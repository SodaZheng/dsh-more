// @vitest-environment happy-dom
// Optional integration check against an installed desktop, not a simulated SlotCore.
// DSH_MORE_DESKTOP_ASAR=/path/to/app.asar vitest run src/patches/projectless-tasks/native-factory.test.tsx
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { installConversationAdapter, installConversationFactoryAdapter } from './client/adapter.js'
import { installPickerAdapter } from './client/picker.js'

interface AsarEntry { files?: Record<string, AsarEntry>; link?: string; offset?: string; size?: number }
function desktopModules(archive: string) {
  const bytes = readFileSync(archive)
  const base = 8 + bytes.readUInt32LE(4)
  const index = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString()) as AsarEntry
  const lookup = (path: string): AsarEntry => {
    let entry = index
    for (const name of path.split('/')) {
      const next = entry.files?.[name]
      if (next === undefined) throw new Error(`Missing desktop archive entry: ${path}`)
      entry = next
    }
    return entry.link === undefined ? entry : lookup(entry.link)
  }
  const source = (path: string): string => {
    const entry = lookup(path)
    if (entry.offset === undefined || entry.size === undefined) throw new Error(`Not a packed file: ${path}`)
    const start = base + Number(entry.offset)
    return bytes.subarray(start, start + entry.size).toString()
  }
  const require = createRequire(import.meta.url)
  const coreModule = { exports: {} }
  runInNewContext(transformSync(source('dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'), { format: 'cjs' }).code,
    { module: coreModule, exports: coreModule.exports, require, queueMicrotask })
  let renderer: { apply(ctx: Context): void } | undefined
  runInNewContext(source('dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js'), {
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): typeof renderer }) => {
      renderer = entry.factory((name) => name === '@deepseek-ai/dsh-client-ui-slots' ? coreModule.exports : require(name))
    } } },
    queueMicrotask, console, setTimeout, clearTimeout,
  })
  if (renderer === undefined) throw new Error('Desktop renderer did not register')
  const primitives = new Proxy({ __esModule: true }, { get: (target, key) => key in target ? target[key as never] : () => null })
  const store = {
    createSnapshotStore<T>(initial: T) {
      let value = initial
      return { getSnapshot: () => value, subscribe: () => () => {}, set(next: T) { value = next } }
    },
  }
  let conversation: { ConversationContent?: ComponentType<any> } | undefined
  const conversationSource = source('dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
    .replace('return module.exports;', 'exports.ConversationContent = ConversationContent; return module.exports;')
  const page = window as Window & { __ModuleLoader__?: unknown }
  page.__ModuleLoader__ = { load: (entry: { factory(require: (name: string) => unknown): typeof conversation }) => {
    conversation = entry.factory((name) => {
      if (name === '@deepseek-ai/dsh-client-ui-slots') return coreModule.exports
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      if (name === '@deepseek-ai/dsh-client-store') return store
      return require(name)
    })
  } }
  runInNewContext(conversationSource, {
    window: page, document, navigator: window.navigator, localStorage: window.localStorage,
    queueMicrotask, console, setTimeout, clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  })
  if (conversation?.ConversationContent === undefined) throw new Error('Desktop conversation content did not load')
  return { renderer, ConversationContent: conversation.ConversationContent }
}

const archive = process.env['DSH_MORE_DESKTOP_ASAR']
it.skipIf(archive === undefined)('adapts an already mounted native desktop SlotRegistry and renderer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const ctx = new Context()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const dispose: Array<() => void> = []
  try {
    desktopModules(archive!).renderer.apply(ctx)
    // The native service does NOT expose SlotCore's factory methods.
    expect('factory' in ctx.slots).toBe(false)
    expect('subscribeFactory' in ctx.slots).toBe(false)
    const slots = ctx.slots as unknown as {
      register(options: object, component: ComponentType<any>): () => void
      registerFactory(options: object, component: ComponentType<any>): () => void
      hostFace(): { factoryOf(name: string): { component: unknown } }
    }
    const observable = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [], archivedSessionIds: [] }
    ctx.slots.provideRoot({ hooks: {
      workspaces: observable(workspace),
      sessions: observable({ byId: { independent: { cwd: '/tmp/independent-task' } } }),
    } })
    const binding = { key: 'independent', ctx, hooks: { session: observable({ openState: 'open' }) }, keyedHooks: {}, props: { sessionId: 'independent' } }
    ctx.slots.installScope('session', { current: observable(binding), resolve: () => binding, renderArea: () => null })
    ctx.slots.register({ name: 'root', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } },
      (props: any) => props.renderSlot('main.conversation', {}))
    // Native 0.1.6 shell owns no composer children: those live in its Factory.
    ctx.slots.register({ name: 'main.conversation' }, (props: any) => props.renderFactorySlot('conversation.content', {}))
    const native = (props: any) => <>
      {props.renderSlot('conversation.composer.bar', { variant: 'hero', disabled: true, onRequestWorkspace() {} })}
      {props.renderSlot('conversation.hero.workspace', { open: true, onPick() {}, onClose() {} })}
    </>
    slots.registerFactory({ name: 'conversation.content', scope: 'session-maybe', children: {
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
    }, inject: () => ({ hooks: { composerBlock: observable(undefined) } }) }, native)
    ctx.slots.register({ name: 'conversation.composer.bar' }, (props: any) => <textarea disabled={props.disabled} />)
    slots.register({ name: 'conversation.hero.workspace', children: {
      'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
    } }, (props: any) => <div role="menu">{props.useWorkspaces((value: typeof workspace) => value).items.map((item: { workspaceId: string; title: string }) =>
      <span key={item.workspaceId}>{item.title}</span>)}</div>)
    await act(async () => root.render(ctx.slots.renderSlot('root', {})))
    expect(document.querySelector('textarea')?.disabled).toBe(true)
    const settings = { ...DEFAULT_PATCH_SETTINGS }
    const activation = { getSnapshot: () => settings, subscribe: () => () => {}, getSettingsSnapshot: vi.fn(), set: vi.fn() }
    await act(async () => {
      dispose.push(installConversationFactoryAdapter(ctx, activation))
      dispose.push(installConversationAdapter(ctx, activation))
      dispose.push(installPickerAdapter(ctx))
    })
    expect(slots.hostFace().factoryOf('conversation.content').component).not.toBe(native)
    expect(document.querySelector('textarea')?.disabled).toBe(false)
    expect(document.querySelector('[role="menu"]')?.textContent).toBe('独立任务')
    await act(async () => dispose.splice(0).reverse().forEach((fn) => fn()))
    expect(slots.hostFace().factoryOf('conversation.content').component).toBe(native)
    expect(document.querySelector('textarea')?.disabled).toBe(true)
    expect(document.querySelector('[role="menu"]')?.textContent).toBe('')
  } finally {
    await act(async () => {
      root.unmount()
      dispose.splice(0).reverse().forEach((fn) => fn())
      await ctx.fiber.dispose()
    })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})

it.skipIf(archive === undefined)('unlocks the real desktop conversation content and shows the independent task', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const ctx = new Context()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const dispose: Array<() => void> = []
  try {
    const desktop = desktopModules(archive!)
    desktop.renderer.apply(ctx)
    const slots = ctx.slots as unknown as {
      installLocale(face: { bind(ns: string): (key: string) => string; getSnapshot(): { revision: number }; subscribe(): () => void }): void
      register(options: object, component: ComponentType<any>): () => void
      registerFactory(options: object, component: ComponentType<any>): () => void
    }
    slots.installLocale({ bind: () => (key) => key, getSnapshot: () => ({ revision: 1 }), subscribe: () => () => {} })
    const observable = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
    const workspace = { phase: 'ready', state: 'idle', error: null, items: [{ workspaceId: 'project', title: 'dsh-more', path: '/code/dsh-more', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [] }
    ctx.slots.provideRoot({ hooks: { workspaces: observable(workspace), sessions: observable({ byId: { independent: { cwd: '/tmp/independent-task' } } }) } })
    const binding = {
      key: 'independent', ctx,
      hooks: {
        session: observable({ openState: 'open' }),
        sessionStatus: observable({ get: () => undefined }),
        input: observable({ phase: 'plain', draft: '' }),
      },
      keyedHooks: {},
      props: { sessionId: 'independent' },
    }
    ;(ctx.slots as unknown as { installScope(scope: string, adapter: object): void }).installScope('session', {
      current: observable(binding), resolve: () => binding, renderArea: () => null,
      bindingSource: () => observable(binding),
    })
    ctx.slots.register({ name: 'root', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } },
      (props: any) => props.renderSlot('main.conversation', {}))
    ctx.slots.register({ name: 'main.conversation' }, (props: any) => props.renderFactorySlot('conversation.content', { variant: 'main', phase: 'hero', hero: true }))
    slots.registerFactory({
      name: 'conversation.content', scope: 'session-maybe', locale: 'conversation',
      children: {
        'conversation.session': { kind: 'single', scope: 'session' },
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
        'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
        'conversation.hero.workspace': { kind: 'single', scope: 'root' },
        'conversation.hero.agentPreset': { kind: 'single', scope: 'session-maybe' },
      },
      slots: { views: { scope: 'session' }, widthControls: { scope: 'root' } },
      inject: () => ({ hooks: { composerBlock: observable(undefined) }, selectWorkspace: () => Promise.resolve() }),
    }, desktop.ConversationContent)
    ctx.slots.register({ name: 'conversation.composer.bar' }, (props: any) => <textarea disabled={props.disabled} />)
    slots.register({ name: 'conversation.hero.workspace', children: {
      'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' },
    } }, (props: any) => <div role="menu">{props.useWorkspaces((value: typeof workspace) => value).items.map((item: { workspaceId: string; title: string }) =>
      <span key={item.workspaceId}>{item.title}</span>)}</div>)
    await act(async () => root.render(ctx.slots.renderSlot('root', {})))
    expect(document.body.textContent).not.toContain('独立任务')
    expect(document.querySelector('textarea')?.disabled).toBe(true)
    const settings = { ...DEFAULT_PATCH_SETTINGS }
    const activation = { getSnapshot: () => settings, subscribe: () => () => {}, getSettingsSnapshot: vi.fn(), set: vi.fn() }
    await act(async () => {
      dispose.push(installConversationFactoryAdapter(ctx, activation))
      dispose.push(installConversationAdapter(ctx, activation))
      dispose.push(installPickerAdapter(ctx))
    })
    expect(document.body.textContent).toContain('独立任务')
    expect(document.querySelector('textarea')?.disabled).toBe(false)
  } finally {
    await act(async () => {
      root.unmount()
      dispose.splice(0).reverse().forEach((fn) => fn())
      await ctx.fiber.dispose()
    })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})
