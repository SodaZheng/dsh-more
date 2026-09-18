import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  createEditedContinuation,
  inspectEditCut,
} from './host/edit-continuation.js'
import { addTurn, appendRuntimeContext } from '../../../test/helpers/session.js'

describe('message-edit patch', () => {
  it('cuts before the edited turn and counts all discarded later turns', () => {
    const session = Session.create(SessionId('session-test-edit'))
    const first = addTurn(session, 1, 'first')
    addTurn(session, 2, 'second')
    expect(inspectEditCut(session, first.userSeq, 'rewritten')).toMatchObject({
      targetSeq: first.userSeq,
      turn: 1,
      turnStartSeq: 0,
      laterTurnCount: 2,
    })
  })

  it('reuses the live preset composition without reinjecting runtime context during the edited turn', async () => {
    const session = Session.create(SessionId('session-test-edit-continuation'))
    addTurn(session, 1, 'first')
    appendRuntimeContext(session)
    const second = addTurn(session, 2, 'second')
    const cut = inspectEditCut(session, second.userSeq, 'rewritten')
    const sourceCtx = {} as Context
    const sourceAgent = {
      session,
      ctx: sourceCtx,
      options: { provider: 'test', model: 'test' },
    } as unknown as Agent
    type AssemblyHandler = (
      assembly: PromptAssembly,
      context: unknown,
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>
    let assemblyHandler: AssemblyHandler | undefined
    let replayReleased = false
    const agentCtx = {
      on: (event: string, handler: AssemblyHandler) => {
        expect(event).toBe('system-prompt/assemble')
        assemblyHandler = handler
        return () => { replayReleased = true }
      },
    } as unknown as Context
    let composedFrom: Context | undefined
    let followedText: string | undefined
    let resolveIdle: (() => void) | undefined
    const clearInbox = vi.fn()
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
    const roster = {
      composeFrom: (_child: Context, parent: Context) => { composedFrom = parent },
    }
    const ctx = {
      get: () => roster,
      sessionProjections: { stateOf: () => null },
      agents: {
        create: async (options: CreateAgentOptions) => {
          await options.setup?.(agentCtx, {
            session: Session.create(options.sessionId), ctx: agentCtx, inbox: { clear: clearInbox },
          } as unknown as Agent)
          return {
            agent: {
              followup: (message: ReturnType<typeof createUserMessage>) => {
                followedText = message.content.find((block) => block.type === 'text')?.text
              },
              whenIdle: () => idle,
            },
            dispose: async () => undefined,
          }
        },
      },
      workspaceRegistry: {
        list: () => [],
        archiveSession: async () => undefined,
      },
    } as unknown as Context

    const continuationSessionId = SessionId('session-edit-preallocated')
    await expect(createEditedContinuation(ctx, sourceAgent, cut, 'rewritten', continuationSessionId)).resolves.toEqual({
      sessionId: continuationSessionId,
    })
    expect(composedFrom).toBe(sourceCtx)
    expect(followedText).toBe('rewritten')
    expect(clearInbox).toHaveBeenCalledOnce()
    if (assemblyHandler === undefined) throw new Error('runtime-context replay listener was not registered')
    const currentAssembly: PromptAssembly = {
      sections: [],
      contexts: [{ name: 'sandbox:policy', text: 'new policy' }],
      tools: [],
      variables: {},
    }
    await expect(assemblyHandler(currentAssembly, {}, async () => currentAssembly)).resolves.toMatchObject({
      contexts: [{ name: 'sandbox:policy', text: 'old policy' }],
    })
    expect(replayReleased).toBe(false)

    resolveIdle?.()
    await idle
    await Promise.resolve()
    expect(replayReleased).toBe(true)
  })

  it('cancels the replayed original inbox before the child loop starts and submits the edit only once', async () => {
    const session = Session.create(SessionId('session-edit-durable-inbox'))
    const original = createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [original] })
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    session.append('step/start', { turn: 1, step: 1 })
    const target = session.append('user/message', original, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const before = session.snapshotEvents()
    const actions: string[] = []
    const childCtx = { on: () => () => undefined } as unknown as Context
    const ctx = {
      get: () => undefined,
      sessionProjections: { stateOf: () => null },
      agents: { create: async (options: CreateAgentOptions) => {
        expect(options.seed).toEqual(before.slice(0, 1))
        const child = {
          session: Session.create(options.sessionId, options.seed),
          inbox: { clear: () => { actions.push('cancel inherited inbox') } },
          followup: (message: ReturnType<typeof createUserMessage>) => { actions.push(JSON.stringify(message.content)) },
          whenIdle: async () => undefined,
        } as unknown as Agent
        await options.setup?.(childCtx, child)
        actions.push('start loop')
        return { agent: child, dispose: async () => undefined }
      } },
      workspaceRegistry: { list: () => [], archiveSession: async () => undefined },
    } as unknown as Context
    await createEditedContinuation(ctx, { session, options: {}, ctx: {} } as Agent,
      inspectEditCut(session, target.seq, 'edited'), 'edited')
    expect(actions).toEqual(['cancel inherited inbox', 'start loop', JSON.stringify([{ type: 'text', text: 'edited' }])])
    expect(session.snapshotEvents()).toBe(before)
  })

  it('removes a failed child from its workspace before disposing it', async () => {
    const session = Session.create(SessionId('session-test-edit-rollback'))
    const turn = addTurn(session, 1, 'first')
    const cut = inspectEditCut(session, turn.userSeq, 'rewritten')
    const childId = SessionId('session-edit-rollback-child')
    const events: string[] = []
    const workspace = {
      sessionIds: [session.id],
      attachSession: async (id: string) => { events.push(`attach:${id}`) },
      detachSession: async (id: string) => { events.push(`detach:${id}`) },
    }
    const sourceAgent = {
      session,
      ctx: {} as Context,
      options: {},
    } as unknown as Agent
    const ctx = {
      get: () => undefined,
      sessionProjections: { stateOf: () => null },
      agents: {
        create: async () => ({
          agent: {
            id: childId,
            followup: () => { events.push('followup') },
            whenIdle: async () => undefined,
          },
          dispose: async () => { events.push('dispose') },
        }),
      },
      workspaceRegistry: {
        list: () => [workspace],
        archiveSession: async () => { events.push('archive'); throw new Error('archive failed') },
      },
    } as unknown as Context

    await expect(createEditedContinuation(ctx, sourceAgent, cut, 'rewritten', childId)).rejects.toThrow('archive failed')
    expect(events).toEqual([
      `attach:${childId}`,
      'followup',
      'archive',
      `detach:${childId}`,
      'dispose',
    ])
  })
})

describe('message-edit continuation metadata', () => {
  it.each([true, false])('preserves seed ownership and the projected preset (selected: %s)', async (selected) => {
    const id = SessionId('session-edit-preset-source')
    const session = Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: '/tmp', ...(selected ? { agentPreset: 'initial' } : {}),
    })
    if (selected) {
      session.append('agent-preset/selected', { agentPreset: 'selected' })
      const first = addTurn(session, 1, 'retained')
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compacted context' }],
        source: { kind: 'plugin', plugin: 'test', form: 'instructions' },
      }), {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(first.userSeq), endSeq: SessionSeq(first.assistantSeq) },
        sourceEventSeqs: [SessionSeq(first.userSeq), SessionSeq(first.assistantSeq)],
      })
      expect(session.surface.nodes).not.toContain(first.userSeq)
    }
    const boundary = session.seq
    const target = addTurn(session, selected ? 2 : 1, 'target')
    const before = session.snapshotEvents()
    const projections = new SessionProjectionRegistry(new Context())
    const unregister = projections.register(agentPresetProjectionDefinition)
    const sourceAgent = { session, ctx: {} as Context, options: {} } as unknown as Agent
    const childId = SessionId('session-edit-preset-child')
    let child: Session | undefined
    const ctx = {
      get: () => undefined,
      sessionProjections: projections,
      agents: {
        create: async (options: CreateAgentOptions) => {
          child = Session.create(childId, options.seed, {
            version: SESSION_FORMAT_VERSION, id: childId, createdAt: 1, isSeeded: false, ...options.meta,
          }, options.inheritedEventCount)
          return { agent: { id: childId, followup: () => undefined, whenIdle: async () => undefined }, dispose: async () => undefined }
        },
      },
      workspaceRegistry: { list: () => [], archiveSession: async () => undefined },
    } as unknown as Context
    try {
      await createEditedContinuation(ctx, sourceAgent, inspectEditCut(session, target.userSeq, 'changed'), 'changed', childId)
      if (child === undefined) throw new Error('continuation was not created')
      expect(child.header).toMatchObject({ parentSession: id, cwd: '/tmp', isSeeded: true })
      expect(child.header.agentPreset).toBe(selected ? 'selected' : undefined)
      expect(child.inheritedEventCount).toBe(boundary)
      expect(child.snapshotEvents(SessionLogOffset(0), child.inheritedEventCount)).toEqual(before.slice(0, boundary))
      expect(child.inheritedEventCount).toBe(child.seq - 1)
      expect(child.ownEvents().map((event) => event.type)).toEqual(['session/end-seed'])
      expect(session.snapshotEvents()).toBe(before)
      expect(projections.stateOf(child, 'agentPreset')).toBe(selected ? 'selected' : null)
    } finally {
      unregister()
    }
  })
})

describe('message-edit input validation', () => {
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid event sequence %s', (seq) => {
    expect(() => inspectEditCut(Session.create(SessionId('session-invalid-seq')), seq, 'edited')).toThrow('消息序号无效')
  })

  it('rejects edits to an unfinished turn', () => {
    const session = Session.create(SessionId('session-unfinished-edit'))
    session.append('turn/start', { turn: 1 })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => inspectEditCut(session, message.seq, 'edited')).toThrow('尚未完成')
  })
})

describe('rc.1 session log sequence contract', () => {
  it('rejects a gapped log instead of interpreting event seqs as compacted offsets', () => {
    const session = Session.create(SessionId('session-gap-source'))
    const event = session.append('turn/start', { turn: 1 })
    expect(() => Session.create(SessionId('session-gap-child'), [
      event, { ...event, seq: SessionSeq(5) },
    ])).toThrow(/contiguous/)
  })
})
