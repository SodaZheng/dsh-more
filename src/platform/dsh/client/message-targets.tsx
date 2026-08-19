import { useLayoutEffect, useState } from 'react'
import { contentText } from './message-content.js'
import type { ConversationHeaderProps, MessageTarget } from '../../../kernel/client/message-actions.js'

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

function hostForRow(row: HTMLElement, kind: MessageTarget['kind']): HTMLElement {
  const existing = row.querySelector<HTMLElement>(':scope [data-dshmore-message-actions]')
  if (kind === 'assistant') {
    const turnRoot = row.querySelector<HTMLElement>('[data-turn-tail][data-time-hover-root]')
    const copyButton = turnRoot?.querySelector<HTMLElement>('button[aria-label="复制"], button[aria-label="Copy"]')
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
  const copyButton = row.querySelector<HTMLElement>('button[aria-label="复制"], button[aria-label="Copy"]')
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

function sameTargets(left: readonly MessageTarget[], right: readonly MessageTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index]
    return other !== undefined
      && target.key === other.key
      && target.seq === other.seq
      && target.host === other.host
      && target.text === other.text
  })
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
): readonly MessageTarget[] {
  const snapshot = props.useSession((state) => state)
  const [targets, setTargets] = useState<readonly MessageTarget[]>([])

  useLayoutEffect(() => {
    let frame: number | null = null
    const scan = (): void => {
      frame = null
      const next: MessageTarget[] = []
      for (const row of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
        const key = row.dataset.chatFlowKey
        if (key === undefined) continue
        const node = snapshot.chat.nodes.get(key)
        const seq = presentationSeq(node)
        if (seq !== undefined && hiddenSeqs.has(seq)) {
          row.dataset.dshmoreHidden = ''
          row.style.display = 'none'
          row.querySelector<HTMLElement>('[data-dshmore-message-actions]')?.remove()
          continue
        }
        if (row.dataset.dshmoreHidden !== undefined) {
          delete row.dataset.dshmoreHidden
          row.style.removeProperty('display')
        }
        const info = messageNodeInfo(node)
        if (info !== null) next.push({ key, ...info, host: hostForRow(row, info.kind) })
      }
      for (const row of document.querySelectorAll<HTMLElement>('[data-trajectory-row-key]')) {
        const seq = trajectorySourceSeq(row)
        const key = trajectoryRecordKey(row)
        if ((seq !== undefined && hiddenSeqs.has(seq)) || (key !== undefined && hiddenTrajectoryKeys.has(key))) {
          row.dataset.dshmoreHidden = ''
          row.style.display = 'none'
        } else if (row.dataset.dshmoreHidden !== undefined) {
          delete row.dataset.dshmoreHidden
          row.style.removeProperty('display')
        }
      }
      setTargets((current) => sameTargets(current, next) ? current : next)
    }
    const schedule = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(scan)
    }
    scan()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
      for (const row of document.querySelectorAll<HTMLElement>('[data-dshmore-hidden]')) {
        delete row.dataset.dshmoreHidden
        row.style.removeProperty('display')
      }
      for (const host of document.querySelectorAll<HTMLElement>('[data-dshmore-message-actions]')) host.remove()
    }
  }, [snapshot, hiddenSeqs, hiddenTrajectoryKeys])

  return targets
}
