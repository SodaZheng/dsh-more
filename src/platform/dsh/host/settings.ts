import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** DSH 0.1.7 projects volatile Config fields; older hosts use registered sections. */
export function liveSetting<T>(schema: z<T>): z<T> {
  const volatile: unknown = Reflect.get(schema, 'volatile')
  return typeof volatile === 'function' ? volatile.call(schema) : schema
}

/** New Config fields are stable references whose current value is read with get(). */
export function settingValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const get: unknown = Reflect.get(value, 'get')
  return typeof get === 'function' ? get.call(value) : value
}

/** Read the public descriptor projection when the legacy settings store is absent. */
export function readSettings(ctx: Context, namespace: string): unknown {
  if (typeof ctx.settings.get === 'function') return ctx.settings.get(namespace)
  return ctx.settings.describe().find((entry) => entry.ns === namespace)?.value
}
