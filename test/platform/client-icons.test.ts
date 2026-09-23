import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const names = [
  ['IconEditOutline16', 'IconEditOutlineRegular'],
  ['IconTrashOutline16', 'IconTrashOutlineRegular'],
  ['IconDownloadOutline16', 'IconDownloadOutlineRegular'],
  ['IconWarningOutline16', 'IconWarningOutlineRegular'],
  ['IconChevronDownOutline14', 'IconChevronDownOutlineRegular'],
] as const

afterEach(() => {
  vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
  vi.resetModules()
})

describe('DSH icon export compatibility', () => {
  it.each(['legacy', 'current'] as const)('renders every used icon with only %s exports available', async (version) => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => Object.fromEntries(names.map(([legacy, current]) => {
      const name = version === 'current' ? current : legacy
      return [name, ({ size, className }: { size: number; className: string }) => createElement('svg', { width: size, className, 'data-icon': name })]
    })))
    const icons = await import('../../src/platform/dsh/client/icons.js')
    for (const [legacy, current] of names) {
      const html = renderToStaticMarkup(createElement(icons[legacy], { size: 14, className: 'test-icon' }))
      expect(html).toContain(`data-icon="${version === 'current' ? current : legacy}"`)
      expect(html).toContain('width="14"')
      expect(html).toContain('class="test-icon"')
    }
  })
})
