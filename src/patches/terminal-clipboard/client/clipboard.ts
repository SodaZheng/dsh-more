import { resolveTerminal, type TerminalHandle } from './terminal.js'

type Resolve = (root: HTMLElement) => TerminalHandle | undefined

/** Delegation handles terminal tabs/remounts without a global MutationObserver. */
export function installTerminalClipboard(doc: Document, resolve: Resolve = resolveTerminal): () => void {
  let active = true
  let gesture: { root: HTMLElement; before: string } | undefined
  let pasteRevision = 0
  let notice: HTMLElement | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const clipboard = doc.defaultView?.navigator.clipboard
  const rootAt = (target: EventTarget | null): HTMLElement | undefined => {
    if (!(target instanceof Element)) return
    return target.closest<HTMLElement>('.xterm') ?? undefined
  }
  const report = (action: string): void => {
    if (!active) return
    notice?.remove()
    clearTimeout(noticeTimer)
    notice = doc.createElement('div')
    notice.setAttribute('role', 'status')
    notice.setAttribute('data-dshmore-terminal-notice', '')
    notice.textContent = '终端' + action + '失败：请允许剪贴板访问，或用 Shift+右键打开原生菜单；也可使用 macOS 的 ⌘C/⌘V 或系统原生粘贴快捷键。'
    notice.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:10000;max-width:360px;padding:12px 16px;border-radius:8px;background:#252525;color:#fff;font-size:13px;box-shadow:0 4px 20px #0005'
    doc.body.append(notice)
    noticeTimer = setTimeout(() => { notice?.remove(); notice = undefined }, 6000)
  }
  const copy = async (text: string): Promise<void> => {
    if (!text || !active) return
    try {
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable')
      await clipboard.writeText(text)
    } catch { report('复制') }
  }
  const paste = async (root: HTMLElement, term: TerminalHandle): Promise<void> => {
    const revision = ++pasteRevision
    if (term.options.disableStdin) return
    term.focus()
    try {
      if (!clipboard?.readText) throw new Error('Clipboard unavailable')
      const text = await clipboard.readText()
      // Do not send a delayed clipboard result into a closed/replaced/blurred terminal.
      if (!active || revision !== pasteRevision || !root.isConnected || resolve(root) !== term
        || term.options.disableStdin || !root.contains(doc.activeElement)) return
      if (text) term.paste(text) // Preserve xterm's newline normalization and bracketed paste.
    } catch { report('粘贴') }
  }
  const consume = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation() }
  const contextmenu = (event: MouseEvent): void => {
    if (event.shiftKey) return // Explicit escape hatch to the browser's native menu.
    const root = rootAt(event.target)
    const term = root && resolve(root)
    if (!root || !term || term.options.disableStdin) return
    consume(event)
    void paste(root, term)
  }
  const keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.altKey) return
    const root = rootAt(event.target)
    const term = root && resolve(root)
    if (!root || !term) return
    const key = event.key.toLowerCase()
    if (key === 'c' && (event.ctrlKey || event.metaKey)) {
      const selection = term.getSelection()
      if (!selection) return // In particular, Ctrl+C still sends SIGINT.
      // Native Cmd+C / Ctrl+C copy events already understand xterm selections.
      // Handle Ctrl+C explicitly so selected text never sends SIGINT.
      if (event.metaKey && !event.ctrlKey) return
      consume(event)
      if (!event.repeat) void copy(selection)
    } else if ((key === 'v' && event.ctrlKey && event.shiftKey && !event.metaKey)
      || (key === 'insert' && event.shiftKey && !event.ctrlKey && !event.metaKey)) {
      if (term.options.disableStdin) return
      consume(event)
      if (!event.repeat) void paste(root, term)
    }
    // Cmd+V and Ctrl+V keep the trusted native paste path (no read permission needed).
  }
  const mousedown = (event: MouseEvent): void => {
    gesture = undefined
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return
    const root = rootAt(event.target)
    const term = root && resolve(root)
    if (root && term) gesture = { root, before: term.getSelection() }
  }
  const mouseup = (event: MouseEvent): void => {
    const started = gesture
    gesture = undefined
    if (event.button !== 0 || !started) return
    // xterm completes its document-level selection handler before this microtask.
    queueMicrotask(() => {
      if (!active || !started.root.isConnected) return
      const text = resolve(started.root)?.getSelection()
      if (text && text !== started.before) void copy(text)
    })
  }
  const blur = (): void => { gesture = undefined; pasteRevision++ }
  doc.addEventListener('contextmenu', contextmenu, true)
  doc.addEventListener('keydown', keydown, true)
  doc.addEventListener('mousedown', mousedown, true)
  doc.addEventListener('mouseup', mouseup, true)
  doc.defaultView?.addEventListener('blur', blur)
  return () => {
    active = false
    blur()
    doc.removeEventListener('contextmenu', contextmenu, true)
    doc.removeEventListener('keydown', keydown, true)
    doc.removeEventListener('mousedown', mousedown, true)
    doc.removeEventListener('mouseup', mouseup, true)
    doc.defaultView?.removeEventListener('blur', blur)
    clearTimeout(noticeTimer)
    notice?.remove()
  }
}
