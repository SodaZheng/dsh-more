const ATTRIBUTE = 'data-dshmore-session-move'

/** Extend the native session menu; the owning sidebar adapter supplies the exact id. */
export function installMoveMenu(onMove: (archive: HTMLButtonElement) => void): () => void {
  const items = new Map<HTMLButtonElement, HTMLElement>()
  let frame: number | undefined
  const sync = (): void => {
    frame = undefined
    for (const [source, item] of items) {
      if (!source.isConnected || !item.isConnected) { item.remove(); items.delete(source) }
    }
    for (const source of document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')) {
      const text = source.textContent?.trim()
      if (text !== '归档会话' && text !== 'Archive session' || items.has(source)) continue
      // Only the native sidebar's open row is routed through our injected
      // archiveSession prop. Never offer this action in unrelated archive menus.
      if (document.querySelector('[class*="_sessionRow"][class*="_menuOpen"]') === null) continue
      const wrapper = source.parentElement
      if (wrapper === null) continue
      const item = wrapper.cloneNode(true) as HTMLElement
      const button = item.querySelector<HTMLButtonElement>('button[role="menuitem"]')
      if (button === null) continue
      const label = text === '归档会话' ? '移动到工作区…' : 'Move to workspace…'
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.nodeValue?.trim() === text) node.nodeValue = node.nodeValue.replace(text, label)
      }
      item.setAttribute(ATTRIBUTE, '')
      button.setAttribute('aria-label', label)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopImmediatePropagation()
        onMove(source)
      })
      items.set(source, item)
      wrapper.before(item)
    }
  }
  const observer = new MutationObserver(() => { frame ??= requestAnimationFrame(sync) })
  sync()
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    items.forEach((item) => item.remove())
    items.clear()
  }
}
