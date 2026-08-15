/**
 * dsh-recall-plugin — 执行与存储层（ctx 绑定的工厂，无模块级副作用）
 *
 * 职责：提供 runShell（宿主身份执行 + 统一编码保证）、会话根目录解析、
 * git 可执行文件探测、home/降级存储解析与迁移、影子仓库初始化（ensureGit）。
 * 按 process.platform 选择脚本模板（scripts.pwsh.js / scripts.posix.js），
 * 两套模板导出同名接口，本文件用 rt.scripts 统一下发。
 * 产出共享 state（各 Map 缓存）供 snapshots.js / maintenance.js 复用；
 * 由 lib/index.js 在 apply(ctx) 里装配，插件卸载时随 Fiber 一起丢弃。
 */

import os from 'node:os'
import crypto from 'node:crypto'
import * as pwshScripts from './scripts.pwsh.js'
import * as posixScripts from './scripts.posix.js'

// home 不可写时迁移重试的节流间隔：避免每条消息都白试一次注定失败的迁移
const HOME_RETRY_MS = 300000

export function createRuntime(ctx) {
  const shell = ctx.shell
  const sessions = ctx.sessions

  const isWin = process.platform === 'win32'
  const SEP = isWin ? '\\' : '/'
  const scripts = isWin ? pwshScripts : posixScripts

  const state = {
    roots: new Map(),
    stores: new Map(),
    snapshots: new Map(),
    queue: Promise.resolve(),
    indexLoaded: new Set(),
    gitReady: new Set(),
    cutSeqCache: new Map(),
    homeRetryAt: new Map(),
    gcLastAt: new Map(),
    gcCount: new Map(),
    gitExe: null,
    posixHomeBase: null
  }

  // 所有 shell 调用都以宿主身份（danger-full-access）执行，不借用会话沙箱。
  // 为什么安全：DSH 沙箱约束的是「模型驱动」的文件效果，而本插件的命令全部
  // 是宿主侧固定模板（建仓/快照/索引/回退），命令串里唯一变量是插件自己
  // 推导的路径（会话 cwd、哈希出的 store 路径、消息 ID），模型无法注入任何
  // 内容；快照落盘的也只是会话本就有权读取的工作区文件副本，不扩大能力。
  // 为什么必须如此：若按会话解析策略，workspace-write/read-only 会话写不了
  // home，快照被迫降级进项目目录（污染）；read-only 会话连项目都写不了，
  // 回退恢复直接失败。pwsh-sandbox / bash-sandbox 对 danger-full-access
  // 直接不约束（等价本地执行器），无沙箱后端的部署则忽略该字段，两边都成立。
  async function runShell(command, opts) {
    const sp = ctx.get('sandboxPolicy')
    const spec = shell.resolve({
      // 编码前导：pwsh 侧统一 UTF-8 输出（中文机器 GBK 代码页不再乱码）；
      // bash 侧 LC_ALL=C 确定序。各模板自带，这里统一前置注入。
      command: scripts.UTF8_PRELUDE + '\n' + command,
      timeoutMs: (opts && opts.timeoutMs) || 300000,
      stdoutMaxBytes: (opts && opts.stdoutMaxBytes) || 4194304,
      // stdin 是官方 ShellExecRequest 契约字段（bash-local/pwsh 均实现），
      // POSIX 侧用它传 index.json 全文，绕开 argv 长度上限
      ...((opts && opts.stdin !== undefined) ? { stdin: opts.stdin } : {}),
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: (sp && sp.workspaceRoot) || process.cwd() }
    })
    const res = await shell.run(spec)
    const out = (res && res.stdout && res.stdout.text) || ''
    if (res && res.exitCode !== 0) {
      const err = ((res && res.stderr && res.stderr.text) || '').trim() || ('exit ' + String(res.exitCode))
      throw new Error(err.slice(0, 1500))
    }
    return out
  }

  async function resolveRoot(sessionId) {
    const key = sessionId ? String(sessionId) : 'fallback'
    const cached = state.roots.get(key)
    if (cached) return cached
    let root = null
    if (sessionId) {
      const session = sessions.get(sessionId)
      if (session && session.header && session.header.cwd) root = session.header.cwd
    }
    if (!root) {
      const sp = ctx.get('sandboxPolicy')
      if (sp && sp.workspaceRoot) root = sp.workspaceRoot
    }
    if (root) {
      // 尾分隔符归一（win32 保 "D:\" 三字符盘根；POSIX 保 "/" 根）：
      // cwd 是否带尾斜杠由上游决定，不归一会让哈希输入不一致（换 store
      // 目录），也会让排除扫描的 ${f#"$root"/} 前缀剥离错一位。
      root = root.replace(/[\\/]+$/, '') || (isWin ? root : '/')
      if (isWin && root.length === 2) root += '\\'
      state.roots.set(key, root)
    }
    return root
  }

  // 解析 git 可执行文件路径：求值一次并缓存，脚本里用绝对路径调用，
  // 避免每条命令依赖 PATH（DSH 进程 PATH 可能不含 git）。
  async function resolveGit() {
    if (state.gitExe !== null) return state.gitExe
    try {
      const path = scripts.stripBom(await runShell(scripts.resolveGitScript(), { stdoutMaxBytes: 4096 })).trim()
      state.gitExe = path || ''
    } catch (error) {
      state.gitExe = ''
    }
    return state.gitExe
  }

  // win32：哈希在 PowerShell 里算（SHA256 Create 兼容 PS 5.1），连带
  // $env:DSH_HOME / $env:USERPROFILE 的解析都在 shell 侧完成。
  async function homeDirForWin(root) {
    const envHome = (process.env && process.env.DSH_HOME) || ''
    const text = scripts.stripBom(await runShell(scripts.homeDirScript(root, envHome), { stdoutMaxBytes: 4096 })).trim()
    if (!text) return null
    // 折叠 Join-Path 可能带出的连续反斜杠；开头的双反斜杠是 UNC 前缀
    // （DSH_HOME/主目录指到网络盘），折叠掉会把 \\server\share 变成无效
    // 的 \server\share，必须原样保留。
    if (/^\\\\/.test(text)) return '\\\\' + text.slice(2).replace(/\\{2,}/g, '\\')
    return text.replace(/\\{2,}/g, '\\')
  }

  // POSIX：shell 侧只探一次 home 基底（$DSH_HOME 优先、否则 $HOME；
  // 执行器 env 是「洗刷后的父进程 env」，会话级导出的 DSH_HOME 传不进去，
  // Node 主进程仍能看到，作为回退字面量）；哈希用 Node crypto 统一算，
  // 规避 Linux sha256sum / macOS shasum 的二选一移植成本。
  async function homeDirForPosix(root) {
    if (state.posixHomeBase === null) {
      let probed = ''
      try {
        probed = (await runShell(scripts.probeHomeScript(), { stdoutMaxBytes: 4096 })).trim()
      } catch (error) {
        probed = ''
      }
      state.posixHomeBase = probed || process.env.DSH_HOME || os.homedir()
    }
    const hash = crypto.createHash('sha256').update(root, 'utf8').digest('hex')
    return state.posixHomeBase.replace(/\/+$/, '') + '/dsh-recall-snapshots/' + hash
  }

  async function homeDirFor(root) {
    return isWin ? homeDirForWin(root) : homeDirForPosix(root)
  }

  // store 形态装配：exclude.txt 是用户自定义排除文件，home 存储时放在
  // dsh-recall-snapshots 根（所有项目共享一份全局配置）；降级存储时放
  // store 目录内部——降级目录本身已被排除规则覆盖，不再往项目根塞文件。
  // git init <dir> 会把真实 git-dir 建在 <dir>/.git，所以 repo 是仓库
  // 工作目录、git 是真实 git-dir——冒烟测试踩过的坑。
  function makeStore(dir, home) {
    const excludeFile = home
      ? dir.slice(0, dir.lastIndexOf(SEP)) + SEP + 'exclude.txt'
      : dir + SEP + 'exclude.txt'
    return { dir, repo: dir + SEP + 'git', git: dir + SEP + 'git' + SEP + '.git', home, excludeFile }
  }

  // 存储根：优先放 DSH home（保持项目目录干净）。shell 以宿主身份执行，
  // 受限会话（workspace-write/read-only）也能写 home；只有 home 本身不可写
  // （如 DSH_HOME 指向只读/网络盘）才降级到项目内（功能优先于干净）。
  async function resolveStore(root) {
    const cached = state.stores.get(root)
    if (cached) return cached
    let homeDir = null
    try {
      homeDir = await homeDirFor(root)
    } catch (error) {
      homeDir = null
    }
    if (homeDir) {
      try {
        await runShell(scripts.mkdirScript(homeDir), { stdoutMaxBytes: 4096 })
        const store = makeStore(homeDir, true)
        state.stores.set(root, store)
        return store
      } catch (error) {
        console.error('recall home store unavailable, falling back to workspace:', String(error))
      }
    }
    const fallback = root + SEP + '.dsh-recall-snapshots'
    await runShell(scripts.mkdirScript(fallback), { stdoutMaxBytes: 4096 })
    const store = makeStore(fallback, false)
    state.stores.set(root, store)
    return store
  }

  // 旧版迁移：宿主身份执行前的版本在受限会话里会把影子仓库降级到项目内，
  // 这里在下一条消息快照前把它整体迁回 home 并删除项目内目录，恢复
  // 「项目目录干净」。失败节流 5 分钟，避免 home 不可写时每条消息白试。
  async function tryUpgradeToHome(root) {
    const store = state.stores.get(root)
    if (!store || store.home) return store
    const now = Date.now()
    const last = state.homeRetryAt.get(root) || 0
    if (now - last < HOME_RETRY_MS) return store
    state.homeRetryAt.set(root, now)
    let homeDir = null
    try {
      homeDir = await homeDirFor(root)
    } catch (error) {
      homeDir = null
    }
    if (!homeDir) return store
    try {
      await runShell(scripts.mkdirScript(homeDir), { stdoutMaxBytes: 4096 })
      await runShell(scripts.migrateScript(store.dir, homeDir), { timeoutMs: 300000, stdoutMaxBytes: 4096 })
      const upgraded = makeStore(homeDir, true)
      state.stores.set(root, upgraded)
      state.gitReady.delete(store.git)
      // 旧 store 的 gc 节流凭据随之作废，清掉避免新 store 误读
      state.gcLastAt.delete(store.git)
      state.gcCount.delete(store.git)
      console.error('recall store upgraded to home:', root)
      return upgraded
    } catch (error) {
      console.error('recall home upgrade failed:', String(error))
      return store
    }
  }

  // 建立影子仓库（幂等：gitReady 命中后直接跳过，省掉每条消息一次的
  // config/exclude 重写）。同时回读 gc.stamp 种子化 gc 节流：让「上次 gc
  // 时间」跨重启续存，避免天天重启的机器每开机都来一次全量 gc。
  async function ensureGit(root, store) {
    if (state.gitReady.has(store.git)) return true
    const gitExe = await resolveGit()
    if (!gitExe) return false
    try {
      const out = scripts.stripBom(await runShell(scripts.ensureGitScript(store, gitExe), { stdoutMaxBytes: 4096 }))
      state.gitReady.add(store.git)
      const m = out.match(/GIT_OK\s+(\d+)/)
      state.gcLastAt.set(store.git, m ? parseInt(m[1], 10) * 1000 : Date.now())
      return true
    } catch (error) {
      console.error('recall ensureGit failed:', String(error))
      return false
    }
  }

  // 迁移收尾：删除旧版 blobs 格式的项目内 .dsh-recall-snapshots 目录，
  // 仅在 home 存储可用时执行——降级场景下该目录就是新 store，不能删。
  function cleanupLegacy(root) {
    const store = state.stores.get(root)
    if (!store || !store.home) return
    runShell(scripts.legacyRmScript(root + SEP + '.dsh-recall-snapshots'), { timeoutMs: 120000, stdoutMaxBytes: 4096 }).catch(() => {})
  }

  return { state, isWin, scripts, runShell, resolveRoot, resolveGit, homeDirFor, resolveStore, tryUpgradeToHome, ensureGit, cleanupLegacy }
}
