import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import {
  MESSAGE_VISIBILITY_PROJECTION_KEY,
  type MessageVisibilityProjection,
} from '../../../kernel/message-visibility.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import { CONVERSATION_QUICK_NAVIGATION_PATCH_ID } from '../shared.js'
import {
  activeTurnAt,
  createConversationTurnSelector,
  historyWindowSignature,
  scrollOffsetForRow,
  shouldAutoLoadOlder,
  type ConversationTurnSummary,
  type TurnPosition,
} from './navigation.js'

type HeaderUtilityProps = PropsRuntime<'conversation.session.header.utilities'>

const MAX_NO_PROGRESS_ATTEMPTS = 3
const MENU_LIST_ID = 'dshmore-conversation-nav-list'

let navigationCollapsedPreference = false

function conversationRow(root: HTMLElement, key: string): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
    if (row.dataset.chatFlowKey === key) return row
  }
  return null
}

function sessionRoot(marker: HTMLElement | null): HTMLElement | null {
  return marker?.closest<HTMLElement>('[data-phase]') ?? null
}

function conversationScrollport(marker: HTMLElement | null): HTMLElement | null {
  return sessionRoot(marker)?.querySelector<HTMLElement>('[data-conversation-scroll]') ?? null
}

/** The native pre-row paging control owns DSH's reader-position anchoring. */
function nativeLoadOlderButton(scrollport: HTMLElement): HTMLButtonElement | null {
  const flow = scrollport.querySelector<HTMLElement>('[data-chat-flow]')
  if (flow === null) return null
  for (const child of flow.children) {
    if (child instanceof HTMLElement && child.dataset.chatFlowKey !== undefined) break
    const button = child.querySelector<HTMLButtonElement>('button')
    if (button !== null) return button
  }
  return null
}

export function ConversationNavigationMenu({
  turns,
  activeKey,
  hasMore,
  loadingOlder,
  autoLoadPaused,
  collapsed,
  onRetry,
  onToggleCollapsed,
  onJump,
  listRef,
}: {
  turns: readonly ConversationTurnSummary[]
  activeKey: string | null
  hasMore: boolean
  loadingOlder: boolean
  autoLoadPaused: boolean
  collapsed: boolean
  onRetry: () => void
  onToggleCollapsed: () => void
  onJump: (key: string) => void
  listRef: React.RefObject<HTMLDivElement>
}): JSX.Element {
  const loading = hasMore && !autoLoadPaused
  const compactStatus = autoLoadPaused
    ? `${String(turns.length)} 轮 · 已暂停`
    : loading
      ? `${String(turns.length)} 轮 · 加载中`
      : `${String(turns.length)} 轮`
  return (
    <nav
      className="dshmore-conversation-nav-menu"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="当前会话的对话目录"
    >
      <header className="dshmore-conversation-nav-header">
        <div className="dshmore-conversation-nav-heading">
          <div className="dshmore-conversation-nav-title-row">
            <div className="dshmore-conversation-nav-title">对话目录</div>
            {collapsed && (
              <div className="dshmore-conversation-nav-compact-status" role="status" aria-live="polite">
                {loading && <span className="dshmore-conversation-nav-loading-dot" aria-hidden="true" />}
                {compactStatus}
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="dshmore-conversation-nav-count" role="status" aria-live="polite">
              {loading && <span className="dshmore-conversation-nav-loading-dot" aria-hidden="true" />}
              {autoLoadPaused
                ? `已载入 ${String(turns.length)} 轮，自动加载已暂停`
                : loading
                  ? `正在加载全部记录 · 已载入 ${String(turns.length)} 轮`
                  : `共 ${String(turns.length)} 轮`}
            </div>
          )}
        </div>
        <div className="dshmore-conversation-nav-actions">
          {!collapsed && autoLoadPaused && (
            <button type="button" className="dshmore-conversation-nav-retry" onClick={onRetry}>
              继续加载
            </button>
          )}
          <button
            type="button"
            className="dshmore-conversation-nav-toggle"
            aria-label={collapsed ? '展开对话目录' : '折叠对话目录'}
            aria-controls={MENU_LIST_ID}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            {collapsed
              ? <IconChevronDownOutline14 size={14} />
              : <IconChevronUpOutline14 size={14} />}
          </button>
        </div>
      </header>
      {!collapsed && (
        <div id={MENU_LIST_ID} ref={listRef} className="dshmore-conversation-nav-list">
          {turns.length === 0 && (
            <div className="dshmore-conversation-nav-empty">
              {loadingOlder || hasMore ? '正在读取历史记录…' : '当前没有可定位的对话'}
            </div>
          )}
          {turns.map((turn, index) => {
            const active = turn.key === activeKey
            return (
              <button
                type="button"
                key={turn.key}
                className="dshmore-conversation-nav-item"
                aria-current={active ? 'location' : undefined}
                onClick={() => { onJump(turn.key) }}
              >
                <span className="dshmore-conversation-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="dshmore-conversation-nav-label">{turn.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </nav>
  )
}

export function ConversationQuickNavigation(props: HeaderUtilityProps & {
  activation: PatchActivationSource
}): JSX.Element | null {
  const settings = useSyncExternalStore(props.activation.subscribe, props.activation.getSnapshot, props.activation.getSnapshot)
  const enabled = settings[CONVERSATION_QUICK_NAVIGATION_PATCH_ID]
  const selector = useMemo(createConversationTurnSelector, [props.sessionId])
  const allTurns = props.useSession(selector)
  const hasMore = props.useSession((snapshot) => snapshot.hasMore)
  const loadingOlder = props.useSession((snapshot) => snapshot.loadingOlder)
  const windowSignature = props.useSession(historyWindowSignature)
  const projected = props.useProjection(MESSAGE_VISIBILITY_PROJECTION_KEY) as MessageVisibilityProjection | undefined
  const hiddenSeqs = useMemo(() => new Set(projected?.deletedSeqs ?? []), [projected])
  const turns = useMemo(
    () => allTurns.filter((turn) => !hiddenSeqs.has(turn.seq)),
    [allTurns, hiddenSeqs],
  )
  const markerRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pendingLoadSignatureRef = useRef<string | null>(null)
  const noProgressAttemptsRef = useRef(0)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [surfaceAvailable, setSurfaceAvailable] = useState(false)
  const [composerInset, setComposerInset] = useState(176)
  const [autoLoadPaused, setAutoLoadPaused] = useState(false)
  const [loadTick, setLoadTick] = useState(0)
  const [collapsed, setCollapsed] = useState(() => navigationCollapsedPreference)

  useLayoutEffect(() => {
    const root = sessionRoot(markerRef.current)
    setPortalTarget(root)
    if (root === null) return
    const composer = root.querySelector<HTMLElement>('[data-composer-seat]')
    const updateInset = (): void => {
      setComposerInset(Math.max(96, (composer?.offsetHeight ?? 152) + 20))
    }
    updateInset()
    if (composer === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateInset)
    observer.observe(composer)
    return () => { observer.disconnect() }
  }, [props.sessionId])

  useEffect(() => {
    pendingLoadSignatureRef.current = null
    noProgressAttemptsRef.current = 0
    setAutoLoadPaused(false)
  }, [enabled, props.sessionId])

  useEffect(() => {
    if (hasMore) return
    pendingLoadSignatureRef.current = null
    noProgressAttemptsRef.current = 0
    setAutoLoadPaused(false)
  }, [hasMore])

  useEffect(() => {
    if (!enabled) {
      setActiveKey(null)
      setSurfaceAvailable(false)
      return
    }
    let frame: number | null = null
    let scrollport: HTMLElement | null = null

    const schedule = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(recompute)
    }
    const bindScrollport = (next: HTMLElement | null): void => {
      if (next === scrollport) return
      scrollport?.removeEventListener('scroll', schedule)
      scrollport = next
      scrollport?.addEventListener('scroll', schedule, { passive: true })
    }
    const recompute = (): void => {
      frame = null
      const nextScrollport = conversationScrollport(markerRef.current)
      bindScrollport(nextScrollport)
      const flowAvailable = nextScrollport !== null && nextScrollport.querySelector('[data-chat-flow]') !== null
      setSurfaceAvailable(flowAvailable)
      if (nextScrollport === null || !flowAvailable) {
        setActiveKey(null)
        return
      }
      const viewport = nextScrollport.getBoundingClientRect()
      const readingLine = viewport.top + Math.min(120, nextScrollport.clientHeight * 0.24)
      const positions: TurnPosition[] = []
      for (const turn of turns) {
        const row = conversationRow(nextScrollport, turn.key)
        if (row !== null) positions.push({ key: turn.key, top: row.getBoundingClientRect().top })
      }
      setActiveKey(activeTurnAt(positions, readingLine))
    }

    const observer = new MutationObserver(schedule)
    const root = sessionRoot(markerRef.current)
    if (root !== null) observer.observe(root, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    recompute()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      scrollport?.removeEventListener('scroll', schedule)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [enabled, turns])

  useEffect(() => {
    if (!shouldAutoLoadOlder({ enabled, surfaceAvailable, hasMore, loadingOlder, paused: autoLoadPaused })) return
    const pendingSignature = pendingLoadSignatureRef.current
    let delay = 0
    if (pendingSignature !== null) {
      if (pendingSignature === windowSignature) {
        noProgressAttemptsRef.current += 1
        if (noProgressAttemptsRef.current >= MAX_NO_PROGRESS_ATTEMPTS) {
          pendingLoadSignatureRef.current = null
          setAutoLoadPaused(true)
          return
        }
        delay = noProgressAttemptsRef.current * 350
      } else {
        noProgressAttemptsRef.current = 0
      }
      pendingLoadSignatureRef.current = null
    }

    let frame: number | null = null
    let retryTimer: number | null = null
    let requestTimer: number | null = null
    const request = (): void => {
      frame = window.requestAnimationFrame(() => {
        frame = null
        const scrollport = conversationScrollport(markerRef.current)
        const button = scrollport === null ? null : nativeLoadOlderButton(scrollport)
        if (button === null || button.disabled) {
          retryTimer = window.setTimeout(() => { setLoadTick((current) => current + 1) }, 180)
          return
        }
        pendingLoadSignatureRef.current = windowSignature
        button.click()
        retryTimer = window.setTimeout(() => { setLoadTick((current) => current + 1) }, 1600)
      })
    }
    if (delay > 0) requestTimer = window.setTimeout(request, delay)
    else request()
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      if (requestTimer !== null) window.clearTimeout(requestTimer)
    }
  }, [autoLoadPaused, enabled, hasMore, loadTick, loadingOlder, surfaceAvailable, windowSignature])

  useLayoutEffect(() => {
    if (collapsed || activeKey === null) return
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="location"]')
    if (list === null || active === null || active === undefined) return
    const top = active.offsetTop
    const bottom = top + active.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [activeKey, collapsed])

  const retryAutoLoad = (): void => {
    pendingLoadSignatureRef.current = null
    noProgressAttemptsRef.current = 0
    setAutoLoadPaused(false)
    setLoadTick((current) => current + 1)
  }

  const toggleCollapsed = (): void => {
    setCollapsed((current) => {
      navigationCollapsedPreference = !current
      return navigationCollapsedPreference
    })
  }

  const jump = (key: string): void => {
    const scrollport = conversationScrollport(markerRef.current)
    if (scrollport === null) return
    const row = conversationRow(scrollport, key)
    if (row === null) return
    const viewport = scrollport.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const top = scrollOffsetForRow(scrollport.scrollTop, viewport.top, rowRect.top)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scrollport.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' })
    setActiveKey(key)
  }

  const rootStyle = { '--dshmore-conversation-nav-bottom': `${String(composerInset)}px` } as CSSProperties
  const surface = enabled && surfaceAvailable && portalTarget !== null
    ? createPortal(
        <div
          className="dshmore-conversation-nav-root"
          data-collapsed={collapsed ? 'true' : 'false'}
          style={rootStyle}
        >
          <ConversationNavigationMenu
            turns={turns}
            activeKey={activeKey}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            autoLoadPaused={autoLoadPaused}
            collapsed={collapsed}
            onRetry={retryAutoLoad}
            onToggleCollapsed={toggleCollapsed}
            onJump={jump}
            listRef={listRef}
          />
        </div>,
        portalTarget,
      )
    : null

  return (
    <>
      <span ref={markerRef} className="dshmore-conversation-nav-marker" aria-hidden="true" />
      <style>{navigationStyles}</style>
      {surface}
    </>
  )
}

const navigationStyles = `
.dshmore-conversation-nav-marker { display: none; }
.dshmore-conversation-nav-root { position: absolute; z-index: 20; right: 14px; top: 78px; bottom: var(--dshmore-conversation-nav-bottom, 176px); width: min(286px, calc(100% - 40px)); pointer-events: none; display: flex; align-items: flex-start; font-family: var(--dsw-font-family); }
.dshmore-conversation-nav-root[data-collapsed="true"] { bottom: auto; height: 58px; }
.dshmore-conversation-nav-menu { box-sizing: border-box; width: 100%; max-height: min(620px, 100%); min-height: 0; overflow: hidden; pointer-events: auto; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-shadow-lv1, var(--dsw-shadow-lv2)); animation: dshmore-conversation-nav-enter 150ms ease-out; }
.dshmore-conversation-nav-menu[data-collapsed="true"] { height: 58px; max-height: 58px; }
.dshmore-conversation-nav-header { box-sizing: border-box; flex: none; min-height: 58px; padding: 12px 12px 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--dsw-alias-border-l3); }
.dshmore-conversation-nav-menu[data-collapsed="true"] .dshmore-conversation-nav-header { height: 58px; min-height: 58px; padding: 0 12px 0 14px; border-bottom: 0; }
.dshmore-conversation-nav-heading { min-width: 0; }
.dshmore-conversation-nav-title-row { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
.dshmore-conversation-nav-title { font: var(--dsw-font-s-strong-14); }
.dshmore-conversation-nav-compact-status { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-caption); text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; }
.dshmore-conversation-nav-count { margin-top: 2px; color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 16px; text-wrap: pretty; }
.dshmore-conversation-nav-loading-dot { width: 6px; height: 6px; margin-right: 6px; display: inline-block; border-radius: 999px; background: var(--dsw-alias-state-business-primary); vertical-align: 1px; animation: dshmore-conversation-nav-pulse 1.1s ease-in-out infinite; }
.dshmore-conversation-nav-retry { flex: none; min-height: 28px; padding: 4px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; font: inherit; font-size: 11px; }
.dshmore-conversation-nav-retry:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dshmore-conversation-nav-actions { flex: none; display: flex; align-items: center; gap: 6px; }
.dshmore-conversation-nav-toggle { box-sizing: border-box; width: 28px; height: 28px; flex: none; padding: 0; display: grid; place-items: center; border: 0; border-radius: 999px; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; }
.dshmore-conversation-nav-toggle:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dshmore-conversation-nav-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px; scrollbar-width: thin; }
.dshmore-conversation-nav-empty { padding: 18px 12px; color: var(--dsw-alias-label-caption); text-align: center; font-size: 12px; line-height: 18px; text-wrap: pretty; }
.dshmore-conversation-nav-item { box-sizing: border-box; width: 100%; min-height: 46px; padding: 7px 9px; display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: start; gap: 2px; border: 0; border-radius: 9px; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; text-align: left; font-family: inherit; transition: background-color 120ms ease, color 120ms ease; }
.dshmore-conversation-nav-item:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dshmore-conversation-nav-item:focus-visible, .dshmore-conversation-nav-retry:focus-visible, .dshmore-conversation-nav-toggle:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dshmore-conversation-nav-item[aria-current="location"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover-solid); }
.dshmore-conversation-nav-index { color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 20px; font-variant-numeric: tabular-nums; }
.dshmore-conversation-nav-item[aria-current="location"] .dshmore-conversation-nav-index { color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.dshmore-conversation-nav-label { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; text-wrap: pretty; }
@keyframes dshmore-conversation-nav-enter { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: translateX(0); } }
@keyframes dshmore-conversation-nav-pulse { 50% { opacity: .35; transform: scale(.82); } }
@media (max-width: 720px) {
  .dshmore-conversation-nav-root { right: 8px; top: 74px; bottom: auto; width: calc(100% - 16px); height: min(220px, 32dvh); align-items: stretch; }
  .dshmore-conversation-nav-root[data-collapsed="true"] { height: 58px; }
  .dshmore-conversation-nav-menu { max-height: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dshmore-conversation-nav-menu, .dshmore-conversation-nav-loading-dot { animation: none; }
  .dshmore-conversation-nav-item { transition: none; }
}
`

export const clientPatch: ClientPatch = {
  id: CONVERSATION_QUICK_NAVIGATION_PATCH_ID,
  install: (ctx, activation) => {
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: `${PLUGIN_NAME}-${CONVERSATION_QUICK_NAVIGATION_PATCH_ID}`,
      order: 120,
      registrant: PLUGIN_NAME,
    }, (props: HeaderUtilityProps) => <ConversationQuickNavigation {...props} activation={activation} />))
  },
}
