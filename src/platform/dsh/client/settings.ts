import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot, SettingsScopeSpec } from '@deepseek-ai/dsh-client-ui-settings/client'

interface ConfigForm extends Omit<SettingsScope<unknown>, 'set' | 'unset' | 'mutate'> {
  set(...args: Parameters<SettingsScope<unknown>['set']>): Promise<boolean>
  unset(...args: Parameters<SettingsScope<unknown>['unset']>): Promise<boolean>
  mutate(...args: Parameters<SettingsScope<unknown>['mutate']>): Promise<boolean>
}

function isConfigForm(value: unknown): value is ConfigForm {
  return typeof value === 'object' && value !== null
    && ['getSnapshot', 'subscribe', 'set', 'unset', 'mutate'].every((key) => typeof Reflect.get(value, key) === 'function')
}

/** Keep feature consumers stable across the settingsScope -> configForms service rename. */
export function bindSettings<T>(ctx: Context, spec: SettingsScopeSpec<T>): SettingsScope<T> {
  const service: unknown = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
  if (typeof service !== 'object' || service === null) return ctx.settingsScope.bind(spec)
  const get: unknown = Reflect.get(service, 'get')
  const form: unknown = typeof get === 'function' ? get.call(service, spec.namespace) : undefined
  if (!isConfigForm(form)) throw new TypeError('DSH configuration form API is unavailable')
  let previous: SettingsScopeSnapshot<unknown> | undefined
  let snapshot: SettingsScopeSnapshot<T> | undefined
  let accepted: T | undefined
  const write = async (operation: Promise<boolean>): Promise<void> => {
    if (!await operation) throw new Error('保存未被接受，请刷新配置后重试。')
  }
  return {
    getSnapshot: () => {
      const current = form.getSnapshot()
      if (current === previous && snapshot !== undefined) return snapshot
      const decoded = spec.decode === undefined ? current.value as T | undefined : spec.decode(current.value)
      if (decoded !== undefined) accepted = decoded
      previous = current
      snapshot = { ...current, value: accepted }
      return snapshot
    },
    subscribe: (listener) => form.subscribe(listener),
    set: (...args) => write(form.set(...args)),
    unset: (...args) => write(form.unset(...args)),
    mutate: (...args) => write(form.mutate(...args)),
  }
}

/** Each supported DSH release provides one of these settings services. */
export function withSettings(ctx: Context, install: (scope: Context) => void): void {
  ctx.inject(['configForms'], install)
  ctx.inject(['settingsScope'], (scope) => {
    if (scope.get('configForms') === undefined) install(scope)
  })
}
