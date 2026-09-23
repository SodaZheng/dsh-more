import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { bindSettings, withSettings } from '../../src/platform/dsh/client/settings.js'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

function formHarness() {
  let current: SettingsScopeSnapshot<unknown> = {
    status: 'ready', value: { enabled: false }, base: {}, user: {}, revision: 1, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const form = {
    getSnapshot() { expect(this).toBe(form); return current },
    subscribe(listener: () => void) { expect(this).toBe(form); listeners.add(listener); return () => { listeners.delete(listener) } },
    set: vi.fn(async (_field: string, _value: unknown) => true),
    unset: vi.fn(async (_field: string) => true),
    mutate: vi.fn(async (_ops: unknown, _revision?: number) => true),
  }
  const get = vi.fn(() => form)
  const ctx = { get: () => ({ get }) } as unknown as Context
  const scope = bindSettings<{ enabled: boolean }>(ctx, {
    namespace: 'dsh-more',
    decode: (value) => typeof value === 'object' && value !== null && 'enabled' in value && typeof value.enabled === 'boolean'
      ? { enabled: value.enabled } : undefined,
  })
  return { form, scope, get, change: (value: unknown) => { current = { ...current, value, revision: (current.revision ?? 0) + 1 }; listeners.forEach((listener) => listener()) } }
}

describe('client settings API compatibility', () => {
  it('retains the legacy binding and decoder on older DSH', () => {
    const scope = {}
    const bind = vi.fn(() => scope)
    const ctx = { settingsScope: { bind } } as unknown as Context
    const spec = { namespace: 'dsh-more', decode: () => ({ enabled: false }) }
    expect(bindSettings(ctx, spec)).toBe(scope)
    expect(bind).toHaveBeenCalledExactlyOnceWith(spec)
  })

  it('keeps decoded snapshots stable and forwards current form notifications', () => {
    const app = formHarness()
    expect(app.get).toHaveBeenCalledExactlyOnceWith('dsh-more')
    const first = app.scope.getSnapshot()
    expect(first.value).toEqual({ enabled: false })
    expect(app.scope.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const unsubscribe = app.scope.subscribe(listener)
    app.change({ enabled: true })
    expect(listener).toHaveBeenCalledOnce()
    expect(app.scope.getSnapshot().value).toEqual({ enabled: true })
    app.change({ enabled: 'invalid' })
    expect(app.scope.getSnapshot().value).toEqual({ enabled: true })
    unsubscribe()
    app.change({ enabled: false })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('passes mutations and revisions through and surfaces refused writes', async () => {
    const app = formHarness()
    await app.scope.set('enabled', true)
    expect(app.form.set).toHaveBeenCalledExactlyOnceWith('enabled', true)
    const ops = [{ op: 'set' as const, path: ['enabled'], value: false }]
    await app.scope.mutate(ops, 4)
    expect(app.form.mutate).toHaveBeenCalledExactlyOnceWith(ops, 4)
    app.form.unset.mockResolvedValue(false)
    await expect(app.scope.unset('enabled')).rejects.toThrow('保存未被接受')
    app.form.set.mockRejectedValue(new Error('disconnected'))
    await expect(app.scope.set('enabled', false)).rejects.toThrow('disconnected')
  })

  it.each(['settingsScope', 'configForms'])('activates when only %s is provided', async (service) => {
    const ctx = new Context()
    try {
      const install = vi.fn()
      withSettings(ctx, install)
      ctx.provide(service, {})
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    } finally { await ctx.fiber.dispose() }
  })
})
