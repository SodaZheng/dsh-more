import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/** Undo the public side effects of a continuation that failed before publication. */
export async function rollbackFailedContinuation(
  child: AgentHandle,
  workspace: Workspace | undefined,
  attached: boolean,
  cause: unknown,
): Promise<never> {
  const errors: unknown[] = [cause]
  if (attached && workspace !== undefined) {
    try {
      await workspace.detachSession(child.agent.id)
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await child.dispose()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw cause
  throw new AggregateError(errors, 'continuation failed and cleanup was incomplete')
}
