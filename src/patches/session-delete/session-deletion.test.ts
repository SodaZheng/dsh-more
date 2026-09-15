import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { DshMoreError } from '../../platform/dsh/host/error.js'
import { deleteSessionPermanently } from './host/session-deletion.js'
import { installLiveSessionHandleTracker } from './host/live-session-handles.js'
import { addTurn } from '../../../test/helpers/session.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(artifact = 'session.jsonl'): Promise<{
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
  const logPath = join(sessionDir, artifact)
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
  it.each(['none', 'zstd'] as const)('deletes a cold session using the native JSONL backend (%s)', async (compression) => {
    const root = await mkdtemp(join(tmpdir(), 'dshmore-native-delete-'))
    roots.push(root)
    const owner = new Context()
    const backend = await owner.plugin(JsonlSessionPersistence, { root, compression })
    const persistence = owner.sessionPersistence
    const session = Session.create(SessionId('native-delete-session'))
    const neighbor = Session.create(SessionId('native-keep-session'))
    try {
      for (const item of [session, neighbor]) {
        const writer = await persistence.create(item.header)
        try {
          addTurn(item, 1, 'persist this session')
          await writer.append(item.snapshotEvents())
          await writer.flush()
        } finally {
          await writer.close()
        }
      }
      expect((await persistence.list()).map((item) => item.header.id)).toContain(session.id)
      const ctx = {
        sessions: { get: () => undefined },
        agents: { get: () => undefined },
        sessionPersistence: persistence,
        workspaceRegistry: { list: () => [] },
      } as unknown as Context
      await expect(deleteSessionPermanently(ctx, session.id)).resolves.toEqual({ sessionId: session.id })
      await expect(persistence.stat(session.id)).resolves.toBeUndefined()
      expect((await persistence.list()).map((item) => item.header.id)).toEqual([neighbor.id])
    } finally {
      await backend.dispose()
    }
  })

  it.each([null, {}, { kind: 'jsonl', path: 42 }])('rejects a malformed backend location before unloading', async (location) => {
    const { sessionId, sessionDir, header } = await fixture()
    const ctx = {
      sessions: { get: () => ({ header }) },
      sessionPersistence: { list: async () => [{ header }], locate: () => location },
    } as unknown as Context
    await expect(deleteSessionPermanently(ctx, sessionId)).rejects.toMatchObject({ status: 500 })
    await expect(stat(sessionDir)).resolves.toMatchObject({})
  })

  it.each([
    { snapshot: false, artifact: 'session.jsonl' },
    { snapshot: true, artifact: 'session.jsonl' },
    { snapshot: true, artifact: 'session.v3.jsonl' },
    { snapshot: true, artifact: 'session.v3.jsonl.zstd' },
  ])('removes a cold session with persistence format $snapshot / $artifact', async ({ snapshot, artifact }) => {
    const { root, sessionId, sessionDir, logPath, header } = await fixture(artifact)
    let detached: string | undefined
    const ctx = {
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      sessionPersistence: {
        list: async () => [snapshot ? { header, revision: 'revision-1' } : header],
        locate: (candidate: unknown) => {
          expect(candidate).toEqual(header)
          return { kind: 'jsonl', path: logPath }
        },
      },
      workspaceRegistry: {
        list: () => [{
          sessionIds: [sessionId],
          detachSession: async (id: string) => { detached = id },
        }],
      },
    } as unknown as Context

    const result = await deleteSessionPermanently(ctx, sessionId)
    expect(result).toEqual({ sessionId })
    await expect(stat(sessionDir)).rejects.toThrow()
    await expect(stat(join(root, 'dsh-more-trash'))).rejects.toThrow()
    expect(detached).toBe(sessionId)
  })

  it.each(['other.jsonl', 'session.v0.jsonl', 'session.v03.jsonl', 'session.v3.jsonl.tmp', 'session.v9007199254740992.jsonl'])('refuses unknown artifact %s without deleting its directory', async (artifact) => {
    const { sessionId, sessionDir, header } = await fixture()
    const unexpectedPath = join(sessionDir, artifact)
    await writeFile(unexpectedPath, 'test\n', 'utf8')
    const ctx = {
      sessions: { get: () => undefined },
      agents: { get: () => undefined },
      sessionPersistence: {
        list: async () => [header],
        locate: () => ({ kind: 'jsonl', path: unexpectedPath }),
      },
      workspaceRegistry: { list: () => [] },
    } as unknown as Context

    await expect(deleteSessionPermanently(ctx, sessionId)).rejects.toThrowError(
      expect.objectContaining<Partial<DshMoreError>>({ code: 'internal', status: 500 }),
    )
    await expect(stat(sessionDir)).resolves.toMatchObject({})
  })

  it('refuses a backend without a per-session location before stopping the agent', async () => {
    const { sessionId, sessionDir, header } = await fixture()
    const ctx = {
      sessions: { get: () => ({ header }) },
      sessionPersistence: { list: async () => [{ header, revision: 'current' }] },
    } as unknown as Context
    await expect(deleteSessionPermanently(ctx, sessionId)).rejects.toMatchObject({ status: 409 })
    await expect(stat(sessionDir)).resolves.toMatchObject({})
  })

  it('preserves an untracked modern writer instead of detaching it with its ownership still open', async () => {
    const { sessionId, sessionDir, logPath, header } = await fixture('session.v3.jsonl')
    const ctx = {
      sessions: { get: () => ({ header }) },
      agents: { get: () => ({ cancel: () => { throw new Error('must not cancel') } }) },
      sessionPersistence: {
        list: async () => [{ header, revision: 'current' }],
        locate: () => ({ kind: 'jsonl', path: logPath }),
        open: async () => { throw new Error('must not acquire the active writer') },
      },
    } as unknown as Context
    await expect(deleteSessionPermanently(ctx, sessionId)).rejects.toMatchObject({ status: 409, code: 'session-not-live' })
    await expect(stat(sessionDir)).resolves.toMatchObject({})
  })

  it.each([false, true])('cancels and disposes a tracked Agent (handle persistence: %s)', async (handlePersistence) => {
    const { sessionId, sessionDir, logPath, header } = await fixture(handlePersistence ? 'session.v3.jsonl.zstd' : 'session.jsonl')
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
        list: async () => [handlePersistence ? { header, revision: 'current' } : header],
        locate: () => ({ kind: 'jsonl', path: logPath }),
        ...handlePersistence ? { open: async () => { throw new Error('must not reopen tracked writer') } } : {},
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
