import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { hostPatch } from './host/index.js'
import { Config, apply as applyCompanion } from './host/settings.js'
import {
  hideWorkspace,
  installWorkspaceRegistryHooks,
  unhideAllWorkspaces,
  unhideWorkspace,
} from './host/hide.js'
import { decodeHiddenWorkspaces, HIDDEN_WORKSPACES_NAMESPACE } from './shared.js'

function createMockContext(options: {
  writable?: boolean
  registered?: boolean
  legacy?: boolean
  initialHidden?: Record<string, boolean>
  workspaces?: Map<string, { id: string; path: string; title: string; sessionIds: string[] }>
} = {}) {
  const hidden: Record<string, boolean> = { ...(options.initialHidden ?? {}) }
  const workspaces = options.workspaces ?? new Map([
    ['ws-1', { id: 'ws-1', path: '/projects/alpha', title: 'Alpha', sessionIds: ['s-1', 's-2'] }],
    ['ws-2', { id: 'ws-2', path: '/projects/beta', title: 'Beta', sessionIds: ['s-3'] }],
  ])

  const mutate = vi.fn(async (_ns: string, ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>) => {
    for (const op of ops) {
      const key = op.path[1]
      if (op.path[0] === 'hidden' && typeof key === 'string') {
        if (op.op === 'set' && typeof op.value === 'boolean') hidden[key] = op.value
        else if (op.op === 'unset') delete hidden[key]
      }
    }
  })

  const settings = options.legacy
    ? {
        writable: options.writable ?? true,
        get: vi.fn((ns: string) => ns === HIDDEN_WORKSPACES_NAMESPACE ? { hidden: { ...hidden } } : undefined),
        register: vi.fn(),
        mutate,
      }
    : {
        writable: options.writable ?? true,
        describe: vi.fn(() => (options.registered ?? true)
          ? [{ ns: HIDDEN_WORKSPACES_NAMESPACE, value: { hidden: { ...hidden } } }]
          : []),
        mutate,
      }

  const registry = {
    get: vi.fn((id: WorkspaceId) => workspaces.get(id) as unknown as Workspace | undefined),
    resolveByPath: vi.fn(async function (this: unknown, targetPath: string) {
      expect(this).toBeDefined()
      for (const ws of workspaces.values()) {
        if (ws.path === targetPath) return ws as unknown as Workspace
      }
      return undefined
    }),
    create: vi.fn(async function (this: unknown, targetPath: string, title?: string) {
      expect(this).toBeDefined()
      for (const ws of workspaces.values()) {
        if (ws.path === targetPath) return ws as unknown as Workspace
      }
      const created = { id: `ws-${workspaces.size + 1}`, path: targetPath, title: title ?? 'New', sessionIds: [] }
      workspaces.set(created.id, created)
      return created as unknown as Workspace
    }),
    delete: vi.fn(async function (this: unknown, id: WorkspaceId) {
      expect(this).toBeDefined()
      return workspaces.delete(id)
    }),
  }

  const effects: Array<() => void> = []
  const ctx = {
    settings,
    workspaceRegistry: registry,
    logger: { warn: vi.fn() },
    inject: vi.fn((_deps: string[], callback: (scope: Context) => void) => {
      const scope = {
        settings,
        workspaceRegistry: registry,
        logger: ctx.logger,
        effect: (fn: () => (() => void) | void) => {
          const dispose = fn()
          if (typeof dispose === 'function') effects.push(dispose)
          return () => {}
        },
      } as unknown as Context
      callback(scope)
      return {
        dispose: async () => {
          while (effects.length > 0) effects.pop()?.()
        },
      }
    }),
  } as unknown as Context

  return { ctx, hidden, workspaces, settings, registry, mutate }
}

describe('workspace-hide shared decoder', () => {
  it('decodes boolean dictionaries and strips false entries', () => {
    expect(decodeHiddenWorkspaces({ hidden: { a: true, b: false } })).toEqual({ hidden: { a: true } })
    expect(decodeHiddenWorkspaces({ hidden: {} })).toEqual({ hidden: {} })
    expect(decodeHiddenWorkspaces(null)).toBeUndefined()
    expect(decodeHiddenWorkspaces({})).toBeUndefined()
    expect(decodeHiddenWorkspaces({ hidden: [] })).toBeUndefined()
    expect(decodeHiddenWorkspaces({ hidden: { a: 'yes' } })).toBeUndefined()
  })
})

describe('workspace-hide host routes and registry hooks', () => {
  it('hides, unhides, and unhides all workspaces idempotently without mutating native workspace records', async () => {
    const { ctx, hidden, workspaces, mutate } = createMockContext()

    await expect(hideWorkspace(ctx, { workspaceId: 'ws-1' })).resolves.toEqual({ workspaceId: 'ws-1', hidden: true })
    expect(hidden).toEqual({ 'ws-1': true })
    expect(workspaces.get('ws-1')?.sessionIds).toEqual(['s-1', 's-2'])

    // Idempotent second hide should not mutate again
    mutate.mockClear()
    await expect(hideWorkspace(ctx, { workspaceId: 'ws-1' })).resolves.toEqual({ workspaceId: 'ws-1', hidden: true })
    expect(mutate).not.toHaveBeenCalled()

    await expect(hideWorkspace(ctx, { workspaceId: 'ws-2' })).resolves.toEqual({ workspaceId: 'ws-2', hidden: true })
    await expect(unhideWorkspace(ctx, { workspaceId: 'ws-1' })).resolves.toEqual({ workspaceId: 'ws-1', hidden: false })
    expect(hidden).toEqual({ 'ws-2': true })

    await expect(unhideAllWorkspaces(ctx)).resolves.toEqual({ restoredIds: ['ws-2'] })
    expect(hidden).toEqual({})
  })

  it('rejects unknown workspaces, invalid payloads, read-only settings, and unregistered namespace', async () => {
    const missing = createMockContext()
    await expect(hideWorkspace(missing.ctx, { workspaceId: 'unknown' })).rejects.toMatchObject({ status: 404 })
    await expect(hideWorkspace(missing.ctx, {})).rejects.toMatchObject({ status: 400 })
    await expect(unhideWorkspace(missing.ctx, { workspaceId: '' })).rejects.toMatchObject({ status: 400 })

    const readonly = createMockContext({ writable: false })
    await expect(hideWorkspace(readonly.ctx, { workspaceId: 'ws-1' })).rejects.toMatchObject({ status: 403 })
    await expect(unhideWorkspace(readonly.ctx, { workspaceId: 'ws-1' })).rejects.toMatchObject({ status: 403 })

    const unregistered = createMockContext({ registered: false })
    await expect(hideWorkspace(unregistered.ctx, { workspaceId: 'ws-1' })).rejects.toMatchObject({ status: 409 })
  })

  it('auto-unhides hidden workspaces when re-added via resolveByPath/create and cleans up on delete', async () => {
    const { ctx, hidden, registry, workspaces } = createMockContext({
      initialHidden: { 'ws-1': true, 'ws-2': true },
    })
    const caller = { tag: 'cordis-proxy' }
    const dispose = hostPatch.setup!(ctx)

    // Re-adding directory triggers resolveByPath and preserves original title + sessionIds
    const resolved = await registry.resolveByPath.call(caller, '/projects/alpha')
    expect(resolved?.id).toBe('ws-1')
    expect(resolved?.sessionIds).toEqual(['s-1', 's-2'])
    expect(hidden['ws-1']).toBeUndefined()
    expect(hidden['ws-2']).toBe(true)

    // Re-adding via create() also unhides existing hidden workspace
    hidden['ws-1'] = true
    const created = await registry.create.call(caller, '/projects/alpha')
    expect(created.id).toBe('ws-1')
    expect(hidden['ws-1']).toBeUndefined()

    // Deleting a hidden workspace removes its hidden marker
    expect(await registry.delete.call(caller, 'ws-2' as WorkspaceId)).toBe(true)
    expect(hidden['ws-2']).toBeUndefined()
    expect(workspaces.has('ws-2')).toBe(false)

    // Disposing restores original descriptors cleanly
    dispose()
    hidden['ws-1'] = true
    await registry.resolveByPath.call(caller, '/projects/alpha')
    expect(hidden['ws-1']).toBe(true)
  })

  it('registers legacy schema on older hosts and suppresses auto-form on companion settings entry', () => {
    const legacy = createMockContext({ legacy: true })
    const dispose = hostPatch.setup!(legacy.ctx)
    expect(legacy.settings.register).toHaveBeenCalledWith(HIDDEN_WORKSPACES_NAMESPACE, expect.anything())
    dispose()

    const configure = vi.fn(() => () => {})
    const effect = vi.fn((fn: () => void) => fn())
    const companionCtx = {
      fiber: { id: 'companion' },
      inject: (_deps: string[], fn: (scope: Context) => void) => {
        fn({ settings: { configure }, effect } as unknown as Context)
      },
    } as unknown as Context
    expect(Config.dict?.hidden).toBeDefined()
    applyCompanion(companionCtx)
    expect(configure).toHaveBeenCalledWith({ auto: false }, companionCtx.fiber)
  })

  it('preserves a later wrapper on teardown instead of clobbering it', () => {
    const { ctx, registry } = createMockContext()
    const dispose = installWorkspaceRegistryHooks(ctx)
    const laterResolve = vi.fn(async () => undefined)
    registry.resolveByPath = laterResolve
    dispose()
    expect(registry.resolveByPath).toBe(laterResolve)
  })
})
