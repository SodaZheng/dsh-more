import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PATCH_SETTINGS,
} from '../../generated/patch-catalog.js'
import { PatchSettingsSchema } from '../../generated/host-settings-schema.js'
import { PATCH_SETTINGS_NAMESPACE as SETTINGS_NAMESPACE } from '../../platform/dsh/identity.js'
import type { HostPatchActivation } from './activation.js'

export const PATCH_SETTINGS_NAMESPACE = SETTINGS_NAMESPACE

/** Bind persisted DSH settings to live Host patch activation. */
export function installPatchSettings(ctx: Context, activation: HostPatchActivation): void {
  let source = () => DEFAULT_PATCH_SETTINGS
  ctx.settings.installSection(ctx, PATCH_SETTINGS_NAMESPACE, PatchSettingsSchema, DEFAULT_PATCH_SETTINGS, {
    setSource: (next) => { source = next },
    onChange: () => { activation.apply(source()) },
  })
}
