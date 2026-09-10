import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { hostPatch } from './host/index.js'
import { validateCapabilities, validateReasoningEfforts } from './host/validate.js'
import { LLM_PI_AI_SETTINGS_NAMESPACE as NS, THINKING_FORMATS, type ModelCapabilitiesSnapshot } from './shared.js'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const SAMPLE = {
  providers: {
    gateway: {
      api: 'openai-completions', baseURL: 'https://example.test/v1', displayName: 'Gateway',
      headers: { 'X-Deployment': 'keep-private' }, apiKeyEnv: 'PRIVATE_KEY_REF',
      models: [
        { id: 'vision', contextWindow: 1000, input: ['text', 'image'], reasoningEfforts: { off: 'none', high: 'deep' }, compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false } },
        { id: 'unknown', contextWindow: 2000 },
        { id: 'text', input: ['text'], reasoningEfforts: false },
      ],
    },
    other: { models: [{ id: 'unknown', reasoningEfforts: false }] },
  },
}

async function fixture(user: unknown = SAMPLE, options: { base?: Record<string, unknown>; writable?: boolean; register?: boolean } = {}) {
  let persisted: Record<string, unknown> | undefined
  let writes = 0
  class MemorySettings extends SettingsProvider {
    readonly writable = options.writable ?? true
    protected async load() { return user === undefined ? {} : { [NS]: structuredClone(user) } }
    protected async persist(_ns: string, section: Record<string, unknown>) { persisted = section; writes += 1 }
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  if (options.register !== false) ctx.settings.register(NS, z.dict(z.any()), { ...(options.base === undefined ? {} : { base: options.base }), applies: 'live' })
  const routes = hostPatch.routes({ ctx, confirmationSecret: new Uint8Array(0) })
  const read = async () => await routes.read!({}) as ModelCapabilitiesSnapshot
  const save = async (overrides: Record<string, unknown> = {}) => routes.save!({
    namespace: NS, provider: 'gateway', modelId: 'unknown', expectedRevision: (await read()).revision,
    vision: null, reasoningEfforts: null, thinkingFormat: null, ...overrides,
  })
  return { ctx, routes, read, save, stored: () => persisted, writes: () => writes }
}

function storedModels(value: unknown): Array<Record<string, unknown>> {
  return (value as typeof SAMPLE).providers.gateway.models
}

describe('model capabilities in the real DSH Settings service', () => {
  it('reads declarations without writing defaults or exposing credentials', async () => {
    const runtime = await fixture()
    const snapshot = await runtime.read()
    expect(snapshot.rows).toMatchObject([
      { provider: 'gateway', providerName: 'Gateway', modelId: 'vision', api: 'openai-completions', vision: true, reasoningEfforts: { off: 'none', high: 'deep' }, thinkingFormat: 'deepseek' },
      { provider: 'gateway', providerName: 'Gateway', modelId: 'unknown', api: 'openai-completions', vision: null, reasoningEfforts: null, thinkingFormat: null },
      { provider: 'gateway', providerName: 'Gateway', modelId: 'text', api: 'openai-completions', vision: false, reasoningEfforts: false, thinkingFormat: null },
      { provider: 'other', providerName: 'other', modelId: 'unknown', api: null, vision: null, reasoningEfforts: false, thinkingFormat: null },
    ])
    expect(JSON.stringify(snapshot)).not.toMatch(/keep-private|PRIVATE_KEY_REF|example.test|documentPath/)
    expect(runtime.writes()).toBe(0)
    expect(Object.keys(runtime.routes).sort()).toEqual(['read', 'save'])
  })

  it('saves vision, levels and wire format without dropping other models or settings', async () => {
    const runtime = await fixture()
    const next = await runtime.save({ vision: true, reasoningEfforts: { off: null, high: 'deep' }, thinkingFormat: 'qwen' })
    expect(next).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ modelId: 'unknown', vision: true, thinkingFormat: 'qwen' })]) })
    expect(runtime.stored()).toEqual({ providers: {
      ...SAMPLE.providers,
      gateway: { ...SAMPLE.providers.gateway, models: [SAMPLE.providers.gateway.models[0],
        { id: 'unknown', contextWindow: 2000, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'deep' }, compat: { thinkingFormat: 'qwen' } }, SAMPLE.providers.gateway.models[2]] },
    } })
  })

  it('explicitly disables vision and reasoning even when previously enabled', async () => {
    const runtime = await fixture()
    await runtime.save({ modelId: 'vision', vision: false, reasoningEfforts: false, thinkingFormat: 'deepseek' })
    expect(storedModels(runtime.stored())[0]).toMatchObject({ input: ['text'], reasoningEfforts: false, compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false } })
  })

  it('clears owned declarations while preserving unrelated compatibility switches', async () => {
    const runtime = await fixture()
    await runtime.save({ modelId: 'vision' })
    expect(storedModels(runtime.stored())[0]).toEqual({ id: 'vision', contextWindow: 1000, compat: { supportsDeveloperRole: false } })
    expect((await runtime.read()).rows[0]).toMatchObject({ vision: null, reasoningEfforts: null, thinkingFormat: null })
  })

  it('preserves a complete base model list on the first user override', async () => {
    const runtime = await fixture({}, { base: SAMPLE })
    await runtime.save({ vision: true })
    expect(storedModels(runtime.stored())).toHaveLength(3)
    expect(storedModels(runtime.stored())[0]).toEqual(SAMPLE.providers.gateway.models[0])
    expect(runtime.stored()).toEqual({ providers: { gateway: { models: [SAMPLE.providers.gateway.models[0],
      { id: 'unknown', contextWindow: 2000, input: ['text', 'image'] }, SAMPLE.providers.gateway.models[2]] } } })
    expect((runtime.ctx.settings.get(NS) as typeof SAMPLE).providers.gateway.baseURL).toBe(SAMPLE.providers.gateway.baseURL)
  })

  it('rejects stale drafts and concurrent writes without losing the successful update', async () => {
    const runtime = await fixture()
    const revision = (await runtime.read()).revision
    const outcomes = await Promise.allSettled([
      runtime.save({ expectedRevision: revision, vision: true }),
      runtime.save({ expectedRevision: revision, reasoningEfforts: false }),
    ])
    expect(outcomes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(runtime.writes()).toBe(1)
    await expect(runtime.save({ expectedRevision: revision })).rejects.toMatchObject({ status: 409 })
    expect(runtime.writes()).toBe(1)
  })

  it('refuses read-only settings and unavailable namespaces', async () => {
    const readonly = await fixture(SAMPLE, { writable: false })
    await expect(readonly.save({ vision: true })).rejects.toMatchObject({ status: 403 })
    const absent = await fixture({}, { register: false })
    expect(await absent.read()).toEqual({ protocolVersion: 2, rows: [], writable: true, revision: null })
    await expect(absent.save({ expectedRevision: 0 })).rejects.toThrow('尚未就绪')
    expect(absent.writes()).toBe(0)
  })

  it.each([
    { provider: 'missing' }, { provider: '__proto__' }, { modelId: 'missing' },
    { vision: 'yes' }, { vision: undefined }, { reasoningEfforts: undefined },
    { thinkingFormat: undefined }, { expectedRevision: -1 }, { expectedRevision: 0.5 },
    { thinkingFormat: 'imaginary' }, { reasoningEfforts: { off: null } },
  ])('refuses invalid requests before persistence: %j', async (payload) => {
    const runtime = await fixture()
    await expect(runtime.save(payload)).rejects.toThrow()
    expect(runtime.writes()).toBe(0)
  })

  it('rejects a compatibility format for a native Responses model', async () => {
    const runtime = await fixture({ providers: { gateway: { api: 'openai-responses', models: [{ id: 'unknown' }] } } })
    await expect(runtime.save({ thinkingFormat: 'openai' })).rejects.toThrow('原生思考协议')
    expect(runtime.writes()).toBe(0)
    await runtime.save({ vision: true, reasoningEfforts: { high: 'high' } })
    expect(runtime.writes()).toBe(1)
  })
})

describe('capability validation', () => {
  it.each(THINKING_FORMATS)('accepts the supported wire format %s', (thinkingFormat) => {
    expect(validateCapabilities({ vision: null, reasoningEfforts: null, thinkingFormat }).thinkingFormat).toBe(thinkingFormat)
  })
  it.each([undefined, true, [], 'high', {}, { turbo: 'on' }, { high: null }, { high: '' }, { high: ' ' }])('rejects invalid thinking declarations: %j', (value) => {
    expect(() => validateReasoningEfforts(value)).toThrow()
  })
  it('preserves a custom off wire value and accepts a null off value', () => {
    expect(validateReasoningEfforts({ off: 'none', high: 'deep' })).toEqual({ off: 'none', high: 'deep' })
    expect(validateReasoningEfforts({ off: null, low: 'low' })).toEqual({ off: null, low: 'low' })
  })
})
