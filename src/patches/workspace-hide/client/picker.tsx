import { createElement, useMemo, useRef, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import { callPatchApi } from '../../../platform/dsh/client/api.js'
import { WORKSPACE_HIDE_PATCH_ID, type WorkspaceHideMutationResult } from '../shared.js'
import { effectiveHiddenWorkspaceIds, projectVisibleWorkspaces } from './projection.js'
import type { HiddenWorkspaceController } from './store.js'

const PICKER_SLOT = 'conversation.hero.workspace'

type NativePickerProps = PropsRuntime<'conversation.hero.workspace'> & {
  createWorkspace?(input: { path: string }): Promise<WorkspaceView>
}

interface Lifetime {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
}

const ALWAYS_LIVE: Lifetime = { subscribe: () => () => {}, getSnapshot: () => true }

export function extendHiddenWorkspacePicker(
  original: ComponentType<NativePickerProps>,
  activation: PatchActivationSource,
  controller: HiddenWorkspaceController,
  lifetime: Lifetime = ALWAYS_LIVE,
): ComponentType<NativePickerProps> {
  return function HiddenWorkspacePicker(props: NativePickerProps): JSX.Element {
    const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot)
    const active = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot)
    const hiddenState = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const enabled = active && settings[WORKSPACE_HIDE_PATCH_ID]
    const snapshot = props.useWorkspaces((value) => value)

    const hiddenIds = useMemo(
      () => enabled ? effectiveHiddenWorkspaceIds(snapshot, hiddenState.effective) : new Set<WorkspaceView['workspaceId']>(),
      [enabled, snapshot, hiddenState.effective],
    )
    const visible = useMemo(
      () => enabled ? projectVisibleWorkspaces(snapshot, hiddenIds, props.selectedId) : snapshot,
      [enabled, snapshot, hiddenIds, props.selectedId],
    )
    const hiddenIdsRef = useRef(hiddenIds)
    hiddenIdsRef.current = hiddenIds
    const enabledRef = useRef(enabled)
    enabledRef.current = enabled

    const useWorkspaces: NativePickerProps['useWorkspaces'] = (select) => select(visible)
    const createWorkspace = props.createWorkspace === undefined ? undefined : async (input: { path: string }) => {
      const workspace = await props.createWorkspace!(input)
      if (enabledRef.current && hiddenIdsRef.current.has(workspace.workspaceId)) {
        controller.setOverride(workspace.workspaceId, false)
        try {
          await callPatchApi<WorkspaceHideMutationResult>(WORKSPACE_HIDE_PATCH_ID, 'unhide', {
            workspaceId: workspace.workspaceId,
          })
        } catch (error) {
          controller.clearOverride(workspace.workspaceId)
          throw error
        }
      }
      return workspace
    }

    return createElement(original, {
      ...props,
      useWorkspaces,
      ...(createWorkspace === undefined ? {} : { createWorkspace }),
    })
  }
}

export function installPickerHideAdapter(
  ctx: Context,
  activation: PatchActivationSource,
  controller: HiddenWorkspaceController,
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
  const wrapped = new Map<StoredEntry, { original: unknown; component: ComponentType<NativePickerProps> }>()
  const sync = (): void => {
    for (const entry of ctx.slots.entries(PICKER_SLOT)) {
      if (wrapped.has(entry) || entry.children?.['conversation.hero.workspace.directoryFlow'] === undefined || typeof entry.component !== 'function') continue
      const original = entry.component as ComponentType<NativePickerProps>
      const component = extendHiddenWorkspacePicker(original, activation, controller, lifetime)
      wrapped.set(entry, { original, component })
      entry.component = component
    }
  }
  const unsubscribe = ctx.slots.subscribe(PICKER_SLOT, sync)
  sync()
  const priorities = ctx.slots.entries(PICKER_SLOT).map((entry) => entry.options.priority ?? 0)
  const fallback = ctx.slots.register({ name: PICKER_SLOT, priority: Math.max(0, ...priorities) + 1 }, () => null)
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
