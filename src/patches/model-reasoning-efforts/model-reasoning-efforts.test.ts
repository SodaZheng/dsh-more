import { describe, expect, it, vi } from 'vitest'

// The client imports dsh-client-ui-primitives for Button/Modal; loading the
// real package in Node pulls katex CSS, which vitest cannot import. Stub the
// two components used by this patch (none of these tests render a real modal).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  Modal: () => null,
}))
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { DshMoreError } from '../../platform/dsh/host/error.js'
import { hostPatch } from './host/index.js'
import { validateReasoningEfforts } from './host/validate.js'
import { LLM_PI_AI_SETTINGS_NAMESPACE, type ModelReasoningEffortsSnapshot } from './shared.js'

const NS = LLM_PI_AI_SETTINGS_NAMESPACE

function fakeRuntime(value: unknown, revision = 7) {
  const opsLog: Array<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }> = []
  const settings = {
    get: (ns: unknown) => (ns === NS ? value : undefined),
    describe: () => [{ ns: NS, revision, value, user: value, schema: {}, applies: 'live' as const }],
    mutate: async (_ns: unknown, ops: readonly SettingsPathOp[], _expectedRevision?: number) => {
      opsLog.push(...ops)
    },
    writable: true,
    documentPath: '/Users/soda/.dsh/settings.yaml',
  }
  const ctx = { settings } as unknown as Context
  const routes = hostPatch.routes({ ctx, confirmationSecret: new Uint8Array(0) })
  return { read: routes.read!, save: routes.save!, fillDefaults: routes.fillDefaults!, opsLog }
}

const SAMPLE = {
  providers: {
    acme: {
      displayName: 'Acme',
      models: [
        { id: 'model-a', contextWindow: 1000, reasoningEfforts: { high: 'high', max: 'max' } },
        { id: 'model-b', contextWindow: 1000 },
        { id: 'model-c', contextWindow: 1000, reasoningEfforts: false },
      ],
    },
    'no-models': { displayName: 'Empty', models: [] },
  },
}

describe('validateReasoningEfforts', () => {
  it('maps null and undefined to clear', () => {
    expect(validateReasoningEfforts(null)).toBeNull()
    expect(validateReasoningEfforts(undefined)).toBeNull()
  })

  it('keeps false for a non-reasoning model', () => {
    expect(validateReasoningEfforts(false)).toBe(false)
  })

  it('accepts a level dict and preserves wire spellings', () => {
    expect(validateReasoningEfforts({ low: 'low', high: 'deepseek-high', max: 'max' }))
      .toEqual({ low: 'low', high: 'deepseek-high', max: 'max' })
  })

  it('accepts off with an empty wire alongside a thinking level', () => {
    expect(validateReasoningEfforts({ off: null, low: 'low' })).toEqual({ off: null, low: 'low' })
  })

  it('rejects an off-only dict', () => {
    expect(() => validateReasoningEfforts({ off: null })).toThrow(DshMoreError)
  })

  it('rejects empty or missing wire values for non-off levels', () => {
    expect(() => validateReasoningEfforts({ high: '' })).toThrow(DshMoreError)
    expect(() => validateReasoningEfforts({ high: null })).toThrow(DshMoreError)
    expect(() => validateReasoningEfforts({ high: '  ' })).toThrow(DshMoreError)
  })

  it('rejects unknown levels, empty dicts, and non-object shapes', () => {
    expect(() => validateReasoningEfforts({ turbo: 'on' })).toThrow(DshMoreError)
    expect(() => validateReasoningEfforts({})).toThrow(DshMoreError)
    expect(() => validateReasoningEfforts([])).toThrow(DshMoreError)
    expect(() => validateReasoningEfforts('high')).toThrow(DshMoreError)
  })
})

describe('model-reasoning-efforts host routes', () => {
  it('reads one row per configured model with normalized efforts', async () => {
    const { read } = fakeRuntime(SAMPLE)
    const snapshot = await read({}) as ModelReasoningEffortsSnapshot
    expect(snapshot).toMatchObject({
      writable: true,
      documentPath: '/Users/soda/.dsh/settings.yaml',
    })
    expect(snapshot.rows).toEqual([
      { provider: 'acme', providerName: 'Acme', modelId: 'model-a', reasoningEfforts: { high: 'high', max: 'max' } },
      { provider: 'acme', providerName: 'Acme', modelId: 'model-b', reasoningEfforts: null },
      { provider: 'acme', providerName: 'Acme', modelId: 'model-c', reasoningEfforts: false },
    ])
  })

  it('returns an empty snapshot when the namespace is not registered', async () => {
    const { read } = fakeRuntime(undefined)
    expect(await read({})).toMatchObject({ rows: [], writable: true })
  })

  it('writes a dict by restating the whole providers dict', async () => {
    const { save, opsLog } = fakeRuntime(SAMPLE)
    const result = await save({ provider: 'acme', modelId: 'model-b', reasoningEfforts: { low: 'low', medium: 'medium' } })
    expect(result).toEqual({ provider: 'acme', modelId: 'model-b', reasoningEfforts: { low: 'low', medium: 'medium' } })
    expect(opsLog).toEqual([{
      op: 'set',
      path: ['providers'],
      value: {
        acme: {
          displayName: 'Acme',
          models: [
            { id: 'model-a', contextWindow: 1000, reasoningEfforts: { high: 'high', max: 'max' } },
            { id: 'model-b', contextWindow: 1000, reasoningEfforts: { low: 'low', medium: 'medium' } },
            { id: 'model-c', contextWindow: 1000, reasoningEfforts: false },
          ],
        },
        'no-models': { displayName: 'Empty', models: [] },
      },
    }])
  })

  it('writes false for a non-reasoning model', async () => {
    const { save, opsLog } = fakeRuntime(SAMPLE)
    await save({ provider: 'acme', modelId: 'model-a', reasoningEfforts: false })
    expect(opsLog).toEqual([{
      op: 'set',
      path: ['providers'],
      value: {
        acme: {
          displayName: 'Acme',
          models: [
            { id: 'model-a', contextWindow: 1000, reasoningEfforts: false },
            { id: 'model-b', contextWindow: 1000 },
            { id: 'model-c', contextWindow: 1000, reasoningEfforts: false },
          ],
        },
        'no-models': { displayName: 'Empty', models: [] },
      },
    }])
  })

  it('removes the field when clearing', async () => {
    const { save, opsLog } = fakeRuntime(SAMPLE)
    await save({ provider: 'acme', modelId: 'model-a', reasoningEfforts: null })
    expect(opsLog).toEqual([{
      op: 'set',
      path: ['providers'],
      value: {
        acme: {
          displayName: 'Acme',
          models: [
            { id: 'model-a', contextWindow: 1000 },
            { id: 'model-b', contextWindow: 1000 },
            { id: 'model-c', contextWindow: 1000, reasoningEfforts: false },
          ],
        },
        'no-models': { displayName: 'Empty', models: [] },
      },
    }])
  })

  it('rejects unknown providers and models', async () => {
    const { save } = fakeRuntime(SAMPLE)
    await expect(save({ provider: 'nope', modelId: 'model-a', reasoningEfforts: { high: 'high' } })).rejects.toThrow(DshMoreError)
    await expect(save({ provider: 'acme', modelId: 'nope', reasoningEfforts: { high: 'high' } })).rejects.toThrow(DshMoreError)
    await expect(save({ provider: 'no-models', modelId: 'x', reasoningEfforts: { high: 'high' } })).rejects.toThrow(DshMoreError)
  })

  it('rejects an invalid efforts payload before touching settings', async () => {
    const { save, opsLog } = fakeRuntime(SAMPLE)
    await expect(save({ provider: 'acme', modelId: 'model-a', reasoningEfforts: { off: null } })).rejects.toThrow(DshMoreError)
    expect(opsLog).toEqual([])
  })

  it('refuses a save when the namespace is absent', async () => {
    const { save } = fakeRuntime(undefined)
    await expect(save({ provider: 'acme', modelId: 'model-a', reasoningEfforts: { high: 'high' } })).rejects.toThrow(DshMoreError)
  })

  it('fills the default efforts onto models with none', async () => {
    const { fillDefaults, opsLog } = fakeRuntime(SAMPLE)
    const result = await fillDefaults({})
    expect(result).toEqual({ filled: 1 })
    expect(opsLog).toEqual([{
      op: 'set',
      path: ['providers'],
      value: {
        acme: {
          displayName: 'Acme',
          models: [
            { id: 'model-a', contextWindow: 1000, reasoningEfforts: { high: 'high', max: 'max' } },
            { id: 'model-b', contextWindow: 1000, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } },
            { id: 'model-c', contextWindow: 1000, reasoningEfforts: false },
          ],
        },
        'no-models': { displayName: 'Empty', models: [] },
      },
    }])
  })

  it('leaves models that already declare efforts untouched', async () => {
    const { fillDefaults, opsLog } = fakeRuntime({
      providers: {
        acme: {
          displayName: 'Acme',
          models: [
            { id: 'model-a', contextWindow: 1000, reasoningEfforts: { high: 'high', max: 'max' } },
            { id: 'model-c', contextWindow: 1000, reasoningEfforts: false },
          ],
        },
      },
    })
    const result = await fillDefaults({})
    expect(result).toEqual({ filled: 0 })
    expect(opsLog).toEqual([])
  })

  it('does nothing when the namespace is absent', async () => {
    const { fillDefaults, opsLog } = fakeRuntime(undefined)
    expect(await fillDefaults({})).toEqual({ filled: 0 })
    expect(opsLog).toEqual([])
  })
})

/**
 * Regression: the client must hand useSyncExternalStore BOUND scope methods.
 * The real SettingsScopeController declares getSnapshot/subscribe as prototype
 * methods, and React invokes them as bare functions, so passing an unbound
 * face crashes the portal (blank UI). install() must bind before the component.
 */
describe('model-reasoning-efforts client render', () => {
  const snapshot = { status: 'ready', value: { providers: {} }, writable: true, revision: 1, mode: 'host' }
  class PrototypeScope {
    constructor(private readonly state: unknown) {}
    getSnapshot() {
      return this.state
    }
    subscribe() {
      return () => undefined
    }
    set() {
      return Promise.resolve()
    }
    unset() {
      return Promise.resolve()
    }
    mutate() {
      return Promise.resolve()
    }
  }

  it('registers the effort portal into shell.overlay', async () => {
    const { clientPatch } = await import('./client/index.js')
    const { MODEL_REASONING_EFFORTS_PATCH_ID } = await import('./shared.js')
    const rawScope = new PrototypeScope(snapshot)
    let registered: { name: string | undefined; component: unknown } = { name: undefined, component: undefined }
    const ctx = {
      settingsScope: { bind: () => rawScope },
      slots: {
        inject: (_name: string, register: () => unknown) => { void register() },
        register: (options: unknown, entry: unknown) => {
          registered = { name: (options as { name?: string }).name, component: entry }
          return {}
        },
      },
    } as never
    const activation = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({ ...DEFAULT_PATCH_SETTINGS, [MODEL_REASONING_EFFORTS_PATCH_ID]: true }),
      getSettingsSnapshot: () => ({ status: 'ready' as const, value: { ...DEFAULT_PATCH_SETTINGS, [MODEL_REASONING_EFFORTS_PATCH_ID]: true }, base: {}, user: {}, writable: true, revision: 1, mode: 'host' as const }),
      set: async () => undefined,
    }
    clientPatch.install(ctx, activation)
    expect(registered.name).toBe('shell.overlay')
    expect(registered.component).toBeDefined()
  })

  it('renders the editor body with the level toggles', async () => {
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    const { EffortEditorBody } = await import('./client/index.js')
    const draft = {
      nonReasoning: false,
      levels: { high: { enabled: true, wire: 'high' }, max: { enabled: true, wire: 'max' } },
    }
    const html = renderToString(createElement(EffortEditorBody, {
      draft,
      setDraft: () => undefined,
      writable: true,
      busy: false,
    }))
    expect(html).toContain('dshmore-effort-levels')
    expect(html).toContain('该模型不支持思考')
  })

  it('renders the portal with BOUND prototype-method scope', async () => {
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    const { clientPatch } = await import('./client/index.js')
    const { MODEL_REASONING_EFFORTS_PATCH_ID } = await import('./shared.js')
    const rawScope = new PrototypeScope(snapshot)
    let component: ((props: Record<string, unknown>) => unknown) | undefined
    const ctx = {
      settingsScope: { bind: () => rawScope },
      slots: {
        inject: (_name: string, register: () => unknown) => { void register() },
        register: (_options: unknown, entry: unknown) => {
          component = entry as typeof component
          return {}
        },
      },
    } as never
    const activation = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({ ...DEFAULT_PATCH_SETTINGS, [MODEL_REASONING_EFFORTS_PATCH_ID]: true }),
      getSettingsSnapshot: () => ({ status: 'ready' as const, value: { ...DEFAULT_PATCH_SETTINGS, [MODEL_REASONING_EFFORTS_PATCH_ID]: true }, base: {}, user: {}, writable: true, revision: 1, mode: 'host' as const }),
      set: async () => undefined,
    }
    clientPatch.install(ctx, activation)
    expect(component).toBeDefined()
    const html = renderToString(createElement(component as never, {
      close: () => undefined,
      useSessions: () => ({}),
      useWorkspaces: () => ({}),
    }))
    expect(html).toContain('dshmore-effort-row-button')
  })

  it('throws when scope methods are passed unbound (documents the failure mode)', async () => {
    const { createElement } = await import('react')
    const { renderToString } = await import('react-dom/server')
    const { ModelsPageEffortPortal } = await import('./client/index.js')
    const rawScope = new PrototypeScope(snapshot)
    const activation = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({ 'message-edit': true, 'message-delete': true, 'session-delete': true, 'conversation-markdown-export': true, 'model-reasoning-efforts': true }),
      getSettingsSnapshot: () => ({ status: 'ready' as const, value: {}, base: {}, user: {}, writable: true, revision: 1, mode: 'host' as const }),
      set: async () => undefined,
    }
    // React invokes getSnapshot as a bare function; `this` is undefined and
    // accessing `this.state` throws — exactly what the bind in install prevents.
    expect(() => renderToString(createElement(ModelsPageEffortPortal, {
      scope: rawScope as never,
      activation: activation as never,
    } as never))).toThrow()
  })
})
