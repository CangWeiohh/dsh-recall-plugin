/**
 * dsh-recall-plugin — Client 半（持久插件形态，浏览器 bundle）
 *
 * 职责：注册 conversation.chat.node 的 user 渲染器，重绘用户消息气泡
 * （文本/图片/JSON 块），在复制按钮旁加「撤回」按钮；二次确认面板展示
 * 文件变更清单，确认后经 /api/recall/* 调用 Host 回退文件，并用官方
 * sessions.fork 把对话一并回退（新会话打开、原会话归档）。
 *
 * 这是 dsh.client bundle（exports["./client"]），由 client-modules 打包成
 * /plugins/<pkg>/client.js 注入页面；factory 内 require("react") 由平台
 * 模块表提供。零构建依赖：纯 JS + React.createElement。
 */
window.__ModuleLoader__.load({
  id: "dsh-recall-plugin",
  factory: (require) => {
    const React = require("react")

    return {
      name: "dsh-recall-plugin",
      apply(ctx) {
        const slots = ctx.get('slots')
        if (!slots) return
        // 官方会话服务：fork 到已完成 turn 前缀 + open 切到新会话；
        // workspaces 的归档只是从列表隐藏、可恢复，用来收走回退前的原会话。
        const sessionsSvc = ctx.get('sessions')
        const workspacesSvc = ctx.get('workspaces')

        // Host HTTP API（动态插件的 harness RPC 在此换成 fetch 调用）
        function api(name, args) {
          return fetch('/api/recall/' + name, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args || {})
          }).then((r) => r.json())
        }

        const css = [
          '.dsh-recall-row{flex-direction:column;align-items:flex-end;gap:6px;display:flex}',
          '.dsh-recall-stack{flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%);display:flex}',
          '.dsh-recall-bubble{background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;white-space:pre-wrap;word-break:break-word}',
          '.dsh-recall-img{max-width:100%;max-height:320px;border-radius:12px;object-fit:contain}',
          '.dsh-recall-json{margin:0;max-width:100%;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-markdown-code-block)}',
          '.dsh-recall-actions{align-items:center;gap:10px;height:28px;display:flex}',
          '.dsh-recall-time{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px;font-size:14px;line-height:24px}',
          '.dsh-recall-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
          '.dsh-recall-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
          '@media (hover:hover){[data-time-hover-root] .dsh-recall-time{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .dsh-recall-time,[data-time-hover-root]:focus-within .dsh-recall-time{opacity:1}}',
          '.dsh-recall-panel{width:min(480px,100%);box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;text-align:left;box-shadow:0 8px 28px rgba(0,0,0,.22)}',
          '.dsh-recall-panel-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}',
          '.dsh-recall-panel-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;word-break:break-word}',
          '.dsh-recall-list{max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:4px 0}',
          '.dsh-recall-file{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:20px}',
          '.dsh-recall-badge{flex:none;font-size:11px;line-height:18px;padding:0 6px;border-radius:6px}',
          '.dsh-recall-badge-modified{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}',
          '.dsh-recall-badge-restored{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
          '.dsh-recall-badge-added{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}',
          '.dsh-recall-rel{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-all;font-family:var(--dsw-font-code, ui-monospace, SFMono-Regular, Consolas, monospace)}',
          '.dsh-recall-panel-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}',
          '.dsh-recall-btn{border:none;border-radius:8px;padding:5px 14px;font-size:13px;line-height:20px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
          '.dsh-recall-btn:hover{color:var(--dsw-alias-label-primary)}',
          '.dsh-recall-btn-danger{background:var(--dsw-alias-state-error-primary);color:#fff}',
          '.dsh-recall-btn-danger:hover{color:#fff;filter:brightness(1.08)}',
          '.dsh-recall-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10000;max-width:min(560px,86vw);box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 16px;font-size:13px;line-height:20px;box-shadow:0 8px 28px rgba(0,0,0,.22);display:flex;align-items:baseline;gap:8px;opacity:0;transition:opacity .25s ease;pointer-events:auto}',
          '.dsh-recall-toast.dsh-recall-toast-in{opacity:1}',
          '.dsh-recall-toast-tag{flex:none;font-weight:600;color:var(--dsw-alias-state-error-primary)}',
          '.dsh-recall-ex-tab{display:flex;flex-direction:column;gap:16px;max-width:720px;padding:4px 0;text-align:left}',
          '.dsh-recall-ex-card{display:flex;flex-direction:column;gap:8px}',
          '.dsh-recall-ex-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}',
          '.dsh-recall-ex-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;word-break:break-word}',
          '.dsh-recall-ex-area{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;font-size:12px;line-height:20px;font-family:var(--dsw-font-code, ui-monospace, SFMono-Regular, Consolas, monospace);resize:vertical;min-height:120px}',
          '.dsh-recall-ex-quick{display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
          '.dsh-recall-ex-input{flex:1;min-width:180px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 10px;font-size:13px;line-height:20px}',
          '.dsh-recall-ex-chip{border:none;border-radius:6px;padding:2px 8px;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
          '.dsh-recall-ex-chip:hover{color:var(--dsw-alias-label-primary)}',
          '.dsh-recall-ex-status{margin-right:auto;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
          '.dsh-recall-ex-status-error{color:var(--dsw-alias-state-error-primary)}'
        ].join('')
        // 静态 bundle 的 ctx 可能不提供 styles 服务，降级为直接注入 <style>
        const stylesSvc = ctx.get('styles')
        if (stylesSvc && typeof stylesSvc.insert === 'function') {
          stylesSvc.insert(css)
        } else if (typeof document !== 'undefined') {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin', 'dsh-recall-plugin')
          tag.textContent = css
          document.head.appendChild(tag)
        }

        let initedSessionId = null
        let initDone = Promise.resolve()

        // 降级提示：每个种类每次页面加载只弹一次（Set 去重），避免切会话时
        // 反复打扰。纯 DOM 直插（与剪贴板同样的零依赖思路），7 秒后自动淡出。
        const noticeShown = new Set()
        function showNotice(kind, text) {
          if (noticeShown.has(kind) || typeof document === 'undefined') return
          noticeShown.add(kind)
          try {
            const el = document.createElement('div')
            el.className = 'dsh-recall-toast'
            const tag = document.createElement('span')
            tag.className = 'dsh-recall-toast-tag'
            tag.textContent = '撤回插件'
            const body = document.createElement('span')
            body.textContent = text
            el.appendChild(tag)
            el.appendChild(body)
            el.addEventListener('click', () => dismiss(), { once: true })
            document.body.appendChild(el)
            requestAnimationFrame(() => el.classList.add('dsh-recall-toast-in'))
            const timer = setTimeout(dismiss, 7000)
            let dismissed = false
            function dismiss() {
              if (dismissed) return
              dismissed = true
              clearTimeout(timer)
              el.classList.remove('dsh-recall-toast-in')
              setTimeout(() => el.remove(), 300)
            }
          } catch (e) { /* 提示失败不影响主流程 */ }
        }

        // 每个会话只向 Host 注册一次（预热其根目录解析缓存）。
        // 返回 init 的 promise：Host 端 init 要跑数条 PowerShell（建仓/loadIndex），
        // snapshot-info 必须等它完成后再查，否则冷启动时索引尚未载入会误判
        // has:false 且不再重试，撤回按钮将永不出现。
        function ensureInit(sessionId) {
          if (!sessionId || initedSessionId === sessionId) return initDone
          initedSessionId = sessionId
          initDone = api('init', { sessionId }).then((res) => {
            const notice = res && res.notice
            if (notice && notice.unsupported) {
              showNotice('unsupported', '撤回插件仅支持 Windows / Linux / macOS，当前平台的快照不可用。')
            }
            if (notice && notice.gitMissing) {
              showNotice('git', '未检测到 git CLI，撤回功能不可用（快照引擎依赖 git）。安装 git 并重启 DSH 后即可使用。')
            }
            if (notice && notice.homeFallback) {
              showNotice('home', 'home 目录不可写，快照已降级存储到项目内 .dsh-recall-snapshots 目录。')
            }
          }).catch(() => {
            // init 失败（如页面先于 Host API 就绪加载）时清掉标记：否则本会话
            // 内被判定“已初始化”，撤回按钮永不出现；清掉后下一条消息挂载会重试
            if (initedSessionId === sessionId) initedSessionId = null
          })
          return initDone
        }

        // 消息时间：当天只显示时分，跨天显示月/日 时分
        function clockText(ms) {
          try {
            // time 字段缺失或非法时返回空串：Invalid Date 不会 throw，
            // 不拦会渲染出 "NaN/NaN NaN:NaN" 这样的坏时间戳
            if (!ms || isNaN(new Date(ms).getTime())) return ''
            const d = new Date(ms)
            const now = new Date()
            const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
            const hh = String(d.getHours()).padStart(2, '0')
            const mm = String(d.getMinutes()).padStart(2, '0')
            return sameDay ? hh + ':' + mm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm
          } catch (e) {
            return ''
          }
        }

        // 复制按钮走浏览器剪贴板；无 primitives 依赖，直接调用并带降级
        function writeClipboard(text) {
          try {
            if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              return navigator.clipboard.writeText(text).then(() => true, () => false)
            }
          } catch (e) { /* fall through */ }
          try {
            if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
              const el = document.createElement('textarea')
              el.value = text
              el.setAttribute('readonly', '')
              el.style.position = 'fixed'
              el.style.left = '-9999px'
              document.body.appendChild(el)
              el.select()
              try {
                return Promise.resolve(document.execCommand('copy'))
              } finally {
                el.remove()
              }
            }
          } catch (e) { /* ignore */ }
          return Promise.resolve(false)
        }

        function CopyIcon() {
          return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
            React.createElement('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
            React.createElement('path', { d: 'M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5' })
          )
        }

        function CheckIcon() {
          return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            React.createElement('path', { d: 'm3 8.5 3.2 3.2L13 5' })
          )
        }

        function UndoIcon() {
          return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            React.createElement('path', { d: 'M7.5 3.5 3.5 7.5l4 4' }),
            React.createElement('path', { d: 'M4.5 7.5h5a3 3 0 0 1 0 6H8' })
          )
        }

        function useImageSrc(attachment, loadImage) {
          const [src, setSrc] = React.useState(null)
          React.useEffect(() => {
            let alive = true
            if (!attachment || typeof loadImage !== 'function') return undefined
            Promise.resolve(loadImage(attachment)).then((url) => {
              if (alive && url) setSrc(String(url))
            }).catch(() => {})
            return () => { alive = false }
          }, [attachment, loadImage])
          return src
        }

        function ImageBox(props) {
          const src = useImageSrc(props.attachment, props.loadImage)
          if (!src) return null
          return React.createElement('img', { className: 'dsh-recall-img', src, alt: '' })
        }

        const KIND_LABEL = { modified: '修改', restored: '恢复', added: '删除' }

        function summaryText(counts) {
          const parts = []
          if (counts.modified > 0) parts.push('修改 ' + counts.modified)
          if (counts.restored > 0) parts.push('恢复 ' + counts.restored)
          if (counts.added > 0) parts.push('删除 ' + counts.added)
          return parts.join(' · ')
        }

        function recallPanel(recall, closePanel, executeRecall) {
          if (recall.stage === 'loading') {
            return React.createElement('div', { className: 'dsh-recall-panel' },
              React.createElement('div', { className: 'dsh-recall-panel-title' }, '正在计算变更…')
            )
          }
          if (recall.stage === 'error') {
            return React.createElement('div', { className: 'dsh-recall-panel' },
              React.createElement('div', { className: 'dsh-recall-panel-title' }, '无法回退'),
              React.createElement('div', { className: 'dsh-recall-panel-note' }, recall.message || ''),
              React.createElement('div', { className: 'dsh-recall-panel-actions' },
                React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: closePanel }, '关闭')
              )
            )
          }
          if (recall.stage === 'confirm') {
            const changes = recall.changes || []
            const counts = { modified: 0, restored: 0, added: 0 }
            for (const c of changes) {
              if (c && counts[c.kind] !== undefined) counts[c.kind]++
            }
            const rows = changes.map((c, i) => React.createElement('div', { className: 'dsh-recall-file', key: i },
              React.createElement('span', { className: 'dsh-recall-badge dsh-recall-badge-' + (c.kind || '') }, KIND_LABEL[c.kind] || c.kind || ''),
              React.createElement('span', { className: 'dsh-recall-rel' }, c.rel || '')
            ))
            // cutSeq 为 null 表示该消息是会话第一条用户消息：文件可回退但对话无从回退
            const canRevertChat = typeof recall.cutSeq === 'number'
            return React.createElement('div', { className: 'dsh-recall-panel' },
              React.createElement('div', { className: 'dsh-recall-panel-title' }, '整段回退'),
              React.createElement('div', { className: 'dsh-recall-panel-note' },
                '将项目恢复到' + (recall.time ? ' ' + clockText(recall.time) + ' ' : ' ') + '发送该消息时的状态。共 ' + changes.length + ' 个文件将变更' + (summaryText(counts) ? '（' + summaryText(counts) + '）' : '') + '。此操作会覆盖当前文件内容，不会自动创建备份。'
              ),
              React.createElement('div', { className: 'dsh-recall-panel-note' },
                canRevertChat
                  ? '对话将一并回退到该消息之前：该消息及之后的全部对话会从当前视图移除，原会话归档保存（可从归档找回）。'
                  : '该消息是本会话中第一条用户消息，无法回退对话；确认后仅回退项目文件。'
              ),
              changes.length > 0 ? React.createElement('div', { className: 'dsh-recall-list' }, ...rows) : null,
              React.createElement('div', { className: 'dsh-recall-panel-actions' },
                React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: closePanel }, '取消'),
                React.createElement('button', { type: 'button', className: 'dsh-recall-btn dsh-recall-btn-danger', onClick: executeRecall }, '确认回退')
              )
            )
          }
          if (recall.stage === 'executing') {
            return React.createElement('div', { className: 'dsh-recall-panel' },
              React.createElement('div', { className: 'dsh-recall-panel-title' }, '正在回退…')
            )
          }
          if (recall.stage === 'done') {
            return React.createElement('div', { className: 'dsh-recall-panel' },
              React.createElement('div', { className: 'dsh-recall-panel-title' }, '回退完成'),
              React.createElement('div', { className: 'dsh-recall-panel-note' },
                recall.chatReverted
                  ? '项目文件与对话已回退到该消息之前。新会话已打开，原会话已归档（可从归档找回）。'
                  : '项目已恢复到发送该消息时的状态。' + (recall.chatError ? ' 对话回退失败：' + recall.chatError : '')
              ),
              React.createElement('div', { className: 'dsh-recall-panel-actions' },
                React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: closePanel }, '关闭')
              )
            )
          }
          return null
        }

        function UserRecallNode(props) {
          const node = props && props.node
          const loadImage = props && props.loadImage
          const sessionId = props && props.sessionId
          const data = node && node.data ? node.data : {}
          // node.id 是会话事件匹配时写入的真实消息 ID；node.key 是位置键（如 13:input），不能用于快照查询
          const messageId = node ? String(node.id || node.key || '') : ''
          const blocks = Array.isArray(data.content) ? data.content : []
          const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
          const images = blocks.filter((b) => b && b.type === 'image' && b.attachment).map((b) => b.attachment)
          const rest = blocks.filter((b) => !b || !(b.type === 'text' && typeof b.text === 'string') && !(b.type === 'image' && b.attachment))

          const [copied, setCopied] = React.useState(false)
          const [hasSnapshot, setHasSnapshot] = React.useState(false)
          const [recall, setRecall] = React.useState({ stage: 'idle' })

          React.useEffect(() => {
            let alive = true
            // 先等 init 预热完成再查快照存在性：避免索引未载入时误判 has:false
            ensureInit(sessionId).then(() => {
              if (!messageId || !alive) return
              return api('snapshot-info', { messageId }).then((res) => {
                if (alive && res && res.has) setHasSnapshot(true)
              }).catch(() => {})
            })
            return () => { alive = false }
          }, [messageId, sessionId])

          const onCopy = () => {
            if (copied) return
            writeClipboard(text).then(() => {
              setCopied(true)
              const timer = ctx.get('timer')
              if (timer && typeof timer.timeout === 'function') {
                timer.timeout(() => setCopied(false), 1200)
              } else {
                setTimeout(() => setCopied(false), 1200)
              }
            })
          }

          const openPreview = () => {
            if (recall.stage === 'loading' || recall.stage === 'executing') return
            setRecall({ stage: 'loading' })
            api('preview', { messageId, sessionId }).then((res) => {
              if (!res || !res.ok) {
                setRecall({ stage: 'error', message: (res && res.error) || '无法获取快照' })
                return
              }
              setRecall({
                stage: 'confirm',
                changes: res.changes || [],
                time: res.time || null,
                cutSeq: typeof res.cutSeq === 'number' ? res.cutSeq : null
              })
            }).catch((error) => {
              setRecall({ stage: 'error', message: String(error) })
            })
          }

          const executeRecall = () => {
            if (recall.stage !== 'confirm') return
            const changes = recall.changes || []
            const previewCut = typeof recall.cutSeq === 'number' ? recall.cutSeq : null
            setRecall({ stage: 'executing', changes })
            api('execute', { messageId, sessionId }).then(async (res) => {
              if (!res || !res.ok) {
                setRecall({ stage: 'error', message: (res && res.error) || '回退失败' })
                return
              }
              // 文件已回退；对话回退独立进行，失败只降级为“仅文件回退”而不是整体失败
              const cutSeq = typeof res.cutSeq === 'number' ? res.cutSeq : previewCut
              let chatReverted = false
              let chatError = ''
              if (cutSeq !== null && sessionsSvc && typeof sessionsSvc.fork === 'function') {
                try {
                  // 撤回语义是「回退」而非「复制」：新会话顶替原会话（原会话已
                  // 归档），必须原样继承标题。increaseTitle 是官方侧栏「复制会话」
                  // 用来区分新旧会话的，会把标题改成「xxx 2」且多次撤回时数字
                  // 不断递增，与「同一会话回退」的用户观感相悖，故不传。
                  const childId = await sessionsSvc.fork({ sessionId, atSeq: cutSeq })
                  if (childId) {
                    if (typeof sessionsSvc.open === 'function') sessionsSvc.open(childId)
                    chatReverted = true
                    // 回退前的原会话归档：只是从列表隐藏、可恢复，避免侧栏出现两个近似会话
                    if (workspacesSvc && typeof workspacesSvc.archiveSession === 'function') {
                      workspacesSvc.archiveSession(sessionId).catch(() => {})
                    }
                  } else {
                    chatError = '未返回新会话'
                  }
                } catch (error) {
                  chatError = String(error)
                }
              }
              setHasSnapshot(false)
              setRecall({ stage: 'done', count: typeof res.count === 'number' ? res.count : changes.length, chatReverted, chatError })
            }).catch((error) => {
              setRecall({ stage: 'error', message: String(error) })
            })
          }

          const closePanel = () => setRecall({ stage: 'idle' })

          const bubbleChildren = []
          if (text !== '') bubbleChildren.push(React.createElement('div', { className: 'dsh-recall-bubble', key: 'text' }, text))
          for (let i = 0; i < images.length; i++) {
            bubbleChildren.push(React.createElement(ImageBox, { key: 'img-' + i, attachment: images[i], loadImage }))
          }
          for (let i = 0; i < rest.length; i++) {
            bubbleChildren.push(React.createElement('pre', { className: 'dsh-recall-json', key: 'rest-' + i }, JSON.stringify(rest[i], null, 2)))
          }

          const actions = []
          actions.push(React.createElement('span', { className: 'dsh-recall-time', key: 'time' }, clockText(data.time)))
          actions.push(React.createElement('button', {
            key: 'copy',
            type: 'button',
            className: 'dsh-recall-action',
            'aria-label': copied ? '已复制' : '复制',
            title: copied ? '已复制' : '复制',
            onClick: onCopy
          }, copied ? React.createElement(CheckIcon, {}) : React.createElement(CopyIcon, {})))
          if (hasSnapshot) {
            actions.push(React.createElement('button', {
              key: 'recall',
              type: 'button',
              className: 'dsh-recall-action',
              'aria-label': '撤回',
              title: '整段回退：文件与对话一并回到该消息之前',
              onClick: openPreview
            }, React.createElement(UndoIcon, {})))
          }

          return React.createElement('div', { className: 'dsh-recall-row', 'data-time-hover-root': true },
            bubbleChildren.length > 0 ? React.createElement('div', { className: 'dsh-recall-stack', key: 'stack' }, ...bubbleChildren) : null,
            React.createElement('div', { className: 'dsh-recall-actions', key: 'actions' }, ...actions),
            recallPanel(recall, closePanel, executeRecall)
          )
        }

        // ---- 设置页「撤回设置」标签：exclude.txt 可视化快速编辑 ----

        // 常用排除建议：一键追加的高频项，覆盖构建产物/日志/密钥三类最
        // 常见诉求；已存在的条目自动从候选里滤掉，避免重复点击堆叠。
        const EXCLUDE_SUGGESTIONS = ['dist/', 'build/', 'out/', 'coverage/', '*.log', '.env']

        // 单个 exclude 文件的编辑卡片。draft/baseline 分离实现「未保存
        // 修改」判定（textarea 所见即将保存的原文，不偷偷规范化）；
        // key=file.path 挂载，父级重载列表时整卡重建、草稿随之丢弃。
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
                setState({ busy: false, message: (res && res.error) || '保存失败', error: true })
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
              state.message ? React.createElement('span', { className: 'dsh-recall-ex-status' + (state.error ? ' dsh-recall-ex-status-error' : '') }, state.message) : null,
              React.createElement('button', { type: 'button', className: 'dsh-recall-btn', disabled: !dirty || state.busy, onClick: discard }, '放弃修改'),
              React.createElement('button', { type: 'button', className: 'dsh-recall-btn dsh-recall-btn-danger', disabled: !dirty || state.busy, onClick: save }, '保存')
            )
          )
        }

        // 「插件」设置分区的标签页主体：拉取 Host 枚举的 exclude 文件列表
        // （home 存储通常合并为一条，降级工作区各一条）。标签页被选中后
        // 由设置外壳保持挂载，本地草稿在标签间切换时不丢失。
        function RecallSettingsTab() {
          const [files, setFiles] = React.useState(null)
          const [error, setError] = React.useState('')

          function load() {
            api('exclude-get', {}).then((res) => {
              if (res && res.ok) { setFiles(res.files || []); setError(''); return }
              if (res && res.unsupported) { setError('当前平台不支持快照功能，排除配置不可用。'); return }
              setError((res && res.error) || '无法读取排除配置')
            }).catch((e) => setError(String(e)))
          }

          React.useEffect(() => { load() }, [])

          let body = null
          if (error) {
            body = React.createElement('div', { className: 'dsh-recall-ex-card' },
              React.createElement('div', { className: 'dsh-recall-ex-note' }, error),
              React.createElement('div', { className: 'dsh-recall-panel-actions' },
                React.createElement('button', { type: 'button', className: 'dsh-recall-btn', onClick: load }, '重试')
              )
            )
          } else if (files === null) {
            body = React.createElement('div', { className: 'dsh-recall-ex-note' }, '正在加载排除配置…')
          } else if (!files.length) {
            // 全新安装且从未发过消息：store 还没建，先告诉用户怎么触发
            body = React.createElement('div', { className: 'dsh-recall-ex-note' }, '尚未创建任何快照存储：在任意工作区发送一条消息后，这里会出现可编辑的排除配置。')
          } else {
            body = React.createElement('div', { className: 'dsh-recall-ex-card' },
              ...files.map((f) => React.createElement(ExcludeCard, { key: f.path, file: f }))
            )
          }
          return React.createElement('div', { className: 'dsh-recall-ex-tab' }, body)
        }

        // keyed slot 显式用低于默认 0 的 priority 注册：默认 0 通常被平台/
        // 其他插件的渲染器占据，不指定 priority 会因 keyed slot 冲突拒载
        // 整个插件；lowest renders，负值恰好覆盖默认渲染器实现撤回 UI。
        // priority -1 也可能被别的机器上的插件占用（同样抛冲突），所以
        // 递减重试三次——最坏情况只是撤回按钮不渲染，绝不让插件加载失败。
        let mounted = false
        for (let priority = -1; priority >= -3 && !mounted; priority--) {
          try {
            slots.inject('conversation.chat.node', () => slots.register(
              { name: 'conversation.chat.node', key: 'user', priority },
              UserRecallNode
            ))
            mounted = true
          } catch (error) {
            if (priority === -3) console.error('[dsh-recall-plugin] slot register failed:', error)
          }
        }

        // 「插件」设置分区挂自己的标签页：settings.plugins.tab 是 root 级
        // list slot，id 唯一即无冲突（与 keyed slot 的 priority 冲突是两套
        // 语义），order 20 排在官方「插件配置」(0) 与「插件清单」(10) 之后。
        // 该 slot 由 ui-settings-plugins 声明；未组装设置页的部署里 inject
        // 只是永不匹配的待定注册，天然无害。try/catch 是防御性兜底——注册
        // 失败绝不该拖垮撤回按钮的主功能。
        try {
          slots.inject('settings.plugins.tab', () => slots.register(
            { name: 'settings.plugins.tab', id: 'dsh-recall', order: 20, label: '撤回设置' },
            RecallSettingsTab
          ))
        } catch (error) {
          console.error('[dsh-recall-plugin] settings tab register failed:', error)
        }
      }
    }
  }
})
