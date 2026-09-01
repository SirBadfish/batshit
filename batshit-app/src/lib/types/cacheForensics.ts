/**
 * SA-093 cache-forensics contract (v1).
 *
 * A forensic record describes ONE run's ordered, Batshit-visible request
 * sections as keyed fingerprints — never raw content. Records ride the
 * Execution Viewer snapshot (`ExecutionSnapshot.cacheForensics`) so they
 * inherit its latest-10 retention and session-deletion lifecycle (DL-093-10).
 *
 * Privacy posture (DL-093-05/06): every hash is a full-length HMAC-SHA-256
 * computed with a server-only key derived from ENCRYPTION_KEY; the record
 * stores hashes, order, sizes, and code-owned labels only.
 */

/**
 * v2 (SA-108): Batshit's single compiled user message is sub-segmented into
 * per-history-message + current-turn segments, and the divergence record
 * carries an explicit `historyStability` verdict. The segment list shape
 * changed, so v1 records must NOT be compared against v2 records —
 * `isEligibleBaseline` already refuses that with a plain-language reason.
 */
export const CACHE_FORENSICS_SCHEMA_VERSION = 2

export type CacheForensicsRuntime = 'vercel' | 'codex' | 'claude' | 'n8n'

/**
 * Which request boundary the segments describe (DL-093-08):
 * - 'batshit-compiled': Batshit's own compiled prompt/tools/options (exact for
 *   every runtime).
 * - 'provider-request': the best available provider request object after the
 *   run (exact/near for `API`; unavailable for hidden n8n/CLI boundaries).
 */
export type CacheForensicsBoundary = 'batshit-compiled' | 'provider-request'

export type CacheForensicsConfidence = 'exact' | 'near' | 'estimated'

export type CacheForensicsSegmentType =
  | 'system-prompt'
  | 'tool'
  | 'history-message'
  | 'current-user-turn'
  | 'attachment'
  | 'provider-options'
  | 'cache-policy'
  | 'runtime-addendum'
  | 'request-block'

export interface CacheForensicsSegment {
  /** 0-based position in the ordered request view. */
  index: number
  type: CacheForensicsSegmentType
  /** Code-owned label, e.g. 'system', 'tool:native_batshit_tool_search', 'history[3]:user'. */
  label: string
  /** Full HMAC-SHA-256 hex (64 chars) of the segment's canonical serialization. */
  hmac: string
  /** UTF-8 byte length of the canonical serialization. */
  bytes: number
  /** Character length of the canonical serialization. */
  chars: number
  /** Optional token estimate for the segment (estimated unless stated). */
  tokensEstimate?: number
  confidence: CacheForensicsConfidence
}

export type CacheForensicsDivergenceState =
  | 'not-comparable'
  | 'no-divergence'
  | 'diverged'
  | 'provider-evidence-unavailable'
  | 'capture-failed'

export type CacheForensicsDivergenceKind =
  | 'changed'
  | 'added'
  | 'removed'
  | 'reordered'

export interface CacheForensicsFirstDivergence {
  kind: CacheForensicsDivergenceKind
  /** Index in the CURRENT run where the divergence starts. */
  index: number
  /** Label of the diverging current segment (or the removed baseline segment). */
  label: string
  /** Baseline-side label when it differs from the current-side label. */
  baselineLabel?: string
}

/**
 * SA-108 compile-stability verdict for the compiled chat history.
 *
 * Josh's acceptance bar: once a history message is written, its compiled form
 * must be byte-stable on every later send. A ONE-TIME rendering transition
 * (content compressing once as it ages out of the zip buffer) is acceptable
 * and shows up here as `mutated` on exactly one send, at the aged index.
 *
 * - 'append-only'    — every baseline history segment is byte-identical and in
 *                      place; only newer turns were added. The healthy state.
 * - 'mutated'        — an already-written history message changed.
 * - 'shortened'      — history segments disappeared (compaction, trim, or
 *                      Infinite-Session graduation).
 * - 'reordered'      — a baseline history segment moved.
 * - 'not-applicable' — one side carried no compiled-history sub-segments
 *                      (a cold send, or a non-Batshit request shape).
 */
export type CacheForensicsHistoryStabilityState =
  | 'append-only'
  | 'mutated'
  | 'shortened'
  | 'reordered'
  | 'not-applicable'

export interface CacheForensicsHistoryStability {
  state: CacheForensicsHistoryStabilityState
  /** Compiled-history sub-segments on the baseline side. */
  baselineSegments: number
  /** Compiled-history sub-segments on the current side. */
  currentSegments: number
  /** Position (within the history sub-list) of the first offending segment. */
  firstChangedIndex?: number
  /** Label of the first offending segment, when there is one. */
  firstChangedLabel?: string
}

export interface CacheForensicsDivergence {
  state: CacheForensicsDivergenceState
  /** Populated for 'not-comparable' and 'capture-failed'. */
  reason?: string
  firstDivergence?: CacheForensicsFirstDivergence
  /** Identical leading segments shared with the baseline. */
  reusablePrefixSegments?: number
  /** Canonical bytes covered by that identical leading run. */
  reusablePrefixBytes?: number
  reusablePrefixTokensEstimate?: number
  /**
   * SA-108: compile-stability verdict for the compiled chat history alone.
   * `firstDivergence` legitimately lands at "where the new turn begins" on a
   * perfectly healthy multi-turn send, so this is the field that answers
   * whether already-written history stayed byte-stable.
   */
  historyStability?: CacheForensicsHistoryStability
}

export interface CacheForensicsProviderCacheUsage {
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  inputTokens?: number
  source?: string
}

export type CacheForensicsExportState = 'disabled' | 'exported' | 'failed'

export interface CacheForensicsExportStatus {
  state: CacheForensicsExportState
  /** Error class/message for 'failed' — never credentials or endpoints with secrets. */
  error?: string
  /** Redacted destination class, e.g. 'loopback-otlp'. */
  destinationClass?: string
}

export interface CacheForensicsRecord {
  schemaVersion: typeof CACHE_FORENSICS_SCHEMA_VERSION
  capturedAt: string
  /**
   * Pseudonymous comparison identity: HMAC over runtime|agent|connection|model|
   * boundary (+ experiment group). Equal ids gate baseline eligibility
   * (DL-093-09) without exposing raw identifiers.
   */
  comparisonId: string
  /** Pseudonymized explicit experiment-group id (optional, DL-093-09). */
  experimentGroup?: string
  runtime: CacheForensicsRuntime
  boundary: CacheForensicsBoundary
  /** Overall evidence confidence at this boundary (DL-093-08). */
  confidence: CacheForensicsConfidence
  /**
   * Plain model id for grouping/filtering (a model name is product metadata,
   * not a personal identifier — DL-093-05 covers user/session/agent ids).
   */
  modelId?: string | null
  segments: CacheForensicsSegment[]
  /** Count of segments dropped by the bounds cap, when any. */
  segmentsTruncated?: number
  /** Divergence vs the selected baseline run, when comparison ran. */
  divergence?: CacheForensicsDivergence
  /** Pseudonymous run id of the baseline this record was compared against. */
  baselineRunId?: string
  /** Pseudonymous id of THIS run (what later runs reference as baselineRunId). */
  runId?: string
  /** Normalized provider cache evidence for the run, when reported. */
  providerCacheUsage?: CacheForensicsProviderCacheUsage
  /**
   * 1-based model-call index inside a tool-loop send. Call 1 compares against
   * the previous eligible RUN; call 2+ compare against the previous CALL of
   * the same run (intra-loop prefix reuse), marked by `intraRunComparison`.
   */
  callIndex?: number
  /** True when `divergence` compares against the previous call of the same run. */
  intraRunComparison?: boolean
  /**
   * Who ran: absent/'primary' = the primary agent's own model calls;
   * 'subagent' = a managed subagent run captured on the parent's snapshot
   * (P4: subagents fingerprint their own contract, never the parent's).
   */
  actor?: 'primary' | 'subagent'
  /** Pseudonymous run id of the PARENT send a subagent record belongs to. */
  parentRunId?: string
  export?: CacheForensicsExportStatus
  notes?: string[]
}
