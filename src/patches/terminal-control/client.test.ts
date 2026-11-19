// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountControl } from './client/control.js'
import { recentScreen, type Screen } from './client/screen.js'
import { Channel } from './host/channel.js'
import type { Mode } from './shared.js'

const clear: (() => void)[] = []
afterEach(() => { clear.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks() })

function panel() {
  const session = document.createElement('div')
  session.dataset.sidebarRightSession = 'conversation-A'
  const root = document.createElement('section')
  root.setAttribute('data-sidebar-terminal', '')
  const xterm = document.createElement('div')
  xterm.className = 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  xterm.append(textarea); root.append(xterm); session.append(root); document.body.append(session)
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300))
  const input = vi.fn()
  const term: Screen = {
    element: xterm, textarea, options: { disableStdin: false }, getSelection: () => '', paste: vi.fn(), focus: vi.fn(),
    input, rows: 24, onWriteParsed: () => ({ dispose: vi.fn() }),
    buffer: { active: { length: 1, getLine: () => ({ translateToString: () => 'shell-ready' }) } },
  }
  Object.assign(root, { __reactFiber$test: { memoizedState: { memoizedState: { current: term } } } })

  let channel: Channel
  let delayClaim: (() => Promise<void>) | undefined
  const control = mountControl(root, async <T>(action: string, payload: object): Promise<T> => {
    const req = payload as { mode: Mode; id: string; ok: boolean; message: string }
    switch (action) {
      case 'open': channel = new Channel(req.mode, () => {}); return { key: channel.key } as T
      case 'next': return await channel.next() as T
      case 'claim': { const claimed = channel.claim(req.id); await delayClaim?.(); return claimed as T }
      case 'watch': return await channel.watch(req.id) as T
      case 'result': return channel.settle(req.id, req.ok, req.message) as T
      case 'close': channel.close(); return true as T
      default: throw new Error(action)
    }
  })
  clear.push(control.dispose)
  const select = root.querySelector('select')!
  async function mode(value: Mode) {
    select.value = value
    select.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(root.querySelector('[role=status]')!.textContent).toMatch(/对话可/))
    return channel
  }
  return { mode, root, session, input, term, select, control, blockClaim: (delay: () => Promise<void>) => { delayClaim = delay } }
}

describe('visible terminal control', () => {
  it('starts off, previews literal text, and only sends after explicit one-shot approval', async () => {
    const p = panel()
    expect(p.select.value).toBe('off')
    const channel = await p.mode('restricted')
    const signal = new AbortController().signal
    const command = 'echo "<example>"'
    const result = channel.execute({ action: 'run', text: command }, signal)
    await vi.waitFor(() => expect(p.root.querySelector('pre')?.textContent).toBe(command))
    expect(p.input).not.toHaveBeenCalled()
    p.root.querySelector<HTMLButtonElement>('.tc-allow')!.click()
    expect(await result).toContain('shell-ready')
    expect(p.input.mock.calls).toEqual([[command + '\r', true]])
    expect(p.root.querySelector('summary')?.textContent).toContain(command)
    const denied = expect(channel.execute({ action: 'run', text: 'pwd' }, signal)).rejects.toThrow()
    await vi.waitFor(() => expect(p.root.querySelector('pre')).toBeTruthy())
    p.root.querySelector<HTMLButtonElement>('.tc-actions button:not(.tc-allow)')!.click()
    await denied
    expect(p.input).toHaveBeenCalledTimes(1)
  })

  it('keeps the original full grant when a background window is hidden or reports no layout size', async () => {
    const p = panel()
    const ch = await p.mode('full')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    vi.mocked(p.root.getBoundingClientRect).mockReturnValue(new DOMRect())
    document.dispatchEvent(new Event('visibilitychange'))
    p.control.check()
    const result = await ch.execute({ action: 'run', text: 'pwd' }, new AbortController().signal)
    expect(p.input.mock.calls).toEqual([['pwd\r', true]])
    expect(result).toContain('shell-ready')
    expect(p.select.value).toBe('full')
  })

  it('retains a restricted preview across a screen switch and still requires the original approval', async () => {
    const p = panel()
    const ch = await p.mode('restricted')
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    const result = ch.execute({ action: 'run', text: 'pwd' }, new AbortController().signal)
    await vi.waitFor(() => expect(p.root.querySelector('pre')?.textContent).toBe('pwd'))
    expect(p.input).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    p.root.querySelector<HTMLButtonElement>('.tc-allow')!.click()
    expect(await result).toContain('shell-ready')
    expect(p.input.mock.calls).toEqual([['pwd\r', true]])
    expect(p.select.value).toBe('restricted')
  })

  it('drops a claimed input on session switch and never redirects it', async () => {
    const p = panel()
    const channel = await p.mode('full')
    let release: (() => void) | undefined
    p.blockClaim(() => new Promise(resolve => { release = resolve }))
    const failed = expect(channel.execute({ action: 'input', text: '\r' }, new AbortController().signal)).rejects.toThrow()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    p.session.dataset.sidebarRightSession = 'different'
    release!()
    await failed
    expect(p.input).not.toHaveBeenCalled()
    expect(p.select.value).toBe('off')
  })

  it('revokes an outstanding call when the panel hides or the view loses write control', async () => {
    for (const change of ['hide', 'read-only']) {
      const p = panel()
      const ch = await p.mode('restricted')
      const failed = expect(ch.execute({ action: 'run', text: 'date' }, new AbortController().signal)).rejects.toThrow()
      await vi.waitFor(() => expect(p.root.querySelector('pre')).toBeTruthy())
      if (change === 'hide') p.session.hidden = true
      else p.term.options.disableStdin = true
      p.control.check()
      await failed
      expect(p.select.value).toBe('off')
      expect(p.root.querySelector('pre')).toBeNull()
      expect(p.input).not.toHaveBeenCalled()
    }
  })

  it('bounds screen reads and omits trailing blank rows', () => {
    const { term } = panel()
    term.buffer.active = { length: 1100, getLine: i => ({ translateToString: () => i >= 1090 ? '' : String(i) }) }
    const screen = recentScreen(term).split('\n')
    expect(screen.length).toBe(40)
    expect(screen.at(-1)).toBe('1089')
  })
})
