import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_PATCH_SETTINGS,
  type PatchId,
  type PatchSettings,
} from '../../generated/patch-catalog.js'
import type { HostPatch } from './patch.js'

const NOOP = (): void => undefined

/** Own the independently disposable Host setup of every enabled patch. */
export class HostPatchActivation {
  private readonly byId: ReadonlyMap<string, HostPatch>
  private readonly disposers = new Map<string, () => void>()
  private settings: PatchSettings = { ...DEFAULT_PATCH_SETTINGS }

  constructor(private readonly ctx: Context, patches: readonly HostPatch[]) {
    this.byId = new Map(patches.map((patch) => [patch.id, patch]))
  }

  apply(next: PatchSettings): void {
    for (const [id, patch] of this.byId) {
      const enabled = next[id as PatchId] === true
      const active = this.disposers.has(id)
      if (enabled && !active) this.disposers.set(id, patch.setup?.(this.ctx) ?? NOOP)
      else if (!enabled && active) {
        const dispose = this.disposers.get(id)
        this.disposers.delete(id)
        dispose?.()
      }
    }
    this.settings = { ...next }
  }

  isEnabled(id: string): boolean {
    return this.settings[id as PatchId] === true && this.byId.has(id)
  }

  dispose(): void {
    for (const dispose of [...this.disposers.values()].reverse()) dispose()
    this.disposers.clear()
  }
}
