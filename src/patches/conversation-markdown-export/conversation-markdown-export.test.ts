import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { markdownFilename } from './client/filename.js'
import { hostPatch } from './host/index.js'
import { conversationMarkdown } from './host/transcript.js'

describe('conversation Markdown export', () => {
  it('exports every conversational entry in durable order', () => {
    const session = Session.create(SessionId('session-export'))
    const callId = CallId('call-demo')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请运行示例工具。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: '先检查参数。' },
          { type: 'text', text: '我来运行。' },
          { type: 'tool-call', id: callId, name: 'demo', arguments: '{"code":"```"}' },
        ],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'demo',
      arguments: '{"code":"```"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: '工具输出' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '来自工作区的上下文' }],
      source: { kind: 'plugin', plugin: 'workspace', form: 'instructions' },
    }), { surfaceOp: 'append' })

    const result = conversationMarkdown(session.events, {
      title: '导出示例',
      sessionId: session.id,
      exportedAt: Date.UTC(2026, 7, 20, 1, 2, 3),
    })

    expect(result.entryCount).toBe(4)
    expect(result.markdown).toContain('# 导出示例')
    expect(result.markdown).toContain('导出时间：2026-08-20T01:02:03.000Z')
    expect(result.markdown).toContain('## 用户')
    expect(result.markdown).toContain('<summary>思考过程</summary>')
    expect(result.markdown).toContain('### 工具调用：demo')
    expect(result.markdown).toContain('````json\n{"code":"```"}\n````')
    expect(result.markdown).toContain('## 工具结果 · demo')
    expect(result.markdown).toContain('## 上下文 · workspace')
    expect(result.markdown.indexOf('请运行示例工具。')).toBeLessThan(result.markdown.indexOf('我来运行。'))
    expect(result.markdown.indexOf('我来运行。')).toBeLessThan(result.markdown.indexOf('工具输出'))
  })

  it('exports an explicit empty transcript', () => {
    const result = conversationMarkdown([], {
      title: '空会话',
      sessionId: 'session-empty',
      exportedAt: 0,
    })
    expect(result).toEqual({
      entryCount: 0,
      markdown: '# 空会话\n\n- 会话 ID：session-empty\n\n- 导出时间：1970-01-01T00:00:00.000Z\n\n- 记录条目：0\n\n（暂无聊天记录）\n',
    })
  })

  it('creates a filesystem-safe Markdown filename', () => {
    expect(markdownFilename('  需求 / 设计：第一版  ', 'session-1')).toBe('需求 - 设计-第一版.md')
    expect(markdownFilename('///', 'session:1')).toBe('dsh-conversation-session-1.md')
  })

  it('rejects malformed render requests before reading a session', () => {
    const render = hostPatch.routes({ ctx: {} as Context, confirmationSecret: new Uint8Array() }).render
    if (render === undefined) throw new Error('missing render route')
    expect(() => render({})).toThrow('sessionId')
    expect(() => render({ sessionId: 'session-1', title: 'x'.repeat(501) })).toThrow('会话标题过长')
  })
})
