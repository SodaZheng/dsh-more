import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { requireLiveSession, requireIdleAgent } from '../../../platform/dsh/host/agent-session.js'
import { requireString } from '../../../platform/dsh/host/wire.js'
import { NEXT_STEP_SUGGESTION_PATCH_ID, type SuggestionResult } from '../shared.js'
import { generateSuggestion, suggestionContext } from './generate.js'

const EMPTY: SuggestionResult = { suggestion: null }

export function createSuggestionService(ctx: Context): { suggest(payload: unknown): Promise<SuggestionResult>; dispose(): void } {
  const lifetime = new AbortController()
  const cache = new Map<string, { key: string; abort: AbortController; result: Promise<SuggestionResult> }>()
  const stop = (id: string): void => { cache.get(id)?.abort.abort(); cache.delete(id) }
  const offStatus = ctx.on('agent/status', ({ agent, status }) => { if (status !== 'idle') stop(agent.id) }, { global: true })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => stop(agent.id), { global: true })
  return {
    async suggest(payload) {
      const id = requireString(payload, 'sessionId')
      const session = requireLiveSession(ctx, id)
      const agent = requireIdleAgent(ctx, id, session)
      if (lifetime.signal.aborted) return EMPTY
      const context = suggestionContext(session.deriveMessages())
      if (context.at(-1)?.role !== 'assistant' || !context.some((message) => message.role === 'user')) return EMPTY
      const request = session.requestContext()
      const provider = agent.options.provider ?? request?.provider
      const model = agent.options.model ?? request?.model
      if (!provider || !model) return EMPTY
      const route: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'> = { provider, model }
      const key = createHash('sha256').update(JSON.stringify([route, context])).digest('hex')
      const found = cache.get(id)
      if (found?.key === key) return found.result
      stop(id)
      if (cache.size >= 100) stop(cache.keys().next().value!)
      const abort = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, abort.signal, AbortSignal.timeout(30_000)])
      const result = (async (): Promise<SuggestionResult> => {
        try {
          const info = await ctx.llm.resolveModelInfo(provider, model, signal)
          const reasoning = info.reasoning
          const effort = reasoning?.efforts.find((item) => item.id === 'off')?.id
            ?? reasoning?.defaultEffort ?? reasoning?.efforts[0]?.id
          if (effort !== undefined) route.reasoningEffort = effort
          const suggestion = await generateSuggestion((options) => ctx.llm.stream(options), route, context, signal)
          signal.throwIfAborted()
          // Never return a completion generated for a previous turn or unloaded Agent.
          if (ctx.agents.get(session.id) !== agent || agent.status !== 'idle'
            || JSON.stringify(suggestionContext(session.deriveMessages())) !== JSON.stringify(context)
            || (agent.options.provider ?? session.requestContext()?.provider) !== provider
            || (agent.options.model ?? session.requestContext()?.model) !== model) return EMPTY
          return { suggestion }
        } catch { return EMPTY }
      })()
      cache.set(id, { key, abort, result })
      return result
    },
    dispose() {
      lifetime.abort()
      offStatus()
      offDisposed()
      cache.clear()
    },
  }
}

const services = new WeakMap<Context, ReturnType<typeof createSuggestionService>>()

export const hostPatch: HostPatch = {
  id: NEXT_STEP_SUGGESTION_PATCH_ID,
  setup(ctx) {
    const fiber = ctx.inject(['llm', 'sessions', 'agents'], (scope) => {
      const service = createSuggestionService(scope)
      services.set(ctx, service)
      scope.effect(() => () => { service.dispose(); if (services.get(ctx) === service) services.delete(ctx) })
    })
    return () => { services.get(ctx)?.dispose(); services.delete(ctx); void fiber.dispose() }
  },
  routes: ({ ctx }) => ({ suggest: (payload) => services.get(ctx)?.suggest(payload) ?? EMPTY }),
}
