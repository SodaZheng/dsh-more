import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { readSettings } from '../../../platform/dsh/host/settings.js'
import { requireString } from '../../../platform/dsh/host/wire.js'
import {
  decodeHiddenWorkspaces,
  EMPTY_HIDDEN_WORKSPACES,
  HIDDEN_WORKSPACES_NAMESPACE,
  type HiddenWorkspaces,
  type WorkspaceHideMutationResult,
  type WorkspaceUnhideAllResult,
} from '../shared.js'

export const HiddenWorkspacesSchema: z<HiddenWorkspaces> = z.object({
  hidden: z.dict(z.boolean()).default({}),
})

export function readHiddenWorkspaces(ctx: Context): HiddenWorkspaces {
  return decodeHiddenWorkspaces(readSettings(ctx, HIDDEN_WORKSPACES_NAMESPACE)) ?? EMPTY_HIDDEN_WORKSPACES
}

function ensureWritableSettings(ctx: Context): void {
  if (!ctx.settings.writable) {
    throw new DshMoreError('forbidden', '当前配置为只读，无法修改工作区显示状态。', 403)
  }
  const legacy = ctx.settings as typeof ctx.settings & { get?: unknown }
  if (typeof legacy.get !== 'function' && typeof ctx.settings.describe === 'function'
    && !ctx.settings.describe().some((entry) => entry.ns === HIDDEN_WORKSPACES_NAMESPACE)) {
    throw new DshMoreError('internal', '隐藏工作区配置尚未就绪，请重启 DSH 服务并刷新页面。', 409)
  }
}

async function unsetHiddenIds(ctx: Context, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await ctx.settings.mutate(
    HIDDEN_WORKSPACES_NAMESPACE,
    ids.map((id) => ({ op: 'unset' as const, path: ['hidden', id] })),
  )
}

export async function hideWorkspace(ctx: Context, payload: unknown): Promise<WorkspaceHideMutationResult> {
  const workspaceId = requireString(payload, 'workspaceId')
  ensureWritableSettings(ctx)
  if (ctx.workspaceRegistry.get(WorkspaceId(workspaceId)) === undefined) {
    throw new DshMoreError('not-found', '目标工作区不存在。', 404)
  }
  if (readHiddenWorkspaces(ctx).hidden[workspaceId] !== true) {
    await ctx.settings.mutate(HIDDEN_WORKSPACES_NAMESPACE, [
      { op: 'set', path: ['hidden', workspaceId], value: true },
    ])
  }
  return { workspaceId, hidden: true }
}

export async function unhideWorkspace(ctx: Context, payload: unknown): Promise<WorkspaceHideMutationResult> {
  const workspaceId = requireString(payload, 'workspaceId')
  ensureWritableSettings(ctx)
  if (readHiddenWorkspaces(ctx).hidden[workspaceId] === true) {
    await unsetHiddenIds(ctx, [workspaceId])
  }
  return { workspaceId, hidden: false }
}

export async function unhideAllWorkspaces(ctx: Context): Promise<WorkspaceUnhideAllResult> {
  ensureWritableSettings(ctx)
  const restoredIds = Object.keys(readHiddenWorkspaces(ctx).hidden)
  await unsetHiddenIds(ctx, restoredIds)
  return { restoredIds }
}

interface MutableWorkspaceRegistry {
  resolveByPath(path: string): Promise<Workspace | undefined>
  create(path: string, title?: string): Promise<Workspace>
  delete(id: WorkspaceId): Promise<boolean>
}

function wrapRegistryMethod<K extends keyof MutableWorkspaceRegistry>(
  registry: MutableWorkspaceRegistry,
  key: K,
  createWrapper: (original: MutableWorkspaceRegistry[K]) => MutableWorkspaceRegistry[K],
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(registry, key)
  const original = registry[key]
  const wrapped = createWrapper(original)
  registry[key] = wrapped
  return () => {
    if (Object.getOwnPropertyDescriptor(registry, key)?.value !== wrapped) return
    if (descriptor === undefined) Reflect.deleteProperty(registry, key)
    else Object.defineProperty(registry, key, descriptor)
  }
}

/**
 * Re-adding a directory resolves or reuses the preserved Workspace entity.
 * Clear its hidden marker so its conversations, title, and order return immediately.
 */
export function installWorkspaceRegistryHooks(ctx: Context): () => void {
  const registry = ctx.workspaceRegistry as unknown as MutableWorkspaceRegistry
  let active = true

  const clearHiddenBestEffort = async (workspaceId: WorkspaceId): Promise<void> => {
    if (!active || readHiddenWorkspaces(ctx).hidden[workspaceId] !== true || !ctx.settings.writable) return
    try {
      await unsetHiddenIds(ctx, [workspaceId])
    } catch (error) {
      const logger = (ctx as { logger?: { warn?(message: string): void } }).logger
      logger?.warn?.(`workspace-hide: failed to unhide workspace '${workspaceId}': ${String(error)}`)
    }
  }

  const unhookResolve = wrapRegistryMethod(registry, 'resolveByPath', (original) => async function (
    this: MutableWorkspaceRegistry,
    path: string,
  ) {
    const found = await original.call(this, path)
    if (found !== undefined) await clearHiddenBestEffort(found.id)
    return found
  })

  const unhookCreate = wrapRegistryMethod(registry, 'create', (original) => async function (
    this: MutableWorkspaceRegistry,
    path: string,
    title?: string,
  ) {
    const created = await original.call(this, path, title)
    await clearHiddenBestEffort(created.id)
    return created
  })

  const unhookDelete = wrapRegistryMethod(registry, 'delete', (original) => async function (
    this: MutableWorkspaceRegistry,
    id: WorkspaceId,
  ) {
    const deleted = await original.call(this, id)
    if (deleted) await clearHiddenBestEffort(id)
    return deleted
  })

  return () => {
    active = false
    unhookDelete()
    unhookCreate()
    unhookResolve()
  }
}
