import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { deleteSessionPermanently } from './host/session-deletion.js'
import { installLiveSessionHandleTracker } from './host/live-session-handles.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  sessionId: SessionId
  sessionDir: string
  logPath: string
  header: { id: SessionId, version: number, createdAt: number, delegationDepth: number }
}> {
  const root = await mkdtemp(join(tmpdir(), 'dshmore-session-delete-'))
  roots.push(root)
  const sessionId = SessionId('session-delete-test')
  const sessionDir = join(root, 'sessions', 'project', sessionId)
  const logPath = join(sessionDir, 'session.jsonl')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(logPath, 'test\n', 'utf8')
  return {
    root,
    sessionId,
    sessionDir,
    logPath,
    header: { id: sessionId, version: 0, createdAt: 1, delegationDepth: 0 },
  }
}

describe('permanent session deletion', () => {
  it('physically removes a cold session and keeps native archive semantics separate', async () => {
    const { root, sessionId, sessionDir, logPath, header } = await fixture()
    let detached: string | undefined
    const ctx = {
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      sessionPersistence: {
        list: async () => [header],
        locate: () => ({ kind: 'jsonl', path: logPath }),
      },
      workspaceRegistry: {
        list: () => [{
          sessionIds: [sessionId],
          detachSession: async (id: string) => { detached = id },
        }],
      },
    } as unknown as Context

    const result = await deleteSessionPermanently(ctx, sessionId)
    expect(result).toEqual({ sessionId, deletedPath: sessionDir })
    await expect(stat(sessionDir)).rejects.toThrow()
    await expect(stat(join(root, 'dsh-more-trash'))).rejects.toThrow()
    expect(detached).toBe(sessionId)
  })

  it('cancels and disposes a tracked running Agent before deleting its directory', async () => {
    const { sessionId, sessionDir, logPath, header } = await fixture()
    let agentLive = true
    let sessionLive = true
    let cancelled = false
    let idleWaited = false
    let flushed = false
    let disposed = false
    let detached = false
    const session = { id: sessionId, header } as unknown as Session
    const agent = {
      id: sessionId,
      session,
      status: 'running',
      cancel: () => { cancelled = true },
      whenIdle: async () => { idleWaited = true },
    } as unknown as Agent
    const baseHandle: AgentHandle = {
      agent,
      dispose: async () => {
        disposed = true
        agentLive = false
        sessionLive = false
      },
    }
    const agents = {
      get: () => agentLive ? agent : undefined,
      create: async () => baseHandle,
      resume: async () => baseHandle,
    }
    const ctx = {
      agents,
      sessions: {
        get: () => sessionLive ? session : undefined,
        flush: async () => { flushed = true; return true },
      },
      sessionPersistence: {
        list: async () => [header],
        locate: () => ({ kind: 'jsonl', path: logPath }),
      },
      workspaceRegistry: {
        list: () => [{
          sessionIds: [sessionId],
          detachSession: async () => { detached = true },
        }],
      },
    } as unknown as Context
    const originalCreate = agents.create
    const disposeTracker = installLiveSessionHandleTracker(ctx)
    expect(agents.create).not.toBe(originalCreate)
    await ctx.agents.create({ sessionId })

    await deleteSessionPermanently(ctx, sessionId)
    expect({ cancelled, idleWaited, flushed, disposed, detached }).toEqual({
      cancelled: true,
      idleWaited: true,
      flushed: true,
      disposed: true,
      detached: true,
    })
    await expect(stat(sessionDir)).rejects.toThrow()
    disposeTracker()
    expect(agents.create).toBe(originalCreate)
  })

  it('unloads an already-live untracked session through the guarded compatibility path', async () => {
    const { sessionId, sessionDir, logPath, header } = await fixture()
    let scopeDisposed = false
    let flushed = false
    const session = { id: sessionId, header } as unknown as Session
    const agent = {
      id: sessionId,
      session,
      status: 'idle',
      cancel: () => undefined,
      whenIdle: async () => undefined,
      scope: { dispose: async () => { scopeDisposed = true } },
    } as unknown as Agent
    const agentEntry = { id: sessionId }
    const sessionEntry = { id: sessionId }
    const agentStore = new Map([[sessionId, agentEntry]])
    const sessionStore = new Map([[sessionId, sessionEntry]])
    const agents = {
      store: agentStore,
      get: () => agentStore.has(sessionId) ? agent : undefined,
      detachEntered: () => { agentStore.delete(sessionId) },
    }
    const sessions = {
      store: sessionStore,
      get: () => sessionStore.has(sessionId) ? session : undefined,
      flush: async () => { flushed = true; return true },
      detachEntered: () => { sessionStore.delete(sessionId) },
    }
    const ctx = {
      agents,
      sessions,
      sessionPersistence: {
        list: async () => [header],
        locate: () => ({ kind: 'jsonl', path: logPath }),
      },
      workspaceRegistry: { list: () => [] },
    } as unknown as Context

    await deleteSessionPermanently(ctx, sessionId)
    expect(scopeDisposed).toBe(true)
    expect(flushed).toBe(true)
    expect(agentStore.size).toBe(0)
    expect(sessionStore.size).toBe(0)
    await expect(stat(sessionDir)).rejects.toThrow()
  })
})
