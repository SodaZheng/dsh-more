import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import { createMessageSurfaceSelector } from '../../src/platform/dsh/client/message-targets.js'

function snapshot(order: readonly string[], entries: ReadonlyMap<string, object>): ConversationSnapshot {
  return {
    chat: {
      order,
      nodes: {
        get: (key: string) => entries.get(key),
        values: () => [...entries.values()],
      },
    },
  } as unknown as ConversationSnapshot
}

describe('message target surface selector', () => {
  it('retains its snapshot across unrelated streaming-node changes', () => {
    const user = {
      key: 'user',
      kind: 'user',
      data: { seq: 1, content: [{ type: 'text', text: 'hello' }] },
    }
    const select = createMessageSurfaceSelector()
    const first = select(snapshot(['user', 'stream'], new Map<string, object>([
      ['user', user],
      ['stream', { key: 'stream', kind: 'assistant-stream', data: { delta: 'a' } }],
    ])))
    const second = select(snapshot(['user', 'stream'], new Map<string, object>([
      ['user', user],
      ['stream', { key: 'stream', kind: 'assistant-stream', data: { delta: 'ab' } }],
    ])))

    expect(second).toBe(first)
    expect(second.byKey.get('user')?.action).toEqual({ seq: 1, kind: 'user', text: 'hello' })
  })

  it('publishes only when a relevant completed-message fact changes', () => {
    const select = createMessageSurfaceSelector()
    const first = select(snapshot(['tail'], new Map<string, object>([
      ['tail', {
        key: 'tail',
        kind: 'turn-tail',
        data: { closing: { finalNode: { seq: 9 }, blocks: [{ kind: 'text', text: 'done' }] } },
      }],
    ])))
    const same = select(snapshot(['tail'], new Map<string, object>([
      ['tail', {
        key: 'tail',
        kind: 'turn-tail',
        data: { tokensPerSecond: 20, closing: { finalNode: { seq: 9 }, blocks: [{ kind: 'text', text: 'done' }] } },
      }],
    ])))
    const changed = select(snapshot(['tail'], new Map<string, object>([
      ['tail', {
        key: 'tail',
        kind: 'turn-tail',
        data: { closing: { finalNode: { seq: 9 }, blocks: [{ kind: 'text', text: 'updated' }] } },
      }],
    ])))

    expect(same).toBe(first)
    expect(changed).not.toBe(first)
    expect(changed.byKey.get('tail')?.action).toEqual({ seq: 9, kind: 'assistant', text: 'updated' })
  })

  it('stays empty while every message action patch is disabled', () => {
    const select = createMessageSurfaceSelector(false)
    const first = select(snapshot([], new Map()))
    const second = select(snapshot(['user'], new Map<string, object>([
      ['user', { key: 'user', kind: 'user', data: { seq: 1, content: [] } }],
    ])))
    expect(second).toBe(first)
    expect(second.rows).toEqual([])
  })
})
