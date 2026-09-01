import {
  CACHE_FORENSICS_SCHEMA_VERSION,
  type CacheForensicsBoundary,
  type CacheForensicsConfidence,
  type CacheForensicsProviderCacheUsage,
  type CacheForensicsRecord,
  type CacheForensicsRuntime,
} from '$lib/types/cacheForensics'
import {
  buildComparisonId,
  CacheForensicsCaptureError,
  fingerprintSegments,
  pseudonymizeId,
  resolveCacheForensicsKey,
  type CacheForensicsSegmentInput,
} from './fingerprint'
import { analyzeDivergence, selectBaselineRecord } from './divergence'

/**
 * SA-093 record assembly (P2).
 *
 * One entry point produces a complete, storage-ready CacheForensicsRecord —
 * including the loud `capture-failed` shape when fingerprinting cannot run
 * (missing key, unserializable input). Capture failure NEVER throws into the
 * send path (DL-093-11); the failure is visible on the record instead.
 */

export interface CaptureCacheForensicsArgs {
  runtime: CacheForensicsRuntime
  boundary: CacheForensicsBoundary
  confidence: CacheForensicsConfidence
  /**
   * Raw internal ids — agent/connection/run are pseudonymized before storage
   * and never stored raw. The model id additionally lands PLAIN on the record
   * for grouping (product metadata, not a personal identifier).
   */
  agentId: string | null | undefined
  connectionId: string | null | undefined
  modelId: string | null | undefined
  runId: string
  experimentGroup?: string | null
  segments: CacheForensicsSegmentInput[]
  providerCacheUsage?: CacheForensicsProviderCacheUsage
  notes?: string[]
  capturedAt?: string
  /** 'subagent' marks managed subagent runs stored on the parent snapshot. */
  actor?: 'primary' | 'subagent'
  /** RAW parent send/message id — pseudonymized before storage like runId. */
  parentRunId?: string | null
}

const CAPTURE_FAILED_COMPARISON_ID = 'capture-failed'

export function captureCacheForensicsRecord(
  args: CaptureCacheForensicsArgs,
): CacheForensicsRecord {
  const capturedAt = args.capturedAt ?? new Date().toISOString()

  try {
    const key = resolveCacheForensicsKey()
    const { segments, truncated } = fingerprintSegments(key, args.segments)

    const record: CacheForensicsRecord = {
      schemaVersion: CACHE_FORENSICS_SCHEMA_VERSION,
      capturedAt,
      comparisonId: buildComparisonId(key, {
        runtime: args.runtime,
        boundary: args.boundary,
        agentId: args.agentId,
        connectionId: args.connectionId,
        modelId: args.modelId,
        experimentGroup: args.experimentGroup ?? null,
      }),
      runtime: args.runtime,
      boundary: args.boundary,
      confidence: args.confidence,
      ...(args.modelId ? { modelId: args.modelId } : {}),
      segments,
      runId: pseudonymizeId(key, 'run', args.runId),
    }

    if (truncated > 0) record.segmentsTruncated = truncated
    if (args.experimentGroup) {
      record.experimentGroup = pseudonymizeId(key, 'experiment', args.experimentGroup)
    }
    if (args.providerCacheUsage) record.providerCacheUsage = args.providerCacheUsage
    if (args.notes?.length) record.notes = [...args.notes]
    if (args.actor === 'subagent') record.actor = 'subagent'
    if (args.parentRunId) {
      record.parentRunId = pseudonymizeId(key, 'run', args.parentRunId)
    }

    return record
  } catch (error) {
    const reason =
      error instanceof CacheForensicsCaptureError
        ? `${error.code}: ${error.message}`
        : `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}`

    return {
      schemaVersion: CACHE_FORENSICS_SCHEMA_VERSION,
      capturedAt,
      comparisonId: CAPTURE_FAILED_COMPARISON_ID,
      runtime: args.runtime,
      boundary: args.boundary,
      confidence: args.confidence,
      segments: [],
      divergence: { state: 'capture-failed', reason },
    }
  }
}

/**
 * Applies default baseline selection + first-divergence analysis to a freshly
 * captured record. `candidates` are earlier runs' records ordered oldest →
 * newest (the Execution Viewer snapshot array order). Returns a new record —
 * inputs are not mutated.
 */
export function applyBaselineComparison(
  current: CacheForensicsRecord,
  candidates: Array<CacheForensicsRecord | null | undefined>,
): CacheForensicsRecord {
  // A failed or evidence-less capture cannot be compared — its divergence
  // already says why (capture-failed / provider-evidence-unavailable).
  if (current.divergence?.state === 'capture-failed') return current
  if (current.segments.length === 0) return current

  // Failed/empty captures must never become baselines: two capture-failed
  // records share the sentinel comparisonId, so filter by real segments too.
  const usable = candidates.filter(
    (candidate): candidate is CacheForensicsRecord =>
      Boolean(candidate) &&
      (candidate as CacheForensicsRecord).segments.length > 0 &&
      (candidate as CacheForensicsRecord).divergence?.state !== 'capture-failed',
  )

  const { baseline, reason } = selectBaselineRecord(current, usable)
  if (!baseline) {
    return {
      ...current,
      divergence: { state: 'not-comparable', reason },
    }
  }

  const divergence = analyzeDivergence(current.segments, baseline.segments)
  return {
    ...current,
    divergence,
    ...(baseline.runId ? { baselineRunId: baseline.runId } : {}),
  }
}
