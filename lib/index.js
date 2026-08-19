/**
 * dsh-recall-plugin — Host 半入口（持久插件形态，bundle 行挂载）
 *
 * 职责：装配各域模块（config 配置域 / store 执行存储层 / snapshots 快照域 /
 * maintenance 维护域），通过 webServer 注册 /api/recall/* HTTP API
 * 供 Client 半调用（init / snapshot-info / preview / execute /
 * exclude-get / exclude-set / manage / status），并接线 session/event
 * 快照触发与启动预热。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 * 文件拆分见 lib/ 下各模块头注释；本文件只做接线，不承载业务逻辑。
 */

import { createConfig } from './config.js'
import { createRuntime } from './store.js'
import { createSnapshots } from './snapshots.js'
import { createMaintenance } from './maintenance.js'

export const name = 'dsh-recall-plugin'

// 硬依赖：shell（PowerShell 执行）、sessions（会话/沙箱策略）、
// webServer（Client 半的 HTTP API 通道）。其余服务按需 ctx.get。
export const inject = ['shell', 'sessions', 'webServer']

// config 由 cordis.patch.yml 的 insert 行 config 键下发，用户在 profile 层
// 按 id: recall 重述该行即可覆盖默认值（见 config.js 头注释）
export function apply(ctx, config) {
  const webServer = ctx.webServer

  const cfg = createConfig(config)
  const rt = createRuntime(ctx, cfg)
  const snaps = createSnapshots(ctx, rt, cfg)
  const maint = createMaintenance(ctx, rt, snaps, cfg)
  const state = rt.state

  // 平台门控：win32 走 PowerShell 模板，linux/darwin 走 bash 模板
  // （ctx.shell 由 DSH 平台层单选挂载 pwsh/bash 执行器，见 dsh-shell README）。
  // 其余平台干净短路：init 返回 unsupported，Client 弹一次性提示；
  // 其余端点因无快照自然返回「没有可用快照」，全程零文件副作用。
  const supported = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'

  // ---- HTTP API（Client 半经由 fetch 调用；动态插件的 harness RPC 在此换成 webServer 路由）----

  // 请求体上限：端点里 exclude-set 接受用户任意文本，无上限时可被无限
  // POST 撑爆内存。1MB 远超正常配置体量，超限干净报错而不是悄悄截断
  // （半截 JSON 会在 parse 处抛更晦涩的错）。
  const MAX_BODY_BYTES = 1048576

  // 快照管理列表的结果缓存：磁盘 dump + 冷会话标题即便已批量/并行化，
  // 也不是零成本（1 条 shell + 若干日志解压）。设置页打开、删除后刷新
  // 都会重拉，30s 缓存让二次打开即时；delete 与新快照落地时失效。
  let listCache = { at: 0, payload: null }

  // 会话标题缓存（apply 级跨请求共享）：冷会话标题要 readSession 整日志
  // 解压 + 重放校验（大日志 10 秒级），绝不能挡列表首屏——list 只查
  // live/缓存（同步、瞬时），冷标题由 Client 拿到列表后异步调 titles 补。
  // 值为 null 表示「查过、确实没有」（已删除会话），同样命中缓存。
  const sessionTitles = new Map()
  function titleFromEvents(events) {
    if (!Array.isArray(events)) return null
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string' && e.data.title) return e.data.title
    }
    return null
  }
  function liveTitleFast(sessionId) {
    if (!sessionId) return null
    if (sessionTitles.has(sessionId)) return sessionTitles.get(sessionId)
    let t = null
    try {
      const live = ctx.sessions.get(sessionId)
      if (live) t = titleFromEvents(live.events)
    } catch (error) { t = null }
    if (t !== null) sessionTitles.set(sessionId, t)
    return t
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    return JSON.parse(text)
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  // 枚举当前全部已知 exclude 文件并按路径去重：home 存储全局共享一份
  // （所有工作区通常合并成一条），降级存储各自独立。根来源取并集——
  // 会话注册表（当前活跃的工作区）+ state.stores 缓存（历史会话预热过、
  // 可能已关闭的工作区），让设置页也能编辑非活跃项目的排除配置。
  // exclude-get 直接消费结果；exclude-set 用它做路径白名单校验，客户端
  // 只能回传 get 下发过的路径，堵死「借 API 写任意文件」的通道。
  async function listExcludeFiles() {
    const roots = new Set(state.stores.keys())
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd) roots.add(cwd)
    }
    const byFile = new Map()
    for (const root of roots) {
      try {
        const store = await rt.resolveStore(root)
        if (store && !byFile.has(store.excludeFile)) byFile.set(store.excludeFile, { store, roots: [] })
        byFile.get(store.excludeFile).roots.push(root)
      } catch (error) {
        /* 单个根解析失败只影响它自己，不拖垮整个列表 */
      }
    }
    // 磁盘兜底：冷启动时会话注册表为空（惰性载入），但 home 容器目录可能
    // 早已存在（历史快照）。容器在 ⇒ 共享 exclude.txt 可编辑（哪怕从未
    // 写过、内容为空）；容器不在 ⇒ 全新安装，让设置页显示引导文案。
    // 注册表扫描命中的同路径条目优先（roots 信息更全），这里只补缺。
    try {
      const container = await rt.resolveHomeContainer()
      if (container) {
        const probe = rt.scripts.stripBom(await rt.runShell(rt.scripts.dirExistsScript(container), { stdoutMaxBytes: 4096 })).trim()
        if (probe === 'YES') {
          const excludeFile = container + (rt.isWin ? '\\' : '/') + 'exclude.txt'
          if (!byFile.has(excludeFile)) {
            // 伪 store：仅承载 readExclude/writeExclude 用到的 excludeFile
            // 与 home 两个字段；不进 state.stores（无对应 root，不污染缓存）
            byFile.set(excludeFile, { store: { dir: container, home: true, excludeFile }, roots: [] })
          }
        }
      }
    } catch (error) {
      /* 兜底失败退回注册表结果 */
    }
    return byFile
  }

  // 工作区 cwd 全集：live 注册表只是子集（ctx.sessions 是纯内存 Map，web
  // 侧栏拉会话列表走 persistence 只读路径、不 resume，注册表可以一直空
  // 着），sessionQuery.listSessions 是「live + 磁盘冷元数据」的完整语料
  // ——每个会话 header 都带创建时的 cwd。manage list 与 delete 兜底共用。
  async function collectCwds() {
    const cwds = new Set()
    for (const session of ctx.sessions.list()) {
      const cwd = session && session.header && session.header.cwd
      if (cwd) cwds.add(cwd)
    }
    try {
      const querySvc = ctx.get('sessionQuery')
      if (querySvc && typeof querySvc.listSessions === 'function') {
        for (const record of await querySvc.listSessions()) {
          const cwd = record && record.header && record.header.cwd
          if (cwd) cwds.add(cwd)
        }
      }
    } catch (error) { /* 冷元数据不可用时退回 live 注册表 */ }
    return cwds
  }

  // 解析 storesDumpScript 的定界输出：dir → { root, entries }。逐行状态机
  // （==DIR / ROOT / INDEXBEGIN..INDEXEND），单个 store 的 JSON 损坏只丢它自己。
  function parseStoresDump(text) {
    const map = new Map()
    let cur = null
    let inIndex = false
    let indexLines = []
    function flush() {
      if (!cur) return
      const raw = indexLines.join('\n').trim()
      if (raw) {
        try {
          const arr = JSON.parse(raw)
          if (Array.isArray(arr)) cur.entries = arr
        } catch (error) { /* index 损坏按无索引处理 */ }
      }
      map.set(cur.dir, cur)
      cur = null
    }
    for (const line of String(text).split(/\r?\n/)) {
      if (line.indexOf('==DIR ') === 0) { flush(); cur = { dir: line.slice(6).trim(), root: null, entries: null }; inIndex = false; indexLines = []; continue }
      if (!cur) continue
      if (line.indexOf('ROOT ') === 0) { const v = line.slice(5).trim(); cur.root = v || null; continue }
      if (line === 'INDEXBEGIN') { inIndex = true; indexLines = []; continue }
      if (line === 'INDEXEND') { inIndex = false; continue }
      if (inIndex) indexLines.push(line)
    }
    flush()
    return map
  }

  // 一条 shell dump 全部 store 元数据（容器子目录 + 降级候选目录的
  // root.txt 与 index.json），manage list 与 delete 兜底共用。
  async function dumpStores() {
    const container = await rt.resolveHomeContainer()
    const extras = Array.from(await collectCwds()).map((cwd) => cwd + (rt.isWin ? '\\' : '/') + '.dsh-recall-snapshots')
    try {
      const text = rt.scripts.stripBom(await rt.runShell(rt.scripts.storesDumpScript(container || '', extras), { timeoutMs: 120000, stdoutMaxBytes: 8388608 }))
      return parseStoresDump(text)
    } catch (error) {
      return new Map()
    }
  }

  // 磁盘反查某快照归属的 store：dump 全部 index 后按 id 查找，root 取
  // 条目自带字段 → root.txt → 内存映射。delete 的兜底路径用它消灭
  // 「列表可见但内存缺失 ⇒ 误报不存在」。
  async function locateSnapshotOnDisk(id) {
    if (!id) return null
    const dump = await dumpStores()
    const hints = new Map()
    for (const [root, st] of state.stores.entries()) {
      if (st && st.dir) hints.set(st.dir, root)
    }
    for (const [dir, info] of dump) {
      const hit = (info.entries || []).find((e) => e && e.id === id)
      if (!hit) continue
      const root = (typeof hit.root === 'string' && hit.root) || info.root || hints.get(dir) || null
      if (!root) continue
      try {
        const store = await rt.resolveStore(root)
        if (store) return { store, root }
      } catch (error) { /* 单个 root 解析失败继续找 */ }
    }
    return null
  }

  // 统一错误映射：业务失败与系统异常分离，文案与诊断解耦。code 给
  // Client 做分支判断（BODY_TOO_LARGE 等），message 直接展示。
  function errBody(error) {
    const text = String(error && error.message ? error.message : error)
    if (text === 'BODY_TOO_LARGE') return { ok: false, code: 'BODY_TOO_LARGE', message: '请求体超过 1MB 上限' }
    return { ok: false, code: 'ERROR', message: text }
  }

  // ---- 端点表：name → handler(args) → 回包体。统一 try/catch 与入队
  // 策略写在这里，端点主体只写业务。queued 标记的端点与快照/gc 共用同
  // 一条串行队列——preview/execute 内部都跑 git add -A，不入队会与
  // 进行中的快照争 index.lock（曾只在 snapshot-info 入队，是并发隐患）。
  // 队列入队即占住后续快照，队列失败不堵队（catch 就地消化）。
  function enqueue(task) {
    const run = state.queue.then(task)
    state.queue = run.catch(() => {})
    return run
  }

  const endpoints = {
    'init': async (args) => {
      if (!supported) {
        return { ok: false, root: null, notice: { unsupported: true } }
      }
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const root = await rt.resolveRoot(sessionId)
      let notice = null
      if (root) {
        let store = await rt.resolveStore(root)
        store = await rt.tryUpgradeToHome(root)
        await rt.ensureGit(root, store)
        await snaps.loadIndex(root, sessionId)
        await snaps.rebuildOrphans(root, sessionId)
        rt.cleanupLegacy(root)
        // 降级状态随 init 下发，Client 弹一次性提示（每次页面加载各弹一次）：
        // gitMissing=未检测到 git CLI（撤回按钮不出现）；homeFallback=home
        // 不可写，快照降级存进项目内 .dsh-recall-snapshots。
        notice = {
          gitMissing: state.gitExe === '',
          homeFallback: store ? !store.home : false
        }
      }
      return { ok: Boolean(root), root: root || null, notice }
    },

    'snapshot-info': async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const snap = state.snapshots.get(id)
      return { has: Boolean(snap), time: snap ? snap.time : null, id }
    },

    'preview': async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const result = await enqueue(() => snaps.diffFor(id))
      if (result === null) return { ok: false, code: 'NO_SNAPSHOT', message: '该消息没有可用的项目快照' }
      const snap = state.snapshots.get(id)
      const cutSeq = await snaps.resolveCutSeq(sessionId, id)
      return { ok: true, changes: result.changes, total: result.total, truncated: result.truncated, time: snap ? snap.time : null, root: snap ? snap.root : null, cutSeq }
    },

    'execute': async (args) => {
      const id = args && args.messageId ? String(args.messageId) : ''
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      const result = await enqueue(async () => {
        // 回退前自动打安全快照：回退覆盖工作区且不回写 index（旧的
        // 「当前状态」从此无任何快照可找回），用消息 ID 打 tag 会与该消息
        // 的既有快照碰撞，故用独立前缀的时间戳 tag——不进 index.json
        // （列表不展示），但孤儿重建/手动 git tag 仍能找到它，误回退后
        // 用户可让插件从该 tag 恢复，堵住唯一的不可逆操作缺口。
        const snap = state.snapshots.get(id)
        if (!snap) return { ok: false, code: 'NO_SNAPSHOT', message: '该消息没有可用的项目快照' }
        const store = state.stores.get(snap.root)
        if (!store) return { ok: false, code: 'NO_STORE', message: '快照存储不可用' }
        const safetyId = 'pre-rollback-' + Date.now()
        try {
          await rt.runShell(rt.scripts.snapshotScript(snap.root, store, state.gitExe, safetyId, cfg.baseExcludes), { timeoutMs: 600000, stdoutMaxBytes: 65536 })
        } catch (error) {
          // 安全快照失败不阻断回退本身：用户已确认覆盖，记录后照原计划执行
          rt.recordError('recall safety snapshot failed: ' + String(error))
        }
        return snaps.rollbackFor(id)
      })
      if (!result.ok) return result
      // 文件回退后再解析切点：切点只依赖会话日志，与快照是否删除无关（命中缓存，瞬时）
      const cutSeq = await snaps.resolveCutSeq(sessionId, id)
      return { ok: true, count: result.count, cutSeq }
    },

    'exclude-get': async () => {
      // 设置页「撤回设置」标签的配置读取。不支持平台照常短路：Client
      // 显示不可用提示而不是空白表单，与 init 的 notice 语义对齐。
      if (!supported) return { ok: false, unsupported: true }
      const byFile = await listExcludeFiles()
      const files = []
      for (const [path, info] of byFile) {
        let content = ''
        try { content = await snaps.readExclude(info.store) } catch (error) { content = '' }
        files.push({ path, home: Boolean(info.store.home), roots: info.roots, content })
      }
      return { ok: true, files }
    },

    'exclude-set': async (args) => {
      if (!supported) return { ok: false, unsupported: true }
      const path = args && args.path ? String(args.path) : ''
      const content = args && typeof args.content === 'string' ? args.content : ''
      // 路径白名单：重新枚举当前已知 exclude 文件并要求精确命中，
      // 客户端伪造的任意路径在这里被拒（见 listExcludeFiles 注释）
      const byFile = await listExcludeFiles()
      const info = byFile.get(path)
      if (!info) return { ok: false, code: 'UNKNOWN_PATH', message: '未知的排除文件路径' }
      await snaps.writeExclude(info.store, content)
      return { ok: true }
    },

    // 设置页「快照管理」卡片：列表 / 磁盘占用 / 单条删除 / 全部删除 / 手动 gc。
    // 全部走串行队列——删除 tag 与 gc 与快照争的是同一个 git 仓库。
    'manage': async (args) => {
      if (!supported) return { ok: false, unsupported: true }
      const op = args && args.op ? String(args.op) : 'list'
      const sessionId = args && args.sessionId ? String(args.sessionId) : null
      if (op === 'list') {
        // 结果缓存（30s + 删除/新快照失效）：设置页反复打开、删除后刷新
        // 都会重拉列表，缓存让二次打开零 shell。
        if (listCache.payload && Date.now() - listCache.at < 30000) return listCache.payload
        const seen = new Set()
        const allItems = []

        // 磁盘全量：一条 shell dump（dumpStores 见其注释——旧实现每目录
        // 2-3 条 shell 串行跑，20 秒级慢的根因）。root 解析链：条目自带
        // root（新数据）→ root.txt → 内存 store 映射（store 目录名是
        // root 的单向 SHA256，磁盘上只有持久化记录能反查）。
        // 标题只查 live/缓存（liveTitleFast，同步瞬时）——冷会话标题由
        // Client 拿到列表后异步调 titles 补齐，列表首屏不等日志解压。
        const dump = await dumpStores()
        const hints = new Map()
        for (const [root, st] of state.stores.entries()) {
          if (st && st.dir) hints.set(st.dir, root)
        }
        // 去重只用 id（消息 ID 全局唯一）：带 root 进 key 会让同一快照
        // 因「磁盘来源 root 缺失 / 内存来源 root 齐全」出现两条重复行
        function push(id, time, root, sessionId) {
          if (!id || typeof id !== 'string' || seen.has(id)) return
          seen.add(id)
          allItems.push({
            id,
            time: typeof time === 'number' ? time : 0,
            root: root || null,
            workspace: root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null,
            sessionId: sessionId || null,
            sessionTitle: liveTitleFast(sessionId)
          })
        }
        for (const [dir, info] of dump) {
          const baseRoot = info.root || hints.get(dir) || null
          for (const e of info.entries || []) {
            if (!e || typeof e.id !== 'string') continue
            push(e.id, e.time, (typeof e.root === 'string' && e.root) || baseRoot, e.sessionId)
          }
        }
        // 内存兜底（刚拍未落盘的保险，正常已被磁盘 dump 覆盖）
        for (const [id, s] of state.snapshots.entries()) {
          push(id, s.time, s.root, s.sessionId)
        }

        allItems.sort((a, b) => (b.time || 0) - (a.time || 0))
        const payload = { ok: true, items: allItems.slice(0, 200), total: allItems.length }
        listCache = { at: Date.now(), payload }
        return payload
      }
      if (op === 'titles') {
        // 冷会话标题补齐（Client 异步二次请求）：readSession 整日志解压 +
        // 重放校验，大日志 10 秒级——独立于列表让首屏即时。并发交给
        // sessionQuery 自带的 inspect 并发闸，这里全量并行发车。
        if (!supported) return { ok: false, unsupported: true }
        const ids = Array.isArray(args && args.sessionIds) ? args.sessionIds.map(String).slice(0, 100) : []
        const out = {}
        await Promise.all(ids.map(async (sid) => {
          if (!sid || out[sid] !== undefined) return
          let title = liveTitleFast(sid)
          if (title === null) {
            const query = ctx.get('sessionQuery')
            if (query && typeof query.readSession === 'function') {
              try {
                const log = await query.readSession(sid)
                title = titleFromEvents(log && log.events)
              } catch (error) { title = null }
            }
          }
          sessionTitles.set(sid, title)
          out[sid] = title
        }))
        return { ok: true, titles: out }
      }
      if (op === 'usage') {
        const root = await rt.resolveRoot(sessionId)
        if (!root) return { ok: false, code: 'NO_ROOT', message: '无法解析当前工作区' }
        const store = state.stores.get(root)
        if (!store) return { ok: false, code: 'NO_STORE', message: '当前工作区尚未创建快照存储' }
        const out = await rt.runShell(rt.scripts.diskUsageScript(store.dir), { stdoutMaxBytes: 4096 })
        const bytes = parseInt(rt.scripts.stripBom(out).trim(), 10) || 0
        return { ok: true, bytes }
      }
      if (op === 'delete') {
        const id = args && args.messageId ? String(args.messageId) : ''
        // 管理列表来自磁盘（跨工作区全量），而内存 state.snapshots 只含
        // 当前工作区 + 预热过的——冷启动或别的会话先点开列表时，列表里有、
        // 内存里没有，只查内存会把可删的快照误报「不存在」。解析链：
        // 内存命中 → Client 透传的条目 root → 磁盘 index 反查归属 store。
        let snap = state.snapshots.get(id) || null
        let root = snap ? snap.root : (args && args.root ? String(args.root) : null)
        let store = null
        if (root) {
          try { store = await rt.resolveStore(root) } catch (error) { store = null }
        }
        if (!store) {
          // 兜底：扫 home 容器与降级目录的 index.json，找到含该 id 的 store
          const found = await locateSnapshotOnDisk(id)
          if (found) { store = found.store; root = found.root }
        }
        if (!store) return { ok: false, code: 'NO_SNAPSHOT', message: '该快照不存在' }
        const finalStore = store
        const finalRoot = root
        await enqueue(async () => {
          if (state.gitExe) {
            await rt.runShell(rt.scripts.purgeTagsScript(finalStore, state.gitExe, ['snap-' + id]), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
          }
          // 兜底路径到这里时内存可能还没载入过该 root 的索引——直接
          // saveIndex 会用「只有内存条目」的列表覆盖 index.json，把同
          // store 其余磁盘快照一并抹掉。先 loadIndex 补齐内存视图（幂等，
          // indexLoaded 命中则零成本），再删目标条目后重写。
          if (!state.indexLoaded.has(finalRoot)) {
            try { await snaps.loadIndex(finalRoot, sessionId) } catch (error) { /* 载入失败照常重写，退化为旧行为 */ }
          }
          state.snapshots.delete(id)
          await snaps.saveIndex(finalRoot, sessionId)
          // 列表缓存失效：Client 删除后会立刻 refresh，必须看到最新状态
          listCache.payload = null
        })
        return { ok: true }
      }
      if (op === 'deleteAll') {
        // 清空全部工作区的全部快照（「快照管理」列表是跨工作区全量，
        // 「全部删除」与之对齐：一次性消灭所有 store 的所有快照）。
        // 数据源用与列表相同的磁盘 dump（dumpStores），不依赖内存预热、
        // 不依赖 sessionId——列表能看到什么，「全部删除」就清掉什么。
        // 每个 store：批量删 snap-* tag（分块避命令行上限）→ loadIndex
        // 补齐内存视图 → 从内存移除该 root 条目 → saveIndex 写空索引。
        // 全部在串行队列里跑，与快照/gc 互斥；单 store 失败只记错误继续，
        // tag 残留由下次清理或 gc 幂等收尾。
        const dump = await dumpStores()
        const hints = new Map()
        for (const [root, st] of state.stores.entries()) {
          if (st && st.dir) hints.set(st.dir, root)
        }
        const groups = new Map()
        for (const [dir, info] of dump) {
          const root = info.root || hints.get(dir) || null
          const ids = (info.entries || []).map((e) => e && typeof e.id === 'string' ? e.id : null).filter(Boolean)
          if (!root || ids.length === 0) continue
          if (!groups.has(root)) groups.set(root, { ids: [] })
          groups.get(root).ids.push(...ids)
        }
        const storeCache = new Map()
        await enqueue(async () => {
          for (const [root, group] of groups) {
            let store = storeCache.get(root)
            if (!store) {
              try { store = await rt.resolveStore(root) } catch (error) { store = null }
              if (store) storeCache.set(root, store)
            }
            if (!store) {
              rt.recordError('recall deleteAll skipped store (resolve failed): ' + root)
              continue
            }
            try {
              if (state.gitExe && group.ids.length > 0) {
                for (let i = 0; i < group.ids.length; i += 100) {
                  await rt.runShell(rt.scripts.purgeTagsScript(store, state.gitExe, group.ids.slice(i, i + 100).map((id) => 'snap-' + id)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
                }
              }
              // 补齐内存视图后再清，避免 saveIndex 用「只有内存条目」的
              // 列表覆盖 index.json、把该 store 其余磁盘快照误留
              if (!state.indexLoaded.has(root)) {
                try { await snaps.loadIndex(root, sessionId) } catch (error) { /* 照常继续 */ }
              }
              for (const id of group.ids) state.snapshots.delete(id)
              await snaps.saveIndex(root, sessionId)
            } catch (error) {
              rt.recordError('recall deleteAll failed for store: ' + root + ' ' + String(error))
            }
          }
          listCache.payload = null
        })
        return { ok: true }
      }
      if (op === 'gc') {
        const done = await enqueue(() => maint.runGc(sessionId, true))
        return { ok: true, gc: Boolean(done) }
      }
      return { ok: false, code: 'UNKNOWN_OP', message: '未知的管理操作: ' + op }
    },

    // 设置页排障：最近错误（Host 侧 console.error 的页面可见副本）
    'status': async () => ({ ok: true, errors: state.errors.slice(-20).reverse() })
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/recall',
    handler: async (req, res) => {
      const path = (req.url || '').split('?')[0]
      const name = path.replace(/^\/api\/recall\/?/, '').split('/')[0]
      const endpoint = endpoints[name]
      if (!endpoint) {
        sendJson(res, 404, { ok: false, code: 'UNKNOWN_ENDPOINT', message: 'unknown endpoint: ' + name })
        return
      }
      try {
        const args = await readJsonBody(req)
        sendJson(res, 200, await endpoint(args))
      } catch (error) {
        sendJson(res, 200, errBody(error))
      }
    }
  }))

  // 快照事件与启动预热仅在受支持平台注册（见上方 supported 短路说明）
  if (!supported) return

  // 注册 settings namespace「dsh-recall」：自 rc.7 起，设置页「插件配置」
  // 标签页只渲染 settings.describe 命中的 namespace 对应的卡片——纯
  // 注册 settings.plugin.item 而不声明 namespace，卡片永远不会出现
  // （modlens 同款做法）。这里注册一个空 pass-through schema，唯一作用
  // 就是让 Host 在 settings.describe 里应答「dsh-recall」，使客户端卡片
  // 可被分发；真实配置仍走自有 /api/recall/* 端点，不经 settings 读写。
  // settings 服务可能未组装（非 web profile / 旧版 harness），用可选
  // ctx.inject 兜底：闭包只在 settings 存在时运行，否则静默跳过。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      try {
        const passThrough = (value) => ({ ...(value ?? {}) })
        passThrough.toJSON = () => ({
          uid: 0,
          refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } }
        })
        scope.settings.register('dsh-recall', passThrough, { base: {} })
      } catch (error) {
        rt.recordError('recall settings namespace skipped: ' + String(error))
      }
    })
  }

  // 每条用户消息触发快照（子代理会话跳过）；快照完成后串行接一次维护
  // （定期 gc / 会话清理）——排在同一条队列里，与快照天然互斥，无 git 锁竞态
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
      .then(() => snaps.captureSnapshot(session.id, messageId, time))
      .then(() => maint.maybeMaintain(session.id))
      .then(() => { listCache.payload = null })
      .catch((error) => rt.recordError('recall snapshot error: ' + String(error)))
  })

  // 启动预热：所有已存在工作区解析存储、重建索引与孤儿快照，
  // 并清理旧版项目内 blobs 目录（home 可用时）。
  // 不触发维护（gc/清理）：开机预热应尽量轻，重活等第一条消息再按节流来。
  for (const session of ctx.sessions.list()) {
    const cwd = session && session.header && session.header.cwd
    if (!cwd) continue
    const sessionId = session.id
    Promise.resolve(rt.resolveStore(cwd))
      .then(() => rt.tryUpgradeToHome(cwd))
      .then((store) => rt.ensureGit(cwd, store))
      .then(() => snaps.loadIndex(cwd, sessionId))
      .then(() => snaps.rebuildOrphans(cwd, sessionId))
      .then(() => rt.cleanupLegacy(cwd))
      .catch(() => {})
  }
}
