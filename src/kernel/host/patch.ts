import type { Context } from '@deepseek-ai/cordis'

export type PatchApiHandler = (payload: unknown) => unknown | Promise<unknown>

export interface HostPatchRuntime {
  ctx: Context
  confirmationSecret: Uint8Array
}

/** A self-contained host-side patch contributed to the umbrella plugin. */
export interface HostPatch {
  readonly id: string
  setup?(ctx: Context): () => void
  routes(runtime: HostPatchRuntime): Readonly<Record<string, PatchApiHandler>>
}
