import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { callPatchApi } from '../../../platform/dsh/client/api.js'
import { PROJECTLESS_TASKS_PATCH_ID, type TaskLocation } from '../shared.js'

/** One shared flight for selection/clear; retries adopt the same native Session. */
export function createTaskStarter(sessions: Pick<ISessions, 'create' | 'open'>) {
  let pendingId: string | undefined
  let flight: Promise<void> | undefined
  let disposed = false
  return {
    start(beforeOpen?: (id: SessionId) => boolean | void): Promise<void> {
      if (disposed) return Promise.reject(new Error('独立任务补丁已关闭。'))
      if (flight !== undefined) return flight
      pendingId ??= `task-${crypto.randomUUID()}`
      const sessionId = pendingId
      flight = (async () => {
        const location = await callPatchApi<TaskLocation>(PROJECTLESS_TASKS_PATCH_ID, 'prepare', { sessionId })
        if (location.sessionId !== sessionId || typeof location.cwd !== 'string' || location.cwd.length === 0) {
          throw new Error('独立任务界面与后台版本不一致，请重启 DSH。')
        }
        if (disposed) return
        const id = await sessions.create({ sessionId: sessionId as SessionId, cwd: location.cwd })
        if (id !== sessionId) throw new Error('创建结果与独立任务标识不一致。')
        // create resolves with a usable binding. Never refresh or clear first.
        if (!disposed && beforeOpen?.(id) !== false) sessions.open(id)
        pendingId = undefined
      })().finally(() => { flight = undefined })
      return flight
    },
    dispose(): void { disposed = true },
  }
}
