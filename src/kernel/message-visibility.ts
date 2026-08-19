/** Shared projection contract used to suppress message surfaces removed by a patch. */
export const MESSAGE_VISIBILITY_PROJECTION_KEY = 'dshMoreMessageDelete'

export interface MessageVisibilityProjection {
  deletedSeqs: number[]
  hiddenTrajectoryKeys: string[]
}
