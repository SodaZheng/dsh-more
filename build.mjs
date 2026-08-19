import { readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

await import('./scripts/generate-patch-registry.mjs')

const root = new URL('.', import.meta.url)
const dist = new URL('./dist', root)
const packageManifest = JSON.parse(await readFile(new URL('./package.json', root), 'utf8'))
if (typeof packageManifest.name !== 'string' || packageManifest.name === '') {
  throw new Error('package.json must define a package name')
}

await rm(dist, { recursive: true, force: true })

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', (code) => {
    if (code === 0) resolve()
    else reject(new Error(`tsc exited with code ${String(code)}`))
  })
})

await Promise.all([
  build({
    entryPoints: ['./src/index.ts'],
    outfile: './dist/index.js',
    absWorkingDir: root.pathname,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
  }),
  build({
    entryPoints: ['./src/client/index.tsx'],
    outfile: './dist/client.js',
    absWorkingDir: root.pathname,
    bundle: true,
    packages: 'external',
    platform: 'browser',
    format: 'cjs',
    target: ['es2022'],
    jsx: 'automatic',
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageManifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: {
      js: `return module.exports; } });`,
    },
  }),
])

const clientSource = await readFile(new URL('./dist/client.js', root), 'utf8')
const clientModules = [...clientSource.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
const injected = packageManifest.dsh?.client?.inject
if (!Array.isArray(injected) || !injected.every((name) => typeof name === 'string')) {
  throw new Error('package.json must define dsh.client.inject as a string array')
}
const shellModules = new Set(['react', 'react-dom', 'react/jsx-runtime'])
const missing = [...new Set(clientModules)].filter((name) => {
  return !shellModules.has(name) && !injected.some((seed) => name === seed || name.startsWith(`${seed}/`))
})
if (missing.length > 0) {
  throw new Error(`client bundle requires modules missing from dsh.client.inject: ${missing.join(', ')}`)
}
