import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import { currentSessionId } from '../../../platform/dsh/client/runtime.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../../projectless-tasks/shared.js'
import { WORKSPACE_HIDE_PATCH_ID } from '../shared.js'
import { effectiveHiddenWorkspaceIds, recentVisibleWorkspaceId } from './projection.js'
import type { HiddenWorkspaceController } from './store.js'

interface Navigation {
  startSession(workspaceId?: WorkspaceId, options?: unknown): void
  clearMain?(): void
}

type Activation = Pick<PatchActivationSource, 'getSnapshot' | 'subscribe'>

function resolveSessionNativeWorkspace(
  list: SessionListState,
  workspaces: WorkspaceSnapshot,
): { inWorkspace: false } | { inWorkspace: true; workspaceId: WorkspaceId } {
  const current = currentSessionId(list)
  if (current === undefined) return { inWorkspace: false }
  const visited = new Set<SessionId>()
  let id: SessionId | undefined = current
  while (id !== undefined && !visited.has(id)) {
    visited.add(id)
    const workspace = workspaces.items.find((item) => item.sessionIds.includes(id!))
    if (workspace !== undefined) return { inWorkspace: true, workspaceId: workspace.workspaceId }
    const summary: SessionSummary | undefined = list.byId[id]
    if (summary === undefined) return { inWorkspace: false }
    if (summary.origin === 'subagent') {
      id = summary.parentId
      continue
    }
    return { inWorkspace: false }
  }
  return { inWorkspace: false }
}

/**
 * Prevent global "New session" without an explicit workspace from selecting a
 * hidden workspace as the current or most-recent destination.
 */
export function bindHiddenNewSessionNavigation({
  navigation,
  sessions,
  workspaces,
  activation,
  hiddenController,
}: {
  navigation: Navigation
  sessions: Pick<ISessions, 'list'>
  workspaces: Pick<IWorkspaces, 'list'>
  activation: Activation
  hiddenController: Pick<HiddenWorkspaceController, 'getSnapshot'>
}): () => void {
  let disposed = false
  let uninstall: (() => void) | undefined

  const sync = (): void => {
    const enabled = !disposed && activation.getSnapshot()[WORKSPACE_HIDE_PATCH_ID]
    if (!enabled) {
      uninstall?.()
      uninstall = undefined
      return
    }
    if (uninstall !== undefined) return

    const descriptor = Object.getOwnPropertyDescriptor(navigation, 'startSession')
    const original = navigation.startSession
    let active = true

    const start: Navigation['startSession'] = (workspaceId, options) => {
      if (!active || workspaceId !== undefined) {
        return original.call(navigation, workspaceId, options)
      }
      const workspacesSnapshot = workspaces.list.getSnapshot()
      const sessionsSnapshot = sessions.list.getSnapshot()
      if (workspacesSnapshot.phase !== 'ready' || sessionsSnapshot.phase !== 'ready') {
        return original.call(navigation, workspaceId, options)
      }

      const hiddenIds = effectiveHiddenWorkspaceIds(workspacesSnapshot, hiddenController.getSnapshot().effective)
      if (hiddenIds.size === 0) {
        return original.call(navigation, workspaceId, options)
      }

      const currentMembership = resolveSessionNativeWorkspace(sessionsSnapshot, workspacesSnapshot)
      if (currentMembership.inWorkspace) {
        if (!hiddenIds.has(currentMembership.workspaceId)) {
          return original.call(navigation, workspaceId, options)
        }
      } else if (currentSessionId(sessionsSnapshot) !== undefined
        && activation.getSnapshot()[PROJECTLESS_TASKS_PATCH_ID]) {
        return original.call(navigation, workspaceId, options)
      }

      const recent = recentVisibleWorkspaceId(workspacesSnapshot, sessionsSnapshot, hiddenIds)
      if (recent !== undefined) {
        return original.call(navigation, recent, options)
      }

      const draftRequested = typeof options === 'object' && options !== null
        && ('prompt' in options && options.prompt !== undefined || 'clearPreviousDraft' in options && options.clearPreviousDraft === true)
      if (!draftRequested && typeof navigation.clearMain === 'function') {
        navigation.clearMain()
        return
      }
      return original.call(navigation, workspaceId, options)
    }

    navigation.startSession = start
    uninstall = () => {
      active = false
      if (Object.getOwnPropertyDescriptor(navigation, 'startSession')?.value !== start) return
      if (descriptor === undefined) Reflect.deleteProperty(navigation, 'startSession')
      else Object.defineProperty(navigation, 'startSession', descriptor)
    }
  }

  const unsubscribe = activation.subscribe(sync)
  try { sync() } catch (error) { unsubscribe(); throw error }
  return () => {
    disposed = true
    unsubscribe()
    sync()
  }
}

export function installHiddenNewSessionNavigation(
  ctx: Context,
  activation: Activation,
  hiddenController: Pick<HiddenWorkspaceController, 'getSnapshot'>,
): () => void {
  const navigation: unknown = ctx.get('uiWorkspace')
  const sessions: unknown = ctx.sessions
  const workspaces: unknown = ctx.workspaces
  if (typeof navigation !== 'object' || navigation === null || !('startSession' in navigation) || typeof navigation.startSession !== 'function'
    || typeof sessions !== 'object' || sessions === null || !('list' in sessions)
    || typeof workspaces !== 'object' || workspaces === null || !('list' in workspaces)) {
    return () => {}
  }
  return bindHiddenNewSessionNavigation({
    navigation: navigation as Navigation,
    sessions: sessions as Pick<ISessions, 'list'>,
    workspaces: workspaces as Pick<IWorkspaces, 'list'>,
    activation,
    hiddenController,
  })
}
