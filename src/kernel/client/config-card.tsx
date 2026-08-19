import { useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  PATCH_CATALOG,
  type PatchId,
} from '../../generated/patch-catalog.js'
import { PATCH_SETTINGS_NAMESPACE, PLUGIN_NAME } from '../../platform/dsh/identity.js'
import { styles } from '../../platform/dsh/client/styles.js'
import type { PatchActivationSource } from './activation.js'

type CardProps = PropsRuntime<'settings.plugin.item'>

export interface PatchConfigCardProps extends CardProps {
  activation: PatchActivationSource
  initiallyOpen?: boolean
}

export function PatchConfigCard({ activation, initiallyOpen = false }: PatchConfigCardProps): JSX.Element | null {
  const scope = useSyncExternalStore(
    activation.subscribe,
    activation.getSettingsSnapshot,
    activation.getSettingsSnapshot,
  )
  const settings = activation.getSnapshot()
  const [open, setOpen] = useState(initiallyOpen)
  const [busy, setBusy] = useState<ReadonlySet<PatchId>>(new Set())
  const [error, setError] = useState<string | null>(null)
  if (scope.status === 'unavailable') return null

  const update = async (id: PatchId, enabled: boolean): Promise<void> => {
    setBusy((current) => new Set([...current, id]))
    setError(null)
    try {
      await activation.set(id, enabled)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <li className={`dshmore-config-card${open ? ' dshmore-config-card-open' : ''}`}>
      <style>{styles}</style>
      <button
        type="button"
        className="dshmore-config-heading"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}设置: DSH More`}
        onClick={() => { setOpen((current) => !current) }}
      >
        <span className="dshmore-config-heading-copy">
          <strong>DSH More</strong>
          <span>动态开启或关闭独立补丁，默认全部开启。</span>
        </span>
        <IconChevronDownOutline14 className={`dshmore-config-chevron${open ? ' dshmore-config-chevron-open' : ''}`} />
      </button>
      {open && (
        <div className="dshmore-config-body">
          <div className="dshmore-config-list">
            {PATCH_CATALOG.map((patch) => {
              const waiting = busy.has(patch.id)
              return (
                <label className="dshmore-config-row" key={patch.id}>
                  <span className="dshmore-config-copy">
                    <strong>{patch.name}</strong>
                    <span>{patch.description}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={patch.name}
                    checked={settings[patch.id]}
                    disabled={scope.status !== 'ready' || !scope.writable || waiting}
                    onChange={(event) => { void update(patch.id, event.currentTarget.checked) }}
                  />
                </label>
              )
            })}
          </div>
          {scope.status === 'loading' && <p className="dshmore-config-note">正在读取插件配置…</p>}
          {scope.status === 'ready' && !scope.writable && <p className="dshmore-config-note">当前 Settings 存储为只读。</p>}
          {error !== null && <p className="dshmore-config-error">{error}</p>}
        </div>
      )}
    </li>
  )
}

export function installPatchConfigCard(ctx: ClientContext, activation: PatchActivationSource): void {
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: PATCH_SETTINGS_NAMESPACE,
    priority: 90,
    registrant: PLUGIN_NAME,
  }, (props: CardProps) => <PatchConfigCard {...props} activation={activation} />))
}
