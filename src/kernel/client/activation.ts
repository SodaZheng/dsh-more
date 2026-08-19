import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  decodePatchSettings,
  DEFAULT_PATCH_SETTINGS,
  type PatchId,
  type PatchSettings,
} from '../../generated/patch-catalog.js'

export interface PatchActivationSource {
  getSnapshot(): PatchSettings
  getSettingsSnapshot(): SettingsScopeSnapshot<PatchSettings>
  subscribe(listener: () => void): () => void
  set(id: PatchId, enabled: boolean): Promise<void>
}

/** Stable client projection over the Host settings namespace. */
export class ClientPatchActivation implements PatchActivationSource {
  private lastScope: SettingsScopeSnapshot<PatchSettings> | undefined
  private lastValue: PatchSettings = { ...DEFAULT_PATCH_SETTINGS }

  constructor(private readonly scope: SettingsScope<PatchSettings>) {}

  getSnapshot = (): PatchSettings => {
    const snapshot = this.scope.getSnapshot()
    if (snapshot === this.lastScope) return this.lastValue
    this.lastScope = snapshot
    this.lastValue = decodePatchSettings(snapshot.value) ?? { ...DEFAULT_PATCH_SETTINGS }
    return this.lastValue
  }

  getSettingsSnapshot = (): SettingsScopeSnapshot<PatchSettings> => this.scope.getSnapshot()

  subscribe = (listener: () => void): (() => void) => this.scope.subscribe(listener)

  set = (id: PatchId, enabled: boolean): Promise<void> => this.scope.set(id, enabled)
}
