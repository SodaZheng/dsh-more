import { callPatchApi } from '../../../platform/dsh/client/api.js'
import { CAPABILITIES_PROTOCOL_VERSION, MODEL_CAPABILITIES_PATCH_ID, type ModelCapabilitiesSnapshot } from '../shared.js'

/** A stale Host must never look like an editable model or silently skip save. */
export function decodeSnapshot(value: unknown): ModelCapabilitiesSnapshot {
  if (typeof value !== 'object' || value === null) throw mismatch()
  const snapshot = value as Partial<ModelCapabilitiesSnapshot>
  if (snapshot.protocolVersion !== CAPABILITIES_PROTOCOL_VERSION || typeof snapshot.writable !== 'boolean'
    || !Array.isArray(snapshot.rows) || !snapshot.rows.every((row: unknown) => {
      if (typeof row !== 'object' || row === null) return false
      const entry = row as Record<string, unknown>
      return (entry.namespace === 'llm-deepseek' || entry.namespace === 'llm-pi-ai')
        && Number.isSafeInteger(entry.revision) && Number(entry.revision) >= 0
        && typeof entry.provider === 'string' && typeof entry.modelId === 'string'
        && (entry.vision === null || typeof entry.vision === 'boolean')
        && Object.hasOwn(entry, 'reasoningEfforts') && Object.hasOwn(entry, 'thinkingFormat')
    })) throw mismatch()
  return snapshot as ModelCapabilitiesSnapshot
}

function mismatch(): Error {
  return new Error('模型能力界面与后台版本不一致，请重启 DSH 服务后刷新页面，再保存配置。')
}

export async function readCapabilities(): Promise<ModelCapabilitiesSnapshot> {
  return decodeSnapshot(await callPatchApi<unknown>(MODEL_CAPABILITIES_PATCH_ID, 'read', {}))
}
