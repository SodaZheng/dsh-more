import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationMarkdownExport } from '../shared.js'

export interface ConversationMarkdownOptions {
  title: string
  sessionId: string
  exportedAt?: number
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isoTime(value: number): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : '未知时间'
}

function codeFence(value: string, language = ''): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${value}\n${fence}`
}

function jsonBlock(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    serialized = String(value)
  }
  return codeFence(serialized, 'json')
}

function imageDescription(block: Extract<ContentBlock, { type: 'image' }>): string {
  const attachment = block.attachment
  const name = singleLine(attachment.name ?? '图片') || '图片'
  return `[${name}；附件 ID：${String(attachment.attachmentId)}；${attachment.mediaType}；${String(attachment.width)}×${String(attachment.height)}；${String(attachment.bytes)} 字节]`
}

function contentBlockMarkdown(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `<details>\n<summary>思考过程</summary>\n\n${block.text}\n\n</details>`
    case 'image':
      return imageDescription(block)
    case 'tool-call': {
      const name = singleLine(block.name) || '未命名工具'
      return `### 工具调用：${name}\n\n${codeFence(block.arguments, 'json')}`
    }
    case 'tool-result': {
      const status = block.isError === true ? '（失败）' : ''
      return `### 工具结果${status}\n\n${contentMarkdown(block.content)}`
    }
    default:
      return `### 未识别内容\n\n${jsonBlock(block)}`
  }
}

function contentMarkdown(content: readonly ContentBlock[]): string {
  if (content.length === 0) return '（空消息）'
  return content.map(contentBlockMarkdown).filter((part) => part !== '').join('\n\n') || '（空消息）'
}

function messageSection(label: string, time: number, body: string): string {
  return `## ${singleLine(label)}\n\n> 时间：${isoTime(time)}\n\n${body}`
}

function sourceLabel(event: Extract<SessionEvent, { type: 'user/message' }>): string {
  const source = event.data.source
  if (source.kind === 'user') return '用户'
  if (source.kind === 'plugin') return `上下文 · ${singleLine(source.plugin) || '插件'}`
  return '上下文'
}

function toolCallIds(content: readonly ContentBlock[]): string[] {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
    .map((block) => String(block.id))
}

/** Convert one immutable Session event snapshot into a complete Markdown transcript. */
export function conversationMarkdown(
  events: readonly SessionEvent[],
  options: ConversationMarkdownOptions,
): ConversationMarkdownExport {
  const sections: string[] = []
  const renderedCalls = new Set<string>()
  const callNames = new Map<string, string>()

  for (const event of events) {
    if (event.type === 'user/message') {
      sections.push(messageSection(sourceLabel(event), event.time, contentMarkdown(event.data.content)))
      continue
    }
    if (event.type === 'assistant/message') {
      for (const callId of toolCallIds(event.data.message.content)) renderedCalls.add(callId)
      sections.push(messageSection('助手', event.time, contentMarkdown(event.data.message.content)))
      continue
    }
    if (event.type === 'tool/call') {
      const callId = String(event.data.callId)
      callNames.set(callId, event.data.name)
      if (!renderedCalls.has(callId)) {
        sections.push(messageSection(
          `工具调用 · ${singleLine(event.data.name) || '未命名工具'}`,
          event.time,
          codeFence(event.data.arguments, 'json'),
        ))
        renderedCalls.add(callId)
      }
      continue
    }
    if (event.type === 'tool/result') {
      const callId = String(event.data.message.source.callId)
      const block = event.data.message.content[0]
      const failed = block?.type === 'tool-result' && block.isError === true
      const resultContent = block?.type === 'tool-result' ? block.content : event.data.message.content
      const name = singleLine(callNames.get(callId) ?? callId) || '未命名工具'
      sections.push(messageSection(
        `工具结果 · ${name}${failed ? '（失败）' : ''}`,
        event.time,
        contentMarkdown(resultContent),
      ))
    }
  }

  const title = singleLine(options.title) || '未命名会话'
  const exportedAt = isoTime(options.exportedAt ?? Date.now())
  const header = [
    `# ${title}`,
    `- 会话 ID：${singleLine(options.sessionId)}`,
    `- 导出时间：${exportedAt}`,
    `- 记录条目：${String(sections.length)}`,
  ].join('\n\n')
  return {
    markdown: sections.length === 0 ? `${header}\n\n（暂无聊天记录）\n` : `${header}\n\n---\n\n${sections.join('\n\n---\n\n')}\n`,
    entryCount: sections.length,
  }
}
