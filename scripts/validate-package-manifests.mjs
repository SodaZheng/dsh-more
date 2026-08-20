import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const packageManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const pluginManifest = JSON.parse(await readFile(new URL('dsh.plugin.json', root), 'utf8'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(pluginManifest.name === packageManifest.name, 'dsh.plugin.json name must match package.json')
assert(pluginManifest.version === packageManifest.version, 'dsh.plugin.json version must match package.json')
assert(pluginManifest.entry?.name === packageManifest.name, 'dsh.plugin.json entry.name must match package.json')
assert(packageManifest.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json must expose the bundle patch')
assert(packageManifest.dsh?.client?.platform === pluginManifest.client?.platform, 'Host and plugin client platforms must match')

const publishedFiles = new Set(packageManifest.files)
for (const path of ['dist', 'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'README.zh-CN.md', 'LICENSE']) {
  assert(publishedFiles.has(path), `package.json files must include ${path}`)
}

const inject = pluginManifest.entry?.inject
assert(Array.isArray(inject) && inject.length > 0, 'dsh.plugin.json entry.inject must be a non-empty array')
assert(inject.every((name) => typeof name === 'string' && name !== ''), 'dsh.plugin.json entry.inject must contain service names')
assert(new Set(inject).size === inject.length, 'dsh.plugin.json entry.inject must not contain duplicates')

process.stdout.write('Package manifests are aligned.\n')
