import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { liveSetting, readSettings, settingValue } from '../../src/platform/dsh/host/settings.js'
import z from '@deepseek-ai/schemastery'

describe('settings API adapter', () => {
  it('uses legacy values when a registered settings store exists', () => {
    const value = { enabled: false }
    const ctx = { settings: { get: vi.fn(() => value), describe: vi.fn() } } as unknown as Context
    expect(readSettings(ctx, 'plugin')).toBe(value)
    expect(ctx.settings.describe).not.toHaveBeenCalled()
  })

  it('reads current form values when get() was removed', () => {
    const value = { models: [{ id: 'custom' }] }
    const ctx = { settings: { describe: () => [{ ns: 'llm-deepseek', value }] } } as unknown as Context
    expect(readSettings(ctx, 'llm-deepseek')).toBe(value)
    expect(readSettings(ctx, 'missing')).toBeUndefined()
  })

  it('preserves old schemas and reads only actual references', () => {
    const schema = z.boolean().default(true)
    expect(liveSetting(schema)).toBe(schema)
    expect(settingValue(false)).toBe(false)
    expect(settingValue({ get: () => false })).toBe(false)
    expect(settingValue({ get: 'value' })).toEqual({ get: 'value' })
  })
})
