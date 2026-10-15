import { afterEach, describe, expect, it, vi } from 'vitest'
import { callPatchApi, callPatchBlobApi, DshMoreApiError } from '../../src/platform/dsh/client/api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('large patch API responses', () => {
  it('uses the desktop carrier and a directory-relative authenticated API path', async () => {
    const webFetch = vi.fn(() => { throw new Error('static desktop origin must not be fetched') })
    const carrier = { fetch: vi.fn(async function(this: unknown) {
      expect(this).toBe(carrier)
      return Response.json({ ok: true, value: { enabled: true } })
    }) }
    vi.stubGlobal('fetch', webFetch)
    vi.stubGlobal('__DSH_TRANSPORT__', carrier)
    await expect(callPatchApi('fast-mode', 'getState', { sessionId: 'one' })).resolves.toEqual({ enabled: true })
    expect(carrier.fetch).toHaveBeenCalledWith('api/dsh-more/fast-mode/getState', expect.objectContaining({
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-more': '1' },
      body: JSON.stringify({ sessionId: 'one' }),
    }))
    expect(webFetch).not.toHaveBeenCalled()
  })

  it('does not retry a failed carrier request through the wrong origin', async () => {
    const webFetch = vi.fn()
    const send = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', webFetch)
    vi.stubGlobal('__DSH_TRANSPORT__', { fetch: send })
    await expect(callPatchApi('message-delete', 'commit', {})).rejects.toMatchObject({ code: 'network', message: 'offline' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(webFetch).not.toHaveBeenCalled()
  })

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
