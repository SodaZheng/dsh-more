import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { HostPatch } from '../../../kernel/host/patch.js'
import {
  FAST_MODE_PATCH_ID,
  FAST_MODE_SETTINGS_NS,
  DEFAULT_FAST_MODE_SETTINGS,
  type FastModeSettings,
} from '../shared.js'

export interface FastModeStore {
  sessionId?: string | undefined
  isFast: boolean
}

export const activeFastSessionStorage = new AsyncLocalStorage<FastModeStore>()

const fastSessions = new Set<string>()

export function isFastSession(sessionId?: string): boolean {
  if (!sessionId) return false
  return fastSessions.has(sessionId)
}

export function setFastSession(sessionId: string, enabled: boolean): void {
  if (enabled) fastSessions.add(sessionId)
  else fastSessions.delete(sessionId)
}

export function toggleFastSession(sessionId: string): boolean {
  const next = !fastSessions.has(sessionId)
  setFastSession(sessionId, next)
  return next
}

let interceptorInstalled = false
let currentSettings: FastModeSettings = { ...DEFAULT_FAST_MODE_SETTINGS }

export function readSettings(ctx: Context): FastModeSettings {
  const descriptor = ctx.settings?.describe?.().find((entry: any) => entry.ns === FAST_MODE_SETTINGS_NS)
  if (!descriptor || typeof descriptor.value !== 'object' || descriptor.value === null) {
    return { ...DEFAULT_FAST_MODE_SETTINGS }
  }
  const val = descriptor.value as Partial<FastModeSettings>
  return {
    defaultEnabled: typeof val.defaultEnabled === 'boolean' ? val.defaultEnabled : false,
    serviceTier: typeof val.serviceTier === 'string' && val.serviceTier ? val.serviceTier : 'priority',
    speed: typeof val.speed === 'number' && val.speed > 0 ? val.speed : 1.5,
    enableAnthropicFastMode: typeof val.enableAnthropicFastMode === 'boolean' ? val.enableAnthropicFastMode : true,
    customBodyParams: typeof val.customBodyParams === 'object' && val.customBodyParams !== null ? val.customBodyParams : {},
    customHeaders: typeof val.customHeaders === 'object' && val.customHeaders !== null ? val.customHeaders : {},
  }
}

function bodyText(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return undefined
}

function codexFastTier(value: string | undefined): string {
  const tier = (value ?? '').trim().toLowerCase()
  if (tier === '' || tier === 'fast' || tier === 'priority') return 'priority'
  return tier
}

function isModelPayload(value: Record<string, unknown>): boolean {
  return typeof value.model === 'string' && ('messages' in value || 'input' in value || 'contents' in value)
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** Apply Codex/OpenAI Fast to one outbound model call. Unknown fields such as speed are not invented. */
export function patchFastRequest(input: RequestInfo | URL, init?: RequestInit): { input: RequestInfo | URL, init: RequestInit | undefined } {
  const store = activeFastSessionStorage.getStore()
  if (!store?.isFast || init?.body == null) return { input, init }
  const text = bodyText(init.body)
  if (text === undefined) return { input, init }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { input, init } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { input, init }
  const body = parsed as Record<string, unknown>
  if (!isModelPayload(body)) return { input, init }
  // CLIProxyAPI drops every service_tier except the exact string "priority".
  body.service_tier = codexFastTier(currentSettings.serviceTier)
  if (currentSettings.customBodyParams) Object.assign(body, currentSettings.customBodyParams)
  const nextBody = JSON.stringify(body)
  const headers = new Headers(init.headers)
  if (headers.has('content-length')) headers.set('content-length', String(Buffer.byteLength(nextBody)))
  const url = requestUrl(input)
  if (currentSettings.enableAnthropicFastMode && /anthropic\.com|\/v1\/messages\b/.test(url)) {
    const beta = headers.get('anthropic-beta')
    headers.set('anthropic-beta', beta && !beta.includes('fast-mode') ? `${beta},fast-mode-2026-02-01` : (beta ?? 'fast-mode-2026-02-01'))
  }
  if (currentSettings.customHeaders) {
    for (const [name, value] of Object.entries(currentSettings.customHeaders)) headers.set(name, value)
  }
  return { input, init: { ...init, body: nextBody, headers } }
}

/**
 * The agent loop iterates the model stream after llm/stream listeners return.
 * Creating the iterator inside AsyncLocalStorage is not enough: the fetch runs
 * on a later next() call, so each pull re-enters the fast context.
 */
export function bindFastStream<T>(stream: AsyncIterable<T>, store: FastModeStore): AsyncIterable<T> & AsyncIterator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  const pull = <R>(run: () => Promise<R>): Promise<R> => activeFastSessionStorage.run(store, run)
  const bound: AsyncIterable<T> & AsyncIterator<T> = {
    [Symbol.asyncIterator]() { return bound },
    next: () => pull(() => iterator.next()),
    return: (value?: unknown) => pull(() => iterator.return?.(value as T | undefined) ?? Promise.resolve({ done: true as const, value: undefined })),
    throw: (error?: unknown) => pull(() => iterator.throw?.(error) ?? Promise.reject(error)),
  }
  return bound
}

export function installFastModeInterceptor(): void {
  if (interceptorInstalled) return
  interceptorInstalled = true
  const originalFetch = globalThis.fetch
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const patched = patchFastRequest(input, init)
      return await originalFetch.call(this, patched.input, patched.init)
    } catch (error) {
      console.warn('fast-mode fetch interceptor error, sending the original request', error)
      return originalFetch.call(this, input, init)
    }
  }
}

export const hostPatch: HostPatch = {
  id: FAST_MODE_PATCH_ID,
  setup: (ctx: Context): (() => void) => {
    currentSettings = readSettings(ctx)
    installFastModeInterceptor()
    const dispose = ctx.on('llm/stream' as any, (options: { sessionId?: unknown, purpose?: unknown }, next: () => AsyncIterable<unknown>) => {
      if (options?.purpose === 'session-title' || options?.purpose === 'compaction') return next()
      const sessionId = options?.sessionId === undefined ? undefined : String(options.sessionId)
      const enabled = (sessionId !== undefined && isFastSession(sessionId)) || currentSettings.defaultEnabled
      if (!enabled) return next()
      return bindFastStream(next(), { sessionId, isFast: true })
    }, { global: true, prepend: true } as any)
    return () => { if (typeof dispose === 'function') dispose() }
  },
  routes: ({ ctx }) => ({
    getState: (payload: any) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
      return { enabled: sessionId ? isFastSession(sessionId) : false, settings: readSettings(ctx) }
    },
    toggle: (payload: any) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) throw new Error('缺少 sessionId')
      return { enabled: toggleFastSession(sessionId) }
    },
    set: (payload: any) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId) throw new Error('缺少 sessionId')
      const enabled = Boolean(payload?.enabled)
      setFastSession(sessionId, enabled)
      return { enabled }
    },
    getSettings: () => readSettings(ctx),
    saveSettings: async (payload: any) => {
      if (typeof payload !== 'object' || payload === null) throw new Error('无效的配置内容')
      const descriptor = ctx.settings?.describe?.().find((entry: any) => entry.ns === FAST_MODE_SETTINGS_NS)
      const next: FastModeSettings = {
        defaultEnabled: Boolean(payload.defaultEnabled),
        serviceTier: typeof payload.serviceTier === 'string' && payload.serviceTier ? payload.serviceTier : 'priority',
        speed: typeof payload.speed === 'number' && payload.speed > 0 ? payload.speed : 1.5,
        enableAnthropicFastMode: payload.enableAnthropicFastMode !== false,
        customBodyParams: typeof payload.customBodyParams === 'object' && payload.customBodyParams !== null ? payload.customBodyParams : {},
        customHeaders: typeof payload.customHeaders === 'object' && payload.customHeaders !== null ? payload.customHeaders : {},
      }
      currentSettings = next
      if (typeof ctx.settings?.mutate === 'function') {
        await (ctx.settings.mutate as any)(FAST_MODE_SETTINGS_NS, [{ op: 'set', path: [], value: next }], descriptor?.revision ?? 0)
      }
      return next
    },
  }),
}
