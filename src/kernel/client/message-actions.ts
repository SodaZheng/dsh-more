import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export type ConversationHeaderProps = PropsRuntime<'conversation.session.header.utilities'>

export interface MessageTarget {
  key: string
  seq: number
  kind: 'user' | 'assistant'
  text: string
  host: HTMLElement
}

export interface MessageActions {
  renderAction(target: MessageTarget): ReactNode
  overlay: ReactNode
}
