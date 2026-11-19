export const ID = 'terminal-control'
export type Mode = 'restricted' | 'full'
export type Operation = { action: 'read' } | { action: 'run' | 'input'; text: string }
export interface Request {
  id: string
  operation: Operation
}

export const SCREEN_LIMIT = 4000
export const APPROVAL_MS = 60_000

/** Validate on both sides of the bridge before displaying or dispatching anything. */
export function operation(value: unknown, mode: Mode): Operation {
  if (typeof value !== 'object' || value === null || !('action' in value)) throw new Error('未知终端操作。')
  if (value.action === 'read' && !('text' in value)) return { action: 'read' }
  if (!('text' in value) || typeof value.text !== 'string' || !value.text.length || value.text.length > 4096) {
    throw new Error('终端输入须为 1 至 4096 个字符。')
  }
  if (value.action === 'input' && mode === 'full') return { action: 'input', text: value.text }
  // A restricted preview must visibly represent every byte sent before the final Enter.
  if (value.action !== 'run' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.text)) {
    throw new Error('命令须为单行可见文本，原始输入需要完全控制。')
  }
  return { action: 'run', text: value.text }
}
