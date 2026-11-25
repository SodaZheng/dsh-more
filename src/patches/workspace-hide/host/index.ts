import type { HostPatch } from '../../../kernel/host/patch.js'
import { HIDDEN_WORKSPACES_NAMESPACE, WORKSPACE_HIDE_PATCH_ID } from '../shared.js'
import {
  HiddenWorkspacesSchema,
  hideWorkspace,
  installWorkspaceRegistryHooks,
  unhideAllWorkspaces,
  unhideWorkspace,
} from './hide.js'

export const hostPatch: HostPatch = {
  id: WORKSPACE_HIDE_PATCH_ID,
  setup: (ctx) => {
    const fiber = ctx.inject(['settings', 'workspaceRegistry'], (scope) => {
      const legacy = scope.settings as typeof scope.settings & {
        register?(namespace: string, schema: typeof HiddenWorkspacesSchema): void
      }
      if (typeof legacy.register === 'function') {
        legacy.register(HIDDEN_WORKSPACES_NAMESPACE, HiddenWorkspacesSchema)
      }
      scope.effect(() => installWorkspaceRegistryHooks(scope))
    })
    return () => { void fiber.dispose() }
  },
  routes: ({ ctx }) => ({
    hide: (payload) => hideWorkspace(ctx, payload),
    unhide: (payload) => unhideWorkspace(ctx, payload),
    unhideAll: () => unhideAllWorkspaces(ctx),
  }),
}
