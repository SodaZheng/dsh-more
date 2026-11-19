import { randomUUID } from 'node:crypto'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { APPROVAL_MS, SCREEN_LIMIT, type Mode, type Operation, type Request } from '../shared.js'

const stale = () => new DshMoreError('stale-preview', '本次终端请求已结束。', 409)
const LEASE_MS = 95_000

/** One browser attachment, one outstanding tool call, at most one input dispatch. */
export class Channel {
  readonly key = randomUUID()
  readonly target = randomUUID().slice(0, 8)
  private closed = false
  private expiry: ReturnType<typeof setTimeout> | undefined
  private wake: ((request: Request | null) => void) | undefined
  private pending: {
    request: Request
    phase: 'queued' | 'delivered' | 'claimed'
    notifyEnd?: () => void
    finish: (result: string | Error) => void
  } | undefined

  constructor(readonly mode: Mode, private readonly onClose: () => void) { this.renew() }

  private renew(): void {
    clearTimeout(this.expiry)
    this.expiry = setTimeout(() => this.close(), LEASE_MS)
    this.expiry.unref()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.expiry)
    this.wake?.(null)
    this.pending?.finish(new Error('终端授权已结束。'))
    this.onClose()
  }

  execute(op: Operation, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.closed) throw stale()
    if (this.pending) throw new Error('上一次终端操作仍在处理中。')
    return new Promise((resolve, reject) => {
      const request = { id: randomUUID(), operation: op }
      const abort = () => finish(new Error('终端操作已取消。'))
      const finish = (result: string | Error): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending?.notifyEnd?.()
        this.pending = undefined
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      const timer = setTimeout(() => finish(new Error('终端请求超时。请先读取屏幕核对结果。')), APPROVAL_MS)
      signal.addEventListener('abort', abort, { once: true })
      this.pending = { request, phase: 'queued', finish }
      if (this.wake) this.wake(this.deliver())
    })
  }

  private deliver(): Request | null {
    if (this.pending?.phase !== 'queued') return null
    this.pending.phase = 'delivered'
    this.renew()
    return this.pending.request
  }

  next(): Promise<Request | null> {
    if (this.closed || this.wake) throw stale()
    this.renew()
    const ready = this.deliver()
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wake?.(null), 15_000)
      this.wake = (request) => { clearTimeout(timer); this.wake = undefined; resolve(request) }
    })
  }

  claim(id: string): boolean {
    if (!this.pending || this.pending.request.id !== id || this.pending.phase !== 'delivered') throw stale()
    this.pending.phase = 'claimed'
    return true
  }

  watch(id: string): Promise<boolean> {
    const pending = this.pending
    if (pending?.request.id !== id || pending.notifyEnd) throw stale()
    return new Promise(resolve => { pending.notifyEnd = () => resolve(true) })
  }

  settle(id: string, ok: unknown, message: unknown): boolean {
    const pending = this.pending
    if (!pending || pending.request.id !== id || pending.phase === 'queued'
      || (ok === true && pending.phase !== 'claimed')) throw stale()
    if (typeof ok !== 'boolean' || typeof message !== 'string' || message.length > SCREEN_LIMIT + 200) {
      throw new DshMoreError('bad-request', '终端回复无效。')
    }
    pending.finish(ok ? message : new Error(message))
    return true
  }
}
