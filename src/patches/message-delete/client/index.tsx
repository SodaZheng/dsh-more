import { useCallback, useEffect, useState } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button,
  IconTrashOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import type { ConversationHeaderProps, MessageActions, MessageTarget } from '../../../kernel/client/message-actions.js'
import type { RefreshableSessions } from '../../../platform/dsh/client/runtime.js'
import { followSessionHandoff, openSessionWithoutGap } from '../../../platform/dsh/client/session-sync.js'
import { MESSAGE_DELETE_PATCH_ID, type MessageDeletePreview } from '../shared.js'

const api = {
  preview: (payload: { sessionId: string; targetSeq: number }) =>
    callPatchApi<MessageDeletePreview>(MESSAGE_DELETE_PATCH_ID, 'preview', payload),
  commit: (payload: { sessionId: string; targetSeq: number; continuationSessionId: string; confirmToken: string }) =>
    callPatchApi<{ sessionId: string; deletedSeqs: readonly number[] }>(MESSAGE_DELETE_PATCH_ID, 'commit', payload),
}

export function useMessageActions(
  props: ConversationHeaderProps & { ctx: ClientContext },
  enabled: boolean,
): MessageActions {
  const [target, setTarget] = useState<MessageTarget | null>(null)
  const [preview, setPreview] = useState<MessageDeletePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (enabled) return
    setTarget(null)
    setPreview(null)
    setError(null)
  }, [enabled])

  const open = useCallback(async (next: MessageTarget) => {
    setTarget(next)
    setPreview(null)
    setError(null)
    setBusy(true)
    try {
      setPreview(await api.preview({ sessionId: props.sessionId, targetSeq: next.seq }))
    } catch (caught) {
      setError(apiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }, [props.sessionId])

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
        continuationSessionId,
        confirmToken: preview.confirmToken,
      })
      await handoff.finish(result.sessionId)
      setTarget(null)
      setPreview(null)
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
    renderAction: (candidate) => enabled ? (
      <Tooltip label="删除这条消息" side="bottom">
        <button type="button" className="dshmore-inline-button" aria-label="删除这条消息" onClick={(event) => {
          event.stopPropagation()
          void open(candidate)
        }}><IconTrashOutline16 size={16} /></button>
      </Tooltip>
    ) : null,
    overlay: enabled ? (
      <Modal
        open={target !== null}
        onClose={() => !busy && setTarget(null)}
        title="删除这条消息？"
        closeLabel="关闭"
        description="这条消息会立即从对话面板和模型上下文中消失。"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>取消</Button>
            <Button variant="primary" disabled={busy || preview === null} onClick={() => void commit()}>
              {busy ? '正在检查…' : '确认删除'}
            </Button>
          </>
        )}
      >
        <div className="dshmore-dialog-body">
          <div className="dshmore-message-preview">{target?.text || '（无文本内容）'}</div>
          {preview !== null && preview.affectedNodeCount > 1 && (
            <div className="dshmore-warning">为保持工具调用完整，将同时移除关联的 {preview.affectedNodeCount - 1} 个上下文节点。</div>
          )}
          {error !== null && <div className="dshmore-error">{error}</div>}
        </div>
      </Modal>
    ) : null,
  }
}
