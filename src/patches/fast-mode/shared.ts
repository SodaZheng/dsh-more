export const FAST_MODE_PATCH_ID = 'fast-mode'
export const FAST_MODE_SETTINGS_NS = 'dsh-more/fast-mode'

export interface FastModeSettings {
  /** Whether fast mode is enabled globally by default across all sessions */
  defaultEnabled: boolean
  /** Wire service tier. Codex/CLIProxyAPI only keeps the exact value "priority" for Fast; "fast" is deleted. */
  serviceTier: string
  /** Retained for older settings documents. Not sent on the wire; Fast is a service tier, not a speed field. */
  speed: number
  /** Whether Anthropic hosts also receive the fast-mode beta header */
  enableAnthropicFastMode: boolean
  /** Custom parameters merged into outgoing LLM request body */
  customBodyParams: Record<string, unknown>
  /** Custom headers merged into outgoing LLM request */
  customHeaders: Record<string, string>
}

export const DEFAULT_FAST_MODE_SETTINGS: FastModeSettings = {
  defaultEnabled: false,
  serviceTier: 'priority',
  speed: 1.5,
  enableAnthropicFastMode: true,
  customBodyParams: {},
  customHeaders: {},
}
