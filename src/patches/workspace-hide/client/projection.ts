import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { currentSessionId } from '../../../platform/dsh/client/runtime.js'
import type { SessionGroups } from '../../projectless-tasks/groups.js'
import type { HiddenWorkspaces } from '../shared.js'

export function effectiveHiddenWorkspaceIds(
  workspaces: WorkspaceSnapshot,
  hidden: HiddenWorkspaces,
  overrides?: ReadonlyMap<string, boolean>,
): ReadonlySet<WorkspaceId> {
  const result = new Set<WorkspaceId>()
  for (const item of workspaces.items) {
    const override = overrides?.get(item.workspaceId)
    const isHidden = override !== undefined ? override : hidden.hidden[item.workspaceId] === true
    if (isHidden) result.add(item.workspaceId)
  }
  return result
}

export function collectHiddenSessionIds(
  workspaces: WorkspaceSnapshot,
  sessions: SessionListState,
  hiddenWorkspaceIds: ReadonlySet<WorkspaceId>,
  groups?: SessionGroups,
): ReadonlySet<SessionId> {
  const hidden = new Set<SessionId>()
  if (hiddenWorkspaceIds.size === 0) return hidden

  const ownedNatively = new Set<SessionId>()
  for (const workspace of workspaces.items) {
    const workspaceHidden = hiddenWorkspaceIds.has(workspace.workspaceId)
    for (const sessionId of workspace.sessionIds) {
      ownedNatively.add(sessionId)
      if (workspaceHidden) hidden.add(sessionId)
    }
  }

  if (groups !== undefined) {
    for (const [sessionId, targetWorkspaceId] of Object.entries(groups.assignments)) {
      const id = sessionId as SessionId
      if (!hiddenWorkspaceIds.has(targetWorkspaceId as WorkspaceId)) continue
      if (ownedNatively.has(id)) continue
      const summary = sessions.byId[id]
      if (summary === undefined || summary.origin === 'subagent') continue
      hidden.add(id)
    }
  }

  if (hidden.size === 0) return hidden

  // Propagate hiding to transitive subagent children without infinite loops on cycles.
  const summaries = Object.values(sessions.byId)
  let added = true
  while (added) {
    added = false
    for (const summary of summaries) {
      if (summary === undefined || summary.origin !== 'subagent' || hidden.has(summary.id)) continue
      if (summary.parentId !== undefined && hidden.has(summary.parentId)) {
        hidden.add(summary.id)
        added = true
      }
    }
  }
  return hidden
}

export function projectVisibleWorkspaces(
  workspaces: WorkspaceSnapshot,
  hiddenWorkspaceIds: ReadonlySet<WorkspaceId>,
  preserveWorkspaceId?: WorkspaceId,
): WorkspaceSnapshot {
  if (hiddenWorkspaceIds.size === 0) return workspaces
  const items = workspaces.items.filter(
    (item) => !hiddenWorkspaceIds.has(item.workspaceId) || item.workspaceId === preserveWorkspaceId,
  )
  return items.length === workspaces.items.length ? workspaces : { ...workspaces, items }
}

export function projectVisibleSessions(
  sessions: SessionListState,
  hiddenSessionIds: ReadonlySet<SessionId>,
): SessionListState {
  if (hiddenSessionIds.size === 0) return sessions
  const ids = sessions.ids.filter((id) => !hiddenSessionIds.has(id))
  let removedFromMap = false
  for (const key of Object.keys(sessions.byId)) {
    if (hiddenSessionIds.has(key as SessionId)) {
      removedFromMap = true
      break
    }
  }
  if (ids.length === sessions.ids.length && !removedFromMap) return sessions
  const byId: Record<SessionId, SessionSummary> = {} as Record<SessionId, SessionSummary>
  for (const [key, summary] of Object.entries(sessions.byId)) {
    if (!hiddenSessionIds.has(key as SessionId) && summary !== undefined) {
      byId[key as SessionId] = summary
    }
  }
  return { ...sessions, ids, byId }
}

export function adjacentVisibleSessionOutsideHidden(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
  hiddenWorkspaceIds: ReadonlySet<WorkspaceId>,
  groups?: SessionGroups,
): SessionId | undefined {
  const current = currentSessionId(sessions)
  if (current === undefined) return undefined
  const hiddenSessionIds = collectHiddenSessionIds(workspaces, sessions, hiddenWorkspaceIds, groups)
  if (!hiddenSessionIds.has(current)) return undefined

  const archived = new Set(workspaces.archivedSessionIds)
  const currentIndex = sessions.ids.indexOf(current)
  const isCandidate = (id: SessionId | undefined, allowBlank: boolean): id is SessionId => {
    if (id === undefined || id === current || hiddenSessionIds.has(id) || archived.has(id)) return false
    const summary = sessions.byId[id]
    if (summary === undefined || summary.origin === 'subagent') return false
    return allowBlank || !summary.blank
  }

  const pick = (allowBlank: boolean): SessionId | undefined => {
    for (let index = currentIndex + 1; index < sessions.ids.length; index += 1) {
      const id = sessions.ids[index]
      if (isCandidate(id, allowBlank)) return id
    }
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const id = sessions.ids[index]
      if (isCandidate(id, allowBlank)) return id
    }
    return undefined
  }

  return pick(false) ?? pick(true)
}

export function recentVisibleWorkspaceId(
  workspaces: WorkspaceSnapshot,
  sessions: SessionListState,
  hiddenWorkspaceIds: ReadonlySet<WorkspaceId>,
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces.items) {
    if (hiddenWorkspaceIds.has(workspace.workspaceId)) continue
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const summary = sessions.byId[sessionId]
      if (summary !== undefined) latest = Math.max(latest, summary.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
