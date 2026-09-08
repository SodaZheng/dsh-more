import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { DEFAULT_PATCH_SETTINGS, type PatchSettings } from '../../src/generated/patch-catalog.js'
import { HostPatchActivation } from '../../src/kernel/host/activation.js'
import { installPatchSettings, PATCH_SETTINGS_NAMESPACE } from '../../src/kernel/host/settings.js'

describe('DSH settings service compatibility', () => {
  it('registers through the current service and applies stored and live switches', () => {
    expect(typeof SettingsProvider.prototype.installSection).toBe('function')
    const id = 'message-delete'
    let current: PatchSettings = { ...DEFAULT_PATCH_SETTINGS, [id]: false }
    let changed = (): void => undefined
    const installSection = vi.fn<Context['settings']['installSection']>((_owner, namespace, _schema, _entry, hooks) => {
      expect(namespace).toBe(PATCH_SETTINGS_NAMESPACE)
      // The provider supplies the stored value before notifying the owner.
      hooks.setSource(() => current as typeof _entry)
      changed = hooks.onChange
      changed()
    })
    const ctx = { settings: { installSection } } as unknown as Context
    const setup = vi.fn(() => vi.fn())
    const activation = new HostPatchActivation(ctx, [{ id, setup, routes: () => ({}) }])
    installPatchSettings(ctx, activation)
    expect(installSection).toHaveBeenCalledOnce()
    expect(activation.isEnabled(id)).toBe(false)
    expect(setup).not.toHaveBeenCalled()
    current = { ...current, [id]: true }
    changed()
    expect(activation.isEnabled(id)).toBe(true)
    activation.dispose()
  })
})
