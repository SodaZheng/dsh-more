import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { requireIdleAgent, requireLiveSession, runAgentMaintenance } from '../../../platform/dsh/host/agent-session.js'
import { createConfirmationToken, verifyConfirmationToken, type ConfirmationFacts } from '../../../platform/dsh/host/confirmation.js'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { completedTurns } from '../../../platform/dsh/host/session-history.js'
import { requireInteger, requireString } from '../../../platform/dsh/host/wire.js'
import { MESSAGE_DELETE_PATCH_ID, type MessageDeletePreview } from '../shared.js'
import { selectMessageDeletion, type MessageDeletionSelection } from './message-selection.js'
import { messageDeleteProjection } from './projection.js'
import { createDeletedContinuation } from './rebuild.js'

function targetTurn(session: Session, seq: number): number {
  return completedTurns(session.events).find((turn) => seq >= turn.startSeq && seq <= turn.endSeq)?.turn ?? 0
}

function facts(
  sessionId: string,
  session: Session,
  selection: MessageDeletionSelection,
  continuationSessionId: string,
): ConfirmationFacts {
  const turn = targetTurn(session, selection.targetSeq)
  return {
    sessionId,
    startTurn: turn,
    endTurn: turn,
    logRevision: session.seq,
    replaceGeneration: session.surface.replaceGeneration,
    shadowedSeqs: selection.shadowedSeqs,
    operation: 'delete-message',
    targetSeq: selection.targetSeq,
    continuationSessionId,
  }
}

function preview(ctx: Context, secret: Uint8Array, payload: unknown): MessageDeletePreview {
  const sessionId = requireString(payload, 'sessionId')
  const session = requireLiveSession(ctx, sessionId)
  const selection = selectMessageDeletion(session, requireInteger(payload, 'targetSeq'))
  const continuationSessionId = `session-${randomUUID()}`
  return {
    affectedNodeCount: selection.shadowedSeqs.length,
    continuationSessionId,
    confirmToken: createConfirmationToken(secret, facts(sessionId, session, selection, continuationSessionId)),
  }
}

async function commit(ctx: Context, secret: Uint8Array, payload: unknown): Promise<{
  sessionId: string
  deletedSeqs: readonly number[]
}> {
  const sessionId = requireString(payload, 'sessionId')
  const session = requireLiveSession(ctx, sessionId)
  const agent = requireIdleAgent(ctx, sessionId, session)
  return runAgentMaintenance(agent, async (signal) => {
    signal.throwIfAborted()
    const selection = selectMessageDeletion(session, requireInteger(payload, 'targetSeq'))
    const continuationSessionId = requireString(payload, 'continuationSessionId')
    verifyConfirmationToken(secret, requireString(payload, 'confirmToken'), facts(sessionId, session, selection, continuationSessionId))
    const child = await createDeletedContinuation(ctx, agent, selection, SessionId(continuationSessionId))
    signal.throwIfAborted()
    return { sessionId: child.sessionId, deletedSeqs: selection.shadowedSeqs }
  })
}

export const hostPatch: HostPatch = {
  id: MESSAGE_DELETE_PATCH_ID,
  setup: (ctx) => ctx.effect(
    () => ctx.sessionProjections.register(messageDeleteProjection),
    `${MESSAGE_DELETE_PATCH_ID}: projection`,
  ),
  routes: ({ ctx, confirmationSecret }) => ({
    preview: (payload) => preview(ctx, confirmationSecret, payload),
    commit: (payload) => commit(ctx, confirmationSecret, payload),
  }),
}
