import { DshMoreError } from '../../../platform/dsh/host/error.js'
import {
  THINKING_LEVELS,
  type ModelReasoningEfforts,
  type ThinkingLevel,
} from '../shared.js'

const LEVEL_SET = new Set<string>(THINKING_LEVELS)

/**
 * Validate a client-supplied `reasoningEfforts` payload, mirroring the
 * pi-ai profile rules the adapter enforces when it resolves a route:
 * - `null`/`undefined` means "clear" (fall back to the installed catalog).
 * - `false` means "this model does not reason".
 * - otherwise a dict whose keys are known levels, whose non-`off` values are
 *   non-empty wire spellings, and which offers at least one level beyond `off`.
 *
 * Rejecting invalid payloads here refuses the `settings.mutate` that would
 * otherwise store a profile the adapter would refuse on its next resolution.
 */
export function validateReasoningEfforts(raw: unknown): ModelReasoningEfforts | null {
  if (raw === null || raw === undefined) return null
  if (raw === false) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DshMoreError('bad-request', 'reasoningEfforts 必须是 false、思考级别字典或 null。')
  }
  const dict = raw as Record<string, unknown>
  const keys = Object.keys(dict)
  if (keys.length === 0) throw new DshMoreError('bad-request', '至少需要声明一个思考级别。')
  const result: Partial<Record<ThinkingLevel, string | null>> = {}
  let offersThinking = false
  for (const key of keys) {
    if (!LEVEL_SET.has(key)) throw new DshMoreError('bad-request', `未知的思考级别：${key}`)
    const value = dict[key]
    if (value === null) {
      if (key !== 'off') throw new DshMoreError('bad-request', `思考级别 ${key} 必须填写线上值，只有 off 可以为空。`)
      result[key as ThinkingLevel] = null
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new DshMoreError('bad-request', `思考级别 ${key} 的线上值必须是非空字符串。`)
    }
    result[key as ThinkingLevel] = value
    if (key !== 'off') offersThinking = true
  }
  if (!offersThinking) throw new DshMoreError('bad-request', '需要至少声明一个非 off 的思考级别。')
  return result as ModelReasoningEfforts
}
