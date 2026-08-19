import { describe, expect, it, vi } from 'vitest'
import type {
  SessionId,
  SessionListState,
  WorkspaceId,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { RefreshableSessions, RefreshableWorkspaces } from '../../src/platform/dsh/client/runtime.js'
import {
  adjacentVisibleSession,
  followSessionHandoff,
  settleSessionRemoval,
} from '../../src/platform/dsh/client/session-sync.js'

function observable<T>(initial: T): {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

const sourceId = 'session-source' as SessionId
const childId = 'session-child' as SessionId
const workspaceId = 'workspace-test' as WorkspaceId

function sessionState(ids: SessionId[], current: SessionId | undefined = sourceId): SessionListState {
  return {
    ids,
    byId: Object.fromEntries(ids.map((id) => [id, {
      id,
      displayTitle: id,
      running: false,
      blank: false,
      updatedAt: 1,
    }])) as SessionListState['byId'],
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspaceState(sessionIds: SessionId[]): WorkspaceListState {
  return {
    items: [{
      workspaceId,
      title: 'Test',
      path: '/test',
      sessionIds,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: workspaceId,
  }
}

describe('incremental client session synchronization', () => {
  it('opens a continuation from the session-added projection without a full refresh', async () => {
    const list = observable(sessionState([sourceId]))
    const open = vi.fn()
    const refresh = vi.fn(async () => undefined)
    const sessions = { list, open, refresh } as unknown as RefreshableSessions
    const handoff = followSessionHandoff(sessions, childId)

    list.set(sessionState([childId, sourceId]))
    await handoff.finish(childId)

    expect(open).toHaveBeenCalledWith(childId)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('uses a baseline pull only when the continuation frame is missing', async () => {
    const list = observable(sessionState([sourceId]))
    const open = vi.fn()
    const refresh = vi.fn(async () => { list.set(sessionState([childId, sourceId])) })
    const sessions = { list, open, refresh } as unknown as RefreshableSessions
    const handoff = followSessionHandoff(sessions, childId)

    await handoff.finish(childId)

    expect(refresh).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(childId)
  })

  it('settles a permanent deletion from push projections without refreshing', async () => {
    const sessionList = observable(sessionState([sourceId, childId]))
    const workspaceList = observable(workspaceState([sourceId, childId]))
    const refreshSessions = vi.fn(async () => undefined)
    const refreshWorkspaces = vi.fn(async () => undefined)
    const sessions = { list: sessionList, refresh: refreshSessions } as unknown as RefreshableSessions
    const workspaces = { list: workspaceList, refresh: refreshWorkspaces } as unknown as RefreshableWorkspaces
    const settling = settleSessionRemoval(sessions, workspaces, sourceId)

    sessionList.set(sessionState([childId], childId))
    workspaceList.set(workspaceState([childId]))
    await settling

    expect(refreshSessions).not.toHaveBeenCalled()
    expect(refreshWorkspaces).not.toHaveBeenCalled()
  })

  it('chooses the nearest visible session only when deleting the current row', () => {
    const archivedId = 'session-archived' as SessionId
    const sessions = sessionState([sourceId, archivedId, childId])
    const workspaces = { ...workspaceState([sourceId, archivedId, childId]), archivedSessionIds: [archivedId] }
    expect(adjacentVisibleSession(sessions, workspaces, sourceId)).toBe(childId)
    expect(adjacentVisibleSession({ ...sessions, current: childId }, workspaces, sourceId)).toBeUndefined()
  })
})
