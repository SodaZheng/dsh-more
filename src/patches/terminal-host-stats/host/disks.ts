import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const options = { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }
export type Counters = Map<string, { read: number; write: number }>

export function linuxCounters(source: string, wholeDisks: ReadonlySet<string>): Counters {
  const disks: Counters = new Map()
  for (const line of source.trim().split('\n')) {
    const fields = line.trim().split(/\s+/)
    const name = fields[2]
    if (!name || !wholeDisks.has(name) || /^(?:loop|ram|zram|dm-|md\d)/.test(name)) continue
    // diskstats always counts 512-byte sectors, regardless of logical block size.
    const read = Number(fields[5]) * 512
    const write = Number(fields[9]) * 512
    if (Number.isSafeInteger(read) && read >= 0 && Number.isSafeInteger(write) && write >= 0) disks.set(name, { read, write })
  }
  return disks
}

export function macCounters(source: string): Counters {
  const disks: Counters = new Map()
  for (const block of source.split(/(?=^\+-o )/m)) {
    const id = block.match(/^\+-o .*?\bid (0x[\da-f]+)/i)?.[1]
    const stats = block.match(/"Statistics"\s*=\s*\{([^}\n]*)\}/)?.[1]
    if (!id || !stats) continue
    const read = stats.match(/"Bytes \(Read\)"\s*=\s*(\d+)/)?.[1]
    const write = stats.match(/"Bytes \(Write\)"\s*=\s*(\d+)/)?.[1]
    if (read && write) disks.set(id, { read: Number(read), write: Number(write) })
  }
  return disks
}

export function windowsCounters(source: string): Counters {
  const disks: Counters = new Map()
  for (const line of source.trim().split(/\r?\n/)) {
    const match = /^(\d+)(?:\s[^|]*)?\|(\d+)\|(\d+)$/.exec(line.trim())
    if (match) disks.set(match[1]!, { read: Number(match[2]), write: Number(match[3]) })
  }
  return disks
}

export async function readDiskCounters(): Promise<Counters> {
  if (process.platform === 'linux') {
    const [devices, stats] = await Promise.all([readdir('/sys/block'), readFile('/proc/diskstats', 'utf8')])
    return linuxCounters(stats, new Set(devices))
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-d', '1', '-w', '0'], options)
    return macCounters(stdout)
  }
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const script = "Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | ForEach-Object { '{0}|{1}|{2}' -f $_.Name,$_.DiskReadBytesPersec,$_.DiskWriteBytesPersec }"
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], options)
    return windowsCounters(stdout)
  }
  return new Map()
}
