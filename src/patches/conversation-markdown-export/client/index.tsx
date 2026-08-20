import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconDownloadOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import {
  CONVERSATION_MARKDOWN_EXPORT_PATCH_ID,
  type ConversationMarkdownExport,
} from '../shared.js'
import { markdownFilename } from './filename.js'

type HeaderUtilityProps = PropsRuntime<'conversation.session.header.utilities'>

const exportStyles = `
.dshmore-markdown-export-button { box-sizing: border-box; min-width: 128px; height: 32px; color: var(--dsw-alias-label-primary); cursor: pointer; background: transparent; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 6px 12px; font-family: var(--dsw-font-family); font-size: 13px; line-height: 20px; }
.dshmore-markdown-export-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshmore-markdown-export-button:disabled { color: var(--dsw-alias-label-dimmed); cursor: wait; }
.dshmore-markdown-export-button > span, .dshmore-markdown-export-button > svg { flex: none; }
`

function saveMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob(['\uFEFF', markdown], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

function ConversationMarkdownExportButton(props: HeaderUtilityProps & {
  activation: PatchActivationSource
}): JSX.Element | null {
  const settings = useSyncExternalStore(props.activation.subscribe, props.activation.getSnapshot)
  const enabled = settings[CONVERSATION_MARKDOWN_EXPORT_PATCH_ID]
  const title = props.useSessions((state) => state.byId[props.sessionId]?.displayTitle ?? String(props.sessionId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const activeSession = useRef<string | null>(null)
  activeSession.current = enabled ? String(props.sessionId) : null

  useEffect(() => {
    generation.current += 1
    setBusy(false)
    setError(null)
  }, [enabled, props.sessionId])

  const download = async (): Promise<void> => {
    const requestSessionId = String(props.sessionId)
    const requestGeneration = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const result = await callPatchApi<ConversationMarkdownExport>(
        CONVERSATION_MARKDOWN_EXPORT_PATCH_ID,
        'render',
        { sessionId: props.sessionId, title },
      )
      if (generation.current !== requestGeneration || activeSession.current !== requestSessionId) return
      saveMarkdown(markdownFilename(title, String(props.sessionId)), result.markdown)
    } catch (caught) {
      if (generation.current === requestGeneration && activeSession.current === requestSessionId) setError(apiErrorText(caught))
    } finally {
      if (generation.current === requestGeneration && activeSession.current === requestSessionId) setBusy(false)
    }
  }

  if (!enabled) return null
  return (
    <>
      <style>{exportStyles}</style>
      <button
        type="button"
        className="dshmore-markdown-export-button"
        disabled={busy}
        aria-busy={busy}
        aria-label="导出完整聊天记录为 Markdown"
        onClick={() => { void download() }}
      >
        <span>{busy ? '正在导出…' : '导出 Markdown'}</span>
        <IconDownloadOutline16 size={12} />
      </button>
      <Modal
        open={error !== null}
        onClose={() => setError(null)}
        title="无法导出聊天记录"
        closeLabel="关闭"
        description={error ?? ''}
        footer={<Button variant="primary" onClick={() => setError(null)}>关闭</Button>}
      />
    </>
  )
}

export const clientPatch: ClientPatch = {
  id: CONVERSATION_MARKDOWN_EXPORT_PATCH_ID,
  install: (ctx, activation) => {
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: `${PLUGIN_NAME}-${CONVERSATION_MARKDOWN_EXPORT_PATCH_ID}`,
      order: 100,
      registrant: PLUGIN_NAME,
    }, (props: HeaderUtilityProps) => <ConversationMarkdownExportButton {...props} activation={activation} />))
  },
}
