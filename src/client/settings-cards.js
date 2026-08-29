/**
 * dsh-recall-plugin — client 设置卡片（排除配置 / 快照管理 / 插件配置）
 *
 * 从原 lib/client.js 抽出设置页「插件配置」卡片的全部内容：排除文件编辑、
 * 快照树形管理、插件配置表单、分区折叠头与撤回卡片外壳。纯组件组装，
 * 依赖注入 React 与 util（api/clockText/sizeText/bytesToMb/buildTree）。
 */

// F1：按 fork lineage 计算会话的版本家族。lineage 是 [{childId, parentId}]，
// 返回 Map<sessionId, {family: string[], index: number}>——family 是按 fork
// 顺序（parent→child）排列的家族链，index 从 1 起（v1/v2/v3）。仅 ≥2 成员的
// 家族有映射；单会话无版本概念。纯函数、渲染期零副作用，供单测钉边界。
export function groupByLineage(ids, lineage) {
  const childOf = new Map()    // childId -> parentId（回溯根用）
  const childrenOf = new Map() // parentId -> [childIds]（向下收集链用）
  for (const e of lineage || []) {
    if (e && e.childId && e.parentId) {
      const child = String(e.childId)
      const parent = String(e.parentId)
      childOf.set(child, parent)
      const kids = childrenOf.get(parent) || []
      kids.push(child)
      childrenOf.set(parent, kids)
    }
  }
  const idSet = new Set((ids || []).map(String))
  const result = new Map()
  const assigned = new Set()
  for (const id of idSet) {
    if (assigned.has(id)) continue
    // 回溯到链根（父不在集合里的节点）
    let root = id
    const seen = new Set()
    while (childOf.has(root) && idSet.has(childOf.get(root)) && !seen.has(root)) {
      seen.add(root)
      root = childOf.get(root)
    }
    // 从根向下按 childrenOf BFS 收集整条家族链（线性链退化为顺序遍历）
    const chain = []
    const queue = [root]
    while (queue.length) {
      const cur = queue.shift()
      if (!cur || !idSet.has(cur) || assigned.has(cur)) continue
      chain.push(cur)
      assigned.add(cur)
      for (const k of childrenOf.get(cur) || []) queue.push(k)
    }
    if (chain.length > 1) {
      chain.forEach((sid, i) => result.set(sid, { family: chain, index: i + 1 }))
    }
  }
  return result
}

export function buildSettingsCards(React, util, sessionsSvc) {
  const { api, clockText, sizeText, bytesToMb, buildTree } = util

  // 常用排除建议：一键追加的高频项，覆盖构建产物/日志/密钥三类最常见诉求；
  // 已存在的条目自动从候选里滤掉，避免重复点击堆叠。
  const EXCLUDE_SUGGESTIONS = ['dist/', 'build/', 'out/', 'coverage/', '*.log', '.env']

  // 单个 exclude 文件的编辑卡片。draft/baseline 分离实现「未保存修改」判定
  // （textarea 所见即将保存的原文，不偷偷规范化）；key=file.path 挂载，
  // 父级重载列表时整卡重建、草稿随之丢弃。
  function ExcludeCard(props) {
    const file = props.file
    const [draft, setDraft] = React.useState(file.content || '')
    const [baseline, setBaseline] = React.useState(file.content || '')
    const [quick, setQuick] = React.useState('')
    const [state, setState] = React.useState({ busy: false, message: '', error: false })
    const dirty = draft !== baseline

    // 追加一条模式：先补齐行尾换行再拼接，保证每条模式独占一行
    // （exclude.txt 按行解析，两条挤一行会双双失效）
    function appendPattern(pattern) {
      setDraft((d) => (d && !d.endsWith('\n') ? d + '\n' : d) + pattern + '\n')
    }

    function addQuick() {
      const t = quick.trim()
      if (!t) return
      appendPattern(t)
      setQuick('')
    }

    function save() {
      if (state.busy || !dirty) return
      setState({ busy: true, message: '保存中…', error: false })
      api('exclude-set', { path: file.path, content: draft }).then((res) => {
        if (res && res.ok) {
          setBaseline(draft)
          setState({ busy: false, message: '已保存，下一次快照 / 预览 / 回退时生效', error: false })
        } else {
          setState({ busy: false, message: (res && (res.message || res.error)) || '保存失败', error: true })
        }
      }).catch((error) => {
        setState({ busy: false, message: String(error), error: true })
      })
    }

    function discard() {
      if (state.busy) return
      setDraft(baseline)
      setState({ busy: false, message: '', error: false })
    }

    const draftLines = draft.split('\n').map((l) => l.trim())
    const suggestions = EXCLUDE_SUGGESTIONS.filter((s) => draftLines.indexOf(s) < 0)

    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      React.createElement('div', { className: 'dsh-recall-ex-title' }, '快照排除项'),
      React.createElement('div', { className: 'dsh-recall-ex-note' },
        file.home
          ? '此配置全局共享，对所有工作区的快照生效（存储位置：' + file.path + '）。'
          : 'home 目录不可写时此工作区降级存储，排除配置独立生效（存储位置：' + file.path + '）。'
      ),
      React.createElement('div', { className: 'dsh-recall-ex-note' }, 'gitignore 语法，一行一条，支持 # 注释；命中排除的文件与目录不进入快照，也不会被回退触碰。'),
      React.createElement('textarea', {
        className: 'dsh-recall-ex-area',
        value: draft,
        spellCheck: false,
        onChange: (e) => setDraft(e.target.value)
      }),
      React.createElement('div', { className: 'dsh-recall-ex-quick' },
        React.createElement('input', {
          className: 'dsh-recall-ex-input',
          value: quick,
          placeholder: '输入路径或模式，回车快速添加',
          onChange: (e) => setQuick(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addQuick() } }
        }),
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: addQuick }, '添加'),
        ...suggestions.map((s) => React.createElement('button', {
          key: 'chip-' + s,
          type: 'button',
          className: 'dsh-recall-ex-chip',
          title: '点击追加 ' + s,
          onClick: () => appendPattern(s)
        }, s))
      ),
      React.createElement('div', { className: 'dsh-recall-panel-actions' },
        state.message ? React.createElement('span', { className: 'dsh-recall-ex-status' + (state.error ? ' dsh-recall-ex-status-error' : ' dsh-recall-ex-status-success') }, state.message) : null,
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: !dirty || state.busy, onClick: discard }, '放弃修改'),
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn dsh-recall-btn-danger', disabled: !dirty || state.busy, onClick: save }, '保存')
      )
    )
  }

  // 快照管理卡片：列表（时间倒序）/ 磁盘占用 / 单条删除 / 手动 gc / 最近错误。
  // 全部操作走 Host 的 manage/status 端点（串行队列在 Host 侧保证）。
  function ManageCard(props) {
    const [items, setItems] = React.useState(null)
    const [usage, setUsage] = React.useState(null)
    const [errors, setErrors] = React.useState(null)
    const [state, setState] = React.useState({ busy: false, message: '', error: false })
    // 快照全量计数与当前拉取上限：Host 按 limit 切片返回，total 是全量
    const [limit, setLimit] = React.useState(200)
    const [total, setTotal] = React.useState(0)
    const [health, setHealth] = React.useState(null)
    const [query, setQuery] = React.useState('')
    const [showAllErrors, setShowAllErrors] = React.useState(false)
    const [titlesPending, setTitlesPending] = React.useState(false)
    // F1：fork lineage（childId ↔ parentId 撤回链），来自 manage op='lineage'
    const [lineage, setLineage] = React.useState([])

    function fetchTitles(list) {
      const missing = Array.from(new Set(
        (list || []).filter((it) => it.sessionId && !it.sessionTitle).map((it) => it.sessionId)
      )).slice(0, 100)
      if (!missing.length) { setTitlesPending(false); return }
      setTitlesPending(true)
      api('manage', { op: 'titles', sessionIds: missing }).then((res) => {
        const map = res && res.ok ? res.titles : null
        if (map) {
          setItems((prev) => (prev || []).map((it) => (
            it.sessionId && map[it.sessionId] ? Object.assign({}, it, { sessionTitle: map[it.sessionId] }) : it
          )))
        }
        setTitlesPending(false)
      }).catch(() => setTitlesPending(false))
    }

    // 消息文本补齐：只请求 live 拿不到文本的快照；同一会话多条消息在 Host 端
    // 共享一次 readSession，避免为每条消息重复解压大日志。
    function fetchMessages(list) {
      const requests = (list || [])
        .filter((it) => it.sessionId && it.id && !Object.prototype.hasOwnProperty.call(it, 'messageText'))
        .map((it) => ({ sessionId: it.sessionId, messageId: it.id }))
        .slice(0, 200)
      if (!requests.length) return
      api('manage', { op: 'messages', requests }).then((res) => {
        const map = res && res.ok ? res.messageTexts : null
        if (map) {
          setItems((prev) => (prev || []).map((it) => (
            it.id && Object.prototype.hasOwnProperty.call(map, it.id) ? Object.assign({}, it, { messageText: map[it.id] }) : it
          )))
        }
      }).catch(() => {})
    }

    function refresh(overLimit) {
      const useLimit = overLimit || limit
      api('manage', { op: 'list', limit: useLimit }).then((res) => {
        if (res && res.ok) {
          setItems(res.items || [])
          setTotal(typeof res.total === 'number' ? res.total : (res.items || []).length)
          fetchTitles(res.items || [])
          fetchMessages(res.items || [])
          // PF-6：stale 表示响应来自旧缓存、有新快照未入列表——静默再拉
          // 一次让新快照渐进补上。再拉仍 stale 时止步不更新（不循环，防
          // 抖动），等用户下次手动刷新。
          if (res.stale) {
            api('manage', { op: 'list', limit: useLimit }).then((res2) => {
              if (res2 && res2.ok && !res2.stale) {
                setItems(res2.items || [])
                setTotal(typeof res2.total === 'number' ? res2.total : (res2.items || []).length)
                fetchTitles(res2.items || [])
                fetchMessages(res2.items || [])
              }
            }).catch(() => {})
          }
        }
        // F1：加载 fork lineage（版本家族），列表成功后异步补齐，不阻塞首屏
        api('manage', { op: 'lineage' }).then((res) => {
          if (res && res.ok && Array.isArray(res.lineage)) setLineage(res.lineage)
        }).catch(() => {})
        // 列表返回后再补 usage/status：首次冷启动时磁盘占用和错误日志都各要
        // 一条 shell，和 list 并发会抢资源拖慢首屏；延后到列表渲染后。
        api('manage', { op: 'usage' }).then((res) => {
          if (res && res.ok) {
            setUsage(res.bytes || 0)
            setHealth({ gitAvailable: res.gitAvailable !== false, homeStores: res.homeStores || 0, fallbackStores: res.fallbackStores || 0 })
          }
        }).catch(() => {})
        api('status', {}).then((res) => {
          if (res && res.ok) setErrors(res.errors || [])
        }).catch(() => {})
      }).catch(() => {
        // list 失败时仍尝试补 usage/status，避免整卡全空
        api('manage', { op: 'usage' }).then((res) => {
          if (res && res.ok) {
            setUsage(res.bytes || 0)
            setHealth({ gitAvailable: res.gitAvailable !== false, homeStores: res.homeStores || 0, fallbackStores: res.fallbackStores || 0 })
          }
        }).catch(() => {})
        api('status', {}).then((res) => {
          if (res && res.ok) setErrors(res.errors || [])
        }).catch(() => {})
      })
    }

    React.useEffect(() => { refresh() }, [])

    function clearErrors() {
      setErrors([])
      api('status', { op: 'clear' }).catch(() => {})
    }

    function run(op, extra, doneText) {
      if (state.busy) return
      setState({ busy: true, message: '执行中…', error: false })
      api('manage', Object.assign({ op }, extra || {})).then((res) => {
        if (res && res.ok) {
          setState({ busy: false, message: typeof res.deleted === 'number' ? '已删除 ' + res.deleted + ' 条快照' : doneText, error: false })
          refresh()
        } else {
          setState({ busy: false, message: (res && (res.message || res.error)) || '操作失败', error: true })
        }
      }).catch((e) => setState({ busy: false, message: String(e), error: true }))
    }

    const [expanded, setExpanded] = React.useState(() => new Set())
    const [confirming, setConfirming] = React.useState(null)

    function renderDeleteAllConfirm() {
      if (!confirming || confirming.kind !== 'all') return null
      return React.createElement('div', { className: 'dsh-recall-tree-confirm' },
          '确认删除所有工作区的全部快照？此操作不可恢复。',
          React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-btn dsh-recall-btn-danger',
            onClick: () => {
              setConfirming(null)
              run('deleteAll', {}, '已清空全部快照')
            }
          }, '确认全部删除'),
          React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: () => setConfirming(null) }, '取消')
        )
    }

    function toggle(key) {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }

    const q = query.trim().toLowerCase()
    const filteredItems = q
      ? (items || []).filter((it) =>
          (it.workspace || '').toLowerCase().indexOf(q) >= 0 ||
          (it.sessionTitle || '').toLowerCase().indexOf(q) >= 0 ||
          (it.messageText || '').toLowerCase().indexOf(q) >= 0 ||
          String(it.id || '').toLowerCase().indexOf(q) >= 0
        )
      : items
    const tree = buildTree(filteredItems)
    // F1：版本家族映射 + 可切换会话（仍在 sessions.list 里的）。versionMap
    // 用全部快照会话 id 与 lineage 推导；sessions.list 快照同步读取。已归档
    // 会话不在 list（无法 open），故不渲染切换按钮，只显示版本号。
    const allSessionIds = Array.from(new Set((items || []).map((it) => it.sessionId).filter(Boolean)))
    const versionMap = groupByLineage(allSessionIds, lineage)
    let listById = null
    try {
      if (sessionsSvc && sessionsSvc.list && typeof sessionsSvc.list.getSnapshot === 'function') {
        listById = sessionsSvc.list.getSnapshot().byId || null
      }
    } catch (e) { listById = null }

    function confirmDelete(kind, key, extra, text) {
      setConfirming({ kind, key, extra, text })
    }
    function renderConfirm(kind, key, extra, text) {
      if (!confirming || confirming.kind !== kind || confirming.key !== key) return null
      return React.createElement('div', { className: 'dsh-recall-tree-confirm' },
        text,
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-ex-chip',
          onClick: () => {
            const c = confirming
            setConfirming(null)
            run('delete', c.extra, '已删除')
          }
        }, '确认'),
        React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: () => setConfirming(null) }, '取消')
      )
    }
    // 叶子节点：展开箭头占位 + 时间 + 消息内容摘要 + 截断 ID。
    function renderLeaf(it) {
      const key = 'snap-' + it.id
      const text = it.messageText
      const title = text || it.id
      const label = text
        ? clockText(it.time) + '  ' + text
        : clockText(it.time) + '  ' + it.id.slice(0, 12) + '…'
      return React.createElement('div', { className: 'dsh-recall-tree-node', key: key },
        React.createElement('div', { className: 'dsh-recall-tree-row', title: title },
          React.createElement('span', { className: 'dsh-recall-tree-toggle-placeholder' }),
          React.createElement('span', { className: 'dsh-recall-tree-label' },
            React.createElement('span', { className: 'dsh-recall-tree-title' }, label)
          ),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-ex-chip',
            title: '删除该快照（tag 与索引条目）',
            onClick: () => confirmDelete('snapshot', key, { messageId: it.id, root: it.root || null }, '确认删除该快照？此操作不可恢复。')
          }, '删除')
        ),
        renderConfirm('snapshot', key, { messageId: it.id, root: it.root || null }, '确认删除该快照？此操作不可恢复。')
      )
    }
    // 会话节点：折叠按钮 + 标题 + 快照数 + 删除按钮；子节点为叶子。
    function renderSession(s) {
      const key = 'session-' + (s.root || '') + '-' + s.sessionId
      const open = expanded.has(key)
      const label = s.title || (titlesPending && s.sessionId ? '…' : '（已删除会话）')
      const version = s.sessionId ? versionMap.get(String(s.sessionId)) : null
      const switchable = Boolean(s.sessionId && listById && listById[s.sessionId])
      return React.createElement('div', { className: 'dsh-recall-tree-node', key: key },
        React.createElement('div', { className: 'dsh-recall-tree-row' },
          React.createElement('span', {
            className: 'dsh-recall-tree-toggle',
            onClick: () => toggle(key)
          }, open ? '▾' : '▸'),
          React.createElement('span', { className: 'dsh-recall-tree-label', title: s.sessionId || '' },
            React.createElement('span', { className: 'dsh-recall-tree-title' }, label),
            version ? React.createElement('span', { className: 'dsh-recall-tree-meta', title: '版本家族：' + version.family.join(' → ') }, 'v' + version.index + '/' + version.family.length) : null,
            React.createElement('span', { className: 'dsh-recall-tree-meta' }, s.items.length + ' 条')
          ),
          switchable ? React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-ex-chip',
            title: '切换到该版本会话',
            onClick: () => { try { sessionsSvc.open(s.sessionId) } catch (e) { /* 会话已不可切换则静默 */ } }
          }, '切换') : null,
          s.sessionId ? React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-ex-chip',
            title: '删除该会话全部快照',
            onClick: () => confirmDelete('session', key, { scope: 'session', sessionId: s.sessionId, root: s.root || null }, '确认删除该会话全部快照？此操作不可恢复。')
          }, '删除') : null
        ),
        open ? React.createElement('div', { className: 'dsh-recall-tree-children' }, ...s.items.map(renderLeaf)) : null,
        s.sessionId ? renderConfirm('session', key, { scope: 'session', sessionId: s.sessionId, root: s.root || null }, '确认删除该会话全部快照？此操作不可恢复。') : null
      )
    }
    // 工作区节点：折叠按钮 + 文件夹名 + 会话数/快照数 + 删除按钮。
    function renderWorkspace(ws) {
      const key = 'ws-' + ws.root
      const open = expanded.has(key)
      const sessionCount = ws.sessions.length
      const snapCount = ws.sessions.reduce((n, s) => n + s.items.length, 0)
      return React.createElement('div', { className: 'dsh-recall-tree-node', key: key },
        React.createElement('div', { className: 'dsh-recall-tree-row' },
          React.createElement('span', {
            className: 'dsh-recall-tree-toggle',
            onClick: () => toggle(key)
          }, open ? '▾' : '▸'),
          React.createElement('span', { className: 'dsh-recall-tree-label', title: ws.root || '' },
            React.createElement('span', { className: 'dsh-recall-tree-name' }, ws.name),
            React.createElement('span', { className: 'dsh-recall-tree-meta' }, sessionCount + ' 会话 / ' + snapCount + ' 快照')
          ),
          ws.root ? React.createElement('button', {
            type: 'button',
            className: 'dsh-recall-ex-chip',
            title: '删除该工作区全部快照',
            onClick: () => confirmDelete('workspace', key, { scope: 'workspace', root: ws.root }, '确认删除该工作区全部快照？此操作不可恢复。')
          }, '删除') : null
        ),
        open ? React.createElement('div', { className: 'dsh-recall-tree-children' }, ...ws.sessions.map(renderSession)) : null,
        ws.root ? renderConfirm('workspace', key, { scope: 'workspace', root: ws.root }, '确认删除该工作区全部快照？此操作不可恢复。') : null
      )
    }
    const treeNodes = tree.map(renderWorkspace)

    // 计数用 Host 返回的全量 total 而非已加载条数
    const loaded = items ? items.length : null
    const countText = loaded === null
      ? '共 … 条快照'
      : '共 ' + total + ' 条快照' + (limit < total ? '（当前显示最新 ' + loaded + ' 条）' : '')

    function loadMore() {
      const next = Math.min(Math.max(total, limit), 2000)
      if (next <= limit) return
      setLimit(next)
      refresh(next)
    }

    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      React.createElement('div', { className: 'dsh-recall-ex-title' }, '快照管理'),
      React.createElement('div', { className: 'dsh-recall-ex-note' },
        usage === null
          ? countText + '。'
          : countText + '，全部工作区快照存储占用 ' + sizeText(usage) + '。'
      ),
      health ? React.createElement('div', { className: 'dsh-recall-ex-note', key: 'health' },
        React.createElement('span', {
          className: health.gitAvailable ? '' : 'dsh-recall-ex-status-error'
        }, health.gitAvailable ? 'git 可用' : 'git 不可用（快照引擎依赖 git）'),
        ' · 快照存储：home ' + health.homeStores + ' 个工作区' + (health.fallbackStores ? '，降级 ' + health.fallbackStores + ' 个' : '')
      ) : null,
      React.createElement('input', {
        className: 'dsh-recall-ex-input',
        placeholder: '搜索工作区 / 会话标题 / 消息内容 / ID',
        value: query,
        spellCheck: false,
        onChange: (e) => setQuery(e.target.value),
      }),
      treeNodes.length > 0 ? React.createElement('div', { className: 'dsh-recall-tree' }, ...treeNodes) : null,
      items && items.length === 0 && !q
        ? React.createElement('div', { className: 'dsh-recall-ex-note', key: 'empty' }, '在任意工作区发送一条消息后，这里会出现快照。')
        : null,
      q && filteredItems && filteredItems.length === 0
        ? React.createElement('div', { className: 'dsh-recall-ex-note', key: 'no-match' }, '无匹配快照')
        : null,
      renderDeleteAllConfirm(),
      React.createElement('div', { className: 'dsh-recall-panel-actions' },
        state.message ? React.createElement('span', { className: 'dsh-recall-ex-status' + (state.error ? ' dsh-recall-ex-status-error' : ' dsh-recall-ex-status-success') }, state.message) : null,
        limit < total ? React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn',
          disabled: state.busy,
          onClick: loadMore
        }, '加载更多') : null,
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: state.busy, onClick: refresh }, '刷新'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn dsh-recall-btn-danger',
          disabled: state.busy,
          title: '删除全部工作区的所有快照；会直接核对并删除 git tag（即使列表为空也可清理残留）',
          onClick: () => setConfirming({ kind: 'all' })
        }, '全部删除'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn',
          disabled: state.busy,
          title: '立即对全部工作区执行一次 git gc（压缩对象库释放空间）',
          onClick: () => run('gc', {}, 'gc 完成')
        }, '立即 gc')
      ),
      errors && errors.length > 0
        ? React.createElement('div', { className: 'dsh-recall-ex-note', key: 'errors' },
            React.createElement('div', { className: 'dsh-recall-ex-status' },
              '最近错误：',
              (showAllErrors ? errors : errors.slice(0, 5)).map((e, i) => React.createElement('div', { key: i, className: 'dsh-recall-ex-note' }, clockText(e.time) + '  ' + e.message))
            ),
            React.createElement('div', { className: 'dsh-recall-panel-actions' },
              errors.length > 5 ? React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: () => setShowAllErrors((v) => !v) }, showAllErrors ? '收起' : '展开全部 (' + errors.length + ')') : null,
              React.createElement('button', { type: 'button', className: 'dsh-recall-ex-chip', onClick: clearErrors }, '清空')
            )
          )
        : null
    )
  }

  // 排除配置分区：拉取 Host 枚举的 exclude 文件列表（home 存储通常合并为一条，
  // 降级工作区各一条）。折叠展开时由设置外壳保持挂载，本地草稿不丢失。
  function ExcludeFilesSection() {
    const [files, setFiles] = React.useState(null)
    const [error, setError] = React.useState('')

    function load() {
      api('exclude-get', {}).then((res) => {
        if (res && res.ok) { setFiles(res.files || []); setError(''); return }
        if (res && res.unsupported) { setError('当前平台不支持快照功能，排除配置不可用。'); return }
        setError((res && (res.message || res.error)) || '无法读取排除配置')
      }).catch((e) => setError(String(e)))
    }

    React.useEffect(() => { load() }, [])

    if (error) {
      return React.createElement('div', { className: 'dsh-recall-ex-card' },
        React.createElement('div', { className: 'dsh-recall-ex-note' }, error),
        React.createElement('div', { className: 'dsh-recall-panel-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: load }, '重试')
        )
      )
    }
    if (files === null) {
      return React.createElement('div', { className: 'dsh-recall-ex-note' }, '正在加载排除配置…')
    }
    if (!files.length) {
      return React.createElement('div', { className: 'dsh-recall-ex-note' }, '尚未创建任何快照存储：在任意工作区发送一条消息后，这里会出现可编辑的排除配置。')
    }
    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      ...files.map((f) => React.createElement(ExcludeCard, { key: f.path, file: f }))
    )
  }

  // 插件配置表单：值经 Host 的 settings namespace「dsh-recall」读写，保存即
  // 持久化并热生效。只提交相对基线修改过的字段，避免一次保存把全部字段
  // 标成「用户覆盖」。
  function ConfigForm() {
    const [baseline, setBaseline] = React.useState(null)
    const [draft, setDraft] = React.useState(null)
    const [envLocks, setEnvLocks] = React.useState({})
    const [overridden, setOverridden] = React.useState({})
    const [writable, setWritable] = React.useState(true)
    const [state, setState] = React.useState({ busy: false, message: '', error: false })
    const [showAdvanced, setShowAdvanced] = React.useState(false)

    function load() {
      api('config-get', {}).then((res) => {
        if (res && res.ok) {
          const v = res.values || {}
          const next = {
            gcSnaps: String(v.gcSnaps == null ? '' : v.gcSnaps),
            gcHours: String(v.gcHours == null ? '' : v.gcHours),
            maxFileBytes: bytesToMb(v.maxFileBytes),
            maxSnapshotsPerWorkspace: String(v.maxSnapshotsPerWorkspace == null ? '' : v.maxSnapshotsPerWorkspace),
            baseExcludes: Array.isArray(v.baseExcludes) ? v.baseExcludes.join('\n') : '',
            refillDraft: v.refillDraft !== false,
            snapshotEnabled: v.snapshotEnabled !== false,
            archiveOriginal: v.archiveOriginal !== false,
            retentionDays: String(v.retentionDays == null ? '' : v.retentionDays),
          }
          setDraft(next)
          setBaseline(next)
          setEnvLocks(res.envLocks || {})
          setOverridden(res.overridden || {})
          setWritable(res.writable !== false)
        } else {
          setState({ busy: false, message: (res && (res.message || res.error)) || '无法读取配置', error: true })
        }
      }).catch((e) => setState({ busy: false, message: String(e), error: true }))
    }

    React.useEffect(() => { load() }, [])

    function edit(key, value) {
      setDraft((d) => Object.assign({}, d, { [key]: value }))
    }

    function save() {
      if (state.busy || !draft || !baseline) return
      const patch = {}
      for (const key of ['gcSnaps', 'gcHours', 'maxFileBytes', 'maxSnapshotsPerWorkspace', 'baseExcludes', 'refillDraft', 'snapshotEnabled', 'archiveOriginal', 'retentionDays']) {
        if (draft[key] !== baseline[key]) patch[key] = draft[key]
      }
      if (!Object.keys(patch).length) {
        setState({ busy: false, message: '没有修改', error: false })
        return
      }
      const clean = {}
      if (patch.gcSnaps !== undefined) {
        const n = parseInt(patch.gcSnaps, 10)
        if (!Number.isFinite(n) || n < 1) { setState({ busy: false, message: '快照条数阈值必须是 >= 1 的整数', error: true }); return }
        clean.gcSnaps = n
      }
      if (patch.gcHours !== undefined) {
        const n = parseInt(patch.gcHours, 10)
        if (!Number.isFinite(n) || n < 1) { setState({ busy: false, message: 'gc 小时阈值必须是 >= 1 的整数', error: true }); return }
        clean.gcHours = n
      }
      if (patch.maxFileBytes !== undefined) {
        // display 层是 MB 小数，持久化仍是字节：model 侧不变，往返零改动
        const mb = Number(patch.maxFileBytes)
        if (!Number.isFinite(mb) || mb < 0.01) { setState({ busy: false, message: '文件大小上限至少 0.01 MB', error: true }); return }
        clean.maxFileBytes = Math.round(mb * 1048576)
      }
      if (patch.maxSnapshotsPerWorkspace !== undefined) {
        const n = parseInt(patch.maxSnapshotsPerWorkspace, 10)
        if (!Number.isFinite(n) || n < 0) { setState({ busy: false, message: '快照总量上限必须是 >= 0 的整数（0 表示不限制）', error: true }); return }
        clean.maxSnapshotsPerWorkspace = n
      }
      if (patch.refillDraft !== undefined) clean.refillDraft = Boolean(patch.refillDraft)
      if (patch.snapshotEnabled !== undefined) clean.snapshotEnabled = Boolean(patch.snapshotEnabled)
      if (patch.archiveOriginal !== undefined) clean.archiveOriginal = Boolean(patch.archiveOriginal)
      if (patch.retentionDays !== undefined) {
        const n = parseInt(patch.retentionDays, 10)
        if (!Number.isFinite(n) || n < 0) { setState({ busy: false, message: '保留天数必须是 >= 0 的整数（0 表示不启用）', error: true }); return }
        clean.retentionDays = n
      }
      if (patch.baseExcludes !== undefined) {
        clean.baseExcludes = String(patch.baseExcludes).split('\n').map((l) => l.trim()).filter(Boolean)
      }
      setState({ busy: true, message: '保存中…', error: false })
      api('config-set', { patch: clean }).then((res) => {
        if (res && res.ok) {
          setState({ busy: false, message: '已保存并即时生效', error: false })
          load()
        } else {
          setState({ busy: false, message: (res && (res.message || res.error)) || '保存失败', error: true })
        }
      }).catch((e) => setState({ busy: false, message: String(e), error: true }))
    }

    function numRow(key, label, hint, opts) {
      const locked = Boolean(envLocks && envLocks[key])
      const changed = Boolean(draft && baseline && draft[key] !== baseline[key])
      return React.createElement('div', { className: 'dsh-recall-cfg-row', key: key },
        React.createElement('div', { className: 'dsh-recall-cfg-line' },
          React.createElement('label', { className: 'dsh-recall-cfg-label' }, label),
          React.createElement('input', {
            className: 'dsh-recall-cfg-input',
            type: 'number',
            value: draft ? draft[key] : '',
            disabled: locked || !writable,
            min: opts && opts.min,
            step: opts && opts.step,
            onChange: (e) => edit(key, e.target.value),
          }),
          opts && opts.suffix ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, opts.suffix) : null,
          changed && !locked ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已修改') : null,
          overridden && overridden[key] !== undefined ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已覆盖') : null,
          locked ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '环境变量锁定') : null
        ),
        React.createElement('div', { className: 'dsh-recall-cfg-hint' }, hint)
      )
    }

    function resetDefaults() {
      if (state.busy || !writable) return
      setState({ busy: true, message: '恢复默认中…', error: false })
      api('config-reset', {}).then((res) => {
        if (res && res.ok) {
          load()
          setState({ busy: false, message: '已恢复默认值', error: false })
        } else {
          setState({ busy: false, message: (res && (res.message || res.error)) || '恢复默认失败', error: true })
        }
      }).catch((e) => setState({ busy: false, message: String(e), error: true }))
    }

    if (!draft) {
      return React.createElement('div', { className: 'dsh-recall-ex-note' }, state.message || '正在读取配置…')
    }

    return React.createElement('div', { className: 'dsh-recall-ex-card' },
      React.createElement('div', { className: 'dsh-recall-cfg-row', key: 'snapshotEnabled' },
        React.createElement('div', { className: 'dsh-recall-cfg-line' },
          React.createElement('label', { className: 'dsh-recall-cfg-label', htmlFor: 'dsh-recall-cfg-snapshot' }, '启用快照'),
          React.createElement('input', {
            id: 'dsh-recall-cfg-snapshot',
            type: 'checkbox',
            checked: Boolean(draft.snapshotEnabled),
            disabled: !writable,
            onChange: (e) => edit('snapshotEnabled', e.target.checked),
          }),
          draft.snapshotEnabled !== baseline.snapshotEnabled ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已修改') : null,
          overridden && overridden.snapshotEnabled !== undefined ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已覆盖') : null
        ),
        React.createElement('div', { className: 'dsh-recall-cfg-hint' }, '关闭后不再新建快照（已有快照仍可撤回），适合临时禁用快照的场合')
      ),
      numRow('gcSnaps', 'gc 触发条数', '每积累多少条快照触发一次 git gc', { min: 1, step: 1 }),
      numRow('gcHours', 'gc 触发小时', '距上次 gc 超过多少小时触发（与条数先到先触发）', { min: 1, step: 1 }),
      numRow('maxFileBytes', '文件大小上限', '超过该大小的文件不进快照、不被回退触碰（单位 MB，支持小数）', { suffix: 'MB', min: 0.01, step: 0.5 }),
      numRow('maxSnapshotsPerWorkspace', '快照总量上限', '每个工作区保留的最大快照数，超限自动删除最旧的；填 0 表示不限制', { min: 0, step: 1 }),
      numRow('retentionDays', '快照保留天数', '按天数保留快照，超期自动删除最旧的；填 0 表示不启用（与快照总数上限各自生效）', { min: 0, step: 1 }),
      React.createElement('div', { className: 'dsh-recall-cfg-row', key: 'refillDraft' },
        React.createElement('div', { className: 'dsh-recall-cfg-line' },
          React.createElement('label', { className: 'dsh-recall-cfg-label', htmlFor: 'dsh-recall-cfg-refill' }, '撤回后回填输入框'),
          React.createElement('input', {
            id: 'dsh-recall-cfg-refill',
            type: 'checkbox',
            checked: Boolean(draft.refillDraft),
            disabled: !writable,
            onChange: (e) => edit('refillDraft', e.target.checked),
          }),
          draft.refillDraft !== baseline.refillDraft ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已修改') : null,
          overridden && overridden.refillDraft !== undefined ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已覆盖') : null
        ),
        React.createElement('div', { className: 'dsh-recall-cfg-hint' }, '撤回成功后把被撤回的消息文本回填到输入框，方便修改后重新发送')
      ),
      React.createElement('div', { className: 'dsh-recall-cfg-row', key: 'archiveOriginal' },
        React.createElement('div', { className: 'dsh-recall-cfg-line' },
          React.createElement('label', { className: 'dsh-recall-cfg-label', htmlFor: 'dsh-recall-cfg-archive' }, '撤回后归档原会话'),
          React.createElement('input', {
            id: 'dsh-recall-cfg-archive',
            type: 'checkbox',
            checked: Boolean(draft.archiveOriginal),
            disabled: !writable,
            onChange: (e) => edit('archiveOriginal', e.target.checked),
          }),
          draft.archiveOriginal !== baseline.archiveOriginal ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已修改') : null,
          overridden && overridden.archiveOriginal !== undefined ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已覆盖') : null
        ),
        React.createElement('div', { className: 'dsh-recall-cfg-hint' }, '撤回后原会话从列表归档隐藏（可从归档找回）；关闭则保留在列表中，方便对照回退前后的上下文')
      ),
      React.createElement(SectionToggle, { title: '高级：基础排除表', open: showAdvanced, onToggle: () => setShowAdvanced((v) => !v) }),
      showAdvanced ? React.createElement('div', { className: 'dsh-recall-cfg-row', key: 'baseExcludes' },
        React.createElement('div', { className: 'dsh-recall-cfg-line' },
          React.createElement('label', { className: 'dsh-recall-cfg-label' }, '基础排除表'),
          draft.baseExcludes !== baseline.baseExcludes ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已修改') : null,
          overridden && overridden.baseExcludes !== undefined ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '已覆盖') : null
        ),
        React.createElement('textarea', {
          className: 'dsh-recall-cfg-area',
          rows: 4,
          value: draft.baseExcludes,
          disabled: !writable,
          onChange: (e) => edit('baseExcludes', e.target.value),
        }),
        React.createElement('div', { className: 'dsh-recall-cfg-hint' }, '内置规则，每个工作区共享，建议保持默认；gitignore 语法每行一条，优先级低于「排除配置」里的 exclude.txt（S3-2 折叠）')
      ) : null,
      React.createElement('div', { className: 'dsh-recall-panel-actions' },
        state.message ? React.createElement('span', { className: 'dsh-recall-ex-status' + (state.error ? ' dsh-recall-ex-status-error' : ' dsh-recall-ex-status-success') }, state.message) : null,
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: state.busy || !writable, onClick: () => setDraft(Object.assign({}, baseline)) }, '放弃修改'),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-recall-btn',
          disabled: state.busy || !writable,
          title: '把所有字段恢复到插件出厂默认值',
          onClick: resetDefaults
        }, '恢复默认'),
        React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: state.busy || !writable, onClick: save }, '保存'),
        !writable ? React.createElement('span', { className: 'dsh-recall-cfg-tag' }, '只读设置源') : null
      )
    )
  }

  // 分区折叠头：官方卡片列表纵向排布，排除配置/快照管理是重内容，默认折叠、
  // 按需展开（展开后由设置外壳保持挂载，草稿不丢）。
  function SectionToggle(props) {
    return React.createElement('button', {
      type: 'button',
      className: 'dsh-recall-cardbtn',
      'aria-expanded': props.open,
      onClick: props.onToggle,
    },
      React.createElement('span', { className: 'dsh-recall-tree-toggle' }, props.open ? '▾' : '▸'),
      React.createElement('span', { style: { fontWeight: 600, fontSize: '14px', lineHeight: '22px' } }, props.title),
      props.meta ? React.createElement('span', { className: 'dsh-recall-tree-meta' }, props.meta) : null
    )
  }

  // 「插件配置」分区里的撤回卡片（settings.plugin.item keyed slot，key =
  // Host 端注册的 settings namespace 'dsh-recall'）。整卡默认收起、点卡片头
  // 展开。展开后内含三段：插件配置表单 + 排除配置（折叠）+ 快照管理（折叠）。
  function RecallSettingsCard() {
    const [open, setOpen] = React.useState(false)
    const [sections, setSections] = React.useState({ exclude: false, manage: false })
    function toggle(key) {
      setSections((prev) => Object.assign({}, prev, { [key]: !prev[key] }))
    }
    return React.createElement('li', { className: 'dsh-recall-card' + (open ? ' dsh-recall-card-open' : '') },
      React.createElement('button', {
        type: 'button',
        className: 'dsh-recall-cardbtn',
        'aria-expanded': open,
        'aria-label': (open ? '收起' : '展开') + ': 撤回插件',
        onClick: () => setOpen((v) => !v),
      },
        React.createElement('span', { className: 'dsh-recall-card-head' },
          React.createElement('span', { className: 'dsh-recall-card-name' }, '撤回插件'),
          React.createElement('span', { className: 'dsh-recall-card-desc' }, '消息撤回（文件快照 + 对话回退）的阈值与治理')
        ),
        React.createElement('svg', {
          width: 14, height: 14, viewBox: '0 0 16 16',
          style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', transition: 'transform .16s', transform: open ? 'rotate(180deg)' : 'none' }
        }, React.createElement('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      ),
      open ? React.createElement('div', { className: 'dsh-recall-card-body' },
        React.createElement(ConfigForm),
        React.createElement(SectionToggle, { title: '排除配置（exclude.txt）', open: sections.exclude, onToggle: () => toggle('exclude') }),
        sections.exclude ? React.createElement(ExcludeFilesSection) : null,
        React.createElement(SectionToggle, { title: '快照管理', open: sections.manage, onToggle: () => toggle('manage') }),
        sections.manage ? React.createElement(ManageCard) : null
      ) : null
    )
  }

  return { RecallSettingsCard }
}
