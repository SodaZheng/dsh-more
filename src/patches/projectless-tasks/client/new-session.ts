import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import { apiErrorText } from '../../../platform/dsh/client/api.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../shared.js'
import { createTaskStarter } from './create-task.js'

interface Navigation {
  startSession(workspaceId?: WorkspaceId): void
}
type Sessions = Pick<ISessions, 'list' | 'create' | 'open'>
type Activation = Pick<PatchActivationSource, 'getSnapshot' | 'subscribe'>
type NewSessionTarget =
  | { kind: 'workspace'; workspaceId: WorkspaceId }
  | { kind: 'independent'; sourceId: SessionId }
  | { kind: 'native' }
  | { kind: 'pending' }

/** Explicit destinations win; otherwise follow the current page, never project recency. */
export function newSessionTarget(list: SessionListState, workspaces: WorkspaceSnapshot, explicit?: WorkspaceId): NewSessionTarget {
  if (explicit !== undefined) return { kind: 'workspace', workspaceId: explicit }
  if (list.current === undefined) return { kind: 'native' }
  if (list.phase !== 'ready' || workspaces.phase !== 'ready') return { kind: 'pending' }
  const visited = new Set<SessionId>()
  let id: SessionId | undefined = list.current
  while (id !== undefined && !visited.has(id)) {
    visited.add(id)
    const workspace = workspaces.items.find((item) => item.sessionIds.includes(id!))
    if (workspace !== undefined) return { kind: 'workspace', workspaceId: workspace.workspaceId }
    const summary: SessionSummary | undefined = list.byId[id]
    if (summary === undefined) return { kind: 'pending' }
    // Child agents inherit their owning task's destination, rather than being
    // mistaken for independent tasks just because they have no direct membership.
    if (summary.origin === 'subagent') { id = summary.parentId; continue }
    return typeof summary.cwd === 'string' && summary.cwd.length > 0
      ? { kind: 'independent', sourceId: list.current }
      : { kind: 'pending' }
  }
  return { kind: 'pending' }
}

/** One reversible service wrapper covers sidebar, brand and native New Session callers. */
export function bindNewSessionNavigation({ navigation, sessions, workspaces, activation, reportError }: {
  navigation: Navigation
  sessions: Sessions
  workspaces: Pick<IWorkspaces, 'list'>
  activation: Activation
  reportError(sourceId: SessionId, error: unknown): void
}): () => void {
  let disposed = false
  let uninstall: (() => void) | undefined
  const sync = (): void => {
    const enabled = !disposed && activation.getSnapshot()[PROJECTLESS_TASKS_PATCH_ID]
    if (!enabled) { uninstall?.(); uninstall = undefined; return }
    if (uninstall !== undefined) return
    const descriptor = Object.getOwnPropertyDescriptor(navigation, 'startSession')
    const original = navigation.startSession
    let active = true
    let attempt: { sourceId: SessionId; starter: ReturnType<typeof createTaskStarter>; flight?: Promise<void> } | undefined
    const cancel = (): void => { attempt?.starter.dispose(); attempt = undefined }
    const start: Navigation['startSession'] = (workspaceId) => {
      // A later plugin may retain this wrapper after our teardown.
      if (!active) return original.call(navigation, workspaceId)
      const list = sessions.list.getSnapshot()
      const target = newSessionTarget(list, workspaces.list.getSnapshot(), workspaceId)
      if (target.kind === 'workspace' || target.kind === 'native') {
        cancel()
        return original.call(navigation, target.kind === 'workspace' ? target.workspaceId : workspaceId)
      }
      if (target.kind === 'pending') {
        cancel()
        if (list.current !== undefined) reportError(list.current, new Error('会话来源仍在加载，请稍后再新建会话。'))
        return
      }
      if (attempt?.sourceId !== target.sourceId) {
        cancel()
        attempt = { sourceId: target.sourceId, starter: createTaskStarter(sessions) }
      }
      const current = attempt
      if (current === undefined || current.flight !== undefined) return
      current.flight = current.starter.start(() => {
        if (!active || attempt !== current) return false
        const destination = newSessionTarget(sessions.list.getSnapshot(), workspaces.list.getSnapshot())
        return destination.kind === 'independent' && destination.sourceId === current.sourceId
      }).catch((error: unknown) => {
        if (active && attempt === current && sessions.list.getSnapshot().current === current.sourceId) {
          reportError(current.sourceId, error)
        }
      }).finally(() => { delete current.flight })
    }
    navigation.startSession = start
    uninstall = () => {
      active = false
      cancel()
      // Cordis returns a new callable proxy on reads; compare the own descriptor.
      if (Object.getOwnPropertyDescriptor(navigation, 'startSession')?.value !== start) return
      if (descriptor === undefined) Reflect.deleteProperty(navigation, 'startSession')
      else Object.defineProperty(navigation, 'startSession', descriptor)
    }
  }
  const unsubscribe = activation.subscribe(sync)
  try { sync() } catch (error) { unsubscribe(); throw error }
  return () => { disposed = true; unsubscribe(); sync() }
}

/** Keep the untyped native service seam local, validated and injection-owned. */
export function installNewSessionNavigation(ctx: Context, activation: Activation): () => void {
  const navigation: unknown = ctx.get('uiWorkspace')
  const sessions: unknown = ctx.sessions
  if (typeof navigation !== 'object' || navigation === null || !('startSession' in navigation) || typeof navigation.startSession !== 'function'
    || typeof sessions !== 'object' || sessions === null || !('create' in sessions) || typeof sessions.create !== 'function'
    || !('open' in sessions) || typeof sessions.open !== 'function' || !('scope' in sessions) || typeof sessions.scope !== 'function'
    || !('list' in sessions) || typeof sessions.list !== 'object' || sessions.list === null
    || !('getSnapshot' in sessions.list) || typeof sessions.list.getSnapshot !== 'function') {
    throw new Error('当前 DSH 版本不支持跟随会话来源新建任务。')
  }
  const clientSessions = sessions as Sessions & Pick<ISessions, 'scope'>
  return bindNewSessionNavigation({
    navigation: navigation as Navigation,
    sessions: clientSessions,
    workspaces: ctx.workspaces,
    activation,
    reportError: (sourceId, error) => {
      const scope = clientSessions.scope(sourceId)
      const message = `新建会话失败：${apiErrorText(error)}`
      if (scope !== undefined) ctx.conversation.input.for(scope).notify('error', message)
      else ctx.logger.warn(message)
    },
  })
}
