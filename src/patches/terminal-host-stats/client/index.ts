import type { ClientPatch } from '../../../kernel/client/patch.js'
import { callPatchApi } from '../../../platform/dsh/client/api.js'
import { TERMINAL_HOST_STATS_ID, type HostStats } from '../shared.js'
import { installMonitor } from './monitor.js'

export const clientPatch: ClientPatch = {
  id: TERMINAL_HOST_STATS_ID,
  install: (ctx, activation) => {
    ctx.effect(() => {
      let dispose: (() => void) | undefined
      const sync = (): void => {
        if (activation.getSnapshot()[TERMINAL_HOST_STATS_ID]) {
          dispose ??= installMonitor(document, () => callPatchApi<HostStats>(TERMINAL_HOST_STATS_ID, 'sample', {}))
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
