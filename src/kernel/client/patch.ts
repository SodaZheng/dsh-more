import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PatchActivationSource } from './activation.js'
import type { ConversationHeaderProps, MessageActions } from './message-actions.js'

/** A self-contained client-side patch contributed to the umbrella plugin. */
export interface ClientPatch {
  readonly id: string
  install(ctx: ClientContext, activation: PatchActivationSource): void
}

/** One patch contributing controls to the shared conversation action row. */
export interface MessageActionPatch {
  readonly id: string
  readonly order: number
  useActions(props: ConversationHeaderProps & { ctx: ClientContext }, enabled: boolean): MessageActions
}
