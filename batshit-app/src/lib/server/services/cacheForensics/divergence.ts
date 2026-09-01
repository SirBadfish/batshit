import type {
  CacheForensicsDivergence,
  CacheForensicsHistoryStability,
  CacheForensicsRecord,
  CacheForensicsSegment,
} from '$lib/types/cacheForensics'
import { isCompiledHistorySegment } from './compiledMessageSegments'

/**
 * SA-093 first-divergence analysis (P1).
 *
 * Compares two ordered segment lists and names the FIRST Batshit-visible
 * divergence (DL-093-07 wording: this is the first visible change, never a
 * proven provider cause). Segment identity is HMAC equality — content-equal
 * segments are identical regardless of label drift.
 */

function segmentsIdentical(a: CacheForensicsSegment, b: CacheForensicsSegment): boolean {
  return a.hmac === b.hmac
}

function findHmacFrom(
  segments: CacheForensicsSegment[],
  fromIndex: number,
  hmac: string,
): number {
  for (let i = fromIndex; i < segments.length; i += 1) {
    if (segments[i].hmac === hmac) return i
  }
  return -1
}

function prefixTotals(segments: CacheForensicsSegment[], count: number) {
  let bytes = 0
  let tokens = 0
  let hasTokens = false
  for (let i = 0; i < count; i += 1) {
    bytes += segments[i].bytes
    if (typeof segments[i].tokensEstimate === 'number') {
      tokens += segments[i].tokensEstimate as number
      hasTokens = true
    }
  }
  return { bytes, tokens: hasTokens ? tokens : undefined }
}

/**
 * SA-108 compile-stability verdict.
 *
 * Compares ONLY the compiled-history sub-segments, in order, and answers
 * Josh's acceptance bar directly: once a history message is written, is its
 * compiled form still byte-identical on this later send? `firstDivergence`
 * cannot answer that — on a healthy multi-turn send it legitimately lands at
 * the position where the newly-appended turn begins.
 */
export function analyzeHistoryStability(
  current: CacheForensicsSegment[],
  baseline: CacheForensicsSegment[],
): CacheForensicsHistoryStability {
  const currentHistory = current.filter(isCompiledHistorySegment)
  const baselineHistory = baseline.filter(isCompiledHistorySegment)

  const counts = {
    baselineSegments: baselineHistory.length,
    currentSegments: currentHistory.length,
  }

  if (baselineHistory.length === 0 || currentHistory.length === 0) {
    return { state: 'not-applicable', ...counts }
  }

  const shared = Math.min(currentHistory.length, baselineHistory.length)
  let matched = 0
  while (matched < shared && currentHistory[matched].hmac === baselineHistory[matched].hmac) {
    matched += 1
  }

  // Every baseline history segment survived byte-identical and in place.
  if (matched === baselineHistory.length) {
    return { state: 'append-only', ...counts }
  }

  const offending = baselineHistory[matched]
  const position = {
    firstChangedIndex: matched,
    firstChangedLabel: offending.label,
  }

  // The current run is a strict prefix of the baseline: history was cut.
  if (matched === currentHistory.length) {
    return { state: 'shortened', ...counts, ...position }
  }

  // The baseline segment still exists somewhere later in the current run, so
  // it moved rather than changed.
  const movedTo = findHmacFrom(currentHistory, matched, offending.hmac)
  if (movedTo > matched) {
    return { state: 'reordered', ...counts, ...position }
  }

  return { state: 'mutated', ...counts, ...position }
}

/**
 * Analyzes current-run segments against an eligible baseline's segments.
 * Callers must gate eligibility first (see isEligibleBaseline) — this function
 * assumes the comparison itself is legitimate.
 */
export function analyzeDivergence(
  current: CacheForensicsSegment[],
  baseline: CacheForensicsSegment[],
): CacheForensicsDivergence {
  let prefix = 0
  const sharedLength = Math.min(current.length, baseline.length)
  while (prefix < sharedLength && segmentsIdentical(current[prefix], baseline[prefix])) {
    prefix += 1
  }

  const totals = prefixTotals(current, prefix)
  const base: Pick<
    CacheForensicsDivergence,
    | 'reusablePrefixSegments'
    | 'reusablePrefixBytes'
    | 'reusablePrefixTokensEstimate'
    | 'historyStability'
  > = {
    reusablePrefixSegments: prefix,
    reusablePrefixBytes: totals.bytes,
    ...(totals.tokens !== undefined
      ? { reusablePrefixTokensEstimate: totals.tokens }
      : {}),
    // SA-108: always present when a comparison ran, including on
    // 'no-divergence', so a reader never has to infer history stability.
    historyStability: analyzeHistoryStability(current, baseline),
  }

  if (prefix === current.length && prefix === baseline.length) {
    return { state: 'no-divergence', ...base }
  }

  // One list is a strict prefix of the other: pure tail addition/removal.
  if (prefix === baseline.length) {
    return {
      state: 'diverged',
      ...base,
      firstDivergence: {
        kind: 'added',
        index: prefix,
        label: current[prefix].label,
      },
    }
  }
  if (prefix === current.length) {
    return {
      state: 'diverged',
      ...base,
      firstDivergence: {
        kind: 'removed',
        index: prefix,
        label: baseline[prefix].label,
        baselineLabel: baseline[prefix].label,
      },
    }
  }

  const currentSegment = current[prefix]
  const baselineSegment = baseline[prefix]

  // Where does each side's next segment appear on the other side (past the prefix)?
  const currentFoundInBaseline = findHmacFrom(baseline, prefix, currentSegment.hmac)
  const baselineFoundInCurrent = findHmacFrom(current, prefix, baselineSegment.hmac)

  let kind: NonNullable<CacheForensicsDivergence['firstDivergence']>['kind']
  if (currentFoundInBaseline >= 0 && baselineFoundInCurrent >= 0) {
    kind = 'reordered'
  } else if (baselineFoundInCurrent > prefix && currentFoundInBaseline === -1) {
    // The baseline's next segment still exists later in the current run, and the
    // current segment is new content: something was inserted here.
    kind = 'added'
  } else if (currentFoundInBaseline > prefix && baselineFoundInCurrent === -1) {
    // The current segment matches later baseline content: something was removed.
    kind = 'removed'
  } else {
    kind = 'changed'
  }

  return {
    state: 'diverged',
    ...base,
    firstDivergence: {
      kind,
      index: prefix,
      label: kind === 'removed' ? baselineSegment.label : currentSegment.label,
      ...(baselineSegment.label !== currentSegment.label
        ? { baselineLabel: baselineSegment.label }
        : {}),
    },
  }
}

export interface BaselineEligibility {
  eligible: boolean
  reason?: string
}

/**
 * Baseline eligibility gate (DL-093-09): identical schema version, comparison
 * identity (runtime + agent + connection + model + boundary + experiment
 * group), and boundary. Unrelated runs are never silently compared.
 */
export function isEligibleBaseline(
  current: Pick<CacheForensicsRecord, 'schemaVersion' | 'comparisonId' | 'boundary'>,
  candidate: Pick<CacheForensicsRecord, 'schemaVersion' | 'comparisonId' | 'boundary'>,
): BaselineEligibility {
  if (candidate.schemaVersion !== current.schemaVersion) {
    return {
      eligible: false,
      reason: `Baseline uses fingerprint schema v${candidate.schemaVersion}; this run uses v${current.schemaVersion}.`,
    }
  }
  if (candidate.boundary !== current.boundary) {
    return {
      eligible: false,
      reason: `Baseline describes the '${candidate.boundary}' boundary; this run describes '${current.boundary}'.`,
    }
  }
  if (candidate.comparisonId !== current.comparisonId) {
    return {
      eligible: false,
      reason:
        'Baseline has a different comparison identity (runtime, agent, connection, model, or experiment group).',
    }
  }
  return { eligible: true }
}

/**
 * Default baseline selection (DL-093-09): the latest earlier eligible record.
 * `candidates` must be ordered oldest → newest; the current record must not be
 * in the list. Returns the record plus the reason nothing was comparable.
 */
export function selectBaselineRecord(
  current: CacheForensicsRecord,
  candidates: Array<CacheForensicsRecord | null | undefined>,
): { baseline: CacheForensicsRecord | null; reason?: string } {
  let lastReason: string | undefined
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]
    if (!candidate) continue
    const eligibility = isEligibleBaseline(current, candidate)
    if (eligibility.eligible) return { baseline: candidate }
    lastReason = eligibility.reason
  }
  return {
    baseline: null,
    reason:
      lastReason ??
      'No earlier run with a compatible comparison identity exists in this session.',
  }
}
