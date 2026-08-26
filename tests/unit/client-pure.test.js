/**
 * client.js 纯逻辑单测（P1-1）
 *
 * client.js 是 DSH 直接原文 serve 的 classic-script bundle（client-modules
 * 原样读 exports["./client"] 指向的文件，浏览器以 <script> 执行），所以：
 * - 不能拆独立模块（顶层 import 会让整包 SyntaxError 拒载）；
 * - 纯函数都定义在 apply() 内部闭包，无法 import。
 *
 * 本文件用「花括号配对提取 client.js 中真实函数/常量源码，在最小容器内
 * 执行」的方式测试发布代码本身的纯逻辑（buildTree/clockText/summaryText/
 * sizeText），零生产代码改动、零复制——改 client.js 语义即测红。
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientJs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../lib/client.js'), 'utf8')

// 从源码文本提取顶层函数/常量：从 `token(` 或 `token =` 的 `{` 配对大括号。
// 只针对纯逻辑（无闭包外依赖），提取后可在任意容器执行。
function extractBracedEnd(source, startIndex) {
  let depth = 0
  let i = startIndex
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return i
}

function extractFunctionSource(source, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = re.exec(source)
  if (!m) throw new Error('client.js 中未找到 function ' + name)
  const bodyOpen = m.index + m[0].indexOf('{')
  return source.slice(m.index, extractBracedEnd(source, bodyOpen) + 1)
}

function extractConstSource(source, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*\\{')
  const m = re.exec(source)
  if (!m) throw new Error('client.js 中未找到 const ' + name)
  const bodyOpen = m.index + m[0].indexOf('{')
  return source.slice(bodyOpen, extractBracedEnd(source, bodyOpen) + 1)
}

function evalFunctionSource(src) {
  // src 形如 `function buildTree(list) {...}`——new Function 构造为返回该函数的表达式
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src + ');')()
}

function evalConstSource(src) {
  // src 形如 `{...}`（const KIND_INFO = 之后的部分）
  // eslint-disable-next-line no-new-func
  return new Function('return ' + src + ';')()
}

const extracted = {}
beforeAll(() => {
  for (const name of ['buildTree', 'clockText', 'sizeText']) {
    extracted[name] = evalFunctionSource(extractFunctionSource(clientJs, name))
  }
  // summaryText 闭包引用 KIND_INFO：提取时把 KIND_INFO 作为参数注入作用域
  extracted.KIND_INFO = evalConstSource(extractConstSource(clientJs, 'KIND_INFO'))
  extracted.summaryText = new Function('KIND_INFO', 'return (' + extractFunctionSource(clientJs, 'summaryText') + ');')(extracted.KIND_INFO)
})

describe('client.js 纯逻辑', () => {
  it('buildTree：按工作区/会话分组，未知归属进「未知」节点', () => {
    const tree = extracted.buildTree([
      { root: '/ws1', workspace: 'ws1', sessionId: 's1', sessionTitle: 'S1', time: 2, id: 'a' },
      { root: '/ws1', workspace: 'ws1', sessionId: 's1', sessionTitle: 'S1', time: 1, id: 'b' },
      { root: '/ws1', workspace: 'ws1', sessionId: 's2', sessionTitle: 'S2', time: 3, id: 'c' },
      { root: null, workspace: null, sessionId: null, time: 4, id: 'd' },
      { root: '/ws1', workspace: 'ws1', sessionId: null, time: 5, id: 'e' },
    ])
    expect(tree.length).toBe(2) // /ws1 + unknown-root
    const ws1 = tree.find((w) => w.root === '/ws1')
    expect(ws1.name).toBe('ws1')
    expect(ws1.sessions.length).toBe(3) // s1 / s2 / unknown-session
    // 会话内子项按 time 降序
    const s1 = ws1.sessions.find((s) => s.sessionId === 's1')
    expect(s1.items.map((i) => i.id)).toEqual(['a', 'b'])
    const unknown = tree.find((w) => w.root === null)
    expect(unknown.name).toBe('未知工作区')
  })

  it('clockText：当天只显示时分，跨天显示月/日 时分，非法值返回空串', () => {
    const now = new Date()
    const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime()
    expect(extracted.clockText(sameDay)).toBe('09:05')
    const otherDay = new Date(2020, 0, 15, 3, 45).getTime()
    expect(extracted.clockText(otherDay)).toBe('1/15 03:45')
    expect(extracted.clockText(0)).toBe('')
    expect(extracted.clockText(null)).toBe('')
    expect(extracted.clockText(NaN)).toBe('')
  })

  it('summaryText：按 modified/restored/added 顺序拼接，0 项不出现', () => {
    const s = extracted.summaryText({ modified: 2, restored: 0, added: 1 })
    expect(s).toBe('修改 2 · 删除 1')
    expect(extracted.summaryText({ modified: 0, restored: 0, added: 0 })).toBe('')
  })

  it('sizeText：KB/MB/GB 边界与格式', () => {
    expect(extracted.sizeText(0)).toBe('0 MB')
    expect(extracted.sizeText(null)).toBe('0 MB')
    expect(extracted.sizeText(512)).toBe('1 KB')
    expect(extracted.sizeText(1048576)).toBe('1.0 MB')
    expect(extracted.sizeText(2 * 1073741824)).toBe('2.00 GB')
  })

  it('KIND_INFO：kind 单表覆盖 modified/restored/added', () => {
    expect(Object.keys(extracted.KIND_INFO).sort()).toEqual(['added', 'modified', 'restored'])
    expect(extracted.KIND_INFO.modified.label).toBe('修改')
    expect(extracted.KIND_INFO.added.label).toBe('删除')
  })
})