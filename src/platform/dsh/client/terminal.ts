/** Only the public xterm surface is used after locating the native React ref. */
export interface TerminalHandle {
  element: HTMLElement
  textarea: HTMLTextAreaElement
  options: { disableStdin?: boolean }
  getSelection(): string
  paste(text: string): void
  focus(): void
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' ? value as RecordValue : undefined
}
function terminal(value: unknown, root: HTMLElement): TerminalHandle | undefined {
  const candidate = record(value)
  if (candidate?.element !== root || !candidate.textarea
    || candidate.textarea !== root.querySelector('textarea.xterm-helper-textarea')) return
  if (!record(candidate.options) || typeof candidate.getSelection !== 'function'
    || typeof candidate.paste !== 'function' || typeof candidate.focus !== 'function') return
  return candidate as unknown as TerminalHandle
}

/**
 * DSH's TerminalScreen keeps xterm in a useRef but exposes no terminal API.
 * Isolate the version-sensitive lookup here, bound every walk, and fail closed.
 * Never mutate React internals, xterm prototypes, or the native key handler.
 */
export function resolveTerminal(root: HTMLElement): TerminalHandle | undefined {
  for (let node: HTMLElement | null = root, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'))
    if (!key) continue
    let fiber = record((node as unknown as RecordValue)[key])
    for (let level = 0; fiber && level < 12; level++, fiber = record(fiber.return)) {
      for (const version of [fiber, record(fiber.alternate)]) {
        let hook = record(version?.memoizedState)
        for (let index = 0; hook && index < 32; index++, hook = record(hook.next)) {
          const found = terminal(record(hook.memoizedState)?.current, root)
          if (found) return found
        }
      }
    }
  }
}
