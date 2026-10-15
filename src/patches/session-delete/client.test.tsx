// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { clientPatch } from './client/index.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(), apiErrorText: (error: Error) => error.message }))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconWarningOutlineRegular: () => null,
  MenuItemButton: ({ children, onSelect }: { children: ReactNode; onSelect(): void }) => <button role="menuitem" onClick={onSelect}>{children}</button>,
  Button: ({ children, onClick }: { children: ReactNode; onClick(): void }) => <button onClick={onClick}>{children}</button>,
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <div role="dialog">{children}{footer}</div> : null,
}))

it('opens deletion for the clicked 0.1.7 menu Session without invoking native archive', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const components = new Map<string, ComponentType<Record<string, unknown>>>()
  const archiveSession = vi.fn()
  const ctx = {
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      spec: () => ({ kind: 'list' }),
      register: (options: { name: string }, component: ComponentType<Record<string, unknown>>) => {
        components.set(options.name, component)
        return () => { components.delete(options.name) }
      },
    },
    sessions: { list: { getSnapshot: () => ({ current: 'current', byId: { other: { displayTitle: '非当前测试会话' } } }) } },
    workspaces: { archiveSession },
  }
  const settings = { ...DEFAULT_PATCH_SETTINGS }
  clientPatch.install(ctx as never, { getSnapshot: () => settings, subscribe: () => () => {} } as never)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const setOpen = vi.fn()
  try {
    const Overlay = components.get('shell.overlay')!
    await act(async () => root.render(<Overlay />))
    const Menu = components.get('sidebar.workspaces.session.menu.item')!
    expect(Menu).toBeDefined()
    await act(async () => root.render(<><Overlay />{createElement(Menu, { sessionId: 'other', useMenuOpenState: () => [true, setOpen] })}</>))
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('非当前测试会话')
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(archiveSession).not.toHaveBeenCalled()
    expect(ctx.workspaces.archiveSession).toBe(archiveSession)
  } finally {
    await act(async () => root.unmount())
    expect(components.has('sidebar.workspaces.session.menu.item')).toBe(false)
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})

it('restores the current Session if permanent deletion is rejected after selecting a neighbor', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(callPatchApi).mockRejectedValueOnce(new Error('writer still owned'))
  const components = new Map<string, ComponentType<Record<string, unknown>>>()
  let current = 'source'
  const openSession = vi.fn((id: string) => { current = id })
  const ctx = {
    get: () => ({ openSession }),
    slots: {
      inject: (_name: string, callback: () => void) => callback(), spec: () => ({ kind: 'list' }),
      register: (options: { name: string }, entry: ComponentType<Record<string, unknown>>) => {
        components.set(options.name, entry)
        return () => { components.delete(options.name) }
      },
    },
    sessions: { list: { getSnapshot: () => ({ ids: ['source', 'neighbor'], byId: Object.fromEntries(
      ['source', 'neighbor'].map((id) => [id, { id, displayTitle: id, retainedBy: { mainView: current === id ? 1 : 0 } }]),
    ) }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } },
  }
  clientPatch.install(ctx as never, { getSnapshot: () => DEFAULT_PATCH_SETTINGS, subscribe: () => () => {} } as never)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    const Overlay = components.get('shell.overlay')!
    await act(async () => root.render(<Overlay />))
    const Menu = components.get('sidebar.workspaces.session.menu.item')!
    await act(async () => root.render(<><Overlay />{createElement(Menu, { sessionId: 'source', useMenuOpenState: () => [true, () => {}] })}</>))
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === '永久删除')!.click())
    expect(openSession.mock.calls).toEqual([['neighbor'], ['source']])
    expect(current).toBe('source')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('writer still owned')
  } finally {
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.mocked(callPatchApi).mockReset()
  }
})
