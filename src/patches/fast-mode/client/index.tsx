import { useEffect, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import { callPatchApi } from '../../../platform/dsh/client/api.js'
import { currentSessionId } from '../../../platform/dsh/client/runtime.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import { FAST_MODE_PATCH_ID } from '../shared.js'
import { fastModeStyles } from './styles.js'

interface SessionFastClientState {
  active: boolean
  busy: boolean
}

const IDLE_FAST_STATE: SessionFastClientState = { active: false, busy: false }

class FastModeClientStore {
  private states = new Map<string, SessionFastClientState>()
  private listeners = new Set<() => void>()

  getState(sessionId?: string): SessionFastClientState {
    const key = sessionId || 'default'
    // useSyncExternalStore requires a stable snapshot; a fresh object crashes the button.
    return this.states.get(key) ?? IDLE_FAST_STATE
  }

  setState(sessionId: string | undefined, next: Partial<SessionFastClientState>): void {
    const key = sessionId || 'default'
    const prev = this.getState(key)
    this.states.set(key, { ...prev, ...next })
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

export const fastModeClientStore = new FastModeClientStore()

export async function syncSessionFastState(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  try {
    const res = await callPatchApi<{ enabled: boolean }>(FAST_MODE_PATCH_ID, 'getState', { sessionId })
    fastModeClientStore.setState(sessionId, { active: res.enabled, busy: false })
    return res.enabled
  } catch {
    return false
  }
}

export async function toggleFastMode(ctx: ClientContext, sessionId?: string): Promise<void> {
  const currentId = sessionId || currentSessionId((ctx as any).sessions?.list?.getSnapshot())
  if (!currentId) return

  const current = fastModeClientStore.getState(currentId)
  if (current.busy) return
  // Optimistic update
  fastModeClientStore.setState(currentId, { active: !current.active, busy: true })

  try {
    const res = await callPatchApi<{ enabled: boolean }>(FAST_MODE_PATCH_ID, 'toggle', { sessionId: currentId })
    fastModeClientStore.setState(currentId, { active: res.enabled, busy: false })
  } catch (err) {
    console.error('Failed to toggle fast mode:', err)
    fastModeClientStore.setState(currentId, { active: current.active, busy: false })
  }
}

function FastModeButton({
  sessionId,
  activation,
  ctx,
}: {
  sessionId?: string | undefined
  activation: PatchActivationSource
  ctx: ClientContext
}): JSX.Element | null {
  const settings = useSyncExternalStore(activation.subscribe, activation.getSnapshot)
  const enabled = settings[FAST_MODE_PATCH_ID]
  const state = useSyncExternalStore(
    fastModeClientStore.subscribe,
    () => fastModeClientStore.getState(sessionId),
  )

  useEffect(() => {
    if (sessionId) {
      void syncSessionFastState(sessionId)
    }
  }, [sessionId])

  if (!enabled) return null

  const tooltip = state.active
    ? '加速已开启\n响应更快，也会更快消耗额度\n点击关闭，恢复标准速度'
    : '加速\n开启后响应更快，但会更快消耗额度\n点击开启'

  return (
    <>
      <style>{fastModeStyles}</style>
      <button
        type="button"
        className={`dshmore-fast-btn ${state.active ? 'dshmore-fast-btn--active' : ''} ${state.busy ? 'dshmore-fast-btn--busy' : ''}`}
        disabled={state.busy}
        title={tooltip}
        aria-label={tooltip}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void toggleFastMode(ctx, sessionId)
        }}
      >
        <span className="dshmore-fast-btn-icon">⚡</span>
        <span className="dshmore-fast-btn-label">
          {state.busy ? '切换中…' : state.active ? '加速 (开)' : '加速'}
        </span>
      </button>
    </>
  )
}

function FastModeInputContribution(
  props: PropsRuntime<'conversation.input.right'> & {
    activation: PatchActivationSource
    ctx: ClientContext
    sessionId?: string
  },
): JSX.Element | null {
  const currentList = (props as any).useSessions ? (props as any).useSessions((s: any) => s) : undefined
  const derivedId =
    props.sessionId ||
    (currentList ? currentSessionId(currentList) : undefined) ||
    currentSessionId((props.ctx as any).sessions?.list?.getSnapshot())

  return (
    <FastModeButton
      sessionId={derivedId ? String(derivedId) : undefined}
      activation={props.activation}
      ctx={props.ctx}
    />
  )
}

function FastModeHeaderContribution(
  props: PropsRuntime<'conversation.session.header.utilities'> & {
    activation: PatchActivationSource
    ctx: ClientContext
  },
): JSX.Element | null {
  const currentList = (props as any).useSessions ? (props as any).useSessions((s: any) => s) : undefined
  const derivedId =
    (props as any).sessionId ||
    (currentList ? currentSessionId(currentList) : undefined) ||
    currentSessionId((props.ctx as any).sessions?.list?.getSnapshot())

  return (
    <FastModeButton
      sessionId={derivedId ? String(derivedId) : undefined}
      activation={props.activation}
      ctx={props.ctx}
    />
  )
}

export const clientPatch: ClientPatch = {
  id: FAST_MODE_PATCH_ID,
  install: (ctx: ClientContext, activation: PatchActivationSource) => {
    // 1. Inject Fast Mode button into composer tool row before model selector
    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register(
        {
          name: 'conversation.input.right',
          id: `${PLUGIN_NAME}-${FAST_MODE_PATCH_ID}`,
          order: 10,
          priority: 10,
          inject: (sessionId) => ({
            sessionId: sessionId ? String(sessionId) : undefined,
          }),
        },
        (props: PropsRuntime<'conversation.input.right'>) => (
          <FastModeInputContribution {...props} ctx={ctx} activation={activation} />
        ),
      ),
    )

    // 2. Also inject into session header utilities (alongside Markdown Export) for high visibility
    ctx.slots.inject('conversation.session.header.utilities', () =>
      ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: `${PLUGIN_NAME}-${FAST_MODE_PATCH_ID}-header`,
          order: 85,
        },
        (props: PropsRuntime<'conversation.session.header.utilities'>) => (
          <FastModeHeaderContribution {...props} ctx={ctx} activation={activation} />
        ),
      ),
    )

    // 3. Register /fast slash command
    const registerCommand = (scope: ClientContext): void => {
      const command: any = (scope as any).commandUi ?? scope.get?.('commandUi')
      const sessions: any = scope.sessions ?? (scope as any).get?.('sessions')
      if (command && typeof command.register === 'function') {
        scope.effect(
          () =>
            command.register({
              name: 'fast',
              label: () => '加速',
              description: () => '开启或关闭当前会话的加速。响应更快，但会更快消耗额度',
              available: (session: any) =>
                sessions?.subagentAddress?.(session.sessionId) === undefined,
              ui: {
                kind: 'action',
                run: (session: any) => {
                  void toggleFastMode(ctx, String(session.sessionId))
                },
              },
            }),
          'fast-mode: /fast command',
        )
      }
    }

    if (typeof (ctx as any).inject === 'function') {
      try {
        ctx.inject(['commandUi'], (scope) => {
          registerCommand(scope)
        })
      } catch {
        registerCommand(ctx)
      }
    } else {
      registerCommand(ctx)
    }
  },
}
