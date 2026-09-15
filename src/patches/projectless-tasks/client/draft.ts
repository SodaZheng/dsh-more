import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

interface Draft {
  state: { getSnapshot(): { phase: string; draft: string; imageIds?: readonly DraftAttachmentId[]; attachmentIds?: readonly DraftAttachmentId[] } }
  setDraft(text: string): void
  addImages?(ids: DraftAttachmentId[]): boolean
  removeImage?(id: DraftAttachmentId): unknown
  addAttachments?(ids: readonly DraftAttachmentId[]): boolean
  removeAttachment?(id: DraftAttachmentId): unknown
}

/** Move only after all target admission checks pass; never overwrite another draft. */
export function transferDraft(source: Draft, target: Draft, rebind?: (ids: readonly DraftAttachmentId[]) => void): void {
  const from = source.state.getSnapshot()
  const to = target.state.getSnapshot()
  if (from.phase !== 'plain' || to.phase !== 'plain') throw new Error('输入正在处理中，请稍后切换任务目录。')
  if (from.draft !== '' && to.draft !== '' && from.draft !== to.draft) {
    throw new Error('目标任务已有其他草稿，本次切换已停止，原草稿已保留。')
  }
  const ids = from.attachmentIds ?? from.imageIds
  const add = from.attachmentIds === undefined ? target.addImages : target.addAttachments
  const remove = from.attachmentIds === undefined ? source.removeImage : source.removeAttachment
  if (!Array.isArray(ids) || typeof add !== 'function' || typeof remove !== 'function') {
    throw new Error('当前 DSH 版本的草稿接口不兼容，原草稿已保留。')
  }
  if (ids.length > 0 && !add.call(target, [...ids])) {
    throw new Error('暂时无法转移图片，原草稿已保留，请稍后重试。')
  }
  // Newer DSH file uploads belong to a Session. Rebind before clearing the source.
  if (ids.length > 0 && from.attachmentIds !== undefined) {
    if (rebind === undefined) throw new Error('无法转移附件归属，原草稿已保留。')
    rebind(ids)
  }
  if (from.draft !== '') target.setDraft(from.draft)
  // Target now owns the draft. A retry with an empty source preserves it.
  if (from.draft !== '') source.setDraft('')
  ids.forEach((id) => remove.call(source, id))
}

/** Validate the Client-only service methods where Cordis Host types overlap. */
export function transferBeforeOpen(ctx: Context, sourceId: SessionId | undefined, targetId: SessionId): boolean {
  const value: unknown = ctx.sessions
  if (typeof value !== 'object' || value === null || !('scope' in value) || typeof value.scope !== 'function'
    || !('list' in value) || typeof value.list !== 'object' || value.list === null
    || !('getSnapshot' in value.list) || typeof value.list.getSnapshot !== 'function') {
    throw new Error('当前 DSH 版本不支持保留草稿切换，请检查会话接口。')
  }
  const sessions = value as Pick<ISessions, 'scope' | 'list'>
  const list = sessions.list.getSnapshot()
  if (list.current !== sourceId) return false
  if (sourceId === undefined || sourceId === targetId) return true
  if (list.byId[sourceId]?.blank !== true) throw new Error('当前会话已开始，请新建会话后选择独立任务。')
  const source = sessions.scope(sourceId)
  const target = sessions.scope(targetId)
  if (source === undefined || target === undefined) throw new Error('任务尚未准备好，原草稿已保留，请稍后重试。')
  const conversation = ctx.conversation as typeof ctx.conversation & {
    rebindDraftFiles?(id: SessionId, ids: readonly DraftAttachmentId[]): void
  }
  transferDraft(conversation.input.for(source), conversation.input.for(target),
    typeof conversation.rebindDraftFiles === 'function' ? (ids) => conversation.rebindDraftFiles!(targetId, ids) : undefined)
  return true
}
