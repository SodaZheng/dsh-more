import type { HostStats } from '../shared.js'
import { createBar } from './bar.js'

const selector = '[data-sidebar-terminal]'

export function installMonitor(doc: Document, sample: () => Promise<HostStats>): () => void {
  const bars = new Map<Element, ReturnType<typeof createBar>>()
  const visible = new Set<Element>()
  let disposed = false
  let pending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const active = () => !disposed && !doc.hidden && visible.size > 0
  const update = async (): Promise<void> => {
    timer = undefined
    if (!active() || pending) return
    pending = true
    let stats: HostStats | null = null
    try { stats = await sample() } catch { /* the next visible tick retries */ }
    pending = false
    if (!active()) return
    for (const root of visible) bars.get(root)?.render(stats, stats === null)
    timer = setTimeout(update, 2000)
  }
  const sync = (): void => {
    if (!active()) {
      clearTimeout(timer)
      timer = undefined
    } else if (!pending && timer === undefined) void update()
  }

  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (bars.has(entry.target) && entry.isIntersecting) visible.add(entry.target)
      else visible.delete(entry.target)
    }
    sync()
  })
  const attach = (root: Element): void => {
    if (bars.has(root) || !root.isConnected) return
    const bar = createBar(doc)
    bars.set(root, bar)
    root.prepend(bar.node)
    visibility.observe(root)
  }
  const discover = (element: Element): void => {
    if (element.matches(selector)) attach(element)
    else element.querySelectorAll(selector).forEach(attach)
  }
  const observer = new MutationObserver((records) => {
    for (const [root, bar] of bars) {
      if (root.isConnected) continue
      visibility.unobserve(root)
      visible.delete(root)
      bars.delete(root)
      bar.node.remove()
    }
    for (const record of records) {
      // xterm continuously updates its rows. No need to scan those subtrees.
      if (record.target instanceof Element && record.target.closest(selector)) continue
      for (const added of record.addedNodes) if (added instanceof Element) discover(added)
    }
    sync()
  })
  discover(doc.body)
  observer.observe(doc.body, { childList: true, subtree: true })
  doc.addEventListener('visibilitychange', sync)
  return () => {
    disposed = true
    clearTimeout(timer)
    doc.removeEventListener('visibilitychange', sync)
    observer.disconnect()
    visibility.disconnect()
    for (const bar of bars.values()) bar.node.remove()
    bars.clear()
    visible.clear()
  }
}
