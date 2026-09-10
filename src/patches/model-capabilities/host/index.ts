import type { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { requireInteger, requireString } from '../../../platform/dsh/host/wire.js'
import {
  LLM_PI_AI_SETTINGS_NAMESPACE as NS,
  LLM_DEEPSEEK_SETTINGS_NAMESPACE as DEEPSEEK_NS,
  DEEPSEEK_PROVIDER, CAPABILITIES_PROTOCOL_VERSION,
  MODEL_CAPABILITIES_PATCH_ID,
  THINKING_FORMATS,
  type ModelCapabilities,
  type ModelCapabilitiesRow,
  type ModelCapabilitiesSnapshot,
} from '../shared.js'
import { installDeepSeekReasoning, validateDeepSeekEfforts } from './deepseek.js'
import { validateCapabilities, validateReasoningEfforts } from './validate.js'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function modelsOf(profile: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(profile.models) ? profile.models.map(record) : []
}

function capabilitiesOf(model: Record<string, unknown>, native = false): ModelCapabilities {
  const input = native ? model.inputModalities : model.input
  const format = record(model.compat).thinkingFormat
  return {
    vision: Array.isArray(input) && input.length > 0 ? input.includes('image') : null,
    reasoningEfforts: model.reasoningEfforts === undefined ? null : validateReasoningEfforts(model.reasoningEfforts),
    thinkingFormat: THINKING_FORMATS.find((entry) => entry === format) ?? null,
  }
}

function read(ctx: Context): ModelCapabilitiesSnapshot {
  const descriptor = ctx.settings.describe().find((entry) => entry.ns === NS)
  const rows: ModelCapabilitiesRow[] = []
  const providers = record(record(descriptor?.value).providers)
  for (const [provider, raw] of Object.entries(providers)) {
    const profile = record(raw)
    for (const model of modelsOf(profile)) {
      if (typeof model.id !== 'string' || model.id === '') continue
      const api = model.api ?? profile.api
      rows.push({
        namespace: NS, revision: descriptor!.revision,
        provider,
        providerName: typeof profile.displayName === 'string' ? profile.displayName : provider,
        modelId: model.id,
        api: typeof api === 'string' ? api : null,
        ...capabilitiesOf(model),
      })
    }
  }
  const native = ctx.settings.describe().find((entry) => entry.ns === DEEPSEEK_NS)
  for (const model of modelsOf(record(native?.value))) {
    if (typeof model.id !== 'string' || model.id === '') continue
    rows.push({
      namespace: DEEPSEEK_NS, revision: native!.revision,
      provider: DEEPSEEK_PROVIDER, providerName: 'DeepSeek', modelId: model.id,
      api: 'deepseek-native', ...capabilitiesOf(model, true),
    })
  }
  // Return only capability metadata: provider headers, credentials and local
  // paths never cross this API boundary.
  return { protocolVersion: CAPABILITIES_PROTOCOL_VERSION, rows, writable: ctx.settings.writable, revision: descriptor?.revision ?? null }
}

async function save(ctx: Context, payload: unknown): Promise<ModelCapabilitiesSnapshot> {
  const namespace = requireString(payload, 'namespace')
  if (namespace !== NS && namespace !== DEEPSEEK_NS) throw new DshMoreError('bad-request', '未知的模型配置来源，请刷新页面。')
  const provider = requireString(payload, 'provider')
  const modelId = requireString(payload, 'modelId')
  const expectedRevision = requireInteger(payload, 'expectedRevision')
  if (expectedRevision < 0) throw new DshMoreError('bad-request', '配置版本无效，请重新打开模型能力。')
  const capabilities = validateCapabilities(record(payload))
  if (!ctx.settings.writable) throw new DshMoreError('forbidden', '当前配置为只读，无法保存修改。', 403)
  const descriptor = ctx.settings.describe().find((entry) => entry.ns === namespace)
  if (descriptor === undefined) throw new DshMoreError('bad-request', '模型配置尚未就绪，请稍后重试。')
  if (descriptor.revision !== expectedRevision) throw staleSettings()
  if (namespace === DEEPSEEK_NS) {
    if (provider !== DEEPSEEK_PROVIDER) throw new DshMoreError('bad-request', 'DeepSeek 提供方不匹配。')
    if (capabilities.thinkingFormat !== null) throw new DshMoreError('bad-request', '原生 DeepSeek 使用固定的思考协议，无需配置参数格式。')
    try { validateDeepSeekEfforts(capabilities.reasoningEfforts) } catch (error) {
      throw new DshMoreError('bad-request', error instanceof Error ? error.message : 'DeepSeek 思考类型无效。')
    }
    const profile = record(descriptor.value)
    if (profile.thinking === 'disabled' && capabilities.reasoningEfforts !== null && capabilities.reasoningEfforts !== false) {
      throw new DshMoreError('bad-request', 'DeepSeek 提供方已关闭思考，请先调整提供方配置。')
    }
    const user = record(descriptor.user)
    const base = record(descriptor.base)
    const source = Array.isArray(user.models) ? user : Array.isArray(base.models) ? base : profile
    const models = modelsOf(source)
    const matches = models.filter((model) => model.id === modelId)
    if (matches.length !== 1) throw new DshMoreError('bad-request', '请先保存模型配置，并确保模型名称唯一。')
    const next = { ...matches[0] }
    if (capabilities.vision === null) delete next.inputModalities
    else next.inputModalities = capabilities.vision ? ['text', 'image'] : ['text']
    if (capabilities.vision !== true) {
      // Native validation rejects image-only budgets on a text-only model.
      delete next.imagePixelBudget
      delete next.imageMaxBytes
    }
    if (capabilities.reasoningEfforts === null) delete next.reasoningEfforts
    else next.reasoningEfforts = capabilities.reasoningEfforts
    await mutate(ctx, namespace, [{ op: 'set', path: ['models'], value: models.map((model) => model.id === modelId ? next : model) }], expectedRevision)
    return read(ctx)
  }
  const providers = record(record(descriptor.value).providers)
  if (!Object.hasOwn(providers, provider)) throw new DshMoreError('not-found', '该提供方已不存在，请重新打开模型配置。', 404)
  const profile = record(providers[provider])
  const matches = modelsOf(profile).filter((entry) => entry.id === modelId)
  const model = matches[0]
  if (matches.length !== 1 || model === undefined) {
    throw new DshMoreError('bad-request', '请先保存提供方配置，并确保模型名称唯一。')
  }
  const api = model.api ?? profile.api
  if (capabilities.thinkingFormat !== null && api !== undefined && api !== 'openai-completions') {
    throw new DshMoreError('bad-request', '该接口使用原生思考协议，无需指定思考参数格式。')
  }

  const userProviders = record(record(descriptor.user).providers)
  const userProfile = record(Object.hasOwn(userProviders, provider) ? userProviders[provider] : undefined)
  // Arrays replace rather than merge in Settings. If this is the first user
  // override, retain the ENTIRE explicit base model list, not only this model.
  // Do not copy the schema-resolved provider (which would persist defaults).
  const baseProfile = record(record(record(descriptor.base).providers)[provider])
  const source = Array.isArray(userProfile.models) ? userProfile : baseProfile
  const storedModels = modelsOf(source)
  const index = storedModels.findIndex((entry) => entry.id === modelId)
  if (index < 0) throw new DshMoreError('bad-request', '未找到已保存的模型，请先保存提供方配置。')
  const next = { ...storedModels[index] }
  if (capabilities.vision === null) delete next.input
  else {
    // Preserve any other declared modalities; the patch owns only image.
    const input = Array.isArray(model.input) ? model.input.filter((entry) => entry !== 'image') : ['text']
    if (!input.includes('text')) input.unshift('text')
    next.input = capabilities.vision ? [...input, 'image'] : input
  }
  if (capabilities.reasoningEfforts === null) delete next.reasoningEfforts
  else next.reasoningEfforts = capabilities.reasoningEfforts
  const compat = { ...record(next.compat) }
  if (capabilities.thinkingFormat === null) delete compat.thinkingFormat
  else compat.thinkingFormat = capabilities.thinkingFormat
  if (Object.keys(compat).length === 0) delete next.compat
  else next.compat = compat
  const nextModels = storedModels.map((entry, position) => position === index ? next : entry)
  await mutate(ctx, namespace, [{
    op: 'set', path: ['providers'],
    value: { ...userProviders, [provider]: { ...userProfile, models: nextModels } },
  }], expectedRevision)
  return read(ctx)
}

async function mutate(ctx: Context, namespace: typeof NS | typeof DEEPSEEK_NS, ops: Parameters<Context['settings']['mutate']>[1], revision: number): Promise<void> {
  try { await ctx.settings.mutate(namespace, ops, revision) } catch (error) {
    if (error instanceof SettingsConflictError) throw staleSettings()
    throw new DshMoreError('bad-request', '模型配置未保存，请检查思考类型、接口格式及提供方设置。')
  }
}

function staleSettings(): DshMoreError {
  return new DshMoreError('stale-preview', '模型配置已变更，请关闭后重新打开模型能力，再保存修改。', 409)
}

export const hostPatch: HostPatch = {
  id: MODEL_CAPABILITIES_PATCH_ID,
  setup: installDeepSeekReasoning,
  routes: ({ ctx }) => ({ read: () => read(ctx), save: (payload) => save(ctx, payload) }),
}
