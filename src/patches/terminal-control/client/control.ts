import { apiErrorText, callPatchApi, DshMoreApiError } from '../../../platform/dsh/client/api.js'
import { ID, operation, type Mode, type Request } from '../shared.js'
import { controlBar } from './bar.js'
import { findScreen, recentScreen, visible, waitForOutput, type Screen } from './screen.js'

type Call = <T>(action: string, payload: object) => Promise<T>
const callHost: Call = (action, payload) => callPatchApi(ID, action, payload)
const sessionOf = (root: HTMLElement) => root.closest<HTMLElement>('[data-sidebar-right-session]')?.dataset.sidebarRightSession
const readyText = (mode: Mode) => mode === 'full' ? '对话可直接读屏和输入' : '对话可读屏，命令需确认'

/** Keep the grant bound to the original sidebar and xterm, including while the OS backgrounds its window. */
export function mountControl(root: HTMLElement, call: Call = callHost) {
  const doc = root.ownerDocument
  const { bar, select, status, record, confirm } = controlBar(doc)
  root.prepend(bar)

  let active: { stop: AbortController; term: Screen; session: string; mode: Mode } | undefined
  let key: string | undefined
  let transition = Promise.resolve()
  const ancestors = new MutationObserver(() => check())
  // Window visibility and layout dimensions are admission checks only. Chromium can hide or
  // resize a mounted terminal when switching tabs, Spaces or apps without changing its owner.
  const bound = (grant: NonNullable<typeof active>) => active === grant && root.isConnected
    && !root.closest('[hidden], [data-sidebar-right-panel][aria-hidden="true"], [data-sidebar-right-panel]:not([data-sidebar-right-open])')
    && sessionOf(root) === grant.session && findScreen(root) === grant.term
  const closeKey = async (oldKey: string) => { await call('close', { key: oldKey }).catch(() => {}) }

  function stop(message = ''): void {
    active?.stop.abort()
    active = undefined
    ancestors.disconnect()
    const oldKey = key
    key = undefined
    if (oldKey) transition = transition.then(() => closeKey(oldKey))
    select.value = 'off'
    status.textContent = message
  }
  function check(): void {
    if (active && !bound(active)) stop('终端已切换或断开，授权已结束')
  }

  async function serve(grant: NonNullable<typeof active>, token: string): Promise<void> {
    while (bound(grant)) {
      const req = await call<Request | null>('next', { key: token })
      if (!bound(grant)) break
      if (!req) continue
      const ref = { key: token, id: req.id }
      try {
        const op = operation(req.operation, grant.mode)
        if (op.action === 'run' && grant.mode === 'restricted') {
          status.textContent = '等待你确认命令'
          const ended = new AbortController()
          // Drop the approval immediately if the user stops the turn in the conversation.
          void call('watch', ref).then(() => ended.abort(), () => ended.abort())
          if (!await confirm(op.text, AbortSignal.any([grant.stop.signal, ended.signal]))) {
            if (!bound(grant)) break
            record(ended.signal.aborted ? '请求已取消' : '未发送命令')
            await call('result', { ...ref, ok: false, message: '用户拒绝或确认超时。' })
            continue
          }
        }
        if (!bound(grant)) break
        await call('claim', ref)
        if (!bound(grant)) break
        if (op.action !== 'read') {
          grant.term.input(op.action === 'run' ? op.text + '\r' : op.text, true)
          if (op.action === 'run') record('已发送命令', op.text)
          else record(op.text === '\x03' ? '已发送 Ctrl+C' : op.text === '\r' ? '已发送回车' : '已发送交互输入')
          await waitForOutput(grant.term, grant.stop.signal)
        } else record('已读取终端屏幕')
        if (!bound(grant)) break
        const prefix = op.action === 'read' ? '' : 'Input queued. Recent screen (command completion unknown):\n'
        await call('result', { ...ref, ok: true, message: prefix + recentScreen(grant.term) })
      } catch (error) {
        // A canceled tool cannot claim a delayed approval, or replay a previously claimed input.
        if (!(error instanceof DshMoreApiError && error.code === 'stale-preview')) throw error
      } finally {
        if (active === grant) status.textContent = readyText(grant.mode)
      }
    }
    if (active === grant) stop('终端授权已结束')
  }

  select.onchange = () => {
    const mode = select.value
    stop()
    if (mode !== 'restricted' && mode !== 'full') return
    const session = sessionOf(root)
    const term = findScreen(root)
    if (!session || !term || !visible(root)) { status.textContent = '请先连接可输入的侧栏终端'; return }
    const grant = { stop: new AbortController(), session, mode, term } as const
    active = grant
    select.value = mode
    status.textContent = '连接中…'
    for (let node: HTMLElement | null = root; node; node = node.parentElement) {
      ancestors.observe(node, { attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'data-sidebar-right-session', 'data-sidebar-right-open'] })
    }
    transition = transition.then(async () => {
      if (!bound(grant)) { if (active === grant) stop(); return }
      const result = await call<{ key: string }>('open', { sessionId: session, mode })
      if (!bound(grant)) { await closeKey(result.key); if (active === grant) stop(); return }
      key = result.key
      status.textContent = readyText(mode)
      void serve(grant, result.key).catch(error => { if (active === grant) stop(apiErrorText(error)) })
    }).catch(error => { if (active === grant) stop(apiErrorText(error)) })
  }
  doc.defaultView?.addEventListener('pagehide', onPageHide)
  function onPageHide(): void { stop() }
  return {
    check,
    dispose() {
      stop()
      doc.defaultView?.removeEventListener('pagehide', onPageHide)
      bar.remove()
    },
  }
}
