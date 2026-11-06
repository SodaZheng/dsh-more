// @vitest-environment happy-dom
// Exercise the installed SDK's real InputBar, Lexical editor, and input actions.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { act, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerBarProps, InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { expect, it, vi } from 'vitest'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { SuggestionComposer } from './client/index.js'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: async () => ({ suggestion: '帮我补充输入框的交互测试' }) }))

interface Shell {
  actions: InputActions
  state: { subscribe(listener: () => void): () => void; getSnapshot(): InputState }
  focus(): void
  dispose(): void
}

function nativeEditor(): { InputBar: ComponentType<ComposerBarProps>; SessionInputShell: new (deps: { actx: Context; defaultSink: () => Promise<{ kind: 'success' }> }) => Shell } {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
    .replace('return module.exports;', 'return { InputBar, SessionInputShell };')
  let result: ReturnType<typeof nativeEditor> | undefined
  const primitives = new Proxy({ __esModule: true }, { get: (target, key) => key in target ? target[key as never]
    : ({ children }: { children?: ReactNode }) => children ?? null })
  const stores = { createSnapshotStore<T,>(initial: T) {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set(next: T) { value = next; listeners.forEach((listener) => listener()) },
    }
  } }
  // Only expose the SDK's private constructors in this test; production uses public input actions.
  const loader = { load: (entry: { factory(require: (name: string) => unknown): ReturnType<typeof nativeEditor> }) => {
    result = entry.factory((name) => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives
      : name === '@deepseek-ai/dsh-client-store' ? stores : require(name))
  } }
  new Function('window', source)(new Proxy(window, { get: (target, key) => key === '__ModuleLoader__' ? loader : Reflect.get(target, key) }))
  if (!result) throw new Error('Native composer failed to load')
  return result
}

it('fills the actual native contenteditable, keeps focus, persists, and leaves Enter to native submission', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  const { InputBar, SessionInputShell } = nativeEditor()
  const submit = vi.fn(async () => ({ kind: 'success' as const }))
  const shell = new SessionInputShell({ actx: {} as Context, defaultSink: submit })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const session = { openState: 'open', running: false, blank: false, removed: false, subagent: null, pendingSubmissions: [], promptError: null }
  const settings = { ...DEFAULT_PATCH_SETTINGS }
  const activation = { getSnapshot: () => settings, subscribe: () => () => {}, getSettingsSnapshot: vi.fn(), set: vi.fn() }
  const emptyList: never[] = []
  const emptyMap = new Map()
  const uploads = {}
  const props = {
    sessionId: 'native', variant: 'composer', keyboard: shell, inputActions: shell.actions,
    useInput: (select: (value: InputState) => unknown) => select(useSyncExternalStore(shell.state.subscribe, shell.state.getSnapshot)),
    useSession: (select: (value: typeof session) => unknown) => select(session),
    useProjection: () => undefined,
    useMenuLauncher: (select: (value: null) => unknown) => select(null),
    useNotices: (select: (value: null) => unknown) => select(null),
    useBusyEnter: (select: (value: string) => unknown) => select('queue'),
    useFileUploads: (select: (value: object) => unknown) => select(uploads),
    useLexicon: (select: (value: Map<unknown, unknown>) => unknown) => select(emptyMap),
    useStopShortcut: (select: (value: never[]) => unknown) => select(emptyList),
    renderSlot: () => null, t: (key: string) => key,
  }
  try {
    await act(async () => { root.render(createElement(SuggestionComposer, { ...props, original: InputBar, activation, active: true } as never)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)) })
    const editor = document.querySelector<HTMLElement>('[data-composer-input]')!
    expect(editor).not.toBeNull()
    expect(editor.getAttribute('data-placeholder')).toBe('帮我补充输入框的交互测试')
    await act(async () => shell.focus())
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => { editor.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(true)
    expect(shell.state.getSnapshot().draft).toBe('帮我补充输入框的交互测试')
    expect(editor.textContent).toBe('帮我补充输入框的交互测试')
    expect(document.activeElement).toBe(editor)
    expect(submit).not.toHaveBeenCalled()
    await act(async () => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(submit).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    shell.dispose()
    vi.unstubAllGlobals()
    if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
    else Reflect.deleteProperty(document, 'fonts')
    document.body.innerHTML = ''
  }
})
