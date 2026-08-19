import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssembledContext } from '@deepseek-ai/dsh-system-prompt'

const RUNTIME_CONTEXT_PLUGIN = '@deepseek-ai/dsh-system-prompt'
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'

/** Recover the last runtime context already retained by a continuation seed. */
function retainedRuntimeContexts(seed: readonly SessionEvent[]): AssembledContext[] {
  for (let index = seed.length - 1; index >= 0; index -= 1) {
    const event = seed[index]
    if (event?.type !== 'user/message') continue
    const source = event.data.source as { plugin?: unknown; form?: unknown; sections?: unknown }
    if (source.plugin !== RUNTIME_CONTEXT_PLUGIN) continue
    if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      const sections = source.sections.filter((section): section is AssembledContext => {
        const value = section as { name?: unknown; text?: unknown }
        return typeof value.name === 'string' && typeof value.text === 'string'
      })
      if (sections.length === source.sections.length) return sections.map((section) => ({ ...section }))
    }
    const [block] = event.data.content
    if (event.data.content.length === 1 && block?.type === 'text' && block.text.startsWith(RUNTIME_CONTEXT_PREFIX)) {
      return [{ name: 'dsh-more:retained-runtime-context', text: block.text.slice(RUNTIME_CONTEXT_PREFIX.length) }]
    }
    return []
  }
  return []
}

/** Keep one continuation turn prefix-stable without appending a prompt snapshot. */
export function replaySeedRuntimeContext(agentCtx: Context, seed: readonly SessionEvent[]): () => void {
  const retained = retainedRuntimeContexts(seed)
  return agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
    ...await next(),
    contexts: retained.map((context) => ({ ...context })),
  }))
}
