import { describe, expect, it } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  activeFastSessionStorage,
  bindFastStream,
  isFastSession,
  patchFastRequest,
  setFastSession,
  toggleFastSession,
} from './host/index.js'
import { DEFAULT_FAST_MODE_SETTINGS } from './shared.js'

describe('Fast Mode service tier', () => {
  it('toggles session fast mode state', () => {
    const sessionId = 'test-session-1'
    expect(isFastSession(sessionId)).toBe(false)
    expect(toggleFastSession(sessionId)).toBe(true)
    expect(isFastSession(sessionId)).toBe(true)
    setFastSession(sessionId, false)
    expect(isFastSession(sessionId)).toBe(false)
  })

  it('defaults to the Codex priority tier', () => {
    expect(DEFAULT_FAST_MODE_SETTINGS.serviceTier).toBe('priority')
  })

  it('writes service_tier priority onto a model request and does not invent a speed field', () => {
    const patched = activeFastSessionStorage.run({ isFast: true }, () => patchFastRequest('http://127.0.0.1:8317/v1/responses', {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: JSON.stringify({ model: 'gpt-6-luna', input: [] }),
    }))
    const body = JSON.parse(String(patched.init?.body))
    expect(body.service_tier).toBe('priority')
    expect(body.speed).toBeUndefined()
    expect(new Headers(patched.init?.headers).get('anthropic-beta')).toBeNull()
    expect(new Headers(patched.init?.headers).get('content-length')).toBe(String(Buffer.byteLength(String(patched.init?.body))))
  })

  it('leaves requests unchanged when fast mode is off', () => {
    const patched = patchFastRequest('http://127.0.0.1:8317/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-luna', input: [] }),
    })
    expect(JSON.parse(String(patched.init?.body)).service_tier).toBeUndefined()
  })

  it('keeps the fast context alive while the model stream is consumed later', async () => {
    const seen: Array<boolean | undefined> = []
    async function* inner() {
      await Promise.resolve()
      seen.push(activeFastSessionStorage.getStore()?.isFast)
      yield 'token'
    }
    const wrapped = bindFastStream(inner(), { isFast: true })
    const step = await wrapped.next()
    expect(step.value).toBe('token')
    expect(seen).toEqual([true])
    expect(activeFastSessionStorage.getStore()).toBeUndefined()
    void new AsyncLocalStorage()
  })
})
