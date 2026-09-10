export const MODEL_CAPABILITIES_PATCH_ID = 'model-capabilities'
export const LLM_PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'
export const LLM_DEEPSEEK_SETTINGS_NAMESPACE = 'llm-deepseek'
export const DEEPSEEK_PROVIDER = 'deepseek-official'
export const CAPABILITIES_PROTOCOL_VERSION = 2
export type ModelSettingsNamespace = typeof LLM_PI_AI_SETTINGS_NAMESPACE | typeof LLM_DEEPSEEK_SETTINGS_NAMESPACE
export const DEEPSEEK_THINKING_LEVELS = ['off', 'low', 'high', 'max'] as const

// DSH 0.1.2-rc.1 dsh-llm-pi-ai/catalog: selectable capabilities, not the
// reasoning level used for a particular conversation or request.
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]
export type ModelReasoningEfforts = false | Partial<Record<ThinkingLevel, string | null>>

// Only openai-completions reads compat.thinkingFormat. Other protocols use
// their native thinking dispatch and must not receive this compatibility key.
export const THINKING_FORMATS = [
  'openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen',
  'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
] as const
export type ThinkingFormat = typeof THINKING_FORMATS[number]

export interface ModelCapabilities {
  /** null removes the model declaration and uses DSH's defaults. */
  vision: boolean | null
  reasoningEfforts: ModelReasoningEfforts | null
  thinkingFormat: ThinkingFormat | null
}

export interface ModelCapabilitiesRow extends ModelCapabilities {
  namespace: ModelSettingsNamespace
  revision: number
  provider: string
  providerName: string
  modelId: string
  api: string | null
}

export interface ModelCapabilitiesSnapshot {
  protocolVersion: typeof CAPABILITIES_PROTOCOL_VERSION
  rows: readonly ModelCapabilitiesRow[]
  writable: boolean
  revision: number | null
}

export interface SaveModelCapabilitiesPayload extends ModelCapabilities {
  namespace: ModelSettingsNamespace
  provider: string
  modelId: string
  expectedRevision: number
}
