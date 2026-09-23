import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_PATCH_SETTINGS,
  decodePatchSettings,
} from '../../generated/patch-catalog.js'
import { PatchSettingsSchema } from '../../generated/host-settings-schema.js'
import { PATCH_SETTINGS_NAMESPACE as SETTINGS_NAMESPACE } from '../../platform/dsh/identity.js'
import { liveSetting, settingValue } from '../../platform/dsh/host/settings.js'
import type { HostPatchActivation } from './activation.js'

export const PATCH_SETTINGS_NAMESPACE = SETTINGS_NAMESPACE

export const PatchConfig = z.object(Object.fromEntries(
  Object.entries(PatchSettingsSchema.dict ?? {}).map(([key, schema]) => [key, liveSetting(schema)]),
))

/** Bind persisted DSH settings to live Host patch activation. */
export function installPatchSettings(ctx: Context, activation: HostPatchActivation, config: unknown = DEFAULT_PATCH_SETTINGS): void {
  if (typeof ctx.settings.installSection !== 'function') {
    const refresh = (): void => {
      const values = typeof config === 'object' && config !== null
        ? Object.fromEntries(Object.entries(config).map(([key, value]) => [key, settingValue(value)]))
        : config
      const settings = decodePatchSettings(values)
      if (settings === undefined) throw new TypeError('Invalid DSH More patch configuration')
      activation.apply(settings)
    }
    ctx.on('loader/volatile-update', refresh)
    refresh()
    return
  }
  let source = () => DEFAULT_PATCH_SETTINGS
  ctx.settings.installSection(ctx, PATCH_SETTINGS_NAMESPACE, PatchSettingsSchema, DEFAULT_PATCH_SETTINGS, {
    setSource: (next) => { source = next },
    onChange: () => { activation.apply(source()) },
  })
}
