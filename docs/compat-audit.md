# compat 台账：官方 API 耦合点矩阵

> 本文是「一直成立的事实」规范（非计划）：把 AGENTS.md「已知坑」的散文列表升级为
> 「子系统 × 不变量 × 探针」矩阵，供 **dsh 升级后定点复查**——升级后先过本表，逐条
> 核对「出处」是否漂移，替代全文重读 AGENTS.md。AGENTS.md「已知坑」保留为一行一条
> 索引，细节住这里，避免双写漂移。
>
> 出处标注为 2026-08-28 核验；每次 dsh 升级后按「复查动作」更新本节「核验日期」。

## 矩阵

### I1 conversation.chat.node keyed slot：负值 priority + 冲突递减重试
- **依赖的官方行为**：keyed slot（key=`user`）不指定 priority 会因与默认渲染器同 key
  冲突而拒载整个插件；负值 priority 覆盖默认实现。
- **出处**：`dsh-client-ui-conversation` slot 注册契约（slots.d.ts / ChatNodeSeat.d.ts）。
- **探针/单测**：无直接探针（client 加载契约，见 I13）；冒烟「撤回按钮出现」覆盖。
- **失效症状**：插件白屏/整体拒载，或撤回按钮不渲染。
- **复查动作**：核对 keyed slot 冲突语义与 priority 覆盖规则未变；`['user','steering']`
  两 key 仍是独立注册。

### I2 chat.node props：只有 renderMessageImages，无 loadImage
- **依赖的官方行为**：`renderMessageImages({ images: [{attachment}], align })` 是图片
  渲染唯一入口；`loadImage` 被 `Omit<MessageImagesOwnerProps,'loadImage'>` 明确剔除。
- **出处**：`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`
  （`Omit<MessageImagesOwnerProps,'loadImage'>`）。
- **探针/单测**：`tests/probe/api-surface.test.js`（renderMessageImages 存在 + Omit 整型匹配）。
- **失效症状**：图片永久无声空白（issue #9：读不存在的 loadImage，守卫 return，零报错）。
- **复查动作**：重跑 test:probe；确认 images 仍传 image 块数组（非裸 attachment）。

### I3 session-scope slot props 合成：props.sessionId 由 kit 注入
- **依赖的官方行为**：`props = {...kit, ...injected, ...slotInjected.props, ...ownerProps}`，
  kit 注入 `sessionId/useSession/useSessions/useWorkspaces/useProjection`；owner 同名覆盖 kit。
- **出处**：`dsh-client-ui-renderer` standardProps/renderEntry（构建产物）。
- **探针/单测**：无直接探针；UserRecallNode 读取 `props.sessionId`/`props.renderMessageImages`。
- **失效症状**：撤回按钮按 `sessionId` 查询失效（按钮出现但快照查询错会话）。
- **复查动作**：核对 standardProps 合成顺序未变；props.sessionId 仍为 kit 注入。

### I4 消息节点 id：node.id 是快照主键，node.key 是位置键
- **依赖的官方行为**：`node.id` 是真实消息 ID；`node.key` 是位置键（如 `13:input`）。
- **出处**：`dsh-client-ui-conversation` ChatNode 类型。
- **探针/单测**：无直接探针；冒烟「撤回 → 文件恢复正确」覆盖。
- **失效症状**：快照查询永远 miss，撤回按钮永不出现或撤回错消息。
- **复查动作**：确认 ChatNode.id 语义未变（仍为消息 ID）。

### I5 chat.node keyed key 与 UI 投影 kind 对齐（user + steering）
- **依赖的官方行为**：agent 运行中插入的转向指令投影为 `steering`（非 `user`），存储层
  `role` 恒 user；只注册 `key:'user'` 时 steering 节点落到官方默认渲染、撤回按钮缺失。
- **出处**：`dsh-client-ui-conversation` 投影 kind 定义。
- **探针/单测**：无直接探针；冒烟「agent 运行中转向指令带撤回按钮」覆盖。
- **失效症状**：转向指令消息无撤回按钮（静默缺失）。
- **复查动作**：确认 UI 投影 kind 集合未新增需覆盖的键。

### I6 sessions.fork：不传 increaseTitle（标题「xxx 2」回归钉）
- **依赖的官方行为**：`fork({ sessionId, atSeq?, increaseTitle? }) → Promise<SessionId>`；
  `increaseTitle` 会把子会话标题改为「xxx 2」并递增。
- **出处**：`dsh-client-runtime/lib/types/client/contract/sessions.d.ts` L90-94。
- **探针/单测**：`tests/probe/api-surface.test.js`（fork 签名 + increaseTitle 可选）。
- **失效症状**：撤回后标题变「xxx 2」且多次撤回递增。
- **复查动作**：确认 fork 签名未变、increaseTitle 仍可选；本项目仍不传它。

### I7 archiveSession 语义：归档 = 从分组表面隐藏（F1 lineage 链断裂根因）
- **依赖的官方行为**：`archiveSession(sessionId)` 把会话移入 registry-global set，
  **hidden from grouping surfaces**（日志与记账槽保留）。
- **出处**：`dsh-client-runtime/lib/types/client/contract/workspaces.d.ts` L89-94。
- **探针/单测**：无直接探针；F1 用 Host 记录 fork lineage 绕过该限制。
- **失效症状**：纯 client 侧从 sessions.list 读不到已归档中间版本的 parentId。
- **复查动作**：确认 archiveSession 仍「隐藏但保留日志」；若改为可列举，F1 可简化。

### I8 sessionQuery.listSessions：会话 id 在 header.id
- **依赖的官方行为**：listSessions 记录形如 `{header, live, persisted}`，会话 id 在
  `header.id`；顶层 `record.id` 恒 undefined。
- **出处**：`dsh-session-query/lib/types/corpus.d.ts`（`header: SessionHeader`）。
- **探针/单测**：`tests/probe/api-surface.test.js`（header: SessionHeader + listSessions）。
- **失效症状**：预热重建的孤儿快照 sessionId 记空，树形管理落「已删除会话」。
- **复查动作**：确认 SessionRecord.header 结构未变。

### I9 冷启动 sessions.list() 为空：exclude 枚举须叠加 home 容器磁盘兜底
- **依赖的官方行为**：`ctx.sessions.list()` 是纯内存 Map，冷启动惰性载入常为空。
- **出处**：ISessions 契约（纯内存）+ `resolveHomeContainer` 磁盘兜底（本项目 store.js）。
- **探针/单测**：无直接探针；冒烟「冷启动设置页可见排除配置」覆盖。
- **失效症状**：设置页误报「尚未创建快照存储」，exclude 编辑不可见。
- **复查动作**：确认 sessions.list 仍为惰性载入；resolveHomeContainer 兜底路径仍有效。

### I10 cordis inject 门禁：ctx.<service> 必须在 inject 声明
- **依赖的官方行为**：cordis 4 要求服务在插件 `inject` 声明才可经 `ctx.xxx` 访问，漏声明
  抛 `cannot get property "xxx" without inject`，被守卫式 try 吞掉后静默 fail-open。
- **出处**：`dsh/node_modules/@deepseek-ai/cordis/lib/index.js`（ReflectService handler）。
- **探针/单测**：`scripts/verify-host.mjs`（真实 Context apply 不抛 = inject 完整）。
- **失效症状**：如 agentBusy 恒返回「不忙」、撤回防护失效（P0-1 实证）。
- **复查动作**：新增 `ctx.<服务>` 调用点同步加进 `inject`；verify:host 变红即修。

### I11 Host import @deepseek-ai/* 按模块真实路径解析（junction）
- **依赖的官方行为**：npm/git 安装走 profile 树（hoisted）；link: 开发安装走工作区，
  须自备 `node_modules/@deepseek-ai/{schemastery,dsh-settings}` junction。
- **出处**：ESM 无全局 node_modules 回退；AGENTS.md「开发与验证」节 junction 重建命令。
- **探针/单测**：`verify:host` / `npm test` 能 import 即通过。
- **失效症状**：`ERR_MODULE_NOT_FOUND`（1.6.0 实证）。
- **复查动作**：link 模式开发前确认 junction 存在；丢失按 AGENTS.md 命令重建。

### I12 settings.plugin.item 按 namespace 交集分发
- **依赖的官方行为**：`settings.plugin.item` 是 root 级 keyed slot，按 settings namespace
  作为 entryKey 分发；卡片 key 必须与 Host namespace（`dsh-recall`）一致。
- **出处**：`dsh-client-ui-settings-plugins` configurable 标签页声明。
- **探针/单测**：无直接探针；冒烟「设置页撤回卡片出现」覆盖。
- **失效症状**：设置卡片永不渲染（key 不匹配，静默）。
- **复查动作**：确认 namespace 分发语义未变；卡片 key 与 Host namespace 同步。

### I13 ModuleLoader：单文件 CJS factory 包裹（R1 路线 B 依据）
- **依赖的官方行为**：插件 bundle 由 `serveBundle` 原文 serve 为 `text/javascript`，浏览器
  以 classic `<script>` 执行；factory 的 `require(spec)` 只按「包名」粒度解析（seed →
  loadCache → 已注册 factory），不认相对路径，未命中 throw（bundle purity gate）。
- **出处**：`dsh-client-modules/lib/index.js` L212（`window.__ModuleLoader__`）、
  serveBundle、`dsh-client-modules/lib/client.js` makeRequire（miss 分支）——
  注意两处 `lib/client.js` 不要混淆：前者是官方包内文件，后者是本仓库的构建产物
  （A8 澄清）。
- **探针/单测**：`scripts/build-client.mjs` 产物断言（factory(require) 包裹 + 无顶层 import）。
- **失效症状**：ESM 多文件相对 import → 顶层 import SyntaxError 拒载（白屏）。
- **复查动作**：dsh 升级后确认 loader 仍为「单文件 CJS table」；若支持 ESM 多文件，
  R1 可换路线 A。

### I14 pwsh 对 native 非零退出不抛：关键命令显式查 $LASTEXITCODE
- **依赖的官方行为**：PowerShell 的 `$ErrorActionPreference` 不作用于 native 命令，非零
  退出码不抛；不显式检查会「旧索引/空树假成功」。
- **出处**：`lib/scripts.pwsh.js`（snapshot/diff/rollback/rescue 模板的显式 throw）。
- **探针/单测**：`tests/unit/scripts-contract.test.js`（模板结构断言）。
- **失效症状**：空树假成功（1.7.0 实证）。
- **复查动作**：新增 pwsh native 命令模板时维持 `$LASTEXITCODE` 检查。

### I15 runShell 失败兜底：g='<store.git>' 赋值约定 + RECALL_CLEANUP 哨兵
- **依赖的官方行为**：runShell 失败路径从脚本文本提取 `g='<store.git>'` 清孤儿进程与
  stale 锁；清扫脚本带 `RECALL_CLEANUP` 哨兵防递归。
- **出处**：`lib/store.js` extractGitDir / cleanupAfterGitFailure。
- **探针/单测**：`tests/unit/scripts-contract.test.js`（STORE_SCRIPTS 的 g= 约定 + 哨兵）。
- **失效症状**：孤儿 git 持锁 30+ 分钟；清扫脚本自递归。
- **复查动作**：新增带 store 脚本模板必须维持 g= 赋值；scripts-contract 变红即修。

### I16 POSIX while 循环体禁用 cond && cmd
- **依赖的官方行为**：`set -e` 下 `cond && cmd` 条件为假时整条管道退出码 1，杀脚本。
- **出处**：`lib/scripts.posix.js`（snapshotScript 的 if/fi 用法）。
- **探针/单测**：`tests/unit/scripts-contract.test.js`（结构断言，间接）。
- **失效症状**：快照脚本在「无跳过」路径整条退出码 1、set -e 杀脚本。
- **复查动作**：新增 posix while 循环体一律 if/fi；不回归 cond && cmd。

### I17 git init <dir>：repo 与 git 是两个路径概念
- **依赖的官方行为**：`git init <dir>` 把真实 git-dir 建在 `<dir>/.git`。
- **出处**：`lib/store.js` makeStore（repo=dir/git、git=dir/git/.git）。
- **探针/单测**：无直接探针；冒烟「中文路径工作区快照/撤回」覆盖。
- **失效症状**：脚本 `--git-dir` 指向错误路径，快照/回退全失败。
- **复查动作**：git init 语义为 git 固有行为，无 dsh 升级风险；改 store 布局时复核。

### I18 子进程不继承 DSH_HOME：POSIX home 探测三档回退
- **依赖的官方行为**：DSH bash 执行器洗刷子进程 DSH_* 变量，用户导出的 DSH_HOME 在
  bash 里通常不可见。
- **出处**：`lib/store.js` posixHomeBaseResolve（bash env → Node 主进程 env → os.homedir()）。
- **探针/单测**：无直接探针；冒烟「POSIX 下快照存对 home」覆盖。
- **失效症状**：快照存错 home 目录（或降级到项目内）。
- **复查动作**：确认 dsh-subprocess 仍洗刷 DSH_* 变量；三档回退顺序仍正确；第三档落点为 `homedir/.dsh`（I24，勿回退成裸 homedir）。

### I19 快照索引两段式补全：manage list 字段补全 + messageTexts null 缓存
- **依赖的官方行为**：`sessionQuery.readSession` 冷读整日志解压很贵（10 秒级），快照管理
  列表首屏不等冷标题/消息文本，由 client 异步二次请求补齐。
- **出处**：`lib/index.js` manage titles/messages 端点 + `lib/client.js`（src/client）两段式。
- **探针/单测**：`tests/unit/client-pure.test.js`（buildTree）+ 冒烟「树形展开见标题/消息」。
- **失效症状**：冷会话标题/消息永不补齐，或无文本消息每次刷新重复解压冷日志。
- **复查动作**：确认 readSession 契约未变；messageTexts null 也缓存（避免重复冷读）。

### I20 批量删 tag 分块（每 100）：win32 命令行 32767 上限
- **依赖的官方行为**：DSH pwsh 执行器把命令串作为 `-Command` 单个 argv 元素 spawn，Windows
  命令行 32767 字符上限。
- **出处**：`lib/index.js` deleteSnapshotsByFilter / `lib/maintenance.js` purgeSession。
- **探针/单测**：无直接探针；冒烟「长历史工作区批量删除」覆盖。
- **失效症状**：长历史工作区批量删 tag spawn 失败。
- **复查动作**：新增批量命令时维持分块；上限值随 pwsh 执行器实现复核。

### I21 ps1 测试文件带 BOM（PS 5.1 无 BOM 按 ANSI 解析）
- **依赖的官方行为**：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI(GBK) 解析，中文路径乱码。
- **出处**：AGENTS.md 已知坑；真实链路（argv 直传 + UTF8_PRELUDE）不受影响。
- **探针/单测**：无（测试文件约定）。
- **失效症状**：手写 .ps1 测试里中文路径乱码。
- **复查动作**：新增 .ps1 测试文件必须带 BOM。

### I22 Client 查 snapshot-info 前必须等 ensureInit 回调
- **依赖的官方行为**：Host 端 init 要跑数条 shell（建仓/loadIndex），是异步预热；快照捕获
  也是异步的。client 侧「单槽缓存 init promise + 有界轮询」是自有时序约定（非官方字段）。
- **出处**：`src/client/util.js` ensureInit / `src/client/recall-node.js` UserRecallNode 轮询。
- **探针/单测**：无直接探针；冒烟「冷启动撤回按钮出现」覆盖。
- **失效症状**：冷启动误判 `has:false` 且不重试，撤回按钮永不出现。
- **复查动作**：确认 init 仍为每会话一次的异步预热；轮询窗口/次数与快照耗时匹配。

### I23 manage list 同 id 去重须字段补全（磁盘先占位、内存后补）
- **依赖的官方行为**：快照列表是「磁盘 dump + 内存缓存」并集，同一 id 可能磁盘先占位
  （root 缺失）、内存后补全；按「首次命中即丢弃」会让节点落「未知工作区」。
- **出处**：`lib/index.js` manage list 的 push 补全逻辑 / collectAllSnapshotRecords。
- **探针/单测**：无直接探针；冒烟「跨工作区快照树形归组正确」覆盖。
- **失效症状**：树形一级节点落「未知工作区」，批量删除按工作区/会话匹配不到。
- **复查动作**：确认 store 目录仍是 root 的单向哈希（磁盘反查 root 依赖 root.txt/index）。

### I24 POSIX home 三级回退第三档缺失 .dsh 子目录（issue #11 修复）
- **依赖的官方行为**：win32 第三档是 `Join-Path USERPROFILE .dsh`；POSIX 版曾直接用
  裸 `os.homedir()`，两平台第三档布局不一致，快照落 `~/dsh-recall-snapshots` 而非
  `~/.dsh/dsh-recall-snapshots`（issue #11 截图实证）。
- **出处**：`lib/store.js` selectPosixHomeBase / resolvePosixHomeBase（第三档补 `/.dsh`
  + 旧容器一次性迁移四态编排）vs `lib/scripts.pwsh.js` homeDirScript；迁移模板
  `lib/scripts.posix.js` legacyHomeMigrateScript。
- **探针/单测**：`tests/unit/store-path.test.js`（三分支 + 迁移四态 + 模板形状）。
- **失效症状**：POSIX 快照落 `~/dsh-recall-snapshots`；改 base 而无迁移时存量用户
  「看不到」历史快照。
- **复查动作**：改 POSIX home 解析链时核对第三档仍拼 `/.dsh`；legacyHomeMigrateScript
  四态输出未漂移（MIGRATE_OK/OLD_ABSENT/BOTH_PRESENT/MIGRATE_FAIL）；parity SKIP
  集合三处（store.js checkScriptParity、scripts-contract.test.js）仍含该平台专属导出。

### I25 失败清扫分级：心跳 + 新锁保护活跃实例（issue #11 根因治理）
- **依赖的官方行为**：POSIX `kill -0` / win32 `Get-Process -Id` 探活；`find -mmin` 与
  `.LastWriteTime` 的 mtime 判定；心跳文件内容为「宿主 PID + epoch 秒」ASCII 单行
  （pwsh 侧必须 ascii 编码——utf8 会带 BOM 破坏 POSIX 侧首字段解析）。
- **出处**：`lib/scripts.pwsh.js` / `lib/scripts.posix.js` killOrphansScript（三级出口
  CLEANUP_OTHER_INSTANCE / CLEANUP_SKIPPED_FRESH_LOCK / CLEANUP_DONE）+
  ensureGitScript/snapshotScript 的 heartbeatBlock 写入 + `lib/store.js`
  parseCleanupResult / cleanupAfterGitFailure。
- **探针/单测**：`tests/unit/diagnostics.test.js`（parseCleanupResult + 接线）+
  `tests/unit/scripts-contract.test.js`（出口标记、心跳接线、STALE_LOCK_MIN /
  HEARTBEAT_TTL_S 两侧同值）。
- **失效症状**：多实例互踩死循环回归（清扫误杀对方活跃 git → 对方也失败 → 循环）。
- **复查动作**：改锁清单或阈值时两侧常量必须同步；心跳写保持 fail-open（不连累
  快照主流程）；parseCleanupResult 的标记名与模板输出逐字一致。

### I26 影子仓库固化 info/attributes 字节保真（issue #12 修复）
- **依赖的官方行为**：`git archive` 与 `git add` 都应用「快照树里项目自己的
  .gitattributes」——`text=auto` + 缺省 `core.eol=native`（Windows 即 CRLF）会让
  archive 解包把 LF 转 CRLF，仓库级 `core.autocrlf=false` 挡不住（属性驱动的转换
  看 core.eol，不看 autocrlf，实测）。`$GIT_DIR/info/attributes` 是优先级最高的
  属性源，对全部路径一票否决树内与全局属性。另两个实测细节：`git add
  --renormalize` 无 pathspec 是空操作（必须 `-- ':(top)'` 顶层魔法 pathspec，
  且不能加 --literal-pathspecs）；属性变更后裸 add -A 受 stat 缓存影响时序依赖
  地跳过重哈希（racy 复查只覆盖「add 与文件同秒写入」），存量归一化条目需要
  显式 renormalize 迁移。
- **出处**：`lib/scripts.pwsh.js` / `lib/scripts.posix.js` FIDELITY_ATTRS 常量 +
  ensureGitScript 的 info/attributes 固化 + snapshotScript 的 attrsMigrateBlock
  （一次性 renormalize，标记文件 attrs-v1.stamp，失败不 throw 保快照主流程）。
- **探针/单测**：`tests/unit/scripts-contract.test.js`（两侧常量逐字同值、固化行、
  renormalize + ':(top)' + 迁移标记）；issue #12 分析的实验矩阵与真实模板端到端
  复验（2026-08-29，本机 system autocrlf=true + 恶意 .gitattributes，16 项全过）。
- **失效症状**：text=auto / eol=crlf 项目回退后换行符漂移（LF↔CRLF 双向失真，
  capture 侧归一化 + restore 侧反向转换）；`export-ignore` 声明让文件从回退归档
  静默消失（快照有、恢复无、零报错）；clean filter / $Id$ / working-tree-encoding
  改写恢复内容。
- **复查动作**：git 升级后复核 info/attributes 优先级仍高于树内 .gitattributes、
  archive 仍应用属性转换（若 git 未来改为「archive 不做转换」，固化即冗余无害）；
  FIDELITY_ATTRS 两侧同值；改动属性内容须同步换 attrs-v1.stamp 标记名（版本化，
  让存量仓库重新迁移）。

## 与 E1 verify-host 的对应关系

装配层条目（I10 inject 门禁、端点注册、Config schema、卸载清零）由
`scripts/verify-host.mjs` 机器化断言；字段层条目（I2/I6/I8 等）由 `tests/probe/`
字段探针断言；纯逻辑与脚本契约由 `tests/unit/` 断言。矩阵里「探针/单测」标注
`无直接探针` 的条目即为测试缺口，dsh 升级后优先补。
