import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { messageDeleteProjection } from './host/projection.js'

function deletionEvent(seq: number, deletedSeqs: number[], plugin = 'dsh-more'): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 100 + seq,
    data: {
      id: `message-${String(seq)}`,
      role: 'user',
      content: [{ type: 'text', text: 'deleted' }],
      source: {
        kind: 'plugin',
        plugin,
        operation: 'delete-message',
        deletedSeqs,
      },
    },
    surfaceOp: { op: 'replace', start: deletedSeqs[0] as number, end: deletedSeqs.at(-1) as number },
    sourceEventSeqs: deletedSeqs,
  } as unknown as SessionEvent
}

describe('message-delete projection', () => {
  it('folds durable replacement metadata into stable deleted seqs', () => {
    const initial = messageDeleteProjection.init()
    const first = messageDeleteProjection.apply(initial, deletionEvent(10, [2, 3]))
    const second = messageDeleteProjection.apply(first, deletionEvent(11, [3, 7]))
    expect(messageDeleteProjection.view(second)).toEqual({ deletedSeqs: [2, 3, 7, 10, 11], hiddenTrajectoryKeys: [] })
    const unrelated = { type: 'turn/start', seq: 12, time: 112, data: { turn: 2 } } as unknown as SessionEvent
    expect(messageDeleteProjection.apply(second, unrelated)).toBe(second)
  })

  it('reads deletion metadata from an empty assistant replacement without adding model-visible text', () => {
    const event = {
      type: 'assistant/message',
      seq: 20,
      time: 120,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-20',
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            provider: 'test',
            model: 'test',
            replayState: { dshMoreMessageDelete: { operation: 'delete-message', deletedSeqs: [4] } },
          },
        },
      },
      surfaceOp: { op: 'replace', start: 4, end: 4 },
      sourceEventSeqs: [4],
    } as unknown as SessionEvent
    expect(messageDeleteProjection.apply(messageDeleteProjection.init(), event)).toEqual({
      deletedSeqs: [4, 20],
      hiddenTrajectoryKeys: ['assistant\u00001\u00001'],
    })
  })
})
