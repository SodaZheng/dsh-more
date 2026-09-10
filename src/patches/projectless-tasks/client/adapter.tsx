import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationSlotProps, ComposerBarOwnerProps, EmptyWorkspaceOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../shared.js'
import { apiErrorText } from '../../../platform/dsh/client/api.js'
import { createTaskStarter } from './create-task.js'
import { transferBeforeOpen } from './draft.js'
import { WorkspaceChoice } from './picker.js'

function isComposerOwner(owner: object): owner is ComposerBarOwnerProps {
  return 'variant' in owner && (owner.variant === 'hero' || owner.variant === 'composer')
}

function isWorkspaceOwner(owner: object): owner is EmptyWorkspaceOwnerProps {
  return 'open' in owner && typeof owner.open === 'boolean'
    && 'onPick' in owner && typeof owner.onPick === 'function'
    && 'onClose' in owner && typeof owner.onClose === 'function'
}

/** Host and Client merge different ctx.sessions types into Cordis. Validate this seam. */
export function clientSessionActions(ctx: Context): Pick<ISessions, 'create' | 'open'> {
  const sessions: unknown = ctx.sessions
  if (typeof sessions !== 'object' || sessions === null || !('create' in sessions)
    || !('open' in sessions) || typeof sessions.create !== 'function' || typeof sessions.open !== 'function') {
    throw new Error('当前 DSH 版本不支持独立任务，请检查会话接口。')
  }
  return sessions as Pick<ISessions, 'create' | 'open'>
}

/** Only the native workspace gate is removed; loading and business blocks stay native. */
export function unlockComposer(owner: ComposerBarOwnerProps, independent: boolean, block: ComposerBarOwnerProps['blocked']): ComposerBarOwnerProps {
  if (!independent || owner.disabled !== true || owner.onRequestWorkspace === undefined) return owner
  const { disabled: _disabled, onRequestWorkspace: _request, workspacePickerOpen: _picker, placeholder: _placeholder, ...rest } = owner
  return { ...rest, ...(block === undefined ? {} : { blocked: block, placeholder: block.reason }) }
}

/**
 * DSH 0.1.2-rc.1 compatibility seam. Keep the native registration identity,
 * children, stores and render authorizations; adapt only its owner props.
 * A dormant fallback registration invalidates the public slot subscription
 * on install/uninstall, including an already mounted Web client.
 */
export function installConversationAdapter(ctx: Context, activation: PatchActivationSource): () => void {
  const wrapped = new Map<StoredEntry, { original: unknown; component: ComponentType<ConversationSlotProps> }>()
  let live = true
  const listeners = new Set<() => void>()
  const subscribeLifetime = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const sync = (): void => {
    for (const entry of ctx.slots.entries('conversation')) {
      if (wrapped.has(entry) || entry.children?.['conversation.composer.bar'] === undefined || typeof entry.component !== 'function') continue
      const original = entry.component as ComponentType<ConversationSlotProps>
      function ProjectlessConversation(props: ConversationSlotProps): JSX.Element {
        const active = useSyncExternalStore(subscribeLifetime, () => live)
        const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot)
        const workspace = props.useWorkspaces((snapshot) => snapshot)
        const cwd = props.useSessions((snapshot) => props.sessionId === undefined ? undefined : snapshot.byId[props.sessionId]?.cwd)
        const session = props.useSession((snapshot) => snapshot)
        const block = props.useComposerBlock((value) => value)
        const enabled = active && settings[PROJECTLESS_TASKS_PATCH_ID]
        const starter = useRef<ReturnType<typeof createTaskStarter>>()
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState<string>()
        useEffect(() => {
          if (!enabled) return
          setBusy(false)
          setError(undefined)
          return () => { starter.current?.dispose(); starter.current = undefined }
        }, [enabled])
        const independent = enabled
          && props.sessionId !== undefined && session?.openState === 'open'
          && typeof cwd === 'string' && cwd.length > 0 && workspace.phase === 'ready'
          && !workspace.items.some((item) => item.sessionIds.includes(props.sessionId!))
        const chooseIndependent = (): void => {
          if (!enabled || busy || independent) return
          const operation = starter.current ??= createTaskStarter(clientSessionActions(ctx))
          setBusy(true)
          setError(undefined)
          void operation.start((id) => transferBeforeOpen(ctx, props.sessionId, id))
            .catch((reason: unknown) => { if (starter.current === operation) setError(apiErrorText(reason)) })
            .finally(() => { if (starter.current === operation) setBusy(false) })
        }
        const renderSlot: ConversationSlotProps['renderSlot'] = (name, owner, options) => {
          if (name === 'conversation.composer.bar' && isComposerOwner(owner)) {
            return props.renderSlot('conversation.composer.bar', unlockComposer(owner, independent, block), options)
          }
          if (enabled && name === 'conversation.hero.workspace' && isWorkspaceOwner(owner)) {
            return <WorkspaceChoice owner={owner} state={{ independent, busy, chooseIndependent }} error={error}>
              {props.renderSlot('conversation.hero.workspace', owner, options)}
            </WorkspaceChoice>
          }
          return props.renderSlot(name, owner, options)
        }
        return createElement(original, { ...props, renderSlot })
      }
      wrapped.set(entry, { original, component: ProjectlessConversation })
      entry.component = ProjectlessConversation
    }
  }
  const unsubscribe = ctx.slots.subscribe('conversation', sync)
  sync()
  const priorities = ctx.slots.entries('conversation').map((entry) => entry.options.priority ?? 0)
  const fallback = ctx.slots.register({ name: 'conversation', priority: Math.max(0, ...priorities) + 1 }, () => null)
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
