// @vitest-environment happy-dom
import { act, createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PATCH_SETTINGS } from '../../generated/patch-catalog.js'
import { callPatchApi } from '../../platform/dsh/client/api.js'
import { MODEL_CAPABILITIES_PATCH_ID as ID, type ModelCapabilitiesSnapshot } from './shared.js'
import { clientPatch } from './client/index.js'
import { capabilitiesFromDraft, draftFromServer } from './client/editor.js'
import { findModelEntries, modelIdOf, providerRouteOf } from './client/model-entries.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, ...props }: { children?: ReactNode; variant?: string }) => createElement('button', props, children),
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer: ReactNode }) => open ? createElement('div', { role: 'dialog' }, title, children, footer) : null,
}))
vi.mock('../../platform/dsh/client/api.js', () => ({ callPatchApi: vi.fn(), apiErrorText: (error: unknown) => error instanceof Error ? error.message : String(error) }))

const ROW = { namespace: 'llm-pi-ai', revision: 7, provider: 'gateway', providerName: 'Gateway', modelId: 'model-a', api: 'openai-completions', vision: null, reasoningEfforts: null, thinkingFormat: null } as const
const SNAPSHOT: ModelCapabilitiesSnapshot = { protocolVersion: 2, rows: [ROW], writable: true, revision: 7 }
const HTML = '<li class="hash_rowCard"><span class="hash_rowName">Gateway</span><div class="hash_editor"><span class="hash_editorRoute">gateway</span><div class="hash_modelCatalog"><div class="hash_modelEntry"><div class="hash_modelRow"><input type="text" value="model-a"><input type="text" value="Model A"></div></div></div></div></li>'
let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.mocked(callPatchApi).mockReset().mockResolvedValue(SNAPSHOT)
  document.body.innerHTML = HTML
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function mount() {
  let component: ComponentType | undefined
  let enabled = true
  let snapshot = { ...DEFAULT_PATCH_SETTINGS, [ID]: enabled }
  const listeners = new Set<() => void>()
  class Scope {
    state = { status: 'ready', revision: 7 }
    listeners = new Set<() => void>()
    getSnapshot() { return this.state }
    subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
    async set() {}
    async unset() {}
    async mutate() {}
  }
  const scope = new Scope()
  clientPatch.install({
    settingsScope: { bind: () => scope },
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (options: { name: string }, entry: ComponentType) => { expect(options.name).toBe('shell.overlay'); component = entry },
    },
  } as never, {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSettingsSnapshot: vi.fn(), set: vi.fn(),
  })
  root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => { root!.render(createElement(component!)) })
  return {
    toggle: async () => { await act(async () => {
      enabled = !enabled; snapshot = { ...DEFAULT_PATCH_SETTINGS, [ID]: enabled }; listeners.forEach((listener) => listener())
    }) },
    refresh: async () => { await act(async () => {
      scope.state = { ...scope.state, revision: scope.state.revision + 1 }; scope.listeners.forEach((listener) => listener())
    }) },
  }
}

async function click(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
async function open() {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-dshmore-model-capabilities]')!.click())
}
async function select(label: string, value: string) {
  const input = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  expect(input).not.toBeNull()
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('models page capability controls', () => {
  it('resolves saved routes and draft model ids in the native DOM', () => {
    const [entry] = findModelEntries()
    expect(providerRouteOf(entry!)).toBe('gateway')
    expect(modelIdOf(entry!)).toBe('model-a')
    entry!.querySelector('input')!.value = 'model-b'
    expect(modelIdOf(entry!)).toBe('model-b')
    document.querySelector('.hash_editorRoute')!.remove()
    expect(providerRouteOf(entry!)).toBe('Gateway')
    document.querySelector('.hash_rowName')!.remove()
    expect(providerRouteOf(entry!)).toBeNull()
  })

  it('binds scope methods, reads without auto-fill, and saves only an explicit choice', async () => {
    await mount()
    expect(document.querySelectorAll('[data-dshmore-model-capabilities]')).toHaveLength(1)
    expect(document.body.textContent).toContain('识图：默认')
    expect(callPatchApi).toHaveBeenCalledWith(ID, 'read', {})
    expect(vi.mocked(callPatchApi).mock.calls.every((call) => call[1] === 'read')).toBe(true)
    await open()
    await select('识图能力', 'yes')
    await select('思考类型', 'disabled')
    await select('思考参数格式', 'deepseek')
    vi.mocked(callPatchApi).mockResolvedValue({ ...SNAPSHOT, revision: 8, rows: [{ ...ROW, vision: true, reasoningEfforts: false, thinkingFormat: 'deepseek' }] })
    await click('保存')
    expect(callPatchApi).toHaveBeenLastCalledWith(ID, 'save', {
      namespace: 'llm-pi-ai', provider: 'gateway', modelId: 'model-a', expectedRevision: 7,
      vision: true, reasoningEfforts: false, thinkingFormat: 'deepseek',
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('支持识图 · 不支持思考')
  })

  it('keeps edits and the opening revision across external updates, and displays conflicts', async () => {
    const runtime = await mount()
    await open()
    await select('识图能力', 'yes')
    vi.mocked(callPatchApi).mockResolvedValue({ ...SNAPSHOT, revision: 8 })
    await runtime.refresh()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="识图能力"]')!.value).toBe('yes')
    vi.mocked(callPatchApi).mockRejectedValue(new Error('模型配置已变更'))
    await click('保存')
    expect(callPatchApi).toHaveBeenLastCalledWith(ID, 'save', expect.objectContaining({ expectedRevision: 7, vision: true }))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('模型配置已变更')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="识图能力"]')!.value).toBe('yes')
  })

  it('cleans up dialogs and injected controls on disable and can re-enable once', async () => {
    const runtime = await mount()
    await open()
    await runtime.toggle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelectorAll('[data-dshmore-model-capabilities]')).toHaveLength(0)
    await runtime.toggle()
    expect(document.querySelectorAll('[data-dshmore-model-capabilities]')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not let a late read resurrect disabled UI', async () => {
    let resolveRead: (value: ModelCapabilitiesSnapshot) => void = () => {}
    vi.mocked(callPatchApi).mockReturnValue(new Promise((resolve) => { resolveRead = resolve }))
    const runtime = await mount()
    await runtime.toggle()
    await act(async () => resolveRead(SNAPSHOT))
    expect(document.querySelectorAll('[data-dshmore-model-capabilities]')).toHaveLength(0)
  })

  it('reports an old Host response and disables save instead of silently returning', async () => {
    vi.mocked(callPatchApi).mockResolvedValue({ writable: true, rows: [{ provider: 'gateway', modelId: 'model-a', input: null, reasoningEfforts: false }] })
    await mount()
    await open()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('界面与后台版本不一致')
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '保存')?.disabled).toBe(true)
    expect(vi.mocked(callPatchApi).mock.calls.every((call) => call[1] === 'read')).toBe(true)
  })

  it('retries failed reads without enabling a blind save', async () => {
    await mount()
    vi.mocked(callPatchApi).mockRejectedValue(new Error('读取失败'))
    await open()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('读取失败')
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '保存')!
    expect(save.disabled).toBe(true)
    vi.mocked(callPatchApi).mockResolvedValue(SNAPSHOT)
    await click('重试')
    expect(document.querySelector('[aria-label="识图能力"]')).not.toBeNull()
  })

  it('disables edits and save in a read-only profile', async () => {
    vi.mocked(callPatchApi).mockResolvedValue({ ...SNAPSHOT, writable: false })
    await mount()
    await open()
    expect(document.querySelector<HTMLSelectElement>('[aria-label="识图能力"]')!.disabled).toBe(true)
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '保存')?.disabled).toBe(true)
  })

  it('saves a native DeepSeek row even with no pi-ai namespace revision', async () => {
    document.body.innerHTML = HTML.replace('>gateway<', '>deepseek-official<')
    const native = { ...SNAPSHOT, revision: null, rows: [{ ...ROW, namespace: 'llm-deepseek', revision: 11, provider: 'deepseek-official', api: 'deepseek-native' }] }
    vi.mocked(callPatchApi).mockResolvedValue(native)
    await mount()
    await open()
    await select('思考类型', 'custom')
    const labels = Array.from(document.querySelectorAll('fieldset label')).map((entry) => entry.textContent)
    expect(labels).toEqual(['不思考 off', '低 low', '高 high', '最高 max'])
    const high = document.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')[2]!
    await act(async () => high.click())
    await click('保存')
    expect(callPatchApi).toHaveBeenLastCalledWith(ID, 'save', {
      namespace: 'llm-deepseek', provider: 'deepseek-official', modelId: 'model-a', expectedRevision: 11,
      vision: null, reasoningEfforts: { high: 'high' }, thinkingFormat: null,
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('hides compatibility controls for a native protocol', async () => {
    vi.mocked(callPatchApi).mockResolvedValue({ ...SNAPSHOT, rows: [{ ...ROW, api: 'anthropic-messages' }] })
    await mount()
    await open()
    expect(document.querySelector('[aria-label="思考参数格式"]')).toBeNull()
    expect(document.body.textContent).toContain('使用原生思考协议')
  })
})

describe('capability drafts', () => {
  it('preserves explicit off wire values when changing vision only', () => {
    const value = { vision: false, reasoningEfforts: { off: 'none', high: 'deep' }, thinkingFormat: 'qwen' } as const
    const draft = draftFromServer(value)
    expect(capabilitiesFromDraft({ ...draft, vision: 'yes' })).toEqual({ ...value, vision: true })
  })
  it('supports independently restoring each capability to defaults', () => {
    const draft = draftFromServer({ vision: true, reasoningEfforts: false, thinkingFormat: 'deepseek' })
    expect(capabilitiesFromDraft({ ...draft, thinking: 'default' })).toEqual({ vision: true, reasoningEfforts: null, thinkingFormat: 'deepseek' })
  })
  it('refuses an empty or off-only custom list', () => {
    const draft = draftFromServer(ROW)
    expect(() => capabilitiesFromDraft({ ...draft, thinking: 'custom' })).toThrow('至少选择')
    expect(() => capabilitiesFromDraft({ ...draft, thinking: 'custom', levels: { off: { enabled: true, wire: '' } } })).toThrow('至少选择')
  })
})
