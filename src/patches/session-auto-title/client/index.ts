import type { ClientPatch } from '../../../kernel/client/patch.js'
import { SESSION_AUTO_TITLE_PATCH_ID } from '../shared.js'

// The shared settings card owns activation; native title projections update
// list rows. No additional UI, observer, or client-side renaming is needed.
export const clientPatch: ClientPatch = {
  id: SESSION_AUTO_TITLE_PATCH_ID,
  install: () => {},
}
