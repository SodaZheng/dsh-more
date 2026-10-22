function safeStem(value: string): string {
  const stem = [...value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')]
    .slice(0, 80)
    .join('')
    .replace(/[.\s]+$/g, '')
  // Windows reserves device names even when followed by an extension. NFKC
  // above also folds the reserved superscript digits in COM¹ / LPT².
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?: *[.]| *$)/i.test(stem) ? `_${stem}` : stem
}

export function markdownFilename(title: string, sessionId: string): string {
  const fallback = safeStem(`dsh-conversation-${sessionId}`) || 'dsh-conversation'
  return `${safeStem(title) || fallback}.md`
}
