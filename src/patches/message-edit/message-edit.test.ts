import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
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
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
    const roster = {
      composeFrom: (_child: Context, parent: Context) => { composedFrom = parent },
    }
    const ctx = {
      get: () => roster,
      agents: {
        create: async (options: CreateAgentOptions) => {
          await options.setup?.(agentCtx)
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
