import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
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

function workspaceState(sessionIds: SessionId[]): WorkspaceSnapshot {
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

  it('finds a fallback with one index lookup even at the end of a large list', () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => `session-${String(index)}` as SessionId)
    const deletingId = ids.at(-1) as SessionId
    let indexLookups = 0
    const originalIndexOf = ids.indexOf.bind(ids)
    ids.indexOf = ((searchElement: SessionId, fromIndex?: number) => {
      indexLookups += 1
      return originalIndexOf(searchElement, fromIndex)
    }) as typeof ids.indexOf
    const sessions = sessionState(ids, deletingId)
    const workspaces = workspaceState(ids)

    expect(adjacentVisibleSession(sessions, workspaces, deletingId)).toBe(ids.at(-2))
    expect(indexLookups).toBe(1)
  })
})
