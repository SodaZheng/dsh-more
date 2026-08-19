import { useEffect, useState } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button,
  IconEditOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import type { ConversationHeaderProps, MessageActions, MessageTarget } from '../../../kernel/client/message-actions.js'
import type { RefreshableSessions } from '../../../platform/dsh/client/runtime.js'
import { followSessionHandoff, openSessionWithoutGap } from '../../../platform/dsh/client/session-sync.js'
import { MESSAGE_EDIT_PATCH_ID, type MessageEditPreview } from '../shared.js'

const api = {
  preview: (payload: { sessionId: string; targetSeq: number; text: string }) =>
    callPatchApi<MessageEditPreview>(MESSAGE_EDIT_PATCH_ID, 'preview', payload),
  commit: (payload: { sessionId: string; targetSeq: number; text: string; continuationSessionId: string; confirmToken: string }) =>
    callPatchApi<{ sessionId: string }>(MESSAGE_EDIT_PATCH_ID, 'commit', payload),
}

export function useMessageActions(
  props: ConversationHeaderProps & { ctx: ClientContext },
  enabled: boolean,
): MessageActions {
  const [target, setTarget] = useState<MessageTarget | null>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<MessageEditPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (enabled) return
    setTarget(null)
    setPreview(null)
    setError(null)
  }, [enabled])

  const open = (next: MessageTarget): void => {
    setTarget(next)
    setText(next.text)
    setPreview(null)
    setError(null)
  }

  const previewChange = async (): Promise<void> => {
    if (target === null) return
    setBusy(true)
    setError(null)
    try {
      setPreview(await api.preview({ sessionId: props.sessionId, targetSeq: target.seq, text }))
    } catch (caught) {
      setError(apiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    if (target === null || preview === null) return
    setBusy(true)
    setError(null)
    const sessions = (props.ctx as unknown as { sessions: RefreshableSessions }).sessions
    const continuationSessionId = preview.continuationSessionId as SessionId
    const handoff = followSessionHandoff(sessions, continuationSessionId)
    try {
      const result = await api.commit({
        sessionId: props.sessionId,
        targetSeq: target.seq,
        text,
        continuationSessionId,
        confirmToken: preview.confirmToken,
      })
      await handoff.finish(result.sessionId)
      setTarget(null)
    } catch (caught) {
      handoff.cancel()
      const sourceId = props.sessionId as SessionId
      const sessionList = sessions.list.getSnapshot()
      const sourceAvailable = sessionList.byId[sourceId] !== undefined
      const sourceArchived = props.ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sourceId)
      if (sourceAvailable && !sourceArchived && sessionList.current !== sourceId) openSessionWithoutGap(sessions, sourceId)
      setPreview(null)
      setError(apiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  return {
    renderAction: (candidate) => enabled && candidate.kind === 'user' ? (
      <Tooltip label="编辑并从这里重新开始" side="bottom">
        <button type="button" className="dshmore-inline-button" aria-label="编辑并从这里重新开始" onClick={(event) => {
          event.stopPropagation()
          open(candidate)
        }}><IconEditOutline16 size={16} /></button>
      </Tooltip>
    ) : null,
    overlay: enabled ? (
      <Modal
        open={target !== null}
        onClose={() => !busy && setTarget(null)}
        title="编辑消息并从这里重新开始"
        closeLabel="关闭"
        className="dshmore-edit-modal"
        description="修改后会创建干净的前缀会话，这条消息之后的内容不会保留。"
        footer={preview === null ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>取消</Button>
            <Button variant="primary" disabled={busy || text.trim() === ''} onClick={() => void previewChange()}>
              {busy ? '正在检查…' : '预览修改'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>返回修改</Button>
            <Button variant="primary" disabled={busy} onClick={() => void commit()}>
              {busy ? '正在重建…' : '确认编辑并丢弃后续'}
            </Button>
          </>
        )}
      >
        <div className="dshmore-dialog-body">
          <textarea
            className="dshmore-editor"
            value={text}
            disabled={busy || preview !== null}
            onChange={(event) => {
              setText(event.currentTarget.value)
              setPreview(null)
              setError(null)
            }}
            rows={7}
            autoFocus
          />
          {preview !== null && (
            <div className="dshmore-warning">
              将从第 {preview.turn} 轮之前重建会话，并丢弃当前轮及之后共 {preview.laterTurnCount} 轮内容。
            </div>
          )}
          {error !== null && <div className="dshmore-error">{error}</div>}
        </div>
      </Modal>
    ) : null,
  }
}
