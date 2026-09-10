export const PROJECTLESS_TASKS_PATCH_ID = 'projectless-tasks'
export const TASK_ID_PATTERN = /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface TaskLocation {
  sessionId: string
  cwd: string
}
