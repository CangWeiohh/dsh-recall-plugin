/**
 * dsh-recall-plugin — Host 半（运行在 DSH Node.js 进程）
 *
 * 职责：监听 session/event，为每条用户消息创建项目快照（独立影子 git 仓库）；
 * 通过 harness.handle 提供 init / snapshot-info / recall-preview / recall-execute
 * 四个包私有 RPC，供 Client 半调用（文件 diff、文件回退、会话切点解析）。
 *
 * 用法：将本文件内容作为 cordis_define 的 code.host（函数体，即返回 Cordis
 * Plugin 的那段代码），client.js 作为 code.client，然后 cordis_run。
 */
return {
  inject: ['shell', 'sessions'],
  apply(ctx) {
    const shell = ctx.shell
    const sessions = ctx.sessions
    const MAX_FILE_BYTES = 104857600
    const HOME_RETRY_MS = 300000

    const state = {
      roots: new Map(),
      stores: new Map(),
      snapshots: new Map(),
      queue: Promise.resolve(),
      indexLoaded: new Set(),
      gitReady: new Set(),
      cutSeqCache: new Map(),
      homeRetryAt: new Map(),
      gitExe: null
    }

    function psq(value) {
      return "'" + String(value).replace(/'/g, "''") + "'"
    }

    // 每次 shell 调用都带会话沙箱策略：默认受限模式下不带策略连临时目录都写不了。
    async function runShell(command, opts, sessionId) {
      let policy
      const sp = ctx.get('sandboxPolicy')
      if (sp) {
        const session = sessionId ? sessions.get(sessionId) : undefined
        policy = sp.resolve(session ? { session } : {})
      }
      const spec = shell.resolve({
        command,
        timeoutMs: (opts && opts.timeoutMs) || 300000,
        stdoutMaxBytes: (opts && opts.stdoutMaxBytes) || 4194304,
        ...(policy ? { sandboxPolicy: policy } : {})
      })
      const res = await shell.run(spec)
      const out = (res && res.stdout && res.stdout.text) || ''
      if (res && res.exitCode !== 0) {
        const err = ((res && res.stderr && res.stderr.text) || '').trim() || ('exit ' + String(res.exitCode))
        throw new Error(err.slice(0, 1500))
      }
      return out
    }

    function stripBom(text) {
      return text.replace(/^\uFEFF/, '')
    }

    async function resolveRoot(sessionId) {
      const key = sessionId ? String(sessionId) : 'fallback'
      const cached = state.roots.get(key)
      if (cached) return cached
      let root = null
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (session && session.header && session.header.cwd) root = session.header.cwd
      }
      if (!root) {
        const sp = ctx.get('sandboxPolicy')
        if (sp && sp.workspaceRoot) root = sp.workspaceRoot
      }
      if (root) state.roots.set(key, root)
      return root
    }

    // 会话查找（按 cwd 匹配），用于索引读写与 git 操作的沙箱策略
    function sessionForRoot(root) {
      const found = sessions.list().find((s) => s && s.header && s.header.cwd === root)
      return found ? found.id : null
    }

    // 解析 git 可执行文件路径：DSH 进程 PATH 可能不含 git，
    // 求值一次并缓存，脚本里用绝对路径调用，避免每条命令依赖 PATH。
    async function resolveGit() {
      if (state.gitExe !== null) return state.gitExe
      try {
        let path = stripBom(await runShell("$g = (Get-Command git -ErrorAction SilentlyContinue).Source; if (-not $g -and (Test-Path -LiteralPath 'C:\\Program Files\\Git\\cmd\\git.exe')) { $g = 'C:\\Program Files\\Git\\cmd\\git.exe' }; if ($g) { Write-Output $g }", { stdoutMaxBytes: 4096 }, null)).trim()
        state.gitExe = path || ''
      } catch (error) {
        state.gitExe = ''
      }
      return state.gitExe
    }

    // 计算项目对应的 home 存储目录（DSH_HOME 优先，否则 ~/.dsh）
    async function homeDirFor(root, sessionId) {
      const dirScript = [
        '$r = ' + psq(root),
        '$h = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }',
        '$hex = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($r))).ToLower()',
        'Write-Output (Join-Path $h ("dsh-recall-snapshots\\" + $hex))'
      ].join('\n')
      const text = stripBom(await runShell(dirScript, { stdoutMaxBytes: 4096 }, sessionId)).trim()
      return text || null
    }

    // 存储根：优先放 DSH home（保持项目目录干净）；
    // workspace-write 等受限会话写不了 home 时自动降级到项目内（功能优先于干净）。
    // git init <dir> 会把真实 git-dir 建在 <dir>\.git，所以 store.repo 是
    // 仓库工作目录、store.git 是真实 git-dir——冒烟测试踩过的坑。
    async function resolveStore(root, sessionId) {
      const cached = state.stores.get(root)
      if (cached) return cached
      let homeDir = null
      try {
        homeDir = await homeDirFor(root, sessionId)
      } catch (error) {
        homeDir = null
      }
      if (homeDir) {
        try {
          await runShell('New-Item -ItemType Directory -Force -Path ' + psq(homeDir) + ' | Out-Null', { stdoutMaxBytes: 4096 }, sessionId)
          const store = { dir: homeDir, repo: homeDir + '\\git', git: homeDir + '\\git\\.git', home: true }
          state.stores.set(root, store)
          return store
        } catch (error) {
          console.error('recall home store unavailable, falling back to workspace:', String(error))
        }
      }
      const fallback = root + '\\.dsh-recall-snapshots'
      await runShell('New-Item -ItemType Directory -Force -Path ' + psq(fallback) + ' | Out-Null', { stdoutMaxBytes: 4096 }, sessionId)
      const store = { dir: fallback, repo: fallback + '\\git', git: fallback + '\\git\\.git', home: false }
      state.stores.set(root, store)
      return store
    }

    // 降级后自动升级：会话权限提升（home 恢复可写）时，把项目内的
    // 影子仓库整体迁回 home 并删除项目内目录，恢复“项目目录干净”。
    // 失败节流 5 分钟，避免受限会话里每条消息都白试一次。
    async function tryUpgradeToHome(root, sessionId) {
      const store = state.stores.get(root)
      if (!store || store.home) return store
      const now = Date.now()
      const last = state.homeRetryAt.get(root) || 0
      if (now - last < HOME_RETRY_MS) return store
      state.homeRetryAt.set(root, now)
      let homeDir = null
      try {
        homeDir = await homeDirFor(root, sessionId)
      } catch (error) {
        homeDir = null
      }
      if (!homeDir) return store
      try {
        await runShell('New-Item -ItemType Directory -Force -Path ' + psq(homeDir) + ' | Out-Null', { stdoutMaxBytes: 4096 }, sessionId)
        const migrate = [
          "$ErrorActionPreference = 'Stop'",
          '$src = ' + psq(store.dir),
          '$dst = ' + psq(homeDir),
          "if (Test-Path -LiteralPath (Join-Path $src 'git')) { Move-Item -LiteralPath (Join-Path $src 'git') -Destination (Join-Path $dst 'git') -Force }",
          "if (Test-Path -LiteralPath (Join-Path $src 'index.json')) { Move-Item -LiteralPath (Join-Path $src 'index.json') -Destination (Join-Path $dst 'index.json') -Force }",
          'Remove-Item -Recurse -Force -LiteralPath $src -ErrorAction SilentlyContinue',
          "Write-Output 'MIGRATE_OK'"
        ].join('\n')
        await runShell(migrate, { timeoutMs: 300000, stdoutMaxBytes: 4096 }, sessionId)
        const upgraded = { dir: homeDir, repo: homeDir + '\\git', git: homeDir + '\\git\\.git', home: true }
        state.stores.set(root, upgraded)
        state.gitReady.delete(store.git)
        console.error('recall store upgraded to home:', root)
        return upgraded
      } catch (error) {
        console.error('recall home upgrade failed:', String(error))
        return store
      }
    }

    // 建立影子仓库：普通 init（index 留在仓库内跨快照复用，git add 的 stat 缓存
    // 让未变文件近乎零成本），core.longpaths 放开 Windows 深路径，
    // info/exclude 排除 .git（项目是 git 仓库时）、node_modules、降级时的自目录。
    // 幂等：gitReady 命中后直接跳过，省掉每条消息一次的 config/exclude 重写。
    async function ensureGit(root, store, sessionId) {
      if (state.gitReady.has(store.git)) return true
      const gitExe = await resolveGit()
      if (!gitExe) return false
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$PSNativeCommandUseErrorActionPreference = $true',
        '$git = ' + psq(gitExe),
        '$repo = ' + psq(store.repo),
        '$g = ' + psq(store.git),
        'if (-not (Test-Path -LiteralPath $g)) {',
        '  & $git init $repo | Out-Null',
        '}',
        '& $git --git-dir=$g config core.longpaths true',
        "Set-Content -LiteralPath (Join-Path $g 'info\\exclude') -Value \"`n.git`nnode_modules/`n.dsh-recall-snapshots/\" -Encoding utf8 -NoNewline",
        "Write-Output 'GIT_OK'"
      ].join('\n')
      try {
        await runShell(script, { stdoutMaxBytes: 4096 }, sessionId)
        state.gitReady.add(store.git)
        return true
      } catch (error) {
        console.error('recall ensureGit failed:', String(error))
        return false
      }
    }

    // 快照：git add -A 增量同步 index（.gitignore/exclude 语义由 git 统一处理），
    // 剔除超大文件（参考 TraeWork update_snapshot_file_over_size 的跳过策略），
    // write-tree 生成树、commit-tree 生成无父孤儿提交、tag 保对象可达。
    // 不做 parent 链、不修剪：像 TraeWork 一样保留全量历史，tag 永远可查。
    function snapshotScript(root, store, gitExe, messageId) {
      const sync = [
        "$ErrorActionPreference = 'Stop'",
        '$PSNativeCommandUseErrorActionPreference = $true',
        '$git = ' + psq(gitExe),
        '$g = ' + psq(store.git),
        '$root = ' + psq(root),
        '& $git --git-dir=$g --work-tree=$root add -A',
        'Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.Length -gt ' + MAX_FILE_BYTES + ' } | ForEach-Object {',
        "  $rel = $_.FullName.Substring($root.Length + 1).Replace('\\','/')",
        '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $rel',
        '}',
        '$tree = (& $git --git-dir=$g --work-tree=$root write-tree).Trim()',
        "$commit = (& $git --git-dir=$g -c user.name=dsh-recall -c user.email=recall@dsh.local commit-tree $tree -m ('snapshot ' + " + psq(messageId) + ")).Trim()",
        '& $git --git-dir=$g tag ' + psq('snap-' + messageId) + ' $commit | Out-Null',
        "Write-Output 'SNAP_OK'"
      ]
      return sync.join('\n')
    }

    // diff：把当前状态 add 进 index 后用 ls-files --stage 取当前清单，
    // 与目标 tag 的 ls-tree 对比——ignore/exclude 语义两侧一致，不会把
    // node_modules 等误报为“新增”。-z 输出避免非 ASCII 路径被引号转义。
    function diffScript(root, store, gitExe, tag) {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$PSNativeCommandUseErrorActionPreference = $true',
        '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
        '$git = ' + psq(gitExe),
        '$g = ' + psq(store.git),
        '$root = ' + psq(root),
        '& $git --git-dir=$g --work-tree=$root add -A',
        'Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.Length -gt ' + MAX_FILE_BYTES + ' } | ForEach-Object {',
        "  $rel = $_.FullName.Substring($root.Length + 1).Replace('\\','/')",
        '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $rel',
        '}',
        '$curOut = & $git --git-dir=$g --work-tree=$root ls-files --stage -z',
        '$targetOut = & $git --git-dir=$g ls-tree -r -z ' + psq(tag),
        '$curMap = @{}',
        'foreach ($r in $curOut.Split("`0", [StringSplitOptions]::RemoveEmptyEntries)) {',
        '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
        '  $sha = ($r.Substring(0, $tab) -split " ")[1]',
        '  $curMap[$path] = $sha',
        '}',
        '$targetMap = @{}',
        'foreach ($r in $targetOut.Split("`0", [StringSplitOptions]::RemoveEmptyEntries)) {',
        '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
        '  $sha = ($r.Substring(0, $tab) -split " ")[2]',
        '  $targetMap[$path] = $sha',
        '}',
        '$result = @()',
        'foreach ($k in $curMap.Keys) {',
        '  if (-not $targetMap.ContainsKey($k)) { $result += [pscustomobject]@{ rel = $k; kind = "added" } }',
        '  elseif ($targetMap[$k] -ne $curMap[$k]) { $result += [pscustomobject]@{ rel = $k; kind = "modified" } }',
        '}',
        'foreach ($k in $targetMap.Keys) {',
        '  if (-not $curMap.ContainsKey($k)) { $result += [pscustomobject]@{ rel = $k; kind = "restored" } }',
        '}',
        '$sorted = @($result | Sort-Object rel)',
        'Write-Output (ConvertTo-Json -InputObject $sorted -Depth 3 -Compress)'
      ]
      return script.join('\n')
    }

    // 回退：archive 生成 zip 直接落盘（二进制不经 shell 文本管道），
    // Expand-Archive 覆盖回工作区；再删除“当前有、目标无”的文件。
    // 空树跳过 archive（空 zip 会让 Expand-Archive 报错），只执行删除。
    // 回退后保留快照 tag 与索引：git delta 空间便宜，保留历史可再次
    // 用该快照恢复（幂等），也避免误回退后无法找回。
    function rollbackScript(root, store, gitExe, tag) {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$PSNativeCommandUseErrorActionPreference = $true',
        '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
        '$git = ' + psq(gitExe),
        '$g = ' + psq(store.git),
        '$root = ' + psq(root),
        '& $git --git-dir=$g --work-tree=$root add -A',
        'Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.Length -gt ' + MAX_FILE_BYTES + ' } | ForEach-Object {',
        "  $rel = $_.FullName.Substring($root.Length + 1).Replace('\\','/')",
        '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $rel',
        '}',
        '$curOut = & $git --git-dir=$g --work-tree=$root ls-files --stage -z',
        '$targetOut = & $git --git-dir=$g ls-tree -r -z ' + psq(tag),
        '$targetMap = @{}',
        'foreach ($r in $targetOut.Split("`0", [StringSplitOptions]::RemoveEmptyEntries)) {',
        '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
        '  $targetMap[$path] = $true',
        '}',
        '$restored = $targetMap.Count',
        'if ($restored -gt 0) {',
        '  $zip = ' + psq(store.dir + '\\restore-tmp.zip'),
        '  & $git --git-dir=$g archive --format=zip --output=$zip ' + psq(tag),
        '  Expand-Archive -LiteralPath $zip -DestinationPath $root -Force',
        '  Remove-Item -LiteralPath $zip -Force',
        '}',
        '$deleted = 0',
        'foreach ($r in $curOut.Split("`0", [StringSplitOptions]::RemoveEmptyEntries)) {',
        '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
        '  if (-not $targetMap.ContainsKey($path)) {',
        "    $full = Join-Path $root ($path.Replace('/','\\'))",
        '    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force; $deleted++ }',
        '  }',
        '}',
        "Write-Output ('ROLLBACK_OK ' + $deleted + ' ' + $restored)"
      ]
      return script.join('\n')
    }

    function listTagsScript(store, gitExe) {
      return [
        "$ErrorActionPreference = 'Stop'",
        '$PSNativeCommandUseErrorActionPreference = $true',
        '$git = ' + psq(gitExe),
        '$g = ' + psq(store.git),
        '& $git --git-dir=$g tag -l "snap-*"'
      ].join('\n')
    }

    // 索引写入合并为单次 shell 调用：pwsh 进程启动是主要耗时，能省一次是一次
    async function saveIndex(root, sessionId) {
      const store = state.stores.get(root)
      if (!store) return
      const entries = Array.from(state.snapshots.entries())
        .filter(([, s]) => s.root === root)
        .map(([id, s]) => ({ id, time: s.time, count: s.count, sessionId: s.sessionId }))
      const json = JSON.stringify(entries)
      try {
        const b64 = btoa(json)
        await runShell("New-Item -ItemType Directory -Force -Path " + psq(store.dir) + " | Out-Null; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')) | Set-Content -LiteralPath " + psq(store.dir + '\\index.json') + ' -Encoding utf8 -NoNewline', { stdoutMaxBytes: 4096 }, sessionId)
      } catch (error) {
        console.error('recall saveIndex failed:', String(error))
      }
    }

    async function loadIndex(root, sessionId) {
      if (state.indexLoaded.has(root)) return
      state.indexLoaded.add(root)
      const store = state.stores.get(root)
      if (!store) return
      try {
        const raw = stripBom(await runShell('Get-Content -LiteralPath ' + psq(store.dir + '\\index.json') + ' -Raw -ErrorAction SilentlyContinue', { stdoutMaxBytes: 4194304 }, sessionId)).trim()
        if (!raw) return
        const entries = JSON.parse(raw)
        if (!Array.isArray(entries)) return
        for (const entry of entries) {
          if (!entry || typeof entry.id !== 'string') continue
          state.snapshots.set(entry.id, {
            root,
            time: typeof entry.time === 'number' ? entry.time : Date.now(),
            count: typeof entry.count === 'number' ? entry.count : 0,
            sessionId: entry.sessionId || sessionId
          })
        }
      } catch (error) {
        /* 索引缺失或损坏时按空历史处理 */
      }
    }

    // 索引丢失时从仓库 tag 重建：tag 名 snap-<messageId> 本身就是快照主键
    async function rebuildOrphans(root, sessionId) {
      const store = state.stores.get(root)
      const gitExe = await resolveGit()
      if (!store || !gitExe) return
      try {
        const listing = stripBom(await runShell(listTagsScript(store, gitExe), { stdoutMaxBytes: 4194304 }, sessionId)).trim()
        if (!listing) return
        for (const name of listing.split(/\r?\n/)) {
          const id = name.trim().replace(/^snap-/, '')
          if (!id || state.snapshots.has(id)) continue
          state.snapshots.set(id, { root, time: 0, count: 0, sessionId })
        }
        await saveIndex(root, sessionId)
      } catch (error) {
        console.error('recall rebuildOrphans failed:', String(error))
      }
    }

    // 迁移收尾：删除旧版 blobs 格式的项目内 .dsh-recall-snapshots 目录，
    // 仅在 home 存储可用时执行——降级场景下该目录就是新 store，不能删。
    function cleanupLegacy(root, sessionId) {
      const store = state.stores.get(root)
      if (!store || !store.home) return
      runShell('Remove-Item -Recurse -Force -LiteralPath ' + psq(root + '\\.dsh-recall-snapshots'), { timeoutMs: 120000, stdoutMaxBytes: 4096 }, sessionId).catch(() => {})
    }

    async function captureSnapshot(sessionId, messageId, time) {
      const root = await resolveRoot(sessionId)
      if (!root) return
      let store = await resolveStore(root, sessionId)
      store = await tryUpgradeToHome(root, sessionId)
      const ok = await ensureGit(root, store, sessionId)
      if (!ok) return
      await loadIndex(root, sessionId)
      try {
        await runShell(snapshotScript(root, store, state.gitExe, messageId), { timeoutMs: 600000, stdoutMaxBytes: 65536 }, sessionId)
        state.snapshots.set(String(messageId), { root, time: time || Date.now(), count: 0, sessionId })
        await saveIndex(root, sessionId)
      } catch (error) {
        console.error('recall snapshot failed:', String(error))
      }
    }

    async function diffFor(messageId) {
      const snap = state.snapshots.get(String(messageId))
      if (!snap) return null
      const store = state.stores.get(snap.root)
      if (!store) return null
      const text = stripBom(await runShell(diffScript(snap.root, store, state.gitExe, 'snap-' + messageId), { timeoutMs: 600000, stdoutMaxBytes: 4194304 }, snap.sessionId))
      const trimmed = text.trim()
      if (!trimmed) return []
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') return [parsed]
      return []
    }

    async function rollbackFor(messageId) {
      const snap = state.snapshots.get(String(messageId))
      if (!snap) return { ok: false, error: '该消息没有可用的项目快照' }
      const store = state.stores.get(snap.root)
      if (!store) return { ok: false, error: '快照存储不可用' }
      const text = stripBom(await runShell(rollbackScript(snap.root, store, state.gitExe, 'snap-' + messageId), { timeoutMs: 600000, stdoutMaxBytes: 65536 }, snap.sessionId))
      const m = text.trim().match(/^ROLLBACK_OK\s+(\d+)\s+(\d+)/)
      const deleted = m ? parseInt(m[1], 10) : 0
      const restored = m ? parseInt(m[2], 10) : 0
      return { ok: true, count: (Number.isNaN(deleted) ? 0 : deleted) + (Number.isNaN(restored) ? 0 : restored) }
    }

    // 在事件序列里找“该消息之前最近一次 turn/end 的 seq”。
    function scanCutSeq(events, messageId) {
      let anchor = -1
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e && e.type === 'user/message' && e.data && String(e.data.id) === String(messageId)) {
          anchor = i
          break
        }
      }
      if (anchor < 0) return null
      for (let i = anchor - 1; i >= 0; i--) {
        const e = events[i]
        if (e && e.type === 'turn/end' && typeof e.seq === 'number') return e.seq
      }
      return null
    }

    // 解析“整段回退”的会话切点：优先读 live 会话的内存事件（零 IO、毫秒级），
    // 冷会话回退到 sessionQuery.readSession；结果按 (会话, 消息) 缓存——
    // 消息一旦入日志，其之前的 turn/end 永不变化，缓存终身有效。
    async function resolveCutSeq(sessionId, messageId) {
      if (!sessionId || !messageId) return null
      const cacheKey = String(sessionId) + '\u0000' + String(messageId)
      if (state.cutSeqCache.has(cacheKey)) return state.cutSeqCache.get(cacheKey)
      let result = null
      const live = sessions.get(sessionId)
      if (live && Array.isArray(live.events)) {
        result = scanCutSeq(live.events, messageId)
      } else {
        const query = ctx.get('sessionQuery')
        if (query) {
          try {
            const log = await query.readSession(sessionId)
            result = scanCutSeq(Array.isArray(log && log.events) ? log.events : [], messageId)
          } catch (error) {
            result = null
          }
        }
      }
      state.cutSeqCache.set(cacheKey, result)
      return result
    }

    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'user/message') return
      const data = event.data
      if (!data || typeof data.id !== 'string' || !data.id) return
      const source = data.source
      if (!source || source.kind !== 'user') return
      // 子代理会话的提示消息会消耗快照预算，跳过
      if (session && session.header && session.header.origin === 'subagent') return
      const messageId = data.id
      const time = event.time
      state.queue = state.queue
        .then(() => captureSnapshot(session.id, messageId, time))
        .catch((error) => console.error('recall snapshot error:', String(error)))
    })

    harness.handle('init', async (args) => {
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const root = await resolveRoot(sessionId)
      if (root) {
        let store = await resolveStore(root, sessionId)
        store = await tryUpgradeToHome(root, sessionId)
        await ensureGit(root, store, sessionId)
        await loadIndex(root, sessionId)
        await rebuildOrphans(root, sessionId)
        cleanupLegacy(root, sessionId)
      }
      return { ok: Boolean(root), root: root || null }
    })

    harness.handle('snapshot-info', async (args) => {
      await state.queue
      const id = args && args.messageId ? String(args.messageId) : ''
      const snap = state.snapshots.get(id)
      return { has: Boolean(snap), time: snap ? snap.time : null, id }
    })

    harness.handle('recall-preview', async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      try {
        const changes = await diffFor(id)
        if (changes === null) return { ok: false, error: '该消息没有可用的项目快照' }
        const snap = state.snapshots.get(id)
        const cutSeq = await resolveCutSeq(sessionId, id)
        return { ok: true, changes, time: snap ? snap.time : null, root: snap ? snap.root : null, cutSeq }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })

    harness.handle('recall-execute', async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      try {
        const result = await rollbackFor(id)
        if (!result.ok) return result
        // 文件回退后再解析切点：切点只依赖会话日志，与快照是否删除无关（命中缓存，瞬时）
        const cutSeq = await resolveCutSeq(sessionId, id)
        return { ok: true, count: result.count, cutSeq }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })

    // 启动预热：所有已存在工作区解析存储、重建索引与孤儿快照，
    // 并清理旧版项目内 blobs 目录（home 可用时）
    for (const session of sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (!cwd) continue
      const sessionId = session.id
      Promise.resolve(resolveStore(cwd, sessionId))
        .then(() => tryUpgradeToHome(cwd, sessionId))
        .then((store) => ensureGit(cwd, store, sessionId))
        .then(() => loadIndex(cwd, sessionId))
        .then(() => rebuildOrphans(cwd, sessionId))
        .then(() => cleanupLegacy(cwd, sessionId))
        .catch(() => {})
    }
  }
}
