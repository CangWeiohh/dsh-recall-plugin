# dsh-recall-plugin

> 撤回一条消息，项目文件也一起回去。

简体中文 | [English](README.en.md)

![npm](https://img.shields.io/npm/v/dsh-recall-plugin?label=npm&color=cb3837)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue)
![DSH](https://img.shields.io/badge/DSH-0.1.0--rc-blue)
![Build](https://img.shields.io/badge/%E7%BA%AFJS-%E9%9B%B6%E6%9E%84%E5%BB%BA-green)

---
**在任意一条你发过的消息下方**，**点「↶ 撤回」**，**工作区文件和对话历史一起回到那条消息发出之前的状态**。

## 界面预览
- 撤回按钮位置

![悬停出现撤回按钮](docs/screenshots/recall-button.png)

---
| 确认面板 · 变更文件清单| 确认面板 · 变更文件清单|
| --- | --- |
| ![确认面板 · 变更文件清单](docs/screenshots/confirm-panel-1.png) | ![确认面板](docs/screenshots/confirm-panel-2.png) |

- 设置页 · 排除项快速编辑（设置 → 插件 → 撤回设置）

| 设置界面 | 设置界面 |
| --- | --- |
| ![设置页·编辑中](docs/screenshots/settings-exclude-1.png) | ![设置页·已保存](docs/screenshots/settings-exclude-2.png) |

## 功能亮点

- **文件 + 对话，整段回退**：撤回的不只是聊天记录，agent 改过的文件也一并回到原样。
- **不碰你项目自己的 git**：快照存在独立的影子 git 仓库里，你的分支、暂存区、未提交改动统统不受影响；`.git`、`node_modules` 自动排除。
- **项目目录保持干净**：快照始终存在 `$DSH_HOME` 下，不会往项目里塞任何东西；与会话的沙箱权限无关（workspace-write / read-only 会话照常快照与回退），仅当 home 本身不可写（如指到只读盘）才降级到项目内 `.dsh-recall-snapshots`（降级时页面会提示），home 恢复后自动迁走、清理干净。
- **可以反复后悔**：只要会话还在（含归档），快照全量保留、不修剪。撤回一次后还能再撤到更早；撤回时被覆盖的文件也一直找得回来。会话被彻底删除后，其快照随之清理（见下）。
- **先看清单再动手**：点撤回先弹出将变更的文件清单（修改 / 恢复 / 删除），确认后才执行，不会稀里糊涂覆盖。
- **磁盘友好**：快照走 git delta 压缩，是增量不是整目录拷贝；超过 100MB 的大文件自动跳过。
- **自动瘦身**：定期 `git gc` 把 loose 对象压 pack（无损，快照一个不丢）；会话删除后其快照自动清理；构建产物可经 `exclude.txt` 全局排除（见下）。

## 已知限制

- 快照在**消息发送时**创建，插件启用前的历史消息没有快照，不显示撤回按钮。
- 会话第一条用户消息无法回退对话（仅文件回退），因为 fork 需要更早的 turn 边界。
- 支持 Windows（PowerShell 5.1/7 + git CLI）与 Linux/macOS（bash + git CLI）。Windows 真机验证充分；Linux 已在 WSL2（Ubuntu 26.04，bash 5.3 + git 2.53）实测全流程（含中文路径、home 降级、会话清理、gc）；macOS 侧脚本按 bash 3.2 兼容编写，尚未真机实测。
- 工作区内嵌套的其他 git 仓库（子目录自带 `.git`）不进快照，其内容不参与回退。
- 文件名含换行/TAB 的极端情形不在 diff 清单的解析能力内（概率可忽略）。

## 安装

前置：git CLI（未装时撤回按钮不出现，页面顶部会提示安装 git，不影响 DSH 运行）；Windows 上 PowerShell 5.1 / 7 均可，Linux/macOS 需 bash + git；DSH 0.1.0-rc.x（依赖版本见 `peerDependencies`）。


- DSH 官方插件命令：安装并自动挂载进 web profile
```powershell
dsh plugin --profile web add dsh-recall-plugin
```
- 也可从 git 直接安装（纯 JS 无构建，免 prepare/allowBuilds）：
```powershell
dsh plugin --profile web add github:limbo947/dsh-recall-plugin
```
- 重启 DSH 进程（按你的启动方式，任选其一）
```powershell
dsh web                      # 前台直接启动
pm2 restart <你的dsh进程名>   # 若用 pm2 托管
```

**验证**：重启后硬刷新页面（Ctrl+Shift+R），悬停任意一条插件启用后发送的用户消息——复制按钮旁出现「↶」即生效。没有按钮？九成是没重启 DSH 进程，或 git CLI 不在 PATH 里。

**卸载**：`dsh plugin --profile web remove dsh-recall-plugin`（同时移除依赖与挂载层），快照数据保留在 home 下 `dsh-recall-snapshots/`，想彻底清除手动删掉该目录即可。

## 使用

1. 鼠标悬停任意**插件启用后发送**的用户消息，复制按钮左侧出现「↶ 撤回」。
2. 点击 → 确认面板展示将变更的文件清单（修改 / 恢复 / 删除）。
3. 点「确认回退」→ 文件恢复到该消息发送前的状态；视图切到新会话（该消息及之后的对话移除），原会话归档、随时可找回。

## 快照维护与清理

快照全量保留的前提是「会话还有找回的可能」，在此之上插件自动控制磁盘占用，无需手动管理：

- **定期 gc**：每 50 条快照或距上次 gc 24 小时（先到先触发），后台执行 `git gc` 把 loose 对象压成 pack。无损操作——所有快照照常可回退。节流凭据写在影子仓库内的 `gc.stamp`，重启 DSH 不会重置周期。两个阈值可用环境变量覆盖（一般用不着）：`DSH_RECALL_GC_SNAPS`、`DSH_RECALL_GC_HOURS`。
- **会话删除联动清理**：会话被彻底删除（会话日志从磁盘消失）后，下一次维护会自动删除该会话的全部快照并释放空间。**归档不算删除**——撤回功能自己归档的原会话日志仍在，快照保留、随时可从归档找回。判断很保守：会话只是冷着（不内存里）不会误清；无法核实日志状态时宁可不清。
- **用户自定义排除**：打开「**设置 → 插件 → 撤回设置**」即可可视化编辑快照排除项——输入路径或模式回车即加、常用模式（`dist/`、`*.log`、`.env` 等）一键追加、保存后下一次快照/回退立即生效，无需重启。也可以直接编辑 home 下 `dsh-recall-snapshots/exclude.txt`（即 `$DSH_HOME/dsh-recall-snapshots/exclude.txt`，未设置时为 `~/.dsh/dsh-recall-snapshots/exclude.txt`；UTF-8），一行一条 gitignore 风格 pattern（`#` 开头为注释），两种方式编辑的是同一份配置，例如：

  ```gitignore
  # 构建产物不进快照
  dist/
  build/
  *.log
  ```

  对所有项目生效（home 不可写而降级到项目内存储时，该工作区有独立的排除配置，设置页会分卡片列出）。新增排除只影响之后的快照；**回退到更早的快照时，当时尚未排除的文件仍会被恢复**（回到当时的状态，这正是回退语义）。想彻底清掉已进快照的目录，可手动删除 home 下 `dsh-recall-snapshots/` 里对应项目的哈希目录。设置页标签依赖 DSH 自带设置页（0.1.0-rc.x 均含）；极旧版本看不到该标签时，直接编辑文件等效。

## 工作原理

每条用户消息发送时（agent 动文件之前），工作区被快照进一个独立的影子 git 仓库；撤回时用 `git archive` 恢复文件、通过 DSH 官方 `sessions.fork` 机制把会话切到该消息之前。二进制安全，全程不触碰项目自身的 git 状态。

- 快照存储：home 下 `dsh-recall-snapshots/<SHA256(项目绝对路径)>/`，内含影子 git 仓库（`git/`，tag 名为 `snap-<消息ID>`）与索引文件 `index.json`（消息 ID → 快照时间 / 会话）。Windows 上脚本走 PowerShell，Linux/macOS 走 bash（按 `ctx.shell` 平台层挂载的执行器自动分叉）。
- 想直接翻历史快照：

  ```powershell
  git --git-dir="<store>\git\.git" tag -l
  git --git-dir="<store>\git\.git" ls-tree -r --name-only snap-<消息ID>
  ```



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
