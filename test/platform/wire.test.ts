import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DshMoreError } from '../../src/platform/dsh/host/error.js'
import {
  readJson,
  requireJsonContentType,
  writeError,
} from '../../src/platform/dsh/host/wire.js'

function request(body: string, contentType = 'application/json'): IncomingMessage {
  return {
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  } as unknown as IncomingMessage
}

function response(): {
  res: ServerResponse
  status: () => number | undefined
  body: () => unknown
} {
  let status: number | undefined
  let body: unknown
  const res = {
    writeHead: (nextStatus: number) => { status = nextStatus; return res },
    end: (value: string) => { body = JSON.parse(value) as unknown; return res },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => body }
}

describe('patch API wire boundary', () => {
  it('accepts JSON with parameters and rejects other media types', () => {
    expect(() => requireJsonContentType(request('{}', 'application/json; charset=utf-8'))).not.toThrow()
    expect(() => requireJsonContentType(request('{}', 'text/plain'))).toThrowError(
      expect.objectContaining<Partial<DshMoreError>>({ code: 'unsupported-media-type', status: 415 }),
    )
  })

  it('reports an oversized body as 413', async () => {
    await expect(readJson(request('x'.repeat(64 * 1024 + 1)))).rejects.toThrowError(
      expect.objectContaining<Partial<DshMoreError>>({ code: 'payload-too-large', status: 413 }),
    )
  })

  it('does not expose unexpected internal error details to the browser', () => {
    const target = response()
    writeError(target.res, new Error('private path /Users/example/session.jsonl'))
    expect(target.status()).toBe(500)
    expect(target.body()).toEqual({
      ok: false,
      error: { code: 'internal', message: '内部错误，请重试或查看 DSH 日志。' },
    })
    expect(JSON.stringify(target.body())).not.toContain('/Users/example')
  })

  it('preserves intentional user-facing errors', () => {
    const target = response()
    writeError(target.res, new DshMoreError('session-busy', '会话仍在运行。', 409))
    expect(target.status()).toBe(409)
    expect(target.body()).toEqual({
      ok: false,
      error: { code: 'session-busy', message: '会话仍在运行。' },
    })
  })
})
