/**
 * dsh-recall-plugin — 配置域（ctx 绑定的工厂，无模块级副作用）
 *
 * 职责：把「用户大概率不改的默认值」从硬编码/环境变量迁移到 DSH 官方
 * 插件配置机制——cordis.patch.yml 的 insert 行声明 config 默认值，用户在
 * 自己 profile 的 cordis.patch.yml 里按 id 重述该行即可覆盖（层叠规则见
 * 《DSH 插件开发规范》第五节），无需设环境变量、无需改包。
 *
 * 环境变量 DSH_RECALL_GC_SNAPS / DSH_RECALL_GC_HOURS 保留为最高优先级
 * 覆盖：已用它们调档的用户（含冒烟测试脚本）升级后行为不漂移。
 */

// 平台分叉的默认值：Windows 用 \\ 拼基础排除表，POSIX 用 /——但排除表是
// gitignore 语法（内部一律正斜杠），与平台无关，只有「是否含该项」的差异
const BASE_EXCLUDES = ['.git', 'node_modules/', '.dsh-recall-snapshots/']

export function createConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}

  function pickNumber(value, fallback, min) {
    const n = typeof value === 'number' ? value : parseInt(String(value == null ? '' : value), 10)
    if (!Number.isFinite(n) || n < min) return fallback
    return n
  }

  // 环境变量优先（向后兼容），其次 config，最后默认值
  const gcSnaps = pickNumber(process.env.DSH_RECALL_GC_SNAPS, pickNumber(cfg.gcSnaps, 50, 1), 1)
  const gcHours = pickNumber(process.env.DSH_RECALL_GC_HOURS, pickNumber(cfg.gcHours, 24, 1), 1)
  const maxFileBytes = pickNumber(cfg.maxFileBytes, 104857600, 1024)

  const baseExcludes = Array.isArray(cfg.baseExcludes) && cfg.baseExcludes.length
    ? cfg.baseExcludes.filter((p) => typeof p === 'string' && p.trim())
    : BASE_EXCLUDES

  return { gcSnaps, gcHours, maxFileBytes, baseExcludes }
}
