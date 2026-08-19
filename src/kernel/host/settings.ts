import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PATCH_SETTINGS,
} from '../../generated/patch-catalog.js'
import { PatchSettingsSchema } from '../../generated/host-settings-schema.js'
import { PATCH_SETTINGS_NAMESPACE as SETTINGS_NAMESPACE } from '../../platform/dsh/identity.js'
import type { HostPatchActivation } from './activation.js'

export const PATCH_SETTINGS_NAMESPACE = settingsNamespace(SETTINGS_NAMESPACE)

/** Bind persisted DSH settings to live Host patch activation. */
export function installPatchSettings(ctx: Context, activation: HostPatchActivation): void {
  let source = () => DEFAULT_PATCH_SETTINGS
  activation.apply(source())
  installSettingsSection(ctx, PATCH_SETTINGS_NAMESPACE, PatchSettingsSchema, DEFAULT_PATCH_SETTINGS, {
    setSource: (next) => { source = next },
    onChange: () => { activation.apply(source()) },
  })
}
