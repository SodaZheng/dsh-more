import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import { bindSettings } from '../../../platform/dsh/client/settings.js'
import { SESSION_GROUPS_NAMESPACE, EMPTY_GROUPS, decodeSessionGroups, type SessionGroups } from '../groups.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../shared.js'
import { installMoveMenu } from './group-menu.js'

/** Only the sidebar receives grouping metadata; execution and workspace selection use native cwd. */
export function projectSessionGroups(workspaces: WorkspaceSnapshot, sessions: SessionListState, groups: SessionGroups): WorkspaceSnapshot {
  const owned = new Set(workspaces.items.flatMap((item) => item.sessionIds))
  const items = workspaces.items.map((workspace) => {
    const added = Object.entries(groups.assignments).flatMap(([id, target]) =>
      target === workspace.workspaceId && !owned.has(id as SessionId)
        && sessions.byId[id as SessionId]?.origin !== 'subagent' && sessions.byId[id as SessionId] !== undefined ? [id as SessionId] : [])
    return added.length === 0 ? workspace : { ...workspace, sessionIds: [...added, ...workspace.sessionIds] }
  })
  return items.every((item, index) => item === workspaces.items[index]) ? workspaces : { ...workspaces, items }
}

// Workspace UI owns this root-scoped child slot; the 0.1.2 SDK only declares its parent.
const SIDEBAR_SLOT = 'sidebar.workspaces' as 'sidebar'
type SidebarProps = PropsRuntime<'sidebar'> & {
  archiveSession(id: SessionId): Promise<void>
}

interface Lifetime { subscribe(listener: () => void): () => void; getSnapshot(): boolean }
const ALWAYS_LIVE: Lifetime = { subscribe: () => () => {}, getSnapshot: () => true }
export function extendGroupedSidebar(original: ComponentType<SidebarProps>, activation: PatchActivationSource, source: SettingsScope<SessionGroups>, lifetime = ALWAYS_LIVE): ComponentType<SidebarProps> {
  return function GroupedSidebar(props: SidebarProps): JSX.Element {
    const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot)
    const binding = useMemo(() => ({ subscribe: (listener: () => void) => source.subscribe(listener), getSnapshot: () => source.getSnapshot() }), [])
    const saved = useSyncExternalStore(binding.subscribe, binding.getSnapshot)
    const native = props.useWorkspaces((value) => value)
    const sessions = props.useSessions((value) => value)
    const active = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot)
    const enabled = active && settings[PROJECTLESS_TASKS_PATCH_ID]
    const groups = saved.value ?? EMPTY_GROUPS
    const display = useMemo(() => enabled ? projectSessionGroups(native, sessions, groups) : native, [enabled, native, sessions, groups])
    const [pending, setPending] = useState<SessionId>()
    const [destination, setDestination] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string>()
    const intent = useRef(false)
    const inFlight = useRef(false)
    const live = useRef(true)
    useEffect(() => { live.current = true; return () => { live.current = false } }, [])
    useEffect(() => {
      if (!enabled) { setPending(undefined); return }
      return installMoveMenu((archive) => {
        intent.current = true
        try { archive.click() } finally { intent.current = false }
      })
    }, [enabled])
    const archiveSession = (id: SessionId): Promise<void> => {
      if (!intent.current) return props.archiveSession(id)
      intent.current = false
      setPending(id)
      setDestination(groups.assignments[id] ?? '')
      setError(undefined)
      return Promise.resolve()
    }
    const useWorkspaces: SidebarProps['useWorkspaces'] = (select) => select(display)
    const close = (): void => { if (!inFlight.current) setPending(undefined) }
    const move = async (): Promise<void> => {
      if (pending === undefined || inFlight.current) return
      inFlight.current = true
      setBusy(true); setError(undefined)
      try {
        await callPatchApi(PROJECTLESS_TASKS_PATCH_ID, 'move', { sessionId: pending, workspaceId: destination || null })
        // Settings' native follow stream updates the sidebar without a list reload or navigation.
        if (live.current) setPending(undefined)
      } catch (reason) { if (live.current) setError(apiErrorText(reason)) }
      finally { inFlight.current = false; if (live.current) setBusy(false) }
    }
    const groupedNatively = pending !== undefined && native.items.some((item) => item.sessionIds.includes(pending))
    const subagent = pending !== undefined && sessions.byId[pending]?.origin === 'subagent'
    const selectedMissing = destination !== '' && !native.items.some((item) => item.workspaceId === destination)
    const unavailable = groupedNatively ? '这条会话已有原生工作区，只支持移动未分组或手动归组的会话。'
      : subagent ? '子会话跟随主会话归组，请移动主会话。'
      : saved.status !== 'ready' ? '归组设置尚未就绪，请确认已重启 DSH 后台并刷新页面。'
      : !saved.writable ? '当前配置为只读，无法移动会话。'
      : selectedMissing ? '目标工作区已不存在，请重新选择。' : undefined
    return <>
      {createElement(original, { ...props, useWorkspaces, archiveSession })}
      {enabled && <Modal open={pending !== undefined} onClose={close} title="移动到工作区" closeLabel="关闭"
        description="保留会话历史和原工作目录，仅调整列表归属。"
        footer={<><Button variant="ghost" disabled={busy} onClick={close}>取消</Button>
          <Button variant="primary" disabled={busy || unavailable !== undefined || pending === undefined
            || (groups.assignments[pending] ?? '') === destination} onClick={() => void move()}>{busy ? '正在移动…' : '移动'}</Button></>}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>{pending === undefined ? '' : sessions.byId[pending]?.displayTitle ?? pending}</div>
          <label style={{ display: 'grid', gap: 8 }}>目标工作区
            <select aria-label="目标工作区" value={destination} disabled={busy || unavailable !== undefined && !selectedMissing}
              onChange={(event) => setDestination(event.target.value)}
              style={{ width: '100%', minHeight: 40, borderRadius: 10, padding: '8px 12px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-button-elevated-fill)', border: '1px solid var(--dsw-alias-border-l4)' }}>
              <option value="">未分组</option>
              {native.items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title || item.path}</option>)}
            </select>
          </label>
          {(error ?? unavailable) !== undefined && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error ?? unavailable}</div>}
        </div>
      </Modal>}
    </>
  }
}

export function installSessionGrouping(ctx: Context, activation: PatchActivationSource): void {
  const source = bindSettings<SessionGroups>(ctx, { namespace: SESSION_GROUPS_NAMESPACE, decode: decodeSessionGroups })
  ctx.slots.inject(SIDEBAR_SLOT, () => {
    let live = true
    const listeners = new Set<() => void>()
    const lifetime: Lifetime = { getSnapshot: () => live, subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
    const wrapped = new Map<StoredEntry, { original: unknown; component: ComponentType<SidebarProps> }>()
    const sync = (): void => {
      for (const entry of ctx.slots.entries(SIDEBAR_SLOT)) {
        if (wrapped.has(entry) || entry.children?.['sidebar.workspaces.directoryFlow'] === undefined || typeof entry.component !== 'function') continue
        const original = entry.component as ComponentType<SidebarProps>
        const component = extendGroupedSidebar(original, activation, source, lifetime)
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
      for (const [entry, patch] of wrapped) if (entry.component === patch.component) entry.component = patch.original
      wrapped.clear()
      fallback()
    }
  })
}
