import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { requireIdleAgent, requireLiveSession, runAgentMaintenance } from '../../../platform/dsh/host/agent-session.js'
import { createConfirmationToken, verifyConfirmationToken, type ConfirmationFacts } from '../../../platform/dsh/host/confirmation.js'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { requireInteger, requireString } from '../../../platform/dsh/host/wire.js'
import { MESSAGE_EDIT_PATCH_ID, type MessageEditPreview } from '../shared.js'
import { createEditedContinuation, inspectEditCut, type EditCut } from './edit-continuation.js'

function facts(sessionId: string, session: Session, cut: EditCut, continuationSessionId: string): ConfirmationFacts {
  return {
    sessionId,
    startTurn: cut.turn,
    endTurn: cut.turn,
    logRevision: session.seq,
    replaceGeneration: session.surface.replaceGeneration,
    shadowedSeqs: [cut.turnStartSeq, Math.max(cut.turnStartSeq, session.seq - 1)],
    operation: 'edit-message',
    targetSeq: cut.targetSeq,
    contentDigest: cut.contentDigest,
    continuationSessionId,
  }
}

function preview(ctx: Context, secret: Uint8Array, payload: unknown): MessageEditPreview {
  const sessionId = requireString(payload, 'sessionId')
  const session = requireLiveSession(ctx, sessionId)
  const cut = inspectEditCut(session, requireInteger(payload, 'targetSeq'), requireString(payload, 'text'))
  const continuationSessionId = `session-${randomUUID()}`
  return {
    turn: cut.turn,
    laterTurnCount: cut.laterTurnCount,
    continuationSessionId,
    confirmToken: createConfirmationToken(secret, facts(sessionId, session, cut, continuationSessionId)),
  }
}

async function commit(ctx: Context, secret: Uint8Array, payload: unknown): Promise<{ sessionId: string }> {
  const sessionId = requireString(payload, 'sessionId')
  const session = requireLiveSession(ctx, sessionId)
  const agent = requireIdleAgent(ctx, sessionId, session)
  return runAgentMaintenance(agent, async (signal) => {
    signal.throwIfAborted()
    const text = requireString(payload, 'text')
    const cut = inspectEditCut(session, requireInteger(payload, 'targetSeq'), text)
    const continuationSessionId = requireString(payload, 'continuationSessionId')
    verifyConfirmationToken(secret, requireString(payload, 'confirmToken'), facts(sessionId, session, cut, continuationSessionId))
    const result = await createEditedContinuation(ctx, agent, cut, text, SessionId(continuationSessionId))
    signal.throwIfAborted()
    return result
  })
}

export const hostPatch: HostPatch = {
  id: MESSAGE_EDIT_PATCH_ID,
  routes: ({ ctx, confirmationSecret }) => ({
    preview: (payload) => preview(ctx, confirmationSecret, payload),
    commit: (payload) => commit(ctx, confirmationSecret, payload),
  }),
}
