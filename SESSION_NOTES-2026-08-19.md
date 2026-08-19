# dsh-recall-plugin 会话记录（2026-08-19）

> 本文件由 AI 编码会话生成，记录该会话中做过的所有关键事项，供未来恢复与排障使用。
> 会话背景：`/Users/cangwei/Downloads/20260818-dsh` 工作目录后续可能被销毁，本会话的上下文也会消失，
> 因此把本会话的工作完整沉淀在这里。

---

## 0. 一句话总结

本次会话完成了三件事：

1. **修复插件被市场覆盖的问题** —— 把 `dsh-recall-plugin` 从 npm 包依赖改成 `link:` 本地依赖，彻底免疫市场更新。
2. **新增 1.5.0 功能** —— 撤回后自动把被撤回的消息文本回填到 DSH 输入框。
3. **仓库迁移** —— 把插件仓库从 `~/Downloads/20260818-dsh/dsh-recall-plugin` 移动到
   `~/Personal.localized/develop/github/dsh-recall-plugin`，并更新了所有 link 引用。

---

## 1. 仓库当前位置与状态

- **仓库路径**：`/Users/cangwei/Personal.localized/develop/github/dsh-recall-plugin`
- **Git remote**：`https://github.com/CangWeiohh/dsh-recall-plugin.git`（origin）
- **当前版本**：`1.5.0`
- **最新提交**：`2d8962c feat: 撤回后自动回填消息文本到输入框（1.5.0）`

```
2d8962c feat: 撤回后自动回填消息文本到输入框（1.5.0）
ce6438d feat: 设置入口迁入官方「插件配置」分区（1.4.2）
5eebc1c fix: 撤回按钮不自动出现 + 冷会话根目录解析错误（1.4.1）
...
```

> 注意：迁移后提交 `2d8962c` 已包含 1.5.0 的回填功能。若未来发现 1.5.0 的改动未 push 到远端，
> 执行 `git push origin main` 即可（迁移本身不影响 remote 指向）。

---

## 2. 插件如何被 DSH Desktop 安装（关键！）

### 2.1 DSH Desktop 的配置位置

```
用户数据目录:   /Users/cangwei/Library/Application Support/dsh-desktop
harness 目录:   /Users/cangwei/Library/Application Support/dsh-desktop/harness
profile 目录:   /Users/cangwei/Library/Application Support/dsh-desktop/harness/profiles/web
```

> 注意：DSH Desktop 用的是 `dsh-desktop/harness`，**不是** `~/.dsh`（那是另一种 DSH 布局）。

### 2.2 link: 依赖机制

`profiles/web/package.json` 中 `dsh-recall-plugin` 依赖为：

```json
"dsh-recall-plugin": "link:/Users/cangwei/Personal.localized/develop/github/dsh-recall-plugin"
```

效果：

- `profiles/web/node_modules/dsh-recall-plugin` 是指向源仓库的**软链**，改源码即改已安装插件。
- 市场（dshmarket）对 `link:` 依赖**永不提供更新**（`updates.js` 返回 `kind:'linked'`、
  `updateAvailable:false`；更新路由直接返回 400 拒绝），所以不会再被 npm 版本覆盖。
- 每次 DSH 重启 / `pnpm install` 都会重新建立软链，但始终指向源仓库，内容不受影响。

### 2.3 如果 link 失效（比如又换了目录）

```bash
# 1) 修改 profile 的 package.json 中 dsh-recall-plugin 的 link 路径为新路径
# 2) 在 profile 目录重新 install（用 DSH 打包的 pnpm，CI=true 防止 TTY 卡住）
cd "/Users/cangwei/Library/Application Support/dsh-desktop/harness/profiles/web"
CI=true NO_COLOR=1 "/Users/cangwei/Library/Application Support/dsh-desktop/harness/.desktop-bin/pnpm" install --no-frozen-lockfile
# 3) 重启 DSH Desktop
```

### 2.4 备份

迁移时生成了备份（profile 目录下）：

- `package.json.bak-20260819-172046`
- `pnpm-lock.yaml.bak-20260819-172046`

这些是迁移前的备份，确认一切正常后可删除。

---

## 3. 本次功能：1.5.0 撤回后回填输入框

### 3.1 需求

点击「撤回」按钮后，把被撤回的消息文本自动回填到 DSH 的输入框中，方便修改后重新发送。

### 3.2 实现（全部在 `lib/client.js`）

**新增 `fillDraft(targetSessionId, text)`**：

- 通过 `ctx.get('conversation')` 获取官方 `conversation` 服务（`ConversationController`）。
- 调 `conversation.input.shell(sessionId)` 得到 per-session 的输入 shell（`SessionInputShell`）。
- 调 `shell.actions.setDraft(text)` 写入输入框 draft —— 这是与输入框自身**同一条官方写入通道**
  （走 InputMachine，draft 镜像同步，输入框即时刷新）。
- 带 8 次 × 150ms 有界重试，覆盖 fork+open 后 shell 就绪的竞态；拿不到服务时静默跳过，不阻塞撤回主流程。

**`executeRecall` 接线**：

- 对话回退成功（fork 出新会话）→ 回填到**新会话**（当前视图已切到它）。
- 对话回退失败 / 无 cutSeq → 回填到**当前会话**。
- 回填内容 = 被撤回消息的文本（`text` 变量，从消息 blocks 提取）。

### 3.3 关键 API 参考（DSH 官方，未来改动可能用到）

```js
// 官方 conversation 服务的形态（来自 @deepseek-ai/dsh-client-ui-conversation）：
// - ConversationController 注册为服务名 "conversation"（super(ctx, "conversation")）
// - 构造时传入 { input: InputHub, blocks: ComposerBlockRegistry }
// - InputHub.shell(sessionId) → SessionInputShell（无则尝试创建）
// - SessionInputShell.actions.setDraft(text) → 写入 draft
// - SessionInputShell.publish() → state.set() + mirrorFn(draft) → 输入框更新

// 其他插件同款用法（可参考）：
// - dsh-client-ui-commands:    actx.get("conversation").input.for(actx).notify(...)
// - dsh-client-ui-model-selection:  this.ctx.get("conversation").blocks.set(...)
```

### 3.4 已知限制

- 只回填**文本**，消息中的图片附件不回填（draft image 机制较复杂，当前未处理）。
- 若 `ctx.get('conversation')` 拿不到服务（极端时序），回填静默跳过，撤回本身不受影响。

---

## 4. 修复历史：插件被覆盖问题（本次会话前半段）

### 4.1 问题

插件之前在 profile 里是 npm 依赖 `"dsh-recall-plugin": "^1.4.0"`。虽然把 node_modules 里的
代码手动改成 1.4.2 修复了问题，但**任何 `pnpm install` 都会把它对齐回 npm 的 1.4.0**，修改丢失。

### 4.2 根因

直接改 `node_modules` 不持久 —— DSH 启动 / 市场操作触发 `pnpm install` 时，会从 lockfile /
npm 重新铺 node_modules，手改的文件被覆盖。

### 4.3 永久修复

改成 `link:` 依赖，指向源仓库（见 §2.2）。更新检测对 link 永久返回无更新，且 pnpm 重装只重建软链。

---

## 5. 发布流程（若未来要发新版本到 npm）

```bash
# 改代码 → bump package.json version → 更新 CHANGELOG.md → 提交
git add -A && git commit -m "feat/fix: ..."
git push origin main
npm publish          # 需要 npm 登录（access: public）
# 可选：打 GitHub Release 标签
```

版本规范（来自 AGENTS.md）：修复 bump patch，新功能 bump minor。

---

## 6. 开发与本地验证

- **开发时**：改 `lib/*.js` 源码即可（link 依赖，安装即源码）。
- **Host 半（index.js 等）**：改完需重启 DSH Desktop。
- **Client 半（client.js）**：改完需重启 DSH Desktop（bundle 在启动时加载）。
- **冒烟路径**：中文路径工作区 → 发消息（出快照）→ 改文件 → 撤回（确认面板清单正确、
  文件恢复、对话回退、标题不变、输入框回填文本）。

---

## 7. 关键文件地图（速查）

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Host 半：装配域模块、`/api/recall/*` 六端点、快照触发 |
| `lib/client.js` | Client 半：撤回按钮/确认面板/回填输入框、设置卡片 |
| `lib/store.js` | 执行与存储层：shell 执行、root/git 解析 |
| `lib/snapshots.js` | 快照域：capture/diff/rollback、index.json |
| `lib/maintenance.js` | 维护域：定期 git gc、会话删除联动 |
| `lib/scripts.posix.js` / `lib/scripts.pwsh.js` | bash / PowerShell 命令模板（同名导出） |
| `cordis.patch.yml` | 持久插件挂载声明 |
| `AGENTS.md` | 项目速览（AI 编码代理指南） |

---

## 8. 本次会话完整操作时间线

1. 发现插件被覆盖回 1.4.0（node_modules 时间戳 Aug 19 15:51，npm 对齐导致）。
2. 确认 DSH Desktop 配置目录是 `~/Library/Application Support/dsh-desktop/harness`。
3. 把 profile 依赖改为 `link:` 指向源仓库 → `pnpm install` → 软链建立、版本 1.4.2。
4. 重启 DSH 验证插件正常加载（快照持续写入）。
5. 用户反馈撤回不回填输入框 → 调研官方 `conversation.input` API → 实现 `fillDraft` + 接线。
6. 用户测试通过。
7. 用户要求迁移仓库 → 提交 1.5.0 → `mv` 到 `~/Personal.localized/develop/github/` →
   更新 profile link 路径 → `pnpm install` → 验证软链/版本/组合正常。
8. 写本记录文档。
