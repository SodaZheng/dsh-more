// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { installTerminalClipboard } from './client/clipboard.js'
import { resolveTerminal, type TerminalHandle } from './client/terminal.js'
import { clientPatch } from './client/index.js'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'

const disposers: Array<() => void> = []
const writeText = vi.fn(async (_text: string) => {})
const readText = vi.fn(async () => 'echo hello\r\n')
beforeEach(() => {
  writeText.mockClear(); readText.mockReset().mockResolvedValue('echo hello\r\n')
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText, readText } as unknown as Clipboard)
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
function fixture() {
  const host = document.createElement('div')
  const root = document.createElement('div')
  root.className = 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  root.append(textarea); host.append(root); document.body.append(host)
  const term: TerminalHandle = {
    element: root, textarea, options: {}, getSelection: vi.fn(() => ''),
    paste: vi.fn(), focus: () => textarea.focus(),
  }
  Object.assign(host, { __reactFiber$test: { return: {
    memoizedState: { memoizedState: { current: host }, next: { memoizedState: { current: term }, next: null } },
  } } })
  return { root, term, textarea, host }
}
function start() { disposers.push(installTerminalClipboard(document)) }
function mouse(target: Element, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event); return event
}
function key(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event); return event
}
function nativePaste(target: Element, text: string) {
  const data = new DataTransfer()
  data.setData('text/html', '<span style="color:red">rich text</span>')
  data.setData('text/plain', text)
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
  target.dispatchEvent(event); return event
}
async function flush() { await Promise.resolve(); await Promise.resolve() }

describe('native terminal adapter', () => {
  it('resolves refs created by real React and survives a rerender', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div'); document.body.append(container)
    const renderer = createRoot(container)
    let expected: TerminalHandle | undefined
    function Screen({ label }: { label: string }) {
      const host = useRef<HTMLDivElement>(null)
      const ref = useRef<TerminalHandle>()
      useLayoutEffect(() => {
        const element = document.createElement('div'); element.className = 'xterm'
        const textarea = document.createElement('textarea'); textarea.className = 'xterm-helper-textarea'
        element.append(textarea); host.current!.append(element)
        expected = ref.current = { element, textarea, options: {}, getSelection: () => '', paste: vi.fn(), focus: () => textarea.focus() }
        return () => { element.remove(); ref.current = undefined }
      }, [])
      return createElement('div', { ref: host, 'aria-label': label })
    }
    try {
      await act(async () => renderer.render(createElement(Screen, { label: 'first' })))
      expect(resolveTerminal(expected!.element)).toBe(expected)
      await act(async () => renderer.render(createElement(Screen, { label: 'updated' })))
      expect(resolveTerminal(expected!.element)).toBe(expected)
    } finally { await act(async () => renderer.unmount()); vi.unstubAllGlobals() }
  })
  it('finds only the exact xterm root and fails closed for unrelated refs', () => {
    const a = fixture(); const b = fixture()
    expect(resolveTerminal(a.root)).toBe(a.term)
    a.term.element = b.root
    expect(resolveTerminal(a.root)).toBeUndefined()
    expect(resolveTerminal(document.body)).toBeUndefined()
  })
  it('handles malformed and cyclic React state without throwing or hanging', () => {
    const { root, host } = fixture()
    const hook: Record<string, unknown> = { memoizedState: { current: { element: root, textarea: {} } } }
    hook.next = hook
    Object.assign(host, { __reactFiber$test: { memoizedState: hook } })
    expect(resolveTerminal(root)).toBeUndefined()
  })
})

describe('terminal clipboard interactions', () => {
  it('copies the actual xterm selection after a completed mouse selection', async () => {
    const { root, term } = fixture(); start()
    mouse(root, 'mousedown')
    vi.mocked(term.getSelection).mockReturnValue('中文 selected\nwrapped line')
    mouse(document.body, 'mouseup')
    await flush()
    expect(writeText).toHaveBeenCalledWith('中文 selected\nwrapped line')
    mouse(root, 'mousedown'); mouse(root, 'mouseup'); await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
  })
  it('right-click strips color escapes and preserves literal colors, tabs and newlines', async () => {
    const { root, term } = fixture(); start()
    readText.mockResolvedValue('\x1b[38;2;1;2;3m中文\x1b[0m\t#ff0000\r\n\x9b48:5:123m第二行\x9bm')
    const nativeMenu = vi.fn(); root.addEventListener('contextmenu', nativeMenu)
    expect(mouse(root, 'contextmenu', { button: 2 }).defaultPrevented).toBe(true)
    await flush()
    expect(term.paste).toHaveBeenCalledExactlyOnceWith('中文\t#ff0000\r\n第二行')
    expect(nativeMenu).not.toHaveBeenCalled()
  })
  it('preserves Shift+right-click, read-only terminals, and unrelated UI', async () => {
    const { root, term } = fixture(); start()
    expect(mouse(root, 'contextmenu', { shiftKey: true }).defaultPrevented).toBe(false)
    term.options.disableStdin = true
    expect(mouse(root, 'contextmenu').defaultPrevented).toBe(false)
    expect(mouse(document.body, 'contextmenu').defaultPrevented).toBe(false)
    await flush(); expect(readText).not.toHaveBeenCalled()
  })
  it('copies Ctrl+C only with selection and preserves SIGINT otherwise', async () => {
    const { textarea, term } = fixture(); start()
    expect(key(textarea, 'c', { ctrlKey: true }).defaultPrevented).toBe(false)
    vi.mocked(term.getSelection).mockReturnValue('selected')
    expect(key(textarea, 'c', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key(textarea, 'C', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    await flush(); expect(writeText.mock.calls).toEqual([['selected'], ['selected']])
  })
  it.each(['Win32', 'Linux x86_64'])('lets Ctrl+V trigger a plain-text native paste on %s', (platform) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    const { textarea, term } = fixture(); start()
    const xtermKey = vi.fn(); textarea.addEventListener('keydown', xtermKey)
    const xtermPaste = vi.fn(); textarea.addEventListener('paste', xtermPaste)
    expect(key(textarea, 'v', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(xtermKey).not.toHaveBeenCalled()
    expect(nativePaste(textarea, '\x1b[31mred\x1b[0m').defaultPrevented).toBe(true)
    expect(xtermPaste).not.toHaveBeenCalled()
    expect(term.paste).toHaveBeenCalledExactlyOnceWith('red')
    expect(readText).not.toHaveBeenCalled()
  })
  it('reads the clipboard for macOS Ctrl+V, Ctrl+Shift+V and Shift+Insert', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const { textarea, term } = fixture(); start()
    readText.mockResolvedValue('\x1b[38;5;202mecho hello\x1b[m')
    expect(key(textarea, 'v', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key(textarea, 'v', { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true)
    await flush()
    expect(key(textarea, 'V', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    await flush()
    expect(key(textarea, 'Insert', { shiftKey: true }).defaultPrevented).toBe(true)
    await flush()
    for (const init of [{ metaKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, isComposing: true }]) {
      expect(key(textarea, 'v', init).defaultPrevented).toBe(false)
    }
    expect(key(textarea, 'c', { metaKey: true }).defaultPrevented).toBe(false)
    expect(term.paste).toHaveBeenCalledTimes(3)
    expect(term.paste).toHaveBeenCalledWith('echo hello')
    expect(readText).toHaveBeenCalledTimes(3)
  })
  it('drops OSC colors and empty pastes without changing other text or controls', () => {
    const { textarea, term } = fixture(); start()
    nativePaste(textarea, '\x1b]11;rgb:11/22/33\x1b\\\x9d4;1;#fff\x9c\x1b]112\x07\x1b[0m')
    expect(term.paste).not.toHaveBeenCalled()
    const literal = 'printf "\\e[31m"\n\x1b[2Krgb(1, 2, 3)'
    nativePaste(textarea, '\x1b]10;#fff\x07' + literal)
    expect(term.paste).toHaveBeenCalledExactlyOnceWith(literal)
  })
  it('leaves native paste alone outside the writable terminal and after disposal', () => {
    const { textarea, term } = fixture(); start()
    expect(nativePaste(document.body, 'outside').defaultPrevented).toBe(false)
    term.options.disableStdin = true
    expect(nativePaste(textarea, 'readonly').defaultPrevented).toBe(false)
    term.options.disableStdin = false
    disposers.pop()?.()
    expect(nativePaste(textarea, 'disabled').defaultPrevented).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
  })
  it('supersedes a pending clipboard read with a newer native paste', async () => {
    const { root, textarea, term } = fixture(); start()
    let finish!: (text: string) => void
    readText.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    mouse(root, 'contextmenu')
    nativePaste(textarea, 'new')
    finish('old'); await flush()
    expect(term.paste).toHaveBeenCalledExactlyOnceWith('new')
  })
  it.each(['dispose', 'detach', 'blur', 'readonly', 'replace'])('drops asynchronous paste after %s', async (change) => {
    const { root, term } = fixture(); start()
    let finish!: (text: string) => void
    readText.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    mouse(root, 'contextmenu')
    if (change === 'dispose') disposers.pop()?.()
    if (change === 'detach') root.remove()
    if (change === 'blur') window.dispatchEvent(new Event('blur'))
    if (change === 'readonly') term.options.disableStdin = true
    if (change === 'replace') term.element = document.createElement('div')
    finish('never send'); await flush()
    expect(term.paste).not.toHaveBeenCalled()
  })
  it('reports permission failure without unhandled rejection and cleans up', async () => {
    const { root } = fixture(); start()
    readText.mockRejectedValue(new Error('denied'))
    mouse(root, 'contextmenu'); await flush()
    expect(document.querySelector('[role="status"]')?.textContent).toContain('粘贴失败')
    disposers.pop()?.()
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(mouse(root, 'contextmenu').defaultPrevented).toBe(false)
  })
  it('works for terminals mounted after installation', async () => {
    start(); const { root, term } = fixture()
    mouse(root, 'contextmenu'); await flush()
    expect(term.paste).toHaveBeenCalledTimes(1)
  })
  it('responds to the settings toggle and plugin disposal', async () => {
    const { root, term } = fixture()
    let enabled = false
    let listener = () => {}
    let cleanup = () => {}
    const unsubscribe = vi.fn()
    const ctx = { effect: (setup: () => () => void) => { cleanup = setup() } }
    const activation = {
      getSnapshot: () => ({ ...DEFAULT_PATCH_SETTINGS, 'terminal-clipboard': enabled }),
      subscribe: (callback: () => void) => { listener = callback; return unsubscribe },
      getSettingsSnapshot: vi.fn(), set: vi.fn(),
    }
    clientPatch.install(ctx as never, activation)
    disposers.push(() => cleanup())
    expect(mouse(root, 'contextmenu').defaultPrevented).toBe(false)
    enabled = true; listener(); listener()
    mouse(root, 'contextmenu'); await flush()
    expect(term.paste).toHaveBeenCalledTimes(1)
    enabled = false; listener()
    expect(mouse(root, 'contextmenu').defaultPrevented).toBe(false)
    enabled = true; listener(); cleanup()
    expect(mouse(root, 'contextmenu').defaultPrevented).toBe(false)
    expect(unsubscribe).toHaveBeenCalled()
  })
})
