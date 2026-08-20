import { afterEach, describe, expect, it, vi } from 'vitest'
import { callPatchBlobApi, DshMoreApiError } from '../../src/platform/dsh/client/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('large patch API responses', () => {
  it('keeps successful Markdown as a Blob instead of parsing a JSON envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# transcript\n', {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })))

    const result = await callPatchBlobApi('conversation-markdown-export', 'render', { sessionId: 'session-1' })
    expect(await result.text()).toBe('# transcript\n')
  })

  it('still decodes structured errors from a raw-response route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'session-busy', message: 'busy' },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(callPatchBlobApi('conversation-markdown-export', 'render', {})).rejects.toEqual(
      expect.objectContaining<Partial<DshMoreApiError>>({ code: 'session-busy', message: 'busy' }),
    )
  })
})
