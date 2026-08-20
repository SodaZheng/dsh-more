import type { IncomingMessage, ServerResponse } from 'node:http'
import { DshMoreError } from './error.js'

const MAX_BODY_BYTES = 64 * 1024

export function requireJsonContentType(req: IncomingMessage): void {
  const value = req.headers['content-type']
  const contentType = (Array.isArray(value) ? value[0] : value)?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new DshMoreError('unsupported-media-type', '请求必须使用 application/json。', 415)
  }
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new DshMoreError('payload-too-large', '请求内容过大。', 413)
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DshMoreError('bad-request', '请求不是有效的 JSON。')
  }
}

export function requireString(value: unknown, key: string): string {
  const found = (value as Record<string, unknown> | null)?.[key]
  if (typeof found !== 'string' || found === '') throw new DshMoreError('bad-request', `缺少 ${key}。`)
  return found
}

export function requireInteger(value: unknown, key: string): number {
  const found = (value as Record<string, unknown> | null)?.[key]
  if (!Number.isSafeInteger(found)) throw new DshMoreError('bad-request', `${key} 必须是整数。`)
  return found as number
}

function write(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

export function writeOk(res: ServerResponse, value: unknown): void {
  write(res, 200, { ok: true, value })
}

export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof DshMoreError) {
    write(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  write(res, 500, { ok: false, error: { code: 'internal', message: '内部错误，请重试或查看 DSH 日志。' } })
}
