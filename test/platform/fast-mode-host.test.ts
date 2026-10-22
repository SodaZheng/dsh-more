import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../../src/patches/fast-mode/host/settings.js'
import { settingValue } from '../../src/platform/dsh/host/settings.js'
import { DEFAULT_FAST_MODE_SETTINGS, FAST_MODE_SETTINGS_NS } from '../../src/patches/fast-mode/shared.js'

const url = 'https://api.example/v1/responses'
const request = { method: 'POST', body: JSON.stringify({ model: 'test', input: [] }) }

beforeEach(() => vi.resetModules())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function fixture() {
  const host = await import('../../src/patches/fast-mode/host/index.js')
  const descriptor = { ns: FAST_MODE_SETTINGS_NS, value: { ...DEFAULT_FAST_MODE_SETTINGS }, revision: 7 }
  const listeners = new Map<string, (...args: any[]) => any>()
  const disposers: ReturnType<typeof vi.fn>[] = []
  const mutate = vi.fn(async (_ns: string, ops: any[], _revision?: number) => { descriptor.value = ops[0].value })
  const settings = { describe: vi.fn(() => [descriptor]), mutate }
  const ctx = { settings, on: (event: string, listener: (...args: any[]) => any) => {
    listeners.set(event, listener)
    const dispose = vi.fn(() => listeners.delete(event))
    disposers.push(dispose)
    return dispose
  } } as unknown as Context
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')))
  const dispose = host.hostPatch.setup!(ctx)
  const routes = host.hostPatch.routes({ ctx, confirmationSecret: new Uint8Array() })
  const patched = () => host.activeFastSessionStorage.run({ isFast: true }, () => host.patchFastRequest(url, request))
  const tier = () => JSON.parse(String(patched().init?.body)).service_tier
  return { host, descriptor, listeners, disposers, settings, ctx, dispose, routes, patched, tier }
}

describe('fast-mode host settings', () => {
  it('projects every existing setting as a live native Config field', () => {
    expect(Object.fromEntries(Object.entries(Config({} as never)).map(([key, value]) => [key, settingValue(value)]))).toEqual(DEFAULT_FAST_MODE_SETTINGS)
    expect(Object.keys(Config.dict!)).toEqual(Object.keys(DEFAULT_FAST_MODE_SETTINGS))
    for (const field of Object.values(Config.dict!)) expect(field.meta.volatile).toBe(true)
  })

  it('reads the existing host adapter on legacy hosts', async () => {
    const { host } = await fixture()
    const get = vi.fn(() => ({ ...DEFAULT_FAST_MODE_SETTINGS, serviceTier: 'flex' }))
    expect(host.readSettings({ settings: { get } } as unknown as Context).serviceTier).toBe('flex')
    expect(get).toHaveBeenCalledWith(FAST_MODE_SETTINGS_NS)
  })

  it('persists to the registered namespace with its revision before applying', async () => {
    const { routes, settings, tier, descriptor } = await fixture()
    let commit!: () => void
    settings.mutate.mockImplementationOnce((_ns, ops) => new Promise<void>((resolve) => {
      commit = () => { descriptor.value = ops[0].value; resolve() }
    }))
    const next = { ...DEFAULT_FAST_MODE_SETTINGS, defaultEnabled: true, serviceTier: 'flex', speed: 2,
      enableAnthropicFastMode: false, customBodyParams: { temperature: 0.5 }, customHeaders: { 'x-fast': 'yes' } }
    const save = routes.saveSettings!(next)
    expect(tier()).toBe('priority')
    expect(settings.mutate).toHaveBeenCalledExactlyOnceWith(FAST_MODE_SETTINGS_NS, [{ op: 'set', path: [], value: next }], 7)
    commit()
    await expect(save).resolves.toEqual(next)
    expect(tier()).toBe('flex')
    expect(routes.getSettings!({})).toEqual(next)
  })

  it('does not apply rejected saves or enable default acceleration', async () => {
    const { routes, settings, tier, listeners, host } = await fixture()
    const error = new Error('revision conflict')
    settings.mutate.mockRejectedValueOnce(error)
    await expect(routes.saveSettings!({ ...DEFAULT_FAST_MODE_SETTINGS, serviceTier: 'flex', defaultEnabled: true })).rejects.toBe(error)
    expect(tier()).toBe('priority')
    const stream = (async function* () { yield host.activeFastSessionStorage.getStore()?.isFast })()
    const result = listeners.get('llm/stream')!({ sessionId: 'not-enabled' }, () => stream)
    expect(result).toBe(stream)
  })

  it('rejects missing namespace or mutation support without applying settings', async () => {
    const { routes, settings, tier } = await fixture()
    settings.describe.mockReturnValueOnce([])
    await expect(routes.saveSettings!({ serviceTier: 'flex' })).rejects.toThrow('尚未注册')
    expect(settings.mutate).not.toHaveBeenCalled()
    Object.assign(settings, { mutate: undefined })
    await expect(routes.saveSettings!({ serviceTier: 'flex' })).rejects.toThrow('尚未注册')
    expect(tier()).toBe('priority')
  })

  it('applies external persisted settings updates and releases subscriptions', async () => {
    const { descriptor, listeners, tier, dispose, disposers, host } = await fixture()
    descriptor.value = { ...DEFAULT_FAST_MODE_SETTINGS, serviceTier: 'flex', defaultEnabled: true }
    listeners.get('settings/document-updated')!('another-plugin', 8)
    expect(tier()).toBe('priority')
    listeners.get('settings/document-updated')!(FAST_MODE_SETTINGS_NS, 8)
    expect(tier()).toBe('flex')
    const stream = (async function* () { yield host.activeFastSessionStorage.getStore()?.isFast })()
    const bound = listeners.get('llm/stream')!({ sessionId: 'default-enabled' }, () => stream)
    expect(await bound.next()).toEqual({ value: true, done: false })
    for (const purpose of ['session-title', 'compaction']) {
      expect(listeners.get('llm/stream')!({ purpose }, () => stream)).toBe(stream)
    }
    dispose()
    for (const disposer of disposers) expect(disposer).toHaveBeenCalledOnce()
  })

  it('preserves custom body/header and Anthropic settings', async () => {
    const { routes, host } = await fixture()
    await routes.saveSettings!({ ...DEFAULT_FAST_MODE_SETTINGS, customBodyParams: { temperature: 0.2 }, customHeaders: { 'x-fast': 'yes' } })
    const patched = host.activeFastSessionStorage.run({ isFast: true }, () => host.patchFastRequest('https://api.anthropic.com/v1/messages', {
      ...request, headers: { 'anthropic-beta': 'existing', 'content-length': '1' },
    }))
    expect(JSON.parse(String(patched.init?.body))).toMatchObject({ service_tier: 'priority', temperature: 0.2 })
    const headers = new Headers(patched.init?.headers)
    expect(headers.get('x-fast')).toBe('yes')
    expect(headers.get('anthropic-beta')).toBe('existing,fast-mode-2026-02-01')
    expect(headers.get('content-length')).toBe(String(Buffer.byteLength(String(patched.init?.body))))
  })
})

describe('fast-mode fetch interceptor', () => {
  it.each([new TypeError('network failed'), new DOMException('cancelled', 'AbortError')])('propagates %s without resending', async (error) => {
    const host = await import('../../src/patches/fast-mode/host/index.js')
    const fetch = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('fetch', fetch)
    host.installFastModeInterceptor()
    host.installFastModeInterceptor()
    await expect(host.activeFastSessionStorage.run({ isFast: true }, () => globalThis.fetch(url, request))).rejects.toBe(error)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(fetch.mock.calls[0]![1].body).service_tier).toBe('priority')
  })

  it('falls back once only when request preparation throws', async () => {
    const host = await import('../../src/patches/fast-mode/host/index.js')
    const response = new Response('ok')
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    host.installFastModeInterceptor()
    const invalid = { ...request, headers: { 'invalid header name': 'value' } }
    expect(await host.activeFastSessionStorage.run({ isFast: true }, () => globalThis.fetch(url, invalid))).toBe(response)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, invalid)
  })

  it('does not retry failures of the unmodified request', async () => {
    const host = await import('../../src/patches/fast-mode/host/index.js')
    const error = new Error('offline')
    const fetch = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('fetch', fetch)
    host.installFastModeInterceptor()
    await expect(globalThis.fetch(url, request)).rejects.toBe(error)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, request)
  })
})
