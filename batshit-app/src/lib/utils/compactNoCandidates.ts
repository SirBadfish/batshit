/**
 * BL-755: a Compact that finds nothing left to compact answers 400 `no_compaction_candidates`. It
 * is not an error — the chat is already under the threshold, sometimes only because a
 * `compaction_changed` retry (`compactEndedEarly.ts`) just refreshed the selection down to
 * nothing. A pressed Compact is told (the existing message, from the local pre-check, already
 * covers the ordinary case; the server's own words cover the rest). An Auto Compact the user never
 * pressed says nothing at all.
 */
export function isSilentAutoCompactNoCandidates(
  mode: 'auto' | 'manual',
  status: number,
  payload: unknown
): boolean {
  if (mode !== 'auto') return false
  if (status !== 400) return false
  return (payload as { code?: unknown } | null)?.code === 'no_compaction_candidates'
}
