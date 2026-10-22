import z from '@deepseek-ai/schemastery'
import { liveSetting } from '../../../platform/dsh/host/settings.js'
import { DEFAULT_FAST_MODE_SETTINGS, type FastModeSettings } from '../shared.js'

/** Companion entry projects the existing namespace into the host's settings forms. */
export const Config: z<FastModeSettings> = z.object({
  defaultEnabled: liveSetting(z.boolean().default(DEFAULT_FAST_MODE_SETTINGS.defaultEnabled)),
  serviceTier: liveSetting(z.string().default(DEFAULT_FAST_MODE_SETTINGS.serviceTier)),
  speed: liveSetting(z.number().default(DEFAULT_FAST_MODE_SETTINGS.speed)),
  enableAnthropicFastMode: liveSetting(z.boolean().default(DEFAULT_FAST_MODE_SETTINGS.enableAnthropicFastMode)),
  customBodyParams: liveSetting(z.dict(z.any()).default({})),
  customHeaders: liveSetting(z.dict(z.string()).default({})),
})

/** The host owns persistence; the fast-mode patch consumes the live descriptor. */
export function apply(): void {}
