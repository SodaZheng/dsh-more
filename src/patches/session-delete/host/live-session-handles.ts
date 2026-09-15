import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

const TRACKER = Symbol.for('dsh-more.session-delete.live-session-handles')

interface MutableAgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  [TRACKER]?: LiveSessionHandleTracker
}

interface LiveSessionHandleTracker {
  readonly handles: Map<SessionId, AgentHandle>
  originalCreate: MutableAgentRegistry['create']
  originalResume: MutableAgentRegistry['resume']
  wrappedCreate: MutableAgentRegistry['create']
  wrappedResume: MutableAgentRegistry['resume']
  createDescriptor: PropertyDescriptor | undefined
  resumeDescriptor: PropertyDescriptor | undefined
  references: number
}

function trackedHandle(tracker: LiveSessionHandleTracker, handle: AgentHandle): AgentHandle {
  let disposal: Promise<void> | undefined
  const wrapped: AgentHandle = {
    agent: handle.agent,
    dispose: () => disposal ??= Promise.resolve().then(async () => {
      await handle.dispose()
      if (tracker.handles.get(handle.agent.id) === wrapped) tracker.handles.delete(handle.agent.id)
    }),
  }
  tracker.handles.set(handle.agent.id, wrapped)
  return wrapped
}

/** Track public Agent handles so one live Session can be cleanly unloaded before disk deletion. */
export function installLiveSessionHandleTracker(ctx: Context): () => void {
  const registry = ctx.agents as unknown as MutableAgentRegistry
  const existing = registry[TRACKER]
  if (existing !== undefined) {
    existing.references += 1
    return releaseTracker(registry, existing)
  }
  const originalCreate = registry.create
  const originalResume = registry.resume
  const tracker = { handles: new Map() } as LiveSessionHandleTracker
  tracker.originalCreate = originalCreate
  tracker.originalResume = originalResume
  tracker.createDescriptor = Object.getOwnPropertyDescriptor(registry, 'create')
  tracker.resumeDescriptor = Object.getOwnPropertyDescriptor(registry, 'resume')
  tracker.wrappedCreate = async (options) => trackedHandle(tracker, await originalCreate.call(registry, options))
  tracker.wrappedResume = async (options) => trackedHandle(tracker, await originalResume.call(registry, options))
  tracker.references = 1
  registry[TRACKER] = tracker
  registry.create = tracker.wrappedCreate
  registry.resume = tracker.wrappedResume
  return releaseTracker(registry, tracker)
}

function releaseTracker(registry: MutableAgentRegistry, tracker: LiveSessionHandleTracker): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    tracker.references -= 1
    if (tracker.references > 0 || registry[TRACKER] !== tracker) return
    // Cordis returns traced functions on property reads; compare own descriptors.
    const restore = (key: 'create' | 'resume', installed: unknown, descriptor: PropertyDescriptor | undefined): void => {
      if (Object.getOwnPropertyDescriptor(registry, key)?.value !== installed) return
      if (descriptor === undefined) Reflect.deleteProperty(registry, key)
      else Object.defineProperty(registry, key, descriptor)
    }
    restore('create', tracker.wrappedCreate, tracker.createDescriptor)
    restore('resume', tracker.wrappedResume, tracker.resumeDescriptor)
    delete registry[TRACKER]
  }
}

/** Return the exact live handle when this plugin observed its creation or resume. */
export function getLiveSessionHandle(ctx: Context, sessionId: SessionId): AgentHandle | undefined {
  return (ctx.agents as unknown as MutableAgentRegistry)[TRACKER]?.handles.get(sessionId)
}
