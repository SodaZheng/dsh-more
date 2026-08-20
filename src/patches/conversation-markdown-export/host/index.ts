import type { HostPatch } from '../../../kernel/host/patch.js'
import { requireIdleAgent, requireLiveSession } from '../../../platform/dsh/host/agent-session.js'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { requireString } from '../../../platform/dsh/host/wire.js'
import { CONVERSATION_MARKDOWN_EXPORT_PATCH_ID } from '../shared.js'
import { conversationMarkdown } from './transcript.js'

const MAX_TITLE_LENGTH = 500

function render(ctx: Parameters<HostPatch['routes']>[0]['ctx'], payload: unknown) {
  const sessionId = requireString(payload, 'sessionId')
  const title = requireString(payload, 'title')
  if ([...title].length > MAX_TITLE_LENGTH) throw new DshMoreError('bad-request', '会话标题过长。')
  const session = requireLiveSession(ctx, sessionId)
  requireIdleAgent(ctx, sessionId, session)
  return conversationMarkdown(session.events, { title, sessionId })
}

export const hostPatch: HostPatch = {
  id: CONVERSATION_MARKDOWN_EXPORT_PATCH_ID,
  routes: ({ ctx }) => ({
    render: (payload) => render(ctx, payload),
  }),
}
