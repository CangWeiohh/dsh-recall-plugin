/**
 * dsh-recall-plugin — Host 半入口（持久插件形态，bundle 行挂载）
 *
 * 职责：装配各域模块（store 执行存储层 / snapshots 快照域 /
 * maintenance 维护域），通过 webServer 注册 /api/recall/* HTTP API
 * 供 Client 半调用（init / snapshot-info / preview / execute），
 * 并接线 session/event 快照触发与启动预热。
 *
 * 这是持久 npm 插件包的主入口（exports["."]），由 cordis.patch.yml 的
 * insert 行挂载进 profile composition，DSH 重启后自动生效。
 * 文件拆分见 lib/ 下各模块头注释；本文件只做接线，不承载业务逻辑。
 */

import { createRuntime } from './store.js'
import { createSnapshots } from './snapshots.js'
import { createMaintenance } from './maintenance.js'

export const name = 'dsh-recall-plugin'

// 硬依赖：shell（PowerShell 执行）、sessions（会话/沙箱策略）、
// webServer（Client 半的 HTTP API 通道）。其余服务按需 ctx.get。
export const inject = ['shell', 'sessions', 'webServer']

export function apply(ctx) {
  const webServer = ctx.webServer

  const rt = createRuntime(ctx)
  const snaps = createSnapshots(ctx, rt)
  const maint = createMaintenance(ctx, rt, snaps)
  const state = rt.state

  // 平台门控：win32 走 PowerShell 模板，linux/darwin 走 bash 模板
  // （ctx.shell 由 DSH 平台层单选挂载 pwsh/bash 执行器，见 dsh-shell README）。
  // 其余平台干净短路：init 返回 unsupported，Client 弹一次性提示；
  // 其余端点因无快照自然返回「没有可用快照」，全程零文件副作用。
  const supported = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'

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
          if (!supported) {
            sendJson(res, 200, { ok: false, root: null, notice: { unsupported: true } })
            return
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
            const changes = await snaps.diffFor(id)
            if (changes === null) { sendJson(res, 200, { ok: false, error: '该消息没有可用的项目快照' }); return }
            const snap = state.snapshots.get(id)
            const cutSeq = await snaps.resolveCutSeq(sessionId, id)
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
            const result = await snaps.rollbackFor(id)
            if (!result.ok) { sendJson(res, 200, result); return }
            // 文件回退后再解析切点：切点只依赖会话日志，与快照是否删除无关（命中缓存，瞬时）
            const cutSeq = await snaps.resolveCutSeq(sessionId, id)
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

  // 快照事件与启动预热仅在受支持平台注册（见上方 supported 短路说明）
  if (!supported) return

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
      .catch((error) => console.error('recall snapshot error:', String(error)))
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
