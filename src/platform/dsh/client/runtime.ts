import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface RefreshableSessions extends Pick<ISessions, 'list' | 'open'> {
  refresh(): Promise<void>
}

export interface RefreshableWorkspaces extends IWorkspaces {
  refresh(): Promise<void>
}

export interface SessionReference {
  ready: Promise<unknown>
  release(): void
}

export interface TaskSessionActions extends Pick<ISessions, 'create' | 'open'> {
  retain?(id: SessionId): SessionReference
}

/** 0.1.7 moved view selection out of the catalog and exposes reference owners. */
export function currentSessionId(list: SessionListState): SessionId | undefined {
  if (list.current !== undefined) return list.current
  return Object.values(list.byId).find((row) => {
    const retained = (row as typeof row & { retainedBy?: { mainView?: number } }).retainedBy
    return (retained?.mainView ?? 0) > 0
  })?.id
}

/** Keep navigation in its owning UI service; never add methods to native Sessions. */
export function clientSessions(ctx: Context): RefreshableSessions {
  const sessions = ctx.sessions as unknown as Pick<RefreshableSessions, 'list' | 'refresh'> & { open?: ISessions['open'] }
  const navigation: unknown = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
  let open: ISessions['open']
  if (typeof sessions.open === 'function') open = (id) => sessions.open!(id)
  else if (typeof navigation === 'object' && navigation !== null
    && 'openSession' in navigation && typeof navigation.openSession === 'function') {
    const openSession = navigation.openSession as ISessions['open']
    open = (id) => openSession.call(navigation, id)
  } else throw new Error('当前 DSH 版本不支持会话导航，请检查会话接口。')
  return { list: sessions.list, refresh: () => sessions.refresh(), open }
}

/** New desktop clients require a temporary reference before borrowing a created draft. */
export function clientSessionActions(ctx: Context): TaskSessionActions {
  const sessions: unknown = ctx.sessions
  if (typeof sessions !== 'object' || sessions === null || !('create' in sessions) || typeof sessions.create !== 'function') {
    throw new Error('当前 DSH 版本不支持独立任务，请检查会话接口。')
  }
  const create = sessions.create as ISessions['create']
  const actions: TaskSessionActions = { create: (options) => create.call(sessions, options), open: clientSessions(ctx).open }
  if ('retain' in sessions && typeof sessions.retain === 'function') {
    const retain = sessions.retain as (id: SessionId, options: { source: string }) => SessionReference
    actions.retain = (id) => retain.call(sessions, id, { source: 'dsh-more-draft-transfer' })
  }
  return actions
}
