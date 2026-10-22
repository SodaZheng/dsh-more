import { Context } from '@deepseek-ai/cordis'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

function merge(base: unknown, over: unknown): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)
    || typeof over !== 'object' || over === null || Array.isArray(over)) return structuredClone(over)
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) result[key] = merge(result[key], value)
  return result
}

/** Exercise real SettingsForms; only the profile document IO is in memory. */
export async function memorySettings(ctx: Context, ns: string, user: unknown, options: {
  base?: object; writable?: boolean; register?: boolean
} = {}) {
  const base = options.base ?? {}
  let override = structuredClone(user ?? {}) as Record<string, unknown>
  let persisted: Record<string, unknown> | undefined
  let writes = 0
  let queue = Promise.resolve()
  const Config = z.dict(z.any()).volatile()
  const entry = {
    id: ns, options: { id: ns, config: merge(base, override) },
    fiber: { uid: 1, state: 2, runtime: { Config }, config: merge(base, override), ctx },
  }
  const entries = () => options.register === false ? [] : [entry]
  ctx.provide('configEditor', {
    entries,
    configuration: () => entries().map((entry) => ({ entry, inherited: base, override })),
    edit: (_entry: unknown, change: (raw: unknown, inherited: unknown) => Record<string, unknown>) => {
      const operation = queue.then(() => {
        override = change(override, base)
        persisted = structuredClone(override)
        writes++
        entry.options.config = merge(base, override)
        entry.fiber.config = merge(base, override)
      })
      queue = operation.catch(() => {})
      return operation
    },
  })
  // Suppress legacy-document import: this fixture has no filesystem profile.
  ctx.provide('profileContext', { home: '/nonexistent-dsh-more-settings-test', name: 'test' })
  ctx.provide('loader', { await: () => Promise.resolve() })
  class Forms extends SettingsForms { override get writable() { return options.writable ?? true } }
  await ctx.plugin(Forms)
  return { stored: () => persisted, writes: () => writes }
}
