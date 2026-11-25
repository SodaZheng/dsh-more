import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { liveSetting } from '../../../platform/dsh/host/settings.js'
import type { HiddenWorkspaces } from '../shared.js'

/** Companion entry keeps hidden workspace state writable via DSH SettingsForms. */
export const Config: z<HiddenWorkspaces> = z.object({
  hidden: liveSetting(z.dict(z.boolean()).default({})),
})

/** Suppress auto-generated raw dictionary UI; sidebar controls manage this namespace. */
export function apply(ctx?: Context): void {
  if (ctx === undefined || typeof ctx.inject !== 'function') return
  ctx.inject(['settings'], (scope) => {
    const settings = scope.settings as typeof scope.settings & {
      configure?(presentation: { auto: boolean }, owner?: unknown): () => void
    }
    if (typeof settings.configure === 'function') {
      scope.effect(() => settings.configure!({ auto: false }, ctx.fiber))
    }
  })
}
