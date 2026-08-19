import { describe, expect, it } from 'vitest'
import { createConfirmationToken, verifyConfirmationToken, type ConfirmationFacts } from '../../src/platform/dsh/host/confirmation.js'
import { DshMoreError } from '../../src/platform/dsh/host/error.js'

const facts: ConfirmationFacts = {
  sessionId: 'session-1',
  startTurn: 2,
  endTurn: 3,
  logRevision: 42,
  replaceGeneration: 1,
  shadowedSeqs: [7, 9, 11],
}

describe('confirmation token', () => {
  it('accepts the exact preview facts before expiry', () => {
    const secret = Buffer.alloc(32, 7)
    const token = createConfirmationToken(secret, facts, 1_000, 5_000)
    expect(() => verifyConfirmationToken(secret, token, facts, 5_999)).not.toThrow()
  })

  it('rejects a changed session revision', () => {
    const secret = Buffer.alloc(32, 7)
    const token = createConfirmationToken(secret, facts, 1_000, 5_000)
    expect(() => verifyConfirmationToken(secret, token, { ...facts, logRevision: 43 }, 2_000)).toThrowError(
      expect.objectContaining<Partial<DshMoreError>>({ code: 'stale-preview' }),
    )
  })

  it('binds edit confirmations to the target and edited content', () => {
    const secret = Buffer.alloc(32, 9)
    const editFacts: ConfirmationFacts = {
      ...facts,
      operation: 'edit-message',
      targetSeq: 7,
      contentDigest: 'digest-a',
    }
    const token = createConfirmationToken(secret, editFacts, 1_000, 5_000)
    expect(() => verifyConfirmationToken(secret, token, { ...editFacts, contentDigest: 'digest-b' }, 2_000)).toThrowError(
      expect.objectContaining<Partial<DshMoreError>>({ code: 'stale-preview' }),
    )
  })

  it('binds a continuation confirmation to its preallocated session', () => {
    const secret = Buffer.alloc(32, 10)
    const continuationFacts: ConfirmationFacts = {
      ...facts,
      operation: 'delete-message',
      targetSeq: 7,
      continuationSessionId: 'session-child-a',
    }
    const token = createConfirmationToken(secret, continuationFacts, 1_000, 5_000)
    expect(() => verifyConfirmationToken(secret, token, {
      ...continuationFacts,
      continuationSessionId: 'session-child-b',
    }, 2_000)).toThrowError(
      expect.objectContaining<Partial<DshMoreError>>({ code: 'stale-preview' }),
    )
  })

  it('rejects expiry and signature tampering', () => {
    const secret = Buffer.alloc(32, 7)
    const token = createConfirmationToken(secret, facts, 1_000, 5_000)
    expect(() => verifyConfirmationToken(secret, token, facts, 6_001)).toThrowError(DshMoreError)
    expect(() => verifyConfirmationToken(secret, `${token}x`, facts, 2_000)).toThrowError(DshMoreError)
  })
})
