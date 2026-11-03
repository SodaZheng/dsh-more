// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMonitor } from './client/monitor.js'
import type { HostStats } from './shared.js'

const stats: HostStats = { cpuPercent: 25, memory: { used: 3 * 2 ** 30, total: 8 * 2 ** 30 },
  disk: { available: 0, total: 2 ** 40 }, io: { read: 0, write: 2048 } }
let visibility: (entries: { target: Element; isIntersecting: boolean }[]) => void
const observe = vi.fn()
const disconnect = vi.fn()
let dispose: (() => void) | undefined
function addTerminal() {
  const section = document.createElement('section')
  section.dataset.sidebarTerminal = ''
  section.innerHTML = '<div class="xterm">terminal output</div>'
  document.body.append(section)
  return section
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof visibility) { visibility = callback }
    observe = observe
    unobserve = vi.fn()
    disconnect = disconnect
  })
})
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('terminal host status', () => {
  it('keeps low free space legible on large volumes', async () => {
    const root = addTerminal()
    dispose = installMonitor(document, async () => ({ ...stats, disk: { available: 10 * 2 ** 30, total: 2 ** 40 } }))
    visibility([{ target: root, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(0)
    expect(root.firstElementChild?.textContent).toContain('磁盘可用 10 GiB/1 TiB')
  })

  it('adds a bar above each screen, shares a poll, pauses when hidden, and removes bars on disable', async () => {
    const first = addTerminal()
    const second = addTerminal()
    const sample = vi.fn(async () => stats)
    dispose = installMonitor(document, sample)
    expect(sample).not.toHaveBeenCalled()
    visibility([first, second].map(target => ({ target, isIntersecting: true })))
    await vi.advanceTimersByTimeAsync(0)
    for (const root of [first, second]) {
      expect(root.firstElementChild?.textContent).toContain('CPU 25%内存 3/8 GiB磁盘可用 0/1 TiB读 0 B/s写 2 KiB/s')
      expect(root.lastElementChild?.textContent).toBe('terminal output')
    }
    expect(sample).toHaveBeenCalledTimes(1)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(6000)
    expect(sample).toHaveBeenCalledTimes(1)
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sample).toHaveBeenCalledTimes(2)
    visibility([first, second].map(target => ({ target, isIntersecting: false })))
    await vi.advanceTimersByTimeAsync(6000)
    expect(sample).toHaveBeenCalledTimes(2)
    dispose()
    expect(document.querySelector('.dshmore-host-stats')).toBeNull()
    expect(disconnect).toHaveBeenCalled()
  })

  it('discovers a later terminal, retries after failure, and ignores a reply after disposal', async () => {
    let finish: (value: HostStats) => void = () => {}
    const sample = vi.fn<() => Promise<HostStats>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(stats)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    dispose = installMonitor(document, sample)
    const root = addTerminal()
    await vi.advanceTimersByTimeAsync(1)
    expect(observe).toHaveBeenCalledWith(root)
    visibility([{ target: root, isIntersecting: true }])
    await vi.advanceTimersByTimeAsync(0)
    expect(root.firstElementChild?.getAttribute('title')).toContain('自动重试')
    await vi.advanceTimersByTimeAsync(2000)
    expect(root.firstElementChild?.textContent).toContain('25%')
    await vi.advanceTimersByTimeAsync(2000)
    root.remove()
    await vi.advanceTimersByTimeAsync(1)
    expect(root.querySelector('.dshmore-host-stats')).toBeNull()
    dispose()
    finish(stats)
    await vi.advanceTimersByTimeAsync(4000)
    expect(sample).toHaveBeenCalledTimes(3)
  })
})
