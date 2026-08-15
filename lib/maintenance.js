/**
 * dsh-recall-plugin — 快照维护（ctx 绑定的工厂，无模块级副作用）
 *
 * 职责：磁盘占用治理，两件事——
 * 1. 定期 git gc：全量保留策略下把 loose 对象压 pack + 跨版本 delta，
 *    无损（所有 tag 可达对象一个不丢），通常省一半以上空间；
 * 2. 会话删除联动清理：会话日志已从磁盘消失时，删除该会话全部快照 tag
 *    并重写索引，空间由紧随的同一次 gc --prune=now 真正释放。
 *
 * 触发点在每条用户消息快照之后的同一条串行队列里（见 index.js 的事件
 * 接线），因此 gc/清理与快照天然互斥，不存在 git 锁竞态。
 */

// gc 节流阈值：每 GC_SNAPS 条快照或距上次 gc GC_MS 毫秒，先到先触发。
// 默认「50 条或 24 小时」——重活（gc）一天至多一次的量级，轻会话用户
// 也不会等太久。支持环境变量覆盖，供高级用户与冒烟测试调档。
const GC_SNAPS = Math.max(1, parseInt(process.env.DSH_RECALL_GC_SNAPS || '', 10) || 50)
const GC_MS = Math.max(1, parseInt(process.env.DSH_RECALL_GC_HOURS || '', 10) || 24) * 3600000

export function createMaintenance(ctx, rt, snaps) {
  const sessions = ctx.sessions
  const state = rt.state
  // 平台选择的脚本模板（gc/purge 两套模板同名导出）
  const S = rt.scripts

  // 删除一个会话的全部快照：按 root 分组（同一会话可能换过工作目录），
  // tag 分块删除规避命令行长度上限，索引重写交给 snaps.saveIndex。
  // best-effort：单块失败只记日志，剩余块继续；tag 残留由下次清理幂等收尾。
  async function purgeSession(sessionId) {
    const byRoot = new Map()
    for (const [id, s] of state.snapshots.entries()) {
      if (!s || s.sessionId !== sessionId) continue
      if (!byRoot.has(s.root)) byRoot.set(s.root, [])
      byRoot.get(s.root).push(id)
    }
    let purged = 0
    for (const [root, ids] of byRoot) {
      const store = state.stores.get(root)
      if (!store || !state.gitExe) continue
      try {
        for (let i = 0; i < ids.length; i += 100) {
          await rt.runShell(S.purgeTagsScript(store, state.gitExe, ids.slice(i, i + 100).map((id) => 'snap-' + id)), { timeoutMs: 120000, stdoutMaxBytes: 4096 })
        }
        for (const id of ids) state.snapshots.delete(id)
        await snaps.saveIndex(root, sessionId)
        purged += ids.length
      } catch (error) {
        console.error('recall purge session failed:', String(error))
      }
    }
    if (purged > 0) console.error('recall purged snapshots of deleted session:', sessionId, purged)
    return purged
  }

  // 扫描索引里出现过的全部会话：既不在 sessions 注册表、冷读日志又失败的，
  // 才认定「已删除」。两个保守闸门：
  // - sessionQuery 服务不存在时整体跳过——没有冷读能力就无法区分
  //   「已删除」和「只是冷着」，误删快照不可逆，宁可不清理；
  // - 归档会话（撤回功能自己归档的）日志仍在磁盘上，readSession 仍成功，
  //   不会被误清——只有日志真正消失才触发。
  async function sweepDeletedSessions() {
    const ids = new Set()
    for (const s of state.snapshots.values()) {
      if (s && s.sessionId) ids.add(s.sessionId)
    }
    if (!ids.size) return
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.readSession !== 'function') return
    for (const id of ids) {
      if (sessions.get(id)) continue
      let alive = false
      try {
        const log = await query.readSession(id)
        alive = Boolean(log)
      } catch (error) {
        alive = false
      }
      if (!alive) await purgeSession(id)
    }
  }

  // 维护入口（每条消息快照后串行调用）：先清理后 gc——被删 tag 腾出的
  // 对象靠同一次 gc --prune=now 释放，一次干两件事。
  // 失败也推进 gcLastAt：gc 失败往往是环境性的（磁盘/杀软），不推进时间戳
  // 会让后续每条消息都重试一次重量级 gc，把队列堵住。
  async function maybeMaintain(sessionId) {
    const root = await rt.resolveRoot(sessionId)
    if (!root) return
    const store = state.stores.get(root)
    if (!store || !state.gitExe) return
    const now = Date.now()
    const last = state.gcLastAt.get(store.git) || 0
    const count = (state.gcCount.get(store.git) || 0) + 1
    state.gcCount.set(store.git, count)
    if (count < GC_SNAPS && now - last < GC_MS) return
    state.gcCount.set(store.git, 0)
    try {
      await sweepDeletedSessions()
      await rt.runShell(S.gcScript(store, state.gitExe), { timeoutMs: 600000, stdoutMaxBytes: 4096 })
    } catch (error) {
      console.error('recall maintenance failed:', String(error))
    }
    state.gcLastAt.set(store.git, Date.now())
  }

  return { maybeMaintain, sweepDeletedSessions, purgeSession }
}
