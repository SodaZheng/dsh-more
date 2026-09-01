import type { HostPatch } from '../../../kernel/host/patch.js'
import { CONVERSATION_QUICK_NAVIGATION_PATCH_ID } from '../shared.js'

export const hostPatch: HostPatch = {
  id: CONVERSATION_QUICK_NAVIGATION_PATCH_ID,
  routes: () => ({
    status: () => ({ available: true }),
  }),
}
