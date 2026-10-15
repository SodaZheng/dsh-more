// Exercise the installed Desktop Host in an isolated home, with a local fake
// model. No user profile, credentials, conversation, or upstream API is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const project = resolve(dirname(script), '..')
const app = process.env.DSH_MORE_DESKTOP_APP ?? '/Applications/DeepSeek Harness.app'
if (process.versions.electron === undefined) {
  const child = spawn(join(app, 'Contents/MacOS/DeepSeek Harness'), ['--expose-internals', script], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1 })
  child.once('exit', (code) => { process.exitCode = code ?? 1 })
} else {
  await checkDesktop()
}

async function checkDesktop() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-more-desktop-check-'))
  process.env.DSH_HOME = root
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const runtime = join(app, 'Contents/Resources/app.asar/dsh')
  const native = (name, file = 'lib/index.js') => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, file)))
  const version = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
  const { loadProfileDirectory, loadLayeredEnv } = await native('dsh-app-boot')
  const { runProfile } = await native('dsh', 'lib/profile-boot.js')
  const { createUserMessage, createAssistantMessage } = await native('dsh-llm')
  const dir = join(root, 'profiles/test')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(project, join(dir, 'node_modules/dsh-more'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-more-desktop-check', private: true,
    dependencies: { 'dsh-more': `link:${project}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-more'] } },
  }))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
  const installAnchor = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
  const profile = loadProfileDirectory('dsh', dir, installAnchor)
  // The Host normally prints a login capability. It is unnecessary for these
  // plugin API checks and must not enter test logs.
  const log = console.log
  console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args) }
  let ctx
  try {
    ;({ ctx } = await runProfile({
      environment: loadLayeredEnv('dsh'), profile: 'desktop',
      resolvedProfile: { profile, installAnchor }, patchFiles: [], args: ['--no-open', '--port', '0'],
    }))
    assert.deepEqual(profile.skippedBundles ?? [], [], 'A skipped bundle is a compatibility failure')
    if (ctx.get('connection')?.fetch !== undefined) {
      assert.ok(ctx.get('connection').fetchRoutes.has('/api/dsh-more/projectless-tasks/prepare'), 'Plugin must use the native Fetch registry, not an HTTP-only route')
    }
    const origin = `http://127.0.0.1:${ctx.webServer.port}`
    const base = `${origin}/api/dsh-more`
    const login = ctx.get('connection')?.authenticatedUrl?.(origin)
    const auth = login === undefined ? undefined : await fetch(login, { redirect: 'manual' })
    const cookie = auth?.headers.get('set-cookie')?.split(';', 1)[0]
    if (login !== undefined) {
      assert.ok(cookie, 'Native API tests must authenticate, never bypass the browser-session boundary')
      const denied = await fetch(`${base}/projectless-tasks/prepare`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-more': '1' }, body: '{}',
      })
      assert.equal(denied.status, 401, 'Unauthenticated callers must not reach plugin mutations')
    }
    const call = async (patch, action, payload, expectedStatus = 200) => {
      const response = await fetch(`${base}/${patch}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-more': '1', ...(cookie === undefined ? {} : { cookie }) }, body: JSON.stringify(payload),
      })
      const text = await response.text()
      assert.ok(response.headers.get('content-type')?.startsWith('text/markdown') || response.headers.get('content-type')?.includes('json'), `${patch}/${action}: HTTP ${response.status}: ${text.slice(0, 300)}`)
      const body = response.headers.get('content-type')?.startsWith('text/markdown') ? text : JSON.parse(text)
      assert.equal(response.status, expectedStatus, JSON.stringify(body))
      if (expectedStatus !== 200) return body
      if (typeof body === 'string') return body
      assert.equal(body.ok, true, JSON.stringify(body))
      return body.value
    }
    const modelInfo = (provider, id) => ({ provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 32768 }, defaultMaxTokens: 256 })
    const calls = []
    ctx.llm.registerAdapter(['dsh-more-test'], {
      providerInfo: (id) => ({ id, name: 'DSH More test' }), providerRetryPolicy: () => undefined,
      resolveModel: async (provider, id) => modelInfo(provider, id), listModels: () => [modelInfo('dsh-more-test', 'test')],
      prepareCall: async (provider, id) => ({
        model: modelInfo(provider, id),
        stream: async function* (options) {
          calls.push(options)
          const text = '任务 · 验证桌面插件兼容性'
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    const cwd = join(root, 'task')
    await mkdir(cwd)
    const id = 'task-11111111-1111-4111-8111-111111111111'
    const location = await call('projectless-tasks', 'prepare', { sessionId: id })
    assert.equal(location.sessionId, id)
    const created = await ctx.sessionController.create({ sessionId: id, cwd })
    assert.equal(created.sessionId, id)
    const session = ctx.sessions.get(id)
    await ctx.sessionController.selectModel({ sessionId: id, provider: 'dsh-more-test', model: 'test' })
    const addTurn = (turn, text) => {
      session.append('request/header', { reason: 'initial', header: { config: { provider: 'dsh-more-test', model: 'test' } } })
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const assistant = session.append('assistant/message', { stream: [], turn, step: 1, message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn}` }], source: { provider: 'dsh-more-test', model: 'test' },
      }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return { userSeq: user.seq, assistantSeq: assistant.seq }
    }
    const first = addTurn(1, 'desktop test one')
    const second = addTurn(2, 'desktop test two')
    const original = session.snapshotEvents()
    const markdown = await call('conversation-markdown-export', 'render', { sessionId: id, title: 'Desktop test' })
    assert.match(markdown, /desktop test one/)
    assert.match(markdown, /answer 2/)
    const deletion = { sessionId: id, targetSeq: second.assistantSeq }
    const preview = await call('message-delete', 'preview', deletion)
    const deleted = await call('message-delete', 'commit', { ...deletion, ...preview })
    const surviving = ctx.sessions.get(deleted.sessionId).snapshotEvents().filter((event) => event.type === 'assistant/message')
    assert.deepEqual(surviving.map((event) => event.data.message.content), [[{ type: 'text', text: 'answer 1' }]])
    const edit = { sessionId: id, targetSeq: first.userSeq, text: 'edited desktop test' }
    const editPreview = await call('message-edit', 'preview', edit)
    const edited = await call('message-edit', 'commit', { ...edit, ...editPreview })
    const child = ctx.agents.get(edited.sessionId)
    await child.whenIdle()
    const events = child.session.snapshotEvents()
    assert.equal(events.findLast((event) => event.type === 'turn/end')?.data.reason.kind, 'completed')
    assert.deepEqual(events.filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').map((event) => event.data.content), [[{ type: 'text', text: edit.text }]])
    // The native asynchronous title provider may append session/title while
    // the edit completes; the source history itself must remain untouched.
    assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
    const workspacePath = join(root, 'workspace')
    await mkdir(workspacePath)
    const workspace = await ctx.workspaceRegistry.create(workspacePath, 'Desktop test')
    await call('projectless-tasks', 'move', { sessionId: id, workspaceId: workspace.id })
    assert.equal(ctx.settings.describe().find((entry) => entry.ns === 'dsh-more-session-groups')?.value.assignments[id], workspace.id)
    assert.equal(session.header.cwd, cwd)
    assert.equal(workspace.sessionIds.includes(id), false)
    await call('projectless-tasks', 'move', { sessionId: id, workspaceId: null })
    // Retain both pre-toggle handles and handles acquired while deletion is off.
    await ctx.settings.mutate('dsh-more', [{ op: 'set', path: ['session-delete'], value: false }])
    await call('session-delete', 'commit', { sessionId: id, confirmSessionId: id }, 409)
    const duringDisabled = (await ctx.sessionController.create({ cwd })).sessionId
    await ctx.settings.mutate('dsh-more', [{ op: 'set', path: ['session-delete'], value: true }])
    await call('session-delete', 'commit', { sessionId: duringDisabled, confirmSessionId: duringDisabled })
    await call('session-delete', 'commit', { sessionId: id, confirmSessionId: 'wrong-session' }, 400)
    assert.ok(ctx.sessions.get(id))
    await call('session-delete', 'commit', { sessionId: id, confirmSessionId: id })
    assert.equal(ctx.sessions.get(id), undefined)
    assert.equal((await ctx.sessionPersistence.list()).some((row) => (row.header ?? row).id === id), false)
    await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'offline-catalog'], value: {
      api: 'openai-completions', baseURL: 'http://127.0.0.1:1', models: [{ id: 'offline-model' }],
    } }])
    const capabilities = await call('model-capabilities', 'read', {})
    const model = capabilities.rows.find((row) => row.provider === 'offline-catalog' && row.modelId === 'offline-model')
    assert.ok(model)
    const change = {
      namespace: model.namespace, provider: model.provider, modelId: model.modelId, expectedRevision: model.revision,
      vision: true, reasoningEfforts: { low: 'low', high: 'high' }, thinkingFormat: 'openai',
    }
    await call('model-capabilities', 'save', change)
    const saved = (await call('model-capabilities', 'read', {})).rows.find((row) => row.provider === model.provider)
    assert.equal(saved.vision, true)
    assert.deepEqual(saved.reasoningEfforts, change.reasoningEfforts)
    await call('model-capabilities', 'save', change, 409)
    for await (const _chunk of ctx.llm.stream({ provider: 'dsh-more-test', model: 'test', purpose: 'session-title', messages: [], signal: new AbortController().signal })) { /* consume */ }
    const status = await call('session-auto-title', 'status', {})
    assert.ok(status.successes >= 1)
    const title = calls.findLast((options) => options.purpose === 'session-title')
    assert.match(title.system, /类型 · 具体任务/)
    assert.ok(title.maxTokens >= 2048)
    log(`Desktop ${version}: export, edit/resume, delete/rebuild, grouping persistence, permanent deletion, capabilities save/conflict and title middleware passed.`)
  } finally {
    await ctx?.fiber.dispose()
    console.log = log
    await rm(root, { recursive: true, force: true })
  }
}
