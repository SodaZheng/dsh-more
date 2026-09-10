// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  INDEPENDENT_CHOICE_ID, WorkspaceChoice, extendWorkspacePicker,
  installPickerAdapter, labelIndependentChip, withIndependentChoice,
} from './client/picker.js'
import { clientPatch } from './client/index.js'

let root: Root | undefined
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const project: WorkspaceView = { workspaceId: 'project' as WorkspaceView['workspaceId'], title: 'dsh-more', path: '/code/dsh-more', sessionIds: [], createdAt: '', updatedAt: '' }
function snapshot(items: WorkspaceView[] = [project]): WorkspaceSnapshot {
  return { items, archivedSessionIds: [], phase: 'ready', state: 'idle', error: null }
}

describe('native workspace picker', () => {
  it('declares the Conversation service before installing controls that move drafts', () => {
    const scopedSlots = { inject: vi.fn() }
    const scope = { slots: scopedSlots, effect: vi.fn() }
    const inject = vi.fn((dependencies: string[], install: (ctx: typeof scope) => void) => {
      expect(dependencies).toContain('conversation')
      expect(dependencies).toContain('uiWorkspace')
      install(scope)
    })
    clientPatch.install({ inject } as never, {} as never)
    expect(inject).toHaveBeenCalledOnce()
    expect(scope.effect).toHaveBeenCalledOnce()
    expect(scopedSlots.inject.mock.calls.map(([name]) => name)).toEqual(['conversation', 'conversation.hero.workspace'])
  })

  it('prepends a menu-local option without changing the Workspace snapshot', () => {
    const source = snapshot()
    const result = withIndependentChoice(source)
    expect(result.items.map((item) => item.title)).toEqual(['独立任务', 'dsh-more'])
    expect(source.items).toEqual([project])
    expect(result.items[1]).toBe(project)
    expect(withIndependentChoice(snapshot([])).items).toHaveLength(1)
  })

  it('updates the native chip label and restores it without replacing the button', () => {
    document.body.innerHTML = '<button aria-label="选择工作区"><span class="hash_workspaceLabel">选择工作区</span></button>'
    const anchor = document.querySelector('button')!
    const dispose = labelIndependentChip(anchor)
    expect(anchor.textContent).toBe('独立任务')
    expect(anchor.getAttribute('aria-label')).toBe('工作目录：独立任务')
    dispose()
    expect(document.querySelector('button')).toBe(anchor)
    expect(anchor.textContent).toBe('选择工作区')
    expect(anchor.getAttribute('aria-label')).toBe('选择工作区')
  })

  async function mount(independent = false, empty = false) {
    document.body.innerHTML = '<button id="anchor" aria-label="选择工作区"><span class="hash_workspaceLabel">dsh-more</span></button>'
    const onPick = vi.fn()
    const onClose = vi.fn()
    const chooseIndependent = vi.fn()
    const addWorkspace = vi.fn()
    const owner = { open: true, selectedId: independent || empty ? undefined : project.workspaceId, onPick, onClose,
      anchorRef: { current: document.getElementById('anchor')! } }
    const data = snapshot(empty ? [] : [project])
    const native: ComponentType<PropsRuntime<'conversation.hero.workspace'>> = (props) => {
      const list = props.useWorkspaces((value) => value)
      return <div role="menu" hidden={!props.open}>
        {list.items.map((item) => <button type="button" role="menuitemradio" key={item.workspaceId}
          aria-checked={item.workspaceId === props.selectedId} onClick={() => props.onPick(item.workspaceId)}>{item.title}</button>)}
        <button type="button" role="menuitem" onClick={addWorkspace}>添加工作区…</button>
      </div>
    }
    const Picker = extendWorkspacePicker(native)
    const props = { ...owner, useWorkspaces: (select: (value: WorkspaceSnapshot) => unknown) => select(data) }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = async (enabled = true, busy = false) => { await act(async () => {
      const picker = createElement(Picker, props as never)
      root!.render(enabled ? <WorkspaceChoice owner={owner} state={{ independent, busy, chooseIndependent }} error={undefined}>{picker}</WorkspaceChoice> : picker)
    }) }
    await render()
    return { onPick, onClose, chooseIndependent, addWorkspace, render }
  }

  it('selects independent tasks without sending the synthetic choice to native workspace navigation', async () => {
    const app = await mount()
    const options = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    expect([...options].map((item) => item.textContent)).toEqual(['独立任务', 'dsh-more'])
    await act(async () => options[0]!.click())
    expect(app.chooseIndependent).toHaveBeenCalledOnce()
    expect(app.onClose).toHaveBeenCalledOnce()
    expect(app.onPick).not.toHaveBeenCalled()
    await act(async () => options[1]!.click())
    expect(app.onPick).toHaveBeenCalledExactlyOnceWith(project.workspaceId)
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
    expect(app.addWorkspace).toHaveBeenCalledOnce()
  })

  it('clears a selected directory with x, and restores the original picker on disable', async () => {
    const app = await mount()
    const clear = document.querySelector<HTMLButtonElement>('button[aria-label="清除目录，切换为独立任务"]')!
    expect(clear.textContent).toBe('×')
    await act(async () => clear.click())
    expect(app.chooseIndependent).toHaveBeenCalledOnce()
    expect(app.onClose).toHaveBeenCalledOnce()
    expect(app.onPick).not.toHaveBeenCalled()
    await app.render(false)
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1)
    expect(document.querySelector('.dshmore-workspace-clear')).toBeNull()
    await app.render(true, true)
    expect(document.querySelector<HTMLButtonElement>('.dshmore-workspace-clear')!.disabled).toBe(true)
    expect(document.querySelector<HTMLElement>('[role="menu"]')!.hidden).toBe(true)
  })

  it('shows the checked independent option and label even when there are no projects', async () => {
    await mount(true, true)
    expect(document.getElementById('anchor')!.textContent).toBe('独立任务')
    expect(document.querySelector('[role="menuitemradio"]')!.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.dshmore-workspace-clear')).toBeNull()
    expect(document.querySelectorAll('button[aria-label="新建独立任务"]')).toHaveLength(0)
  })

  it('restores the picker registration on cleanup, preserving later plugin replacements', () => {
    const original = () => null
    const entry: StoredEntry = { component: original, options: {}, children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } } }
    const unsubscribe = vi.fn()
    const removeFallback = vi.fn()
    const slots = { entries: () => [entry], subscribe: () => unsubscribe, register: () => removeFallback }
    const dispose = installPickerAdapter({ slots } as never)
    expect(entry.component).not.toBe(original)
    dispose()
    expect(entry.component).toBe(original)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(removeFallback).toHaveBeenCalledOnce()
    const again = installPickerAdapter({ slots } as never)
    const later = () => null
    entry.component = later
    again()
    expect(entry.component).toBe(later)
    expect(INDEPENDENT_CHOICE_ID).not.toBe(project.workspaceId)
  })
})
