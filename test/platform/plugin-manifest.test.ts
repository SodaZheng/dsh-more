import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { inject } from '../../src/index.js'

it('keeps Host injection declarations aligned without requiring retired services', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../dsh.plugin.json', import.meta.url), 'utf8'))
  expect(new Set(manifest.entry.inject)).toEqual(new Set(inject))
  expect(inject).toContain('connection')
  expect(inject).not.toContain('webRuntime')
})

it('pins every DSH development package to the verified 0.2.1-rc.2 SDK', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const sdk = Object.entries(manifest.devDependencies).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  expect(sdk.length).toBeGreaterThan(20)
  for (const [name, version] of sdk) expect(version, name).toBe('0.2.1-rc.2')
})
