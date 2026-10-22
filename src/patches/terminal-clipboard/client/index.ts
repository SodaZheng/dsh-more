import type { ClientPatch } from '../../../kernel/client/patch.js'
import { TERMINAL_CLIPBOARD_PATCH_ID } from '../shared.js'
import { installTerminalClipboard } from './clipboard.js'

export const clientPatch: ClientPatch = {
  id: TERMINAL_CLIPBOARD_PATCH_ID,
  install: (ctx, activation) => {
    ctx.effect(() => {
      let dispose: (() => void) | undefined
      const sync = (): void => {
        if (activation.getSnapshot()[TERMINAL_CLIPBOARD_PATCH_ID]) {
          dispose ??= installTerminalClipboard(document)
        } else {
          dispose?.()
          dispose = undefined
        }
      }
      const unsubscribe = activation.subscribe(sync)
      sync()
      return () => { unsubscribe(); dispose?.() }
    })
  },
}
