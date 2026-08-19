export const MESSAGE_DELETE_PATCH_ID = 'message-delete'

export interface MessageDeletePreview {
  affectedNodeCount: number
  continuationSessionId: string
  confirmToken: string
}
