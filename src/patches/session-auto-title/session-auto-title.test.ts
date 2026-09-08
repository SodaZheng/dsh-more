import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionTitleService, SessionTitleProviderId, type SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import { generateTitle, parseTitle, type TitleStream } from './host/generate.js'
import { hostPatch } from './host/index.js'

function request(): SessionTitleProviderRequest {
  return {
    session: Session.create(SessionId('title-test')),
    messages: [{ seq: SessionSeq(1), text: '帮我修复会话切换闪烁' }],
    route: { provider: 'test', model: 'test-model' },
    signal: new AbortController().signal,
  }
}

async function* response(title = '修复 · 会话切换时页面闪烁'): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: title }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('title generation', () => {
  it('uses the current route and an auxiliary call, with exact source attribution', async () => {
    const stream = vi.fn((_options: GenerateOptions) => response())
    expect(await generateTitle(stream, request())).toEqual({
      title: '修复 · 会话切换时页面闪烁', messageSeqs: [1], model: request().route,
    })
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      provider: 'test', model: 'test-model', purpose: 'session-title', sessionId: 'title-test', maxTokens: 1024,
    })
  })

  it.each(['随便起名', '完成 · 修好了', '修复 · ', '修复 · 一行\n还有一行', '修复 · **闪烁**', `开发 · ${'字'.repeat(40)}`, '修复 · 隐藏\u200b字符'])(
    'rejects invalid model output: %s', (text) => { expect(() => parseTitle(text)).toThrow() },
  )

  it('bounds input while attributing the first and latest messages', async () => {
    let options: GenerateOptions | undefined
    const stream: TitleStream = (value) => { options = value; return response() }
    const input = { ...request(), messages: Array.from({ length: 20 }, (_, index) => ({ seq: SessionSeq(index + 1), text: 'x'.repeat(10_000) })) }
    const result = await generateTitle(stream, input)
    expect(result.messageSeqs).toEqual([1, 18, 19, 20])
    expect(JSON.stringify(options?.messages).length).toBeLessThan(13_000)
  })

  it('rejects incomplete or failed streams even when text looks valid', async () => {
    const partial: TitleStream = async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '修复 · 页面闪烁' } }
    }
    await expect(generateTitle(partial, request())).rejects.toThrow('不完整')
    const failed: TitleStream = async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '修复 · 页面闪烁' } }
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'cancelled' } } }
    }
    await expect(generateTitle(failed, request())).rejects.toThrow('未正常完成')
  })

  it('does not dispatch without a route or after cancellation', async () => {
    const stream = vi.fn((_options: GenerateOptions) => response())
    const { route: _route, ...unrouted } = request()
    await expect(generateTitle(stream, unrouted)).rejects.toThrow('可用模型')
    await expect(generateTitle(stream, { ...request(), signal: AbortSignal.abort() })).rejects.toThrow()
    expect(stream).not.toHaveBeenCalled()
  })
})

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function fixture(stream: TitleStream = () => response(), reasoning?: LlmModelReasoningInfo) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 12, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  class Adapter extends LlmAdapter {
    stream = stream
    override async resolveModel(provider: string, model: string) {
      return { ...await super.resolveModel(provider, model), ...(reasoning ? { reasoning } : {}) }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  ctx.sessionTitle.register({
    id: SessionTitleProviderId('native-provider'), automatic: 'first-prompt',
    generate: (request) => generateTitle((options) => ctx.llm.stream(Object.freeze({ ...options, system: 'Native title prompt', maxTokens: 64 })), request),
  })
  let dispose: () => void = () => {}
  await ctx.plugin({
    name: 'title-patch-test',
    inject: ['sessions'],
    apply(scope: Context) { dispose = hostPatch.setup!(scope) },
  })
  await vi.waitFor(() => expect(ctx.registry.size).toBeGreaterThan(4))
  const session = ctx.sessions.create()
  return { ctx, session, dispose }
}

function prompt(session: Session, text = '修复页面闪烁'): void {
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}

describe('native title service integration', () => {
  it('retries a transient rate limit without retaining partial output', async () => {
    let calls = 0
    const { ctx, session } = await fixture(async function* () {
      calls += 1
      if (calls === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '不应保留的失败片段' } }
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'busy' } } }
      } else yield* response()
    })
    prompt(session)
    session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
    await vi.waitFor(() => expect(ctx.sessionTitle.get(session)?.title).toBe('修复 · 会话切换时页面闪烁'), { timeout: 4000 })
    expect(calls).toBe(2)
  })

  it('supplies a supported effort for always-thinking models with no default', async () => {
    const calls: GenerateOptions[] = []
    const { ctx, session } = await fixture((options) => {
      calls.push(options)
      if (options.reasoningEffort !== 'low') throw new Error('model does not support thinking off')
      return response()
    }, { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }] })
    prompt(session)
    session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
    await vi.waitFor(() => expect(ctx.sessionTitle.get(session)?.title).toBe('修复 · 会话切换时页面闪烁'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.reasoningEffort).toBe('low')
    expect(calls[0]?.maxTokens).toBe(2048)
  })

  it('accepts a title while the main model response is still pending', async () => {
    let releaseMain: () => void = () => {}
    const pendingMain = new Promise<void>((resolve) => { releaseMain = resolve })
    let mainStarted = false
    let mainFinished = false
    const { ctx, session } = await fixture(async function* (options) {
      if (options.purpose !== 'session-title') {
        mainStarted = true
        await pendingMain
        mainFinished = true
      }
      yield* response()
    })
    prompt(session)
    const main = ctx.llm.stream({ provider: 'test', model: 'test-model', messages: [], sessionId: session.id })[Symbol.asyncIterator]()
    const firstChunk = main.next()
    try {
      await vi.waitFor(() => expect(mainStarted).toBe(true))
      session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
      await vi.waitFor(() => expect(ctx.sessionTitle.get(session)?.title).toBe('修复 · 会话切换时页面闪烁'))
      expect(mainFinished).toBe(false)
    } finally {
      releaseMain()
      await firstChunk
      await main.return?.()
    }
  })

  it('generates on the first prompt and leaves later prompts and manual names alone', async () => {
    const stream = vi.fn(() => response())
    const { ctx, session } = await fixture(stream)
    prompt(session)
    session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
    await vi.waitFor(() => expect(ctx.sessionTitle.get(session)?.title).toBe('修复 · 会话切换时页面闪烁'))
    expect(ctx.sessionProjections.stateOf(session, 'title')).toBe('修复 · 会话切换时页面闪烁')
    prompt(session, '再加一个测试')
    await Promise.resolve()
    expect(stream).toHaveBeenCalledTimes(1)
    ctx.sessionTitle.rename(session, '我的固定标题')
    prompt(session, '现在改做别的事情')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('user')
    expect(ctx.sessionTitle.get(session)?.title).toBe('我的固定标题')
  })

  it('preserves the fallback on malformed output', async () => {
    const { ctx, session } = await fixture(() => response('不符合格式'))
    session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
    prompt(session)
    await expect(ctx.sessionTitle.refresh(session)).rejects.toThrow('标题格式无效')
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe('fallback')
  })

  it('enhances an existing native provider and restores its request on disable', async () => {
    const prompts: Array<string | undefined> = []
    const budgets: Array<number | undefined> = []
    const { ctx, session, dispose } = await fixture((options) => {
      prompts.push(options.system)
      budgets.push(options.maxTokens)
      return response()
    })
    session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
    prompt(session)
    await ctx.sessionTitle.refresh(session)
    expect(prompts).toHaveLength(1)
    expect(budgets).toEqual([2048])
    expect(prompts[0]).toContain('唯一输出格式：类型 · 具体任务')
    expect(ctx.sessionTitle.get(session)?.source).toMatchObject({ provider: 'native-provider' })
    dispose()
    await ctx.sessionTitle.refresh(session)
    expect(prompts[1]).toBe('Native title prompt')
    expect(budgets[1]).toBe(64)
    const again = hostPatch.setup!(ctx)
    await ctx.sessionTitle.refresh(session)
    expect(prompts[2]).toContain('唯一输出格式：类型 · 具体任务')
    again()
  })

  it.each(['rename', 'disable'] as const)('discards a late result after %s', async (action) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = false
    const { ctx, session, dispose } = await fixture(async function* () {
      started = true
      await gate
      yield* response()
    })
    session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' }, tools: [] }, reason: 'initial' })
    prompt(session)
    const generation = ctx.sessionTitle.refresh(session)
    const rejected = expect(generation).rejects.toThrow()
    await vi.waitFor(() => expect(started).toBe(true))
    if (action === 'rename') ctx.sessionTitle.rename(session, '手动命名')
    else dispose()
    await Promise.resolve()
    release()
    await rejected
    expect(ctx.sessionTitle.get(session)?.source.kind).toBe(action === 'rename' ? 'user' : 'fallback')
  })
})
