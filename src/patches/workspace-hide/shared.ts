export const WORKSPACE_HIDE_PATCH_ID = 'workspace-hide'
export const HIDDEN_WORKSPACES_NAMESPACE = 'dsh-more/workspace-hide'

export interface HiddenWorkspaces {
  hidden: Record<string, boolean>
}

export const EMPTY_HIDDEN_WORKSPACES: HiddenWorkspaces = { hidden: {} }

export interface WorkspaceHideMutationResult {
  workspaceId: string
  hidden: boolean
}

export interface WorkspaceUnhideAllResult {
  restoredIds: string[]
}

export function decodeHiddenWorkspaces(value: unknown): HiddenWorkspaces | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('hidden' in value)) {
    return undefined
  }
  const rawHidden = value.hidden
  if (typeof rawHidden !== 'object' || rawHidden === null || Array.isArray(rawHidden)) {
    return undefined
  }
  const hidden: Record<string, boolean> = {}
  for (const [workspaceId, flag] of Object.entries(rawHidden)) {
    if (typeof flag !== 'boolean') return undefined
    if (flag) hidden[workspaceId] = true
  }
  return { hidden }
}
