import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { LlmAdapter, LlmRuntime, ReasoningEffortId, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { hostPatch } from './host/index.js'
import { DEEPSEEK_PROVIDER as PROVIDER, LLM_DEEPSEEK_SETTINGS_NAMESPACE as NS, type ModelCapabilitiesSnapshot } from './shared.js'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const initial = {
  baseURL: 'http://example.test', apiKeyEnv: 'KEEP_REFERENCE', defaultContextWindow: 12345,
  models: [
    { id: 'first', contextWindow: 9000, inputModalities: ['text'] },
    { id: 'second', inputModalities: ['text', 'image'], imagePixelBudget: 1048576, imageMaxBytes: 500000 },
  ],
}
async function fixture(user: unknown = initial, base?: object) {
  const ctx = new Context()
  contexts.push(ctx)
  let writes = 0
  let stored: Record<string, unknown> | undefined
  class MemorySettings extends SettingsProvider {
    writable = true
    protected async load() { return { [NS]: structuredClone(user) } }
    protected async persist(_ns: string, value: Record<string, unknown>) { writes += 1; stored = value }
  }
  await ctx.plugin(MemorySettings)
  ctx.settings.register(NS, z.dict(z.any()), { applies: 'live', ...(base === undefined ? {} : { base }) })
  await ctx.plugin(LlmRuntime)
  const sent: GenerateOptions[] = []
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      const profile = ctx.settings.get(NS) as typeof initial
      return {
        provider, id: model, name: model, context: { contextWindow: 9000 },
        inputModalities: ['text' as const],
        reasoning: { efforts: ['off', 'low', 'high', 'max'].map((level) => ({ id: ReasoningEffortId(level), name: level })), defaultEffort: ReasoningEffortId('high') },
        defaultMaxTokens: profile.defaultContextWindow,
      }
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      sent.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([PROVIDER, 'other'], new Adapter())
  const routes = hostPatch.routes({ ctx, confirmationSecret: new Uint8Array(0) })
  const dispose = hostPatch.setup!(ctx)
  const read = async () => await routes.read!({}) as ModelCapabilitiesSnapshot
  const save = async (changes: Record<string, unknown> = {}) => routes.save!({ namespace: NS, provider: PROVIDER, modelId: 'first',
    expectedRevision: (await read()).rows[0]?.revision, vision: true, reasoningEfforts: { low: 'low', max: 'max' }, thinkingFormat: null, ...changes })
  return { ctx, read, save, dispose, sent, writes: () => writes, stored: () => stored }
}
const config: LlmCallConfig = { provider: PROVIDER, model: 'first' }
async function consume(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

describe('native DeepSeek model capabilities', () => {
  it('uses the native namespace and preserves provider and other-model configuration', async () => {
    const runtime = await fixture()
    expect((await runtime.read()).rows).toMatchObject([
      { namespace: NS, provider: PROVIDER, modelId: 'first', api: 'deepseek-native', vision: false },
      { namespace: NS, provider: PROVIDER, modelId: 'second', vision: true },
    ])
    await runtime.save()
    expect(runtime.stored()).toEqual({ ...initial, models: [
      { ...initial.models[0], inputModalities: ['text', 'image'], reasoningEfforts: { low: 'low', max: 'max' } }, initial.models[1],
    ] })
    expect(runtime.writes()).toBe(1)
  })

  it('applies each model list to metadata, defaults, prepared calls and direct streams', async () => {
    const runtime = await fixture()
    await runtime.save()
    const info = await runtime.ctx.llm.resolveModelInfo(PROVIDER, 'first')
    expect(info.reasoning?.efforts.map((entry) => entry.id)).toEqual(['low', 'max'])
    expect((await runtime.ctx.llm.resolveModelInfo(PROVIDER, 'second')).reasoning?.efforts).toHaveLength(4)
    expect((await runtime.ctx.llm.resolveModelInfo('other', 'first')).reasoning?.efforts).toHaveLength(4)
    const resolved = await runtime.ctx.llm.resolveCallConfig(config)
    expect(resolved.reasoningEffort).toBe('low')
    const prepared = await runtime.ctx.llm.prepareCall(config)
    expect(prepared.config.reasoningEffort).toBe('low')
    expect(prepared.adapterDefaults.reasoningEffort).toBe(true)
    await consume(prepared.stream({ ...prepared.config, messages: [] }))
    await consume(runtime.ctx.llm.stream({ ...config, messages: [] }))
    expect(runtime.sent.map((entry) => entry.reasoningEffort)).toEqual(['low', 'low'])
  })

  it('refuses a disallowed explicit effort before transport', async () => {
    const runtime = await fixture()
    await runtime.save()
    const invalid = { ...config, reasoningEffort: ReasoningEffortId('high') }
    await expect(runtime.ctx.llm.resolveCallConfig(invalid)).rejects.toThrow('未配置')
    await expect(runtime.ctx.llm.prepareCall(invalid)).rejects.toThrow('未配置')
    expect(await consume(runtime.ctx.llm.stream({ ...invalid, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } }])
    expect(runtime.sent).toHaveLength(0)
  })

  it('uses off when reasoning is disabled without altering other models', async () => {
    const runtime = await fixture()
    await runtime.save({ vision: false, reasoningEfforts: false })
    expect((await runtime.ctx.llm.prepareCall(config)).config.reasoningEffort).toBe('off')
    expect((await runtime.ctx.llm.prepareCall({ ...config, model: 'second' })).config.reasoningEffort).toBe('high')
  })

  it('keeps a prepared request on its original settings and restores behavior on disable', async () => {
    const runtime = await fixture()
    await runtime.save()
    const prepared = await runtime.ctx.llm.prepareCall(config)
    await runtime.save({ reasoningEfforts: false })
    await consume(prepared.stream({ ...prepared.config, messages: [] }))
    expect(runtime.sent[0]?.reasoningEffort).toBe('low')
    expect((await runtime.ctx.llm.prepareCall(config)).config.reasoningEffort).toBe('off')
    runtime.dispose()
    await Promise.resolve()
    expect((await runtime.ctx.llm.resolveModelInfo(PROVIDER, 'first')).reasoning?.efforts).toHaveLength(4)
    const reinstall = hostPatch.setup!(runtime.ctx)
    await vi.waitFor(async () => expect((await runtime.ctx.llm.prepareCall(config)).config.reasoningEffort).toBe('off'))
    reinstall()
  })

  it('clears declarations and removes incompatible image budgets when disabling vision', async () => {
    const runtime = await fixture()
    await runtime.save({ modelId: 'second', vision: false, reasoningEfforts: null })
    expect(runtime.stored()).toMatchObject({ models: [initial.models[0], { id: 'second', inputModalities: ['text'] }] })
    const model = (runtime.stored() as typeof initial).models[1]!
    expect(model).not.toHaveProperty('imagePixelBudget')
    expect(model).not.toHaveProperty('imageMaxBytes')
  })

  it('retains the full inherited catalog when first overriding a default model', async () => {
    const runtime = await fixture({}, initial)
    await runtime.save()
    expect((runtime.stored() as typeof initial).models).toHaveLength(2)
    expect(runtime.stored()).not.toHaveProperty('apiKeyEnv')
  })

  it.each([{ reasoningEfforts: { medium: 'medium' } }, { reasoningEfforts: { high: 'deep' } }, { thinkingFormat: 'deepseek' }, { provider: 'other' }, { namespace: 'untrusted' }, { expectedRevision: -1 }])('rejects invalid native changes: %j', async (changes) => {
    const runtime = await fixture()
    await expect(runtime.save(changes)).rejects.toThrow()
    expect(runtime.writes()).toBe(0)
  })

  it('refuses a stale native draft and honors deployment-level disabled thinking', async () => {
    const runtime = await fixture({ ...initial, thinking: 'disabled' })
    await expect(runtime.save()).rejects.toThrow('提供方已关闭')
    const revision = (await runtime.read()).rows[0]!.revision
    await runtime.save({ reasoningEfforts: false })
    await expect(runtime.save({ reasoningEfforts: false, expectedRevision: revision })).rejects.toMatchObject({ status: 409 })
  })
})
