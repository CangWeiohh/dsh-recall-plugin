# dsh-recall-plugin

DeepSeek Harness(DSH)**持久插件**(bundle 形态,安装后一直生效):在用户消息气泡的复制按钮旁添加「撤回」按钮,把**项目文件**与**对话历史**一并回退到该消息发送之前(整段回退,参考 TraeWork 的 `revert_message` + 文件快照机制)。

## 功能

- **文件回退**:每条用户消息发送时,工作区被快照进一个**独立影子 git 仓库**(默认存于 `$DSH_HOME/dsh-recall-snapshots/<SHA256(项目路径)>/`,项目目录保持干净)。撤回时通过 `git archive` 恢复文件,二进制安全,不碰项目自身的 git 状态。
- **对话回退**:通过 DSH 官方 `sessions.fork` 机制,把会话切到该消息之前——该消息及之后的对话从当前视图移除,新会话打开,原会话归档(可从归档找回)。
- **二次确认**:点击撤回后先展示将变更的文件清单(修改/恢复/删除),确认后才执行。
- **快照全量保留不修剪**:git delta 压缩省空间,每次撤回后可重复回退、可找回。
- **排除与跳过**:自动排除 `.git`、`node_modules`(尊重项目 `.gitignore`);跳过 >100MB 的超大文件。
- **受限会话自动降级**:会话沙箱为「完全访问」时快照存 home(项目干净);`workspace-write` 等受限会话写不了 home 时自动降级到项目内 `.dsh-recall-snapshots`,权限恢复后自动迁回 home 并清理项目目录。

## 目录结构

```
dsh-recall-plugin/
├── package.json       # dsh.bundle.patch + dsh.client 声明、peerDependencies
├── cordis.patch.yml   # 挂载层（insert 自身行，CLI bundle 协调自动合并）
├── lib/
│   ├── index.js       # Host 半：影子 git 快照引擎 + /api/recall/* HTTP API
│   └── client.js      # Client 半：气泡 UI、撤回按钮、确认面板（__ModuleLoader__ bundle）
├── LICENSE            # MIT
└── README.md
```

## 安装(npm 发布后)

```powershell
# DSH 官方插件命令：安装并自动挂载进 web profile
dsh plugin --profile web add dsh-recall-plugin@<version>

# 重启 DSH（本机示例）
pm2 restart dsh-web
```

重启后硬刷新页面(Ctrl+Shift+R),插件永久生效,无需批准、无需每次重装。

> 依赖的 DSH 包版本见 `peerDependencies`(与 DSH 0.1.0-rc.x 配套)。

## 使用

1. 鼠标悬停任意**插件启用后发送**的用户消息,复制按钮左侧出现 ↶ 撤回按钮。
2. 点击 → 确认面板展示将变更的文件清单(修改 / 恢复 / 删除)。
3. 点「确认回退」→ 文件恢复到该消息发送前的状态;视图切到新会话
   (该消息及之后的对话移除),原会话归档。

## 存储与权限

- 存储位置:`$DSH_HOME/dsh-recall-snapshots/<SHA256(项目绝对路径)>/`,
  内含影子 git 仓库(`git/`,tag 名为 `snap-<消息ID>`)与 `index.json`
  (消息 ID → 快照时间/会话的索引)。
- 查看历史快照:
  ```powershell
  git --git-dir="<store>\git\.git" tag -l
  git --git-dir="<store>\git\.git" ls-tree -r --name-only snap-<消息ID>
  ```

## 已知限制

- 快照在**消息发送时**(agent 修改文件前)创建;插件启用前的历史消息没有快照,
  不显示撤回按钮。
- 会话第一条用户消息无法回退对话(仅文件回退),因为 fork 需要更早的
  turn 边界。
- 仅在 Windows + PowerShell 7 环境验证(依赖 git CLI 与 Expand-Archive)。

## 开发(本地验证,无需发布)

```powershell
# 把包目录放进 web profile 的 node_modules，并登记到 bundles
$pkg = 'D:\workspace\dsh-plugin\dsh-recall-plugin'
$profile = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item -Recurse -Force $pkg "$profile\node_modules\dsh-recall-plugin"
# 手动编辑 $profile\package.json：
#   dependencies 加 "dsh-recall-plugin": "1.0.0"
#   dsh.profile.bundles 加 "dsh-recall-plugin"
# 然后重启 DSH 并硬刷新页面
```

## License

MIT
