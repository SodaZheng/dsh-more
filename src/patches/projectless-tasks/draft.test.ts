import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionInput, InputState, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { transferBeforeOpen, transferDraft } from './client/draft.js'

function draft(text: string, imageIds: string[] = [], phase: InputState['phase'] = 'plain') {
  let data = { draft: text, imageIds: imageIds as DraftAttachmentId[], phase }
  return {
    state: { getSnapshot: () => data },
    setDraft: vi.fn((value: string) => { data = { ...data, draft: value } }),
    addImages: vi.fn((ids: DraftAttachmentId[]) => { data = { ...data, imageIds: [...new Set([...data.imageIds, ...ids])] }; return true }),
    removeImage: vi.fn((id: DraftAttachmentId) => { data = { ...data, imageIds: data.imageIds.filter((item) => item !== id) } }),
  }
}
const asDraft = (value: ReturnType<typeof draft>): Pick<SessionInput, 'state' | 'setDraft' | 'addImages' | 'removeImage'> => value as never

describe('workspace to independent draft handoff', () => {
  it('moves text and image references after target admission', () => {
    const source = draft('未发送的需求 @设计图', ['image-1', 'image-2'])
    const target = draft('')
    transferDraft(asDraft(source), asDraft(target))
    expect(target.state.getSnapshot()).toMatchObject({ draft: '未发送的需求 @设计图', imageIds: ['image-1', 'image-2'] })
    expect(source.state.getSnapshot()).toMatchObject({ draft: '', imageIds: [] })
    expect(target.addImages.mock.invocationCallOrder[0]).toBeLessThan(source.setDraft.mock.invocationCallOrder[0]!)
    transferDraft(asDraft(source), asDraft(target))
    expect(target.state.getSnapshot().draft).toBe('未发送的需求 @设计图')
  })

  it('retains the entire source when target image admission fails', () => {
    const source = draft('保留我', ['image'])
    const target = draft('')
    target.addImages.mockReturnValueOnce(false)
    expect(() => transferDraft(asDraft(source), asDraft(target))).toThrow('原草稿已保留')
    expect(source.state.getSnapshot()).toMatchObject({ draft: '保留我', imageIds: ['image'] })
    expect(source.setDraft).not.toHaveBeenCalled()
    expect(source.removeImage).not.toHaveBeenCalled()
    expect(target.setDraft).not.toHaveBeenCalled()
  })

  it('rejects active submission and conflicting target drafts without overwriting them', () => {
    const source = draft('原草稿')
    const target = draft('其他草稿')
    expect(() => transferDraft(asDraft(source), asDraft(target))).toThrow('其他草稿')
    expect(target.setDraft).not.toHaveBeenCalled()
    expect(() => transferDraft(asDraft(draft('原草稿', [], 'submitting')), asDraft(draft('')))).toThrow('输入正在处理中')
  })

  it('does not navigate after the user selects another session, or migrate a started session', () => {
    const sourceId = 'source' as SessionId
    const targetId = 'target' as SessionId
    const scope = vi.fn()
    const sessions = { scope, list: { getSnapshot: () => ({ current: 'other', byId: {} }) } }
    expect(transferBeforeOpen({ sessions } as never, sourceId, targetId)).toBe(false)
    expect(scope).not.toHaveBeenCalled()
    sessions.list.getSnapshot = () => ({ current: sourceId, byId: { source: { blank: false } } })
    expect(() => transferBeforeOpen({ sessions } as never, sourceId, targetId)).toThrow('当前会话已开始')
    expect(scope).not.toHaveBeenCalled()
  })
})
