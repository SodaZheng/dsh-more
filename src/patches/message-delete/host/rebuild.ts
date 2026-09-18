import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
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
  const survivors = new Map<SessionSeq, SessionEvent[]>()
  for (const seq of source.surface.nodes) {
    if (deleted.has(seq)) continue
    const event = source.eventAt(seq)
    if (event === undefined || source.deriveEventMessage(event) === null) continue
    // A replacement is logged later, but still occupies its original position
    // on the model surface (notably the leading system prompt).
    let anchor = event
    while (anchor.surfaceOp !== undefined && anchor.surfaceOp !== 'append') {
      const previous = source.eventAt(anchor.surfaceOp.startSeq)
      if (previous === undefined || previous.seq >= anchor.seq) break
      anchor = previous
    }
    const at = survivors.get(anchor.seq) ?? []
    at.push(event)
    survivors.set(anchor.seq, at)
  }

  const rebuilt = Session.create(SessionId(`session-rebuild-${randomUUID()}`))
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let assistantSeen = false
  const loggedCalls = new Set<ToolCallId>()
  const userSeqs = new Map<SessionSeq, SessionSeq>()
  let sourceTurnOpen = false

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

  for (const entry of source.snapshotEvents()) {
    // These records are durable session configuration, not discarded work.
    // In particular, inbox splices must never be replayed in a clean history.
    if (['permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/model-selection-policy',
      'model/selection', 'request/header', 'request/context', 'agent-preset/selected'].includes(entry.type)) {
      rebuilt.append(entry.type, entry.data)
      continue
    }
    if (entry.type === 'turn/start') {
      closeTurn()
      sourceTurnOpen = true
      continue
    }
    if (entry.type === 'turn/end') {
      closeTurn()
      sourceTurnOpen = false
      continue
    }
    if (entry.type === 'step/end') {
      closeStep()
      continue
    }
    for (const event of survivors.get(entry.seq) ?? []) {
      // Plugin context between turns is not a separate user turn.
      if (event.type === 'user/message' && !sourceTurnOpen && event.data.source.kind !== 'user') {
        rebuilt.append('user/message', event.data, { surfaceOp: 'append' })
        continue
      }
      if (event.type === 'assistant/message' && assistantSeen) closeStep()
      openStep()
      if (event.type === 'system/message') {
        rebuilt.append('system/message', { ...event.data, turn, step }, { surfaceOp: 'append' })
        continue
      }
      if (event.type === 'user/message') {
        const appended = rebuilt.append('user/message', event.data, { surfaceOp: 'append' })
        if (event.data.source.kind === 'user') userSeqs.set(event.seq, appended.seq)
        continue
      }
      if (event.type === 'assistant/message') {
        rebuilt.append('assistant/message', {
          // Keep the durable stream and settlement metadata required by DSH 0.1.5.
          // Only the reconstructed turn/step coordinates belong to the new log.
          ...event.data,
          turn,
          step,
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
  }
  closeTurn()
  const title = source.snapshotEvents().findLast((event) => event.type === 'session/title')
  if (title?.type === 'session/title') {
    const messageSeqs = title.data.messageSeqs.flatMap((seq) => {
      const mapped = userSeqs.get(seq)
      return mapped === undefined ? [] : [mapped]
    })
    if (title.data.source.kind === 'user' || messageSeqs.length > 0) {
      rebuilt.append('session/title', { ...title.data, messageSeqs })
    }
  }
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
      ...((request?.reasoningEffort ?? sourceAgent.options.reasoningEffort) === undefined ? {} : {
        reasoningEffort: request?.reasoningEffort ?? sourceAgent.options.reasoningEffort,
      }),
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
