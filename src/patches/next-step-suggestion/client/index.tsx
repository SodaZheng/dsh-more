import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type KeyboardEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ComposerBarProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import { callPatchApi } from '../../../platform/dsh/client/api.js'
import { NEXT_STEP_SUGGESTION_PATCH_ID as ID, type SuggestionResult } from '../shared.js'

export function SuggestionComposer({ original, activation, active, ...props }: ComposerBarProps & {
  original: ComponentType<ComposerBarProps>
  activation: PatchActivationSource
  active: boolean
}): JSX.Element {
  const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot)
  const input = props.useInput((state) => state)
  const session = props.useSession((state) => state)
  const menu = props.useMenuLauncher((value) => value)
  const enabled = active && settings[ID]
  const ready = enabled && props.sessionId !== undefined && session?.openState === 'open'
    && !session.running && !session.blank && !session.removed && session.subagent === null
    && session.pendingSubmissions.length === 0 && !props.disabled && props.blocked === undefined
  const [candidate, setCandidate] = useState<{ sessionId: string; text: string }>()
  const [dismissed, setDismissed] = useState(false)
  const [composing, setComposing] = useState(false)
  const compositionEnd = useRef(0)
  useEffect(() => {
    setCandidate(undefined)
    setDismissed(false)
    if (!ready || props.sessionId === undefined) return
    const sessionId = props.sessionId
    let current = true
    // Let native turn/history projections settle, and skip transient mounts.
    const timer = setTimeout(() => {
      void callPatchApi<SuggestionResult>(ID, 'suggest', { sessionId }).then((result) => {
        if (current && typeof result.suggestion === 'string' && result.suggestion.trim()) {
          setCandidate({ sessionId, text: result.suggestion })
        }
      }).catch(() => {})
    }, 500)
    return () => { current = false; clearTimeout(timer) }
  }, [ready, props.sessionId])

  const text = ready && !dismissed && !composing && menu === null
    && input?.phase === 'plain' && input.draft === '' && input.attachmentIds.length === 0
    && input.queue.length === 0 && candidate !== undefined && candidate.sessionId === props.sessionId
    ? candidate.text : undefined
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!text || !(target instanceof HTMLElement)
      || !target.matches('[contenteditable="true"][role="textbox"], textarea:not(:disabled)')
      || event.nativeEvent.isComposing || event.keyCode === 229 || composing || Date.now() - compositionEnd.current < 80) return
    if (event.key === 'Escape') { setDismissed(true); return }
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.defaultPrevented) return
    // Read live DOM as well as the last React snapshot: typing and Tab can share a frame.
    if ((target instanceof HTMLTextAreaElement ? target.value : target.textContent ?? '').replace(/\n/g, '') !== '') return
    const actions = props.inputActions
    if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return
    const span = actions.captureInsertion()
    if (span.draftRev !== input?.draftRev || span.start !== 0 || span.end !== 0) return
    if (!actions.insertText(text, span)) return
    event.preventDefault()
    event.stopPropagation()
    setDismissed(true)
    actions.persistDraft()
  }
  // A display-contents boundary preserves native geometry and owns only this editor's keys.
  return <div style={{ display: 'contents' }} onKeyDownCapture={onKeyDown}
    onCompositionStartCapture={() => setComposing(true)}
    onCompositionEndCapture={() => { compositionEnd.current = Date.now(); setComposing(false) }}>
    {createElement(original, { ...props, ...(text === undefined ? {} : { placeholder: text }) })}
  </div>
}

/** Preserve the native registration, injected editor, stores, and child-slot permissions. */
export function installComposerAdapter(ctx: Context, activation: PatchActivationSource): () => void {
  const name = 'conversation.composer.bar'
  const wrapped = new Map<StoredEntry, { original: unknown; component: ComponentType<ComposerBarProps> }>()
  let active = true
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const sync = (): void => {
    for (const entry of ctx.slots.entries(name)) {
      if (wrapped.has(entry) || entry.children?.['conversation.input.overlay'] === undefined) continue
      const original = entry.component
      // The native InputBar is React.memo(), so it is an object rather than a function.
      if (typeof original !== 'function' && !(typeof original === 'object' && original !== null
        && '$$typeof' in original && (original.$$typeof === Symbol.for('react.memo') || original.$$typeof === Symbol.for('react.forward_ref')))) continue
      const Native = original as ComponentType<ComposerBarProps>
      const component = (props: ComposerBarProps): JSX.Element => {
        const live = useSyncExternalStore(subscribe, () => active)
        return <SuggestionComposer {...props} original={Native} activation={activation} active={live} />
      }
      wrapped.set(entry, { original, component })
      entry.component = component
    }
  }
  const off = ctx.slots.subscribe(name, sync)
  sync()
  // A lower-priority dormant entry invalidates already mounted native slot renderers.
  const priority = Math.max(0, ...ctx.slots.entries(name).map((entry) => entry.options.priority ?? 0)) + 1
  const invalidate = ctx.slots.register({ name, priority }, () => null)
  return () => {
    active = false
    listeners.forEach((listener) => listener())
    off()
    for (const [entry, previous] of wrapped) if (entry.component === previous.component) entry.component = previous.original
    wrapped.clear()
    invalidate()
  }
}

export const clientPatch: ClientPatch = {
  id: ID,
  install(ctx, activation) {
    ctx.slots.inject('conversation.composer.bar', () => installComposerAdapter(ctx, activation))
  },
}
