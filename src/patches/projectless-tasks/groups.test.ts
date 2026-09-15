import { describe, expect, it, vi } from 'vitest'
import { moveSessionGroup } from './host/groups.js'
import { SESSION_GROUPS_NAMESPACE } from './groups.js'

function harness(modern = true) {
  const header = { id: 'source', cwd: '/original/task', origin: undefined as string | undefined }
  const assignments: Record<string, string> = {}
  const workspace = { id: 'target', path: '/project', sessionIds: [] as string[] }
  const ctx = {
    settings: {
      writable: true,
      get: () => ({ assignments }),
      mutate: vi.fn(async (_ns, ops) => { for (const op of ops) {
        if (op.op === 'unset') delete assignments[op.path[1]]
        else assignments[op.path[1]] = op.value
      } }),
    },
    sessions: { get: vi.fn(() => undefined) },
    sessionPersistence: { list: vi.fn(async () => modern ? [{ header, revision: 'r1' }] : [header]) },
    workspaceRegistry: { get: vi.fn((id) => id === 'target' ? workspace : undefined), list: () => [workspace] },
  }
  return { ctx, header, assignments, workspace, move: (workspaceId: string | null = 'target') => moveSessionGroup(ctx as never, { sessionId: 'source', workspaceId }) }
}

describe('durable session grouping', () => {
  it.each([false, true])('moves cold sessions with modern snapshots=%s without rewriting their headers', async (modern) => {
    const app = harness(modern)
    await expect(app.move()).resolves.toEqual({ sessionId: 'source', workspaceId: 'target' })
    expect(app.ctx.settings.mutate).toHaveBeenCalledExactlyOnceWith(SESSION_GROUPS_NAMESPACE, [{ op: 'set', path: ['assignments', 'source'], value: 'target' }])
    expect(app.assignments).toEqual({ source: 'target' })
    expect(app.header.cwd).toBe('/original/task')
    expect(app.workspace.sessionIds).toEqual([])
    await expect(app.move()).resolves.toEqual({ sessionId: 'source', workspaceId: 'target' })
    expect(app.ctx.settings.mutate).toHaveBeenCalledOnce()
    await expect(app.move(null)).resolves.toEqual({ sessionId: 'source', workspaceId: null })
    expect(app.assignments).toEqual({})
  })

  it('rejects missing targets and sessions, readonly settings, and native ownership without writing', async () => {
    const app = harness()
    await expect(app.move('missing')).rejects.toThrow('已不存在')
    app.ctx.settings.writable = false
    await expect(app.move()).rejects.toThrow('只读')
    app.ctx.settings.writable = true
    app.workspace.sessionIds.push('source')
    await expect(app.move()).rejects.toThrow('原生工作区')
    app.workspace.sessionIds.length = 0
    app.header.origin = 'subagent'
    await expect(app.move()).rejects.toThrow('主会话')
    app.ctx.sessionPersistence.list.mockResolvedValue([])
    await expect(app.move()).rejects.toThrow('已不存在')
    expect(app.ctx.settings.mutate).not.toHaveBeenCalled()
  })

  it('surfaces persistence failures with the original grouping intact', async () => {
    const app = harness()
    app.ctx.settings.mutate.mockRejectedValueOnce(new Error('disk full'))
    await expect(app.move()).rejects.toThrow('disk full')
    expect(app.assignments).toEqual({})
  })
})
