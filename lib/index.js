/**
 * dsh-recall-plugin — Host 半（持久插件形态，bundle 行挂载）
 *
 * 职责：监听 session/event，为每条用户消息创建项目快照（独立影子 git 仓库，
 * 默认存于 DSH home，受限会话自动降级项目内并可迁回）；
 * 通过 webServer 注册 /api/recall/* HTTP API，供 Client 半调用
 * （init / snapshot-info / preview / execute）。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 */

export const name = 'dsh-recall-plugin'

// 硬依赖：shell（PowerShell 执行）、sessions（会话/沙箱策略）、
// webServer（Client 半的 HTTP API 通道）。其余服务按需 ctx.get。
export const inject = ['shell', 'sessions', 'webServer']

const MAX_FILE_BYTES = 104857600
const HOME_RETRY_MS = 300000

export function apply(ctx) {
  const shell = ctx.shell
  const sessions = ctx.sessions
  const webServer = ctx.webServer

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

  // 所有 shell 调用都以宿主身份（danger-full-access）执行，不借用会话沙箱。
  // 为什么安全：DSH 沙箱约束的是「模型驱动」的文件效果，而本插件的命令全部
  // 是宿主侧固定模板（建仓/快照/索引/回退），命令串里唯一变量是插件自己
  // 推导的路径（会话 cwd、哈希出的 store 路径、消息 ID），模型无法注入任何
  // 内容；快照落盘的也只是会话本就有权读取的工作区文件副本，不扩大能力。
  // 为什么必须如此：若按会话解析策略，workspace-write/read-only 会话写不了
  // home，快照被迫降级进项目目录（污染）；read-only 会话连项目都写不了，
  // 回退恢复直接失败。pwsh-sandbox 对 danger-full-access 直接不约束（等价
  // 本地执行器），无沙箱后端的部署则忽略该字段，两种环境都成立。
  async function runShell(command, opts) {
    const sp = ctx.get('sandboxPolicy')
    const spec = shell.resolve({
      command,
      timeoutMs: (opts && opts.timeoutMs) || 300000,
      stdoutMaxBytes: (opts && opts.stdoutMaxBytes) || 4194304,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: (sp && sp.workspaceRoot) || process.cwd() }
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

  // 解析 git 可执行文件路径：DSH 进程 PATH 可能不含 git，
  // 求值一次并缓存，脚本里用绝对路径调用，避免每条命令依赖 PATH。
  async function resolveGit() {
    if (state.gitExe !== null) return state.gitExe
    try {
      let path = stripBom(await runShell("$g = (Get-Command git -ErrorAction SilentlyContinue).Source; if (-not $g -and (Test-Path -LiteralPath 'C:\\Program Files\\Git\\cmd\\git.exe')) { $g = 'C:\\Program Files\\Git\\cmd\\git.exe' }; if ($g) { Write-Output $g }", { stdoutMaxBytes: 4096 })).trim()
      state.gitExe = path || ''
    } catch (error) {
      state.gitExe = ''
    }
    return state.gitExe
  }

  // 计算项目对应的 home 存储目录（DSH_HOME 优先，否则 ~/.dsh）。
  // 哈希用 Create()+ComputeHash+BitConverter 而不是 HashData+ToHexString：
  // 后两者是 .NET 5+（仅 PS 7）API，别人机器的 shell 若是 Windows PowerShell
  // 5.1 会抛错，导致 home 存储永远降级到项目内；前者两个版本都可用。
  async function homeDirFor(root, sessionId) {
    const dirScript = [
      '$r = ' + psq(root),
      '$h = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }',
      '$sha = [Security.Cryptography.SHA256]::Create()',
      "$hex = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($r))) -replace '-','').ToLower()",
      "Write-Output (Join-Path $h ('dsh-recall-snapshots\\' + $hex))"
    ].join('\n')
    const text = stripBom(await runShell(dirScript, { stdoutMaxBytes: 4096 })).trim()
    if (!text) return null
    // PS 的 Join-Path 可能带出连续反斜杠（旧版脚本遗留 "…\\<hex>" 形态）；
    // 折叠成单反斜杠。Windows 把中间的重复分隔符视为同一个目录，
    // 所以与既有快照数据（index.json、影子 git 仓库）路径完全兼容。
    return text.replace(/\\{2,}/g, '\\')
  }

  // 存储根：优先放 DSH home（保持项目目录干净）。shell 以宿主身份执行，
  // 受限会话（workspace-write/read-only）也能写 home；只有 home 本身不可写
  // （如 DSH_HOME 指向只读/网络盘）才降级到项目内（功能优先于干净）。
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
        await runShell('New-Item -ItemType Directory -Force -Path ' + psq(homeDir) + ' | Out-Null', { stdoutMaxBytes: 4096 })
        const store = { dir: homeDir, repo: homeDir + '\\git', git: homeDir + '\\git\\.git', home: true }
        state.stores.set(root, store)
        return store
      } catch (error) {
        console.error('recall home store unavailable, falling back to workspace:', String(error))
      }
    }
    const fallback = root + '\\.dsh-recall-snapshots'
    await runShell('New-Item -ItemType Directory -Force -Path ' + psq(fallback) + ' | Out-Null', { stdoutMaxBytes: 4096 })
    const store = { dir: fallback, repo: fallback + '\\git', git: fallback + '\\git\\.git', home: false }
    state.stores.set(root, store)
    return store
  }

  // 旧版迁移：宿主身份执行前的版本在受限会话里会把影子仓库降级到项目内，
  // 这里在下一条消息快照前把它整体迁回 home 并删除项目内目录，恢复
  // 「项目目录干净」。失败节流 5 分钟，避免 home 不可写时每条消息白试。
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
      await runShell('New-Item -ItemType Directory -Force -Path ' + psq(homeDir) + ' | Out-Null', { stdoutMaxBytes: 4096 })
      const migrate = [
        "$ErrorActionPreference = 'Stop'",
        '$src = ' + psq(store.dir),
        '$dst = ' + psq(homeDir),
        "if (Test-Path -LiteralPath (Join-Path $src 'git')) { Move-Item -LiteralPath (Join-Path $src 'git') -Destination (Join-Path $dst 'git') -Force }",
        "if (Test-Path -LiteralPath (Join-Path $src 'index.json')) { Move-Item -LiteralPath (Join-Path $src 'index.json') -Destination (Join-Path $dst 'index.json') -Force }",
        'Remove-Item -Recurse -Force -LiteralPath $src -ErrorAction SilentlyContinue',
        "Write-Output 'MIGRATE_OK'"
      ].join('\n')
      await runShell(migrate, { timeoutMs: 300000, stdoutMaxBytes: 4096 })
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
      // 不设 PSNativeCommandUseErrorActionPreference：git 的 stderr 警告（hint 等）
      // 在 DSH shell 注入方式下会被包成 ErrorRecord，配上 EAP=Stop 直接终止脚本；
      // 真正的 git 失败由 runShell 统一按 exitCode 检测抛错，不依赖这里。
      '$git = ' + psq(gitExe),
      '$repo = ' + psq(store.repo),
      '$g = ' + psq(store.git),
      'if (-not (Test-Path -LiteralPath $g)) {',
      '  & $git init $repo | Out-Null',
      '}',
      '& $git --git-dir=$g config core.longpaths true',
      // autocrlf=false：按原始字节入快照（回退时逐字节还原），也避免
      // 用户全局 autocrlf=true 时的 LF/CRLF stderr 警告；addEmbeddedRepo=false：
      // 嵌套仓库 hint/warning 走 stderr，在 DSH shell（EAP=Stop）下会让
      // 整条脚本非零退出，必须在仓库级配置里静默掉。
      '& $git --git-dir=$g config core.autocrlf false',
      '& $git --git-dir=$g config advice.addEmbeddedRepo false',
      "Set-Content -LiteralPath (Join-Path $g 'info\\exclude') -Value \"`n.git`nnode_modules/`n.dsh-recall-snapshots/\" -Encoding utf8 -NoNewline",
      "Write-Output 'GIT_OK'"
    ].join('\n')
    try {
      await runShell(script, { stdoutMaxBytes: 4096 })
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
  //
  // 嵌套 git 仓库（工作区里的子项目自带 .git）会被 add -A 记成 gitlink（160000）；
  // gitlink 残留在 index 时 add -A 会 fatal "in unpopulated submodule"，
  // 且 gitlink 对文件回退毫无意义——所以 add 前后各清一次，子仓库内容不进快照。
  // 依赖外层脚本已定义的 $git/$g；返回的行片段嵌入 snapshot/diff/rollback 三处
  function dropGitlinksScript() {
    return [
      "& $git --git-dir=$g ls-files --stage | Where-Object { $_ -like '160000*' } | ForEach-Object {",
      "  $p = ($_ -split \"`t\")[1]",
      '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $p',
      '}'
    ].join('\n')
  }

  function snapshotScript(root, store, gitExe, messageId) {
    const sync = [
      "$ErrorActionPreference = 'Stop'",
      // 不设 PSNativeCommandUseErrorActionPreference：git 的 stderr 警告（hint 等）
      // 在 DSH shell 注入方式下会被包成 ErrorRecord，配上 EAP=Stop 直接终止脚本；
      // 真正的 git 失败由 runShell 统一按 exitCode 检测抛错，不依赖这里。
      '$git = ' + psq(gitExe),
      '$g = ' + psq(store.git),
      '$root = ' + psq(root),
      dropGitlinksScript(),
      '& $git --git-dir=$g --work-tree=$root add -A',
      dropGitlinksScript(),
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
  // node_modules 等误报为“新增”。
  // 不用 -z：PowerShell 捕获原生命令输出会丢弃含 NUL 的行（实测整段变 null），
  // 改用 core.quotePath=false 让非 ASCII 路径原样输出，逐行按 TAB 解析；
  // [Console]::OutputEncoding=UTF8 保证中文路径正确解码。
  // 代价是文件名含换行的极端情况会解析错乱——概率可忽略，记录为已知限制。
  function diffScript(root, store, gitExe, tag) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      'try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}',
      '$git = ' + psq(gitExe),
      '$g = ' + psq(store.git),
      '$root = ' + psq(root),
      dropGitlinksScript(),
      '& $git --git-dir=$g --work-tree=$root add -A',
      dropGitlinksScript(),
      'Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.Length -gt ' + MAX_FILE_BYTES + ' } | ForEach-Object {',
      "  $rel = $_.FullName.Substring($root.Length + 1).Replace('\\','/')",
      '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $rel',
      '}',
      '$curOut = & $git -c core.quotePath=false --git-dir=$g --work-tree=$root ls-files --stage',
      // 旧 tag 的树里可能仍有 gitlink（修复前留下的），从目标侧一并剔除，
      // 否则 diff 会报出“恢复 dsh-recall-plugin”这类幻影条目
      "$targetOut = @(& $git -c core.quotePath=false --git-dir=$g ls-tree -r " + psq(tag) + " | Where-Object { -not $_.StartsWith('160000') })",
      '$curMap = @{}',
      'foreach ($r in @($curOut)) {',
      '  if (-not $r) { continue }',
      '  $tab = $r.IndexOf("`t"); $path = $r.Substring($tab + 1)',
      '  $sha = ($r.Substring(0, $tab) -split " ")[1]',
      '  $curMap[$path] = $sha',
      '}',
      '$targetMap = @{}',
      'foreach ($r in @($targetOut)) {',
      '  if (-not $r) { continue }',
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
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      'try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}',
      '$git = ' + psq(gitExe),
      '$g = ' + psq(store.git),
      '$root = ' + psq(root),
      dropGitlinksScript(),
      '& $git --git-dir=$g --work-tree=$root add -A',
      dropGitlinksScript(),
      'Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.Length -gt ' + MAX_FILE_BYTES + ' } | ForEach-Object {',
      "  $rel = $_.FullName.Substring($root.Length + 1).Replace('\\','/')",
      '  & $git --literal-pathspecs --git-dir=$g update-index --force-remove -- $rel',
      '}',
      // 同 diffScript：-z 的 NUL 输出会被 PowerShell 捕获丢弃，改为逐行 + quotePath=false
      '$curOut = & $git -c core.quotePath=false --git-dir=$g --work-tree=$root ls-files --stage',
      // 旧 tag 的树里可能仍有 gitlink（修复前留下的），从目标侧一并剔除，
      // 否则 diff 会报出“恢复 dsh-recall-plugin”这类幻影条目
      "$targetOut = @(& $git -c core.quotePath=false --git-dir=$g ls-tree -r " + psq(tag) + " | Where-Object { -not $_.StartsWith('160000') })",
      '$targetMap = @{}',
      'foreach ($r in @($targetOut)) {',
      '  if (-not $r) { continue }',
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
      'foreach ($r in @($curOut)) {',
      '  if (-not $r) { continue }',
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
      // 不设 PSNativeCommandUseErrorActionPreference：git 的 stderr 警告（hint 等）
      // 在 DSH shell 注入方式下会被包成 ErrorRecord，配上 EAP=Stop 直接终止脚本；
      // 真正的 git 失败由 runShell 统一按 exitCode 检测抛错，不依赖这里。
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
      const b64 = Buffer.from(json, 'utf8').toString('base64')
      await runShell("New-Item -ItemType Directory -Force -Path " + psq(store.dir) + " | Out-Null; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')) | Set-Content -LiteralPath " + psq(store.dir + '\\index.json') + ' -Encoding utf8 -NoNewline', { stdoutMaxBytes: 4096 })
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
      const raw = stripBom(await runShell('Get-Content -LiteralPath ' + psq(store.dir + '\\index.json') + ' -Raw -ErrorAction SilentlyContinue', { stdoutMaxBytes: 4194304 })).trim()
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
      const listing = stripBom(await runShell(listTagsScript(store, gitExe), { stdoutMaxBytes: 4194304 })).trim()
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
    runShell('Remove-Item -Recurse -Force -LiteralPath ' + psq(root + '\\.dsh-recall-snapshots'), { timeoutMs: 120000, stdoutMaxBytes: 4096 }).catch(() => {})
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
      await runShell(snapshotScript(root, store, state.gitExe, messageId), { timeoutMs: 600000, stdoutMaxBytes: 65536 })
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
    const text = stripBom(await runShell(diffScript(snap.root, store, state.gitExe, 'snap-' + messageId), { timeoutMs: 600000, stdoutMaxBytes: 4194304 }))
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
    const text = stripBom(await runShell(rollbackScript(snap.root, store, state.gitExe, 'snap-' + messageId), { timeoutMs: 600000, stdoutMaxBytes: 65536 }))
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

  // ---- HTTP API（Client 半经由 fetch 调用；动态插件的 harness RPC 在此换成 webServer 路由）----

  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    return JSON.parse(text)
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/recall',
    handler: async (req, res) => {
      const path = (req.url || '').split('?')[0]
      const name = path.replace(/^\/api\/recall\/?/, '').split('/')[0]
      try {
        const args = await readJsonBody(req)
        if (name === 'init') {
          const sessionId = args && args.sessionId ? String(args.sessionId) : null
          const root = await resolveRoot(sessionId)
          let notice = null
          if (root) {
            let store = await resolveStore(root, sessionId)
            store = await tryUpgradeToHome(root, sessionId)
            await ensureGit(root, store, sessionId)
            await loadIndex(root, sessionId)
            await rebuildOrphans(root, sessionId)
            cleanupLegacy(root, sessionId)
            // 降级状态随 init 下发，Client 弹一次性提示（每次页面加载各弹一次）：
            // gitMissing=未检测到 git CLI（撤回按钮不出现）；homeFallback=home
            // 不可写，快照降级存进项目内 .dsh-recall-snapshots。
            notice = {
              gitMissing: state.gitExe === '',
              homeFallback: store ? !store.home : false
            }
          }
          sendJson(res, 200, { ok: Boolean(root), root: root || null, notice })
          return
        }
        if (name === 'snapshot-info') {
          await state.queue
          const id = args && args.messageId ? String(args.messageId) : ''
          const snap = state.snapshots.get(id)
          sendJson(res, 200, { has: Boolean(snap), time: snap ? snap.time : null, id })
          return
        }
        if (name === 'preview') {
          const id = args && args.messageId ? String(args.messageId) : ''
          const sessionId = args && args.sessionId ? String(args.sessionId) : null
          try {
            const changes = await diffFor(id)
            if (changes === null) { sendJson(res, 200, { ok: false, error: '该消息没有可用的项目快照' }); return }
            const snap = state.snapshots.get(id)
            const cutSeq = await resolveCutSeq(sessionId, id)
            sendJson(res, 200, { ok: true, changes, time: snap ? snap.time : null, root: snap ? snap.root : null, cutSeq })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String(error) })
          }
          return
        }
        if (name === 'execute') {
          const id = args && args.messageId ? String(args.messageId) : ''
          const sessionId = args && args.sessionId ? String(args.sessionId) : null
          try {
            const result = await rollbackFor(id)
            if (!result.ok) { sendJson(res, 200, result); return }
            // 文件回退后再解析切点：切点只依赖会话日志，与快照是否删除无关（命中缓存，瞬时）
            const cutSeq = await resolveCutSeq(sessionId, id)
            sendJson(res, 200, { ok: true, count: result.count, cutSeq })
          } catch (error) {
            sendJson(res, 200, { ok: false, error: String(error) })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: 'unknown endpoint: ' + name })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) })
      }
    }
  }))

  // 每条用户消息触发快照（子代理会话跳过）
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'user/message') return
    const data = event.data
    if (!data || typeof data.id !== 'string' || !data.id) return
    const source = data.source
    if (!source || source.kind !== 'user') return
    if (session && session.header && session.header.origin === 'subagent') return
    const messageId = data.id
    const time = event.time
    state.queue = state.queue
      .then(() => captureSnapshot(session.id, messageId, time))
      .catch((error) => console.error('recall snapshot error:', String(error)))
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
