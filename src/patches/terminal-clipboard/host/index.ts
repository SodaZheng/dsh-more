import type { HostPatch } from '../../../kernel/host/patch.js'
import { TERMINAL_CLIPBOARD_PATCH_ID } from '../shared.js'

// Clipboard contents remain in the browser; no Host clipboard or shell access.
export const hostPatch: HostPatch = {
  id: TERMINAL_CLIPBOARD_PATCH_ID,
  routes: () => ({ status: () => ({ available: true }) }),
}
