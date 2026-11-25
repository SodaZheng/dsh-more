import type { ClientPatch } from '../../../kernel/client/patch.js'
import { bindSettings } from '../../../platform/dsh/client/settings.js'
import { decodeSessionGroups, SESSION_GROUPS_NAMESPACE, type SessionGroups } from '../../projectless-tasks/groups.js'
import { decodeHiddenWorkspaces, HIDDEN_WORKSPACES_NAMESPACE, WORKSPACE_HIDE_PATCH_ID, type HiddenWorkspaces } from '../shared.js'
import { installHiddenNewSessionNavigation } from './new-session.js'
import { installPickerHideAdapter } from './picker.js'
import { installSidebarHideAdapter } from './sidebar.js'
import { createHiddenWorkspaceController } from './store.js'

export const clientPatch: ClientPatch = {
  id: WORKSPACE_HIDE_PATCH_ID,
  install: (ctx, activation) => {
    const scope = bindSettings<HiddenWorkspaces>(ctx, {
      namespace: HIDDEN_WORKSPACES_NAMESPACE,
      decode: decodeHiddenWorkspaces,
    })
    const controller = createHiddenWorkspaceController(scope)
    ctx.effect(() => () => controller.dispose())

    let groupsScope: ReturnType<typeof bindSettings<SessionGroups>> | undefined
    try {
      groupsScope = bindSettings<SessionGroups>(ctx, {
        namespace: SESSION_GROUPS_NAMESPACE,
        decode: decodeSessionGroups,
      })
    } catch {
      groupsScope = undefined
    }

    ctx.slots.inject('sidebar.workspaces' as 'sidebar', () =>
      installSidebarHideAdapter(ctx, activation, controller, groupsScope),
    )
    ctx.slots.inject('conversation.hero.workspace', () =>
      installPickerHideAdapter(ctx, activation, controller),
    )
    ctx.inject(['sessions', 'workspaces', 'uiWorkspace'], (scopeCtx) => {
      scopeCtx.effect(() => installHiddenNewSessionNavigation(scopeCtx, activation, controller))
    })
  },
}
