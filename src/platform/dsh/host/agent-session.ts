import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { DshMoreError } from './error.js'

export function requireLiveSession(ctx: Context, sessionId: string): Session {
  const session = ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new DshMoreError('session-not-live', '请先打开这条会话再操作。', 409)
  return session
}

export function requireIdleAgent(ctx: Context, sessionId: string, session: Session): Agent {
  const agent = ctx.agents.get(SessionId(sessionId))
  if (agent === undefined || agent.session !== session) {
    throw new DshMoreError('session-not-live', '当前会话没有可维护的 Agent，请重新打开后再试。', 409)
  }
  if (agent.status !== 'idle') throw new DshMoreError('session-busy', '会话仍在生成或执行工具，请等待它空闲后再操作。', 409)
  return agent
}

export function runAgentMaintenance<T>(agent: Agent, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try {
    return agent.runMaintenance(task)
  } catch {
    throw new DshMoreError('session-busy', '会话刚刚开始了新任务，请等待它空闲后重试。', 409)
  }
}
