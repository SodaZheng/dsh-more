import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web-app'
import { HOST_PATCHES } from './generated/host-registry.js'
import { HostPatchActivation } from './kernel/host/activation.js'
import { installPatchSettings } from './kernel/host/settings.js'
import { registerPatchApi } from './platform/dsh/host/api-router.js'
import { PLUGIN_NAME } from './platform/dsh/identity.js'

export const name = PLUGIN_NAME
export const inject = [
  'webServer', 'webRuntime', 'agents', 'sessions',
  'sessionPersistence', 'sessionProjections', 'workspaceRegistry', 'agentPresets', 'settings',
]

export function apply(ctx: Context): void {
  const activation = new HostPatchActivation(ctx, HOST_PATCHES)
  ctx.effect(() => () => activation.dispose(), `${PLUGIN_NAME}: patch activation`)
  installPatchSettings(ctx, activation)
  registerPatchApi(ctx, HOST_PATCHES, randomBytes(32), (patchId) => activation.isEnabled(patchId))
}
