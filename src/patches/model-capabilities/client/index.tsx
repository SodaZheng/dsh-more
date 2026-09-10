import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
export type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import { readCapabilities } from './api.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import { LLM_PI_AI_SETTINGS_NAMESPACE, LLM_DEEPSEEK_SETTINGS_NAMESPACE, DEEPSEEK_PROVIDER, MODEL_CAPABILITIES_PATCH_ID, type ModelCapabilitiesSnapshot, type ModelSettingsNamespace } from '../shared.js'
import { CapabilitiesEditorModal, summaryLabel } from './editor.js'
import { findModelEntries, modelIdOf, providerRouteOf } from './model-entries.js'
import { capabilitiesStyles } from './styles.js'

const BUTTON_ATTR = 'data-dshmore-model-capabilities'

export function ModelsPageCapabilitiesPortal({ scope, deepseekScope, activation }: {
  deepseekScope: SettingsScope<unknown>
  scope: SettingsScope<unknown>
  activation: PatchActivationSource
}): JSX.Element | null {
  const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot, activation.getSnapshot)
  const enabled = settings[MODEL_CAPABILITIES_PATCH_ID]
  const scopeSnapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
  const deepseekSnapshot = useSyncExternalStore(deepseekScope.subscribe, deepseekScope.getSnapshot, deepseekScope.getSnapshot)
  const [editing, setEditing] = useState<{ namespace: ModelSettingsNamespace; provider: string; modelId: string } | null>(null)
  const [data, setData] = useState<ModelCapabilitiesSnapshot | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => {
    let cancelled = false
    if (!enabled) {
      setEditing(null)
      setData(null)
      return
    }
    // Reading a page never declares capabilities on the user's behalf.
    void readCapabilities().then((snapshot) => {
      if (!cancelled) setData(snapshot)
    }).catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [enabled, scopeSnapshot, deepseekSnapshot])

  const syncButtons = useCallback((): void => {
    if (!enabled) return
    const active = new Set<HTMLElement>()
    for (const entry of findModelEntries()) {
      const provider = providerRouteOf(entry)
      const modelId = modelIdOf(entry)
      const modelRow = entry.querySelector('[class*="modelRow"]')
      if (provider === null || modelId === null || modelRow === null) continue
      active.add(entry)
      let button = entry.querySelector<HTMLButtonElement>(`[${BUTTON_ATTR}]`)
      if (button === null) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshmore-capabilities-button'
        button.setAttribute(BUTTON_ATTR, '')
        button.addEventListener('click', () => {
          const route = button?.dataset.provider
          const model = button?.dataset.model
          if (route !== undefined && model !== undefined) setEditing({ namespace: route === DEEPSEEK_PROVIDER ? LLM_DEEPSEEK_SETTINGS_NAMESPACE : LLM_PI_AI_SETTINGS_NAMESPACE, provider: route, modelId: model })
        })
        entry.insertBefore(button, modelRow.nextSibling)
      }
      if (button.dataset.provider !== provider) button.dataset.provider = provider
      if (button.dataset.model !== modelId) button.dataset.model = modelId
      const row = dataRef.current?.rows.find((item) => item.provider === provider && item.modelId === modelId)
      const text = row === undefined ? '模型能力 · 识图 / 思考类型' : `模型能力 · ${summaryLabel(row)}`
      // Avoid observer loops caused by replacing unchanged text nodes.
      if (button.textContent !== text) button.textContent = text
    }
    document.querySelectorAll<HTMLButtonElement>(`[${BUTTON_ATTR}]`).forEach((button) => {
      if (button.parentElement === null || !active.has(button.parentElement)) button.remove()
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let frame: number | null = null
    const schedule = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => { frame = null; syncButtons() })
    }
    syncButtons()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('input', schedule)
    document.addEventListener('change', schedule)
    return () => {
      observer.disconnect()
      document.removeEventListener('input', schedule)
      document.removeEventListener('change', schedule)
      if (frame !== null) window.cancelAnimationFrame(frame)
      document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((element) => element.remove())
    }
  }, [enabled, syncButtons])
  useEffect(() => { if (enabled) syncButtons() }, [enabled, syncButtons, data])

  if (!enabled) return null
  return (
    <>
      <style>{capabilitiesStyles}</style>
      {editing !== null && <CapabilitiesEditorModal key={`${editing.provider}/${editing.modelId}`}
        {...editing} onClose={() => { setEditing(null) }} onSaved={setData} />}
    </>
  )
}

export const clientPatch: ClientPatch = {
  id: MODEL_CAPABILITIES_PATCH_ID,
  install: (ctx: ClientContext, activation: PatchActivationSource) => {
    const bindScope = (namespace: ModelSettingsNamespace): SettingsScope<unknown> => {
      const scope = ctx.settingsScope.bind<unknown>({ namespace })
      // DSH scope methods live on the prototype. React invokes them bare, so
      // bind once here to preserve the controller's receiver.
      return {
        getSnapshot: scope.getSnapshot.bind(scope), subscribe: scope.subscribe.bind(scope),
        set: scope.set.bind(scope), unset: scope.unset.bind(scope), mutate: scope.mutate.bind(scope),
      }
    }
    const boundScope = bindScope(LLM_PI_AI_SETTINGS_NAMESPACE)
    const deepseekScope = bindScope(LLM_DEEPSEEK_SETTINGS_NAMESPACE)
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: `${PLUGIN_NAME}-${MODEL_CAPABILITIES_PATCH_ID}`, order: 90,
    }, () => <ModelsPageCapabilitiesPortal scope={boundScope} deepseekScope={deepseekScope} activation={activation} />))
  },
}
