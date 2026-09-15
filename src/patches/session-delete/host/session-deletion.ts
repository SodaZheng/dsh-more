import { rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
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
  const handle = getLiveSessionHandle(ctx, sessionId)
  // 0.1.5 releases persistence ownership in the Agent handle's teardown.
  // Detaching the registries alone would leave its writer and file lock alive.
  const ownsWriter = 'open' in ctx.sessionPersistence && typeof ctx.sessionPersistence.open === 'function'
  if (session !== undefined && ownsWriter && handle === undefined) {
    throw new DshMoreError('session-not-live', '无法安全卸载这条已加载的会话，请重启 DSH 后再删除。', 409)
  }
  if (agent !== undefined) {
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()
  }
  if (session !== undefined) await ctx.sessions.flush(session)

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
  const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/.exec(artifact)
  if (match === null || match[1] !== undefined && !Number.isSafeInteger(Number(match[1]))) {
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
  // 0.1.2 returns headers; 0.1.5 returns { header, revision } snapshots.
  const stored: readonly (SessionHeader | { header: SessionHeader })[] = await ctx.sessionPersistence.list()
  const header = stored.map((candidate) => 'header' in candidate ? candidate.header : candidate)
    .find((candidate) => candidate.id === sessionId) ?? live?.header
  if (header === undefined) throw new DshMoreError('not-found', '会话记录不存在。', 404)

  // JSONL 0.1.5 retains locate as a private diagnostics hook, not a service API.
  // Probe this optional backend capability and validate its result before disk access.
  const persistence = ctx.sessionPersistence
  const location: unknown = 'locate' in persistence && typeof persistence.locate === 'function'
    ? persistence.locate(header) : undefined
  if (location === undefined) {
    throw new DshMoreError('internal', '当前持久化后端不支持逐会话物理删除。', 409)
  }
  if (typeof location !== 'object' || location === null
    || !('kind' in location) || typeof location.kind !== 'string'
    || !('path' in location) || typeof location.path !== 'string') {
    throw new DshMoreError('internal', '持久化后端返回了无效的会话位置。', 500)
  }
  if (location.kind !== 'jsonl') {
    throw new DshMoreError('internal', `持久化后端 ${location.kind} 不支持安全的逐目录删除。`, 409)
  }
  const sessionDir = sessionDirectoryFromLocation(location.path)
  await unloadLiveSession(ctx, sessionId)

  const info = await stat(sessionDir).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info !== undefined) {
    if (!info.isDirectory()) throw new DshMoreError('internal', '会话持久化路径不是目录。', 500)
    await rm(sessionDir, { recursive: true, force: false })
  }

  const workspaces = ctx.workspaceRegistry.list().filter((candidate) => candidate.sessionIds.includes(sessionId))
  await Promise.all(workspaces.map(async (workspace) => workspace.detachSession(sessionId)))
  return { sessionId }
}
