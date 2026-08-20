function safeStem(value: string): string {
  return [...value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')]
    .slice(0, 80)
    .join('')
    .trim()
}

export function markdownFilename(title: string, sessionId: string): string {
  const fallback = safeStem(`dsh-conversation-${sessionId}`) || 'dsh-conversation'
  return `${safeStem(title) || fallback}.md`
}
