import { rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { getLiveSessionHandle } from './live-session-handles.js'

interface InternalScope {
  dispose(): Promise<void>
}

interface InternalAgent extends Agent {
  scope?: InternalScope
}

interface InternalRegistryEntry {
  readonly id: SessionId
}

interface InternalRegistry {
  store?: Map<SessionId, InternalRegistryEntry>
  detachEntered?(entry: InternalRegistryEntry): void
}

function detachInternal(registry: unknown, sessionId: SessionId, label: string): void {
  const internal = registry as InternalRegistry
  const entry = internal.store?.get(sessionId)
  if (entry === undefined) return
  if (typeof internal.detachEntered !== 'function') {
    throw new DshMoreError('internal', `当前 DSH 版本无法卸载已加载的${label}。`, 500)
  }
  internal.detachEntered(entry)
}

async function unloadLiveSession(ctx: Context, sessionId: SessionId): Promise<void> {
  const agent = ctx.agents.get(sessionId)
  const session = ctx.sessions.get(sessionId)
  if (agent !== undefined) {
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()
  }
  if (session !== undefined) await ctx.sessions.flush(session)

  const handle = getLiveSessionHandle(ctx, sessionId)
  if (handle !== undefined) {
    await handle.dispose()
  } else {
    if (agent !== undefined) {
      const scope = (agent as InternalAgent).scope
      if (scope === undefined || typeof scope.dispose !== 'function') {
        throw new DshMoreError('internal', '当前 DSH 版本无法卸载已加载的 Agent。', 500)
      }
      await scope.dispose()
      detachInternal(ctx.agents, sessionId, ' Agent')
    }
    if (session !== undefined) detachInternal(ctx.sessions, sessionId, '会话')
  }

  if (ctx.agents.get(sessionId) !== undefined || ctx.sessions.get(sessionId) !== undefined) {
    throw new DshMoreError('internal', '会话停止后仍处于加载状态，未执行磁盘删除。', 500)
  }
}

function sessionDirectoryFromLocation(locationPath: string): string {
  if (!isAbsolute(locationPath)) {
    throw new DshMoreError('internal', '当前持久化后端没有返回绝对会话路径。', 409)
  }
  const artifact = basename(locationPath)
  if (artifact !== 'session.jsonl' && artifact !== 'session.jsonl.zstd') {
    throw new DshMoreError('internal', '持久化后端返回了未知的会话文件布局。', 500)
  }
  const sessionDir = dirname(locationPath)
  if (sessionDir === dirname(sessionDir)) {
    throw new DshMoreError('internal', '持久化后端返回了不安全的会话路径。', 500)
  }
  return sessionDir
}

/** Stop/unload a Session, then recursively remove its exact persistence directory. */
export async function deleteSessionPermanently(ctx: Context, rawSessionId: string): Promise<{
  sessionId: string
}> {
  const sessionId = SessionId(rawSessionId)
  const live = ctx.sessions.get(sessionId) as Session | undefined
  const header = (await ctx.sessionPersistence.list()).find((candidate) => candidate.id === sessionId) ?? live?.header
  if (header === undefined) throw new DshMoreError('not-found', '会话记录不存在。', 404)

  const location = ctx.sessionPersistence.locate(header)
  if (location === undefined) {
    throw new DshMoreError('internal', '当前持久化后端不支持逐会话物理删除。', 409)
  }
  if (location.kind !== 'jsonl') {
    throw new DshMoreError('internal', `持久化后端 ${location.kind} 不支持安全的逐目录删除。`, 409)
  }
  const sessionDir = sessionDirectoryFromLocation(location.path)
  await unloadLiveSession(ctx, sessionId)

  const info = await stat(sessionDir).catch(() => undefined)
  if (info !== undefined) {
    if (!info.isDirectory()) throw new DshMoreError('internal', '会话持久化路径不是目录。', 500)
    await rm(sessionDir, { recursive: true, force: false })
  }

  const workspaces = ctx.workspaceRegistry.list().filter((candidate) => candidate.sessionIds.includes(sessionId))
  await Promise.all(workspaces.map(async (workspace) => workspace.detachSession(sessionId)))
  return { sessionId }
}
