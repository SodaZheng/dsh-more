// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarOwnerProps, ConversationSlotProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { clientSessionActions, installConversationAdapter, unlockComposer } from './client/adapter.js'
import { PROJECTLESS_TASKS_PATCH_ID as ID } from './shared.js'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(), apiErrorText: (error: unknown) => String(error) }))
let root: Root | undefined
const disposers: Array<() => void> = []
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks()
  document.body.innerHTML = ''
})

function activation() {
  let state = { ...DEFAULT_PATCH_SETTINGS }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    getSettingsSnapshot: vi.fn(), set: vi.fn(),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    toggle: async (enabled: boolean) => { await act(async () => {
      state = { ...state, [ID]: enabled }; listeners.forEach((listener) => listener())
    }) },
  }
}

describe('native composer compatibility', () => {
  const gated: ComposerBarOwnerProps = { variant: 'hero', disabled: true, onRequestWorkspace: () => {}, placeholder: 'Choose workspace', workspacePickerOpen: true }
  it('removes only the workspace gate and retains feature blocks', () => {
    expect(unlockComposer(gated, true, undefined)).toEqual({ variant: 'hero' })
    expect(unlockComposer(gated, true, { reason: 'Approval pending' })).toEqual({ variant: 'hero', blocked: { reason: 'Approval pending' }, placeholder: 'Approval pending' })
    expect(unlockComposer(gated, false, undefined)).toBe(gated)
    const locked: ComposerBarOwnerProps = { variant: 'hero', disabled: true }
    expect(unlockComposer(locked, true, undefined)).toBe(locked)
  })

  it('validates the Client/Host sessions boundary', () => {
    expect(() => clientSessionActions({ sessions: { create() {} } } as never)).toThrow('会话接口')
    const sessions = { create: vi.fn(), open: vi.fn() }
    expect(clientSessionActions({ sessions } as never)).toBe(sessions)
  })

  async function harness() {
    const slots = new SlotCore()
    const state = activation()
    const native = vi.fn((props: PropsRenderSlots<'conversation.composer.bar'>) => <>{props.renderSlot('conversation.composer.bar', gated)}</>)
    slots.register({ name: 'root', children: { conversation: { kind: 'single', scope: 'session-maybe' } } },
      (props: PropsRenderSlots<'conversation'>) => props.renderSlot('conversation', {}))
    slots.register({ name: 'conversation', children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } } }, native)
    const originalEntry = slots.entries('conversation')[0]!
    const dispose = installConversationAdapter({ slots } as never, state)
    disposers.push(dispose)
    const entry = slots.entriesOfSlot('conversation')[0]!
    expect(entry).toBe(originalEntry)
    expect(entry.children).toBe(originalEntry.children)
    let workspace = { phase: 'ready', items: [] as Array<{ sessionIds: string[] }> }
    let session = { openState: 'open' }
    let cwd: string | undefined = '/ordinary/non-git-folder'
    let block: { reason: string } | undefined
    const owners: ComposerBarOwnerProps[] = []
    const props = {
      sessionId: 'independent',
      useWorkspaces: (select: (value: typeof workspace) => unknown) => select(workspace),
      useSession: (select: (value: typeof session) => unknown) => select(session),
      useSessions: (select: (value: object) => unknown) => select({ byId: { independent: { cwd } } }),
      useComposerBlock: (select: (value: typeof block) => unknown) => select(block),
      renderSlot: (_name: string, owner: ComposerBarOwnerProps) => {
        owners.push(owner)
        return <textarea disabled={owner.disabled || owner.blocked !== undefined} aria-label="原生输入框" />
      },
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = async () => { await act(async () => root!.render(createElement(entry.component as ComponentType<ConversationSlotProps>, props as never))) }
    await render()
    return {
      state, slots, native, entry, dispose, owners, render,
      workspace: (value: typeof workspace) => { workspace = value },
      session: (value: typeof session) => { session = value },
      cwd: (value: typeof cwd) => { cwd = value },
      block: (value: typeof block) => { block = value },
    }
  }

  it('unlocks ordinary ungrouped sessions and restores on toggle without replacing the native component', async () => {
    const app = await harness()
    const input = document.querySelector('textarea')!
    expect(input.disabled).toBe(false)
    await app.state.toggle(false)
    expect(document.querySelector('textarea')).toBe(input)
    expect(input.disabled).toBe(true)
    await app.state.toggle(true)
    expect(input.disabled).toBe(false)
    await act(async () => app.dispose())
    expect(app.entry.component).toBe(app.native)
    expect(app.slots.entries('conversation')).toHaveLength(1)
    expect(input.disabled).toBe(true)
  })

  it('preserves project ownership, pending workspace loading, missing cwd, loading errors and business restrictions', async () => {
    const app = await harness()
    app.workspace({ phase: 'ready', items: [{ sessionIds: ['independent'] }] })
    await app.render(); expect(document.querySelector('textarea')!.disabled).toBe(true)
    app.workspace({ phase: 'pending', items: [] })
    await app.render(); expect(document.querySelector('textarea')!.disabled).toBe(true)
    app.workspace({ phase: 'ready', items: [] }); app.cwd(undefined)
    await app.render(); expect(document.querySelector('textarea')!.disabled).toBe(true)
    app.cwd('/ordinary/non-git-folder'); app.session({ openState: 'error' })
    await app.render(); expect(document.querySelector('textarea')!.disabled).toBe(true)
    app.session({ openState: 'open' }); app.block({ reason: 'Blocked' })
    await app.render(); expect(app.owners.at(-1)?.blocked?.reason).toBe('Blocked')
    expect(document.querySelector('textarea')!.disabled).toBe(true)
  })

  it('does not overwrite a later plugin replacement on cleanup', async () => {
    const app = await harness()
    const later = () => null
    app.entry.component = later
    await act(async () => app.dispose())
    expect(app.entry.component).toBe(later)
  })
})
