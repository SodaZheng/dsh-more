import type { Context } from '@deepseek-ai/cordis'
import { LlmError, ReasoningEffortId, type LlmCallConfig, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_PROVIDER, DEEPSEEK_THINKING_LEVELS, LLM_DEEPSEEK_SETTINGS_NAMESPACE, type ModelReasoningEfforts } from '../shared.js'
import { validateReasoningEfforts } from './validate.js'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Native DeepSeek accepts only these literal levels, not pi-ai wire aliases. */
export function validateDeepSeekEfforts(efforts: ModelReasoningEfforts | null): void {
  if (efforts === false || efforts === null) return
  for (const [level, wire] of Object.entries(efforts)) {
    if (!DEEPSEEK_THINKING_LEVELS.some((item) => item === level)
      || (wire !== level && !(level === 'off' && wire === null))) {
      throw new Error('原生 DeepSeek 支持不思考、低、高、最高，参数值固定为 off、low、high、max。')
    }
  }
}

interface Rule { levels: readonly string[]; defaultEffort: string }
function ruleFor(ctx: Context, provider: string, modelId: string): Rule | undefined {
  if (provider !== DEEPSEEK_PROVIDER) return undefined
  const profile = record(ctx.settings.get(LLM_DEEPSEEK_SETTINGS_NAMESPACE))
  const models = Array.isArray(profile.models) ? profile.models : []
  const model = record(models.find((item) => record(item).id === modelId))
  if (model.reasoningEfforts === undefined) return undefined
  const efforts = validateReasoningEfforts(model.reasoningEfforts)
  validateDeepSeekEfforts(efforts)
  if (efforts === null) return undefined
  const levels = efforts === false ? ['off'] : DEEPSEEK_THINKING_LEVELS.filter((level) => Object.hasOwn(efforts, level))
  // A deployment-wide disabled policy remains authoritative.
  if (profile.thinking === 'disabled' && levels.some((level) => level !== 'off')) {
    throw new LlmError('DeepSeek 提供方已关闭思考，请先调整提供方配置。', 'UNSUPPORTED_REASONING_EFFORT')
  }
  const preferred = typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : 'high'
  return { levels, defaultEffort: levels.includes(preferred) ? preferred : levels[0]! }
}

function revise<T extends LlmCallConfig>(config: T, rule: Rule | undefined): T {
  if (rule === undefined) return config
  const effort = config.reasoningEffort ?? ReasoningEffortId(rule.defaultEffort)
  if (!rule.levels.includes(effort)) {
    throw new LlmError(`模型 ${config.model} 未配置思考类型 ${effort}，请重新选择思考类型。`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  return { ...config, reasoningEffort: effort }
}

function reasoning(rule: Rule): LlmModelReasoningInfo {
  return {
    efforts: rule.levels.map((level) => ({ id: ReasoningEffortId(level), name: level })),
    defaultEffort: ReasoningEffortId(rule.defaultEffort),
  }
}

/**
 * DSH 0.1.2-rc.1 persists model extension fields, but its native adapter exposes
 * one shared reasoning list. Adapt public methods on this runtime instance so
 * selectors, prepared calls and direct streams use each model's declaration.
 * Native image handling and transport remain with the registered adapter.
 */
export function installDeepSeekReasoning(ctx: Context): () => void {
  let active = true
  let cleanup = (): void => {}
  const fiber = ctx.inject(['llm', 'settings'], (scope) => {
    if (!active) return
    const llm = scope.llm
    const descriptors = {
      resolveModelInfo: Object.getOwnPropertyDescriptor(llm, 'resolveModelInfo'),
      resolveCallConfig: Object.getOwnPropertyDescriptor(llm, 'resolveCallConfig'),
      prepareCall: Object.getOwnPropertyDescriptor(llm, 'prepareCall'),
      stream: Object.getOwnPropertyDescriptor(llm, 'stream'),
    }
    const originalInfo = llm.resolveModelInfo
    const originalResolve = llm.resolveCallConfig
    const originalPrepare = llm.prepareCall
    const originalStream = llm.stream
    const info: typeof originalInfo = async (provider, model, signal) => {
      const rule = active ? ruleFor(scope, provider, model) : undefined
      const result = await originalInfo.call(llm, provider, model, signal)
      return rule === undefined ? result : { ...result, reasoning: reasoning(rule) }
    }
    const resolve: typeof originalResolve = async (config, signal) =>
      originalResolve.call(llm, revise(config, active ? ruleFor(scope, config.provider, config.model) : undefined), signal)
    const prepare: typeof originalPrepare = async (config, signal) => {
      const revised = revise(config, active ? ruleFor(scope, config.provider, config.model) : undefined)
      const prepared = await originalPrepare.call(llm, revised, signal)
      if (config.reasoningEffort !== undefined || revised.reasoningEffort === undefined) return prepared
      return Object.freeze({ ...prepared, adapterDefaults: Object.freeze({ ...prepared.adapterDefaults, reasoningEffort: true as const }) })
    }
    const stream: typeof originalStream = (options) => {
      try { return originalStream.call(llm, revise(options, active ? ruleFor(scope, options.provider, options.model) : undefined)) }
      catch (error) {
        if (!(error instanceof LlmError)) throw error
        return (async function* () {
          yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: error.code, message: error.message } } }
        })()
      }
    }
    llm.resolveModelInfo = info
    llm.resolveCallConfig = resolve
    llm.prepareCall = prepare
    llm.stream = stream
    cleanup = () => {
      // Cordis wraps methods when read through a traced service. Compare the
      // own descriptor rather than that newly-created callable proxy.
      const restore = (name: keyof typeof descriptors, installed: unknown): void => {
        if (Object.getOwnPropertyDescriptor(llm, name)?.value !== installed) return
        const descriptor = descriptors[name]
        if (descriptor === undefined) Reflect.deleteProperty(llm, name)
        else Object.defineProperty(llm, name, descriptor)
      }
      restore('resolveModelInfo', info)
      restore('resolveCallConfig', resolve)
      restore('prepareCall', prepare)
      restore('stream', stream)
    }
    scope.effect(() => cleanup)
  })
  return () => { active = false; cleanup(); void fiber.dispose() }
}
