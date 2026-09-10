// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostForRow } from '../../src/platform/dsh/client/message-targets.js'
import { installSessionDeleteMenuItems } from '../../src/patches/session-delete/client/index.js'
import { clientPatch as exportPatch } from '../../src/patches/conversation-markdown-export/client/index.js'
import { DEFAULT_PATCH_SETTINGS } from '../../src/generated/patch-catalog.js'
import { callPatchBlobApi } from '../../src/platform/dsh/client/api.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => createElement('button', props, children),
  Modal: ({ open, description }: { open: boolean; description: string }) => open ? createElement('div', { role: 'dialog' }, description) : null,
  IconWarningOutline16: () => null,
  IconDownloadOutline16: () => null,
  IconChevronDownOutline14: () => null,
  IconChevronUpOutline14: () => null,
}))
vi.mock('../../src/platform/dsh/client/api.js', () => ({
  callPatchBlobApi: vi.fn(),
  callPatchApi: vi.fn(),
  apiErrorText: (error: unknown) => String(error),
}))

let root: Root | undefined
const disposers: Array<() => void> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.body.innerHTML = ''
})
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  disposers.splice(0).forEach((dispose) => dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('DSH 0.1.2-rc.1 client DOM', () => {
  it('mounts assistant actions inside the new reveal row before its clock, including copied state', () => {
    document.body.innerHTML = '<div data-chat-flow-key="tail"><div data-turn-tail="1" data-actions-reveal="hover"><div><button aria-label="Copied"></button><button aria-label="Branch"></button><span>12:00</span></div></div></div>'
    const row = document.querySelector<HTMLElement>('[data-chat-flow-key]')!
    const host = hostForRow(row, 'assistant')
    expect(host.parentElement).toBe(row.querySelector('[data-turn-tail] > div'))
    expect(host.nextElementSibling?.textContent).toBe('12:00')
    expect(hostForRow(row, 'assistant')).toBe(host)
    expect(row.querySelectorAll('[data-dshmore-message-actions]')).toHaveLength(1)
  })

  it('reattaches user actions after native row replacement', () => {
    document.body.innerHTML = '<div data-chat-flow-key="user"><div><span>12:00</span><button aria-label="复制"></button></div></div>'
    const row = document.querySelector<HTMLElement>('[data-chat-flow-key]')!
    const host = hostForRow(row, 'user')
    expect(host.nextElementSibling?.getAttribute('aria-label')).toBe('复制')
    const next = document.createElement('div')
    next.innerHTML = '<button aria-label="已复制"></button>'
    row.replaceChildren(next, host)
    expect(hostForRow(row, 'user')).toBe(host)
    expect(host.parentElement).toBe(next)
  })

  it.each(['归档会话', 'Archive session'])('adds a distinct delete menu item beside %s and cleans up', (label) => {
    document.body.innerHTML = `<div role="menu"><div><button role="menuitem"><span>${label}</span></button></div></div>`
    const archive = document.querySelector<HTMLButtonElement>('button')!
    const callback = vi.fn()
    const archiveClick = vi.fn()
    archive.addEventListener('click', archiveClick)
    const dispose = installSessionDeleteMenuItems(callback)
    disposers.push(dispose)
    const deletion = document.querySelector<HTMLButtonElement>('[data-dshmore-session-delete] button')!
    expect(deletion).not.toBeNull()
    deletion.click()
    expect(callback).toHaveBeenCalledWith(archive)
    expect(archiveClick).not.toHaveBeenCalled()
    archive.click()
    expect(archiveClick).toHaveBeenCalledOnce()
    dispose()
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1)
    expect(archive.hasAttribute('data-dshmore-session-delete-source')).toBe(false)
  })

  it('exports the selected session as a downloadable Markdown blob', async () => {
    let component: ComponentType<Record<string, unknown>> | undefined
    const activation = {
      getSnapshot: () => DEFAULT_PATCH_SETTINGS,
      subscribe: () => () => {},
      getSettingsSnapshot: vi.fn(), set: vi.fn(),
    }
    exportPatch.install({ slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (_options: object, entry: ComponentType<Record<string, unknown>>) => { component = entry },
    } } as never, activation)
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.mocked(callPatchBlobApi).mockResolvedValue(new Blob(['# Full history']))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(createElement(component!, {
      sessionId: 'selected-session',
      useSessions: (select: (state: unknown) => unknown) => select({ byId: { 'selected-session': { displayTitle: 'Test title' } } }),
    })))
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    expect(callPatchBlobApi).toHaveBeenCalledWith('conversation-markdown-export', 'render', { sessionId: 'selected-session', title: 'Test title' })
    expect(createURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
  })
})
