import { describe, expect, it } from 'vitest'
import { markdownFilename } from '../../src/patches/conversation-markdown-export/client/filename.js'

describe('Windows Markdown export names', () => {
  it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con.txt', 'AUX .txt', 'COM¹', 'LPT²', 'ＣＯＮ'])('escapes the reserved device name %s', (title) => {
    expect(markdownFilename(title, 'id')).toBe('_' + title.normalize('NFKC') + '.md')
  })

  it.each(['console', 'COM10', 'LPT0', 'AUX notes', '会议记录', 'release.notes'])('preserves an ordinary title %s', (title) => {
    expect(markdownFilename(title, 'id')).toBe(title + '.md')
  })

  it('strips trailing dots exposed by truncation', () => {
    expect(markdownFilename('a'.repeat(79) + '.more', 'id')).toBe('a'.repeat(79) + '.md')
  })
})
