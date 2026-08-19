export type DshMoreErrorCode =
  | 'bad-request'
  | 'forbidden'
  | 'method-not-allowed'
  | 'not-found'
  | 'session-not-live'
  | 'session-busy'
  | 'invalid-turn-range'
  | 'selection-empty'
  | 'stale-preview'
  | 'patch-disabled'
  | 'internal'

export class DshMoreError extends Error {
  constructor(
    readonly code: DshMoreErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'DshMoreError'
  }
}
