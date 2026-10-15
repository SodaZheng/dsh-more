// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSlotProps, ComposerBarOwnerProps, EmptyWorkspaceOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { installConversationFactoryAdapter } from './client/adapter.js'
import { extendWorkspacePicker } from './client/picker.js'
import { PROJECTLESS_TASKS_PATCH_ID as ID } from './shared.js'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(), apiErrorText: (error: unknown) => String(error) }))
let root: Root | undefined
const disposers: Array<() => void> = []
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  document.body.innerHTML = ''
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function activation() {
  let state = { ...DEFAULT_PATCH_SETTINGS, [ID]: true }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state, getSettingsSnapshot: vi.fn(), set: vi.fn(),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    toggle: async (enabled: boolean) => { await act(async () => {
      state = { ...state, [ID]: enabled }; listeners.forEach((listener) => listener())
    }) },
  }
}
function definition(component: ComponentType<ConversationSlotProps> = () => null) {
  return {
    name: 'conversation.content', scope: 'session-maybe', component,
    children: {
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
    },
    slots: { views: { scope: 'session' }, widthControls: { scope: 'root' } },
    store: {}, inject: vi.fn(), locale: 'native-conversation', registrant: 'native',
  }
}
function registry(initial?: ReturnType<typeof definition>) {
  let current = initial
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  const host = {
    factoryOf: vi.fn((name: string) => name === 'conversation.content' ? current : undefined),
    subscribeFactory: vi.fn((name: string, listener: () => void) => {
      expect(name).toBe('conversation.content')
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    }),
  }
  return {
    // Match the real Cordis SlotRegistry, which has no factory/subscribeFactory
    // methods of its own (those live on SlotCore and the renderer host face).
    slots: { hostFace: vi.fn(() => host) },
    host,
    unsubscribe,
    publish: (next?: ReturnType<typeof definition>) => { current = next; listeners.forEach((listener) => listener()) },
  }
}

describe('desktop conversation.content factory compatibility', () => {
  it.each([{}, { hostFace: () => ({}) }])('is a no-op on older hosts without factory APIs (%j)', (slots) => {
    const dispose = installConversationFactoryAdapter({ slots } as never, activation())
    expect(dispose).toBeTypeOf('function')
    expect(() => dispose()).not.toThrow()
  })

  it('wraps late registrations and replacement definitions without replacing their identity or metadata', () => {
    const app = registry()
    const dispose = installConversationFactoryAdapter({ slots: app.slots } as never, activation())
    disposers.push(dispose)
    const first = definition()
    const original = first.component
    const metadata = { ...first }
    app.publish(first)
    expect(app.host.factoryOf('conversation.content')).toBe(first)
    expect(app.slots.hostFace).toHaveBeenCalledOnce()
    expect('factory' in app.slots).toBe(false)
    expect(first.component).not.toBe(original)
    for (const key of ['children', 'slots', 'store', 'inject', 'locale', 'registrant', 'scope'] as const) expect(first[key]).toBe(metadata[key])
    const wrapped = first.component
    app.publish(first)
    expect(first.component).toBe(wrapped)
    app.publish(undefined)
    const next = definition()
    const nextOriginal = next.component
    app.publish(next)
    expect(next.component).not.toBe(nextOriginal)
    dispose()
    expect(next.component).toBe(nextOriginal)
    expect(app.unsubscribe).toHaveBeenCalled()
    const after = definition()
    const afterOriginal = after.component
    app.publish(after)
    expect(after.component).toBe(afterOriginal)
  })

  it('does not overwrite a later plugin component on teardown', () => {
    const entry = definition()
    const app = registry(entry)
    const dispose = installConversationFactoryAdapter({ slots: app.slots } as never, activation())
    disposers.push(dispose)
    const later = () => null
    entry.component = later
    dispose()
    expect(entry.component).toBe(later)
  })

  it.each(['hero', 'composer'] as const)('unlocks the %s factory composer and supplies picker context while preserving native props and blocks', async (variant) => {
    const state = activation()
    const workspace: WorkspaceSnapshot = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [] }
    const useWorkspaces = (select: (value: WorkspaceSnapshot) => unknown) => select(workspace)
    const Picker = extendWorkspacePicker((props: PropsRuntime<'conversation.hero.workspace'>) => {
      const data = props.useWorkspaces((value) => value)
      return <div role="menu">{data.items.map((item) => <span key={item.workspaceId}>{item.title}</span>)}</div>
    })
    const gated: ComposerBarOwnerProps = { variant, disabled: true, onRequestWorkspace: vi.fn(), placeholder: 'Choose workspace' }
    const owner: EmptyWorkspaceOwnerProps = { open: true, onPick: vi.fn(), onClose: vi.fn() }
    const native = vi.fn((props: ConversationSlotProps) => <>
      {props.renderSlot('conversation.composer.bar', gated)}
      {props.renderSlot('conversation.hero.workspace', owner)}
    </>)
    const entry = definition(native)
    const app = registry(entry)
    const dispose = installConversationFactoryAdapter({ slots: app.slots } as never, state)
    disposers.push(dispose)
    let block: { reason: string } | undefined
    const selectWorkspace = vi.fn()
    const useFactorySlot = vi.fn()
    const props = {
      sessionId: 'independent', variant: 'main', phase: 'hero', hero: true,
      selectWorkspace, useFactorySlot, useWorkspaces,
      useSession: (select: (value: object) => unknown) => select({ openState: 'open' }),
      useSessions: (select: (value: object) => unknown) => select({ byId: { independent: { cwd: '/tmp/task' } } }),
      useComposerBlock: (select: (value: typeof block) => unknown) => select(block),
      renderSlot: (name: string, value: ComposerBarOwnerProps | EmptyWorkspaceOwnerProps) => {
        if (name === 'conversation.hero.workspace') return createElement(Picker, { ...value, useWorkspaces } as never)
        const composer = value as ComposerBarOwnerProps
        return <textarea disabled={composer.disabled || composer.blocked !== undefined} placeholder={composer.placeholder} />
      },
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = async () => { await act(async () => root!.render(createElement(entry.component, props as never))) }
    await render()
    const input = document.querySelector('textarea')!
    expect(input.disabled).toBe(false)
    expect(document.querySelector('[role="menu"]')!.textContent).toBe('独立任务')
    expect(native.mock.calls.at(-1)?.[0]).toMatchObject({ selectWorkspace, useFactorySlot, variant: 'main', phase: 'hero', hero: true })
    block = { reason: 'Approval pending' }
    await render()
    expect(input.disabled).toBe(true)
    expect(input.placeholder).toBe('Approval pending')
    block = undefined
    await render()
    await state.toggle(false)
    expect(document.querySelector('textarea')).toBe(input)
    expect(input.disabled).toBe(true)
    expect(document.querySelector('[role="menu"]')!.textContent).toBe('')
    await state.toggle(true)
    expect(input.disabled).toBe(false)
    await act(async () => dispose())
    expect(entry.component).toBe(native)
    expect(input.disabled).toBe(true)
    expect(document.querySelector('[role="menu"]')!.textContent).toBe('')
  })
})
