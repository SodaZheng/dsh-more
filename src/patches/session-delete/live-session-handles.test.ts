import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { getLiveSessionHandle, installLiveSessionHandleTracker } from './host/live-session-handles.js'

describe('live session handle tracking', () => {
  it('shares a failed disposal across retries instead of reporting success', async () => {
    const sessionId = SessionId('session-tracker-failure')
    const failure = new Error('writer close failed')
    const dispose = vi.fn().mockRejectedValue(failure)
    const handle = { agent: { id: sessionId }, dispose } as unknown as AgentHandle
    const ctx = { agents: { create: async () => handle, resume: async () => handle } } as unknown as Context
    const stop = installLiveSessionHandleTracker(ctx)
    try {
      const tracked = await ctx.agents.create({ sessionId })
      await expect(tracked.dispose()).rejects.toBe(failure)
      await expect(tracked.dispose()).rejects.toBe(failure)
      expect(dispose).toHaveBeenCalledOnce()
      expect(getLiveSessionHandle(ctx, sessionId)).toBe(tracked)
    } finally { stop() }
  })

  it('restores Cordis prototype methods when the last subscriber leaves, in either order', async () => {
    class Registry extends Service {
      constructor(ctx: Context) { super(ctx, 'agents') }
      async create(): Promise<AgentHandle> { throw new Error('unused') }
      async resume(): Promise<AgentHandle> { throw new Error('unused') }
    }
    for (const reverse of [false, true]) {
      const ctx = new Context()
      await ctx.plugin(Registry)
      try {
        const agents = ctx.agents
        const before = Object.getOwnPropertyDescriptor(agents, 'create')
        const stops = [installLiveSessionHandleTracker(ctx), installLiveSessionHandleTracker(ctx)]
        if (reverse) stops.reverse()
        stops[0]!()
        stops[0]!()
        expect(Object.getOwnPropertyDescriptor(agents, 'create')?.value).toBeTypeOf('function')
        stops[1]!()
        expect(Object.getOwnPropertyDescriptor(agents, 'create')).toEqual(before)
        expect(Object.getOwnPropertyDescriptor(agents, 'resume')).toBeUndefined()
      } finally { await ctx.fiber.dispose() }
    }
  })
})
