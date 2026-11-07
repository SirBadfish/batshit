import type { ObservedUsage } from '$lib/types/executionViewer'

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
