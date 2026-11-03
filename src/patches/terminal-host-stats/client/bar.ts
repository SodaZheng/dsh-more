import type { HostStats } from '../shared.js'

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
function unit(bytes: number): number {
  return Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)))
}

function amount(bytes: number, index: number): string {
  return Number((bytes / 1024 ** index).toFixed(1)).toString()
}

function capacity(value: number, total: number): string {
  const index = unit(total)
  const valueUnit = unit(value)
  if (value > 0 && valueUnit < index) {
    return amount(value, valueUnit) + ' ' + units[valueUnit] + '/' + amount(total, index) + ' ' + units[index]
  }
  return amount(value, index) + '/' + amount(total, index) + ' ' + units[index]
}

function rate(bytes: number): string {
  const index = unit(bytes)
  return amount(bytes, index) + ' ' + units[index] + '/s'
}

export function createBar(doc: Document) {
  const node = doc.createElement('div')
  node.className = 'dshmore-host-stats'
  node.setAttribute('role', 'group')
  node.setAttribute('aria-label', '终端主机状态')
  node.style.cssText = 'display:flex;flex:none;order:-1;flex-wrap:wrap;align-items:center;gap:3px 14px;padding:4px 10px 6px;border-bottom:1px solid var(--dsw-alias-border-primary, #8884);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums'
  const fields = [
    ['CPU', '所有逻辑核心的平均使用率'],
    ['内存', '主机已用 / 总物理内存'],
    ['磁盘可用', '主机主目录所在卷的可用 / 总空间'],
    ['读', '主机磁盘每秒读取的字节数'],
    ['写', '主机磁盘每秒写入的字节数'],
  ] as const
  const values = fields.map(([label, hint]) => {
    const cell = doc.createElement('span')
    cell.title = hint
    cell.style.whiteSpace = 'nowrap'
    const key = doc.createElement('span')
    key.style.color = 'var(--dsw-alias-label-secondary, inherit)'
    key.textContent = label + ' '
    const value = doc.createTextNode('—')
    cell.append(key, value)
    node.append(cell)
    return value
  })
  function render(stats: HostStats | null, failed = false): void {
    node.title = failed ? '暂时无法读取主机状态，将自动重试' : '终端主机状态 · — 表示等待采样或系统未提供此指标'
    const display = [
      stats?.cpuPercent != null ? stats.cpuPercent + '%' : '—',
      stats?.memory ? capacity(stats.memory.used, stats.memory.total) : '—',
      stats?.disk ? capacity(stats.disk.available, stats.disk.total) : '—',
      stats?.io ? rate(stats.io.read) : '—',
      stats?.io ? rate(stats.io.write) : '—',
    ]
    values.forEach((value, i) => { if (value.data !== display[i]) value.data = display[i]! })
  }
  render(null)
  return { node, render }
}
