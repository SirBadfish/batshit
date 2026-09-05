export type DelegatedRunKind = 'subagent' | 'worker'
export type DelegatedRunStatus = 'completed' | 'failed' | 'timed_out'
export type DelegatedRunThread = 'fresh' | 'resumed' | 'resumed-empty' | null

export interface DelegatedUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
}

export interface DelegatedRunRecord {
  kind: DelegatedRunKind
  name: string
  type: string
  model: string | null
  provider: string | null
  usage: DelegatedUsage | null
  durationMs: number
  status: DelegatedRunStatus
  thread: DelegatedRunThread
}

export interface DelegatedRunTotals {
  runs: number
  completed: number
  failed: number
  timedOut: number
  usageKnownRuns: number
  usageUnknownRuns: number
  usage: DelegatedUsage | null
}

export interface DelegatedExecutionSummary {
  runs: DelegatedRunRecord[]
  totals: DelegatedRunTotals
}
