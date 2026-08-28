/**
 * 两套脚本模板同名导出断言（P1-1）
 *
 * AGENTS.md 重要约束：scripts.pwsh.js 与 scripts.posix.js 必须同名导出——
 * 调用方统一走 rt.scripts.*（按 process.platform 单选），单侧漏导出只会
 * 在另一平台用户机器上以「不是函数」的怪异方式暴雷。store.js 装配时已有
 * 运行时 checkScriptParity 兜底（console.error），这里是机器化断言钉死，
 * 且加关键模板结构断言（快照脚本含 --ignore-errors、killOrphans 含
 * RECALL_CLEANUP 哨兵、带 store 的脚本维持 g= 赋值约定）——
 * AGENTS.md「已知坑」的回归钉。
 */

import { describe, it, expect } from 'vitest'
import * as pwsh from '../../lib/scripts.pwsh.js'
import * as posix from '../../lib/scripts.posix.js'

// 与 store.js checkScriptParity 的豁免集保持一致：
// 平台专属导出（homeDirScript 的 $h 链只在 pwsh 侧需要；probeHomeScript
// 只在 posix 侧用于 home 基底探测；fileWriteCmd 仅 pwsh 版存在——POSIX
// 文本落盘走 stdin，不经命令行传参）。
const SKIP = new Set(['homeDirScript', 'probeHomeScript', 'fileWriteCmd'])

const pwshKeys = Object.keys(pwsh).filter((k) => !SKIP.has(k)).sort()
const posixKeys = Object.keys(posix).filter((k) => !SKIP.has(k)).sort()

// 提供 store 最少形状（extractGitDir 只读 store.git 字面量赋值）
const FAKE_STORE = { git: 'GIT_DIR', repo: 'REPO_DIR', excludeFile: 'EXCLUDE', home: true }

// 带 store 参数的脚本（注入 $g = '<store.git>' 赋值）——这些是 runShell 失败
// 兜底提取 git-dir 的目标集（store.js extractGitDir）；新增带 store 脚本模板
// 必须保持该约定（AGENTS.md 已知坑）。migrateScript 只取 src/dst、不经失败
// 兜底，单独豁免。
const STORE_SCRIPTS = {
  ensureGitScript: (api) => api.ensureGitScript(FAKE_STORE, 'git-exe', []),
  snapshotScript: (api) => api.snapshotScript('ROOT', FAKE_STORE, 'git-exe', 'm1', []),
  diffScript: (api) => api.diffScript('ROOT', FAKE_STORE, 'git-exe', 'snap-1', []),
  rollbackScript: (api) => api.rollbackScript('ROOT', FAKE_STORE, 'git-exe', 'snap-1', []),
  listTagsScript: (api) => api.listTagsScript(FAKE_STORE, 'git-exe'),
  gcScript: (api) => api.gcScript(FAKE_STORE, 'git-exe'),
  pruneScript: (api) => api.pruneScript(FAKE_STORE, 'git-exe'),
  purgeTagsScript: (api) => api.purgeTagsScript(FAKE_STORE, 'git-exe', ['snap-1']),
  rescueScript: (api) => api.rescueScript('ROOT', FAKE_STORE, 'git-exe', 'pre-rollback-1'),
}

describe('脚本模板同名导出契约', () => {
  it('两套模板导出键集合全等（含平台豁免集）', () => {
    expect(pwshKeys).toEqual(posixKeys)
  })

  it('平台专属导出各自存在且互不越界', () => {
    expect(typeof pwsh.homeDirScript).toBe('function')
    expect(typeof pwsh.fileWriteCmd).toBe('function')
    expect(pwsh.probeHomeScript).toBeUndefined()
    expect(typeof posix.probeHomeScript).toBe('function')
    expect(posix.homeDirScript).toBeUndefined()
    expect(posix.fileWriteCmd).toBeUndefined()
  })

  for (const key of pwshKeys) {
    it(`${key} 两侧类型一致`, () => {
      const p = pwsh[key]
      const x = posix[key]
      if (typeof p === 'function') {
        expect(typeof x, 'posix.' + key).toBe('function')
      } else {
        // 常量（UTF8_PRELUDE / MAX_FILE_BYTES）类型也应一致
        expect(typeof x, 'posix.' + key).toBe(typeof p)
      }
    })
  }
})

describe('关键模板结构断言', () => {
  for (const [title, module] of [['pwsh', pwsh], ['posix', posix]]) {
    it(`${title}: snapshotScript 含 --ignore-errors（嵌套仓库 fail-open）`, () => {
      expect(module.snapshotScript('ROOT', { git: 'STORE_GIT' }, 'git-exe', 'm1', [])).toContain('--ignore-errors')
    })

    it(`${title}: killOrphansScript 含 RECALL_CLEANUP 哨兵（防递归清理）`, () => {
      expect(module.killOrphansScript('any/dir')).toContain('RECALL_CLEANUP')
    })

    // F-G2 防回归字面契约：rollbackScript（含内联的 collectListsBlock）里
    // 禁止裸 ` && ` 链——set -e 下条件为假的 && 列表会杀掉脚本或让 rm 失败
    // 被静默豁免，半回退假成功报 ROLLBACK_OK、救援永不触发。循环体一律 if/fi。
    it(`${title}: rollbackScript 不存在裸 ' && ' 链（set -e 循环体约定）`, () => {
      expect(module.rollbackScript('ROOT', FAKE_STORE, 'git-exe', 'snap-1', [])).not.toContain(' && ')
    })

    for (const [name, invoke] of Object.entries(STORE_SCRIPTS)) {
      it(`${title}: ${name}(store) 维持 g='<store.git>' 赋值约定`, () => {
        const script = invoke(module)
        expect(script.split(/\r?\n/).some((line) => /(?:^\$g|^g)\s*=\s*'GIT_DIR'/.test(line)),
          `${name} 未定义 g='GIT_DIR'（failed-check 提取 git-dir 依赖该约定）`).toBe(true)
      })
    }
  }

  it('两侧 UTF8_PRELUDE 非空（编码前导是 runShell 统一前置注入的契约）', () => {
    expect(pwsh.UTF8_PRELUDE.length).toBeGreaterThan(0)
    expect(posix.UTF8_PRELUDE.length).toBeGreaterThan(0)
  })
})

describe('F-S1 rescue tag 前缀契约（跨函数）', () => {
  // S1 漏网口：snapshotScript 打 tag 无条件加 snap- 前缀，rescueScript 接受
  // 完整 tag 名——若调用侧（snapshots.js rescueRollback）忘记拼前缀，reset
  // 目标必然 unknown revision 且救援 100% 走失败分支。假模板单测测不到这种
  // 跨函数约定，这里把「snapshotScript 的 tag 命令」与「rescueScript('snap-' + id)
  // 的 reset 目标」钉成同一个名字，前缀规则漂移即红。
  for (const [title, module] of [['pwsh', pwsh], ['posix', posix]]) {
    it(`${title}: snapshotScript 打的 tag 与 rescueScript('snap-'+id) 的 reset 目标同名`, () => {
      const snap = module.snapshotScript('ROOT', FAKE_STORE, 'git-exe', 'm1', [])
      const tagM = snap.match(/tag -f '([^']+)'/)
      expect(tagM, 'snapshotScript 未找到 tag -f 命令').toBeTruthy()
      const rescue = module.rescueScript('ROOT', FAKE_STORE, 'git-exe', 'snap-m1')
      const resetM = rescue.match(/reset --hard '([^']+)'/)
      expect(resetM, 'rescueScript 未找到 reset --hard 目标').toBeTruthy()
      expect(resetM[1]).toBe(tagM[1])
    })
  }
})