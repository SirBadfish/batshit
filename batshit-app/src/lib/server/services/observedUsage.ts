import type { ObservedUsage } from '$lib/types/executionViewer'
import type { DelegatedUsage } from '$lib/types/delegation'
import { normalizeUsageLike } from './apiProviderUsage'

export const OBSERVED_USAGE_FIELDS = [
  'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheCreationInputTokens'
] as const

export function observedCounts(value: unknown): ObservedUsage['parts'][number]['counts'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const counts: Record<string, number> = {}
  for (const field of OBSERVED_USAGE_FIELDS) {
    const count = record[field]
    if (typeof count === 'number' && Number.isFinite(count)) counts[field] = count
  }
  return Object.keys(counts).length > 0 ? counts : null
}

/** Plain reported portions are not normalized into billable whole-run usage. */
export function readObservedUsage(value: unknown): ObservedUsage | undefined {
  if (value === null || value === undefined) return undefined
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
  if (record?.completeness !== 'partial' || !Array.isArray(record.parts)) {
    throw new Error('The stored observed usage evidence is invalid; its portions were not replaced.')
  }
  const parts: ObservedUsage['parts'] = []
  for (const part of record.parts) {
    const source = part?.source
    if (source !== 'codex-app-server-progress' && source !== 'run-usage-prefix') {
      throw new Error('The stored observed usage evidence has an unknown source; its portions were not replaced.')
    }
    const counts = observedCounts(part?.counts)
    if (!counts) throw new Error('The stored observed usage evidence has no reported counts; its portions were not replaced.')
    parts.push({ source, counts })
  }
  if (parts.length === 0) throw new Error('The stored observed usage evidence has no portions; it was not replaced.')
  return { completeness: 'partial', parts }
}

export type CodexDelegatedAccounting = {
  usage: DelegatedUsage | null
  observedUsage?: ObservedUsage
  observedUsageUnavailable?: 'invalid'
}

/** One invocation, one immediate result boundary; no event/Redis/EV writer or cleanup wait. */
export function createCodexDelegatedAccounting() {
  let getter: (() => ObservedUsage | undefined) | undefined
  let usage: DelegatedUsage | null = null
  let consumedCompletion = false
  let observation: unknown
  let frozen: CodexDelegatedAccounting | undefined
  const copyUsage = (value: DelegatedUsage | null): DelegatedUsage | null => value ? {
    ...value,
    ...(value.inputTokenDetails ? { inputTokenDetails: { ...value.inputTokenDetails } } : {}),
    ...(value.outputTokenDetails ? { outputTokenDetails: { ...value.outputTokenDetails } } : {})
  } : null
  const copy = (value: CodexDelegatedAccounting): CodexDelegatedAccounting => ({
    usage: copyUsage(value.usage),
    ...(value.observedUsage ? { observedUsage: readObservedUsage(value.observedUsage) } : {}),
    ...(value.observedUsageUnavailable ? { observedUsageUnavailable: value.observedUsageUnavailable } : {})
  })
  return {
    discard() { if (!frozen) frozen = { usage: null } },
    register(source: () => ObservedUsage | undefined) {
      if (!frozen) getter = source // REGISTER ONLY: do not read/freeze a running lane.
    },
    reportCompleted(value: unknown) {
      if (frozen) return
      consumedCompletion = true
      usage = copyUsage(normalizeUsageLike(value) ?? null)
    },
    reportFinish(payload: { totalUsage?: unknown; observedUsage?: unknown }) {
      if (frozen) return
      if (payload.totalUsage !== undefined && payload.totalUsage !== null) usage = copyUsage(normalizeUsageLike(payload.totalUsage) ?? null)
      if (payload.observedUsage !== undefined) observation = payload.observedUsage
    },
    freeze(): CodexDelegatedAccounting {
      if (!frozen) {
        if (usage || consumedCompletion) frozen = { usage: copyUsage(usage) }
        else {
          try {
            const observedUsage = readObservedUsage(getter ? getter() : observation)
            frozen = { usage: null, ...(observedUsage ? { observedUsage } : {}) }
          } catch {
            // Explicit unavailable state, never silently drop the run or infer a zero.
            frozen = { usage: null, observedUsageUnavailable: 'invalid' }
          }
        }
      }
      return copy(frozen)
    }
  }
}
