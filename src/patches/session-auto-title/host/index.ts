import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { SESSION_AUTO_TITLE_PATCH_ID, TITLE_TYPES } from '../shared.js'
import { parseTitle, TITLE_SYSTEM_PROMPT } from './generate.js'

interface TitleStatus {
  requests: number
  successes: number
  failures: number
  retries: number
  lastFinish?: string
  lastErrorCode?: string
  lastErrorMessage?: string
}
const statuses = new WeakMap<Context, TitleStatus>()

/** Validate before exposing a successful terminal chunk to the native provider. */
async function* validate(stream: AsyncIterable<StreamChunk>, signal: AbortSignal, status: TitleStatus): AsyncIterable<StreamChunk> {
  let text = ''
  let finish: string | undefined
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted()
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text
      if (text.length > 512) throw new Error('标题响应过长')
      if (chunk.type === 'finish') {
        status.lastFinish = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          status.lastErrorCode = chunk.reason.failure.code
          status.lastErrorMessage = chunk.reason.failure.message.slice(0, 300).replace(/(?:Bearer\s+\S+|sk-[\w-]+)/gi, '[redacted]')
        }
        if (chunk.reason.kind === 'stop') parseTitle(text)
        finish = chunk.reason.kind
      }
      yield chunk
    }
    signal.throwIfAborted()
    if (!finish) throw new Error('标题响应不完整')
    if (finish === 'stop') status.successes += 1
    else status.failures += 1
  } catch (error) {
    status.failures += 1
    throw error
  }
}

export const hostPatch: HostPatch = {
  id: SESSION_AUTO_TITLE_PATCH_ID,
  setup: (ctx) => {
    const status: TitleStatus = { requests: 0, successes: 0, failures: 0, retries: 0 }
    statuses.set(ctx, status)
    const lifetime = new AbortController()
    const forwarded = new WeakSet<GenerateOptions>()
    const fiber = ctx.inject(['llm'], (scope) => {
      scope.on('llm/stream', (options, next) => {
        if (options.purpose !== 'session-title' || forwarded.has(options)) return next()
        status.requests += 1
        // Native options are frozen. Redispatch a detached request through the
        // public LLM seam, marking its identity to prevent recursion. Only one
        // adapter call is made; the outer native request is not dispatched.
        const signal = AbortSignal.any([
          lifetime.signal,
          ...(options.signal ? [options.signal] : []),
        ])
        const revised: GenerateOptions = { ...options, system: TITLE_SYSTEM_PROMPT, maxTokens: Math.max(options.maxTokens ?? 0, 2048), signal }
        async function* dispatch(): AsyncIterable<StreamChunk> {
          // Auxiliary native calls omit reasoning effort. For models that expose
          // only thinking levels, omission can be translated to "thinking off"
          // by an adapter and rejected by the provider (e.g. GLM 5.3 Flash).
          if (revised.reasoningEffort === undefined) {
            const info = await scope.llm.resolveModelInfo(revised.provider, revised.model, signal)
            const reasoning = info.reasoning
            const effort = reasoning?.defaultEffort
              ?? (reasoning?.efforts.some((item) => item.id === 'off') ? undefined : reasoning?.efforts[0]?.id)
            if (effort !== undefined) revised.reasoningEffort = effort
          }
          signal.throwIfAborted()
          forwarded.add(revised)
          for (let attempt = 0; ; attempt += 1) {
            const chunks: StreamChunk[] = []
            let retryable = false
            for await (const chunk of scope.llm.stream(revised)) {
              signal.throwIfAborted()
              chunks.push(chunk)
              if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                const failure = chunk.reason.failure
                retryable = failure.code === 'RATE_LIMIT' || failure.status === 429
              }
            }
            if (!retryable || attempt >= 3) {
              yield* chunks
              return
            }
            status.retries += 1
            // Buffer each attempt so a failed response never contaminates the
            // native assembler. Remain inside its original cancellation deadline.
            await delay(1500 * 2 ** attempt, undefined, { signal })
          }
        }
        return validate(dispatch(), signal, status)
      }, { global: true, prepend: true })
    })
    return () => { lifetime.abort(); void fiber.dispose() }
  },
  routes: ({ ctx }) => ({
    format: () => ({ format: '类型 · 具体任务', types: TITLE_TYPES, mode: 'native-title-request', minOutputTokens: 2048 }),
    status: () => ({ ...statuses.get(ctx) }),
  }),
}
