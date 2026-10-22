import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCommand } from './npm-command.mjs'
import { discoverDesktop, discoverRuntime, directoryLinkType } from './desktop-runtime-paths.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const execute = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}
const temporary = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-more 脚本 # % &-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

test('Windows release resolves npm JS beside Node without a command shell', () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe"
  const cli = win32.join(win32.dirname(execPath), 'node_modules/npm/bin/npm-cli.js')
  const args = ['version', 'patch', '--message=chore(release): v%s']
  assert.deepEqual(npmCommand(args, { platform: 'win32', execPath, env: {}, exists: (p) => p === cli }), {
    command: execPath, args: [cli, ...args],
  })
})

test('Windows pnpm invocation finds npm through case-insensitive quoted PATH', () => {
  const cli = "D:\\工具 & npm\\node_modules\\npm\\bin\\npm-cli.js"
  const invocation = npmCommand(['--version'], {
    platform: 'win32', execPath: "C:\\node\\node.exe",
    env: { npm_execpath: "D:\\pnpm\\pnpm.cjs", Path: "\"D:\\工具 & npm\";C:\\other" },
    exists: (p) => p === cli,
  })
  assert.equal(invocation.args[0], cli)
  assert.throws(() => npmCommand([], { platform: 'win32', env: {}, exists: () => false }), /Cannot find npm-cli/)
})

test('npm invocation preserves spaces, quotes, percent and shell metacharacters', async (t) => {
  const root = await temporary(t)
  const cli = join(root, 'npm-cli.js')
  await writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2)))')
  const args = ['version', '--message=chore(release): v%s', 'a & b', '%PATH%', '^|<>', 'quoted "value"', '中文']
  const invocation = npmCommand(args, { platform: 'win32', env: { npm_execpath: cli } })
  assert.deepEqual(JSON.parse(execute(invocation.command, invocation.args)), args)
})

test('installed npm executes without shell on this platform', () => {
  const invocation = npmCommand(['--version'])
  assert.match(execute(invocation.command, invocation.args).trim(), /^\d+\.\d+\.\d+/)
})

test('Windows Desktop discovers per-user and machine installations', () => {
  for (const [env, root] of [
    [{ LOCALAPPDATA: "C:\\Users\\测试 用户\\AppData\\Local" }, "C:\\Users\\测试 用户\\AppData\\Local\\Programs\\DeepSeek Harness"],
    [{ ProgramFiles: "C:\\Program Files" }, "C:\\Program Files\\DeepSeek Harness"],
  ]) {
    const executable = win32.join(root, 'DeepSeek Harness.exe')
    const desktop = discoverDesktop({ platform: 'win32', env, fileExists: (p) => p === executable })
    assert.equal(desktop.executable, executable)
    assert.deepEqual(desktop.runtimeCandidates, ['app.asar', 'app'].map((p) => win32.join(root, 'resources', p, 'dsh')))
  }
})

test('explicit Windows Desktop directory, executable and UNC paths are literal', () => {
  for (const root of ["D:\\测试 # % &\\DeepSeek Harness", "\\\\server\\share\\DeepSeek Harness"]) {
    const executable = win32.join(root, 'DeepSeek Harness.exe')
    for (const override of [root, executable]) {
      assert.equal(discoverDesktop({ platform: 'win32', env: { DSH_MORE_DESKTOP_APP: override }, fileExists: (p) => p === executable }).executable, executable)
    }
  }
})

test('explicit missing Desktop fails instead of using another installation', () => {
  assert.throws(() => discoverDesktop({ platform: 'win32', env: { DSH_MORE_DESKTOP_APP: "D:\\missing", ProgramFiles: "C:\\Program Files" }, fileExists: (p) => p.startsWith('C:') }), /DSH_MORE_DESKTOP_APP/)
  assert.throws(() => discoverDesktop({ platform: 'linux', env: {}, fileExists: () => false }), /--sdk/)
})

test('macOS app discovery remains supported', () => {
  const executable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
  const desktop = discoverDesktop({ platform: 'darwin', env: {}, fileExists: (p) => p === executable })
  assert.equal(desktop.executable, executable)
  assert.equal(desktop.runtimeCandidates[0], '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh')
})

test('runtime discovery checks packaged and unpacked layouts', async (t) => {
  const root = await temporary(t)
  const runtimeCandidates = ['app.asar', 'app'].map((p) => join(root, p, 'dsh'))
  assert.throws(() => discoverRuntime({ runtimeCandidates }), /runtime not found/)
  const anchor = join(runtimeCandidates[1], 'node_modules/@deepseek-ai/dsh/package.json')
  await mkdir(dirname(anchor), { recursive: true })
  await writeFile(anchor, '{}')
  assert.equal(discoverRuntime({ runtimeCandidates }), runtimeCandidates[1])
})

test('directory links work without Windows symlink privilege and preserve target on cleanup', async (t) => {
  const root = await temporary(t)
  const target = join(root, 'target')
  const profile = join(root, 'profile')
  await mkdir(target)
  await mkdir(profile)
  await writeFile(join(target, 'sentinel'), 'keep')
  assert.equal(directoryLinkType('win32'), 'junction')
  await symlink(target, join(profile, 'plugin'), directoryLinkType())
  assert.equal(await readFile(join(profile, 'plugin/sentinel'), 'utf8'), 'keep')
  await rm(profile, { recursive: true, force: true })
  assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'keep')
})

test('real build runs from an encoded path independently of caller cwd', async (t) => {
  const root = await temporary(t)
  for (const name of ['build.mjs', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'src']) {
    await cp(join(project, name), join(root, name), { recursive: true })
  }
  await mkdir(join(root, 'scripts'))
  await cp(join(project, 'scripts/generate-patch-registry.mjs'), join(root, 'scripts/generate-patch-registry.mjs'))
  await symlink(resolve(project, 'node_modules'), join(root, 'node_modules'), directoryLinkType())
  execute(process.execPath, [join(root, 'build.mjs')], { cwd: tmpdir() })
  assert.match(await readFile(join(root, 'dist/client.js'), 'utf8'), /__ModuleLoader__/)
  assert.ok((await readFile(join(root, 'dist/index.js'), 'utf8')).length > 0)
  assert.doesNotMatch(await readFile(join(root, 'src/generated/client-registry.ts'), 'utf8'), /from "[^"\n]*\\/)
})
