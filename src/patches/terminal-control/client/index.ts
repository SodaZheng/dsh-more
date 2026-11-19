import type { ClientPatch } from '../../../kernel/client/patch.js'
import { ID } from '../shared.js'
import { mountControl } from './control.js'
import { terminalControlStyles } from './styles.js'

const selector = '[data-sidebar-terminal]'

export function installControls(doc: Document): () => void {
  const style = doc.createElement('style')
  style.textContent = terminalControlStyles
  doc.head.append(style)
  const controls = new Map<HTMLElement, ReturnType<typeof mountControl>>()
  function attach(root: HTMLElement): void {
    if (root.isConnected && !controls.has(root)) controls.set(root, mountControl(root))
  }
  const observer = new MutationObserver(records => {
    for (const [root, control] of controls) {
      if (!root.isConnected) { control.dispose(); controls.delete(root) }
    }
    for (const record of records) {
      if (!(record.target instanceof Element) || record.target.closest('.xterm')) continue
      const terminal = record.target.closest<HTMLElement>(selector)
      if (terminal) { controls.get(terminal)?.check(); continue }
      for (const added of record.addedNodes) {
        if (!(added instanceof HTMLElement)) continue
        if (added.matches(selector)) attach(added)
        else added.querySelectorAll<HTMLElement>(selector).forEach(attach)
      }
    }
  })
  doc.querySelectorAll<HTMLElement>(selector).forEach(attach)
  observer.observe(doc.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    for (const control of controls.values()) control.dispose()
    controls.clear()
    style.remove()
  }
}

export const clientPatch: ClientPatch = {
  id: ID,
  install(ctx, activation) {
    ctx.effect(() => {
      let dispose: (() => void) | undefined
      const sync = () => {
        if (activation.getSnapshot()[ID]) dispose ??= installControls(document)
        else { dispose?.(); dispose = undefined }
      }
      const off = activation.subscribe(sync)
      sync()
      return () => { off(); dispose?.() }
    })
  },
}
