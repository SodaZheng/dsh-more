import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'

export interface RefreshableSessions extends ISessions {
  refresh(): Promise<void>
}

export interface RefreshableWorkspaces extends IWorkspaces {
  refresh(): Promise<void>
}
