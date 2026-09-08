import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { selectMessageDeletion } from './host/message-selection.js'
import { buildCleanSeed, createDeletedContinuation } from './host/rebuild.js'
import { addTurn, appendRuntimeContext } from '../../../test/helpers/session.js'

describe('message-delete patch', () => {
  it('selects one ordinary message without widening a balanced surface', () => {
    const session = Session.create(SessionId('session-test-message'))
    const first = addTurn(session, 1, 'first')
    expect(selectMessageDeletion(session, first.userSeq)).toMatchObject({ shadowedSeqs: [first.userSeq] })
    expect(selectMessageDeletion(session, first.assistantSeq)).toMatchObject({ shadowedSeqs: [SessionSeq(first.assistantSeq)] })
  })

  it('keeps the retained runtime context through the first user turn after deletion', async () => {
    const session = Session.create(SessionId('session-test-delete-continuation'))
    addTurn(session, 1, 'first')
    appendRuntimeContext(session)
    const second = addTurn(session, 2, 'second')
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
    type StatusHandler = (payload: { status: 'idle' | 'running' }) => void
    let assemblyHandler: AssemblyHandler | undefined
    let statusHandler: StatusHandler | undefined
    let contextReplayReleased = false
    let statusWatchReleased = false
    const agentCtx = {
      on: (event: string, handler: AssemblyHandler | StatusHandler) => {
        if (event === 'system-prompt/assemble') {
          assemblyHandler = handler as AssemblyHandler
          return () => { contextReplayReleased = true }
        }
        if (event === 'agent/status') {
          statusHandler = handler as StatusHandler
          return () => { statusWatchReleased = true }
        }
        throw new Error(`unexpected event ${event}`)
      },
    } as unknown as Context
    let composedFrom: Context | undefined
    const roster = { composeFrom: (_child: Context, parent: Context) => { composedFrom = parent } }
    const ctx = {
      get: () => roster,
      sessionProjections: { stateOf: () => null },
      agents: {
        create: async (options: CreateAgentOptions) => {
          await options.setup?.(agentCtx)
          return { agent: {}, dispose: async () => undefined }
        },
      },
      workspaceRegistry: { list: () => [], archiveSession: async () => undefined },
    } as unknown as Context

    const continuationSessionId = SessionId('session-delete-preallocated')
    await expect(createDeletedContinuation(
      ctx,
      sourceAgent,
      selectMessageDeletion(session, second.assistantSeq),
      continuationSessionId,
    )).resolves.toEqual({ sessionId: continuationSessionId })
    expect(composedFrom).toBe(sourceCtx)
    if (assemblyHandler === undefined || statusHandler === undefined) throw new Error('continuation listeners were not registered')
    const currentAssembly: PromptAssembly = {
      sections: [],
      contexts: [{ name: 'sandbox:policy', text: 'new policy' }],
      tools: [],
      variables: {},
    }
    await expect(assemblyHandler(currentAssembly, {}, async () => currentAssembly)).resolves.toMatchObject({
      contexts: [{ name: 'sandbox:policy', text: 'old policy' }],
    })
    statusHandler({ status: 'running' })
    expect(contextReplayReleased).toBe(false)
    statusHandler({ status: 'idle' })
    expect(contextReplayReleased).toBe(true)
    expect(statusWatchReleased).toBe(true)
  })

  it('removes a failed child from its workspace before disposing it', async () => {
    const session = Session.create(SessionId('session-test-delete-rollback'))
    const turn = addTurn(session, 1, 'first')
    const sourceAgent = {
      session,
      ctx: {} as Context,
      options: {},
    } as unknown as Agent
    const childId = SessionId('session-delete-rollback-child')
    const events: string[] = []
    const workspace = {
      sessionIds: [session.id],
      attachSession: async (id: string) => { events.push(`attach:${id}`) },
      detachSession: async (id: string) => { events.push(`detach:${id}`) },
    }
    const ctx = {
      get: () => undefined,
      sessionProjections: { stateOf: () => null },
      agents: {
        create: async () => ({
          agent: { id: childId },
          dispose: async () => { events.push('dispose') },
        }),
      },
      workspaceRegistry: {
        list: () => [workspace],
        archiveSession: async () => { events.push('archive'); throw new Error('archive failed') },
      },
    } as unknown as Context

    await expect(createDeletedContinuation(
      ctx,
      sourceAgent,
      selectMessageDeletion(session, turn.assistantSeq),
      childId,
    )).rejects.toThrow('archive failed')
    expect(events).toEqual([
      `attach:${childId}`,
      'archive',
      `detach:${childId}`,
      'dispose',
    ])
  })

  it('deletes exactly one middle user message while preserving all other history', () => {
    const session = Session.create(SessionId('session-test-delete-middle'))
    addTurn(session, 1, 'first')
    const middle = addTurn(session, 2, 'middle')
    addTurn(session, 3, 'third')
    const clean = Session.create(
      SessionId('session-test-delete-middle-child'),
      buildCleanSeed(session, selectMessageDeletion(session, middle.userSeq)),
    )
    expect(clean.deriveMessages().flatMap((message) => message.content.map((block) => block.type === 'text' ? block.text : ''))).toEqual([
      'first',
      'answer 1',
      'answer 2',
      'third',
      'answer 3',
    ])
    expect(JSON.stringify(clean.snapshotEvents())).not.toContain('middle')
  })

  it('rebuilds a clean session without marker or invalid replacement messages', () => {
    const session = Session.create(SessionId('session-test-clean-rebuild'))
    const first = addTurn(session, 1, 'first')
    const second = addTurn(session, 2, 'second')
    session.append('compaction/prune', {
      shadowedRange: { start: SessionSeq(first.assistantSeq), end: SessionSeq(first.assistantSeq) },
      shadowedSeqs: [SessionSeq(first.assistantSeq)],
      shadowedTokenCount: 10,
    })
    const marker = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[DSH More] 用户删除了一条历史消息。' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-more',
        form: 'notice',
        summary: '一条历史消息已删除',
        operation: 'delete-message',
        targetSeq: first.assistantSeq,
        deletedSeqs: [first.assistantSeq],
      },
    }), {
      surfaceOp: { op: 'replace', start: SessionSeq(first.assistantSeq), end: SessionSeq(first.assistantSeq) },
      sourceEventSeqs: [SessionSeq(first.assistantSeq)],
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: {
          provider: 'test',
          model: 'test',
          replayState: {
            dshMoreMessageDelete: {
              operation: 'delete-message',
              targetSeq: first.assistantSeq,
              deletedSeqs: [first.assistantSeq, marker.seq],
            },
          },
        },
      }),
    }, {
      surfaceOp: { op: 'replace', start: marker.seq, end: marker.seq },
      sourceEventSeqs: [marker.seq],
    })
    const clean = Session.create(
      SessionId('session-test-clean-child'),
      buildCleanSeed(session, selectMessageDeletion(session, second.assistantSeq)),
    )
    expect(clean.deriveMessages().flatMap((message) => message.content.map((block) => block.type === 'text' ? block.text : ''))).toEqual([
      'first',
      'second',
    ])
    expect(JSON.stringify(clean.snapshotEvents())).not.toContain('DSH More')
    expect(JSON.stringify(clean.snapshotEvents())).not.toContain('answer 1')
    expect(JSON.stringify(clean.snapshotEvents())).not.toContain('answer 2')
  })

  it('preserves balanced tool call/result history while deleting a later assistant message', () => {
    const session = Session.create(SessionId('session-test-tool-rebuild'))
    const callId = ToolCallId('call-1')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'use tool' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'demo', arguments: '{}' }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'demo', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    const final = session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'final answer' }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const clean = Session.create(SessionId('session-test-tool-child'), buildCleanSeed(session, selectMessageDeletion(session, final.seq)))
    expect(clean.deriveMessages().map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'use tool' }],
      [{ type: 'tool-call', id: callId, name: 'demo', arguments: '{}' }],
      [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'result' }], isError: false }],
    ])
  })
})

describe('message-delete rc.1 continuation metadata', () => {
  it.each([true, false])('preserves seed ownership and the projected preset (selected: %s)', async (selected) => {
    const id = SessionId('session-delete-preset-source')
    const session = Session.create(id, undefined, {
      version: 0, id, createdAt: 0, isSeeded: false, cwd: '/tmp', ...(selected ? { agentPreset: 'initial' } : {}),
    })
    if (selected) {
      session.append('agent-preset/selected', { agentPreset: 'selected' })
      addTurn(session, 1, 'retained')
    }
    const target = addTurn(session, selected ? 2 : 1, 'target')
    const before = session.snapshotEvents()
    const projections = new SessionProjectionRegistry(new Context())
    const unregister = projections.register(agentPresetProjectionDefinition)
    const sourceAgent = { session, ctx: {} as Context, options: {} } as unknown as Agent
    const childId = SessionId('session-delete-preset-child')
    let child: Session | undefined
    const ctx = {
      get: () => undefined,
      sessionProjections: projections,
      agents: {
        create: async (options: CreateAgentOptions) => {
          child = Session.create(childId, options.seed, {
            version: 0, id: childId, createdAt: 1, isSeeded: false, ...options.meta,
          }, options.inheritedEventCount)
          return { agent: { id: childId, followup: () => undefined, whenIdle: async () => undefined }, dispose: async () => undefined }
        },
      },
      workspaceRegistry: { list: () => [], archiveSession: async () => undefined },
    } as unknown as Context
    try {
      await createDeletedContinuation(ctx, sourceAgent, selectMessageDeletion(session, target.assistantSeq), childId)
      if (child === undefined) throw new Error('continuation was not created')
      expect(child.header).toMatchObject({ parentSession: id, cwd: '/tmp', isSeeded: false })
      expect(child.header.agentPreset).toBe(selected ? 'selected' : undefined)
      expect(child.inheritedEventCount).toBe(0)
      expect(child.ownEvents()).toEqual(child.snapshotEvents())
      expect(child.deriveMessages().flatMap((message) => message.content)).not.toContainEqual({ type: 'text', text: selected ? 'answer 2' : 'answer 1' })
      expect(session.snapshotEvents()).toBe(before)
      expect(projections.stateOf(child, 'agentPreset')).toBe(selected ? 'selected' : null)
    } finally {
      unregister()
    }
  })
})

describe('message-delete tool selection', () => {
  it('deletes a tool-calling assistant and all paired results while retaining later turns', () => {
    const session = Session.create(SessionId('session-paired-delete'))
    const ids = [ToolCallId('call-a'), ToolCallId('call-b')]
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const assistant = session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: ids.map((id) => ({ type: 'tool-call', id, name: 'demo', arguments: '{}' })),
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    const results = ids.map((callId) => {
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'demo', arguments: '{}' })
      return session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }),
      }, { surfaceOp: 'append' })
    })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    addTurn(session, 2, 'retained')
    const selection = selectMessageDeletion(session, assistant.seq)
    expect(selection.shadowedSeqs).toEqual([assistant.seq, ...results.map((event) => event.seq)])
    const clean = Session.create(SessionId('session-paired-delete-child'), buildCleanSeed(session, selection))
    expect(clean.deriveMessages().flatMap((message) => message.content)).toEqual([
      { type: 'text', text: 'retained' }, { type: 'text', text: 'answer 2' },
    ])
    expect(clean.snapshotEvents().some((event) => event.type === 'tool/call' || event.type === 'tool/result')).toBe(false)
  })
})
