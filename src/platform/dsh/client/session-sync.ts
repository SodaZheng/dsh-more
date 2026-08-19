import type { SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { RefreshableSessions, RefreshableWorkspaces } from './runtime.js'

const INCREMENTAL_SYNC_GRACE_MS = 180

/** Switch synchronously so a following archive/removal frame cannot expose the empty view. */
export function openSessionWithoutGap(sessions: RefreshableSessions, sessionId: SessionId): void {
  sessions.open(sessionId)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export interface SessionHandoff {
  finish(returnedSessionId: string): Promise<void>
  cancel(): void
}

/**
 * Follow the Host's session-added frame and navigate before the source session's
 * later archive frame can clear the current view. A baseline refresh is only a
 * fallback for a delayed or missing incremental frame.
 */
export function followSessionHandoff(
  sessions: RefreshableSessions,
  targetSessionId: SessionId,
): SessionHandoff {
  let disposed = false
  let opened = false
  let unsubscribe: () => void = () => undefined
  let resolveArrival: () => void = () => undefined
  const arrival = new Promise<void>((resolve) => { resolveArrival = resolve })

  const reconcile = (): void => {
    if (disposed || opened || sessions.list.getSnapshot().byId[targetSessionId] === undefined) return
    opened = true
    unsubscribe()
    resolveArrival()
    openSessionWithoutGap(sessions, targetSessionId)
  }
  unsubscribe = sessions.list.subscribe(reconcile)
  reconcile()

  return {
    finish: async (returnedSessionId) => {
      if (returnedSessionId !== targetSessionId) {
        throw new Error('Host 返回的新会话与预览不一致，请重新操作。')
      }
      if (!opened) await Promise.race([arrival, delay(INCREMENTAL_SYNC_GRACE_MS)])
      if (!opened) {
        await sessions.refresh()
        reconcile()
      }
      if (!opened) throw new Error('新会话已创建，但客户端列表尚未同步，请稍后重试。')
    },
    cancel: () => {
      disposed = true
      unsubscribe()
    },
  }
}

function sessionRemovalSettled(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  sessionId: SessionId,
): boolean {
  return sessions.byId[sessionId] === undefined
    && workspaces.items.every((workspace) => !workspace.sessionIds.includes(sessionId))
}

/** Prefer push-frame convergence after deletion; re-pull both baselines only as a fallback. */
export async function settleSessionRemoval(
  sessions: RefreshableSessions,
  workspaces: RefreshableWorkspaces,
  sessionId: SessionId,
): Promise<void> {
  const settled = (): boolean => sessionRemovalSettled(
    sessions.list.getSnapshot(),
    workspaces.list.getSnapshot(),
    sessionId,
  )
  if (settled()) return

  await new Promise<void>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribeSessions()
      unsubscribeWorkspaces()
      resolve()
    }
    const reconcile = (): void => { if (settled()) finish() }
    const unsubscribeSessions = sessions.list.subscribe(reconcile)
    const unsubscribeWorkspaces = workspaces.list.subscribe(reconcile)
    timer = setTimeout(finish, INCREMENTAL_SYNC_GRACE_MS)
    reconcile()
  })
  if (settled()) return

  await Promise.all([sessions.refresh(), workspaces.refresh()])
  if (!settled()) throw new Error('会话已删除，但客户端列表尚未同步，请重新打开页面。')
}

/** Pick the nearest non-archived row so deleting the current session never exposes a blank gap. */
export function adjacentVisibleSession(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  deletingSessionId: SessionId,
): SessionId | undefined {
  if (sessions.current !== deletingSessionId) return undefined
  const archived = new Set(workspaces.archivedSessionIds)
  const visible = sessions.ids.filter((id) => id !== deletingSessionId && !archived.has(id))
  if (visible.length === 0) return undefined
  const deletingIndex = sessions.ids.indexOf(deletingSessionId)
  return visible.find((id) => sessions.ids.indexOf(id) > deletingIndex) ?? visible.at(-1)
}
