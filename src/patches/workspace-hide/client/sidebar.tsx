import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import { clientSessions, currentSessionId } from '../../../platform/dsh/client/runtime.js'
import { openSessionWithoutGap } from '../../../platform/dsh/client/session-sync.js'
import type { SettingsScope } from '../../../platform/dsh/client/settings.js'
import { styles } from '../../../platform/dsh/client/styles.js'
import { EMPTY_GROUPS, type SessionGroups } from '../../projectless-tasks/groups.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../../projectless-tasks/shared.js'
import {
  WORKSPACE_HIDE_PATCH_ID,
  type WorkspaceHideMutationResult,
  type WorkspaceUnhideAllResult,
} from '../shared.js'
import { installWorkspaceHideMenus, type WorkspaceHideMenuController } from './menu.js'
import {
  adjacentVisibleSessionOutsideHidden,
  collectHiddenSessionIds,
  effectiveHiddenWorkspaceIds,
  projectVisibleSessions,
  projectVisibleWorkspaces,
} from './projection.js'
import type { HiddenWorkspaceController } from './store.js'

const SIDEBAR_SLOT = 'sidebar.workspaces' as 'sidebar'

type SidebarActions = {
  retainAccountKeys?(keys: readonly string[]): void
  setGroupExpanded?(key: string, expanded: boolean): void
}

type SidebarProps = PropsRuntime<'sidebar'> & {
  actions?: SidebarActions
  createWorkspace?(input: { path: string }): Promise<WorkspaceView>
}

interface Lifetime {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
}

const ALWAYS_LIVE: Lifetime = { subscribe: () => () => {}, getSnapshot: () => true }

interface GroupsScopeLike {
  subscribe(listener: () => void): () => void
  getSnapshot(): { value?: SessionGroups | undefined }
}

const EMPTY_GROUPS_SCOPE: GroupsScopeLike = {
  subscribe: () => () => {},
  getSnapshot: () => ({ value: EMPTY_GROUPS }),
}

const modalStyles = `
.dshmore-hidden-ws-list { display: grid; gap: 8px; max-height: 320px; overflow-y: auto; }
.dshmore-hidden-ws-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dshmore-hidden-ws-meta { min-width: 0; flex: 1; display: grid; gap: 2px; }
.dshmore-hidden-ws-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshmore-hidden-ws-path { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshmore-hidden-ws-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshmore-hidden-ws-empty { padding: 12px 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
`

function displayWorkspaceTitle(title: string): string {
  return title === 'default-workspace' ? '默认工作区' : title
}

export function extendHiddenWorkspacesSidebar(
  original: ComponentType<SidebarProps>,
  activation: PatchActivationSource,
  controller: HiddenWorkspaceController,
  groupsScope: GroupsScopeLike = EMPTY_GROUPS_SCOPE,
  lifetime: Lifetime = ALWAYS_LIVE,
  ctx?: Context,
): ComponentType<SidebarProps> {
  return function HiddenWorkspacesSidebar(props: SidebarProps): JSX.Element {
    const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot)
    const active = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot)
    const hiddenState = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const groupsBinding = useMemo(() => ({
      subscribe: (listener: () => void) => groupsScope.subscribe(listener),
      getSnapshot: () => groupsScope.getSnapshot(),
    }), [groupsScope])
    const groupsSaved = useSyncExternalStore(groupsBinding.subscribe, groupsBinding.getSnapshot)
    const nativeWorkspaces = props.useWorkspaces((value) => value)
    const nativeSessions = props.useSessions((value) => value)
    const enabled = active && settings[WORKSPACE_HIDE_PATCH_ID]
    const projectlessEnabled = settings[PROJECTLESS_TASKS_PATCH_ID]
    const activeGroups = projectlessEnabled ? (groupsSaved.value ?? EMPTY_GROUPS) : undefined

    const hiddenWorkspaceIds = useMemo(
      () => enabled ? effectiveHiddenWorkspaceIds(nativeWorkspaces, hiddenState.effective) : new Set<WorkspaceId>(),
      [enabled, nativeWorkspaces, hiddenState.effective],
    )
    const hiddenSessionIds = useMemo(
      () => enabled ? collectHiddenSessionIds(nativeWorkspaces, nativeSessions, hiddenWorkspaceIds, activeGroups) : new Set<SessionId>(),
      [enabled, nativeWorkspaces, nativeSessions, hiddenWorkspaceIds, activeGroups],
    )
    const visibleWorkspaces = useMemo(
      () => enabled ? projectVisibleWorkspaces(nativeWorkspaces, hiddenWorkspaceIds) : nativeWorkspaces,
      [enabled, nativeWorkspaces, hiddenWorkspaceIds],
    )
    const visibleSessions = useMemo(
      () => enabled ? projectVisibleSessions(nativeSessions, hiddenSessionIds) : nativeSessions,
      [enabled, nativeSessions, hiddenSessionIds],
    )
    const hiddenItems = useMemo(
      () => nativeWorkspaces.items.filter((item) => hiddenWorkspaceIds.has(item.workspaceId)),
      [nativeWorkspaces.items, hiddenWorkspaceIds],
    )

    const [manageOpen, setManageOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [hideError, setHideError] = useState<string | null>(null)

    const enabledRef = useRef(enabled)
    enabledRef.current = enabled
    const hiddenIdsRef = useRef(hiddenWorkspaceIds)
    hiddenIdsRef.current = hiddenWorkspaceIds
    const hiddenItemsRef = useRef(hiddenItems)
    hiddenItemsRef.current = hiddenItems
    const hiddenStateRef = useRef(hiddenState)
    hiddenStateRef.current = hiddenState
    const nativeWorkspacesRef = useRef(nativeWorkspaces)
    nativeWorkspacesRef.current = nativeWorkspaces
    const nativeSessionsRef = useRef(nativeSessions)
    nativeSessionsRef.current = nativeSessions
    const activeGroupsRef = useRef(activeGroups)
    activeGroupsRef.current = activeGroups
    const actionsRef = useRef(props.actions)
    actionsRef.current = props.actions
    const inFlightRef = useRef(false)
    const liveRef = useRef(true)
    const menuRef = useRef<WorkspaceHideMenuController>()

    useEffect(() => {
      liveRef.current = true
      return () => { liveRef.current = false }
    }, [])

    const hideOne = useCallback(async (workspaceId: WorkspaceId): Promise<void> => {
      if (!enabledRef.current || inFlightRef.current) return
      const state = hiddenStateRef.current
      if (state.status !== 'ready') {
        setHideError('隐藏工作区设置尚未就绪，请确认已重启 DSH 后台并刷新页面。')
        return
      }
      if (!state.writable) {
        setHideError('当前配置为只读，无法隐藏工作区。')
        return
      }

      inFlightRef.current = true
      setHideError(null)
      const currentWorkspaces = nativeWorkspacesRef.current
      const currentSessions = nativeSessionsRef.current
      const currentGroups = activeGroupsRef.current
      const previousCurrentId = currentSessionId(currentSessions)
      const nextHiddenIds = new Set([...hiddenIdsRef.current, workspaceId])
      const nextHiddenSessions = collectHiddenSessionIds(currentWorkspaces, currentSessions, nextHiddenIds, currentGroups)
      const currentWasHidden = previousCurrentId !== undefined && nextHiddenSessions.has(previousCurrentId)
      const fallbackSessionId = currentWasHidden
        ? adjacentVisibleSessionOutsideHidden(currentSessions, currentWorkspaces, nextHiddenIds, currentGroups)
        : undefined

      let navigatedAway = false
      const uiWorkspace = ctx === undefined || typeof ctx.get !== 'function'
        ? undefined
        : ctx.get('uiWorkspace') as { clearMain?(): void } | undefined

      if (currentWasHidden) {
        if (fallbackSessionId !== undefined && ctx !== undefined) {
          openSessionWithoutGap(clientSessions(ctx), fallbackSessionId)
          navigatedAway = true
        } else if (typeof uiWorkspace?.clearMain === 'function') {
          uiWorkspace.clearMain()
          navigatedAway = true
        }
      }

      controller.setOverride(workspaceId, true)
      try {
        await callPatchApi<WorkspaceHideMutationResult>(WORKSPACE_HIDE_PATCH_ID, 'hide', { workspaceId })
      } catch (caught) {
        controller.clearOverride(workspaceId)
        if (navigatedAway && ctx !== undefined && previousCurrentId !== undefined
          && nativeSessionsRef.current.byId[previousCurrentId] !== undefined) {
          openSessionWithoutGap(clientSessions(ctx), previousCurrentId)
        }
        if (liveRef.current) setHideError(apiErrorText(caught))
      } finally {
        inFlightRef.current = false
      }
    }, [controller, ctx])

    useEffect(() => {
      if (!enabled) {
        setManageOpen(false)
        setError(null)
        setHideError(null)
        menuRef.current?.dispose()
        menuRef.current = undefined
        return
      }
      const installed = installWorkspaceHideMenus({
        getHiddenCount: () => hiddenItemsRef.current.length,
        onHide: (workspaceId) => { void hideOne(workspaceId) },
        onManageHidden: () => {
          setError(null)
          setManageOpen(true)
        },
      })
      menuRef.current = installed
      return () => {
        installed.dispose()
        if (menuRef.current === installed) menuRef.current = undefined
      }
    }, [enabled, hideOne])

    useEffect(() => {
      if (enabled) menuRef.current?.refresh()
    }, [enabled, hiddenItems.length])

    const wrappedActions = useMemo(() => {
      const originalActions = props.actions
      if (!enabled || originalActions === undefined) return originalActions
      const retain = originalActions.retainAccountKeys
      if (typeof retain !== 'function') return originalActions
      return {
        ...originalActions,
        retainAccountKeys: (keys: readonly string[]) => {
          const merged = new Set(keys)
          for (const id of hiddenIdsRef.current) merged.add(id)
          retain([...merged])
        },
      }
    }, [enabled, props.actions])

    const createWorkspace = useMemo(() => {
      const originalCreate = props.createWorkspace
      if (originalCreate === undefined) return undefined
      return async (input: { path: string }) => {
        const workspace = await originalCreate(input)
        if (enabledRef.current && hiddenIdsRef.current.has(workspace.workspaceId)) {
          controller.setOverride(workspace.workspaceId, false)
          actionsRef.current?.setGroupExpanded?.(workspace.workspaceId, true)
          try {
            await callPatchApi<WorkspaceHideMutationResult>(WORKSPACE_HIDE_PATCH_ID, 'unhide', {
              workspaceId: workspace.workspaceId,
            })
          } catch (caught) {
            controller.clearOverride(workspace.workspaceId)
            throw caught
          }
        }
        return workspace
      }
    }, [controller, props.createWorkspace])

    const restoreOne = async (workspaceId: WorkspaceId): Promise<void> => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      setBusy(true)
      setError(null)
      controller.setOverride(workspaceId, false)
      actionsRef.current?.setGroupExpanded?.(workspaceId, true)
      try {
        await callPatchApi<WorkspaceHideMutationResult>(WORKSPACE_HIDE_PATCH_ID, 'unhide', { workspaceId })
        if (liveRef.current && hiddenItemsRef.current.length <= 1) setManageOpen(false)
      } catch (caught) {
        controller.clearOverride(workspaceId)
        if (liveRef.current) setError(apiErrorText(caught))
      } finally {
        inFlightRef.current = false
        if (liveRef.current) setBusy(false)
      }
    }

    const restoreAll = async (): Promise<void> => {
      if (inFlightRef.current) return
      const targets = hiddenItemsRef.current.map((item) => item.workspaceId)
      if (targets.length === 0) return
      inFlightRef.current = true
      setBusy(true)
      setError(null)
      for (const id of targets) {
        controller.setOverride(id, false)
        actionsRef.current?.setGroupExpanded?.(id, true)
      }
      try {
        await callPatchApi<WorkspaceUnhideAllResult>(WORKSPACE_HIDE_PATCH_ID, 'unhideAll', {})
        if (liveRef.current) setManageOpen(false)
      } catch (caught) {
        for (const id of targets) controller.clearOverride(id)
        if (liveRef.current) setError(apiErrorText(caught))
      } finally {
        inFlightRef.current = false
        if (liveRef.current) setBusy(false)
      }
    }

    const useWorkspaces: SidebarProps['useWorkspaces'] = (select) => select(visibleWorkspaces)
    const useSessions: SidebarProps['useSessions'] = (select) => select(visibleSessions)

    const closeManage = (): void => {
      if (busy) return
      setManageOpen(false)
      setError(null)
    }

    const unavailable = hiddenState.status !== 'ready'
      ? '隐藏工作区设置尚未就绪，请确认已重启 DSH 后台并刷新页面。'
      : !hiddenState.writable
        ? '当前配置为只读，无法恢复已隐藏的工作区。'
        : undefined

    return (
      <>
        {createElement(original, {
          ...props,
          useWorkspaces,
          useSessions,
          ...(wrappedActions === undefined ? {} : { actions: wrappedActions }),
          ...(createWorkspace === undefined ? {} : { createWorkspace }),
        })}
        {enabled && (
          <>
            <style>{styles + modalStyles}</style>
            <Modal
              open={manageOpen}
              onClose={closeManage}
              title="已隐藏的工作区"
              closeLabel="关闭"
              description="隐藏的工作区会保留全部对话、标题和排序；重新添加目录或点击恢复即可回到列表。"
              footer={(
                <>
                  <Button variant="ghost" disabled={busy} onClick={closeManage}>关闭</Button>
                  {hiddenItems.length > 1 && (
                    <Button variant="primary" disabled={busy || unavailable !== undefined} onClick={() => void restoreAll()}>
                      {busy ? '正在恢复…' : '全部恢复'}
                    </Button>
                  )}
                </>
              )}
            >
              <div className="dshmore-dialog-body">
                {hiddenItems.length === 0 ? (
                  <div className="dshmore-hidden-ws-empty">当前没有已隐藏的工作区。</div>
                ) : (
                  <div className="dshmore-hidden-ws-list">
                    {hiddenItems.map((item) => (
                      <div className="dshmore-hidden-ws-row" key={item.workspaceId}>
                        <div className="dshmore-hidden-ws-meta">
                          <span className="dshmore-hidden-ws-title">{displayWorkspaceTitle(item.title)}</span>
                          <span className="dshmore-hidden-ws-path" title={item.path}>{item.path}</span>
                        </div>
                        <span className="dshmore-hidden-ws-count">{item.sessionIds.length} 个会话</span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || unavailable !== undefined}
                          onClick={() => void restoreOne(item.workspaceId)}
                        >
                          恢复显示
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {(error ?? unavailable) !== undefined && (
                  <div className="dshmore-error" role="alert">{error ?? unavailable}</div>
                )}
              </div>
            </Modal>
            <Modal
              open={!manageOpen && hideError !== null}
              onClose={() => { setHideError(null) }}
              title="无法隐藏工作区"
              closeLabel="关闭"
              footer={<Button variant="primary" onClick={() => { setHideError(null) }}>知道了</Button>}
            >
              <div className="dshmore-dialog-body">
                <div className="dshmore-error" role="alert">{hideError}</div>
              </div>
            </Modal>
          </>
        )}
      </>
    )
  }
}

export function installSidebarHideAdapter(
  ctx: Context,
  activation: PatchActivationSource,
  controller: HiddenWorkspaceController,
  groupsScope?: Pick<SettingsScope<SessionGroups>, 'subscribe' | 'getSnapshot'>,
): () => void {
  let live = true
  const listeners = new Set<() => void>()
  const lifetime: Lifetime = {
    getSnapshot: () => live,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const wrapped = new Map<StoredEntry, { original: unknown; component: ComponentType<SidebarProps> }>()
  const sync = (): void => {
    for (const entry of ctx.slots.entries(SIDEBAR_SLOT)) {
      if (wrapped.has(entry) || entry.children?.['sidebar.workspaces.directoryFlow'] === undefined || typeof entry.component !== 'function') continue
      const original = entry.component as ComponentType<SidebarProps>
      const component = extendHiddenWorkspacesSidebar(original, activation, controller, groupsScope, lifetime, ctx)
      wrapped.set(entry, { original, component })
      entry.component = component
    }
  }
  const unsubscribe = ctx.slots.subscribe(SIDEBAR_SLOT, sync)
  sync()
  const priorities = ctx.slots.entries(SIDEBAR_SLOT).map((entry) => entry.options.priority ?? 0)
  const fallback = ctx.slots.register({ name: SIDEBAR_SLOT, priority: Math.max(0, ...priorities) + 1 }, () => null)
  return () => {
    live = false
    listeners.forEach((listener) => listener())
    unsubscribe()
    for (const [entry, patch] of wrapped) {
      if (entry.component === patch.component) entry.component = patch.original
    }
    wrapped.clear()
    fallback()
  }
}
