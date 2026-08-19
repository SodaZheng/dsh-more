import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isTrustedMutationRequest } from '../../src/platform/dsh/host/trust.js'

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('mutation request trust fence', () => {
  it('accepts the same-origin loopback client with the capability header', () => {
    expect(isTrustedMutationRequest(request({
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'x-dsh-more': '1',
    }), [])).toBe(true)
  })

  it('rejects missing capability header and cross-site requests', () => {
    expect(isTrustedMutationRequest(request({ host: '127.0.0.1:3080' }), [])).toBe(false)
    expect(isTrustedMutationRequest(request({
      host: '127.0.0.1:3080',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
      'x-dsh-more': '1',
    }), [])).toBe(false)
  })

  it('accepts an explicitly trusted LAN authority only with matching origin', () => {
    expect(isTrustedMutationRequest(request({
      host: '192.168.1.8:3080',
      origin: 'http://192.168.1.8:3080',
      'x-dsh-more': '1',
    }), ['192.168.1.8'])).toBe(true)
    expect(isTrustedMutationRequest(request({
      host: '192.168.1.9:3080',
      origin: 'http://192.168.1.9:3080',
      'x-dsh-more': '1',
    }), ['192.168.1.8'])).toBe(false)
  })
})
