// @vitest-environment happy-dom
import { act, createElement, memo, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SlotCore, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBarProps, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'
import { NEXT_STEP_SUGGESTION_PATCH_ID as ID } from './shared.js'
import { installComposerAdapter } from './client/index.js'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn() }))
let root: Root | undefined
const disposers: Array<() => void> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.mocked(callPatchApi).mockReset().mockResolvedValue({ suggestion: '帮我补充输入框的交互测试' })
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  vi.useRealTimers(); vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function harness() {
  let settings = { ...DEFAULT_PATCH_SETTINGS }
  const listeners = new Set<() => void>()
  const activation = {
    getSnapshot: () => settings, getSettingsSnapshot: vi.fn(), set: vi.fn(),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const slots = new SlotCore()
  slots.register({ name: 'root', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } },
    (props: PropsRenderSlots<'main.conversation'>) => props.renderSlot('main.conversation', {}))
  slots.register({ name: 'main.conversation', children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } } },
    (props: PropsRenderSlots<'conversation.composer.bar'>) => props.renderSlot('conversation.composer.bar', { variant: 'composer' }))
  const native = memo((props: Pick<ComposerBarProps, 'placeholder' | 'disabled' | 'blocked'> & PropsRenderSlots<'conversation.input.overlay'>) => <>
    <textarea placeholder={props.placeholder ?? '发送消息'} disabled={props.disabled || props.blocked !== undefined} />
    <button>模型</button>
  </>)
  slots.register({ name: 'conversation.composer.bar', children: { 'conversation.input.overlay': { kind: 'list', scope: 'session' } } }, native)
  const entry = slots.entries('conversation.composer.bar')[0]!
  const children = entry.children
  const dispose = installComposerAdapter({ slots } as never, activation)
  disposers.push(dispose)
  let input = { phase: 'plain', draft: '', attachmentIds: [], queue: [], draftRev: 0, occurrences: [] } as InputState
  let session = { openState: 'open', running: false, blank: false, removed: false, subagent: null, pendingSubmissions: [] } as unknown as SessionSnapshot
  let menu: string | null = null
  const insert = vi.fn((text: string) => {
    document.querySelector('textarea')!.value = text
    input = { ...input, draft: text }
    return true
  })
  const props = {
    sessionId: 'a', variant: 'composer',
    useInput: (select: (state: InputState) => unknown) => select(input),
    useSession: (select: (state: SessionSnapshot) => unknown) => select(session),
    useMenuLauncher: (select: (state: string | null) => unknown) => select(menu),
    inputActions: { captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: input.draftRev })), insertText: insert, persistDraft: vi.fn(), submit: vi.fn() },
  }
  root = createRoot(document.body.appendChild(document.createElement('div')))
  const Component = entry.component as ComponentType<ComposerBarProps>
  const render = async (extra = {}) => { await act(async () => root!.render(createElement(Component, { ...props, ...extra } as never))) }
  const advance = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(500) }) }
  const key = async (key: string, options: KeyboardEventInit = {}, target: HTMLElement = document.querySelector('textarea')!) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    await act(async () => { target.dispatchEvent(event) })
    return event
  }
  await render()
  return {
    props, render, advance, key, insert, slots, native, entry, children, dispose,
    input: (next: Partial<InputState>) => { input = { ...input, ...next } },
    session: (next: Partial<SessionSnapshot>) => { session = { ...session, ...next } },
    menu: (next: string | null) => { menu = next },
    toggle: async (enabled: boolean) => { await act(async () => {
      settings = { ...settings, [ID]: enabled }; listeners.forEach((listener) => listener())
    }) },
  }
}

describe('next-step composer', () => {
  it('keeps the memoized native editor and registration; Tab inserts once and never sends', async () => {
    const app = await harness()
    const input = document.querySelector('textarea')!
    await app.advance()
    expect(input.placeholder).toBe('帮我补充输入框的交互测试')
    expect(input.value).toBe('')
    expect((await app.key('Enter')).defaultPrevented).toBe(false)
    expect(app.insert).not.toHaveBeenCalled()
    expect((await app.key('Tab')).defaultPrevented).toBe(true)
    expect(input.value).toBe('帮我补充输入框的交互测试')
    expect(document.querySelector('textarea')).toBe(input)
    expect(app.props.inputActions.persistDraft).toHaveBeenCalledOnce()
    expect(app.props.inputActions.submit).not.toHaveBeenCalled()
    expect((await app.key('Tab')).defaultPrevented).toBe(false)
    expect(app.entry.children).toBe(app.children)
    await act(async () => app.dispose())
    expect(app.entry.component).toBe(app.native)
    expect(app.slots.entries('conversation.composer.bar')).toHaveLength(1)
  })
  it('preserves navigation, modifier keys, toolbar Tab, and IME composition', async () => {
    const app = await harness(); await app.advance()
    for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect((await app.key('Tab', options)).defaultPrevented).toBe(false)
    }
    expect((await app.key('Tab', {}, document.querySelector('button')!)).defaultPrevented).toBe(false)
    await act(async () => { document.querySelector('textarea')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    expect((await app.key('Tab')).defaultPrevented).toBe(false)
    expect(app.insert).not.toHaveBeenCalled()
  })
  it('does not replace drafts or attachments, and yields to commands and queued input', async () => {
    const app = await harness(); await app.advance()
    for (const state of [
      { draft: '已有草稿' }, { draft: ' ' }, { phase: 'claimed' }, { attachmentIds: ['attachment'] }, { queue: [{}] },
    ]) {
      app.input({ draft: '', phase: 'plain', attachmentIds: [], queue: [], ...state } as Partial<InputState>)
      await app.render()
      expect((await app.key('Tab')).defaultPrevented).toBe(false)
    }
    app.input({ draft: '', phase: 'plain', attachmentIds: [], queue: [] })
    app.menu('command'); await app.render()
    expect((await app.key('Tab')).defaultPrevented).toBe(false)
    app.menu(null); await app.render()
    // A character typed before React's next frame is still protected.
    document.querySelector('textarea')!.value = '刚输入'
    expect((await app.key('Tab')).defaultPrevented).toBe(false)
    expect(app.insert).not.toHaveBeenCalled()
  })
  it('dismisses with Escape and restores the native placeholder on disable', async () => {
    const app = await harness(); await app.advance()
    await app.key('Escape')
    expect(document.querySelector('textarea')!.placeholder).toBe('发送消息')
    expect((await app.key('Tab')).defaultPrevented).toBe(false)
    await app.toggle(false); await app.advance()
    expect(vi.mocked(callPatchApi)).toHaveBeenCalledTimes(1)
    await app.toggle(true); await app.advance()
    expect(document.querySelector('textarea')!.placeholder).toBe('帮我补充输入框的交互测试')
    await app.toggle(false)
    expect(document.querySelector('textarea')!.placeholder).toBe('发送消息')
  })
  it('discards late responses across sessions and running turns; failures leave native input usable', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(callPatchApi).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const app = await harness(); await app.advance()
    app.props.sessionId = 'b'
    await app.render()
    await act(async () => resolve({ suggestion: 'a 会话的旧建议' }))
    expect(document.querySelector('textarea')!.placeholder).toBe('发送消息')
    vi.mocked(callPatchApi).mockRejectedValueOnce(new Error('offline'))
    await app.advance()
    expect(document.querySelector('textarea')!.placeholder).toBe('发送消息')
    app.session({ running: true }); await app.render(); await app.advance()
    expect(callPatchApi).toHaveBeenCalledTimes(2)
    app.session({ running: false }); await app.render(); await app.advance()
    expect(document.querySelector('textarea')!.placeholder).toBe('帮我补充输入框的交互测试')
    app.session({ running: true }); await app.render()
    expect((await app.key('Tab')).defaultPrevented).toBe(false)
  })
})
