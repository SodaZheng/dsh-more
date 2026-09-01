import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { contentText } from '../../../platform/dsh/client/message-content.js'

const MAX_LABEL_CODE_POINTS = 72

export interface ConversationTurnSummary {
  key: string
  seq: number
  label: string
}

interface ConversationTurnCandidate {
  kind?: unknown
  data?: {
    seq?: unknown
    content?: unknown
  }
}

export interface TurnPosition {
  key: string
  top: number
}

export interface AutoLoadOlderState {
  enabled: boolean
  surfaceAvailable: boolean
  hasMore: boolean
  loadingOlder: boolean
  paused: boolean
}

function conciseLabel(content: readonly ContentBlock[], fallbackIndex: number): string {
  const text = contentText(content)
  if (text === '') return `第 ${String(fallbackIndex)} 轮 · 非文本消息`
  const codePoints = [...text]
  if (codePoints.length <= MAX_LABEL_CODE_POINTS) return text
  return `${codePoints.slice(0, MAX_LABEL_CODE_POINTS - 1).join('')}…`
}

function turnSummary(node: unknown, key: string, index: number): ConversationTurnSummary | null {
  const candidate = node as ConversationTurnCandidate | undefined
  if (candidate?.kind !== 'user' && candidate?.kind !== 'steering') return null
  if (!Number.isSafeInteger(candidate.data?.seq) || !Array.isArray(candidate.data?.content)) return null
  return {
    key,
    seq: candidate.data.seq as number,
    label: conciseLabel(candidate.data.content as readonly ContentBlock[], index),
  }
}

function sameTurns(left: readonly ConversationTurnSummary[], right: readonly ConversationTurnSummary[]): boolean {
  return left.length === right.length && left.every((turn, index) => {
    const other = right[index]
    return other !== undefined
      && turn.key === other.key
      && turn.seq === other.seq
      && turn.label === other.label
  })
}

/** Select stable user-authored turn summaries without observing assistant streaming frames. */
export function createConversationTurnSelector(): (snapshot: ConversationSnapshot) => readonly ConversationTurnSummary[] {
  let previousOrder: readonly string[] | undefined
  let previous: readonly ConversationTurnSummary[] = []
  return (snapshot) => {
    if (snapshot.chat.order === previousOrder) return previous
    previousOrder = snapshot.chat.order
    const next: ConversationTurnSummary[] = []
    for (const key of snapshot.chat.order) {
      const summary = turnSummary(snapshot.chat.nodes.get(key), key, next.length + 1)
      if (summary !== null) next.push(summary)
    }
    if (!sameTurns(previous, next)) previous = next
    return previous
  }
}

/** Stable evidence that an older history page prepended visible conversation material. */
export function historyWindowSignature(snapshot: ConversationSnapshot): string {
  const first = snapshot.chat.order[0] ?? ''
  const last = snapshot.chat.order.at(-1) ?? ''
  return `${first}\u0000${last}\u0000${String(snapshot.chat.order.length)}`
}

export function shouldAutoLoadOlder(state: AutoLoadOlderState): boolean {
  return state.enabled
    && state.surfaceAvailable
    && state.hasMore
    && !state.loadingOlder
    && !state.paused
}

/** Pick the last turn at or above the reading line, falling back to the first turn. */
export function activeTurnAt(positions: readonly TurnPosition[], readingLine: number): string | null {
  let active = positions[0]?.key ?? null
  for (const position of positions) {
    if (position.top > readingLine) break
    active = position.key
  }
  return active
}

/** Translate a row's viewport coordinate into a bounded scrollport offset. */
export function scrollOffsetForRow(
  currentScrollTop: number,
  scrollportTop: number,
  rowTop: number,
  topInset = 20,
): number {
  return Math.max(0, currentScrollTop + rowTop - scrollportTop - topInset)
}
