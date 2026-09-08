import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { requireString } from '../../../platform/dsh/host/wire.js'
import {
  DEFAULT_REASONING_EFFORTS,
  LLM_PI_AI_SETTINGS_NAMESPACE,
  MODEL_REASONING_EFFORTS_PATCH_ID,
  type ModelReasoningEfforts,
  type ModelReasoningEffortsRow,
  type ModelReasoningEffortsSnapshot,
} from '../shared.js'
import { validateReasoningEfforts } from './validate.js'

const LLM_PI_AI_NS = LLM_PI_AI_SETTINGS_NAMESPACE

/** The resolved llm-pi-ai section, or undefined while the namespace is not registered. */
function piAiSection(ctx: Context): { providers: Record<string, unknown> } | undefined {
  const value = ctx.settings.get(LLM_PI_AI_NS)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const providers = (value as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return undefined
  return { providers: providers as Record<string, unknown> }
}

/** Narrow a stored `reasoningEfforts` field to what this patch may show. */
function normalizeEfforts(value: unknown): ModelReasoningEfforts | null {
  if (value === false) return false
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as ModelReasoningEfforts
}

function read(ctx: Context): ModelReasoningEffortsSnapshot {
  const section = piAiSection(ctx)
  const rows: ModelReasoningEffortsRow[] = []
  if (section !== undefined) {
    for (const [provider, profile] of Object.entries(section.providers)) {
      if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) continue
      const models = (profile as { models?: unknown }).models
      if (!Array.isArray(models)) continue
      const displayName = (profile as { displayName?: unknown }).displayName
      const providerName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : provider
      for (const model of models) {
        if (typeof model !== 'object' || model === null || Array.isArray(model)) continue
        const modelId = (model as { id?: unknown }).id
        if (typeof modelId !== 'string' || modelId === '') continue
        rows.push({
          provider,
          providerName,
          modelId,
          reasoningEfforts: normalizeEfforts((model as { reasoningEfforts?: unknown }).reasoningEfforts),
        })
      }
    }
  }
  return {
    rows,
    writable: ctx.settings.writable,
    documentPath: ctx.settings.documentPath,
  }
}

async function save(
  ctx: Context,
  payload: unknown,
): Promise<{ provider: string; modelId: string; reasoningEfforts: ModelReasoningEfforts | null }> {
  const provider = requireString(payload, 'provider')
  const modelId = requireString(payload, 'modelId')
  const reasoningEfforts = validateReasoningEfforts((payload as Record<string, unknown>).reasoningEfforts)
  const section = piAiSection(ctx)
  if (section === undefined) throw new DshMoreError('bad-request', 'llm-pi-ai 配置尚未注册，无法保存思考强度。')
  const profile = section.providers[provider]
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new DshMoreError('bad-request', `未找到提供方 ${provider} 的配置。`)
  }
  const models = (profile as { models?: unknown }).models
  if (!Array.isArray(models)) throw new DshMoreError('bad-request', `提供方 ${provider} 未配置任何模型。`)
  const index = models.findIndex((model) => {
    if (typeof model !== 'object' || model === null) return false
    return (model as { id?: unknown }).id === modelId
  })
  if (index === -1) throw new DshMoreError('bad-request', `提供方 ${provider} 下未找到模型 ${modelId}。`)

  // settings.mutate path ops cannot cross array indices (applyPathOp treats an
  // array child as "not a plain object" and rebuilds it as a keyed object), so
  // the models array must be rewritten wholesale. Restate the raw user layer
  // rather than the resolved value: resolved entries carry schema/catalog
  // defaults that must not be materialized into the stored document.
  const descriptor = ctx.settings.describe().find((entry) => entry.ns === LLM_PI_AI_NS)
  if (descriptor === undefined) throw new DshMoreError('bad-request', 'llm-pi-ai 配置尚未注册，无法保存思考强度。')
  const user = descriptor.user
  const userProviders = (typeof user === 'object' && user !== null && !Array.isArray(user))
    ? (user as { providers?: unknown }).providers
    : undefined
  const providers = (typeof userProviders === 'object' && userProviders !== null && !Array.isArray(userProviders))
    ? { ...userProviders as Record<string, unknown> }
    : {}
  const userProfile = providers[provider]
  const userModels = (typeof userProfile === 'object' && userProfile !== null && !Array.isArray(userProfile))
    ? (userProfile as { models?: unknown }).models
    : undefined
  const storedModels = Array.isArray(userModels) ? [...userModels] : []
  const storedIndex = storedModels.findIndex((model) => {
    if (typeof model !== 'object' || model === null) return false
    return (model as { id?: unknown }).id === modelId
  })
  if (storedIndex === -1 && reasoningEfforts === null) {
    // Nothing stored to clear — the field is absent from the user document.
    return { provider, modelId, reasoningEfforts }
  }
  const stored = storedIndex === -1 ? { id: modelId } : storedModels[storedIndex] as Record<string, unknown>
  let nextModel: Record<string, unknown>
  if (reasoningEfforts === null) {
    const { reasoningEfforts: _dropped, ...rest } = stored
    nextModel = rest
  } else {
    nextModel = { ...stored, reasoningEfforts }
  }
  const nextModels = storedIndex === -1
    ? [...storedModels, nextModel]
    : storedModels.map((model, modelIndex) => (modelIndex === storedIndex ? nextModel : model))
  const nextProfile = {
    ...(typeof userProfile === 'object' && userProfile !== null && !Array.isArray(userProfile)
      ? userProfile as Record<string, unknown>
      : {}),
    models: nextModels,
  }
  const ops: readonly SettingsPathOp[] = [{ op: 'set', path: ['providers'], value: { ...providers, [provider]: nextProfile } }]
  await ctx.settings.mutate(LLM_PI_AI_NS, ops, descriptor.revision)
  return { provider, modelId, reasoningEfforts }
}

/**
 * Fill the default reasoning-effort set onto every configured model that has
 * no `reasoningEfforts` at all. This is what makes a freshly fetched model
 * think: the adapter treats a model with no efforts as non-reasoning, so the
 * default set gives it a sensible starting point the user can refine per
 * model. Restates the raw user layer, like `save`.
 */
async function fillDefaults(ctx: Context): Promise<{ filled: number }> {
  const descriptor = ctx.settings.describe().find((entry) => entry.ns === LLM_PI_AI_NS)
  if (descriptor === undefined) return { filled: 0 }
  const user = descriptor.user
  const userProviders = (typeof user === 'object' && user !== null && !Array.isArray(user))
    ? (user as { providers?: unknown }).providers
    : undefined
  const providers = (typeof userProviders === 'object' && userProviders !== null && !Array.isArray(userProviders))
    ? { ...userProviders as Record<string, unknown> }
    : {}
  let filled = 0
  const nextProviders: Record<string, unknown> = { ...providers }
  for (const [route, profile] of Object.entries(providers)) {
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) continue
    const models = (profile as { models?: unknown }).models
    if (!Array.isArray(models)) continue
    let changed = false
    const nextModels = models.map((model) => {
      if (typeof model !== 'object' || model === null) return model
      const entry = model as Record<string, unknown>
      if ('reasoningEfforts' in entry) return model
      changed = true
      filled += 1
      return { ...entry, reasoningEfforts: { ...DEFAULT_REASONING_EFFORTS } }
    })
    if (!changed) continue
    nextProviders[route] = { ...(profile as Record<string, unknown>), models: nextModels }
  }
  if (filled === 0) return { filled: 0 }
  const ops: readonly SettingsPathOp[] = [{ op: 'set', path: ['providers'], value: nextProviders }]
  await ctx.settings.mutate(LLM_PI_AI_NS, ops, descriptor.revision)
  return { filled }
}

export const hostPatch: HostPatch = {
  id: MODEL_REASONING_EFFORTS_PATCH_ID,
  routes: ({ ctx }) => ({
    read: () => read(ctx),
    save: (payload) => save(ctx, payload),
    fillDefaults: () => fillDefaults(ctx),
  }),
}
