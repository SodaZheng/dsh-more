import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconWarningOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { apiErrorText, callPatchApi } from '../../../platform/dsh/client/api.js'
import type { PatchActivationSource } from '../../../kernel/client/activation.js'
import type { ClientPatch } from '../../../kernel/client/patch.js'
import type { RefreshableSessions, RefreshableWorkspaces } from '../../../platform/dsh/client/runtime.js'
import {
  adjacentVisibleSession,
  openSessionWithoutGap,
  settleSessionRemoval,
} from '../../../platform/dsh/client/session-sync.js'
import { styles } from '../../../platform/dsh/client/styles.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'
import { SESSION_DELETE_PATCH_ID } from '../shared.js'

type OverlayProps = PropsRuntime<'shell.overlay'>

interface PendingSessionDelete {
  sessionId: SessionId
  title: string
  resolve: () => void
}

const DELETE_MENU_ATTRIBUTE = 'data-dshmore-session-delete'
const DELETE_SOURCE_ATTRIBUTE = 'data-dshmore-session-delete-source'
const sessionDeleteStyles = `
.dshmore-session-delete-menu-item { color: var(--dsw-alias-state-error-primary, rgb(220,90,90)) !important; }
`

function replaceExactText(root: Element, before: string, after: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    if (node.nodeValue?.trim() === before) node.nodeValue = node.nodeValue.replace(before, after)
    node = walker.nextNode()
  }
}

/** Add a separate permanent-delete row beside the native archive row. */
export function installSessionDeleteMenuItems(onDelete: (archiveButton: HTMLButtonElement) => void): () => void {
  let frame: number | null = null
  const deleteItems = new Map<HTMLButtonElement, HTMLElement>()
  const pendingButtons = new Set<HTMLButtonElement>()
  const syncButton = (archiveButton: HTMLButtonElement): void => {
    if (!archiveButton.isConnected) return
    const text = archiveButton.textContent?.trim()
    const deleteLabel = text === '归档会话'
      ? '永久删除会话'
      : text === 'Archive session' ? 'Permanently delete session' : undefined
    if (deleteLabel === undefined) return
    const wrapper = archiveButton.parentElement
    if (wrapper === null) return
    if (archiveButton.hasAttribute(DELETE_SOURCE_ATTRIBUTE)) {
      if (deleteItems.get(archiveButton)?.isConnected === true) return
      archiveButton.removeAttribute(DELETE_SOURCE_ATTRIBUTE)
    }
    const clone = wrapper.cloneNode(true) as HTMLElement
    const deleteButton = clone.querySelector<HTMLButtonElement>('button[role="menuitem"]')
    if (deleteButton === null) return
    archiveButton.setAttribute(DELETE_SOURCE_ATTRIBUTE, '')
    clone.setAttribute(DELETE_MENU_ATTRIBUTE, '')
    deleteItems.set(archiveButton, clone)
    replaceExactText(deleteButton, text, deleteLabel)
    deleteButton.setAttribute('aria-label', deleteLabel)
    deleteButton.classList.add('dshmore-session-delete-menu-item')
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      onDelete(archiveButton)
    })
    wrapper.after(clone)
  }
  const collectButtons = (node: Node): void => {
    const element = node instanceof Element ? node : node.parentElement
    if (element === null) return
    const ancestor = element.closest<HTMLButtonElement>('button[role="menuitem"]')
    if (ancestor !== null) pendingButtons.add(ancestor)
    if (element.matches('button[role="menuitem"]')) pendingButtons.add(element as HTMLButtonElement)
    element.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]').forEach((button) => pendingButtons.add(button))
  }
  const flush = (): void => {
    frame = null
    for (const [archiveButton, deleteItem] of deleteItems) {
      if (!archiveButton.isConnected) {
        deleteItem.remove()
        deleteItems.delete(archiveButton)
      } else if (!deleteItem.isConnected) {
        archiveButton.removeAttribute(DELETE_SOURCE_ATTRIBUTE)
        deleteItems.delete(archiveButton)
        pendingButtons.add(archiveButton)
      }
    }
    for (const button of pendingButtons) syncButton(button)
    pendingButtons.clear()
  }
  const schedule = (): void => {
    if (frame !== null) return
    frame = window.requestAnimationFrame(flush)
  }
  document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]').forEach((button) => pendingButtons.add(button))
  flush()
  const observer = new MutationObserver((records) => {
    let removedKnownItem = false
    for (const record of records) {
      record.addedNodes.forEach(collectButtons)
      if (record.removedNodes.length > 0 && deleteItems.size > 0) removedKnownItem = true
    }
    if (pendingButtons.size > 0 || removedKnownItem) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    if (frame !== null) window.cancelAnimationFrame(frame)
    document.querySelectorAll(`[${DELETE_MENU_ATTRIBUTE}]`).forEach((node) => { node.remove() })
    document.querySelectorAll(`[${DELETE_SOURCE_ATTRIBUTE}]`).forEach((node) => { node.removeAttribute(DELETE_SOURCE_ATTRIBUTE) })
  }
}

function SessionDeleteController(props: OverlayProps & {
  ctx: ClientContext
  activation: PatchActivationSource
}): JSX.Element | null {
  const settings = useSyncExternalStore(props.activation.subscribe, props.activation.getSnapshot)
  const enabled = settings[SESSION_DELETE_PATCH_ID]
  const [pending, setPending] = useState<PendingSessionDelete | null>(null)
  const pendingRef = useRef<PendingSessionDelete | null>(null)
  const deleteIntentRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const workspaces = (props.ctx as unknown as { workspaces: RefreshableWorkspaces }).workspaces
    const sessions = (props.ctx as unknown as { sessions: RefreshableSessions }).sessions
    const mutable = workspaces as unknown as { archiveSession: (sessionId: SessionId) => Promise<void> }
    const original = mutable.archiveSession
    mutable.archiveSession = (sessionId) => {
      if (!deleteIntentRef.current) return original.call(mutable, sessionId)
      deleteIntentRef.current = false
      return new Promise<void>((resolve) => {
        const request = {
          sessionId,
          title: sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? String(sessionId),
          resolve,
        }
        pendingRef.current?.resolve()
        pendingRef.current = request
        setError(null)
        setPending(request)
      })
    }
    const removeDeleteItems = installSessionDeleteMenuItems((archiveButton) => {
      deleteIntentRef.current = true
      archiveButton.click()
      queueMicrotask(() => { deleteIntentRef.current = false })
    })
    return () => {
      mutable.archiveSession = original
      removeDeleteItems()
      deleteIntentRef.current = false
      pendingRef.current?.resolve()
      pendingRef.current = null
    }
  }, [props.ctx, enabled])

  const close = (): void => {
    if (busy) return
    pending?.resolve()
    pendingRef.current = null
    setPending(null)
    setError(null)
  }

  const commit = async (): Promise<void> => {
    if (pending === null) return
    setBusy(true)
    setError(null)
    const sessions = (props.ctx as unknown as { sessions: RefreshableSessions }).sessions
    const workspaces = (props.ctx as unknown as { workspaces: RefreshableWorkspaces }).workspaces
    const fallbackSessionId = adjacentVisibleSession(
      sessions.list.getSnapshot(),
      workspaces.list.getSnapshot(),
      pending.sessionId,
    )
    if (fallbackSessionId !== undefined) openSessionWithoutGap(sessions, fallbackSessionId)
    try {
      await callPatchApi(SESSION_DELETE_PATCH_ID, 'commit', {
        sessionId: pending.sessionId,
        confirmSessionId: pending.sessionId,
      })
      await settleSessionRemoval(sessions, workspaces, pending.sessionId)
      pending.resolve()
      pendingRef.current = null
      setPending(null)
    } catch (caught) {
      setError(apiErrorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const title = pending?.title ?? ''
  if (!enabled) return null
  return (
    <>
      <style>{styles + sessionDeleteStyles}</style>
      <Modal
        open={pending !== null}
        onClose={close}
        title="永久删除会话？"
        closeLabel="关闭"
        description="会话会从左侧列表和 DSH 持久化目录中永久删除，不会归档，也不会移入回收目录。"
        footer={(
          <>
            <Button variant="ghost" disabled={busy} onClick={close}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => void commit()}>
              {busy ? '正在删除…' : '永久删除'}
            </Button>
          </>
        )}
      >
        <div className="dshmore-dialog-body">
          <div className="dshmore-message-preview">{title}</div>
          <div className="dshmore-danger"><IconWarningOutline16 size={16} /> 若会话正在运行，将先停止当前任务。删除后无法恢复。</div>
          {error !== null && <div className="dshmore-error">{error}</div>}
        </div>
      </Modal>
    </>
  )
}

export const clientPatch: ClientPatch = {
  id: SESSION_DELETE_PATCH_ID,
  install: (ctx, activation) => {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: `${PLUGIN_NAME}-${SESSION_DELETE_PATCH_ID}`,
      order: 90,
    }, (props: OverlayProps) => <SessionDeleteController {...props} ctx={ctx} activation={activation} />))
  },
}
