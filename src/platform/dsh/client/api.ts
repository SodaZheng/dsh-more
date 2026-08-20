import { PLUGIN_API_PREFIX, PLUGIN_MUTATION_HEADER } from '../identity.js'

export class DshMoreApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DshMoreApiError'
  }
}

async function requestPatch(patchId: string, action: string, payload: unknown): Promise<Response> {
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
  return response
}

async function responseError(response: Response): Promise<DshMoreApiError> {
  const body = await response.json().catch(() => null) as {
    error?: { code?: string; message?: string }
  } | null
  return new DshMoreApiError(body?.error?.code ?? 'http', body?.error?.message ?? `HTTP ${String(response.status)}`)
}

export async function callPatchApi<T>(patchId: string, action: string, payload: unknown): Promise<T> {
  const response = await requestPatch(patchId, action, payload)
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    value?: T
    error?: { code?: string; message?: string }
  } | null
  if (!response.ok || body?.ok !== true || body.value === undefined) throw await responseErrorFromBody(response, body)
  return body.value
}

function responseErrorFromBody(
  response: Response,
  body: { error?: { code?: string; message?: string } } | null,
): DshMoreApiError {
  return new DshMoreApiError(body?.error?.code ?? 'http', body?.error?.message ?? `HTTP ${String(response.status)}`)
}

/** Fetch a large successful payload as a Blob, avoiding JSON stringify/parse copies. */
export async function callPatchBlobApi(patchId: string, action: string, payload: unknown): Promise<Blob> {
  const response = await requestPatch(patchId, action, payload)
  if (!response.ok) throw await responseError(response)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'text/markdown') throw new DshMoreApiError('unexpected-response', '导出接口返回了未知内容。')
  return response.blob()
}

export function apiErrorText(error: unknown): string {
  if (error instanceof DshMoreApiError || error instanceof Error) return error.message
  return String(error)
}
