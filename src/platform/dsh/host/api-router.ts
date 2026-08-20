import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-web-app'
import { PLUGIN_API_PREFIX, PLUGIN_NAME } from '../identity.js'
import { DshMoreError } from './error.js'
import type { HostPatch, HostPatchRuntime, PatchApiHandler } from '../../../kernel/host/patch.js'
import { isTrustedMutationRequest } from './trust.js'
import { readJson, requireJsonContentType, writeError, writeOk } from './wire.js'

interface WebRuntimeFace { trustedHosts: readonly string[] }
interface HostContext extends Context { webRuntime: WebRuntimeFace }
interface RegisteredRoute { patchId: string; handler: PatchApiHandler }

function collectRoutes(patches: readonly HostPatch[], runtime: HostPatchRuntime): Map<string, RegisteredRoute> {
  const collected = new Map<string, RegisteredRoute>()
  for (const patch of patches) {
    for (const [action, handler] of Object.entries(patch.routes(runtime))) {
      const route = `${patch.id}/${action}`
      if (collected.has(route)) throw new Error(`Duplicate patch API route: ${route}`)
      collected.set(route, { patchId: patch.id, handler })
    }
  }
  return collected
}

export function registerPatchApi(
  ctx: Context,
  patches: readonly HostPatch[],
  confirmationSecret: Uint8Array,
  isEnabled: (patchId: string) => boolean,
): void {
  const host = ctx as HostContext
  const routes = collectRoutes(patches, { ctx, confirmationSecret })
  const logger = ctx.logger(PLUGIN_NAME)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PLUGIN_API_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedMutationRequest(req, host.webRuntime.trustedHosts)) {
        writeError(res, new DshMoreError('forbidden', '请求来源不受信任。', 403))
        return
      }
      if (req.method !== 'POST') {
        writeError(res, new DshMoreError('method-not-allowed', '只接受 POST 请求。', 405))
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const routePrefix = `${PLUGIN_API_PREFIX}/`
      const route = pathname.startsWith(routePrefix) ? pathname.slice(routePrefix.length) : ''
      const registered = routes.get(route)
      if (registered === undefined) {
        writeError(res, new DshMoreError('not-found', '未知接口。', 404))
        return
      }
      if (!isEnabled(registered.patchId)) {
        writeError(res, new DshMoreError('patch-disabled', '这个补丁当前已关闭。', 409))
        return
      }
      try {
        requireJsonContentType(req)
        writeOk(res, await registered.handler(await readJson(req)))
      } catch (error) {
        if (!(error instanceof DshMoreError) || error.status >= 500) {
          const detail = error instanceof Error ? error.stack ?? error.message : String(error)
          logger.error('patch API %s failed: %s', route, detail)
        }
        writeError(res, error)
      }
    },
  }), `${PLUGIN_NAME}: patch API`)
}
