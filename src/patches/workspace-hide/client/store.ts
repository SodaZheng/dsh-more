import type { SettingsScope, SettingsScopeSnapshot } from '../../../platform/dsh/client/settings.js'
import { EMPTY_HIDDEN_WORKSPACES, type HiddenWorkspaces } from '../shared.js'

export interface HiddenWorkspaceStateSnapshot {
  saved: HiddenWorkspaces
  overrides: ReadonlyMap<string, boolean>
  effective: HiddenWorkspaces
  status: SettingsScopeSnapshot<HiddenWorkspaces>['status']
  writable: boolean
}

export interface HiddenWorkspaceController {
  subscribe(listener: () => void): () => void
  getSnapshot(): HiddenWorkspaceStateSnapshot
  setOverride(workspaceId: string, hidden: boolean): void
  clearOverride(workspaceId: string): void
  dispose(): void
}

function buildEffective(saved: HiddenWorkspaces, overrides: ReadonlyMap<string, boolean>): HiddenWorkspaces {
  if (overrides.size === 0) return saved
  const hidden: Record<string, boolean> = { ...saved.hidden }
  for (const [workspaceId, flag] of overrides) {
    if (flag) hidden[workspaceId] = true
    else delete hidden[workspaceId]
  }
  return { hidden }
}

export function createHiddenWorkspaceController(
  scope: SettingsScope<HiddenWorkspaces>,
): HiddenWorkspaceController {
  const overrides = new Map<string, boolean>()
  const listeners = new Set<() => void>()
  let lastScopeSnapshot = scope.getSnapshot()
  let overrideVersion = 0
  let cachedVersion = -1
  let cachedScopeSnapshot: SettingsScopeSnapshot<HiddenWorkspaces> | undefined
  let cachedState: HiddenWorkspaceStateSnapshot | undefined

  const pruneCaughtUpOverrides = (saved: HiddenWorkspaces): void => {
    for (const [workspaceId, flag] of [...overrides]) {
      const persisted = saved.hidden[workspaceId] === true
      if (persisted === flag) overrides.delete(workspaceId)
    }
  }

  const notify = (): void => {
    listeners.forEach((listener) => listener())
  }

  const unsubscribeScope = scope.subscribe(() => {
    const nextScope = scope.getSnapshot()
    if (nextScope !== lastScopeSnapshot) {
      lastScopeSnapshot = nextScope
      pruneCaughtUpOverrides(nextScope.value ?? EMPTY_HIDDEN_WORKSPACES)
    }
    notify()
  })

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => {
      const scopeSnapshot = scope.getSnapshot()
      if (cachedState !== undefined && cachedScopeSnapshot === scopeSnapshot && cachedVersion === overrideVersion) {
        return cachedState
      }
      const saved = scopeSnapshot.value ?? EMPTY_HIDDEN_WORKSPACES
      cachedScopeSnapshot = scopeSnapshot
      cachedVersion = overrideVersion
      cachedState = {
        saved,
        overrides: new Map(overrides),
        effective: buildEffective(saved, overrides),
        status: scopeSnapshot.status,
        writable: scopeSnapshot.writable,
      }
      return cachedState
    },
    setOverride: (workspaceId, hidden) => {
      const savedFlag = (scope.getSnapshot().value ?? EMPTY_HIDDEN_WORKSPACES).hidden[workspaceId] === true
      if (savedFlag === hidden) {
        if (!overrides.delete(workspaceId)) return
      } else {
        if (overrides.get(workspaceId) === hidden) return
        overrides.set(workspaceId, hidden)
      }
      overrideVersion += 1
      notify()
    },
    clearOverride: (workspaceId) => {
      if (!overrides.delete(workspaceId)) return
      overrideVersion += 1
      notify()
    },
    dispose: () => {
      unsubscribeScope()
      overrides.clear()
      listeners.clear()
    },
  }
}
