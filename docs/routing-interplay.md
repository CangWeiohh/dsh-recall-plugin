# 与 dsh-routing-suite 的交互：撤回 × 路由阶段

> 本文解释 dsh-recall-plugin（消息撤回）与 dsh-routing-suite（渐进式工具披露路由）同时启用时的交互现象、成因与解决方案。README「已知限制」节的对应条目只保留现象，详情见本文。

## 背景

- **dsh-routing-suite** 的 router-standard 预设实现「渐进式工具披露」：把会话按阶段（了解/对齐 → 拟合方案 → 开发 → 验证）渐进解锁工具，阶段状态持久化在 `$DSH_HOME/router-standard/stages.json`（未设 `DSH_HOME` 时为 `~/.dsh/router-standard/stages.json`），**按会话 id 存储**。
- **dsh-recall-plugin** 的撤回走官方 `sessions.fork`：原会话归档、fork 出新会话（新会话 id 与旧不同），对话与文件回退到目标消息之前。

## 现象

在启用 router-standard 的会话里撤回一条消息后，新会话的路由阶段**重置为默认**——表现为工具面收窄、阶段回到初始档位，仿佛「路由不记得之前的进度」。

- 影响范围：仅**同时启用两者**时存在；只使用本插件（无路由）不受影响。
- 严重程度：低——功能不受损，阶段可手动恢复；属于会话「回到过去」语义下的状态回退，不是本插件或路由的 bug。

## 成因

1. 撤回 = `sessions.fork` → 新会话 id（官方 `SessionHeader.parentSession` 字段记录来源会话，但阶段状态不在其中）。
2. 路由阶段状态按**会话 id** 持久化（`stages.json` 的 `sessions.<id>.stage`）。
3. fork 出的新 id 在 `stages.json` 中无记录 → 路由按默认阶段初始化 → 阶段「重置」。

这是会话级状态与「fork 新身份」之间的天然断层：阶段状态跟着会话 id 走，而撤回的语义就是换一个身份回到过去。

## 解决方案（dsh-routing-suite ≥ v1.20.3）

路由新增导出纯函数 `inheritForkStage(state, session)`，在 `agent/pre-step` 最先执行时接线：

- 若当前会话**尚无阶段记录**，读取官方 `SessionHeader.parentSession`，把父会话的阶段记录（`stage` / `guided` / `stageAtTime`）复制到新会话 id；
- 随后同步 `applyStageRestrict`（工具面对齐继承阶段）与 `installMetaShim`（元工具 shim），并 `saveStageState()` 持久化。

**设计要点**：

| 特性 | 说明 |
|---|---|
| 幂等 | 仅当新会话无记录时继承；已有记录（含手动 `phase_advance` 过）绝不覆盖 |
| 无副作用 | 无 `parentSession`（普通新会话）、父会话无记录、空会话 → 一律不动 |
| 即时性 | 改写的是路由内存缓存（`ensureStage()` 返回值），同一 turn 立即生效并持久化 |
| 末档 | 继承 stage 达末档时 `applyStageRestrict` 短路（restrict 释放全量，工具全开） |
| 语义 | 继承阶段**状态**，不复制推进历史（`lastAdvance`）——子会话从父会话披露进度继续，自己的推进记录从零开始 |

**生效条件**：重启 DSH（agent-presets 部署副本的 entry 版本戳递增强制 ESM 重载，绕过 import 缓存）。

实现位置：`~/.dsh/dsh-routing-suite/preset/router-standard/router-bootstrap-v34.mjs`（运行面副本在 `~/.dsh/.agent-presets/router-standard/`，安装是一次性复制、不自动同步，改动需手动部署并递增 `agent.cordis.yml` 中 entry 的 `?v=` 版本戳）。

## 旧版本（无继承）的降级路径

- 撤回后在新会话手动调用 `phase_advance` 逐级恢复到原阶段；
- 或升级 dsh-routing-suite 到 ≥ v1.20.3。

## 验证记录（2026-08-27 实测）

| 撤回 | 父会话 | 子会话 | 结果 |
|---|---|---|---|
| 修复前（旧代码） | `8cc973a1`（stage 3） | `1543c77e` | 阶段重置为默认 |
| 修复后（v1.20.3） | `1543c77e`（stage 3, guided false, stageAtTime 1787768671035） | `4b68d86f` | **继承 stage 3 / guided false / stageAtTime 完全一致** |

证据：`stages.json` 中 `4b68d86f` 与父 `1543c77e` 的阶段记录一致；快照索引中的 `pre-rollback-*` tag 确认 fork 关系；`dev_router_status` 显示继承后阶段为「验证 (3/3)」。

## 边界与说明

- 本插件**不依赖** dsh-routing-suite，两者独立可用；本文仅记录同时启用时的交互与对策。
- 阶段状态文件路径可通过 `DSH_ROUTER_STAGE_FILE` 环境变量覆盖（路由内部约定，一般无需改动）。
- 本文为交互说明（无完成态的事实文档），不参与版本计划；若机制变化请同步更新本文与 README 对应条目。
