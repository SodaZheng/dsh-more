import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import {
  LLM_PI_AI_SETTINGS_NAMESPACE,
  MODEL_REASONING_EFFORTS_PATCH_ID,
  THINKING_LEVELS,
  type ModelReasoningEfforts,
  type ModelReasoningEffortsSnapshot,
  type SaveModelReasoningEffortsPayload,
  type ThinkingLevel,
} from '../shared.js'

type OverlayProps = PropsRuntime<'shell.overlay'>

/** Attribute marking a reasoning-effort button injected into a model entry. */
const EFFORT_BUTTON_ATTR = 'data-dshmore-effort'

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '不思考',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

/** One level's editing state inside a model's draft. */
interface LevelDraft {
  enabled: boolean
  wire: string
}

/** One model's in-progress reasoning-effort draft. */
export interface ModelDraft {
  nonReasoning: boolean
  levels: Partial<Record<ThinkingLevel, LevelDraft>>
}

function emptyDraft(): ModelDraft {
  return { nonReasoning: false, levels: {} }
}

function draftFromServer(efforts: ModelReasoningEfforts | null): ModelDraft {
  if (efforts === false) return { nonReasoning: true, levels: {} }
  if (efforts !== null && typeof efforts === 'object') {
    const levels: Partial<Record<ThinkingLevel, LevelDraft>> = {}
    for (const level of THINKING_LEVELS) {
      const wire = efforts[level]
      if (wire !== undefined) levels[level] = { enabled: true, wire: wire ?? '' }
    }
    return { nonReasoning: false, levels }
  }
  return emptyDraft()
}

/** Build the stored dict from a draft; `off` keeps an empty wire ("send nothing"). */
function buildDict(draft: ModelDraft): Partial<Record<ThinkingLevel, string | null>> {
  const dict: Partial<Record<ThinkingLevel, string | null>> = {}
  for (const level of THINKING_LEVELS) {
    const entry = draft.levels[level]
    if (entry === undefined || !entry.enabled) continue
    dict[level] = level === 'off' ? null : entry.wire
  }
  return dict
}

/** Compact state label for a model's button summary. */
function summaryLabel(efforts: ModelReasoningEfforts | null): string {
  if (efforts === false) return '不支持思考'
  if (efforts === null || typeof efforts !== 'object') return '未配置'
  const parts = THINKING_LEVELS
    .filter((level) => level !== 'off' && efforts[level] !== undefined)
    .map((level) => LEVEL_LABELS[level])
  return parts.length === 0 ? '未配置' : parts.join('、')
}

/**
 * Locate every model row of every open model catalog in the shipped Models
 * settings page (the provider editor's 模型目录). The classes are the models
 * package's own CSS-module hashes, stable per build.
 */
function findModelEntries(): HTMLElement[] {
  const entries: HTMLElement[] = []
  const catalogs = document.querySelectorAll<HTMLElement>('[class*="modelCatalog"]')
  for (const catalog of catalogs) {
    for (const entry of catalog.querySelectorAll<HTMLElement>('[class*="modelEntry"]')) entries.push(entry)
  }
  return entries
}

/**
 * Resolve the provider route for one model entry: the editor header's route
 * span when the route differs from the display name, else the owning provider
 * card's display name (which for such providers equals the route). Returns
 * null for the custom-provider creation card, which has no saved provider yet.
 */
function providerRouteOf(entry: HTMLElement): string | null {
  const editor = entry.closest('[class*="editor"]')
  if (editor === null) return null
  const routeSpan = editor.querySelector<HTMLElement>('[class*="editorRoute"]')
  const route = routeSpan?.textContent?.trim()
  if (route !== undefined && route !== '') return route
  const rowCard = editor.closest('[class*="rowCard"]')
  const name = rowCard?.querySelector<HTMLElement>('[class*="rowName"]')?.textContent?.trim()
  return name !== undefined && name !== '' ? name : null
}

/** Resolve the model id from a model entry's first row input (the id field). */
function modelIdOf(entry: HTMLElement): string | null {
  const input = entry.querySelector<HTMLInputElement>('[class*="modelRow"] input[type="text"]')
  const id = input?.value.trim()
  return id !== undefined && id !== '' ? id : null
}

/**
 * The level toggles + wire-value inputs shared by the editor modal. Draft
 * state lives in the caller so the modal survives models-page re-renders.
 */
export function EffortEditorBody({ draft, setDraft, writable, busy }: {
  draft: ModelDraft
  setDraft: (updater: (current: ModelDraft) => ModelDraft) => void
  writable: boolean
  busy: boolean
}): JSX.Element {
  const toggleLevel = (level: ThinkingLevel, enabled: boolean): void => {
    setDraft((current) => {
      const existing = current.levels[level]
      const levels = { ...current.levels }
      levels[level] = existing === undefined
        ? { enabled, wire: level === 'off' ? '' : level }
        : { ...existing, enabled }
      return { ...current, levels }
    })
  }

  const setWire = (level: ThinkingLevel, wire: string): void => {
    setDraft((current) => {
      const existing = current.levels[level]
      if (existing === undefined) return current
      return { ...current, levels: { ...current.levels, [level]: { ...existing, wire } } }
    })
  }

  return (
    <div className="dshmore-effort-editor">
      <label className="dshmore-effort-switch">
        <input
          type="checkbox"
          role="switch"
          checked={draft.nonReasoning}
          disabled={!writable || busy}
          onChange={(event) => { setDraft((current) => ({ ...current, nonReasoning: event.currentTarget.checked })) }}
        />
        <span>该模型不支持思考（reasoningEfforts: false）</span>
      </label>
      {!draft.nonReasoning && (
        <div className="dshmore-effort-levels">
          {THINKING_LEVELS.map((level) => {
            const entry = draft.levels[level]
            const enabled = entry?.enabled === true
            return (
              <label className="dshmore-effort-level" key={level}>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!writable || busy}
                  onChange={(event) => { toggleLevel(level, event.currentTarget.checked) }}
                />
                <span className="dshmore-effort-level-label">{LEVEL_LABELS[level]}</span>
                {enabled && level !== 'off' && (
                  <input
                    className="dshmore-effort-wire"
                    type="text"
                    value={entry?.wire ?? ''}
                    disabled={!writable || busy}
                    placeholder="线上值"
                    aria-label={`${LEVEL_LABELS[level]} 的线上值`}
                    onChange={(event) => { setWire(level, event.currentTarget.value) }}
                  />
                )}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The reasoning-effort editor for one model, in a modal owned by the persistent portal. */
function EffortEditorModal({ provider, modelId, initial, writable, onClose }: {
  provider: string
  modelId: string
  initial: ModelReasoningEfforts | null | undefined
  writable: boolean
  onClose: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<ModelDraft>(() => draftFromServer(initial ?? null))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(draftFromServer(initial ?? null))
  }, [initial])

  const known = initial !== undefined

  const save = async (): Promise<void> => {
    if (!known) return
    const payload: ModelReasoningEfforts = draft.nonReasoning ? false : buildDict(draft)
    if (payload !== false && !THINKING_LEVELS.some((level) => level !== 'off' && payload[level] !== undefined)) {
      setError('至少需要开启一个非「不思考」的思考级别，或使用「清除配置」。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await callPatchApi<SaveModelReasoningEffortsPayload>(MODEL_REASONING_EFFORTS_PATCH_ID, 'save', {
        provider,
        modelId,
        reasoningEfforts: payload,
      })
      onClose()
    } catch (caught) {
      setError(apiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    if (!known) return
    setBusy(true)
    setError(null)
    try {
      await callPatchApi<SaveModelReasoningEffortsPayload>(MODEL_REASONING_EFFORTS_PATCH_ID, 'save', {
        provider,
        modelId,
        reasoningEfforts: null,
      })
      onClose()
    } catch (caught) {
      setError(apiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`思考强度 · ${modelId}`}
      closeLabel="关闭"
      description={`提供方 ${provider}`}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>关闭</Button>
          {known && <Button variant="ghost" disabled={!writable || busy} onClick={() => { void clear() }}>清除配置</Button>}
          {known && <Button variant="primary" disabled={!writable || busy} onClick={() => { void save() }}>{busy ? '保存中…' : '保存'}</Button>}
        </>
      )}
    >
      <div className="dshmore-effort-dialog-body">
        {!known && <p className="dshmore-effort-note">该模型尚未保存到 settings.yaml，请先在上方保存提供方配置。</p>}
        {known && <EffortEditorBody draft={draft} setDraft={setDraft} writable={writable} busy={busy} />}
        {!writable && <p className="dshmore-effort-warn">当前 Settings 存储为只读，无法保存修改。</p>}
        {error !== null && <div className="dshmore-effort-error">{error}</div>}
      </div>
    </Modal>
  )
}

/**
 * Persistent frame entry that drops a reasoning-effort button into every model
 * row of the shipped Models page model catalog and owns the editor modal. The
 * buttons are plain DOM (stateless) re-synced by a MutationObserver, so the
 * models page can re-render freely; the modal's state lives in this component,
 * which the slot system never unmounts.
 */
export function ModelsPageEffortPortal(props: OverlayProps & {
  scope: SettingsScope<unknown>
  activation: PatchActivationSource
}): JSX.Element | null {
  const settings = useSyncExternalStore(props.activation.subscribe, props.activation.getSnapshot, props.activation.getSnapshot)
  const enabled = settings[MODEL_REASONING_EFFORTS_PATCH_ID]
  // The bound llm-pi-ai scope refreshes whenever the namespace changes anywhere
  // (including this patch's own writes), so button summaries refetch.
  const scopeSnapshot = useSyncExternalStore(props.scope.subscribe, props.scope.getSnapshot, props.scope.getSnapshot)
  const [editing, setEditing] = useState<{ provider: string; modelId: string } | null>(null)
  const [data, setData] = useState<ModelReasoningEffortsSnapshot | null>(null)
  const dataRef = useRef<ModelReasoningEffortsSnapshot | null>(data)
  dataRef.current = data
  const generation = useRef(0)
  const fillingRef = useRef(false)

  const reload = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    try {
      const snapshot = await callPatchApi<ModelReasoningEffortsSnapshot>(MODEL_REASONING_EFFORTS_PATCH_ID, 'read', {})
      if (generation.current !== current) return
      setData(snapshot)
      // Auto-fill reasoning efforts for models that have none (e.g. freshly
      // fetched ones), which the adapter would otherwise treat as non-reasoning.
      if (enabled && snapshot.writable && snapshot.rows.some((row) => row.reasoningEfforts === null) && !fillingRef.current) {
        fillingRef.current = true
        void callPatchApi<{ filled: number }>(MODEL_REASONING_EFFORTS_PATCH_ID, 'fillDefaults', {})
          .catch(() => undefined)
          .finally(() => { fillingRef.current = false })
      }
    } catch {
      // Keep the last known snapshot; the manual refresh path is the retry.
    }
  }, [enabled])

  useEffect(() => {
    if (enabled) void reload()
  }, [enabled, reload, scopeSnapshot])

  const syncButtons = useCallback((): void => {
    if (!enabled) return
    const active = new Set<HTMLElement>()
    for (const entry of findModelEntries()) {
      const provider = providerRouteOf(entry)
      const modelId = modelIdOf(entry)
      if (provider === null || modelId === null) continue
      active.add(entry)
      let button = entry.querySelector<HTMLButtonElement>(`[${EFFORT_BUTTON_ATTR}]`)
      if (button === null) {
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'dshmore-effort-row-button'
        button.setAttribute(EFFORT_BUTTON_ATTR, '')
        button.addEventListener('click', () => {
          const route = button?.dataset.provider
          const model = button?.dataset.model
          if (route !== undefined && model !== undefined) setEditing({ provider: route, modelId: model })
        })
        const row = entry.querySelector('[class*="modelRow"]')
        if (row === null) continue
        entry.insertBefore(button, row.nextSibling)
      }
      if (button.dataset.provider !== provider) button.dataset.provider = provider
      if (button.dataset.model !== modelId) button.dataset.model = modelId
      const rowData = dataRef.current?.rows.find((row) => row.provider === provider && row.modelId === modelId)
      const text = rowData === undefined ? '思考强度' : `思考强度 · ${summaryLabel(rowData.reasoningEfforts)}`
      // Only write when changed: textContent replacement itself mutates the DOM,
      // which would re-trigger the observer and spin the sync loop.
      if (button.textContent !== text) button.textContent = text
    }
    document.querySelectorAll<HTMLButtonElement>(`[${EFFORT_BUTTON_ATTR}]`).forEach((button) => {
      const host = button.parentElement
      if (host === null || !active.has(host)) button.remove()
    })
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      document.querySelectorAll(`[${EFFORT_BUTTON_ATTR}]`).forEach((element) => element.remove())
      return
    }
    let frame: number | null = null
    const schedule = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        syncButtons()
      })
    }
    syncButtons()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [enabled, syncButtons])

  // Re-run only to refresh button summaries after a fetch lands.
  useEffect(() => {
    if (enabled) syncButtons()
  }, [enabled, syncButtons, data])

  const editingRow = editing === null
    ? undefined
    : data?.rows.find((row) => row.provider === editing.provider && row.modelId === editing.modelId)

  return (
    <>
      <style>{effortStyles}</style>
      {editing !== null && (
        <EffortEditorModal
          provider={editing.provider}
          modelId={editing.modelId}
          initial={editingRow === undefined ? undefined : editingRow.reasoningEfforts}
          writable={data?.writable ?? true}
          onClose={() => { setEditing(null) }}
        />
      )}
    </>
  )
}

const effortStyles = `
.dshmore-effort-row-button { box-sizing: border-box; width: 100%; height: 28px; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; background: transparent; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 6px; margin-top: 6px; padding: 0 10px; font-size: 12px; line-height: 18px; display: inline-flex; align-items: center; justify-content: flex-start; gap: 6px; }
.dshmore-effort-row-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshmore-effort-dialog-body { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; width: 100%; min-width: 0; overflow: hidden; }
.dshmore-effort-editor { display: flex; flex-direction: column; gap: 12px; }
.dshmore-effort-switch, .dshmore-effort-level { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; cursor: pointer; }
.dshmore-effort-switch input, .dshmore-effort-level input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; }
.dshmore-effort-levels { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 12px; }
.dshmore-effort-level-label { flex: none; }
.dshmore-effort-wire { box-sizing: border-box; height: 28px; min-width: 0; width: 100%; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 0 8px; font-size: 12px; line-height: 18px; }
.dshmore-effort-wire:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.dshmore-effort-wire::placeholder { color: var(--dsw-alias-label-dimmed); }
.dshmore-effort-note { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; }
.dshmore-effort-warn { color: var(--dsw-alias-state-warn-label); margin: 0; font-size: 12px; line-height: 18px; }
.dshmore-effort-error { padding: 8px 10px; border-radius: 8px; background: rgba(208,58,58,.10); color: var(--dsw-alias-state-error-primary, rgb(220,90,90)); font-size: 12px; line-height: 18px; }
`

export const clientPatch: ClientPatch = {
  id: MODEL_REASONING_EFFORTS_PATCH_ID,
  install: (ctx: ClientContext, activation: PatchActivationSource) => {
    const scope = ctx.settingsScope.bind<unknown>({ namespace: LLM_PI_AI_SETTINGS_NAMESPACE })
    // SettingsScopeController methods are prototype methods; React invokes
    // useSyncExternalStore callbacks as bare functions (this === undefined),
    // so bind the face once before handing it to the component.
    const boundScope: SettingsScope<unknown> = {
      getSnapshot: scope.getSnapshot.bind(scope),
      subscribe: scope.subscribe.bind(scope),
      set: scope.set.bind(scope),
      unset: scope.unset.bind(scope),
    }
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: `${PLUGIN_NAME}-${MODEL_REASONING_EFFORTS_PATCH_ID}`,
      order: 90,
      registrant: PLUGIN_NAME,
    }, (props: OverlayProps) => <ModelsPageEffortPortal {...props} scope={boundScope} activation={activation} />))
  },
}
