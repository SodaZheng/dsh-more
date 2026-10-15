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
  private readonly observers: Array<() => void> = []
  private settings: PatchSettings = { ...DEFAULT_PATCH_SETTINGS }

  constructor(private readonly ctx: Context, patches: readonly HostPatch[]) {
    this.byId = new Map(patches.map((patch) => [patch.id, patch]))
    try {
      for (const patch of patches) {
        const dispose = patch.observe?.(ctx)
        if (dispose !== undefined) this.observers.push(dispose)
      }
    } catch (error) {
      const failures = [error]
      for (const dispose of this.observers.splice(0).reverse()) {
        try { dispose() } catch (failure) { failures.push(failure) }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'patch observation failed')
      throw error
    }
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
    const disposers = [...this.disposers.values()].reverse()
    this.disposers.clear()
    disposers.push(...this.observers.splice(0).reverse())
    const failures: unknown[] = []
    for (const dispose of disposers) {
      try { dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'patch cleanup failed')
  }
}
