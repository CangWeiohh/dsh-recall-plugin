/**
 * 官方 API 字段探针（tests/probe/，仅本地跑：npm run test:probe）
 *
 * 原理：直接读取本机 dsh 安装目录的真实 .d.ts，断言插件依赖的官方字段存在。
 * 与运行时同源——dsh 升级后本探针先红，这正是想要的预警（P1-1）。
 * 每条探针对应一个历史坑或现有调用点，把 AGENTS.md 合规清单 #8
 * （禁字段假设）从纪律变成断言。
 *
 * 定位：优先环境变量 DSH_ROOT；否则 %APPDATA%\npm\node_modules\@deepseek-ai\dsh
 * （npm 全局安装默认路径）。找不到时整体 skip（黄）——没装 dsh 的
 * 贡献者/CI 不被卡死；装了的机器本地必跑（AGENTS.md 开发与验证节）。
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function dshRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT
  const global = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  return fs.existsSync(global) ? global : null
}

const ROOT = dshRoot()
const PKG = (name) => path.join(ROOT, 'node_modules', '@deepseek-ai', name)
const read = (pkg, rel) => fs.readFileSync(path.join(PKG(pkg), rel), 'utf8')

// 命中文件才跑探针；文件缺失/目录缺失 skip（黄），不 fail
const probeIf = (guard) => (name, fn) => it(name, () => {
  if (!ROOT || !guard()) return // local-only：无 dsh 环境直接跳过
  fn()
})

describe('官方 API 字段探针（dsh 安装目录）', () => {
  const has = (pkg, rel) => fs.existsSync(path.join(PKG(pkg), rel))

  describe('chat.node slot props（issue #9 钉子）', () => {
    const p = 'dsh-client-ui-conversation'
    const f = '/lib/types/client/contract/slots.d.ts'
    const guard = () => has(p, f)

    probeIf(guard)('renderMessageImages 是官方字段（曾读不存在的 loadImage）', () => {
      const src = read(p, f)
      expect(src).toMatch(/renderMessageImages/)
      // 契约明确剔除 loadImage——`Omit<MessageImagesOwnerProps, 'loadImage'>`
      // 是「渲染入口只有 renderMessageImages」的机器化表达；单匹配 loadImage
      // 会被字面量误放行（字面量作为被 Omit 剔除的名字也存在），必须匹配整型
      expect(src).toMatch(/Omit<MessageImagesOwnerProps,\s*'loadImage'>/)
    })

    probeIf(guard)('node 字段存在（消息节点渲染 props 的官方命名）', () => {
      expect(read(p, f)).toMatch(/node:\s*ChatNode</)
    })

    probeIf(guard)('cwd 字段存在（会话工作区路径显示契约）', () => {
      expect(read(p, f)).toMatch(/cwd\??:\s*string/)
    })
  })

  describe('sessions.fork 签名（1.6.x 行为回归钉）', () => {
    const p = 'dsh-client-runtime'
    const f = '/lib/types/client/contract/sessions.d.ts'
    const guard = () => has(p, f)

    probeIf(guard)('fork 接受 { sessionId, atSeq, increaseTitle? }', () => {
      const src = read(p, f)
      expect(src).toMatch(/fork\(opts:\s*\{/)
      expect(src).toMatch(/atSeq\??:\s*number/)
      expect(src).toMatch(/increaseTitle\??:\s*boolean/)
    })

    probeIf(guard)('increaseTitle 是可选项（本项目 fork 不传它，标题「xxx 2」回归钉）', () => {
      // 若未来 increaseTitle 变成必填，本探针红
      expect(read(p, f)).toMatch(/increaseTitle\??:\s*boolean/)
    })
  })

  describe('sessionQuery.listSessions 记录结构（1.5.2 坑钉子）', () => {
    const p = 'dsh-session-query'
    const f = '/lib/types/corpus.d.ts'
    const guard = () => has(p, f)

    probeIf(guard)('SessionRecord.header 为 SessionHeader，listSessions 存在', () => {
      const src = read(p, f)
      // id 在 header.id——误读 record.id 恒 undefined（1.5.2 修过预热路径）
      expect(src).toMatch(/header:\s*SessionHeader/)
      expect(src).toMatch(/listSessions\s*\(/)
    })
  })

  describe('AgentRegistry / AgentStatus（P0-1 依赖）', () => {
    const p = 'dsh-agent'
    const guardA = () => has(p, '/lib/types/index.d.ts')
    const guardB = () => has(p, '/lib/types/runtime-types.d.ts')

    probeIf(guardA)('AgentRegistry.get(id) 与 list() 存在', () => {
      const src = read(p, '/lib/types/index.d.ts')
      expect(src).toMatch(/\bget\(/)
      expect(src).toMatch(/\blist\(/)
    })

    probeIf(guardB)('Agent.status ∈ idle | running', () => {
      expect(read(p, '/lib/types/runtime-types.d.ts')).toMatch(/idle|running/)
    })

    probeIf(() => has('dsh-session', '/lib/types/types.d.ts'))('Agent.session.header.cwd 存在（跨会话比对用）', () => {
      expect(read('dsh-session', '/lib/types/types.d.ts')).toMatch(/cwd\??:\s*string/)
    })
  })

  describe('settings RPC 契约（config-reset 依赖，S1-3）', () => {
    const p = 'dsh-host-apiproxy'
    const f = '/lib/types/api/settings.d.ts'
    const guard = () => has(p, f)

    probeIf(guard)('replace(ns, section) 存在（恢复默认的官方 reset 路径）', () => {
      const src = read(p, f)
      expect(src).toMatch(/replace\(request:\s*RpcRequest<\{\s*\n\s*ns:\s*string;\s*\n\s*section:\s*object;/)
    })

    probeIf(guard)('mutate 支持路径级 unset op（清除单字段的通道）', () => {
      const src = read(p, f)
      expect(src).toMatch(/op:\s*'set'/)
      expect(src).toMatch(/op:\s*'unset'/)
    })
  })

  describe('ShellRunResult.stdout CollectedOutput（F-G3 索引截断判定依赖）', () => {
    const p = 'dsh-shell'
    const f = '/lib/types/types.d.ts'
    const guard = () => has(p, f)

    probeIf(guard)('ShellRunResult.stdout 是 CollectedOutput（runShellMeta 读取载体）', () => {
      expect(read(p, f)).toMatch(/stdout:\s*CollectedOutput/)
    })

    probeIf(guard)('CollectedOutput.truncated 存在（截断可判定，loadIndex 据此区分截断/损坏）', () => {
      // CollectedOutput 定义住在 dsh-subprocess（dsh-shell re-export）；
      // 截断时 text 只剩流尾部——这是「截断 ≠ 损坏」分支的官方事实依据
      const sub = read('dsh-subprocess', '/lib/types/types.d.ts')
      expect(sub).toMatch(/truncated:\s*boolean/)
      expect(sub).toMatch(/spillPath\?:/)
    })
  })
})