import { describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  activeTurnAt,
  createConversationTurnSelector,
  historyWindowSignature,
  scrollOffsetForRow,
  shouldAutoLoadOlder,
} from './client/navigation.js'
import { CONVERSATION_QUICK_NAVIGATION_PATCH_ID } from './shared.js'
import { hostPatch } from './host/index.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
  IconChevronUpOutline14: () => null,
}))

function snapshot(order: readonly string[], entries: ReadonlyMap<string, object>): ConversationSnapshot {
  return {
    chat: {
      order,
      nodes: { get: (key: string) => entries.get(key) },
    },
  } as unknown as ConversationSnapshot
}

describe('conversation-quick-navigation patch', () => {
  it('summarizes user-authored turns in rendered order', () => {
    const select = createConversationTurnSelector()
    const longText = '这是一段很长的提问'.repeat(12)
    const value = snapshot(['user-1', 'assistant-1', 'steering-2', 'image-3'], new Map([
      ['user-1', { kind: 'user', data: { seq: 1, content: [{ type: 'text', text: '  第一轮\n问题  ' }] } }],
      ['assistant-1', { kind: 'turn-tail', data: { closing: { finalNode: { seq: 2 }, blocks: [] } } }],
      ['steering-2', { kind: 'steering', data: { seq: 3, content: [{ type: 'text', text: longText }] } }],
      ['image-3', { kind: 'user', data: { seq: 4, content: [{ type: 'image', source: 'test' }] } }],
    ]))

    expect(select(value)).toEqual([
      { key: 'user-1', seq: 1, label: '第一轮 问题' },
      { key: 'steering-2', seq: 3, label: `${[...longText].slice(0, 71).join('')}…` },
      { key: 'image-3', seq: 4, label: '第 3 轮 · 非文本消息' },
    ])
  })

  it('retains selector identity while only assistant streaming changes', () => {
    const select = createConversationTurnSelector()
    const order = ['user-1', 'assistant-1']
    const first = select(snapshot(order, new Map([
      ['user-1', { kind: 'user', data: { seq: 1, content: [{ type: 'text', text: '问题' }] } }],
    ])))
    const second = select(snapshot(order, new Map([
      ['user-1', { kind: 'user', data: { seq: 1, content: [{ type: 'text', text: '问题' }] } }],
      ['assistant-1', { kind: 'partial', data: { text: 'streaming' } }],
    ])))
    expect(second).toBe(first)
  })

  it('chooses the latest turn above the reading line and computes a bounded jump', () => {
    expect(activeTurnAt([
      { key: 'one', top: 80 },
      { key: 'two', top: 240 },
      { key: 'three', top: 480 },
    ], 300)).toBe('two')
    expect(activeTurnAt([], 300)).toBeNull()
    expect(scrollOffsetForRow(360, 100, 250)).toBe(490)
    expect(scrollOffsetForRow(0, 100, 60)).toBe(0)
  })

  it('loads older history only while the native chat surface can advance', () => {
    expect(shouldAutoLoadOlder({
      enabled: true,
      surfaceAvailable: true,
      hasMore: true,
      loadingOlder: false,
      paused: false,
    })).toBe(true)
    expect(shouldAutoLoadOlder({
      enabled: true,
      surfaceAvailable: true,
      hasMore: true,
      loadingOlder: true,
      paused: false,
    })).toBe(false)
    expect(shouldAutoLoadOlder({
      enabled: true,
      surfaceAvailable: false,
      hasMore: true,
      loadingOlder: false,
      paused: false,
    })).toBe(false)
  })

  it('changes the history signature when an older page is prepended', () => {
    const entries = new Map<string, object>()
    expect(historyWindowSignature(snapshot(['middle', 'last'], entries)))
      .not.toBe(historyWindowSignature(snapshot(['first', 'middle', 'last'], entries)))
  })

  it('unmounts the scrollable turn list while the menu is collapsed', async () => {
    const { createElement, createRef } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { ConversationNavigationMenu } = await import('./client/index.js')
    const props = {
      turns: [{ key: 'turn-1', seq: 1, label: '第一轮问题' }],
      activeKey: 'turn-1',
      hasMore: false,
      loadingOlder: false,
      autoLoadPaused: false,
      onRetry: () => undefined,
      onToggleCollapsed: () => undefined,
      onJump: () => undefined,
      listRef: createRef<HTMLDivElement>(),
    }
    const expanded = renderToStaticMarkup(createElement(ConversationNavigationMenu, { ...props, collapsed: false }))
    const collapsed = renderToStaticMarkup(createElement(ConversationNavigationMenu, { ...props, collapsed: true }))
    expect(expanded).toContain('第一轮问题')
    expect(expanded).toContain('aria-label="折叠对话目录"')
    expect(collapsed).not.toContain('第一轮问题')
    expect(collapsed).toContain('aria-label="展开对话目录"')
    expect(collapsed).toContain('1 轮')
  })

  it('keeps the Host registry contract without installing Host side effects', () => {
    expect(hostPatch.id).toBe(CONVERSATION_QUICK_NAVIGATION_PATCH_ID)
    expect(hostPatch.setup).toBeUndefined()
    expect(hostPatch.routes({ ctx: {} as never, confirmationSecret: new Uint8Array(32) }).status?.({})).toEqual({ available: true })
  })

  it('registers a standalone session utility without changing shared entrypoints', async () => {
    const { clientPatch } = await import('./client/index.js')
    let registered: { name?: string; id?: string; component?: unknown } = {}
    const ctx = {
      slots: {
        inject: (name: string, register: () => unknown) => {
          expect(name).toBe('conversation.session.header.utilities')
          void register()
        },
        register: (options: { name?: string; id?: string }, component: unknown) => {
          registered = { ...options, component }
          return () => undefined
        },
      },
    } as never
    clientPatch.install(ctx, {} as never)
    expect(registered.name).toBe('conversation.session.header.utilities')
    expect(registered.id).toContain(CONVERSATION_QUICK_NAVIGATION_PATCH_ID)
    expect(registered.component).toBeTypeOf('function')
  })
})
