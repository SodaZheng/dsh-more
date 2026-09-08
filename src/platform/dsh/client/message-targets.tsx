import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { contentText } from './message-content.js'
import type { ConversationHeaderProps, MessageTarget } from '../../../kernel/client/message-actions.js'

export interface MessageSurfaceRow {
  key: string
  presentationSeq: number | undefined
  action: Omit<MessageTarget, 'key' | 'host'> | null
}

export interface MessageSurfaceSnapshot {
  rows: readonly MessageSurfaceRow[]
  byKey: ReadonlyMap<string, MessageSurfaceRow>
}

const EMPTY_MESSAGE_SURFACE: MessageSurfaceSnapshot = {
  rows: [],
  byKey: new Map(),
}

function messageNodeInfo(node: unknown): Omit<MessageTarget, 'key' | 'host'> | null {
  const candidate = node as {
    kind?: unknown
    data?: {
      seq?: unknown
      content?: unknown
      closing?: unknown
    }
  } | undefined
  if (candidate?.kind === 'user' && Number.isSafeInteger(candidate.data?.seq) && Array.isArray(candidate.data?.content)) {
    return {
      seq: candidate.data.seq as number,
      kind: 'user',
      text: contentText(candidate.data.content as Parameters<typeof contentText>[0]),
    }
  }
  const closing = candidate?.data?.closing as {
    finalNode?: { seq?: unknown }
    blocks?: unknown
  } | undefined
  if (candidate?.kind === 'turn-tail' && Number.isSafeInteger(closing?.finalNode?.seq) && Array.isArray(closing?.blocks)) {
    const text = (closing.blocks as Array<{ kind?: unknown; text?: unknown }>)
      .filter((block) => block.kind === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
    return { seq: closing.finalNode?.seq as number, kind: 'assistant', text }
  }
  return null
}

function presentationSeq(node: unknown): number | undefined {
  const candidate = node as { kind?: unknown; data?: Record<string, unknown> } | undefined
  const direct = candidate?.data?.seq
  if (Number.isSafeInteger(direct)) return direct as number
  const finalNode = candidate?.data?.finalNode as { seq?: unknown } | undefined
  if (Number.isSafeInteger(finalNode?.seq)) return finalNode?.seq as number
  const root = candidate?.data?.root as { seq?: unknown } | undefined
  if (Number.isSafeInteger(root?.seq)) return root?.seq as number
  const closing = candidate?.data?.closing as { finalNode?: { seq?: unknown } } | undefined
  if (Number.isSafeInteger(closing?.finalNode?.seq)) return closing?.finalNode?.seq as number
  return undefined
}

function sameSurfaceRow(left: MessageSurfaceRow | undefined, right: MessageSurfaceRow): boolean {
  return left !== undefined
    && left.key === right.key
    && left.presentationSeq === right.presentationSeq
    && left.action?.seq === right.action?.seq
    && left.action?.kind === right.action?.kind
    && left.action?.text === right.action?.text
}

/** Select only facts used by message actions, retaining identity across unrelated stream frames. */
export function createMessageSurfaceSelector(active = true): (snapshot: ChatSnapshot) => MessageSurfaceSnapshot {
  if (!active) return () => EMPTY_MESSAGE_SURFACE
  const nodeCache = new WeakMap<object, MessageSurfaceRow>()
  let previous = EMPTY_MESSAGE_SURFACE

  return (snapshot) => {
    const rows: MessageSurfaceRow[] = []
    for (const key of snapshot.order) {
      const node = snapshot.nodes.get(key)
      if (node === undefined) continue
      let row = nodeCache.get(node)
      if (row === undefined) {
        row = {
          key,
          presentationSeq: presentationSeq(node),
          action: messageNodeInfo(node),
        }
        nodeCache.set(node, row)
      }
      const retained = previous.byKey.get(key)
      rows.push(sameSurfaceRow(retained, row) ? retained as MessageSurfaceRow : row)
    }
    if (rows.length === previous.rows.length && rows.every((row, index) => row === previous.rows[index])) return previous
    previous = { rows, byKey: new Map(rows.map((row) => [row.key, row])) }
    return previous
  }
}

export function hostForRow(row: HTMLElement, kind: MessageTarget['kind']): HTMLElement {
  const existing = row.querySelector<HTMLElement>(':scope [data-dshmore-message-actions]')
  if (kind === 'assistant') {
    const turnRoot = row.querySelector<HTMLElement>('[data-turn-tail][data-actions-reveal]')
    const copyButton = turnRoot?.querySelector<HTMLElement>('button[aria-label="复制"], button[aria-label="Copy"], button[aria-label="已复制"], button[aria-label="Copied"]')
    const builtInActions = copyButton?.parentElement
    const placeBeforeClock = (host: HTMLElement): void => {
      if (builtInActions === undefined || builtInActions === null) return
      const clock = [...builtInActions.children].findLast((child) => {
        return child !== host && child.querySelector('button') === null && (child.textContent?.trim() ?? '') !== ''
      })
      if (clock === undefined) {
        if (host.parentElement !== builtInActions || builtInActions.lastElementChild !== host) builtInActions.appendChild(host)
      } else if (host.parentElement !== builtInActions || host.nextElementSibling !== clock) {
        builtInActions.insertBefore(host, clock)
      }
    }
    if (existing !== null) {
      placeBeforeClock(existing)
      return existing
    }
    const host = document.createElement('span')
    host.dataset.dshmoreMessageActions = ''
    host.className = 'dshmore-inline-actions'
    if (builtInActions !== undefined && builtInActions !== null) placeBeforeClock(host)
    else row.appendChild(host)
    return host
  }
  const copyButton = row.querySelector<HTMLElement>('button[aria-label="复制"], button[aria-label="Copy"], button[aria-label="已复制"], button[aria-label="Copied"]')
  const builtInActions = copyButton?.parentElement
  if (existing !== null) {
    if (builtInActions !== undefined && builtInActions !== null && (existing.parentElement !== builtInActions || existing.nextElementSibling !== copyButton)) {
      builtInActions.insertBefore(existing, copyButton ?? null)
    }
    return existing
  }
  const host = document.createElement('span')
  host.dataset.dshmoreMessageActions = ''
  host.className = 'dshmore-inline-actions'
  if (builtInActions !== undefined && builtInActions !== null) builtInActions.insertBefore(host, copyButton ?? null)
  else row.appendChild(host)
  return host
}

function sameTarget(left: MessageTarget, right: MessageTarget | undefined): boolean {
  return right !== undefined
    && left.key === right.key
    && left.seq === right.seq
    && left.host === right.host
    && left.text === right.text
}

function sameTargets(left: readonly MessageTarget[], right: readonly MessageTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => sameTarget(target, right[index]))
}

function trajectoryRecordKey(row: HTMLElement): string | undefined {
  const encoded = row.dataset.trajectoryRowKey
  if (encoded === undefined) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

function trajectorySourceSeq(row: HTMLElement): number | undefined {
  const decoded = trajectoryRecordKey(row)
  if (decoded === undefined) return undefined
  const marker = '\u0000seq\u0000'
  const at = decoded.lastIndexOf(marker)
  if (at < 0) return undefined
  const raw = decoded.slice(at + marker.length).split('\u0000', 1)[0]
  const seq = Number(raw)
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

export function useMessageTargets(
  props: ConversationHeaderProps,
  hiddenSeqs: ReadonlySet<number>,
  hiddenTrajectoryKeys: ReadonlySet<string>,
  active = true,
): readonly MessageTarget[] {
  const selector = useMemo(() => createMessageSurfaceSelector(active), [active, props.sessionId])
  const surface = props.useChat(selector)
  const surfaceRef = useRef(surface)
  const hiddenSeqsRef = useRef(hiddenSeqs)
  const hiddenTrajectoryKeysRef = useRef(hiddenTrajectoryKeys)
  surfaceRef.current = surface
  hiddenSeqsRef.current = hiddenSeqs
  hiddenTrajectoryKeysRef.current = hiddenTrajectoryKeys
  const [targets, setTargets] = useState<readonly MessageTarget[]>([])
  const requestFullScanRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    if (!active) {
      setTargets((current) => current.length === 0 ? current : [])
      return
    }
    let frame: number | null = null
    let fullScanRequested = true
    let pruneDisconnected = false
    let targetsDirty = false
    const pendingChatRows = new Set<HTMLElement>()
    const pendingTrajectoryRows = new Set<HTMLElement>()
    const mountedTargets = new Map<string, MessageTarget>()

    const processChatRow = (row: HTMLElement): void => {
      const key = row.dataset.chatFlowKey
      if (key === undefined) return
      const descriptor = surfaceRef.current.byKey.get(key)
      if (descriptor === undefined) {
        if (mountedTargets.delete(key)) targetsDirty = true
        row.querySelector<HTMLElement>('[data-dshmore-message-actions]')?.remove()
        return
      }
      if (descriptor.presentationSeq !== undefined && hiddenSeqsRef.current.has(descriptor.presentationSeq)) {
        row.dataset.dshmoreHidden = ''
        if (mountedTargets.delete(key)) targetsDirty = true
        row.querySelector<HTMLElement>('[data-dshmore-message-actions]')?.remove()
        return
      }
      if (row.dataset.dshmoreHidden !== undefined) delete row.dataset.dshmoreHidden
      if (descriptor.action === null) {
        if (mountedTargets.delete(key)) targetsDirty = true
        row.querySelector<HTMLElement>('[data-dshmore-message-actions]')?.remove()
        return
      }
      const next = {
        key,
        ...descriptor.action,
        host: hostForRow(row, descriptor.action.kind),
      }
      const current = mountedTargets.get(key)
      if (current === undefined || !sameTarget(current, next)) {
        mountedTargets.set(key, next)
        targetsDirty = true
      }
    }

    const processTrajectoryRow = (row: HTMLElement): void => {
      const seq = trajectorySourceSeq(row)
      const key = trajectoryRecordKey(row)
      if ((seq !== undefined && hiddenSeqsRef.current.has(seq)) || (key !== undefined && hiddenTrajectoryKeysRef.current.has(key))) {
        row.dataset.dshmoreHidden = ''
      } else if (row.dataset.dshmoreHidden !== undefined) {
        delete row.dataset.dshmoreHidden
      }
    }

    const publishTargets = (): void => {
      for (const [key, target] of mountedTargets) {
        if (!target.host.isConnected && mountedTargets.delete(key)) targetsDirty = true
      }
      const next = surfaceRef.current.rows.flatMap((row) => {
        const target = mountedTargets.get(row.key)
        return target === undefined ? [] : [target]
      })
      setTargets((current) => sameTargets(current, next) ? current : next)
      targetsDirty = false
    }

    const flush = (): void => {
      frame = null
      if (fullScanRequested) {
        fullScanRequested = false
        mountedTargets.clear()
        targetsDirty = true
        for (const row of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) processChatRow(row)
        for (const row of document.querySelectorAll<HTMLElement>('[data-trajectory-row-key]')) processTrajectoryRow(row)
      } else {
        for (const row of pendingChatRows) if (row.isConnected) processChatRow(row)
        for (const row of pendingTrajectoryRows) if (row.isConnected) processTrajectoryRow(row)
      }
      pendingChatRows.clear()
      pendingTrajectoryRows.clear()
      const shouldPrune = pruneDisconnected
      pruneDisconnected = false
      if (targetsDirty || shouldPrune) publishTargets()
    }

    const schedule = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(flush)
    }
    const requestFullScan = (): void => {
      fullScanRequested = true
      schedule()
    }
    const collectRows = (node: Node): void => {
      const element = node instanceof Element ? node : node.parentElement
      if (element === null) return
      const chatAncestor = element.closest<HTMLElement>('[data-chat-flow-key]')
      if (chatAncestor !== null) pendingChatRows.add(chatAncestor)
      const trajectoryAncestor = element.closest<HTMLElement>('[data-trajectory-row-key]')
      if (trajectoryAncestor !== null) pendingTrajectoryRows.add(trajectoryAncestor)
      if (element.matches('[data-chat-flow-key]')) pendingChatRows.add(element as HTMLElement)
      if (element.matches('[data-trajectory-row-key]')) pendingTrajectoryRows.add(element as HTMLElement)
      element.querySelectorAll<HTMLElement>('[data-chat-flow-key]').forEach((row) => pendingChatRows.add(row))
      element.querySelectorAll<HTMLElement>('[data-trajectory-row-key]').forEach((row) => pendingTrajectoryRows.add(row))
    }
    requestFullScanRef.current = requestFullScan
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.removedNodes.length > 0) {
          pruneDisconnected = true
          collectRows(record.target)
        }
        record.addedNodes.forEach(collectRows)
      }
      if (pendingChatRows.size > 0 || pendingTrajectoryRows.size > 0 || pruneDisconnected) schedule()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    flush()
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
      requestFullScanRef.current = null
      for (const row of document.querySelectorAll<HTMLElement>('[data-dshmore-hidden]')) {
        delete row.dataset.dshmoreHidden
      }
      for (const host of document.querySelectorAll<HTMLElement>('[data-dshmore-message-actions]')) host.remove()
    }
  }, [active, props.sessionId])

  useLayoutEffect(() => {
    requestFullScanRef.current?.()
  }, [surface, hiddenSeqs, hiddenTrajectoryKeys])

  return targets
}
