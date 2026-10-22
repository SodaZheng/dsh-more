import { describe, expect, it, vi } from 'vitest'
import { clientPatch } from '../../src/patches/fast-mode/client/index.js'
import { DEFAULT_PATCH_SETTINGS } from '../../src/generated/patch-catalog.js'
import { callPatchApi } from '../../src/platform/dsh/client/api.js'

vi.mock('../../src/platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(async () => ({ enabled: true })) }))

describe('/fast command activation', () => {
  it('checks live activation and subagent status without reinstalling the command', () => {
    let enabled = false
    const register = vi.fn()
    const ctx = {
      slots: { inject: vi.fn() },
      commandUi: { register },
      sessions: { subagentAddress: (id: string) => id === 'subagent' ? {} : undefined },
      effect: (effect: () => unknown) => effect(),
    }
    const activation = { getSnapshot: () => ({ ...DEFAULT_PATCH_SETTINGS, 'fast-mode': enabled }), subscribe: () => () => {} }
    clientPatch.install(ctx as never, activation as never)
    expect(register).toHaveBeenCalledOnce()
    const command = register.mock.calls[0]![0]
    const session = { sessionId: 'fast-command-main' }
    expect(command.available(session)).toBe(false)
    command.ui.run(session)
    expect(callPatchApi).not.toHaveBeenCalled()
    enabled = true
    expect(command.available(session)).toBe(true)
    expect(command.available({ sessionId: 'subagent' })).toBe(false)
    command.ui.run(session)
    expect(callPatchApi).toHaveBeenCalledExactlyOnceWith('fast-mode', 'toggle', { sessionId: session.sessionId })
    enabled = false
    expect(command.available(session)).toBe(false)
    command.ui.run({ sessionId: 'disabled-other-session' })
    expect(callPatchApi).toHaveBeenCalledOnce()
  })
})
