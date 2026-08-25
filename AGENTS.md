# AGENTS.md

给 AI 编码代理（和快速上手的人类）的项目速览。读完本文件即可定位任意改动的落点，无需通读源码。

## 一句话理解

DSH 消息撤回插件：在用户消息气泡旁加「撤回」按钮，把**项目文件**（独立影子 git 仓库快照）与**对话历史**（官方 sessions.fork）一并回退到该消息发送之前。

## 核心机制（三个关键词）

1. **影子仓库**：每个工作区在 `~/.dsh/dsh-recall-snapshots/<工作区路径SHA256>/git/` 有独立 git 仓库，`--work-tree` 指向项目目录——项目本身零污染（无 .git、无快照文件落地）。home 不可写时降级到项目内 `.dsh-recall-snapshots/`。
2. **tag 即快照**：每条用户消息触发一次 `write-tree + commit-tree + tag snap-<消息ID>`。不建分支、不动工作区文件；消息 ID 就是快照主键，索引丢失可从 tag 名反推重建（`rebuildOrphans`）。
3. **双轨回退**：文件走影子仓库 reset 到 tag；对话走官方 `sessions.fork({ atSeq: cutSeq })`——cutSeq 是该消息之前最近一次 `turn/end` 的 seq。原会话归档（可恢复），新会话继承原标题（不传 `increaseTitle`，避免"标题 2"递增）。

## 文件地图（改动先看这里）

| 文件 | 职责 | 什么时候改它 |
|---|---|---|
| `lib/index.js` | Host 半入口：装配三个域模块、注册 `/api/recall/*` 端点（init/snapshot-info/preview/execute/exclude-get/exclude-set/config-get/config-set/manage/status/messages）、`installSettingsSection` 挂 settings namespace `dsh-recall`（真 Config schema，watch 热更新 cfg）、接线 `session/event` 快照触发与启动预热；`listExcludeFiles` 枚举全部 exclude.txt（注册表扫描 + home 容器磁盘兜底）并充当写入白名单；`manage` 支持树形管理的 workspace/session 批量删除与 list/usage/gc（usage/gc 无 sessionId 时全局化），`messages` 异步补冷会话消息文本 | 加 API 端点、改事件触发逻辑 |
| `lib/client.js` | Client 半（浏览器）：抢注 `conversation.chat.node` user 渲染槽位（priority -1，冲突递减重试到 -3）、撤回按钮/确认面板/toast、调 fork + 归档、撤回成功后回填消息文本到输入框（官方 `conversation.input` 通道，`refillDraft` 可关）；用户消息图片经官方 `props.renderMessageImages` 渲染（不自研加载链）；注册 `settings.plugin.item` 的「撤回插件」卡片（key=namespace `dsh-recall`：插件配置表单经 settings 用户层读写、exclude.txt 可视化快速编辑、快照管理树形卡片：工作区→会话→快照，三级展开/折叠与删除，叶子显示消息内容摘要） | 改 UI、改 fork 行为 |
| `lib/store.js` | 执行与存储层：`runShell`（统一 `danger-full-access` 宿主身份 + UTF-8 prelude + 失败兜底：按 `$g` 提取 git-dir 做孤儿清扫/清 stale 锁）、root/git 解析、home/降级 store 解析与迁移、`resolveHomeContainer`（设置页兜底用）、`ensureGit` | 改存储布局、shell 执行策略 |
| `lib/snapshots.js` | 快照域：capture/diff/rollback、index.json 落盘与载入、`readExclude`/`writeExclude`（设置页读写，平台分叉与 saveIndex 同构）、孤儿重建、`resolveCutSeq`（live 内存优先，冷会话走 sessionQuery，结果永久缓存）、失败善后（prune 清残骸 + 连续 3 次失败起 5min→60min 指数退避熔断，成功即复位）、失败/跳过反馈（SNAP_SKIP 解析进 snapFeedback，`feedbackFor` 供 snapshot-info 下发，熔断期反馈暂停状态） | 改快照/回退算法 |
| `lib/maintenance.js` | 维护域：定期 `git gc`（每 50 拍或 24h，环境变量 `DSH_RECALL_GC_SNAPS/HOURS` 可调）、会话删除联动清 tag | 改磁盘治理策略 |
| `lib/scripts.pwsh.js` | PowerShell 命令模板（win32） | 改 Windows 命令细节 |
| `lib/scripts.posix.js` | bash 命令模板（linux/darwin），与 pwsh 版**同名导出** | 改 POSIX 命令细节 |
| `cordis.patch.yml` | 持久插件挂载声明（bundle insert 行） | 基本不动 |

**重要约束**：两套脚本模板必须保持同名导出接口——所有调用方统一走 `rt.scripts.*` / `S.*`，按 `process.platform` 在 store.js 单选。

## 关键设计决策（为什么这样写）

- **shell 以宿主身份执行**（`sandboxPolicy: { mode: 'danger-full-access' }`）：受限会话（workspace-write/read-only）写不了 home，read-only 连项目都写不了，回退会直接失败。安全边界靠「命令全是固定模板，唯一变量是插件自己推导的路径，模型无法注入」。
- **串行队列 `state.queue`**：一条消息一次快照，gc/清理排在同队——与快照天然互斥，无 git 锁竞态。
- **幂等与节流**：`ensureGit` 用 `gitReady` Set 跳过重复初始化；home 迁移失败 5 分钟节流（`HOME_RETRY_MS`）；gc 失败也推进时间戳（环境性失败不该堵队列）。
- **win32 索引写入走 base64 分块**（每块 20000 字符）：Windows 命令行 32767 字符上限；POSIX 直接 stdin 写全文。
- **diff 不用 `-z`**：PowerShell 捕获原生命令输出会丢弃含 NUL 的行；改用 `core.quotePath=false` + 逐行按 TAB 解析。
- **pwsh 哈希用 `SHA256::Create()`**：兼容 Windows PowerShell 5.1（无 `Get-FileHash -AsHash` 等新语法依赖）。
- **零构建依赖**：client.js 是纯 JS + `React.createElement`，无打包步骤。

## 数据流速查

```
用户消息 → session/event → captureSnapshot（串行队列）
  → git add -A --ignore-errors（exclude.txt 排除 + 超大文件跳过 + fail-open：
    无法索引的路径退出码 1 容忍、SNAP_SKIP 行回传）→ write-tree → commit-tree → tag
点撤回 → preview（diff 当前 vs tag）→ 确认 → execute（文件回退）
  → resolveCutSeq（找 turn/end）→ client 调 sessions.fork → 原会话归档
快照失败 → runShell 失败兜底（杀 --git-dir 标记的孤儿 + 清 stale 锁）
  → recordError + snapFeedback{failed} → prune 清残骸 + 熔断计数
  → client 轮询 snapshot-info 得 failed → toast（10min 文本节流）并停止轮询
快照成功但有跳过 → snapFeedback{skipped} → client「已跳过未纳入的路径」提示
设置页 → exclude-get（枚举+读）→ 编辑 → exclude-set（白名单校验后写入）
  → excludeSyncBlock 下一次快照/diff/回退时重读 exclude.txt 即时生效
设置页插件配置表单 → config-get（describe user 层 + env 锁定标记）→ 编辑
  → config-set（settings.update 进用户层，watch 热更新 cfg，无需重启）
设置页快照管理 → manage list（磁盘 dump + 内存并集，30s 缓存）
  → 树形分组（工作区→会话→快照）→ titles/messages 异步补冷会话标题/消息文本
  → 删除（scope=workspace/session/snapshot）→ purgeTags 分块 + saveIndex
```

## 存储布局

```
~/.dsh/dsh-recall-snapshots/
├── exclude.txt                    # 用户自定义排除（gitignore 语法，全局共享）
└── <工作区路径SHA256>/
    ├── git/                       # 影子仓库工作目录（空，仅持有 .git）
    │   └── .git/                  # 真实 git-dir（config/info/objects…）
    └── index.json                 # [{id,time,root,sessionId}] 快照索引
```

降级时（home 不可写）：以上结构整体落到 `<项目>/.dsh-recall-snapshots/`，exclude.txt 移入 store 目录内部。

## 开发与验证

```powershell
# 本地开发环境（一次性，已配置）：
# - profile（~/.dsh/profiles/web/package.json）的依赖是 link:<本仓库>——
#   工作区 lib/ 即已安装代码，改完重启 dsh-web 生效，无需复制；市场/pnpm
#   更新对 link: 依赖永不覆盖。
# - 工作区 node_modules/@deepseek-ai/{schemastery,dsh-settings} 是指向
#   dsh 安装目录的 junction：Host 侧直接 import 这两个包，ESM 按真实路径
#   解析（link: 下即工作区），工作区必须本地可寻。注意 dsh-settings
#   0.1.1-rc.2 未发布公共 npm（registry 只有 0.0.1-rc.1），只能从 dsh
#   安装目录链接。junction 丢失（如换机/删 node_modules）时重建：
#   cmd /c mklink /J node_modules\@deepseek-ai\schemastery "%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\schemastery"
#   cmd /c mklink /J node_modules\@deepseek-ai\dsh-settings "%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-settings"

# 发布流程：bump package.json version → git commit/push → npm publish → GitHub Release
# 发布后若要改回跟随 npm 版本：profile 依赖改 "^<ver>" 后 pnpm install
```

- 冒烟路径：中文路径工作区 → 发消息（出快照）→ 改文件 → 撤回（确认面板清单正确、文件恢复、对话回退、标题不变）→ 设置页快照管理（树形展开/折叠、叶子消息内容显示、三级删除与批量删除、立即 gc）。
- 回归注意点：每次动 scripts.*.js 必须两个平台过一遍心智检查（路径引号、编码、命令长度上限差异）。
- 版本规范：修复 bump patch，新功能 bump minor；metadata-only 可不发 GitHub Release。

## 已知坑（踩过的，别再踩）

- keyed slot（`conversation.chat.node` key=user）不指定 priority 会因冲突拒载整个插件——必须负值优先级 + 冲突递减重试。
- `conversation.chat.node` slot 的 props 契约里**没有 `loadImage`**，图片渲染入口是 `props.renderMessageImages`（`(owner) => ReactNode`，内部经 `conversation.message.images` slot 渲染官方 MessageImages，自带鉴权/缓存/失败重试/灯箱）：读不存在的字段守卫直接 return，功能静默失效且毫无报错（issue #9，v1.6~v1.7 用户消息图片因此从未显示）。调用形如 `renderMessageImages({ images: [{attachment}], align: 'end' })`——images 传 image 块数组（内部取 `image.attachment.attachmentId`），不是裸 attachment；布局顺序对齐官方 UserStyleBubble：图片在上、气泡在下。任何 slot props 字段先查官方 `.d.ts`（dsh-client-ui-conversation 的 slots.d.ts / ChatNodeSeat.d.ts），别靠猜。
- `node.id` 才是真实消息 ID（快照主键）；`node.key` 是位置键（如 `13:input`），不能用于查询。
- Client 查 `snapshot-info` 前必须等 `ensureInit` 完成回调，否则冷启动误判 `has:false` 且不重试，按钮永不出现。
- fork 不传 `increaseTitle`（2026-08 修复）：否则撤回出的新会话标题变「xxx 2」且多次撤回递增。
- `git init <dir>` 把真实 git-dir 建在 `<dir>/.git`——代码里 repo 与 git 是两个不同路径概念。
- shell 子进程不继承主进程 `DSH_HOME`：POSIX 侧探测为空时回退 Node 主进程 env 再回退 `os.homedir()`。
- 冷启动 `sessions.list()` 为空（惰性载入）：exclude 枚举不能只扫注册表，必须叠加 home 容器磁盘兜底（`resolveHomeContainer`，2026-08 修复），否则设置页误报「尚未创建快照存储」。
- 树形管理 `manage list` 同 id 去重时不能“首次命中即丢弃”：磁盘先占位、内存后补全 root，必须做字段补全，否则工作区节点落入「未知工作区」且批量删除匹配不到。
- 批量删除 tag 要分块（每 100 个）：win32 命令行 32767 字符上限，长历史工作区整批传会爆；与 `maintenance.purgeSession` 保持一致。
- 消息文本展示是“两段式”补全：`manage list` 只带 live 命中值，冷会话由客户端异步调 `messages` 端点补齐；`messageTexts` 缓存 null 也要落缓存，否则无文本消息每次刷新都重复解压冷日志。
- 手写 .ps1 测试文件必须带 BOM：Windows PowerShell 5.1 读无 BOM 脚本按 ANSI(GBK) 解析，中文路径直接乱码。插件真实链路（argv 直传 + UTF8_PRELUDE）不受影响，但任何落盘 .ps1 的调试脚本都要记得这一点。
- `settings.plugin.item` 是 keyed slot 且按 **namespace 交集**分发：卡片 key 必须与 Host 端 settings namespace（`dsh-recall`，经官方 `installSettingsSection` 注册真 Config schema）一致，Host 未注册 namespace 时卡片永不渲染。各 namespace 独占自己的 key，无同 key 抢占，不需要 priority（与 `conversation.chat.node` 覆盖默认渲染器的 priority 冲突是两套语义）。
- `sessionQuery.listSessions()` 的记录形如 `{header, live, persisted}`，会话 id 在 `header.id`，顶层没有 id 字段——误读 `record.id` 恒得 undefined（1.5.2 修过预热路径这个坑）。
- Host 侧 import 的 `@deepseek-ai/*` 包按**模块真实路径**解析：npm/git 安装的真实路径在 profile 树内（hoisted 平铺可寻）；**link: 开发安装的真实路径是工作区**，工作区必须自备 junction（见「开发与验证」）。另注意 ESM 没有 CJS 的全局 node_modules 回退——用 `require.resolve` 验证可解析会误判（1.6.0 踩过：启动失败 ERR_MODULE_NOT_FOUND）。
- pwsh 对原生命令**非零退出不抛错**（EAP 不作用于 native）：git fatal 后脚本会继续走完后续命令。模板里凡 add 类关键命令必须显式检查 `$LASTEXITCODE` 并 throw，否则产出「旧索引/空树假成功」快照（1.7.0 修，实测 PS 5.1/pwsh 7 均如此）。捕获 native stderr 用 `EAP=Continue + 2>&1`——PS 5.1 的 SilentlyContinue 会把合并流整个丢弃（实测 LOG 为空），Stop 则直接抛 NativeCommandError。
- runShell 失败路径会从脚本文本提取 `g='<store.git>'` 赋值做孤儿进程清扫：**新增带 store 的脚本模板必须维持该赋值约定**（否则清扫静默跳过，属安全降级）；清扫脚本自身带 `RECALL_CLEANUP` 哨兵注释防递归，改它时别删哨兵。
- POSIX 快照脚本里 while 循环体禁用 `cond && cmd` 列表：条件为假时整条管道退出码 1，`set -e` 会杀掉脚本——用 `if/fi`（豁免语义）。
