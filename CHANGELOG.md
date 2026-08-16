# 更新日志

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

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
