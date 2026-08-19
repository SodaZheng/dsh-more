import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

export function addTurn(session: Session, turn: number, prompt: string): {
  userSeq: number
  assistantSeq: number
} {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `answer ${String(turn)}` }],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { userSeq: user.seq, assistantSeq: assistant.seq }
}

export function appendRuntimeContext(session: Session, text = 'old policy'): void {
  session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${text}`,
    }],
    source: {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [{ name: 'sandbox:policy', text }],
    },
  }), { surfaceOp: 'append' })
}
