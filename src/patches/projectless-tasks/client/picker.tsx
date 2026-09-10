import { createContext, createElement, useContext, useLayoutEffect, useMemo, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { EmptyWorkspaceOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export const INDEPENDENT_CHOICE_ID = '::dsh-more-independent-task' as WorkspaceId
// A picker-local option, never published to workspaces.list or sent to a Host API.
const INDEPENDENT_CHOICE: WorkspaceView = {
  workspaceId: INDEPENDENT_CHOICE_ID, title: '独立任务', path: '', sessionIds: [], createdAt: '', updatedAt: '',
}

interface ChoiceState {
  independent: boolean
  busy: boolean
  chooseIndependent(): void
}
const ChoiceContext = createContext<ChoiceState | undefined>(undefined)

export function withIndependentChoice(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return { ...snapshot, items: [INDEPENDENT_CHOICE, ...snapshot.items] }
}

/** Patch just the native chip label; its button, anchor and menu stay mounted. */
export function labelIndependentChip(anchor: HTMLElement): () => void {
  const label = anchor.querySelector('[class*="_workspaceLabel"]')
  if (label === null) return () => {}
  const text = label.textContent
  const aria = anchor.getAttribute('aria-label')
  label.textContent = '独立任务'
  anchor.setAttribute('aria-label', '工作目录：独立任务')
  return () => {
    if (label.textContent === '独立任务') label.textContent = text
    if (anchor.getAttribute('aria-label') === '工作目录：独立任务') {
      if (aria === null) anchor.removeAttribute('aria-label')
      else anchor.setAttribute('aria-label', aria)
    }
  }
}

export function WorkspaceChoice({ owner, state, error, children }: {
  owner: EmptyWorkspaceOwnerProps
  state: ChoiceState
  error: string | undefined
  children: ReactNode
}): JSX.Element {
  // Reapply after native label changes during workspace/session follow frames.
  useLayoutEffect(() => {
    const anchor = owner.anchorRef?.current
    if (!state.independent || owner.selectedId !== undefined || anchor === undefined || anchor === null) return
    return labelIndependentChip(anchor)
  })
  const clear = (): void => { owner.onClose(); state.chooseIndependent() }
  return <ChoiceContext.Provider value={state}>
    {children}
    {owner.selectedId !== undefined && <button type="button" className="dshmore-workspace-clear"
      aria-label="清除目录，切换为独立任务" title="清除目录，切换为独立任务" disabled={state.busy}
      onClick={clear}>×</button>}
    {state.busy && <span className="dshmore-workspace-status" role="status">切换中…</span>}
    {error !== undefined && <span className="dshmore-workspace-error" role="alert">{error}</span>}
    <style>{`
      .dshmore-workspace-clear { display:inline-flex; align-items:center; justify-content:center; flex:none; width:22px; height:22px; margin:0 4px 0 -2px; padding:0; border:0; border-radius:50%; color:var(--dsw-alias-label-secondary); background:transparent; font:18px/1 sans-serif; cursor:pointer; }
      .dshmore-workspace-clear:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
      .dshmore-workspace-clear:disabled { opacity:.45; cursor:wait; }
      .dshmore-workspace-status,.dshmore-workspace-error { font-size:12px; color:var(--dsw-alias-label-secondary); }
      .dshmore-workspace-error { max-width:300px; overflow-wrap:anywhere; color:var(--dsw-alias-state-error-primary); }
    `}</style>
  </ChoiceContext.Provider>
}

type NativePickerProps = PropsRuntime<'conversation.hero.workspace'>

/** Preserve the native menu, keyboard selection, Add workspace and directory flow. */
export function extendWorkspacePicker(original: ComponentType<NativePickerProps>): ComponentType<NativePickerProps> {
  return function ProjectlessPicker(props: NativePickerProps): JSX.Element {
    const choice = useContext(ChoiceContext)
    const snapshot = props.useWorkspaces((value) => value)
    const display = useMemo(() => choice === undefined ? snapshot : withIndependentChoice(snapshot), [snapshot, choice === undefined])
    // The wrapper owns the live subscription. This scoped selector projects only
    // this menu; native workspaces, groups and sessions remain untouched.
    const useWorkspaces: NativePickerProps['useWorkspaces'] = (select) => select(display)
    return createElement(original, {
      ...props,
      useWorkspaces,
      open: props.open && !choice?.busy,
      selectedId: props.selectedId ?? (choice?.independent ? INDEPENDENT_CHOICE_ID : undefined),
      onPick: (id: WorkspaceId) => {
        if (choice?.busy) return
        if (id === INDEPENDENT_CHOICE_ID) {
          props.onClose()
          choice?.chooseIndependent()
        } else props.onPick(id)
      },
    })
  }
}

/** Same guarded registration seam as the Conversation adapter, with full teardown. */
export function installPickerAdapter(ctx: Context): () => void {
  const wrapped = new Map<StoredEntry, { original: unknown; component: ComponentType<NativePickerProps> }>()
  const sync = (): void => {
    for (const entry of ctx.slots.entries('conversation.hero.workspace')) {
      if (wrapped.has(entry) || entry.children?.['conversation.hero.workspace.directoryFlow'] === undefined || typeof entry.component !== 'function') continue
      const original = entry.component as ComponentType<NativePickerProps>
      const component = extendWorkspacePicker(original)
      wrapped.set(entry, { original, component })
      entry.component = component
    }
  }
  const unsubscribe = ctx.slots.subscribe('conversation.hero.workspace', sync)
  sync()
  const priorities = ctx.slots.entries('conversation.hero.workspace').map((entry) => entry.options.priority ?? 0)
  const fallback = ctx.slots.register({ name: 'conversation.hero.workspace', priority: Math.max(0, ...priorities) + 1 }, () => null)
  return () => {
    unsubscribe()
    for (const [entry, patch] of wrapped) if (entry.component === patch.component) entry.component = patch.original
    wrapped.clear()
    fallback()
  }
}
