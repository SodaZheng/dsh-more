import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import {
  MODEL_CAPABILITIES_PATCH_ID, THINKING_FORMATS, THINKING_LEVELS, DEEPSEEK_THINKING_LEVELS,
  type ModelSettingsNamespace,
  type ModelCapabilities, type ModelCapabilitiesSnapshot, type ThinkingLevel,
} from '../shared.js'

import { decodeSnapshot, readCapabilities } from './api.js'

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '不思考', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
}

export interface ModelDraft {
  vision: 'default' | 'yes' | 'no'
  thinking: 'default' | 'disabled' | 'custom'
  levels: Partial<Record<ThinkingLevel, { enabled: boolean; wire: string }>>
  thinkingFormat: NonNullable<ModelCapabilities['thinkingFormat']> | 'default'
}

export function draftFromServer(capabilities: ModelCapabilities): ModelDraft {
  const efforts = capabilities.reasoningEfforts
  const levels: ModelDraft['levels'] = {}
  if (efforts !== false && efforts !== null) {
    for (const level of THINKING_LEVELS) {
      if (Object.hasOwn(efforts, level)) levels[level] = { enabled: true, wire: efforts[level] ?? '' }
    }
  }
  return {
    vision: capabilities.vision === null ? 'default' : capabilities.vision ? 'yes' : 'no',
    thinking: efforts === null ? 'default' : efforts === false ? 'disabled' : 'custom',
    levels,
    thinkingFormat: capabilities.thinkingFormat ?? 'default',
  }
}

export function capabilitiesFromDraft(draft: ModelDraft): ModelCapabilities {
  let reasoningEfforts: ModelCapabilities['reasoningEfforts'] = null
  if (draft.thinking === 'disabled') reasoningEfforts = false
  if (draft.thinking === 'custom') {
    reasoningEfforts = {}
    for (const level of THINKING_LEVELS) {
      const entry = draft.levels[level]
      if (!entry?.enabled) continue
      const wire = entry.wire.trim()
      if (level !== 'off' && wire === '') throw new Error(`请填写「${LEVEL_LABELS[level]}」的参数值。`)
      reasoningEfforts[level] = level === 'off' && wire === '' ? null : wire
    }
    if (!THINKING_LEVELS.some((level) => level !== 'off' && draft.levels[level]?.enabled)) {
      throw new Error('请至少选择一种思考等级；仅需不思考时，请选择「不支持思考」。')
    }
  }
  return {
    vision: draft.vision === 'default' ? null : draft.vision === 'yes',
    reasoningEfforts,
    thinkingFormat: draft.thinkingFormat === 'default' ? null : draft.thinkingFormat,
  }
}

export function summaryLabel(capabilities: ModelCapabilities): string {
  const vision = capabilities.vision === null ? '识图：默认' : capabilities.vision ? '支持识图' : '不支持识图'
  const efforts = capabilities.reasoningEfforts
  const thinking = efforts === null ? '思考：默认' : efforts === false ? '不支持思考'
    : THINKING_LEVELS.filter((level) => Object.hasOwn(efforts, level)).map((level) => LEVEL_LABELS[level]).join('、')
  return `${vision} · ${thinking}`
}

export function CapabilitiesEditorBody({ draft, setDraft, disabled, api }: {
  draft: ModelDraft
  setDraft: (updater: (current: ModelDraft) => ModelDraft) => void
  disabled: boolean
  api: string | null
}): JSX.Element {
  return (
    <div className="dshmore-capabilities-fields">
      <label className="dshmore-capabilities-field">
        <span>识图能力</span>
        <select aria-label="识图能力" value={draft.vision} disabled={disabled} onChange={(event) => {
          const vision = event.currentTarget.value as ModelDraft['vision']
          setDraft((current) => ({ ...current, vision }))
        }}>
          <option value="default">沿用默认</option>
          <option value="yes">支持识图</option>
          <option value="no">不支持识图（仅文字）</option>
        </select>
      </label>
      <label className="dshmore-capabilities-field">
        <span>思考类型</span>
        <select aria-label="思考类型" value={draft.thinking} disabled={disabled} onChange={(event) => {
          const thinking = event.currentTarget.value as ModelDraft['thinking']
          setDraft((current) => ({ ...current, thinking }))
        }}>
          <option value="default">沿用默认</option>
          <option value="disabled">不支持思考</option>
          <option value="custom">自定义可选类型</option>
        </select>
      </label>
      {draft.thinking === 'custom' && (
        <fieldset className="dshmore-capabilities-levels" disabled={disabled}>
          <legend>模型支持的思考等级</legend>
          {(api === 'deepseek-native' ? DEEPSEEK_THINKING_LEVELS : THINKING_LEVELS).map((level) => {
            const entry = draft.levels[level]
            return (
              <div className="dshmore-capabilities-level" key={level}>
                <label>
                  <input type="checkbox" checked={entry?.enabled === true} onChange={(event) => {
                    const enabled = event.currentTarget.checked
                    setDraft((current) => ({ ...current, levels: {
                      ...current.levels, [level]: { wire: level === 'off' ? '' : level, ...current.levels[level], enabled },
                    } }))
                  }} />
                  <span>{LEVEL_LABELS[level]} <small>{level}</small></span>
                </label>
                {entry?.enabled && (
                  <input type="text" aria-label={`${LEVEL_LABELS[level]}的参数值`} value={entry.wire} readOnly={api === 'deepseek-native'}
                    placeholder={level === 'off' ? '留空：不发送参数' : '发送给接口的参数值'}
                    onChange={(event) => {
                      const wire = event.currentTarget.value
                      setDraft((current) => ({ ...current, levels: {
                        ...current.levels, [level]: { enabled: true, wire },
                      } }))
                    }} />
                )}
              </div>
            )
          })}
        </fieldset>
      )}
      <details className="dshmore-capabilities-advanced">
        <summary>思考参数格式{draft.thinkingFormat === 'default' ? '' : ` · ${draft.thinkingFormat}`}</summary>
        {api === null || api === 'openai-completions' ? (
          <label className="dshmore-capabilities-field">
            <span>接口接受的格式</span>
            <select aria-label="思考参数格式" disabled={disabled} value={draft.thinkingFormat} onChange={(event) => {
              const thinkingFormat = event.currentTarget.value as ModelDraft['thinkingFormat']
              setDraft((current) => ({ ...current, thinkingFormat }))
            }}>
              <option value="default">沿用默认（提供方 / 自动识别）</option>
              {THINKING_FORMATS.map((format) => <option value={format} key={format}>{format}</option>)}
            </select>
            <span className="dshmore-capabilities-note">用于 OpenAI 兼容接口；按接口要求选择 OpenAI、DeepSeek、Qwen 等格式。</span>
          </label>
        ) : <p className="dshmore-capabilities-note">当前接口使用原生思考协议，无需配置此项。</p>}
      </details>
      <p className="dshmore-capabilities-note">沿用默认会移除该模型的对应声明。请按模型实际能力配置。</p>
    </div>
  )
}

export function CapabilitiesEditorModal({ provider, modelId, namespace, onClose, onSaved }: {
  namespace: ModelSettingsNamespace
  provider: string
  modelId: string
  onClose: () => void
  onSaved: (snapshot: ModelCapabilitiesSnapshot) => void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<ModelCapabilitiesSnapshot | null>(null)
  const [draft, setDraft] = useState<ModelDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const saving = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let cancelled = false
    setError(null)
    void readCapabilities().then((next) => {
      if (cancelled) return
      setSnapshot(next)
      const row = next.rows.find((entry) => entry.namespace === namespace && entry.provider === provider && entry.modelId === modelId)
      setDraft(row === undefined ? null : draftFromServer(row))
    }).catch((caught: unknown) => {
      if (!cancelled) setError(apiErrorText(caught))
    })
    return () => { cancelled = true }
  }, [namespace, provider, modelId, attempt])

  const row = snapshot?.rows.find((entry) => entry.provider === provider && entry.modelId === modelId)
  const save = async (): Promise<void> => {
    if (saving.current) return
    if (draft === null || row === undefined || !snapshot?.writable || !Number.isSafeInteger(row.revision)) {
      setError('模型配置尚未就绪，请重新打开弹窗后重试。')
      return
    }
    let capabilities: ModelCapabilities
    try { capabilities = capabilitiesFromDraft(draft) } catch (caught) { setError(apiErrorText(caught)); return }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const next = decodeSnapshot(await callPatchApi<unknown>(MODEL_CAPABILITIES_PATCH_ID, 'save', {
        namespace, provider, modelId, expectedRevision: row.revision, ...capabilities,
      }))
      if (mounted.current) { onSaved(next); onClose() }
    } catch (caught) {
      if (mounted.current) setError(apiErrorText(caught))
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Modal open onClose={() => { if (!saving.current) onClose() }} title={`模型能力 · ${modelId}`}
      closeLabel="关闭" description={`提供方 ${provider}`} footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || draft === null || row === undefined || !snapshot?.writable}
            onClick={() => { void save() }}>{busy ? '保存中…' : '保存'}</Button>
        </>
      )}>
      <div className="dshmore-capabilities-dialog">
        {snapshot === null && error === null && <p className="dshmore-capabilities-note">正在读取模型配置…</p>}
        {snapshot !== null && row === undefined && <p className="dshmore-capabilities-note">请先保存提供方配置，再打开该模型的能力设置。</p>}
        {draft !== null && row !== undefined && <CapabilitiesEditorBody draft={draft}
          setDraft={(update) => { setDraft((current) => current === null ? null : update(current)) }}
          disabled={busy || !snapshot?.writable} api={row.api} />}
        {snapshot !== null && !snapshot.writable && <p className="dshmore-capabilities-note">当前配置为只读。</p>}
        {error !== null && <div role="alert" className="dshmore-capabilities-error">{error}</div>}
        {snapshot === null && error !== null && <Button variant="ghost" onClick={() => { setAttempt((value) => value + 1) }}>重试</Button>}
      </div>
    </Modal>
  )
}
