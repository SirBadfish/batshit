/**
 * SA-093 P7: the code-owned cache-hit-rate formula for the chat-bar strip.
 *
 * cacheHitRate% = cachedInputTokens / inputTokens × 100, computed from
 * Batshit's normalized usage (AI SDK v7 semantics: `inputTokens` is the total
 * input INCLUDING cache reads/writes, with the split in `inputTokenDetails`).
 *
 * Honesty rules (DL-093-14):
 * - both numbers must be reported and inputTokens > 0, else null (unknown);
 * - never derived from latency;
 * - clamped to [0, 100] so a provider normalization quirk can never render
 *   an impossible percentage.
 */

export interface CacheHitRateUsageLike {
  inputTokens?: number | null
  cachedInputTokens?: number | null
  inputTokenDetails?: {
    cacheReadTokens?: number | null
  } | null
}

/**
 * Extract the eligible (inputTokens, cachedTokens) pair from a normalized
 * usage object, or null when the response did not report both numbers.
 * Eligibility here is THE rule for both the per-response percent and the
 * whole-chat aggregate — a response that reports no cache data is excluded
 * from both, never counted as 0%.
 */
export function extractCacheUsage(
  usage: CacheHitRateUsageLike | null | undefined,
): { inputTokens: number; cachedTokens: number } | null {
  if (!usage) return null

  const inputTokens =
    typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
      ? usage.inputTokens
      : null
  const cachedRaw =
    typeof usage.cachedInputTokens === 'number' &&
    Number.isFinite(usage.cachedInputTokens)
      ? usage.cachedInputTokens
      : typeof usage.inputTokenDetails?.cacheReadTokens === 'number' &&
          Number.isFinite(usage.inputTokenDetails.cacheReadTokens)
        ? usage.inputTokenDetails.cacheReadTokens
        : null

  if (inputTokens === null || cachedRaw === null) return null
  if (inputTokens <= 0) return null

  return { inputTokens, cachedTokens: Math.max(0, cachedRaw) }
}

export function computeCacheHitRatePercent(
  usage: CacheHitRateUsageLike | null | undefined,
): number | null {
  const extracted = extractCacheUsage(usage)
  if (!extracted) return null

  const percent = (extracted.cachedTokens / extracted.inputTokens) * 100
  return Math.min(100, Math.max(0, percent))
}

export interface SessionCacheAggregate {
  /** Token-weighted overall hit rate: total cached / total input × 100, clamped [0, 100]. */
  percent: number
  cachedTokens: number
  inputTokens: number
  /** How many responses reported eligible cache usage and are included. */
  responseCount: number
}

/**
 * Whole-chat aggregate over every response's normalized usage. Token-weighted
 * (total cached / total input), so long prompts count more than short ones —
 * this is the rate a provider actually billed, not an average of percents.
 * Returns null when no response reported eligible cache usage.
 */
export function computeSessionCacheAggregate(
  usages: Array<CacheHitRateUsageLike | null | undefined>,
): SessionCacheAggregate | null {
  let cachedTokens = 0
  let inputTokens = 0
  let responseCount = 0

  for (const usage of usages) {
    const extracted = extractCacheUsage(usage)
    if (!extracted) continue
    cachedTokens += extracted.cachedTokens
    inputTokens += extracted.inputTokens
    responseCount += 1
  }

  if (responseCount === 0 || inputTokens <= 0) return null

  const percent = Math.min(100, Math.max(0, (cachedTokens / inputTokens) * 100))
  return { percent, cachedTokens, inputTokens, responseCount }
}

/** Display form: whole percent, e.g. 87 → "87%". */
export function formatCacheHitRatePercent(percent: number | null): string | null {
  if (percent === null) return null
  return `${Math.round(percent)}%`
}
