import { createHmac, timingSafeEqual } from 'node:crypto'
import { DshMoreError } from './error.js'

export interface ConfirmationFacts {
  sessionId: string
  startTurn: number
  endTurn: number
  logRevision: number
  replaceGeneration: number
  shadowedSeqs: readonly number[]
  operation?: 'delete-message' | 'edit-message'
  targetSeq?: number
  contentDigest?: string
  continuationSessionId?: string
}

interface ConfirmationPayload extends ConfirmationFacts {
  expiresAt: number
}

function encode(payload: ConfirmationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function signature(secret: Uint8Array, encoded: string): Buffer {
  return createHmac('sha256', secret).update(encoded).digest()
}

export function createConfirmationToken(
  secret: Uint8Array,
  facts: ConfirmationFacts,
  now = Date.now(),
  ttlMs = 5 * 60_000,
): string {
  const encoded = encode({ ...facts, expiresAt: now + ttlMs })
  return `${encoded}.${signature(secret, encoded).toString('base64url')}`
}

export function verifyConfirmationToken(
  secret: Uint8Array,
  token: string,
  expected: ConfirmationFacts,
  now = Date.now(),
): void {
  const [encoded, receivedText, extra] = token.split('.')
  if (encoded === undefined || receivedText === undefined || extra !== undefined) {
    throw new DshMoreError('stale-preview', '确认信息无效，请重新预览。', 409)
  }
  const received = Buffer.from(receivedText, 'base64url')
  const wanted = signature(secret, encoded)
  if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) {
    throw new DshMoreError('stale-preview', '确认信息无效，请重新预览。', 409)
  }

  let payload: ConfirmationPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ConfirmationPayload
  } catch {
    throw new DshMoreError('stale-preview', '确认信息无效，请重新预览。', 409)
  }
  const same = payload.sessionId === expected.sessionId
    && payload.startTurn === expected.startTurn
    && payload.endTurn === expected.endTurn
    && payload.logRevision === expected.logRevision
    && payload.replaceGeneration === expected.replaceGeneration
    && payload.operation === expected.operation
    && payload.targetSeq === expected.targetSeq
    && payload.contentDigest === expected.contentDigest
    && payload.continuationSessionId === expected.continuationSessionId
    && payload.shadowedSeqs.length === expected.shadowedSeqs.length
    && payload.shadowedSeqs.every((seq, index) => seq === expected.shadowedSeqs[index])
  if (!same || !Number.isFinite(payload.expiresAt) || payload.expiresAt < now) {
    throw new DshMoreError('stale-preview', '会话已变化或确认已过期，请重新预览。', 409)
  }
}
