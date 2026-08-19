import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface CompletedTurn {
  turn: number
  startSeq: number
  endSeq: number
}

/** Return only turns with a durable start/end pair, in log order. */
export function completedTurns(events: readonly SessionEvent[]): CompletedTurn[] {
  const starts = new Map<number, number>()
  const turns: CompletedTurn[] = []
  for (const event of events) {
    if (event.type === 'turn/start') {
      starts.set(event.data.turn, event.seq)
      continue
    }
    if (event.type !== 'turn/end') continue
    const startSeq = starts.get(event.data.turn)
    if (startSeq !== undefined) turns.push({ turn: event.data.turn, startSeq, endSeq: event.seq })
  }
  return turns.sort((left, right) => left.startSeq - right.startSeq)
}
