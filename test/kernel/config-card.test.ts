import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { PatchConfigCard, type PatchConfigCardProps } from '../../src/kernel/client/config-card.js'
import type { PatchActivationSource } from '../../src/kernel/client/activation.js'
import {
  DEFAULT_PATCH_SETTINGS,
  type PatchSettings,
} from '../../src/generated/patch-catalog.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const react = await import('react')
  return {
    IconChevronDownOutline14: ({ className }: { className?: string }) => react.createElement('svg', { className }),
  }
})

const snapshot: SettingsScopeSnapshot<PatchSettings> = {
  status: 'ready',
  value: DEFAULT_PATCH_SETTINGS,
  base: DEFAULT_PATCH_SETTINGS,
  user: undefined,
  revision: 1,
  writable: true,
  mode: 'host',
}

const activation: PatchActivationSource = {
  getSnapshot: () => DEFAULT_PATCH_SETTINGS,
  getSettingsSnapshot: () => snapshot,
  subscribe: () => () => undefined,
  set: async () => undefined,
}

function render(initiallyOpen: boolean): string {
  return renderToStaticMarkup(createElement(PatchConfigCard, {
    activation,
    initiallyOpen,
  } as PatchConfigCardProps))
}

describe('patch config card', () => {
  it('starts collapsed with disclosure semantics', () => {
    const html = render(false)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('展开设置: DSH More')
    expect(html).not.toContain('编辑并重新开始')
  })

  it('renders patch controls and an open chevron when expanded', () => {
    const html = render(true)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('收起设置: DSH More')
    expect(html).toContain('dshmore-config-chevron-open')
    expect(html).toContain('编辑并重新开始')
    expect(html).toContain('单条消息删除')
    expect(html).toContain('永久删除会话')
  })
})
