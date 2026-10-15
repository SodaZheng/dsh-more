import { describe, expect, it, vi } from 'vitest'
import { registerPatchApi } from '../../src/platform/dsh/host/api-router.js'
import { RawPatchResponse } from '../../src/platform/dsh/host/wire.js'

type FetchRoute = { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }

function setup(enabled = true) {
  const routes: FetchRoute[] = []
  const register = vi.fn((route: FetchRoute) => { routes.push(route); return () => {} })
  const handler = vi.fn((payload: unknown) => payload)
  const http = vi.fn()
  const ctx = { get: () => ({ fetch: { register } }), logger: () => ({ error: vi.fn() }), webServer: { register: http } }
  registerPatchApi(ctx as never, [{ id: 'example', routes: () => ({ echo: handler, markdown: () => new RawPatchResponse('# text', 'text/markdown') }) }], new Uint8Array(32), () => enabled)
  return { routes, handler, http }
}

function request(body = '{}', header = '1', contentType = 'application/json') {
  return new Request('http://dsh.internal/api/dsh-more/example/echo', {
    method: 'POST', body, headers: { 'x-dsh-more': header, 'content-type': contentType },
  })
}

describe('authenticated native Fetch routes', () => {
  it('registers only with Connection, leaving authentication to its owner', async () => {
    const { routes, handler, http } = setup()
    expect(http).not.toHaveBeenCalled()
    expect(routes.map(({ path }) => path)).toEqual(['/api/dsh-more/example/echo', '/api/dsh-more/example/markdown'])
    expect(routes[0]).toMatchObject({ methods: ['POST'], requestBody: 'buffered' })
    const response = await routes[0]!.fetch(request('{"text":"中文"}'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: { text: '中文' } })
    expect(handler).toHaveBeenCalledOnce()
    const markdown = await routes[1]!.fetch(request())
    expect(markdown.headers.get('content-type')).toBe('text/markdown')
    expect(markdown.headers.get('cache-control')).toBe('no-store')
    expect(await markdown.text()).toBe('# text')
  })

  it.each([
    ['header', '', 'application/json', '{}', 403],
    ['media', '1', 'text/plain', '{}', 415],
    ['json', '1', 'application/json', '{', 400],
    ['size', '1', 'application/json', 'x'.repeat(64 * 1024 + 1), 413],
  ])('rejects invalid %s without invoking the action', async (_name, header, contentType, body, status) => {
    const { routes, handler } = setup()
    const response = await routes[0]!.fetch(request(body, header, contentType))
    expect(response.status).toBe(status)
    expect(handler).not.toHaveBeenCalled()
  })

  it('preserves disabled-patch errors on the native route', async () => {
    const { routes, handler } = setup(false)
    const response = await routes[0]!.fetch(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'patch-disabled' } })
    expect(handler).not.toHaveBeenCalled()
  })
})
