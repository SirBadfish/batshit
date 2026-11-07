import type { ObservedUsage } from './executionViewer'

export type DelegatedRunKind = 'subagent' | 'worker'
/**
 * How a delegated run ended. `partial`: a limit stopped it, either its Subagent's tool-step limit
 * (delegation limits, 2026-10-24) or its last model call's output limit (BL-2356); its output is the
 * work so far, led by a note that says which limit.
 */
export type DelegatedRunStatus = 'completed' | 'failed' | 'timed_out' | 'partial'

/** Every status a saved delegated run may carry; a reader drops a record with any other. */
export const DELEGATED_RUN_STATUSES: readonly DelegatedRunStatus[] = ['completed', 'failed', 'timed_out', 'partial']
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
  observedUsage?: ObservedUsage
  observedUsageUnavailable?: 'invalid'
  durationMs: number
  status: DelegatedRunStatus
  thread: DelegatedRunThread
}

export interface DelegatedRunTotals {
  runs: number
  completed: number
  failed: number
  timedOut: number
  /** Runs a step limit or an output limit stopped (`partial`). Absent on a summary saved before 2026-10-24. */
  partial?: number
  usageKnownRuns: number
  usageUnknownRuns: number
  usage: DelegatedUsage | null
}

export interface DelegatedExecutionSummary {
  runs: DelegatedRunRecord[]
  totals: DelegatedRunTotals
}
