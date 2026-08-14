# dsh-recall-plugin

> 撤回一条消息，项目文件也一起回去。

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows-blue)
![DSH](https://img.shields.io/badge/DSH-0.1.0--rc-blue)
![Build](https://img.shields.io/badge/%E7%BA%AFJS-%E9%9B%B6%E6%9E%84%E5%BB%BA-green)

用 agent 写代码最狼狈的时刻：发了一条消息，agent 把文件改得一团糟——对话可以撤回，文件却回不去，只好手动一处处回滚。

这个插件把两者绑在一起：悬停任意一条你发过的消息，点「↶ 撤回」，**工作区文件和对话历史一起回到那条消息发出之前的状态**。

## 界面预览

![悬停出现撤回按钮](docs/screenshots/recall-button.png)

| 确认面板 · 变更文件清单 | 确认面板 |
| --- | --- |
| ![确认面板 · 变更文件清单](docs/screenshots/confirm-panel-1.png) | ![确认面板](docs/screenshots/confirm-panel-2.png) |

## 功能亮点

- **文件 + 对话，整段回退**：撤回的不只是聊天记录，agent 改过的文件也一并回到原样。
- **不碰你项目自己的 git**：快照存在独立的影子 git 仓库里，你的分支、暂存区、未提交改动统统不受影响；`.git`、`node_modules` 自动排除。
- **项目目录保持干净**：快照默认存在 `$DSH_HOME` 下，不会往项目里塞任何东西；受限会话写不了 home 时才临时降级到项目内 `.dsh-recall-snapshots`，权限为 Full access 时自动迁走、清理干净。
- **可以反复后悔**：快照全量保留、永不修剪。撤回一次后还能再撤到更早；撤回时被覆盖的文件也一直找得回来。
- **先看清单再动手**：点撤回先弹出将变更的文件清单（修改 / 恢复 / 删除），确认后才执行，不会稀里糊涂覆盖。
- **磁盘友好**：快照走 git delta 压缩，是增量不是整目录拷贝；超过 100MB 的大文件自动跳过。

## 安装

前置：Windows + git CLI（未装 git 时插件静默降级，不显示撤回按钮，不影响 DSH 运行）；PowerShell 5.1 / 7 均可；DSH 0.1.0-rc.x（依赖版本见 `peerDependencies`）。

```powershell
# DSH 官方插件命令：安装并自动挂载进 web profile
dsh plugin --profile web add dsh-recall-plugin@<version>
# 未发布时也可从 git 安装（纯 JS 无构建，免 prepare/allowBuilds）：
# dsh plugin --profile web add github:<user>/dsh-recall-plugin

# 重启 DSH 进程（按你的启动方式，任选其一）
dsh web                      # 前台直接启动
pm2 restart <你的dsh进程名>   # 若用 pm2 托管
```

**验证**：重启后硬刷新页面（Ctrl+Shift+R），悬停任意一条插件启用后发送的用户消息——复制按钮旁出现「↶」即生效。没有按钮？九成是没重启 DSH 进程，或 git CLI 不在 PATH 里。

**卸载**：`dsh plugin --profile web remove dsh-recall-plugin`（同时移除依赖与挂载层），快照数据保留在 `$DSH_HOME/dsh-recall-snapshots/`，想彻底清除手动删掉该目录即可。

## 使用

1. 鼠标悬停任意**插件启用后发送**的用户消息，复制按钮左侧出现「↶ 撤回」。
2. 点击 → 确认面板展示将变更的文件清单（修改 / 恢复 / 删除）。
3. 点「确认回退」→ 文件恢复到该消息发送前的状态；视图切到新会话（该消息及之后的对话移除），原会话归档、随时可找回。

## 工作原理

每条用户消息发送时（agent 动文件之前），工作区被快照进一个独立的影子 git 仓库；撤回时用 `git archive` 恢复文件、通过 DSH 官方 `sessions.fork` 机制把会话切到该消息之前。二进制安全，全程不触碰项目自身的 git 状态。

- 快照存储：`$DSH_HOME/dsh-recall-snapshots/<SHA256(项目绝对路径)>/`，内含影子 git 仓库（`git/`，tag 名为 `snap-<消息ID>`）与索引文件 `index.json`（消息 ID → 快照时间 / 会话）。
- 想直接翻历史快照：

  ```powershell
  git --git-dir="<store>\git\.git" tag -l
  git --git-dir="<store>\git\.git" ls-tree -r --name-only snap-<消息ID>
  ```

## 已知限制

- 快照在**消息发送时**创建，插件启用前的历史消息没有快照，不显示撤回按钮。
- 会话第一条用户消息无法回退对话（仅文件回退），因为 fork 需要更早的 turn 边界。
- 仅支持 Windows（脚本用 PowerShell + git CLI）；Linux/macOS 下插件不报错，但快照不工作、不显示撤回按钮。
- 工作区内嵌套的其他 git 仓库（子目录自带 `.git`）不进快照，其内容不参与回退。

## 本地开发（无需发布）

```powershell
# 把包目录放进 web profile 的 node_modules，并登记到 bundles
$pkg = '<你的仓库克隆路径>\dsh-recall-plugin'
$profile = "$env:USERPROFILE\.dsh\profiles\web"
Copy-Item -Recurse -Force $pkg "$profile\node_modules\dsh-recall-plugin"
# 手动编辑 $profile\package.json：
#   dependencies 加 "dsh-recall-plugin": "1.0.0"
#   dsh.profile.bundles 加 "dsh-recall-plugin"
# 然后重启 DSH 并硬刷新页面
```

## License

MIT
