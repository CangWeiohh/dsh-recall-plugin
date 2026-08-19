# 更新日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [1.5.0] - 2026-08-19

### 新增

- 撤回后自动把被撤回的消息文本回填到输入框：方便用户修改后重新发送。走官方 `conversation` 服务的 `input.shell(id).actions.setDraft`（与输入框自身同一写入通道，draft 镜像同步），对话回退成功时填入新会话、回退失败时填入当前会话；带 8 次 × 150ms 有界重试覆盖 fork+open 后 shell 就绪竞态，拿不到服务时静默跳过、不阻塞撤回主流程。

## [1.4.2] - 2026-08-18

### 变更

- 设置入口从独立标签页「撤回设置」迁入官方「插件配置」分区：改用 `settings.plugin.item` keyed slot（按 namespace 分发），与 modlens 等第三方插件一致；Host 端 `index.js` 注册空 pass-through `dsh-recall` namespace 使 `settings.describe` 命中、卡片可被分发（真实配置仍走自有 `/api/recall/*` 端点，不经 settings 读写）。卡片改为折叠式（与官方内置卡片同款外观），展开后展示排除项编辑与快照管理。

## [1.4.1] - 2026-08-18

### 修复

- 撤回按钮不自动出现、需手动刷新：快照捕获（Host 侧脚本）是异步的，客户端在消息节点挂载时只查一次 `snapshot-info`，若先于捕获完成返回 `has:false` 则永不重试、按钮消失直到刷新。改为有界轮询（近 5 分钟内的新消息最多 20 次 × 1s，`has:true` 即渲染按钮），捕获完成后按钮自动出现。
- 冷会话（未 live）根目录解析错误：`resolveRoot` 只认 live 会话，冷启动时回退到 `sandboxPolicy.workspaceRoot`（常为 harness 启动目录）导致查错 store、快照永远查不到。改为先经 `sessionQuery.listSessions`（廉价目录枚举）从持久化 header 解析真实 cwd；且只缓存 live/持久化来源的结果，回退的临时根不缓存，避免错误根遮蔽后续正确解析。

## [1.4.0] - 2026-08-17

### 新增

- 官方插件配置机制：`cordis.patch.yml` 行声明默认值（`gcSnaps`/`gcHours`/`maxFileBytes`/`baseExcludes`），用户在 profile 的 `cordis.patch.yml` 按 `id: recall` 重述该行即可覆盖；`DSH_RECALL_GC_SNAPS/GC_HOURS` 环境变量保留为最高优先（向后兼容）。
- 回退前自动保存安全快照（`snap-pre-rollback-<时间戳>` tag，不进列表），误回退后可从该 tag 找回，堵住唯一的不可逆操作缺口；确认面板文案同步说明。
- 设置页「快照管理」卡片：快照列表（时间倒序，含工作区名/会话标题）、当前工作区磁盘占用、单条删除、「立即 gc」手动触发、最近错误展示（Host 侧失败原本只在宿主进程日志，页面不可见）。
- 快照列表跨工作区名称解析：`saveIndex` 条目持久化 `root`；store 目录新增 `root.txt` 元数据（旧 store 重新解析时自动补写）；工作区 cwd 全集取「live 注册表 + `sessionQuery.listSessions` 冷元数据」并集（冷启动注册表为空也能解析）。
- 快照管理性能优化：新增双平台 `storesDumpScript` 一条 shell 批量 dump 全部 store 元数据（旧实现每目录 2-3 条 shell 串行，冷列表 20 秒级）；列表 30 秒结果缓存（删除/新快照失效）；冷会话标题两段式——列表首屏只查 live/缓存（同步瞬时），冷标题（整日志解压 10 秒级）由客户端异步 `titles` 端点补齐、行内先显示「…」。实测冷列表 20s+ → 2.3s、缓存命中 8ms、删除 20s+ → 4.4s。
- Host 新增 `manage`（list/usage/delete/gc）与 `status`（最近错误环形缓冲）端点；`preview`/`execute` 与快照/gc 共用同一条串行队列，消除 git index 锁并发竞态。
- 变更清单截断保护：超过 500 条时面板显示「仅显示前 N 条」，总数仍准确；请求体 1MB 上限（`BODY_TOO_LARGE`）；启动时自检两套脚本模板的同名导出对齐。

### 修复

- 索引载入失败（如 shell 未就绪）后该工作区本次进程内被永久标记「已载入」、撤回按钮消失直到重启——改为读取链路全部走通后才标记，失败自然重试。
- 快照列表「未知工作区」与同快照重复行：旧列表只查内存 `state.snapshots` 且去重 key 带 root——冷启动注册表为空时全部落空。修复后磁盘来源三层解析 root、去重只按消息 ID。
- 管理页删除误报「该快照不存在」：列表来自磁盘全量而删除只查内存——修复为「内存 → 条目 root → 磁盘 index 反查（`locateSnapshotOnDisk`）」解析链；兜底删除前先 `loadIndex` 补齐内存视图，防止 `saveIndex` 用残缺内存覆盖 index.json 抹掉同 store 其余快照；`purgeSession` 对未缓存 root 现场解析 store（原先直接跳过导致该 root 清理永远 miss）。
- 事件重放/重发产生重复 messageId 时 `git tag` 重名 fatal 导致整条快照失败——改 `tag -f`（同一条消息重快照取最新状态）。
- A→B→A 切换会话后 A 复用 B 的 init promise——init 缓存改 `Map<会话, Promise>`。

### 变更

- 错误回包统一为 `{ok, code, message}`（业务失败与系统异常分离，文案与诊断解耦）。
- `saveIndex`/`writeExclude` 的 win32 base64 分块与 POSIX stdin 分叉合并为统一落盘原语 `writeTextViaShell`；脚本导出 `indexWriteCmd`/`excludeWriteCmd` 合并为 `fileWriteCmd`。
- `resolveHomeContainer` 改纯 JS 推导（容器 = home 目录父级），删除与 `homeDirScript` 重复的整条 `$h` shell 解析链（消除双链漂移风险）。
- `maintenance.js` 导出面收敛为 `maybeMaintain`/`runGc`；删除 `index.json` 的死字段 `count`；删除未使用的非 scoped `cordis` peerDependency。
- Host 端点分发重构为端点表 + 统一 try/catch；Client 侧 `kind` 语义（文案/徽章类名/汇总）合并为单表。

### 兼容性

- 全部改动经冒烟实测：临时中文+空格工作区上跑通真实 git 链路（建仓/快照/tag -f 幂等/diff 三类变更检出/回退恢复与删除/分块索引读写/tag 清理/gc/磁盘统计），Windows PowerShell 5.1 与 pwsh 7 双解释器通过。
- 评估阶段曾将 win32 回退改为 bsdtar 优先，冒烟实测否决：GBK 代码页机器上 bsdtar 把 tar 流里的 UTF-8 文件名按 ANSI 解码（中文文件名解包成乱码新文件），已回滚为 zip + Expand-Archive 链路（中文路径实测正确，mtime 语义天然安全）。

## [1.3.0] - 2026-08-17

### 新增

- 设置页「撤回设置」标签（设置 → 插件）：可视化编辑快照排除项——输入路径或模式回车即加、常用模式一键追加（`dist/`、`*.log`、`.env` 等）、放弃修改/保存与未保存状态提示，保存后下一次快照/预览/回退立即生效，无需重启。
- Host 端 `exclude-get` / `exclude-set` HTTP 端点：枚举并读写全部 exclude.txt（home 存储全局共享一份，降级工作区各自独立、分卡片展示）；写入走 base64 分块（win32）/ stdin（POSIX），任意长度配置不受命令行上限约束；写入路径经服务端白名单校验（仅接受枚举结果中的路径）。
- 冷启动兜底：会话注册表未载入时按磁盘 home 容器目录枚举 exclude.txt（`resolveHomeContainer`），设置页不再误报「尚未创建快照存储」。

### 兼容性

- 全部新增 shell 命令在 Windows PowerShell 5.1 与 WSL2 Ubuntu（bash）实测通过，覆盖中文/空格路径、CRLF、空文件、缺失文件等边界。

## [1.2.2] - 2026-08-15

### 修复

- 撤回出的新会话不再向标题追加递增数字：fork 不传 `increaseTitle`，原样继承原标题。

### 文档

- 新增英文 README（README.en.md，与中文版互链）与 AGENTS.md 项目速览。

## [1.2.1] - 2026-08-15

### 修复

- 修正 package.json 仓库地址（仓库改名后同步）；README 安装地址同步。

## [1.2.0] - 2026-08-15

### 新增

- Linux/macOS（bash）平台支持：与 Windows 版同名导出的脚本模板按 `process.platform` 单选；POSIX 侧 `DSH_HOME` 解析对齐执行器 env 洗刷语义（WSL2 实测）。
- 快照自动维护：定期 `git gc`（每 50 条快照或 24 小时先到先触发，`DSH_RECALL_GC_SNAPS` / `DSH_RECALL_GC_HOURS` 可调，`gc.stamp` 跨重启续存节流）。
- 会话删除联动清理：会话日志从磁盘消失后自动删除该会话全部快照 tag 并释放空间；归档不算删除，判断保守（冷会话不误清）。
- 用户自定义排除：home 下 `exclude.txt`（gitignore 语法）全局生效，下一次快照/回退即时应用。

### 变更

- Host 代码模块化拆分（index / store / snapshots / maintenance / scripts.*），零顶层副作用，全部副作用经 `ctx.on` / `ctx.effect`。

## [1.0.4] - 2026-08-15

### 修复

- 非 UTF-8 代码页（GBK）输出乱码、UNC home、非 Windows 平台的通用性问题。

## [1.0.3] - 2026-08-15

### 修复

- 跨机器通用性：git 多候选安装位置探测、索引 base64 分块写入（突破命令行 32767 上限）、目录扫描容错（杀软锁定/异常 ACL）、路径尾分隔符归一、`DSH_HOME` 回退链。

## [1.0.2] - 2026-08-15

### 新增

- 未装 git / home 不可写时页面顶部一次性降级提示（gitMissing / homeFallback）。

## [1.0.1] - 2026-08-15

### 变更

- shell 以宿主身份（`danger-full-access`）执行：受限会话（workspace-write / read-only）也能在 home 建影子仓库、照常快照与回退。

## [1.0.0] - 2026-08-15

### 初始发布

- 消息撤回：影子 git 仓库快照（tag 即快照，项目目录零污染）+ 官方 `sessions.fork` 对话整段回退，原会话归档可找回。
- 确认面板先展示变更文件清单（修改/恢复/删除）再执行；`.git`、`node_modules` 自动排除；超过 100MB 的大文件跳过。
- key 冲突递减重试的 user 槽位注册，Windows PowerShell 5.1 / 7 双版本兼容。
