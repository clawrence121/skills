export type TranscriptPath = string

declare module 'claude-code' {
  interface PluginState {
    'no-compaction': { transcriptPath: TranscriptPath }
  }
}
