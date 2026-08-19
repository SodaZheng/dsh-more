import { isReplacementSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import {
  MESSAGE_VISIBILITY_PROJECTION_KEY,
  type MessageVisibilityProjection,
} from '../../../kernel/message-visibility.js'
import { PLUGIN_NAME } from '../../../platform/dsh/identity.js'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    dshMoreMessageDelete: MessageVisibilityProjection
  }
}

const schema = z.object({
  deletedSeqs: z.array(z.number().int().nonnegative()),
  hiddenTrajectoryKeys: z.array(z.string()),
})

function deletionUpdate(event: SessionEvent): { seqs: number[]; trajectoryKeys: string[] } | null {
  if (!isReplacementSurfaceEvent(event)) return null
  let metadata: { operation?: unknown; deletedSeqs?: unknown } | undefined
  if (event.type === 'user/message') {
    const source = event.data.source as {
      kind?: unknown
      plugin?: unknown
      operation?: unknown
      deletedSeqs?: unknown
    }
    if (source.kind === 'plugin' && source.plugin === PLUGIN_NAME) metadata = source
  } else if (event.type === 'assistant/message') {
    const replayState = event.data.message.source.replayState as {
      dshMoreMessageDelete?: { operation?: unknown; deletedSeqs?: unknown }
    } | undefined
    metadata = replayState?.dshMoreMessageDelete
  }
  if (metadata?.operation !== 'delete-message') return null
  if (!Array.isArray(metadata.deletedSeqs) || !metadata.deletedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)) return null
  return {
    seqs: [...metadata.deletedSeqs as number[], event.seq],
    trajectoryKeys: event.type === 'assistant/message'
      ? [`assistant\u0000${String(event.data.turn)}\u0000${String(event.data.step)}`]
      : [],
  }
}

export const messageDeleteProjection: ProjectionDefinition<typeof MESSAGE_VISIBILITY_PROJECTION_KEY, MessageVisibilityProjection> = {
  key: MESSAGE_VISIBILITY_PROJECTION_KEY,
  schema,
  stateVersion: 3,
  init: () => ({ deletedSeqs: [], hiddenTrajectoryKeys: [] }),
  apply: (state, event) => {
    const added = deletionUpdate(event)
    if (added === null) return state
    const nextSeqs = [...new Set([...state.deletedSeqs, ...added.seqs])].sort((a, b) => a - b)
    const nextKeys = [...new Set([...state.hiddenTrajectoryKeys, ...added.trajectoryKeys])]
    if (nextSeqs.length === state.deletedSeqs.length && nextKeys.length === state.hiddenTrajectoryKeys.length) return state
    return { deletedSeqs: nextSeqs, hiddenTrajectoryKeys: nextKeys }
  },
  view: (state) => state,
}
