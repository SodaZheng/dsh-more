// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'
import { extendGroupedSidebar, projectSessionGroups } from './client/groups.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'> & { variant: string }) => { const { variant: _, ...rest } = props; return <button {...rest} /> },
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <div role="dialog">{children}{footer}</div> : null,
}))
vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(), apiErrorText: (error: unknown) => String(error) }))
let root: Root | undefined
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.resetAllMocks(); vi.unstubAllGlobals() })

const native = { phase: 'ready', items: [
  { workspaceId: 'a', title: '项目 A', path: '/a', sessionIds: ['native'], createdAt: '', updatedAt: '' },
  { workspaceId: 'b', title: '项目 B', path: '/b', sessionIds: [], createdAt: '', updatedAt: '' },
], archivedSessionIds: [], state: 'idle', error: null } as unknown as WorkspaceSnapshot
const sessions = { phase: 'ready', current: 'source', ids: ['native', 'source', 'child'], byId: {
  native: { id: 'native', cwd: '/a' }, source: { id: 'source', cwd: '/task', displayTitle: '原会话' }, child: { id: 'child', origin: 'subagent' },
} } as unknown as SessionListState

describe('session grouping sidebar', () => {
  it('projects only live ungrouped roots, preserving native ownership, identity and cwd', () => {
    const groups = { assignments: { source: 'b', native: 'b', missing: 'b', child: 'b' } }
    const result = projectSessionGroups(native, sessions, groups)
    expect(result.items[0]).toBe(native.items[0])
    expect(result.items[1]?.sessionIds).toEqual(['source'])
    expect(native.items[1]?.sessionIds).toEqual([])
    expect(sessions.current).toBe('source')
    expect(Object.values(sessions.byId).find((item) => item.id === 'source')?.cwd).toBe('/task')
    expect(projectSessionGroups(native, sessions, { assignments: { source: 'deleted-project' } })).toBe(native)
  })

  async function harness() {
    let settings = { ...DEFAULT_PATCH_SETTINGS }
    const listeners = new Set<() => void>()
    const activation = { getSnapshot: () => settings, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
    let saved = { status: 'ready', writable: true, value: { assignments: {} as Record<string, string> } }
    const sourceListeners = new Set<() => void>()
    const source = { getSnapshot: () => saved, subscribe: (fn: () => void) => { sourceListeners.add(fn); return () => { sourceListeners.delete(fn) } } }
    const archive = vi.fn(async () => {})
    const Native = (props: { useWorkspaces: (fn: (data: WorkspaceSnapshot) => WorkspaceSnapshot) => WorkspaceSnapshot; archiveSession: (id: string) => void }) => {
      const list = props.useWorkspaces((data) => data)
      return <div><div className="native_sessionRow native_menuOpen" /><input aria-label="现有输入" defaultValue="保留草稿" /><output>{JSON.stringify(list.items.map((item) => item.sessionIds))}</output>
        <div role="menu"><div><button role="menuitem" onClick={() => props.archiveSession('source')}>归档会话</button></div></div></div>
    }
    const Grouped = extendGroupedSidebar(Native as never, activation as never, source as never)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(createElement(Grouped, { useWorkspaces: (fn: (data: WorkspaceSnapshot) => unknown) => fn(native),
      useSessions: (fn: (data: SessionListState) => unknown) => fn(sessions), archiveSession: archive } as never)))
    return { archive,
      toggle: async (enabled: boolean) => { await act(async () => { settings = { ...settings, 'projectless-tasks': enabled }; listeners.forEach((fn) => fn()) }) },
      publish: async (assignments: Record<string, string>) => { await act(async () => { saved = { ...saved, value: { assignments } }; sourceListeners.forEach((fn) => fn()) }) },
    }
  }
  const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)!
  async function openMove() { await act(async () => button('移动到工作区…').click()) }
  async function choose(id: string) { await act(async () => { const select = document.querySelector('select')!; select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })) }) }

  it('gets the exact native menu session without archiving, cancels safely and follows persisted updates without navigation', async () => {
    const app = await harness()
    const input = document.querySelector('input')
    await openMove()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原会话')
    await act(async () => button('取消').click())
    expect(callPatchApi).not.toHaveBeenCalled()
    expect(app.archive).not.toHaveBeenCalled()
    await openMove(); await choose('b')
    await act(async () => button('移动').click())
    expect(callPatchApi).toHaveBeenCalledExactlyOnceWith('projectless-tasks', 'move', { sessionId: 'source', workspaceId: 'b' })
    await app.publish({ source: 'b' })
    expect(document.querySelector('output')?.textContent).toBe('[["native"],["source"]]')
    expect(document.querySelector('input')).toBe(input)
    expect(input?.value).toBe('保留草稿')
    await app.toggle(false)
    expect(button('移动到工作区…')).toBeUndefined()
    expect(document.querySelector('output')?.textContent).toBe('[["native"],[]]')
    await act(async () => button('归档会话').click())
    expect(app.archive).toHaveBeenCalledExactlyOnceWith('source')
    await app.toggle(true)
    expect(document.querySelector('output')?.textContent).toBe('[["native"],["source"]]')
  })

  it('keeps failed moves reviewable and allows returning manual groups to Ungrouped', async () => {
    const app = await harness()
    await app.publish({ source: 'b' })
    await openMove(); await choose('')
    vi.mocked(callPatchApi).mockRejectedValueOnce(new Error('保存失败'))
    await act(async () => button('移动').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
    expect(document.querySelector('output')?.textContent).toBe('[["native"],["source"]]')
    await act(async () => button('移动').click())
    expect(callPatchApi).toHaveBeenLastCalledWith('projectless-tasks', 'move', { sessionId: 'source', workspaceId: null })
    expect(app.archive).not.toHaveBeenCalled()
  })
})
