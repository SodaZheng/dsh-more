import type { ClientPatch } from '../../../kernel/client/patch.js'
import { PROJECTLESS_TASKS_PATCH_ID } from '../shared.js'
import { installConversationAdapter } from './adapter.js'
import { installPickerAdapter } from './picker.js'
import { installNewSessionNavigation } from './new-session.js'

export const clientPatch: ClientPatch = {
  id: PROJECTLESS_TASKS_PATCH_ID,
  install: (ctx, activation) => {
    ctx.inject(['conversation', 'uiWorkspace'], (scope) => {
      scope.effect(() => installNewSessionNavigation(scope, activation))
      scope.slots.inject('conversation', () => installConversationAdapter(scope, activation))
      scope.slots.inject('conversation.hero.workspace', () => installPickerAdapter(scope))
    })
  },
}
