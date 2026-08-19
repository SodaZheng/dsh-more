import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'

export interface RefreshableSessions extends ISessions {
  refresh(): Promise<void>
}

export interface RefreshableWorkspaces extends IWorkspaces {
  refresh(): Promise<void>
}
