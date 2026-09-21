/**
 * SA-120 Jev Juice — evidence helpers (DL-120-02/07).
 *
 * Every call becomes one `TypesafeCallRecord`. Where it lands:
 * - a lane that runs BEFORE `send-routed` records its snapshot pushes records into
 *   the in-memory `executionMetadata.typesafeCalls` before `recordSnapshot`;
 * - a lane that runs AFTER the snapshot exists (post-turn checks) calls
 *   `appendTypesafeCallRecords`, a read-modify-write of `executionMetadata` on the
 *   stored snapshot (the other finish-time patches touch different top-level fields).
 *
 * A miss on a compile lane also produces a `JevJuiceNote` for the assistant message
 * (`metadata.jevJuice.notes`), which `JevJuiceNote.svelte` renders beside the memory chips.
 */

import type { JevJuiceNote, TypesafeCallRecord } from '$lib/types/typesafe'
import { readTypesafeCallRecords, type TypesafeFeatureId } from '$lib/utils/jevJuice'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import type { TypesafeCallOutcome } from './typesafeClient'

export { readTypesafeCallRecords }

export interface CreateTypesafeCallRecordInput {
  featureId: TypesafeFeatureId
  requestedModel: string
  questionCount: number
  /** `null` when the access rule denied the call. */
  outcome: TypesafeCallOutcome | null
  deniedReason?: 'master_off' | 'feature_off' | 'no_key'
  decision?: string
  now?: () => Date
}

export function createTypesafeCallRecord(input: CreateTypesafeCallRecordInput): TypesafeCallRecord {
  const at = (input.now ?? (() => new Date()))().toISOString()
  const { outcome } = input
  if (!outcome) {
    return {
      feature: input.featureId,
      model: input.requestedModel,
      latencyMs: 0,
      usage: null,
      deadlineHit: false,
      status: 'unavailable',
      reason: input.deniedReason ?? 'master_off',
      questionCount: input.questionCount,
      ...(input.decision ? { decision: input.decision } : {}),
      at
    }
  }
  if (outcome.status === 'ok') {
    return {
      feature: input.featureId,
      model: outcome.response.model || input.requestedModel,
      latencyMs: outcome.latencyMs,
      usage: outcome.response.usage,
      deadlineHit: false,
      status: 'ok',
      questionCount: input.questionCount,
      requestChars: outcome.requestChars,
      ...(input.decision ? { decision: input.decision } : {}),
      at
    }
  }
  return {
    feature: input.featureId,
    model: input.requestedModel,
    latencyMs: outcome.latencyMs,
    usage: null,
    deadlineHit: outcome.deadlineHit,
    status: outcome.status,
    reason: outcome.reason,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    questionCount: input.questionCount,
    requestChars: outcome.requestChars,
    ...(input.decision ? { decision: input.decision } : {}),
    at
  }
}

/**
 * Appends records to an already-recorded snapshot. Returns false when the snapshot
 * does not exist (nothing to attach to); callers log, they do not throw.
 */
export async function appendTypesafeCallRecords(
  sessionId: string,
  snapshotId: string,
  records: TypesafeCallRecord[]
): Promise<boolean> {
  if (records.length === 0) return true
  const snapshots = await executionViewerService.getSnapshots(sessionId)
  const current: ExecutionSnapshot | undefined = snapshots.find((entry) => entry.id === snapshotId)
  if (!current) return false
  const existing = readTypesafeCallRecords(current.executionMetadata)
  await executionViewerService.updateSnapshot(sessionId, snapshotId, {
    executionMetadata: {
      ...(current.executionMetadata ?? {}),
      typesafeCalls: [...existing, ...records]
    }
  })
  return true
}

/** A note exists only for a miss; a successful call needs no chip. */
export function buildJevJuiceNote(record: TypesafeCallRecord): JevJuiceNote | null {
  if (record.status === 'ok') return null
  return {
    feature: record.feature,
    status: record.status,
    reason: record.reason ?? 'master_off',
    at: record.at
  }
}

/** Merges notes into message metadata without disturbing sibling fields. */
export function withJevJuiceNotes<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
  notes: JevJuiceNote[]
): T & { jevJuice?: { notes: JevJuiceNote[] } } {
  const base = (metadata ?? {}) as T & { jevJuice?: { notes: JevJuiceNote[] } }
  if (notes.length === 0) return base
  const existing = Array.isArray(base.jevJuice?.notes) ? base.jevJuice!.notes : []
  return { ...base, jevJuice: { notes: [...existing, ...notes] } }
}
