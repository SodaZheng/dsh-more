import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolGuard, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Channel } from './host/channel.js'
import { hostPatch } from './host/index.js'
import { APPROVAL_MS, operation } from './shared.js'

const signal = new AbortController().signal
afterEach(() => vi.useRealTimers())

describe('sidebar terminal channel', () => {
  it('delivers once, checks claim order and drops duplicate or mismatched replies', async () => {
    vi.useFakeTimers()
    const ch = new Channel('full', vi.fn())
    const next = ch.next()
    expect(() => ch.next()).toThrow()
    const tool = ch.execute({ action: 'run', text: 'pwd' }, signal)
    expect(() => ch.execute({ action: 'read' }, signal)).toThrow()
    const request = (await next)!
    expect(request.operation).toEqual({ action: 'run', text: 'pwd' })
    expect(() => ch.claim('bogus')).toThrow()
    expect(() => ch.settle(request.id, true, 'premature')).toThrow()
    ch.claim(request.id)
    expect(() => ch.claim(request.id)).toThrow()
    expect(() => ch.settle(request.id, true, 'x'.repeat(5000))).toThrow()
    ch.settle(request.id, true, 'ok')
    await expect(tool).resolves.toBe('ok')
    expect(() => ch.settle(request.id, true, 'again')).toThrow()
    const idle = ch.next()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await idle).toBeNull()
    ch.close()
  })

  it('denies raw input, multiline and invisible controls in restricted previews', () => {
    for (const text of ['a\nb', 'a\rb', '\t', '\x1b[A', 'abc\u202edef', 'a\u2028b', 'a\u0085b']) {
      expect(() => operation({ action: 'run', text }, 'restricted')).toThrow()
    }
    expect(operation({ action: 'run', text: 'echo "你好"' }, 'restricted').action).toBe('run')
    expect(() => operation({ action: 'input', text: '\x03' }, 'restricted')).toThrow()
    expect(operation({ action: 'input', text: '\x03' }, 'full').action).toBe('input')
  })

  it('invalidates pending approval on cancellation, timeout and lease expiry', async () => {
    vi.useFakeTimers()
    const closed = vi.fn()
    const ch = new Channel('restricted', closed)
    const abort = new AbortController()
    const failed = expect(ch.execute({ action: 'run', text: 'pwd' }, abort.signal)).rejects.toThrow()
    const { id } = (await ch.next())!
    const ended = ch.watch(id)
    abort.abort()
    await failed
    expect(await ended).toBe(true)
    expect(() => ch.claim(id)).toThrow()
    const timed = expect(ch.execute({ action: 'read' }, signal)).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(APPROVAL_MS)
    await timed
    await vi.advanceTimersByTimeAsync(95_000)
    expect(closed).toHaveBeenCalledOnce()
    expect(() => ch.execute({ action: 'read' }, signal)).toThrow()
  })

  it('binds the tool and background-shell guard to the granting agent and removes both on disable', async () => {
    let definition: ToolDefinition | undefined
    let guard: ToolGuard | undefined
    const removeTool = vi.fn(), removeGuard = vi.fn(), removePrompt = vi.fn()
    const tools = {
      register(tool: ToolDefinition) { definition = tool; return removeTool },
      guard(fn: ToolGuard) { guard = fn; return removeGuard },
    }
    const agent = { ctx: { get: (key: string) => key === 'tools' ? tools : { section: () => removePrompt } } }
    const ctx = { agents: { get: (id: string) => id === 'mine' ? agent : undefined }, on: () => vi.fn() } as unknown as Context
    const dispose = hostPatch.setup!(ctx)
    const routes = hostPatch.routes({ ctx, confirmationSecret: new Uint8Array() })
    const payload = { sessionId: 'mine', mode: 'restricted' }
    const auth = await routes.open!(payload) as { key: string }
    expect(() => routes.open!(payload)).toThrow('已有授权')
    expect(() => routes.open!({ ...payload, sessionId: 'elsewhere' })).toThrow()
    expect(() => routes.next!({ key: 'wrong' })).toThrow()
    const target = (definition!.parameters as { properties: { target: { enum: string[] } } }).properties.target.enum[0]
    const exec = { agent, signal } as unknown as ToolRunContext
    expect(guard!({ ...exec, name: 'bash' })).toMatch(/sidebar_terminal/)
    expect(guard!({ ...exec, name: 'read' })).toBeUndefined()
    await expect(definition!.execute({ target, action: 'read' }, { ...exec, agent: {} } as ToolRunContext)).rejects.toThrow()
    await expect(definition!.execute({ target: 'old', action: 'read' }, exec)).rejects.toThrow()
    await expect(definition!.execute({ target, action: 'input', text: 'x' }, exec)).rejects.toThrow()
    const pending = expect(definition!.execute({ target, action: 'read' }, exec)).rejects.toThrow('授权已结束')
    const next = await routes.next!(auth)
    expect(next).toMatchObject({ operation: { action: 'read' } })
    dispose()
    await pending
    for (const remove of [removeGuard, removeTool, removePrompt]) expect(remove).toHaveBeenCalledOnce()
    expect(() => routes.open!(payload)).toThrow('已关闭')
    const second = hostPatch.setup!(ctx)
    expect(await routes.open!(payload)).not.toEqual(auth)
    second()
  })
})
