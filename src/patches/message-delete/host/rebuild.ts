import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import { replaySeedRuntimeContext } from '../../../platform/dsh/host/runtime-context.js'
import { rollbackFailedContinuation } from '../../../platform/dsh/host/continuation.js'
import type { MessageDeletionSelection } from './message-selection.js'

function recordedDeletionSeqs(events: readonly SessionEvent[]): Set<number> {
  const deleted = new Set<number>()
  for (const event of events) {
    let values: unknown
    if (event.type === 'user/message') {
      const source = event.data.source as { plugin?: unknown; operation?: unknown; deletedSeqs?: unknown }
      if (source.plugin === PLUGIN_NAME && source.operation === 'delete-message') values = source.deletedSeqs
    } else if (event.type === 'assistant/message') {
      const replay = event.data.message.source.replayState as {
        dshMoreMessageDelete?: { operation?: unknown; deletedSeqs?: unknown }
      } | undefined
      const metadata = replay?.dshMoreMessageDelete
      if (metadata?.operation === 'delete-message') values = metadata.deletedSeqs
    }
    if (Array.isArray(values)) for (const seq of values) if (Number.isSafeInteger(seq) && seq >= 0) deleted.add(seq as number)
    if (values !== undefined) deleted.add(event.seq)
  }
  return deleted
}

/** Rebuild only the surviving model surface into ordinary, balanced turns and steps. */
export function buildCleanSeed(source: Session, selection: MessageDeletionSelection): readonly SessionEvent[] {
  const deleted = recordedDeletionSeqs(source.snapshotEvents())
  for (const seq of selection.shadowedSeqs) deleted.add(seq)
  const survivors = source.surface.nodes
    .filter((seq) => !deleted.has(seq))
    .map((seq) => source.eventAt(seq))
    .filter((event): event is SessionEvent => event !== undefined && source.deriveEventMessage(event) !== null)

  const rebuilt = Session.create(SessionId(`session-rebuild-${randomUUID()}`))
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let assistantSeen = false
  const loggedCalls = new Set<ToolCallId>()

  const closeStep = (): void => {
    if (!stepOpen) return
    rebuilt.append('step/end', { turn, step })
    stepOpen = false
    assistantSeen = false
    loggedCalls.clear()
  }
  const closeTurn = (): void => {
    if (!turnOpen) return
    closeStep()
    rebuilt.append('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }
  const openStep = (): void => {
    if (!turnOpen) {
      turn += 1
      step = 0
      rebuilt.append('turn/start', { turn })
      turnOpen = true
    }
    if (!stepOpen) {
      step += 1
      rebuilt.append('step/start', { turn, step })
      stepOpen = true
    }
  }

  for (const event of survivors) {
    if (event.type === 'user/message' && event.data.source.kind === 'user' && turnOpen) closeTurn()
    if (event.type === 'assistant/message' && assistantSeen) closeStep()
    openStep()
    if (event.type === 'user/message') {
      rebuilt.append('user/message', event.data, { surfaceOp: 'append' })
      continue
    }
    if (event.type === 'assistant/message') {
      rebuilt.append('assistant/message', {
        turn,
        step,
        message: event.data.message,
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      }, { surfaceOp: 'append' })
      assistantSeen = true
      for (const call of event.data.message.content) {
        if (call.type !== 'tool-call') continue
        rebuilt.append('tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments })
        loggedCalls.add(call.id)
      }
      continue
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId
      if (!loggedCalls.has(callId)) {
        rebuilt.append('tool/call', { turn, step, callId: event.data.message.source.callId, name: 'restored-tool', arguments: '{}' })
        loggedCalls.add(callId)
      }
      rebuilt.append('tool/result', { turn, step, message: event.data.message, ...event.data.error === undefined ? {} : { error: event.data.error }, ...event.data.meta === undefined ? {} : { meta: event.data.meta } }, { surfaceOp: 'append' })
    }
  }
  closeTurn()
  return rebuilt.snapshotEvents()
}

export async function createDeletedContinuation(
  ctx: Context,
  sourceAgent: Agent,
  selection: MessageDeletionSelection,
  childId = SessionId(`session-${randomUUID()}`),
): Promise<{ sessionId: string }> {
  const source = sourceAgent.session
  const presetId = ctx.sessionProjections.stateOf(source, 'agentPreset') ?? undefined
  const roster = ctx.get('agentPresets')
  const request = source.requestHeader()?.config
  const provider = request?.provider ?? sourceAgent.options.provider
  const model = request?.model ?? sourceAgent.options.model
  const seed = buildCleanSeed(source, selection)
  let firstTurnStarted = false
  let releaseRuntimeContextReplay: (() => void) | undefined
  let releaseStatusWatch: (() => void) | undefined
  const releaseReplay = (): void => {
    const releaseContext = releaseRuntimeContextReplay
    const releaseStatus = releaseStatusWatch
    releaseRuntimeContextReplay = undefined
    releaseStatusWatch = undefined
    releaseContext?.()
    releaseStatus?.()
  }
  const child = await ctx.agents.create({
    sessionId: childId,
    seed,
    // Rebuilt events are renumbered child-owned history, not a verbatim parent prefix.
    inheritedEventCount: SessionLogOffset(0),
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: source.id,
      isSeeded: false,
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    },
    agentOptions: {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(sourceAgent.options.maxTokens === undefined ? {} : { maxTokens: sourceAgent.options.maxTokens }),
    },
    setup: (agentCtx: Context) => {
      roster?.composeFrom(agentCtx, sourceAgent.ctx)
      releaseRuntimeContextReplay = replaySeedRuntimeContext(agentCtx, seed)
      releaseStatusWatch = agentCtx.on('agent/status', ({ status }) => {
        if (status === 'running') firstTurnStarted = true
        else if (firstTurnStarted) releaseReplay()
      })
    },
  })
  const workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(source.id))
  let attached = false
  try {
    if (workspace !== undefined) {
      await workspace.attachSession(childId)
      attached = true
    }
    await ctx.workspaceRegistry.archiveSession(source.id)
    return { sessionId: childId }
  } catch (error) {
    releaseReplay()
    return rollbackFailedContinuation(child, workspace, attached, error)
  }
}
