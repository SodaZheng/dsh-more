// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { callPatchBlobApi } from '../../platform/dsh/client/api.js'
import { clientPatch } from './client/index.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => createElement('button', props, children),
  Modal: ({ open, description }: { open: boolean; description: string }) => open ? createElement('div', { role: 'dialog' }, description) : null,
  IconDownloadOutline16: () => null,
}))
vi.mock('../../platform/dsh/client/api.js', () => ({
  callPatchBlobApi: vi.fn(),
  apiErrorText: (error: unknown) => String(error),
}))

let root: Root
let component: ComponentType<Record<string, unknown>>
let settings = { ...DEFAULT_PATCH_SETTINGS }
const listeners = new Set<() => void>()
const activation = {
  getSnapshot: () => settings,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSettingsSnapshot: vi.fn(), set: vi.fn(),
}
const fallback = (): HTMLButtonElement => document.querySelector('.dshmore-markdown-export-button')!
const menuItem = (): HTMLButtonElement | null => document.querySelector('[data-dshmore-markdown-export] button')
const render = async (sessionId = 'selected-session'): Promise<void> => {
  await act(async () => root.render(createElement(component, {
    sessionId,
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { [sessionId]: { displayTitle: 'Test title' } } }),
  })))
}
const flushMenu = async (): Promise<void> => {
  await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))) })
}

function nativeMore(label = '下载 Session 日志', header = document.querySelector('header')!): {
  trigger: HTMLButtonElement; logClick: ReturnType<typeof vi.fn>; open: () => void
} {
  const wrapper = header.appendChild(document.createElement('span'))
  const trigger = wrapper.appendChild(document.createElement('button'))
  trigger.className = 'nL4_yW_moreButton'
  trigger.setAttribute('aria-label', label === '下载 Session 日志' ? '更多操作' : 'More actions')
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  const logClick = vi.fn()
  const open = (): void => {
    trigger.setAttribute('aria-expanded', 'true')
    const menu = wrapper.appendChild(document.createElement('div'))
    menu.setAttribute('role', 'menu')
    menu.innerHTML = `<div role="presentation"><div class="native-item-wrap"><button role="menuitem" class="native-item"><span class="native-icon"><svg></svg></span><span class="native-label">${label}</span></button></div></div>`
    menu.querySelector('button')!.addEventListener('click', logClick)
  }
  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') {
      trigger.setAttribute('aria-expanded', 'false')
      wrapper.querySelector('[role="menu"]')?.remove()
    } else open()
  })
  return { trigger, logClick, open }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  settings = { ...DEFAULT_PATCH_SETTINGS }
  document.body.innerHTML = '<header><div id="export-slot"></div></header>'
  root = createRoot(document.querySelector('#export-slot')!)
  clientPatch.install({ slots: {
    inject: (_name: string, register: () => void) => register(),
    register: (_options: object, entry: ComponentType<Record<string, unknown>>) => { component = entry },
  } } as never, activation)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.mocked(callPatchBlobApi).mockReset().mockResolvedValue(new Blob(['# Full history']))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Markdown export in the native Session more menu', () => {
  it.each(['下载 Session 日志', 'Download session log'])('adds export below %s and closes only the menu on export', async (label) => {
    const native = nativeMore(label)
    await render()
    expect(fallback().hidden).toBe(true)
    expect(menuItem()).toBeNull()
    native.open()
    await flushMenu()
    const rows = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect(Array.from(rows, (row) => row.textContent)).toEqual([label, '导出 Markdown'])
    expect(menuItem()?.className).toBe('native-item')
    expect(menuItem()?.querySelector('svg')).not.toBeNull()
    rows[0]!.click()
    expect(native.logClick).toHaveBeenCalledOnce()
    await act(async () => menuItem()!.click())
    expect(native.logClick).toHaveBeenCalledOnce()
    expect(native.trigger.getAttribute('aria-expanded')).toBe('false')
    expect(callPatchBlobApi).toHaveBeenCalledWith('conversation-markdown-export', 'render', { sessionId: 'selected-session', title: 'Test title' })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
    native.open()
    await flushMenu()
    expect(document.querySelectorAll('[data-dshmore-markdown-export]')).toHaveLength(1)
  })

  it('keeps the toolbar fallback on older DSH and ignores another Session header', async () => {
    const otherHeader = document.body.appendChild(document.createElement('header'))
    nativeMore('下载 Session 日志', otherHeader).open()
    await render()
    expect(fallback().hidden).toBe(false)
    expect(menuItem()).toBeNull()
    await act(async () => fallback().click())
    expect(callPatchBlobApi).toHaveBeenCalledOnce()
  })

  it('tracks a late native menu, removes its row on disable, and restores the fallback on native unload', async () => {
    await render()
    const native = nativeMore()
    native.open()
    await flushMenu()
    expect(fallback().hidden).toBe(true)
    await act(async () => {
      settings = { ...settings, 'conversation-markdown-export': false }
      listeners.forEach((listener) => listener())
    })
    expect(menuItem()).toBeNull()
    expect(document.querySelector('.dshmore-markdown-export-button')).toBeNull()
    await act(async () => {
      settings = { ...settings, 'conversation-markdown-export': true }
      listeners.forEach((listener) => listener())
    })
    expect(menuItem()).not.toBeNull()
    native.trigger.parentElement!.remove()
    await flushMenu()
    expect(fallback().hidden).toBe(false)
    expect(menuItem()).toBeNull()
  })

  it('keeps the error dialog after closing the menu and offers export again', async () => {
    const native = nativeMore()
    native.open()
    vi.mocked(callPatchBlobApi).mockRejectedValue(new Error('下载失败'))
    await render()
    await act(async () => menuItem()!.click())
    expect(native.trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('下载失败')
    native.open()
    await flushMenu()
    expect(menuItem()?.disabled).toBe(false)
  })

  it('does not duplicate a pending export, and ignores its result after switching Sessions', async () => {
    let resolve!: (blob: Blob) => void
    vi.mocked(callPatchBlobApi).mockReturnValue(new Promise((done) => { resolve = done }))
    const native = nativeMore()
    native.open()
    await render()
    await act(async () => {
      const button = menuItem()!
      button.click()
      button.click()
    })
    expect(callPatchBlobApi).toHaveBeenCalledOnce()
    native.open()
    await flushMenu()
    expect(menuItem()?.disabled).toBe(true)
    await render('next-session')
    await act(async () => resolve(new Blob(['# Previous Session'])))
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(menuItem()?.disabled).toBe(false)
    vi.mocked(callPatchBlobApi).mockResolvedValue(new Blob(['# Next Session']))
    await act(async () => menuItem()!.click())
    expect(callPatchBlobApi).toHaveBeenLastCalledWith('conversation-markdown-export', 'render', { sessionId: 'next-session', title: 'Test title' })
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })
})
