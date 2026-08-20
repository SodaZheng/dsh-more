import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const packagePath = new URL('package.json', root)
const pluginPath = new URL('dsh.plugin.json', root)
const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'))
const pluginManifest = JSON.parse(await readFile(pluginPath, 'utf8'))

if (pluginManifest.name !== packageManifest.name) {
  throw new Error('Refusing to sync a dsh.plugin.json with a different package name')
}
if (pluginManifest.version !== packageManifest.version) {
  pluginManifest.version = packageManifest.version
  await writeFile(pluginPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`Synchronized dsh.plugin.json to ${packageManifest.version}.\n`)
}
