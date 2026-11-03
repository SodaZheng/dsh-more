import { statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, totalmem } from 'node:os'
import type { HostStats } from '../shared.js'
import { readDiskCounters, type Counters } from './disks.js'

interface Reading {
  at: number
  cpu: { count: number; idle: number; total: number }
  memory: HostStats['memory']
  disk: HostStats['disk']
  counters: Counters
}

async function readHost(): Promise<Reading> {
  const [disk, counters] = await Promise.all([
    statfs(homedir()).then(({ bavail, blocks, bsize }) =>
      blocks > 0 && bavail >= 0 ? { available: bavail * bsize, total: blocks * bsize } : null).catch(() => null),
    readDiskCounters().catch(() => new Map()),
  ])
  const cores = cpus()
  const cpu = { count: cores.length, idle: 0, total: 0 }
  for (const { times } of cores) {
    cpu.idle += times.idle
    cpu.total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  const total = totalmem()
  const memory = total > 0 ? { used: total - freemem(), total } : null
  return { at: performance.now(), cpu, memory, disk, counters }
}

function diskRate(before: Counters, after: Counters, seconds: number): HostStats['io'] {
  let matched = false
  let read = 0
  let write = 0
  for (const [id, now] of after) {
    const prev = before.get(id)
    if (!prev || now.read < prev.read || now.write < prev.write) continue
    read += now.read - prev.read
    write += now.write - prev.write
    matched = true
  }
  return matched ? { read: read / seconds, write: write / seconds } : null
}

// One sampler per Host registration. Sampling is demand-driven, including the
// baseline: no terminal clients means no timer and no background subprocess.
export function createSampler(collect = readHost): () => Promise<HostStats> {
  let previous: Reading | undefined
  let cached: HostStats | undefined
  let pending: Promise<HostStats> | undefined

  const sample = async (): Promise<HostStats> => {
    const now = await collect()
    const result: HostStats = { cpuPercent: null, memory: now.memory, disk: now.disk, io: null }
    const elapsed = now.at - (previous?.at ?? now.at)
    if (previous && elapsed > 0 && elapsed <= 15_000) {
      const total = now.cpu.total - previous.cpu.total
      const idle = now.cpu.idle - previous.cpu.idle
      if (now.cpu.count === previous.cpu.count && total > 0 && idle >= 0 && idle <= total) {
        result.cpuPercent = Math.round(100 * (1 - idle / total))
      }
      result.io = diskRate(previous.counters, now.counters, elapsed / 1000)
    }
    previous = now
    cached = result
    return result
  }

  return () => {
    if (previous && cached && performance.now() - previous.at < 1000) return Promise.resolve(cached)
    return pending ??= sample().finally(() => { pending = undefined })
  }
}
