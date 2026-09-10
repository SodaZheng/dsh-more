import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'
import { PROJECTLESS_TASKS_PATCH_ID as ID } from './shared.js'
import { bindNewSessionNavigation, newSessionTarget } from './client/new-session.js'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(), apiErrorText: String }))
const sid = (value: string) => value as SessionId
const wid = (value: string) => value as WorkspaceId
const taskId = sid('task-00000000-0000-4000-8000-000000000001')
const sourceId = sid('independent')
const projectSession = sid('project-session')
const projectId = wid('project')
const summary = (id: SessionId, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, displayTitle: String(id), cwd: '/ordinary-folder', running: false, blank: false, updatedAt: 0, ...extra,
})
function sessionList(current: SessionId | undefined = sourceId): SessionListState {
  return {
    current, ids: [sourceId, projectSession], byId: {
      [sourceId]: summary(sourceId, { cwd: '/Documents/DSH/tasks/previous-task' }),
      [projectSession]: summary(projectSession, { cwd: '/repo' }),
    }, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}
const project: WorkspaceView = { workspaceId: projectId, path: '/repo', title: 'Project', sessionIds: [projectSession], createdAt: '', updatedAt: '' }
function workspaceList(): WorkspaceSnapshot {
  return { items: [project], archivedSessionIds: [], phase: 'ready', state: 'idle', error: null }
}
const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).reverse().forEach((dispose) => dispose()); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe('New Session destination', () => {
  it('keeps independent pages independent even when a recent project exists', () => {
    expect(newSessionTarget(sessionList(), workspaceList())).toEqual({ kind: 'independent', sourceId })
    const blank = sessionList()
    blank.byId[sourceId] = summary(sourceId, { blank: true })
    expect(newSessionTarget(blank, workspaceList())).toEqual({ kind: 'independent', sourceId })
  })

  it('uses the current project, while an explicit project always wins', () => {
    expect(newSessionTarget(sessionList(projectSession), workspaceList())).toEqual({ kind: 'workspace', workspaceId: projectId })
    expect(newSessionTarget(sessionList(), workspaceList(), wid('other'))).toEqual({ kind: 'workspace', workspaceId: 'other' })
  })

  it('waits for a known source instead of falling back to recent projects', () => {
    expect(newSessionTarget({ ...sessionList(), phase: 'pending' }, workspaceList())).toEqual({ kind: 'pending' })
    expect(newSessionTarget(sessionList(), { ...workspaceList(), phase: 'pending' })).toEqual({ kind: 'pending' })
    expect(newSessionTarget(sessionList(sid('missing')), workspaceList())).toEqual({ kind: 'pending' })
    expect(newSessionTarget({ ...sessionList(), current: undefined }, workspaceList())).toEqual({ kind: 'native' })
  })

  it('follows child-agent ownership and fails closed on broken lineage', () => {
    const child = sid('child')
    const list = sessionList(child)
    list.byId[child] = summary(child, { origin: 'subagent', parentId: projectSession })
    expect(newSessionTarget(list, workspaceList())).toEqual({ kind: 'workspace', workspaceId: projectId })
    list.byId[child] = summary(child, { origin: 'subagent', parentId: sourceId })
    expect(newSessionTarget(list, workspaceList())).toEqual({ kind: 'independent', sourceId: child })
    list.byId[child] = summary(child, { origin: 'subagent', parentId: child })
    expect(newSessionTarget(list, workspaceList())).toEqual({ kind: 'pending' })
  })
})

function harness() {
  let list = sessionList()
  let settings = { ...DEFAULT_PATCH_SETTINGS }
  const listeners = new Set<() => void>()
  vi.stubGlobal('crypto', { randomUUID: () => String(taskId).slice(5) })
  vi.mocked(callPatchApi).mockResolvedValue({ sessionId: taskId, cwd: `/Documents/DSH/tasks/${taskId}` })
  const original = vi.fn(function (this: object, _workspaceId?: WorkspaceId) { return this })
  // The shipped navigation method is inherited from the service prototype.
  const navigation: { startSession(workspaceId?: WorkspaceId): void } = Object.create({ startSession: original })
  const create = vi.fn<NonNullable<Pick<ISessions, 'create'>['create']>>(async () => taskId)
  const open = vi.fn((id: SessionId) => {
    list = { ...list, current: id, byId: { ...list.byId, [id]: summary(id) } }
  })
  const reportError = vi.fn()
  const dispose = bindNewSessionNavigation({
    navigation,
    sessions: { create, open, list: { getSnapshot: () => list, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: workspaceList, subscribe: () => () => {} } },
    activation: {
      getSnapshot: () => settings,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    reportError,
  })
  disposers.push(dispose)
  return {
    navigation, original, create, open, reportError, dispose,
    select: (id: SessionId | undefined) => { list = { ...list, current: id } },
    toggle: (enabled: boolean) => { settings = { ...settings, [ID]: enabled }; listeners.forEach((listener) => listener()) },
  }
}

describe('source-aware native new-session entry', () => {
  it('creates a fresh independent directory once and opens only after native creation', async () => {
    const app = harness()
    app.navigation.startSession()
    app.navigation.startSession()
    expect(app.original).not.toHaveBeenCalled()
    expect(app.open).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(app.open).toHaveBeenCalledExactlyOnceWith(taskId))
    expect(app.create).toHaveBeenCalledExactlyOnceWith({ sessionId: taskId, cwd: `/Documents/DSH/tasks/${taskId}` })
  })

  it('retains native project and no-current behavior with the correct service receiver', () => {
    const app = harness()
    app.navigation.startSession(wid('explicit'))
    app.select(projectSession)
    app.navigation.startSession()
    app.select(undefined)
    app.navigation.startSession()
    expect(app.original.mock.calls).toEqual([['explicit'], [projectId], [undefined]])
    expect(app.original.mock.contexts.every((value) => value === app.navigation)).toBe(true)
    expect(app.create).not.toHaveBeenCalled()
  })

  it('reports failure in the source and retries the same task identity without project fallback', async () => {
    const app = harness()
    app.create.mockRejectedValueOnce(new Error('response lost'))
    app.navigation.startSession()
    await vi.waitFor(() => expect(app.reportError).toHaveBeenCalledOnce())
    expect(app.open).not.toHaveBeenCalled()
    app.navigation.startSession()
    await vi.waitFor(() => expect(app.open).toHaveBeenCalledOnce())
    expect(app.create.mock.calls[0]).toEqual(app.create.mock.calls[1])
    expect(app.original).not.toHaveBeenCalled()
  })

  it('restores the inherited method on disable and permits re-enabling without duplicate wrappers', async () => {
    const app = harness()
    app.toggle(false)
    expect(Object.hasOwn(app.navigation, 'startSession')).toBe(false)
    app.navigation.startSession()
    expect(app.original).toHaveBeenCalledOnce()
    app.toggle(true)
    app.navigation.startSession()
    await vi.waitFor(() => expect(app.open).toHaveBeenCalledOnce())
    app.dispose()
    expect(Object.hasOwn(app.navigation, 'startSession')).toBe(false)
  })

  it.each(['navigate', 'explicit', 'disable', 'dispose'] as const)('does not hijack the page after %s during creation', async (change) => {
    const app = harness()
    let resolve: (id: SessionId) => void = () => {}
    app.create.mockImplementationOnce(() => new Promise<SessionId>((done) => { resolve = done }))
    app.navigation.startSession()
    await vi.waitFor(() => expect(app.create).toHaveBeenCalledOnce())
    if (change === 'navigate') app.select(projectSession)
    else if (change === 'explicit') app.navigation.startSession(projectId)
    else if (change === 'disable') app.toggle(false)
    else app.dispose()
    resolve(taskId)
    await new Promise((done) => setTimeout(done, 0))
    expect(app.open).not.toHaveBeenCalled()
  })

  it('leaves later wrappers intact on teardown, while its retained wrapper becomes inert', () => {
    const app = harness()
    const retained = app.navigation.startSession
    const later = vi.fn((id?: WorkspaceId) => retained(id))
    app.navigation.startSession = later
    app.dispose()
    expect(app.navigation.startSession).toBe(later)
    app.navigation.startSession(projectId)
    expect(app.original).toHaveBeenCalledExactlyOnceWith(projectId)
    expect(app.create).not.toHaveBeenCalled()
  })
})
