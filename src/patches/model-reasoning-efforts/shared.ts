export const MODEL_REASONING_EFFORTS_PATCH_ID = 'model-reasoning-efforts'

/**
 * The llm-pi-ai settings namespace this patch reads and writes. The shipped
 * Models settings page writes custom providers into the same namespace, so a
 * profile stored there is exactly what this patch annotates with
 * `reasoningEfforts`.
 */
export const LLM_PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai'

/**
 * Every pi-ai thinking level a model may offer, in escalation order. Mirror of
 * the `THINKING_LEVELS` the installed `dsh-llm-pi-ai` adapter accepts; a level
 * absent from a model's dict is simply not offered.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ThinkingLevel = typeof THINKING_LEVELS[number]

/**
 * The reasoning-effort set auto-filled onto a model that has none. DSH does
 * not expose a model's true supported levels for custom providers (the pi-ai
 * catalog lives behind the adapter, and `resolveModelInfo` does not surface
 * reasoning for custom routes), so the patch fills a common default which the
 * user can adjust per model. A model with no `reasoningEfforts` at all is
 * treated as non-reasoning by the adapter, so this override is what makes a
 * freshly fetched model think.
 */
export const DEFAULT_REASONING_EFFORTS: Partial<Record<ThinkingLevel, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
}

/**
 * One model's reasoning-effort capability as stored in `settings.yaml`:
 * `false` means the model does not reason at all; a dict maps each offered
 * level to the wire spelling dispatch should send for it (`off` may leave its
 * spelling empty — "supported, send nothing").
 */
export type ModelReasoningEfforts = false | Partial<Record<ThinkingLevel, string | null>>

/** One configured model's reasoning-effort state; `null` = not configured (falls back to the installed catalog). */
export interface ModelReasoningEffortsRow {
  provider: string
  providerName: string
  modelId: string
  reasoningEfforts: ModelReasoningEfforts | null
}

/** What the settings page renders from, returned by the `read` route. */
export interface ModelReasoningEffortsSnapshot {
  rows: readonly ModelReasoningEffortsRow[]
  writable: boolean
  documentPath: string | undefined
}

/** The `save` route payload; `reasoningEfforts: null` clears the field. */
export interface SaveModelReasoningEffortsPayload {
  provider: string
  modelId: string
  reasoningEfforts: ModelReasoningEfforts | null
}
