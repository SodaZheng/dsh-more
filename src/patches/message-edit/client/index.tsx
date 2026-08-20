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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (enabled) return
    setTarget(null)
    setError(null)
  }, [enabled])

  const open = (next: MessageTarget): void => {
    setTarget(next)
    setText(next.text)
    setError(null)
  }

  const applyChange = async (): Promise<void> => {
    if (target === null) return
    setBusy(true)
    setError(null)
    const sessions = (props.ctx as unknown as { sessions: RefreshableSessions }).sessions
    let handoff: ReturnType<typeof followSessionHandoff> | undefined
    try {
      // Preview remains an internal consistency check. The user submits once;
      // its bound token prevents a concurrent session change from being applied.
      const preview = await api.preview({ sessionId: props.sessionId, targetSeq: target.seq, text })
      const continuationSessionId = preview.continuationSessionId as SessionId
      handoff = followSessionHandoff(sessions, continuationSessionId)
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
      handoff?.cancel()
      const sourceId = props.sessionId as SessionId
      const sessionList = sessions.list.getSnapshot()
      const sourceAvailable = sessionList.byId[sourceId] !== undefined
      const sourceArchived = props.ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sourceId)
      if (sourceAvailable && !sourceArchived && sessionList.current !== sourceId) openSessionWithoutGap(sessions, sourceId)
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
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>取消</Button>
            <Button variant="primary" disabled={busy || text.trim() === ''} onClick={() => void applyChange()}>
              {busy ? '正在修改…' : '修改并重新开始'}
            </Button>
          </>
        )}
      >
        <div className="dshmore-dialog-body">
          <textarea
            className="dshmore-editor"
            value={text}
            disabled={busy}
            onChange={(event) => {
              setText(event.currentTarget.value)
              setError(null)
            }}
            rows={7}
            autoFocus
          />
          {error !== null && <div className="dshmore-error">{error}</div>}
        </div>
      </Modal>
    ) : null,
  }
}
