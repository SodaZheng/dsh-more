import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

// Exercise Windows path semantics even when CI runs on macOS or Linux.
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>()
  return { ...path, ...path.win32 }
})
vi.mock('node:fs/promises', () => ({ stat: vi.fn(), rm: vi.fn() }))

import { rm, stat } from 'node:fs/promises'
import { prepareTask } from '../../src/patches/projectless-tasks/host/index.js'
import { deleteSessionPermanently } from '../../src/patches/session-delete/host/session-deletion.js'

const id = 'task-00000000-0000-4000-8000-000000000001'
const windows = (path: string): string => path.replaceAll('/', '\\')
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>)
})

function deletionContext(path: string) {
  const header = { id }
  const get = vi.fn(() => undefined)
  return { get, ctx: {
    sessions: { get }, agents: { get },
    sessionPersistence: { list: async () => [{ header }], locate: () => ({ kind: 'jsonl', path }) },
    workspaceRegistry: { list: () => [] },
  } as unknown as Context }
}

describe('Windows host paths', () => {
  it.each(['C:/Users/测试 User', '//server/homes/测试 User'])('prepares task directories under %s without disk writes', (path) => {
    const home = windows(path)
    expect(prepareTask({ sessionId: id }, home)).toEqual({
      sessionId: id, cwd: windows(path + '/Documents/DSH/tasks/' + id),
    })
    expect(stat).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
  })

  it.each([
    'C:/Users/测试 User/sessions/one',
    '//server/share/sessions/one',
    '//?/C:/Users/测试 User/sessions/one',
  ])('deletes only the persistence directory at %s', async (path) => {
    const directory = windows(path)
    const { ctx } = deletionContext(windows(path + '/session.v3.jsonl.zstd'))
    await expect(deleteSessionPermanently(ctx, id)).resolves.toEqual({ sessionId: id })
    expect(stat).toHaveBeenCalledExactlyOnceWith(directory)
    expect(rm).toHaveBeenCalledExactlyOnceWith(directory, { recursive: true, force: false })
  })

  it.each([
    windows('C:/session.jsonl'),
    windows('//server/share/session.jsonl'),
    windows('C:relative/session.jsonl'),
    'file:///C:/sessions/one/session.jsonl',
    windows('C:/sessions/one/unknown.jsonl'),
  ])('rejects unsafe or unsupported persistence locations: %s', async (path) => {
    const { ctx, get } = deletionContext(path)
    await expect(deleteSessionPermanently(ctx, id)).rejects.toThrow()
    expect(get).toHaveBeenCalledTimes(1) // Header lookup only; never unload.
    expect(stat).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
  })
})
