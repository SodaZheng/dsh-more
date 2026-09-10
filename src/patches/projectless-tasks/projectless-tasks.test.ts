import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareTask } from './host/index.js'
import { createTaskStarter } from './client/create-task.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn() }))
const ID = 'task-00000000-0000-4000-8000-000000000001'
const directories: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('independent task location', () => {
  it('prepares a deterministic persistent directory without touching disk', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-more-task-'))
    directories.push(home)
    const first = prepareTask({ sessionId: ID }, home)
    expect(first).toEqual({ sessionId: ID, cwd: join(home, 'Documents', 'DSH', 'tasks', ID) })
    expect(prepareTask({ sessionId: ID }, home)).toEqual(first)
    expect(prepareTask({ sessionId: ID.replace(/1$/, '2') }, home).cwd).not.toBe(first.cwd)
    expect(await readdir(home)).toEqual([])
  })

  it.each([null, [], {}, { sessionId: '../project' }, { sessionId: '/tmp/a' }, { sessionId: 'task-x' },
    { sessionId: ID, cwd: '/tmp/injected' }, { sessionId: `${ID}/..` }, { sessionId: ID, workspaceId: 'w' }])(
    'rejects invalid location requests %j', (payload) => { expect(() => prepareTask(payload)).toThrow('标识无效') },
  )
})

describe('native task creation', () => {
  function setup() {
    vi.stubGlobal('crypto', { randomUUID: () => ID.slice(5) })
    vi.mocked(callPatchApi).mockImplementation(async (_patch, _action, payload) => prepareTask(payload, '/isolated-home'))
    const sessions = { create: vi.fn(async (options) => options.sessionId as SessionId), open: vi.fn() }
    return { sessions, starter: createTaskStarter(sessions) }
  }

  it('deduplicates clicks, supplies cwd without workspaceId, and opens only after create', async () => {
    const { sessions, starter } = setup()
    const first = starter.start()
    const second = starter.start()
    expect(second).toBe(first)
    expect(sessions.open).not.toHaveBeenCalled()
    await first
    expect(callPatchApi).toHaveBeenCalledOnce()
    expect(sessions.create).toHaveBeenCalledExactlyOnceWith({ sessionId: ID, cwd: `/isolated-home/Documents/DSH/tasks/${ID}` })
    expect(sessions.open).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it('retries uncertain creation with the same identity and location', async () => {
    const { sessions, starter } = setup()
    sessions.create.mockRejectedValueOnce(new Error('response lost'))
    await expect(starter.start()).rejects.toThrow('response lost')
    await starter.start()
    expect(sessions.create.mock.calls[0]).toEqual(sessions.create.mock.calls[1])
    expect(sessions.open).toHaveBeenCalledOnce()
  })

  it('does not create after disabling during preparation', async () => {
    const { sessions, starter } = setup()
    const operation = starter.start()
    starter.dispose()
    await operation
    expect(sessions.create).not.toHaveBeenCalled()
    await expect(starter.start()).rejects.toThrow('已关闭')
  })

  it('keeps a completed task but does not navigate after disabling during native creation', async () => {
    const { sessions, starter } = setup()
    let finish: (id: SessionId) => void = () => {}
    sessions.create.mockImplementationOnce(() => new Promise<SessionId>((resolve) => { finish = resolve }))
    const operation = starter.start()
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce())
    starter.dispose()
    finish(ID as SessionId)
    await operation
    expect(sessions.open).not.toHaveBeenCalled()
  })

  it('fails closed on a mismatched Host response', async () => {
    const { sessions, starter } = setup()
    vi.mocked(callPatchApi).mockResolvedValueOnce({ sessionId: 'other', cwd: '/tmp' })
    await expect(starter.start()).rejects.toThrow('版本不一致')
    expect(sessions.create).not.toHaveBeenCalled()
  })

  it('transfers the draft before navigation and retains identity if transfer must be retried', async () => {
    const { sessions, starter } = setup()
    const transfer = vi.fn(() => { throw new Error('image admission refused') })
    await expect(starter.start(transfer)).rejects.toThrow('image admission refused')
    expect(sessions.open).not.toHaveBeenCalled()
    await starter.start(() => { expect(sessions.open).not.toHaveBeenCalled(); return true })
    expect(sessions.create.mock.calls[0]).toEqual(sessions.create.mock.calls[1])
    expect(sessions.open).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it('does not change the current view when the handoff was superseded', async () => {
    const { sessions, starter } = setup()
    await starter.start(() => false)
    expect(sessions.open).not.toHaveBeenCalled()
  })
})
