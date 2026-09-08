import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { completedTurns } from '../../../platform/dsh/host/session-history.js'
import { replaySeedRuntimeContext } from '../../../platform/dsh/host/runtime-context.js'
import { rollbackFailedContinuation } from '../../../platform/dsh/host/continuation.js'
import { DshMoreError } from '../../../platform/dsh/host/error.js'

export interface EditCut {
  targetSeq: SessionSeq
  turn: number
  turnStartSeq: SessionSeq
  laterTurnCount: number
  contentDigest: string
}

export function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function editedContent(original: readonly ContentBlock[], text: string): ContentBlock[] {
  const kept = original.filter((block) => block.type !== 'text')
  return [{ type: 'text', text }, ...kept]
}

export function inspectEditCut(session: Session, targetSeq: number, editedText: string): EditCut {
  if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) throw new DshMoreError('bad-request', '消息序号无效。')
  const text = editedText.trim()
  if (text === '') throw new DshMoreError('bad-request', '编辑后的消息不能为空。')
  if (text.length > 100_000) throw new DshMoreError('bad-request', '编辑后的消息过长。')
  const event = session.eventAt(SessionSeq(targetSeq))
  if (event?.type !== 'user/message' || event.data.source.kind !== 'user' || event.surfaceOp !== 'append') {
    throw new DshMoreError('bad-request', '只能编辑普通用户消息。')
  }
  const turns = completedTurns(session.snapshotEvents())
  const owning = turns.find((turn) => targetSeq >= turn.startSeq && targetSeq <= turn.endSeq)
  if (owning === undefined) throw new DshMoreError('invalid-turn-range', '这条消息所属轮次尚未完成。', 409)
  return {
    targetSeq: event.seq,
    turn: owning.turn,
    turnStartSeq: owning.startSeq,
    laterTurnCount: turns.filter((turn) => turn.turn >= owning.turn).length,
    contentDigest: textDigest(text),
  }
}

function sourceMessage(session: Session, targetSeq: SessionSeq): Extract<SessionEvent, { type: 'user/message' }> {
  const event = session.eventAt(targetSeq)
  if (event?.type !== 'user/message') throw new DshMoreError('bad-request', '用户消息不存在。')
  return event
}

export async function createEditedContinuation(
  ctx: Context,
  sourceAgent: Agent,
  cut: EditCut,
  editedText: string,
  childId = SessionId(`session-${randomUUID()}`),
): Promise<{ sessionId: string }> {
  const source = sourceAgent.session
  const original = sourceMessage(source, cut.targetSeq)
  const presetId = ctx.sessionProjections.stateOf(source, 'agentPreset') ?? undefined
  const roster = ctx.get('agentPresets')
  const request = source.requestHeader()?.config
  // rc.1 guarantees seq === log index even when the model surface has gaps.
  // The gap immediately before this turn has the same numeric position.
  const seed = source.snapshotEvents(SessionLogOffset(0), SessionLogOffset(cut.turnStartSeq))
  let releaseRuntimeContextReplay: (() => void) | undefined
  const releaseReplay = (): void => {
    const release = releaseRuntimeContextReplay
    releaseRuntimeContextReplay = undefined
    release?.()
  }
  const child = await ctx.agents.create({
    sessionId: childId,
    seed,
    inheritedEventCount: SessionLogOffset(seed.length),
    meta: {
      ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
      parentSession: source.id,
      isSeeded: true,
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    },
    agentOptions: {
      ...((request?.provider ?? sourceAgent.options.provider) === undefined ? {} : { provider: request?.provider ?? sourceAgent.options.provider }),
      ...((request?.model ?? sourceAgent.options.model) === undefined ? {} : { model: request?.model ?? sourceAgent.options.model }),
      ...(sourceAgent.options.maxTokens === undefined ? {} : { maxTokens: sourceAgent.options.maxTokens }),
    },
    setup: (agentCtx: Context) => {
      // A rollback continues the source Agent's exact live composition. Mounting
      // again by id can select a different preset generation.
      roster?.composeFrom(agentCtx, sourceAgent.ctx)
      // Make every assembly in the edited turn match the snapshot already in the
      // seed. DSH then observes no runtime-context delta and appends no new
      // @deepseek-ai/dsh-system-prompt message. Later turns use live contexts.
      releaseRuntimeContextReplay = replaySeedRuntimeContext(agentCtx, seed)
    },
  })
  const workspace = ctx.workspaceRegistry.list().find((candidate) => candidate.sessionIds.includes(source.id))
  let attached = false
  try {
    if (workspace !== undefined) {
      await workspace.attachSession(childId)
      attached = true
    }
    child.agent.followup(createUserMessage({
      content: editedContent(original.data.content, editedText.trim()),
      source: { kind: 'user' },
    }))
    void child.agent.whenIdle().then(releaseReplay, releaseReplay)
    // Archive is the final publication step: no later synchronous operation can
    // fail and leave the source hidden behind an unusable continuation.
    await ctx.workspaceRegistry.archiveSession(source.id)
    return { sessionId: childId }
  } catch (error) {
    releaseReplay()
    return rollbackFailedContinuation(child, workspace, attached, error)
  }
}
