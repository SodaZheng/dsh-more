import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, createUserMessage, createAssistantMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { addTurn, appendRuntimeContext } from '../../../test/helpers/session.js'
import { generateSuggestion, parseSuggestion, suggestionContext } from './host/generate.js'
import { createSuggestionService, hostPatch } from './host/index.js'

async function* response(text = '帮我补充输入框的交互测试'): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('suggestion generation', () => {
  it.each(['NONE', '', '第一行\n第二行', '字'.repeat(121), '```json', '建议：继续', '隐藏\u200b内容'])(
    'does not expose invalid or empty suggestions: %s', (text) => expect(parseSuggestion(text)).toBeNull(),
  )
  it('uses only completed visible text, with bounded dialogue and no tools', async () => {
    const history = Array.from({ length: 12 }, (_, index) => index % 2 === 0
      ? createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `task ${index} ${'x'.repeat(8000)}` }] })
      : createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: `reply ${index}` }] }))
    const context = suggestionContext(history)
    expect(context).toHaveLength(6)
    expect(context[0]?.text).toContain('task 0')
    expect(context.at(-1)?.text).toBe('reply 11')
    expect(JSON.stringify(context).length).toBeLessThan(13_000)
    const stream = vi.fn((_options: GenerateOptions) => response())
    expect(await generateSuggestion(stream, { provider: 'test', model: 'test' }, context, new AbortController().signal)).toBe('帮我补充输入框的交互测试')
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ provider: 'test', model: 'test', maxTokens: 2048 })
    expect(stream.mock.calls[0]?.[0].tools).toBeUndefined()
  })
  it('discards truncated or failed output and checks cancellation before dispatch', async () => {
    const partial = async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '继续测试' } }
    }
    expect(await generateSuggestion(partial, { provider: 'a', model: 'b' }, [], new AbortController().signal)).toBeNull()
    const stream = vi.fn(() => response())
    await expect(generateSuggestion(stream, { provider: 'a', model: 'b' }, [], AbortSignal.abort())).rejects.toThrow()
    expect(stream).not.toHaveBeenCalled()
  })
})

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

async function fixture(stream = vi.fn((_options: GenerateOptions) => response())) {
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  class Adapter extends LlmAdapter { stream = stream }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const session = ctx.sessions.create()
  const agent = { id: session.id, session, ctx, status: 'idle', options: { provider: 'test', model: 'model-a' } }
  ctx.agents.register(agent as never)
  addTurn(session, 1, '给输入框增加提示')
  appendRuntimeContext(session, 'not user-visible')
  const service = createSuggestionService(ctx)
  disposers.push(service.dispose)
  return { ctx, session, agent, service, stream }
}

describe('suggestion host lifecycle', () => {
  it('deduplicates calls, keeps history untouched, excludes runtime context, and follows model changes', async () => {
    const { session, agent, service, stream } = await fixture()
    const before = session.seq
    const payload = { sessionId: session.id }
    const results = await Promise.all([service.suggest(payload), service.suggest(payload)])
    expect(results).toEqual([{ suggestion: '帮我补充输入框的交互测试' }, { suggestion: '帮我补充输入框的交互测试' }])
    await service.suggest(payload)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(session.seq).toBe(before)
    expect(JSON.stringify(stream.mock.calls[0]?.[0].messages)).not.toContain('not user-visible')
    agent.options.model = 'model-b'
    await service.suggest(payload)
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[1]?.[0].model).toBe('model-b')
  })
  it('rejects invalid, missing, and running sessions before using model quota', async () => {
    const { session, agent, service, stream } = await fixture()
    await expect(service.suggest({})).rejects.toThrow('sessionId')
    await expect(service.suggest({ sessionId: 'missing' })).rejects.toThrow('打开')
    agent.status = 'running'
    await expect(service.suggest({ sessionId: session.id })).rejects.toThrow('空闲')
    expect(stream).not.toHaveBeenCalled()
  })
  it('discards output if dialogue changes while the model is responding', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const stream = vi.fn(async function* (_options: GenerateOptions) { await gate; yield* response('旧的下一步') })
    const { session, service } = await fixture(stream)
    const pending = service.suggest({ sessionId: session.id })
    await vi.waitFor(() => expect(stream).toHaveBeenCalled())
    addTurn(session, 2, '我改主意了')
    finish()
    expect(await pending).toEqual({ suggestion: null })
  })
  it('aborts in-flight work on disable, and enables again with a fresh service', async () => {
    const stream = vi.fn(async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      yield* response()
    })
    const { ctx, session, service } = await fixture(stream)
    service.dispose()
    const disable = hostPatch.setup!(ctx)
    const route = hostPatch.routes({ ctx, confirmationSecret: new Uint8Array() }).suggest!
    await vi.waitFor(() => expect(ctx.registry.size).toBeGreaterThan(3))
    const pending = route({ sessionId: session.id })
    await vi.waitFor(() => expect(stream).toHaveBeenCalled())
    disable()
    expect(await pending).toEqual({ suggestion: null })
    expect(stream.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    expect(await route({ sessionId: session.id })).toEqual({ suggestion: null })
    stream.mockImplementation(() => response('检查刚才修改的效果'))
    const disableAgain = hostPatch.setup!(ctx)
    disposers.push(disableAgain)
    await vi.waitFor(async () => expect(await route({ sessionId: session.id })).toEqual({ suggestion: '检查刚才修改的效果' }))
  })
})
