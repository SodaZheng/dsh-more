import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostPatch } from '../../../kernel/host/patch.js'
import { DshMoreError } from '../../../platform/dsh/host/error.js'
import { PROJECTLESS_TASKS_PATCH_ID, TASK_ID_PATTERN, type TaskLocation } from '../shared.js'
import { SESSION_GROUPS_NAMESPACE } from '../groups.js'
import { moveSessionGroup, SessionGroupsSchema } from './groups.js'

/** Preparation is read-only. The native Session API owns mkdir and creation. */
export function prepareTask(payload: unknown, homeDirectory = homedir()): TaskLocation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
    || !('sessionId' in payload) || typeof payload.sessionId !== 'string'
    || !TASK_ID_PATTERN.test(payload.sessionId) || Object.keys(payload).length !== 1) {
    throw new DshMoreError('bad-request', '独立任务标识无效，请重新新建任务。')
  }
  return { sessionId: payload.sessionId, cwd: join(homeDirectory, 'Documents', 'DSH', 'tasks', payload.sessionId) }
}

export const hostPatch: HostPatch = {
  id: PROJECTLESS_TASKS_PATCH_ID,
  setup: (ctx) => {
    const fiber = ctx.inject(['settings'], (scope) => {
      // New hosts project the companion entry's Config under this same namespace.
      if (typeof scope.settings.register === 'function') {
        scope.settings.register(SESSION_GROUPS_NAMESPACE, SessionGroupsSchema)
      }
    })
    return () => { void fiber.dispose() }
  },
  routes: ({ ctx }) => ({ prepare: (payload) => prepareTask(payload), move: (payload) => moveSessionGroup(ctx, payload) }),
}
