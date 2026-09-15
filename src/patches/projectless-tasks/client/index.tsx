import type { ClientPatch } from '../../../kernel/client/patch.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../shared.js'
import { CONVERSATION_SLOTS, conversationSlot, installConversationAdapter } from './adapter.js'
import { installPickerAdapter } from './picker.js'
import { installNewSessionNavigation } from './new-session.js'
import { installSessionGrouping } from './groups.js'

export const clientPatch: ClientPatch = {
  id: PROJECTLESS_TASKS_PATCH_ID,
  install: (ctx, activation) => {
    installSessionGrouping(ctx, activation)
    ctx.inject(['conversation', 'uiWorkspace'], (scope) => {
      scope.effect(() => installNewSessionNavigation(scope, activation))
      for (const name of CONVERSATION_SLOTS) {
        scope.slots.inject(conversationSlot(name), () => installConversationAdapter(scope, activation, name))
      }
      scope.slots.inject('conversation.hero.workspace', () => installPickerAdapter(scope))
    })
  },
}
