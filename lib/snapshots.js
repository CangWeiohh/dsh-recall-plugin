/**
 * dsh-recall-plugin — 快照域（ctx 绑定的工厂，无模块级副作用）
 *
 * 职责：快照捕获（captureSnapshot）、索引落盘/载入/孤儿重建、
 * diff 清单（diffFor）、回退执行（rollbackFor）、会话切点解析
 * （resolveCutSeq）。依赖 store.js 的执行与存储层，脚本文本全部
 * 来自 rt.scripts（按平台选择的 scripts.pwsh.js / scripts.posix.js）。
 */

export function createSnapshots(ctx, rt) {
  const sessions = ctx.sessions
  const state = rt.state
  // 平台选择的脚本模板（rt.scripts = scripts.pwsh.js / scripts.posix.js）：
  // 两套导出同名接口但实现分属 pwsh/bash，所有调用统一走 S.*
  const S = rt.scripts

  // 索引落盘。win32：base64 分块内联（见 scripts.pwsh.js indexWriteCmd 注释，
  // 受 Windows 命令行 32767 字符上限约束）。POSIX：官方 ShellExecRequest
  // 的 stdin 契约字段直写全文——不经命令行传参，没有 argv 长度上限，
  // 也省掉 base64 往返；单次调用即完成。
  async function saveIndex(root, sessionId) {
    const store = state.stores.get(root)
    if (!store) return
    const entries = Array.from(state.snapshots.entries())
      .filter(([, s]) => s.root === root)
      .map(([id, s]) => ({ id, time: s.time, count: s.count, sessionId: s.sessionId }))
    const json = JSON.stringify(entries)
    try {
      if (rt.isWin) {
        const b64 = Buffer.from(json, 'utf8').toString('base64')
        let first = true
        for (let i = 0; i < b64.length; i += 20000) {
          const piece = "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64.slice(i, i + 20000) + "')) | "
          await rt.runShell(S.indexWriteCmd(store.dir, piece, first), { stdoutMaxBytes: 4096 })
          first = false
        }
      } else {
        await rt.runShell('cat > ' + S.psq(store.dir + '/index.json'), { stdin: json, stdoutMaxBytes: 4096 })
      }
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
      const raw = S.stripBom(await rt.runShell(S.indexReadCmd(store.dir), { stdoutMaxBytes: 4194304 })).trim()
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

  // exclude.txt 原文读取（设置页编辑用）：stripBom 剥掉 PS 5.1 Set-Content
  // 写入的 UTF-8 BOM，避免设置页首行出现不可见的 \uFEFF；两套模板对缺失
  // 文件都输出空串，这里不用区分「没配过」和「配了空」。
  async function readExclude(store) {
    return S.stripBom(await rt.runShell(S.excludeReadCmd(store.excludeFile), { stdoutMaxBytes: 1048576 }))
  }

  // exclude.txt 原文写入（设置页保存）：平台分叉与 saveIndex 完全同构——
  // win32 走 base64 分块（命令行 32767 上限），POSIX 走 stdin 直写全文。
  // 先 mkdir 父目录兜底：home 根目录/降级 store 目录被用户手滑删掉时，
  // 保存不该因此失败。空内容也要落一次写（清空配置是合法操作），所以
  // base64 为空串时仍发一块空 piece，而不是整段跳过留下旧文件。
  async function writeExclude(store, text) {
    const body = String(text == null ? '' : text)
    const sep = rt.isWin ? '\\' : '/'
    const parent = store.excludeFile.slice(0, store.excludeFile.lastIndexOf(sep))
    await rt.runShell(S.mkdirScript(parent), { stdoutMaxBytes: 4096 })
    if (rt.isWin) {
      const b64 = Buffer.from(body, 'utf8').toString('base64')
      const chunks = b64 ? b64.match(/.{1,20000}/g) : ['']
      let first = true
      for (const chunk of chunks) {
        const piece = "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + chunk + "')) | "
        await rt.runShell(S.excludeWriteCmd(store.excludeFile, piece, first), { stdoutMaxBytes: 4096 })
        first = false
      }
    } else {
      await rt.runShell('cat > ' + S.psq(store.excludeFile), { stdin: body, stdoutMaxBytes: 4096 })
    }
  }

  // 索引丢失时从仓库 tag 重建：tag 名 snap-<messageId> 本身就是快照主键
  async function rebuildOrphans(root, sessionId) {
    const store = state.stores.get(root)
    const gitExe = await rt.resolveGit()
    if (!store || !gitExe) return
    try {
      const listing = S.stripBom(await rt.runShell(S.listTagsScript(store, gitExe), { stdoutMaxBytes: 4194304 })).trim()
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

  async function captureSnapshot(sessionId, messageId, time) {
    const root = await rt.resolveRoot(sessionId)
    if (!root) return
    let store = await rt.resolveStore(root)
    store = await rt.tryUpgradeToHome(root)
    const ok = await rt.ensureGit(root, store)
    if (!ok) return
    await loadIndex(root, sessionId)
    try {
      await rt.runShell(S.snapshotScript(root, store, state.gitExe, messageId), { timeoutMs: 600000, stdoutMaxBytes: 65536 })
      state.snapshots.set(String(messageId), { root, time: time || Date.now(), count: 0, sessionId })
      await saveIndex(root, sessionId)
    } catch (error) {
      console.error('recall snapshot failed:', String(error))
    }
  }

  // POSIX 侧 diff 输出是 TSV「kind<TAB>path」逐行（bash 模板不拼 JSON，
  // 避免 jq 依赖与转义坑）；win32 侧是 ConvertTo-Json。这里按平台分叉解析。
  function parseChanges(text) {
    if (rt.isWin) {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
      if (parsed && typeof parsed === 'object') return [parsed]
      return []
    }
    const out = []
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      out.push({ kind: line.slice(0, tab), rel: line.slice(tab + 1) })
    }
    return out
  }

  async function diffFor(messageId) {
    const snap = state.snapshots.get(String(messageId))
    if (!snap) return null
    const store = state.stores.get(snap.root)
    if (!store) return null
    const text = S.stripBom(await rt.runShell(S.diffScript(snap.root, store, state.gitExe, 'snap-' + messageId), { timeoutMs: 600000, stdoutMaxBytes: 4194304 }))
    const trimmed = text.trim()
    if (!trimmed) return []
    return parseChanges(trimmed)
  }

  async function rollbackFor(messageId) {
    const snap = state.snapshots.get(String(messageId))
    if (!snap) return { ok: false, error: '该消息没有可用的项目快照' }
    const store = state.stores.get(snap.root)
    if (!store) return { ok: false, error: '快照存储不可用' }
    const text = S.stripBom(await rt.runShell(S.rollbackScript(snap.root, store, state.gitExe, 'snap-' + messageId), { timeoutMs: 600000, stdoutMaxBytes: 65536 }))
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

  return { saveIndex, loadIndex, readExclude, writeExclude, rebuildOrphans, captureSnapshot, diffFor, rollbackFor, resolveCutSeq }
}
