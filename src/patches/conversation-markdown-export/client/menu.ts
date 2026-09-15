const MENU_ITEM_ATTRIBUTE = 'data-dshmore-markdown-export'
const MORE_BUTTON_SELECTOR = 'button[class*="_moreButton"][aria-haspopup="menu"]'

/** DSH 0.1.5 owns this menu inside session-log-export, without a child slot. */
export function installMarkdownExportMenu(
  fallback: HTMLButtonElement,
  options: { busy: boolean; download: () => void },
): () => void {
  const header = fallback.closest('header')
  if (header === null) return () => {}
  let item: HTMLElement | null = null
  let source: HTMLButtonElement | null = null
  let frame: number | null = null

  const removeItem = (): void => {
    item?.remove()
    item = null
    source = null
  }
  const sync = (): void => {
    frame = null
    const trigger = Array.from(header.querySelectorAll<HTMLButtonElement>(MORE_BUTTON_SELECTOR))
      .find((button) => ['更多操作', 'More actions'].includes(button.getAttribute('aria-label') ?? ''))
    fallback.hidden = trigger !== undefined
    // The native Menu is rendered beside its trigger, within this Session's header.
    const download = trigger?.parentElement?.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    const text = download?.textContent?.trim()
    if (download === undefined || download === null || !['下载 Session 日志', 'Download session log'].includes(text ?? '')) {
      removeItem()
      return
    }
    if (source === download && item?.isConnected === true) return
    removeItem()
    const wrapper = download.parentElement
    if (wrapper === null || wrapper.getAttribute('role') === 'menu') return
    const clone = wrapper.cloneNode(true)
    if (!(clone instanceof HTMLElement)) return
    const button = clone.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (button === null) return
    const label = options.busy ? '正在导出…' : '导出 Markdown'
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue?.trim() === text) node.nodeValue = label
    }
    clone.setAttribute(MENU_ITEM_ATTRIBUTE, '')
    button.disabled = options.busy
    button.setAttribute('aria-busy', String(options.busy))
    button.setAttribute('aria-label', '导出完整聊天记录为 Markdown')
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (options.busy) return
      options.download()
      if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click()
    })
    source = download
    item = clone
    wrapper.after(clone)
  }
  sync()
  const observer = new MutationObserver(() => {
    frame ??= window.requestAnimationFrame(sync)
  })
  observer.observe(header, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-expanded'],
    characterData: true,
  })
  return () => {
    observer.disconnect()
    if (frame !== null) window.cancelAnimationFrame(frame)
    removeItem()
    fallback.hidden = false
  }
}
