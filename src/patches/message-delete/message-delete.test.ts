import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { selectMessageDeletion } from './host/message-selection.js'
import { buildCleanSeed, createDeletedContinuation } from './host/rebuild.js'
import { addTurn, appendRuntimeContext } from '../../../test/helpers/session.js'

describe('message-delete patch', () => {
  it('selects one ordinary message without widening a balanced surface', () => {
    const session = Session.create(SessionId('session-test-message'))
    const first = addTurn(session, 1, 'first')
    expect(selectMessageDeletion(session, first.userSeq)).toMatchObject({ shadowedSeqs: [first.userSeq] })
    expect(selectMessageDeletion(session, first.assistantSeq)).toMatchObject({ shadowedSeqs: [first.assistantSeq] })
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
    expect(JSON.stringify(clean.events)).not.toContain('middle')
  })

  it('rebuilds a clean session without marker or invalid replacement messages', () => {
    const session = Session.create(SessionId('session-test-clean-rebuild'))
    const first = addTurn(session, 1, 'first')
    const second = addTurn(session, 2, 'second')
    session.append('compaction/prune', {
      shadowedRange: { start: first.assistantSeq, end: first.assistantSeq },
      shadowedSeqs: [first.assistantSeq],
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
      surfaceOp: { op: 'replace', start: first.assistantSeq, end: first.assistantSeq },
      sourceEventSeqs: [first.assistantSeq],
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
    expect(JSON.stringify(clean.events)).not.toContain('DSH More')
    expect(JSON.stringify(clean.events)).not.toContain('answer 1')
    expect(JSON.stringify(clean.events)).not.toContain('answer 2')
  })

  it('preserves balanced tool call/result history while deleting a later assistant message', () => {
    const session = Session.create(SessionId('session-test-tool-rebuild'))
    const callId = CallId('call-1')
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
