// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { installSessionMenuAction } from '../../src/platform/dsh/client/session-menu.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MenuItemButton: ({ children, onSelect }: { children: ReactNode; onSelect(): void }) =>
    <button role="menuitem" onClick={onSelect}>{children}</button>,
}))
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('uses the exact menu Session id without invoking or wrapping the native archive action', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let component: ComponentType<Record<string, unknown>> | undefined
  const unregister = vi.fn()
  const archiveSession = vi.fn()
  const ctx = { slots: {
    spec: (name: string) => name === 'sidebar.workspaces.session.menu.item' ? { kind: 'list' } : undefined,
    register: vi.fn((_options: object, entry: ComponentType<Record<string, unknown>>) => { component = entry; return unregister }),
  }, workspaces: { archiveSession } }
  const select = vi.fn()
  const dispose = installSessionMenuAction(ctx as never, {
    id: 'dsh-more-test', label: '测试动作', order: 350, select,
  })
  const setOpen = vi.fn()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<>
      {createElement(component!, { sessionId: 'current', useMenuOpenState: () => [true, setOpen] })}
      {createElement(component!, { sessionId: 'other', useMenuOpenState: () => [true, setOpen] })}
    </>))
    await act(async () => document.querySelectorAll<HTMLButtonElement>('button')[1]!.click())
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(select).toHaveBeenCalledExactlyOnceWith('other')
    expect(archiveSession).not.toHaveBeenCalled()
    expect(ctx.workspaces.archiveSession).toBe(archiveSession)
    dispose?.()
    expect(unregister).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()) }
})

it('leaves older hosts on the legacy adapter', async () => {
  const register = vi.fn()
  expect(installSessionMenuAction({ slots: { register } } as never, {
    id: 'test', label: 'Test', order: 1, select: vi.fn(),
  })).toBeUndefined()
  expect(register).not.toHaveBeenCalled()
})
