export const TERMINAL_HOST_STATS_ID = 'terminal-host-stats'

export interface HostStats {
  cpuPercent: number | null
  memory: { used: number; total: number } | null
  disk: { available: number; total: number } | null
  io: { read: number; write: number } | null // bytes/second
}
