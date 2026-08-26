/**
 * snapshots.js 工厂级测试（P1-2）：feedback 落盘/回填往返
 *
 * createSnapshots 是工厂函数，注入假 rt/ctx/state 即可不跑 git 测试
 * saveIndex/loadIndex（纯索引 JSON 读写链路，经过 mock 的
 * rt.writeTextViaShell / rt.runShell）。钉住：
 * - 失败/有跳过消息的 feedback 写进 index.json、正常快照不带；
 * - loadIndex 回填回 snapFeedback（重启后 snapshot-info 仍可解释）；
 * - 旧格式索引（无 feedback 字段）正常载入、不产生 feedback。
 */

import { describe, it, expect } from 'vitest'
import { createSnapshots } from '../../lib/snapshots.js'

function fakeState() {
  return {
    snapshots: new Map(),
    snapFeedback: new Map(),
    indexLoaded: new Set(),
    stores: new Map(),
    cutSeqCache: new Map(),
    gcLastAt: new Map(),
    gcCount: new Map(),
  }
}

// 构造最小 rt：writeTextViaShell 捕获 index.json 落盘（diskIndex），
// runShell 按 indexReadCmd 前缀读回；脚本接口仅承载 stripBom/indexReadCmd
function fakeRt(state) {
  let diskIndex = ''
  const S = {
    stripBom: (t) => String(t == null ? '' : t).replace(/^\uFEFF/, ''),
    indexReadCmd: (dir) => 'READ ' + dir,
  }
  return {
    state,
    isWin: false,
    scripts: S,
    writeTextViaShell: async (file, text) => {
      if (String(file).endsWith('index.json')) diskIndex = String(text)
    },
    runShell: async (cmd) => {
      return String(cmd).startsWith('READ ') ? diskIndex : ''
    },
  }
}

const ROOT = 'D:/ws'
const SID = 'session-1'

describe('P1-2 feedback 持久化', () => {
  it('saveIndex：失败/有跳过消息写入 feedback，正常快照不带', async () => {
    const state = fakeState()
    const rt = fakeRt(state)
    const snaps = createSnapshots({ sessions: { get: () => null } }, rt, { baseExcludes: [] })
    state.stores.set(ROOT, { dir: '/store', git: '/store/git/.git' })
    state.snapshots.set('m-fail', { root: ROOT, time: 1000, sessionId: SID })
    state.snapshots.set('m-skip', { root: ROOT, time: 2000, sessionId: SID })
    state.snapshots.set('m-ok', { root: ROOT, time: 3000, sessionId: SID })
    state.snapFeedback.set('m-fail', { failed: true, error: 'boom' })
    state.snapFeedback.set('m-skip', { skipped: ['a/', 'b/'] })

    await snaps.saveIndex(ROOT, SID)

    const entries = JSON.parse(await rt.runShell('READ /store'))
    expect(entries.find((e) => e.id === 'm-fail').feedback).toEqual({ failed: true, error: 'boom' })
    expect(entries.find((e) => e.id === 'm-skip').feedback).toEqual({ skipped: ['a/', 'b/'] })
    expect(entries.find((e) => e.id === 'm-ok').feedback).toBeUndefined()
  })

  it('loadIndex：回填 feedback 到 snapFeedback（重启后可解释）', async () => {
    const state = fakeState()
    const rt = fakeRt(state)
    const snaps = createSnapshots({ sessions: { get: () => null } }, rt, { baseExcludes: [] })
    state.stores.set(ROOT, { dir: '/store', git: '/store/git/.git' })
    const idx = JSON.stringify([
      { id: 'm-fail', time: 1000, root: ROOT, sessionId: SID, feedback: { failed: true, error: 'boom' } },
      { id: 'm-skip', time: 2000, root: ROOT, sessionId: SID, feedback: { skipped: ['a/'] } },
      { id: 'm-ok', time: 3000, root: ROOT, sessionId: SID },
    ])
    // 直接把索引文本塞进 fake rt 的读回
    rt.runShell = async () => idx

    await snaps.loadIndex(ROOT, SID)

    expect(state.snapFeedback.get('m-fail')).toEqual({ failed: true, error: 'boom' })
    expect(state.snapFeedback.get('m-skip')).toEqual({ skipped: ['a/'] })
    expect(state.snapFeedback.has('m-ok')).toBe(false)
  })

  it('loadIndex：旧格式索引（无 feedback 字段）正常载入，无 feedback 产生', async () => {
    const state = fakeState()
    const rt = fakeRt(state)
    const snaps = createSnapshots({ sessions: { get: () => null } }, rt, { baseExcludes: [] })
    state.stores.set(ROOT, { dir: '/store', git: '/store/git/.git' })
    rt.runShell = async () => JSON.stringify([
      { id: 'm1', time: 1000, root: ROOT, sessionId: SID },
      { id: 'm2', time: 2000, root: ROOT, sessionId: SID },
    ])

    await snaps.loadIndex(ROOT, SID)

    expect(state.snapshots.has('m1')).toBe(true)
    expect(state.snapshots.has('m2')).toBe(true)
    expect(state.snapFeedback.size).toBe(0)
  })

  it('loadIndex：feedback 形状损坏/越界字段被清洗，不污染内存', async () => {
    const state = fakeState()
    const rt = fakeRt(state)
    const snaps = createSnapshots({ sessions: { get: () => null } }, rt, { baseExcludes: [] })
    state.stores.set(ROOT, { dir: '/store', git: '/store/git/.git' })
    rt.runShell = async () => JSON.stringify([
      { id: 'm1', time: 1000, root: ROOT, sessionId: SID, feedback: { failed: true, error: 42 } },
      { id: 'm2', time: 2000, root: ROOT, sessionId: SID, feedback: { skipped: 'not-array' } },
      { id: 'm3', time: 3000, root: ROOT, sessionId: SID, feedback: { failed: false } },
    ])

    await snaps.loadIndex(ROOT, SID)

    // error 非 string 被丢弃但仍保留 failed:true（失败事实本身有效）
    expect(state.snapFeedback.get('m1')).toEqual({ failed: true })
    expect(state.snapFeedback.has('m2')).toBe(false) // skipped 非数组被清洗
    expect(state.snapFeedback.has('m3')).toBe(false) // failed:false 无 skipped → 不需要解释
  })

  it('saveIndex→loadIndex 往返：feedback 一致、正常消息不受影响（模拟重启）', async () => {
    // 第一轮：写入
    const state = fakeState()
    const rt = fakeRt(state)
    const snaps = createSnapshots({ sessions: { get: () => null } }, rt, { baseExcludes: [] })
    state.stores.set(ROOT, { dir: '/store', git: '/store/git/.git' })
    state.snapshots.set('m-fail', { root: ROOT, time: 1000, sessionId: SID })
    state.snapshots.set('m-ok', { root: ROOT, time: 3000, sessionId: SID })
    state.snapFeedback.set('m-fail', { failed: true, error: 'boom' })
    await snaps.saveIndex(ROOT, SID)
    const persisted = await rt.runShell('READ /store')

    // 第二轮：全新 state/rt 模拟重启，从磁盘读回
    const state2 = fakeState()
    const rt2 = fakeRt(state2)
    const snaps2 = createSnapshots({ sessions: { get: () => null } }, rt2, { baseExcludes: [] })
    state2.stores.set(ROOT, { dir: '/store', git: '/store/git/.git' })
    rt2.runShell = async () => persisted
    await snaps2.loadIndex(ROOT, SID)

    expect(state2.snapshots.has('m-fail')).toBe(true)
    expect(state2.snapshots.has('m-ok')).toBe(true)
    expect(state2.snapFeedback.get('m-fail')).toEqual({ failed: true, error: 'boom' })
    expect(state2.snapFeedback.has('m-ok')).toBe(false)
  })
})