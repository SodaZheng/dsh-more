import type { IncomingMessage } from 'node:http'
import { PLUGIN_MUTATION_HEADER } from '../identity.js'

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function trustedAuthority(host: URL, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) return false
    return parsed.port === '' ? parsed.hostname === host.hostname : parsed.host === host.host
  })
}

/** Same trust boundary as DSH's local API, plus a non-simple custom header. */
export function isTrustedMutationRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  if (header(req, PLUGIN_MUTATION_HEADER) !== '1') return false
  const hostText = header(req, 'host')
  if (hostText === undefined) return false
  const host = parseAuthority(hostText)
  if (host === undefined || (!isLoopback(host.hostname) && !trustedAuthority(host, trustedHosts))) return false
  if (header(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}
