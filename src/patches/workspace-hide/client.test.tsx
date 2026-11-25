// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'
import type { SettingsScope, SettingsScopeSnapshot } from '../../platform/dsh/client/settings.js'
import type { SessionGroups } from '../projectless-tasks/groups.js'
import {
  adjacentVisibleSessionOutsideHidden,
  collectHiddenSessionIds,
  effectiveHiddenWorkspaceIds,
  projectVisibleSessions,
  projectVisibleWorkspaces,
  recentVisibleWorkspaceId,
} from './client/projection.js'
import { createHiddenWorkspaceController } from './client/store.js'
import { extendHiddenWorkspacesSidebar } from './client/sidebar.js'
import { extendHiddenWorkspacePicker } from './client/picker.js'
import { bindHiddenNewSessionNavigation } from './client/new-session.js'
import type { HiddenWorkspaces } from './shared.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'> & { variant?: string; size?: string }) => {
    const { variant: _v, size: _s, ...rest } = props
    return <button type="button" {...rest} />
  },
  Modal: ({ open, title, description, children, footer }: {
    open: boolean
    title: string
    description?: string
    children: ReactNode
    footer: ReactNode
  }) => open ? <div role="dialog" aria-label={title}><h2>{title}</h2>{description && <p>{description}</p>}{children}{footer}</div> : null,
}))

vi.mock('../../platform/dsh/client/api.js', () => ({
  callPatchApi: vi.fn(),
  apiErrorText: (error: unknown) => error instanceof Error ? error.message : String(error),
}))

let root: Root | undefined
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

const workspacesSnapshot: WorkspaceSnapshot = {
  phase: 'ready',
  state: 'idle',
  error: null,
  archivedSessionIds: ['s-archived' as SessionId],
  pinnedSessionIds: [],
  items: [
    {
      workspaceId: 'ws-a' as WorkspaceId,
      title: 'Alpha',
      path: '/work/alpha',
      sessionIds: ['s-a1' as SessionId, 's-a2' as SessionId],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      workspaceId: 'ws-b' as WorkspaceId,
      title: 'Beta',
      path: '/work/beta',
      sessionIds: ['s-b1' as SessionId, 's-archived' as SessionId],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  ],
}

const sessionsSnapshot = {
  phase: 'ready',
  ids: ['s-a1', 's-a2', 's-a1-sub', 's-manual', 's-b1', 's-archived', 's-ungrouped'],
  byId: {
    's-a1': { id: 's-a1', cwd: '/work/alpha', updatedAt: 100, blank: false, retainedBy: { mainView: 1 } },
    's-a2': { id: 's-a2', cwd: '/work/alpha', updatedAt: 90, blank: false, retainedBy: {} },
    's-a1-sub': { id: 's-a1-sub', cwd: '/work/alpha', origin: 'subagent', parentId: 's-a1', updatedAt: 95, blank: false, retainedBy: {} },
    's-manual': { id: 's-manual', cwd: '/tasks/t1', updatedAt: 85, blank: false, retainedBy: {} },
    's-b1': { id: 's-b1', cwd: '/work/beta', updatedAt: 200, blank: false, retainedBy: {} },
    's-archived': { id: 's-archived', cwd: '/work/beta', updatedAt: 150, blank: false, retainedBy: {} },
    's-ungrouped': { id: 's-ungrouped', cwd: '/tasks/t2', updatedAt: 50, blank: false, retainedBy: {} },
  },
} as unknown as SessionListState

function createScope<T>(initial: T) {
  let snap: SettingsScopeSnapshot<T> = {
    status: 'ready',
    writable: true,
    value: initial,
    base: undefined,
    user: undefined,
    revision: 0,
  }
  const listeners = new Set<() => void>()
  const scope: SettingsScope<T> = {
    getSnapshot: () => snap,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async () => {},
    unset: async () => {},
    mutate: async () => {},
  }
  return {
    scope,
    publish: (value: T) => {
      snap = { ...snap, value }
      listeners.forEach((listener) => listener())
    },
    setMeta: (meta: Partial<SettingsScopeSnapshot<T>>) => {
      snap = { ...snap, ...meta }
      listeners.forEach((listener) => listener())
    },
  }
}

describe('workspace-hide projections', () => {
  it('hides workspace sessions, manual group assignments, and subagent descendants without spilling into ungrouped', () => {
    const hiddenIds = effectiveHiddenWorkspaceIds(workspacesSnapshot, { hidden: { 'ws-a': true, missing: true } })
    expect([...hiddenIds]).toEqual(['ws-a'])

    const groups: SessionGroups = { assignments: { 's-manual': 'ws-a', 's-b1': 'ws-a' } }
    const hiddenSessions = collectHiddenSessionIds(workspacesSnapshot, sessionsSnapshot, hiddenIds, groups)
    expect([...hiddenSessions].sort()).toEqual(['s-a1', 's-a1-sub', 's-a2', 's-manual'])

    const visibleWorkspaces = projectVisibleWorkspaces(workspacesSnapshot, hiddenIds)
    expect(visibleWorkspaces.items.map((item) => item.workspaceId)).toEqual(['ws-b'])
    expect(projectVisibleWorkspaces(workspacesSnapshot, hiddenIds, 'ws-a' as WorkspaceId).items.length).toBe(2)

    const visibleSessions = projectVisibleSessions(sessionsSnapshot, hiddenSessions)
    expect(visibleSessions.ids).toEqual(['s-b1', 's-archived', 's-ungrouped'])
    expect(visibleSessions.byId['s-a1' as SessionId]).toBeUndefined()
    expect(visibleSessions.byId['s-manual' as SessionId]).toBeUndefined()
    expect(visibleSessions.byId['s-b1' as SessionId]).toBeDefined()

    expect(adjacentVisibleSessionOutsideHidden(sessionsSnapshot, workspacesSnapshot, hiddenIds, groups)).toBe('s-b1')
    expect(recentVisibleWorkspaceId(workspacesSnapshot, sessionsSnapshot, hiddenIds)).toBe('ws-b')
  })
})

describe('workspace-hide sidebar, menus, picker, and new-session navigation', () => {
  async function mountSidebar() {
    let settings = { ...DEFAULT_PATCH_SETTINGS }
    const activationListeners = new Set<() => void>()
    const activation = {
      getSnapshot: () => settings,
      subscribe: (fn: () => void) => { activationListeners.add(fn); return () => { activationListeners.delete(fn) } },
      getSettingsSnapshot: () => ({ status: 'ready' as const, writable: true, value: settings }),
      set: async () => {},
    }

    const hiddenStore = createScope<HiddenWorkspaces>({ hidden: {} })
    const groupsStore = createScope<SessionGroups>({ assignments: { 's-manual': 'ws-a' } })
    const controller = createHiddenWorkspaceController(hiddenStore.scope)

    const retainAccountKeys = vi.fn()
    const setGroupExpanded = vi.fn()
    const openSession = vi.fn()
    const clearMain = vi.fn()
    const nativeCreateWorkspace = vi.fn(async (input: { path: string }) => {
      const found = workspacesSnapshot.items.find((item) => item.path === input.path)
      if (!found) throw new Error('not found')
      return found
    })

    const ctx = {
      sessions: { list: { getSnapshot: () => sessionsSnapshot }, refresh: vi.fn() },
      uiWorkspace: { openSession, clearMain },
      get: (name: string) => name === 'uiWorkspace' ? { openSession, clearMain } : undefined,
    }

    const NativeSidebar = (props: {
      useWorkspaces: (fn: (s: WorkspaceSnapshot) => WorkspaceSnapshot) => WorkspaceSnapshot
      useSessions: (fn: (s: SessionListState) => SessionListState) => SessionListState
      actions?: { retainAccountKeys?(keys: readonly string[]): void; setGroupExpanded?(key: string, expanded: boolean): void }
      createWorkspace?(input: { path: string }): Promise<WorkspaceView>
    }) => {
      const ws = props.useWorkspaces((s) => s)
      const ss = props.useSessions((s) => s)
      return (
        <div>
          <div data-row-key="workspace:ws-a" className="YDXeBa_projectRow YDXeBa_menuOpen">Alpha</div>
          <output data-testid="ws">{JSON.stringify(ws.items.map((item) => item.workspaceId))}</output>
          <output data-testid="sessions">{JSON.stringify(ss.ids)}</output>
          <button type="button" onClick={() => props.actions?.retainAccountKeys?.(['', ...ws.items.map((i) => i.workspaceId)])}>
            retain
          </button>
          <button type="button" onClick={() => { void props.createWorkspace?.({ path: '/work/alpha' }) }}>
            readd-alpha
          </button>
          <div role="menu" data-testid="ws-menu">
            <div className="wrap"><button type="button" role="menuitem"><span className="_itemIcon"><svg /></span><span className="_itemLabel">重命名</span></button></div>
            <div className="wrap"><button type="button" role="menuitem"><span className="_itemIcon"><svg /></span><span className="_itemLabel">删除工作区</span></button></div>
          </div>
          <div role="menu" data-testid="view-menu">
            <div className="_viewport">
              <div className="wrap"><button type="button" role="menuitem" className="_item _selected"><span className="_itemLabel">按工作区</span><span className="_check" /></button></div>
              <div role="separator" className="_sep" />
              <div className="wrap"><button type="button" role="menuitem" className="_item"><span className="_itemIcon"><svg /></span><span className="_itemLabel">隐藏已归档</span></button></div>
              <div className="wrap"><button type="button" role="menuitem" className="_item"><span className="_itemLabel">仅显示已归档</span></button></div>
            </div>
          </div>
        </div>
      )
    }

    const Wrapped = extendHiddenWorkspacesSidebar(
      NativeSidebar as never,
      activation as never,
      controller,
      groupsStore.scope,
      undefined,
      ctx as never,
    )

    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(createElement(Wrapped, {
      useWorkspaces: (fn: (s: WorkspaceSnapshot) => unknown) => fn(workspacesSnapshot),
      useSessions: (fn: (s: SessionListState) => unknown) => fn(sessionsSnapshot),
      actions: { retainAccountKeys, setGroupExpanded },
      createWorkspace: nativeCreateWorkspace,
    } as never)))

    return {
      hiddenStore,
      groupsStore,
      controller,
      retainAccountKeys,
      setGroupExpanded,
      openSession,
      clearMain,
      nativeCreateWorkspace,
      toggle: async (enabled: boolean) => {
        await act(async () => {
          settings = { ...settings, 'workspace-hide': enabled }
          activationListeners.forEach((fn) => fn())
        })
      },
    }
  }

  it('injects menu item beside rename/delete, hides workspace and its sessions, retains account keys, and restores on re-add or modal', async () => {
    const app = await mountSidebar()
    const wsMenu = document.querySelector('[data-testid="ws-menu"]')!
    const viewMenu = document.querySelector('[data-testid="view-menu"]')!

    const items = Array.from(wsMenu.querySelectorAll('button[role="menuitem"]')).map((el) => el.textContent?.trim())
    expect(items).toEqual(['重命名', '隐藏工作区', '删除工作区'])
    expect(viewMenu.textContent).not.toContain('已隐藏的工作区')

    vi.mocked(callPatchApi).mockResolvedValue({ workspaceId: 'ws-a', hidden: true })
    const hideBtn = Array.from(wsMenu.querySelectorAll('button[role="menuitem"]')).find((el) => el.textContent?.trim() === '隐藏工作区') as HTMLButtonElement
    await act(async () => { hideBtn.click() })

    expect(callPatchApi).toHaveBeenCalledWith('workspace-hide', 'hide', { workspaceId: 'ws-a' })
    expect(app.openSession).toHaveBeenCalledWith('s-b1')
    expect(document.querySelector('[data-testid="ws"]')?.textContent).toBe('["ws-b"]')
    expect(document.querySelector('[data-testid="sessions"]')?.textContent).toBe('["s-b1","s-archived","s-ungrouped"]')
    expect(viewMenu.textContent).toContain('已隐藏的工作区（1）…')

    // Browser view state pruning keeps hidden workspace keys
    await act(async () => {
      (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'retain') as HTMLButtonElement).click()
    })
    expect(app.retainAccountKeys).toHaveBeenCalledWith(['', 'ws-b', 'ws-a'])

    // Re-adding the directory via createWorkspace automatically unhides and expands
    vi.mocked(callPatchApi).mockResolvedValueOnce({ workspaceId: 'ws-a', hidden: false })
    await act(async () => {
      (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'readd-alpha') as HTMLButtonElement).click()
    })
    await act(async () => { app.hiddenStore.publish({ hidden: {} }) })
    expect(callPatchApi).toHaveBeenLastCalledWith('workspace-hide', 'unhide', { workspaceId: 'ws-a' })
    expect(app.setGroupExpanded).toHaveBeenCalledWith('ws-a', true)
    expect(document.querySelector('[data-testid="ws"]')?.textContent).toBe('["ws-a","ws-b"]')

    // Hide again via published settings, open manage modal from View options, and restore
    await act(async () => { app.hiddenStore.publish({ hidden: { 'ws-a': true } }) })
    expect(viewMenu.textContent).toContain('已隐藏的工作区（1）…')

    const manageBtn = Array.from(viewMenu.querySelectorAll('button[role="menuitem"]')).find((el) => el.textContent?.includes('已隐藏的工作区')) as HTMLButtonElement
    await act(async () => { manageBtn.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Alpha')
    expect(dialog.textContent).toContain('/work/alpha')
    expect(dialog.textContent).toContain('2 个会话')

    vi.mocked(callPatchApi).mockResolvedValueOnce({ workspaceId: 'ws-a', hidden: false })
    const restoreBtn = Array.from(dialog.querySelectorAll('button')).find((el) => el.textContent === '恢复显示') as HTMLButtonElement
    await act(async () => { restoreBtn.click() })
    await act(async () => { app.hiddenStore.publish({ hidden: {} }) })
    expect(callPatchApi).toHaveBeenLastCalledWith('workspace-hide', 'unhide', { workspaceId: 'ws-a' })
    expect(document.querySelector('[data-testid="ws"]')?.textContent).toBe('["ws-a","ws-b"]')

    // Toggling patch off removes injected menus and restores everything
    await act(async () => { app.hiddenStore.publish({ hidden: { 'ws-a': true } }) })
    expect(document.querySelector('[data-testid="ws"]')?.textContent).toBe('["ws-b"]')
    await app.toggle(false)
    expect(document.querySelector('[data-testid="ws"]')?.textContent).toBe('["ws-a","ws-b"]')
    expect(wsMenu.querySelector('[data-dshmore-workspace-hide-item]')).toBeNull()
    expect(wsMenu.textContent).not.toContain('隐藏工作区')
    expect(viewMenu.textContent).not.toContain('已隐藏的工作区')
  })

  it('reverts optimistic hide and selection when the hide API fails', async () => {
    const app = await mountSidebar()
    const wsMenu = document.querySelector('[data-testid="ws-menu"]')!
    vi.mocked(callPatchApi).mockRejectedValueOnce(new Error('写入失败'))
    const hideBtn = Array.from(wsMenu.querySelectorAll('button[role="menuitem"]')).find((el) => el.textContent?.trim() === '隐藏工作区') as HTMLButtonElement
    await act(async () => { hideBtn.click() })

    expect(app.openSession).toHaveBeenNthCalledWith(1, 's-b1')
    expect(app.openSession).toHaveBeenNthCalledWith(2, 's-a1')
    expect(document.querySelector('[data-testid="ws"]')?.textContent).toBe('["ws-a","ws-b"]')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('写入失败')
  })

  it('filters hidden workspaces in WorkspacePicker and skips hidden workspaces in startSession', async () => {
    const settings = { ...DEFAULT_PATCH_SETTINGS }
    const activation = {
      getSnapshot: () => settings,
      subscribe: () => () => {},
      getSettingsSnapshot: () => ({ status: 'ready' as const, writable: true, value: settings }),
      set: async () => {},
    }
    const hiddenStore = createScope<HiddenWorkspaces>({ hidden: { 'ws-a': true } })
    const controller = createHiddenWorkspaceController(hiddenStore.scope)

    const Picker = (props: { useWorkspaces: (fn: (s: WorkspaceSnapshot) => WorkspaceSnapshot) => WorkspaceSnapshot }) => {
      const snap = props.useWorkspaces((s) => s)
      return <output data-testid="picker">{JSON.stringify(snap.items.map((i) => i.workspaceId))}</output>
    }
    const WrappedPicker = extendHiddenWorkspacePicker(Picker as never, activation as never, controller)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(createElement(WrappedPicker, {
      useWorkspaces: (fn: (s: WorkspaceSnapshot) => unknown) => fn(workspacesSnapshot),
    } as never)))
    expect(document.querySelector('[data-testid="picker"]')?.textContent).toBe('["ws-b"]')

    const startSession = vi.fn()
    const clearMain = vi.fn()
    const unbind = bindHiddenNewSessionNavigation({
      navigation: { startSession, clearMain },
      sessions: { list: { getSnapshot: () => sessionsSnapshot, subscribe: () => () => {} } },
      workspaces: { list: { getSnapshot: () => workspacesSnapshot, subscribe: () => () => {} } },
      activation,
      hiddenController: controller,
    })

    // Current session s-a1 belongs to hidden ws-a -> route to recent visible ws-b instead
    startSession.mockClear()
    const nav = { startSession, clearMain }
    // Test via fresh binding over mutable navigation object
    unbind()
    const unbindNav = bindHiddenNewSessionNavigation({
      navigation: nav,
      sessions: { list: { getSnapshot: () => sessionsSnapshot, subscribe: () => () => {} } },
      workspaces: { list: { getSnapshot: () => workspacesSnapshot, subscribe: () => () => {} } },
      activation,
      hiddenController: controller,
    })
    nav.startSession()
    expect(startSession).toHaveBeenCalledWith('ws-b', undefined)

    // When all workspaces are hidden, clearMain is called instead of opening a hidden workspace
    await act(async () => { hiddenStore.publish({ hidden: { 'ws-a': true, 'ws-b': true } }) })
    startSession.mockClear()
    nav.startSession()
    expect(clearMain).toHaveBeenCalledOnce()
    expect(startSession).not.toHaveBeenCalled()
    unbindNav()
    controller.dispose()
  })
})
