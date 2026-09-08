import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
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
    expect(messageDeleteProjection.wire.view(second)).toEqual({ deletedSeqs: [2, 3, 7, 10, 11], hiddenTrajectoryKeys: [] })
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

describe('message-delete rc.1 projection registry', () => {
  it('publishes the wire view, checkpoints host state, and removes the capability on disposal', () => {
    const session = Session.create(SessionId('session-projection-registry'))
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'deleted' }],
      source: { kind: 'plugin', plugin: 'dsh-more', operation: 'delete-message', deletedSeqs: [original.seq] },
    }), { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })
    const registry = new SessionProjectionRegistry(new Context())
    const dispose = registry.register(messageDeleteProjection)
    try {
      const expected = { deletedSeqs: [0, 1], hiddenTrajectoryKeys: [] }
      expect(registry.stateOf(session, 'dshMoreMessageDelete')).toEqual(expected)
      expect(registry.snapshot(session).values.dshMoreMessageDelete).toEqual(expected)
      const checkpoint = registry.checkpoint(session)
      expect(registry.viewCheckpoint(checkpoint).dshMoreMessageDelete).toEqual(expected)
      const state = registry.stateOf(session, 'dshMoreMessageDelete')
      session.append('turn/start', { turn: 1 })
      expect(registry.stateOf(session, 'dshMoreMessageDelete')).toBe(state)
    } finally {
      dispose()
    }
    expect(registry.snapshot(session).values).not.toHaveProperty('dshMoreMessageDelete')
  })

  it('ignores unrelated plugins and malformed deletion metadata without invalidating state', () => {
    const state = messageDeleteProjection.init()
    expect(messageDeleteProjection.apply(state, deletionEvent(3, [1], 'other-plugin'))).toBe(state)
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(messageDeleteProjection.apply(state, deletionEvent(3, [seq]))).toBe(state)
    }
    const event = deletionEvent(3, [1])
    expect(messageDeleteProjection.apply(state, { ...event, seq: SessionSeq(3), surfaceOp: 'append' } as SessionEvent)).toBe(state)
  })
})
