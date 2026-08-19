import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { ClientPatchActivation } from '../../src/kernel/client/activation.js'
import { HostPatchActivation } from '../../src/kernel/host/activation.js'
import type { HostPatch } from '../../src/kernel/host/patch.js'
import {
  DEFAULT_PATCH_SETTINGS,
  type PatchSettings,
} from '../../src/generated/patch-catalog.js'

describe('patch activation', () => {
  it('mounts, disposes, and remounts Host patch setup independently', () => {
    const events: string[] = []
    const ids = Object.keys(DEFAULT_PATCH_SETTINGS)
    const toggledId = ids[0]
    if (toggledId === undefined) throw new Error('expected at least one generated patch')
    const patches: HostPatch[] = ids.map((id) => ({
      id,
      setup: () => {
        events.push(`mount:${id}`)
        return () => { events.push(`dispose:${id}`) }
      },
      routes: () => ({}),
    }))
    const activation = new HostPatchActivation({} as Context, patches)
    activation.apply(DEFAULT_PATCH_SETTINGS)
    expect(events).toEqual(ids.map((id) => `mount:${id}`))

    activation.apply({ ...DEFAULT_PATCH_SETTINGS, [toggledId]: false })
    expect(activation.isEnabled(toggledId)).toBe(false)
    expect(events.at(-1)).toBe(`dispose:${toggledId}`)

    activation.apply(DEFAULT_PATCH_SETTINGS)
    expect(activation.isEnabled(toggledId)).toBe(true)
    expect(events.at(-1)).toBe(`mount:${toggledId}`)

    activation.dispose()
    const remainingIds = ids.filter((id) => id !== toggledId)
    expect(events.slice(-ids.length)).toEqual([
      `dispose:${toggledId}`,
      ...remainingIds.reverse().map((id) => `dispose:${id}`),
    ])
  })

  it('projects and writes live Client settings', async () => {
    let snapshot: SettingsScopeSnapshot<PatchSettings> = {
      status: 'ready',
      value: { ...DEFAULT_PATCH_SETTINGS },
      base: DEFAULT_PATCH_SETTINGS,
      user: undefined,
      revision: 1,
      writable: true,
      mode: 'host',
    }
    const listeners = new Set<() => void>()
    const scope: SettingsScope<PatchSettings> = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async (field, value) => {
        snapshot = {
          ...snapshot,
          value: { ...snapshot.value as PatchSettings, [field]: value },
          revision: (snapshot.revision ?? 0) + 1,
        }
        for (const listener of listeners) listener()
      },
      unset: async () => undefined,
    }
    const activation = new ClientPatchActivation(scope)
    let notified = 0
    const dispose = activation.subscribe(() => { notified += 1 })
    const first = activation.getSnapshot()
    expect(activation.getSnapshot()).toBe(first)

    const patchId = Object.keys(DEFAULT_PATCH_SETTINGS)[0] as keyof PatchSettings | undefined
    if (patchId === undefined) throw new Error('expected at least one generated patch')
    await activation.set(patchId, false)
    expect(activation.getSnapshot()[patchId]).toBe(false)
    expect(notified).toBe(1)
    dispose()
  })
})
