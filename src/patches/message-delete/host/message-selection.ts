import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { isAppendSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'
import { DshMoreError } from '../../../platform/dsh/host/error.js'

export interface MessageDeletionSelection {
  targetSeq: number
  shadowedSeqs: readonly number[]
}

function assertDeletableTarget(session: Session, seq: number): void {
  const event = session.events[seq]
  if (event?.type === 'user/message' && isAppendSurfaceEvent(event) && event.data.source.kind === 'user') return
  if (event?.type === 'assistant/message' && isAppendSurfaceEvent(event)) return
  throw new DshMoreError('bad-request', '只能删除仍在当前上下文中的用户消息或助手消息。')
}

/** Expand only as far as needed to keep tool call/result pairing valid. */
export function selectMessageDeletion(session: Session, targetSeq: number): MessageDeletionSelection {
  if (!Number.isSafeInteger(targetSeq) || targetSeq < 0) throw new DshMoreError('bad-request', '消息序号无效。')
  const nodes = [...session.surface.nodes]
  const targetIndex = nodes.indexOf(targetSeq)
  if (targetIndex < 0) throw new DshMoreError('selection-empty', '这条消息已经不在当前模型上下文中。')
  assertDeletableTarget(session, targetSeq)
  let startIndex = targetIndex
  let endIndex = targetIndex
  while (!toolPairingBalancedBefore(session, nodes[startIndex] as number)) {
    startIndex -= 1
    if (startIndex < 0) throw new DshMoreError('invalid-turn-range', '无法找到安全的工具调用起点。')
  }
  while (!toolPairingBalancedAfter(session, nodes[endIndex] as number)) {
    endIndex += 1
    if (endIndex >= nodes.length) throw new DshMoreError('invalid-turn-range', '工具调用仍未结束，暂时不能删除这条消息。')
  }
  const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)
  if (shadowedSeqs.length === 0) throw new DshMoreError('selection-empty', '没有可删除的上下文节点。')
  return { targetSeq, shadowedSeqs }
}
