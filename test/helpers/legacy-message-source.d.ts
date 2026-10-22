import type {} from '@deepseek-ai/dsh-llm'

// Historical persisted messages remain valid inputs to migration/rebuild tests.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    plugin: { kind: 'plugin'; plugin: string; form?: string; sections?: readonly { name: string; text: string }[]; operation?: string; deletedSeqs?: number[] }
  }
}
