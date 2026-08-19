import { DshMoreError } from '../../../platform/dsh/host/error.js'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { requireString } from '../../../platform/dsh/host/wire.js'
import { SESSION_DELETE_PATCH_ID } from '../shared.js'
import { installLiveSessionHandleTracker } from './live-session-handles.js'
import { deleteSessionPermanently } from './session-deletion.js'

export const hostPatch: HostPatch = {
  id: SESSION_DELETE_PATCH_ID,
  setup: installLiveSessionHandleTracker,
  routes: ({ ctx }) => ({
    commit: async (payload) => {
      const sessionId = requireString(payload, 'sessionId')
      if (requireString(payload, 'confirmSessionId') !== sessionId) {
        throw new DshMoreError('bad-request', '会话删除确认不匹配。')
      }
      return deleteSessionPermanently(ctx, sessionId)
    },
  }),
}
