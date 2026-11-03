import type { HostPatch } from '../../../kernel/host/patch.js'
import { TERMINAL_HOST_STATS_ID } from '../shared.js'
import { createSampler } from './sample.js'

export const hostPatch: HostPatch = {
  id: TERMINAL_HOST_STATS_ID,
  routes: () => ({ sample: createSampler() }),
}
