import { PLUGIN_API_PREFIX, PLUGIN_MUTATION_HEADER } from '../identity.js'

export class DshMoreApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DshMoreApiError'
  }
}

export async function callPatchApi<T>(patchId: string, action: string, payload: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${PLUGIN_API_PREFIX}/${encodeURIComponent(patchId)}/${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [PLUGIN_MUTATION_HEADER]: '1',
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new DshMoreApiError('network', error instanceof Error ? error.message : String(error))
  }
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    value?: T
    error?: { code?: string; message?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.value === undefined) {
    throw new DshMoreApiError(body?.error?.code ?? 'http', body?.error?.message ?? `HTTP ${String(response.status)}`)
  }
  return body.value
}

export function apiErrorText(error: unknown): string {
  if (error instanceof DshMoreApiError || error instanceof Error) return error.message
  return String(error)
}
