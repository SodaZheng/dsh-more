import { resolveTerminal, type TerminalHandle } from '../../../platform/dsh/client/terminal.js'
import { SCREEN_LIMIT } from '../shared.js'

interface BufferView {
  length: number
  getLine(index: number): { translateToString(trimRight: boolean): string } | undefined
}
export interface Screen extends TerminalHandle {
  rows: number
  input(data: string, wasUserInput: boolean): void
  onWriteParsed(listener: () => void): { dispose(): void }
  buffer: { active: BufferView }
}

function compatible(term: TerminalHandle): term is Screen {
  if (!('input' in term) || typeof term.input !== 'function' || !('buffer' in term)
    || !('onWriteParsed' in term) || typeof term.onWriteParsed !== 'function'
    || !('rows' in term) || !Number.isSafeInteger(term.rows)) return false
  const buffer = term.buffer
  if (!buffer || typeof buffer !== 'object' || !('active' in buffer)) return false
  const active = buffer.active
  return !!active && typeof active === 'object' && 'length' in active && Number.isSafeInteger(active.length)
    && 'getLine' in active && typeof active.getLine === 'function'
}

export function findScreen(root: HTMLElement): Screen | undefined {
  const element = root.querySelector<HTMLElement>('.xterm')
  if (!element) return
  const term = resolveTerminal(element)
  if (term && compatible(term) && term.options.disableStdin === false) return term
}

export function visible(root: HTMLElement): boolean {
  if (!root.isConnected || root.ownerDocument.hidden || root.closest('[hidden],[aria-hidden="true"],[inert]')) return false
  const rect = root.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && root.checkVisibility?.({ visibilityProperty: true }) !== false
}

/** Coalesce shell echo and immediate output without making a silent or long-running job block the conversation. */
export function waitForOutput(term: Screen, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    const paint = term.onWriteParsed(() => {
      clearTimeout(quiet)
      quiet = setTimeout(done, 35)
    })
    const limit = setTimeout(done, 180)
    function done(): void {
      clearTimeout(quiet)
      clearTimeout(limit)
      paint.dispose()
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

export function recentScreen(term: Screen): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  const start = Math.max(0, buffer.length - term.rows - 40)
  for (let i = buffer.length - 1; i >= start; i--) {
    const line = buffer.getLine(i)?.translateToString(true) ?? ''
    if (line || lines.length) lines.push(line)
    if (lines.length >= 40) break
  }
  return lines.reverse().join('\n').slice(-SCREEN_LIMIT)
}
