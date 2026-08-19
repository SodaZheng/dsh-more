import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_PATCH_SETTINGS, PATCH_CATALOG } from '../../src/generated/patch-catalog.js'
import { HOST_PATCHES } from '../../src/generated/host-registry.js'

const runtime = { ctx: {} as Context, confirmationSecret: new Uint8Array(32) }

describe('patch registry contract', () => {
  it('keeps generated catalog, settings, and Host registry aligned', () => {
    const ids = PATCH_CATALOG.map((patch) => patch.id)
    expect(HOST_PATCHES.map((patch) => patch.id)).toEqual(ids)
    expect(Object.keys(DEFAULT_PATCH_SETTINGS)).toEqual(ids)
    expect(PATCH_CATALOG.every((patch) => patch.clientKind === 'message-action' || patch.clientKind === 'standalone')).toBe(true)
    expect(Object.values(DEFAULT_PATCH_SETTINGS).every((enabled) => typeof enabled === 'boolean')).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps every API action callable through its owning patch', () => {
    for (const patch of HOST_PATCHES) {
      const routes = Object.entries(patch.routes(runtime))
      expect(routes.length).toBeGreaterThan(0)
      expect(routes.every(([action, handler]) => action.length > 0 && typeof handler === 'function')).toBe(true)
    }
  })
})
