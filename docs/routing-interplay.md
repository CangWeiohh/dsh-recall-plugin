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

## 解决方案：本地修改 dsh-routing-suite 预设

> dsh-routing-suite 是第三方注入器预设（本插件作者不维护其版本发布），**不保证上游存在含下述改动的版本**。以下方案是**本地文件改动**：直接改本机预设源码并部署，不依赖上游发布，也不影响本插件的安装与发布。

原理：路由在 `agent/pre-step` 最先执行时，若当前会话尚无阶段记录，读取官方 `SessionHeader.parentSession`（fork 来源），把父会话的阶段记录（`stage` / `guided` / `stageAtTime`）复制到新会话 id，并同步工具面（`applyStageRestrict`）与元工具（`installMetaShim`），随后持久化。

### 步骤 1：修改预设源文件

文件：`~/.dsh/dsh-routing-suite/preset/router-standard/router-bootstrap-v34.mjs`（主文件 `router-bootstrap.mjs` 同步改，保持两版一致）。

**1a. 新增导出函数**（放在 `export function sessionFresh` 附近）：

```js
/**
 * fork 会话继承父会话阶段：sessions.fork（撤回/回退）出的新会话
 * header.parentSession 记录来源会话 id（官方 SessionHeader 字段）。
 * 幂等地（仅当本会话尚无记录）把父会话的阶段记录复制到新会话 id。
 * 返回是否执行了继承（true = state 已填充，调用方应据此对齐 restrict/shim
 * 并 saveStageState）。
 */
export function inheritForkStage(state, session) {
  const sid = session?.id
  if (!sid || state[sid] !== undefined) return false
  const parentId = session?.header?.parentSession
  const parent = parentId ? state[parentId] : undefined
  if (parent === undefined) return false
  state[sid] = { stage: parent.stage, guided: parent.guided, stageAtTime: parent.stageAtTime ?? 0 }
  return true
}
```

**1b. `agent/pre-step` 接线**（在 `const sid = agent.session.id` 之后、`const st = (ensureStage()[sid] ??= { stage: 0, guided: false })` 之前插入）：

```js
    // fork 继承：撤回/fork 出的会话继承父会话阶段——幂等纯函数 inheritForkStage
    const state = ensureStage()
    if (inheritForkStage(state, agent.session)) {
      saveStageState()
      try { applyStageRestrict(agent, state[sid].stage) } catch { /* ignore */ }
      try { installMetaShim(agent, { installStage: true, stage: state[sid].stage }) } catch { /* ignore */ }
    }
```

### 步骤 2：部署到运行面副本

DSH 实际加载的是 `~/.dsh/.agent-presets/router-standard/` 下的副本（安装是一次性复制、不自动同步），需手动同步：

```powershell
$src = "$env:USERPROFILE\.dsh\dsh-routing-suite\preset\router-standard"
$ap  = "$env:USERPROFILE\.dsh\.agent-presets\router-standard"
# 改前备份
Copy-Item "$ap\router-bootstrap-v34.mjs" "$ap\router-bootstrap-v34.mjs.bak" -Force
# 同步修改后的源文件
Copy-Item "$src\router-bootstrap-v34.mjs" "$ap\router-bootstrap-v34.mjs" -Force
```

### 步骤 3：递增 entry 版本戳

编辑 `~/.dsh/.agent-presets/router-standard/agent.cordis.yml`，把 router-bootstrap 的 entry 版本戳 +1（强制 ESM 重载新模块，绕过 import 缓存）：

```yaml
name: ./router-bootstrap-v34.mjs?v=88   # 改为 ?v=89（下一次改动再 +1）
```

### 步骤 4：重启 DSH

重启 dsh web 进程使新预设生效（agent-presets 在启动/装配时按新版本戳加载）。

### 步骤 5：验证

```powershell
# 语法检查
node --check "$env:USERPROFILE\.dsh\.agent-presets\router-standard\router-bootstrap-v34.mjs"
```

重启后撤回一条消息（目标会话此前已推进过阶段）→ 新会话应保持父会话阶段：`dev_router_status` 显示继承的阶段；`stages.json` 中新会话 id 出现与父会话一致的 `stage`/`guided`/`stageAtTime` 记录。

### 回滚

用备份文件覆盖副本并恢复版本戳，重启即还原（`router-bootstrap-v34.mjs.bak` → 覆盖 `$ap\router-bootstrap-v34.mjs`）。

### 设计要点

| 特性 | 说明 |
|---|---|
| 幂等 | 仅当新会话无记录时继承；已有记录（含手动 `phase_advance` 过）绝不覆盖 |
| 无副作用 | 无 `parentSession`（普通新会话）、父会话无记录、空会话 → 一律不动 |
| 即时性 | 改写的是路由内存缓存（`ensureStage()` 返回值），同一 turn 立即生效并持久化 |
| 末档 | 继承 stage 达末档时 `applyStageRestrict` 短路（restrict 释放全量，工具全开） |
| 语义 | 继承阶段**状态**，不复制推进历史（`lastAdvance`）——子会话从父会话披露进度继续，自己的推进记录从零开始 |

## 未做修改时的降级路径

- 撤回后在新会话手动调用 `phase_advance` 逐级恢复到原阶段；
- 或按上文步骤修改本地预设（推荐，一次改动长期生效）。

## 验证记录（2026-08-27 实测）

| 撤回 | 父会话 | 子会话 | 结果 |
|---|---|---|---|
| 修改前（原预设） | `8cc973a1`（stage 3） | `1543c77e` | 阶段重置为默认 |
| 修改后（本地预设改动） | `1543c77e`（stage 3, guided false, stageAtTime 1787768671035） | `4b68d86f` | **继承 stage 3 / guided false / stageAtTime 完全一致** |

证据：`stages.json` 中 `4b68d86f` 与父 `1543c77e` 的阶段记录一致；快照索引中的 `pre-rollback-*` tag 确认 fork 关系；`dev_router_status` 显示继承后阶段为「验证 (3/3)」。

## 边界与说明

- 本插件**不依赖** dsh-routing-suite，两者独立可用；本文仅记录同时启用时的交互与对策。
- 阶段状态文件路径可通过 `DSH_ROUTER_STAGE_FILE` 环境变量覆盖（路由内部约定，一般无需改动）。
- 本文为交互说明（无完成态的事实文档），不参与版本计划；若机制变化请同步更新本文与 README 对应条目。
