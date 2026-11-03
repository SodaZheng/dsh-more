import { afterEach, describe, expect, it, vi } from 'vitest'
import { linuxCounters, macCounters, windowsCounters } from './host/disks.js'
import { createSampler } from './host/sample.js'

afterEach(() => vi.restoreAllMocks())

describe('physical disk counters', () => {
  it('counts Linux whole disks in bytes, excluding partitions and stacked devices', () => {
    const names = ['nvme0n1', 'nvme0n1p1', 'sda', 'md0', 'dm-0', 'loop1', 'zram0']
    const lines = names.map((name, i) => '8 ' + i + ' ' + name + ' 1 0 5 0 2 0 12 0 0 0 0')
    const devices = new Set(names.filter(name => name !== 'nvme0n1p1'))
    expect([...linuxCounters(lines.join('\n'), devices)]).toEqual([
      ['nvme0n1', { read: 2560, write: 6144 }], ['sda', { read: 2560, write: 6144 }],
    ])
  })

  it('reads macOS counters by driver ID and Windows counters by physical disk', () => {
    const ioreg = '+-o IOBlockStorageDriver <class IOBlockStorageDriver, id 0xaf, active>\n'
      + '    "Statistics" = {"Bytes (Write)"=227,"Bytes (Read)"=0}\n'
      + '+-o IOBlockStorageDriver <class IOBlockStorageDriver, id 0xbf, active>\n'
      + '    "Statistics" = {"Bytes (Read)"=55}\n'
    expect([...macCounters(ioreg)]).toEqual([['0xaf', { read: 0, write: 227 }]])
    expect([...windowsCounters('0 C: D:|100|51\r\n1|10|0\r\n_Total|110|51')]).toEqual([
      ['0', { read: 100, write: 51 }], ['1', { read: 10, write: 0 }],
    ])
  })
})

describe('on-demand sampling', () => {
  it('shares concurrent and recent reads, then uses matched device and CPU deltas', async () => {
    let at = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    const reading = {
      at, cpu: { count: 2, idle: 40, total: 100 },
      counters: new Map([['a', { read: 100, write: 500 }], ['gone', { read: 1e6, write: 1e6 }]]),
      disk: null, memory: { used: 10, total: 16 },
    }
    const collect = vi.fn(async () => structuredClone({ ...reading, at }))
    const sample = createSampler(collect)
    const [first, concurrent] = await Promise.all([sample(), sample()])
    expect(first).toEqual({ cpuPercent: null, io: null, disk: null, memory: reading.memory })
    expect(first).toBe(concurrent)
    at += 500
    expect(await sample()).toBe(first)
    expect(collect).toHaveBeenCalledTimes(1)
    at += 1500
    reading.cpu = { count: 2, idle: 90, total: 300 }
    reading.counters = new Map([['a', { read: 1100, write: 500 }], ['new', { read: 1e8, write: 1e8 }]])
    expect(await sample()).toMatchObject({ io: { read: 500, write: 0 }, cpuPercent: 75 })
    at += 2000
    reading.counters = new Map([['a', { read: 0, write: 0 }]])
    expect(await sample()).toMatchObject({ io: null, cpuPercent: null })
    at += 20_000
    reading.counters.set('a', { read: 400, write: 600 })
    reading.cpu = { count: 2, idle: 92, total: 302 }
    expect(await sample()).toMatchObject({ io: null, cpuPercent: null })
  })
})
