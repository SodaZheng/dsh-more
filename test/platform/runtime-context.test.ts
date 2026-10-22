import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { replaySeedRuntimeContext } from '../../src/platform/dsh/host/runtime-context.js'

async function replay(sources: unknown[]) {
  const ctx = new Context()
  const session = Session.create(SessionId('runtime-context-compat'))
  for (const source of sources) session.append('user/message', createUserMessage({
    source: source as MessageSource, content: [{ type: 'text', text: 'snapshot' }],
  }), { surfaceOp: 'append' })
  let listener: Function | undefined
  const release = replaySeedRuntimeContext({ on: (_name: string, handler: Function) => {
    listener = handler
    return () => { listener = undefined }
  } } as unknown as Context, session.snapshotEvents())
  try {
    return await listener!({}, {}, async () => ({ sections: [], contexts: [{ name: 'live', text: 'changed' }], tools: [], variables: {} }))
  } finally { release(); await ctx.fiber.dispose() }
}

const sections = [{ name: 'sandbox:policy', text: 'retained policy' }]
describe('runtime context source compatibility', () => {
  it.each([
    { kind: 'runtime-context' },
    { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
  ])('retains a snapshot from %j', async (source) => {
    expect((await replay([{ ...source, form: 'snapshot', sections }])).contexts).toEqual(sections)
  })
  it('honors the latest alpha cleared snapshot instead of reviving an older policy', async () => {
    expect((await replay([
      { kind: 'runtime-context', form: 'snapshot', sections },
      { kind: 'runtime-context', form: 'snapshot', sections: [] },
    ])).contexts).toEqual([])
  })
  it('does not treat user or unrelated producer snapshots as runtime policy', async () => {
    expect((await replay([{ kind: 'user', form: 'snapshot', sections }])).contexts).toEqual([])
  })
})
