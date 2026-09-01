import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import type { CacheForensicsRecord } from '$lib/types/cacheForensics'
import { analyzeDivergence } from './divergence'
import { applyBaselineComparison } from './record'
import {
  exportCacheForensicsRecords,
  resolveCacheForensicsExportConfig,
} from './otlpExport'

/**
 * SA-093 Execution Viewer integration (P2).
 *
 * Forensic records ride the existing per-session snapshot array
 * (`session:{id}:execution_log`) — no new Redis namespace, latest-10 trim and
 * session deletion inherited (DL-093-10). Tool-loop sends store one record per
 * model call: call 1 compares cross-run, later calls compare against the
 * previous call of the same run (intra-loop prefix reuse).
 */

/**
 * Master opt-in gate (DL-093-01): cache forensics is internal developer
 * tooling, enabled only by the server env flag — never a Settings control.
 */
export function isCacheForensicsEnabled(): boolean {
  return (env.BATSHIT_CACHE_FORENSICS || '').trim() === '1'
}

function comparableRecord(
  record: CacheForensicsRecord | null | undefined,
): record is CacheForensicsRecord {
  return Boolean(
    record &&
      record.segments.length > 0 &&
      record.divergence?.state !== 'capture-failed',
  )
}

/**
 * Applies the comparison policy to a run's per-call records:
 * - records[0] compares against earlier runs' first-call records (DL-093-09
 *   default baseline: latest earlier eligible same-session run);
 * - records[i>0] compare against records[i-1] of the SAME run, flagged
 *   `intraRunComparison` so nobody reads them as cross-run evidence.
 */
export function compareRunRecords(
  records: CacheForensicsRecord[],
  crossRunCandidates: Array<CacheForensicsRecord | null | undefined>,
): CacheForensicsRecord[] {
  return records.map((record, index) => {
    if (index === 0) {
      return applyBaselineComparison(record, crossRunCandidates)
    }

    const previousCall = records[index - 1]
    if (record.divergence?.state === 'capture-failed') return record
    if (record.segments.length === 0) return record
    if (!comparableRecord(previousCall)) {
      return {
        ...record,
        intraRunComparison: true,
        divergence: {
          state: 'not-comparable',
          reason: 'The previous model call in this run has no comparable capture.',
        },
      }
    }

    const divergence = analyzeDivergence(record.segments, previousCall.segments)
    return {
      ...record,
      intraRunComparison: true,
      divergence,
      ...(previousCall.runId ? { baselineRunId: previousCall.runId } : {}),
    }
  })
}

/**
 * Compares a run's freshly captured records and patches them onto its
 * Execution Viewer snapshot.
 *
 * Never throws (DL-093-11): storage/comparison failures are logged loudly and
 * the send path continues untouched.
 */
export async function attachCacheForensicsToSnapshot(args: {
  sessionId: string
  snapshotId: string
  records: CacheForensicsRecord[]
}): Promise<CacheForensicsRecord[] | null> {
  try {
    if (args.records.length === 0) return null

    // getSnapshots returns newest-first; cross-run candidates must be oldest →
    // newest and must exclude the current run's own snapshot. The candidate
    // per earlier run is its first PRIMARY record (call 1); subagent records
    // ride the same arrays but are never parent baselines.
    const snapshots = await executionViewerService.getSnapshots(args.sessionId)
    const crossRunCandidates = snapshots
      .filter((snapshot) => snapshot.id !== args.snapshotId)
      .sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      .map((snapshot) =>
        Array.isArray(snapshot.cacheForensics)
          ? snapshot.cacheForensics.find((record) => record?.actor !== 'subagent') ??
            null
          : null,
      )

    const compared = compareRunRecords(args.records, crossRunCandidates)

    // Managed subagent runs finish mid-send and may already have appended
    // their records to this snapshot — the parent's attach must keep them.
    const currentSnapshot = snapshots.find((snapshot) => snapshot.id === args.snapshotId)
    const subagentRecords = Array.isArray(currentSnapshot?.cacheForensics)
      ? currentSnapshot.cacheForensics.filter((record) => record?.actor === 'subagent')
      : []

    await executionViewerService.updateSnapshot(args.sessionId, args.snapshotId, {
      cacheForensics: [...compared, ...subagentRecords],
    })

    // Optional OTLP export runs fire-and-forget AFTER the snapshot write so it
    // can never delay the send path; its outcome is stamped onto the stored
    // records in a follow-up patch (DL-093-11 fail-visible posture).
    if (resolveCacheForensicsExportConfig().state !== 'disabled') {
      void (async () => {
        try {
          const status = await exportCacheForensicsRecords(compared)
          const stamped = compared.map((record) => ({ ...record, export: status }))
          await executionViewerService.updateSnapshot(args.sessionId, args.snapshotId, {
            cacheForensics: [...stamped, ...subagentRecords],
          })
          if (status.state === 'failed') {
            console.error('[cache-forensics] OTLP export failed:', status.error)
          }
        } catch (exportError) {
          console.error(
            '[cache-forensics] OTLP export stamping failed:',
            exportError instanceof Error ? exportError.message : exportError,
          )
        }
      })()
    }

    return compared
  } catch (error) {
    console.error(
      '[cache-forensics] Failed to attach forensic records to Execution Viewer snapshot:',
      error instanceof Error ? error.message : error,
    )
    logger.debug('[cache-forensics] attach failure detail', error)
    return null
  }
}

/**
 * Appends one managed-subagent record to the PARENT send's snapshot (P4).
 *
 * Baselines come from earlier subagent-actor records across the session's
 * retained snapshots (the comparisonId gate keeps comparisons to the same
 * subagent/model/runtime), including earlier subagent runs of the same send.
 * Never throws (DL-093-11).
 */
export async function appendSubagentCacheForensicsRecord(args: {
  sessionId: string
  parentMessageId: string
  record: CacheForensicsRecord
}): Promise<CacheForensicsRecord | null> {
  try {
    const snapshots = await executionViewerService.getSnapshots(args.sessionId)
    const currentSnapshot = snapshots.find(
      (snapshot) => snapshot.id === args.parentMessageId,
    )
    if (!currentSnapshot) {
      console.error(
        '[cache-forensics] No Execution Viewer snapshot exists for the parent send; managed-subagent record was not stored.',
      )
      return null
    }

    const candidates = snapshots
      .slice()
      .sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      .flatMap((snapshot) =>
        Array.isArray(snapshot.cacheForensics) ? snapshot.cacheForensics : [],
      )
      .filter((record) => record?.actor === 'subagent')

    const compared = applyBaselineComparison(args.record, candidates)
    const existing = Array.isArray(currentSnapshot.cacheForensics)
      ? currentSnapshot.cacheForensics
      : []

    await executionViewerService.updateSnapshot(args.sessionId, args.parentMessageId, {
      cacheForensics: [...existing, compared],
    })

    if (resolveCacheForensicsExportConfig().state !== 'disabled') {
      void (async () => {
        try {
          const status = await exportCacheForensicsRecords([compared])
          // Re-read before stamping: the parent's own attach may have
          // rewritten the array while the export was in flight.
          const freshSnapshots = await executionViewerService.getSnapshots(args.sessionId)
          const freshSnapshot = freshSnapshots.find(
            (snapshot) => snapshot.id === args.parentMessageId,
          )
          const freshRecords = Array.isArray(freshSnapshot?.cacheForensics)
            ? freshSnapshot.cacheForensics
            : []
          const stamped = freshRecords.map((record) =>
            record?.runId && record.runId === compared.runId
              ? { ...record, export: status }
              : record,
          )
          await executionViewerService.updateSnapshot(
            args.sessionId,
            args.parentMessageId,
            { cacheForensics: stamped },
          )
          if (status.state === 'failed') {
            console.error('[cache-forensics] OTLP export failed:', status.error)
          }
        } catch (exportError) {
          console.error(
            '[cache-forensics] OTLP export stamping failed:',
            exportError instanceof Error ? exportError.message : exportError,
          )
        }
      })()
    }

    return compared
  } catch (error) {
    console.error(
      '[cache-forensics] Failed to append managed-subagent forensic record:',
      error instanceof Error ? error.message : error,
    )
    logger.debug('[cache-forensics] subagent append failure detail', error)
    return null
  }
}
