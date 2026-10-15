import { describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { clientSessionActions, clientSessions, currentSessionId } from '../../src/platform/dsh/client/runtime.js'
import { installNewSessionNavigation, newSessionTarget } from '../../src/patches/projectless-tasks/client/new-session.js'
import { DEFAULT_PATCH_SETTINGS } from '../../src/generated/patch-catalog.js'

const id = 'task-desktop' as SessionId
const list = {
  phase: 'ready', ids: [id], byId: { [id]: { id, cwd: '/task', retainedBy: { mainView: 1 } } },
} as unknown as SessionListState

describe('desktop Session selection and navigation', () => {
  it('reads mainView retention when the native catalog no longer has current', () => {
    expect(currentSessionId(list)).toBe(id)
    expect(newSessionTarget(list, { phase: 'ready', items: [] } as never)).toEqual({ kind: 'independent', sourceId: id })
    expect(currentSessionId({ ...list, byId: {} })).toBeUndefined()
  })

  it('installs new-session behavior without sessions.open and navigates via uiWorkspace', () => {
    const nativeStart = vi.fn()
    const navigation = { startSession: nativeStart, openSession: vi.fn() }
    const reference = { ready: Promise.resolve(), release: vi.fn() }
    const sessions = {
      list: { getSnapshot: () => list, subscribe: () => () => {} },
      create: vi.fn(async () => id), scope: vi.fn(), refresh: vi.fn(async () => {}),
      retain: vi.fn(() => reference),
    }
    const ctx = { sessions, workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }) } }, get: () => navigation }
    const activation = { getSnapshot: () => DEFAULT_PATCH_SETTINGS, subscribe: () => () => {} }
    const dispose = installNewSessionNavigation(ctx as never, activation)
    expect(navigation.startSession).not.toBe(nativeStart)
    const actions = clientSessionActions(ctx as never)
    actions.open(id)
    expect(navigation.openSession).toHaveBeenCalledExactlyOnceWith(id)
    expect(actions.retain?.(id)).toBe(reference)
    expect(sessions.retain).toHaveBeenCalledWith(id, { source: 'dsh-more-draft-transfer' })
    expect('open' in sessions).toBe(false)
    dispose()
    expect(navigation.startSession).toBe(nativeStart)
  })

  it('keeps the legacy Session controller as its own navigation receiver', () => {
    const sessions = { open: vi.fn(function(this: unknown) { expect(this).toBe(sessions) }), list: {}, refresh: vi.fn() }
    clientSessions({ sessions, get: () => undefined } as never).open(id)
    expect(sessions.open).toHaveBeenCalledExactlyOnceWith(id)
  })
})
