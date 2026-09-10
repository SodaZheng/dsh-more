import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

type Draft = Pick<SessionInput, 'state' | 'setDraft' | 'addImages' | 'removeImage'>

/** Move only after all target admission checks pass; never overwrite another draft. */
export function transferDraft(source: Draft, target: Draft): void {
  const from = source.state.getSnapshot()
  const to = target.state.getSnapshot()
  if (from.phase !== 'plain' || to.phase !== 'plain') throw new Error('输入正在处理中，请稍后切换任务目录。')
  if (from.draft !== '' && to.draft !== '' && from.draft !== to.draft) {
    throw new Error('目标任务已有其他草稿，本次切换已停止，原草稿已保留。')
  }
  if (from.imageIds.length > 0 && !target.addImages([...from.imageIds])) {
    throw new Error('暂时无法转移图片，原草稿已保留，请稍后重试。')
  }
  if (from.draft !== '') target.setDraft(from.draft)
  // Target now owns the draft. A retry with an empty source preserves it.
  if (from.draft !== '') source.setDraft('')
  from.imageIds.forEach((id) => source.removeImage(id))
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
  transferDraft(ctx.conversation.input.for(source), ctx.conversation.input.for(target))
  return true
}
