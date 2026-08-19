export const MESSAGE_EDIT_PATCH_ID = 'message-edit'

export interface MessageEditPreview {
  turn: number
  laterTurnCount: number
  continuationSessionId: string
  confirmToken: string
}
