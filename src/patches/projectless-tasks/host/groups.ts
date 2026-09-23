import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { requireString } from '../../../platform/dsh/host/wire.js'
import { readSettings } from '../../../platform/dsh/host/settings.js'
import { SESSION_GROUPS_NAMESPACE, decodeSessionGroups, EMPTY_GROUPS, type SessionGroups } from '../groups.js'

export const SessionGroupsSchema: z<SessionGroups> = z.object({ assignments: z.dict(z.string()).default({}) })

/** Persist presentation membership only. Immutable cwd and native accounts stay authoritative. */
export async function moveSessionGroup(ctx: Context, payload: unknown): Promise<{ sessionId: string; workspaceId: string | null }> {
  const sessionId = SessionId(requireString(payload, 'sessionId'))
  if (typeof payload !== 'object' || payload === null || !('workspaceId' in payload)
    || !(payload.workspaceId === null || typeof payload.workspaceId === 'string' && payload.workspaceId.length > 0)) {
    throw new DshMoreError('bad-request', '请选择目标工作区。')
  }
  const workspaceId = payload.workspaceId
  if (!ctx.settings.writable) throw new DshMoreError('forbidden', '当前配置为只读，无法移动会话。', 403)
  if (workspaceId !== null && ctx.workspaceRegistry.get(WorkspaceId(workspaceId)) === undefined) {
    throw new DshMoreError('not-found', '目标工作区已不存在，请重新选择。', 404)
  }
  // 0.1.2 returns headers; 0.1.5 returns revision-bearing snapshots.
  const storedHeaders = async (): Promise<SessionHeader[]> => {
    const stored: readonly (SessionHeader | { header: SessionHeader })[] = await ctx.sessionPersistence.list()
    return stored.map((item) => 'header' in item ? item.header : item)
  }
  const header = ctx.sessions.get(sessionId)?.header ?? (await storedHeaders()).find((item) => item.id === sessionId)
  if (header === undefined) throw new DshMoreError('not-found', '该会话已不存在。', 404)
  if (header.origin === 'subagent') throw new DshMoreError('bad-request', '子会话跟随主会话归组，请移动主会话。')
  // Native ownership may have appeared since the menu opened. Never shadow it.
  if (ctx.workspaceRegistry.list().some((workspace) => workspace.sessionIds.includes(sessionId))) {
    throw new DshMoreError('bad-request', '这条会话已有原生工作区，只支持移动未分组或手动归组的会话。')
  }
  const current = decodeSessionGroups(readSettings(ctx, SESSION_GROUPS_NAMESPACE)) ?? EMPTY_GROUPS
  const result = { sessionId, workspaceId }
  if ((current.assignments[sessionId] ?? null) === workspaceId) return result
  await ctx.settings.mutate(SESSION_GROUPS_NAMESPACE, [workspaceId === null
    ? { op: 'unset', path: ['assignments', sessionId] }
    : { op: 'set', path: ['assignments', sessionId], value: workspaceId }])
  return result
}
