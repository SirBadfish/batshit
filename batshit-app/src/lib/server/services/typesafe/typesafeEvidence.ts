/**
 * SA-120 Judge Juice — evidence helpers (DL-120-02/07).
 *
 * Every call becomes one `TypesafeCallRecord`. Where it lands:
 * - a lane that runs BEFORE `send-routed` records its snapshot pushes records into
 *   the in-memory `executionMetadata.typesafeCalls` before `recordSnapshot`;
 * - a lane that runs AFTER the snapshot exists (post-turn checks, tool lanes mid-run) calls
 *   `appendTypesafeCallRecords`, a read-modify-write of `executionMetadata` on the
 *   stored snapshot (the other finish-time patches touch different top-level fields);
 *   appends to one snapshot run one after another (BL-529).
 *
 * A miss on a compile lane also produces a `JevJuiceNote` for the assistant message
 * (`metadata.jevJuice.notes`), which `JevJuiceNote.svelte` renders beside the memory chips.
 */

import type { JevJuiceNote, JudgeProviderRef, TypesafeCallRecord } from '$lib/types/typesafe'
import { readTypesafeCallRecords, type TypesafeFeatureId } from '$lib/utils/jevJuice'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import type { ExecutionSnapshot } from '$lib/types/executionViewer'
import type { TypesafeCallOutcome } from './typesafeClient'

export { readTypesafeCallRecords }

export interface CreateTypesafeCallRecordInput {
  featureId: TypesafeFeatureId
  /** The judge's model id; `null` when no judge was found (`no_provider`). */
  requestedModel: string | null
  /** SA-120 P10a: the judge this call went to (or would have gone to). */
  provider?: JudgeProviderRef
  /** Round 1, S5: on `no_provider`, the judge id that was chosen but not found. */
  chosenProviderId?: string
  questionCount: number
  /** `null` when the access rule denied the call. */
  outcome: TypesafeCallOutcome | null
  deniedReason?: 'master_off' | 'feature_off' | 'no_provider' | 'no_key'
  decision?: string
  now?: () => Date
}

export function createTypesafeCallRecord(input: CreateTypesafeCallRecordInput): TypesafeCallRecord {
  const at = (input.now ?? (() => new Date()))().toISOString()
  const { outcome } = input
  const provider = input.provider
    ? { provider: { ...input.provider } }
    : input.chosenProviderId
      ? { chosenProviderId: input.chosenProviderId }
      : {}
  if (!outcome) {
    return {
      feature: input.featureId,
      model: input.requestedModel,
      ...provider,
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
      ...provider,
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
    ...provider,
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
 * BL-529: the appends waiting on each snapshot, keyed `sessionId:snapshotId`. An append is a
 * read-modify-write of `executionMetadata`, so two Jev calls that finished together (two
 * `sys.judge.ask` calls in one step, an ask beside a memory rerank or a DM screen) each wrote the
 * old rows plus their own, and one row was lost. Appends to one snapshot now run one after
 * another, in the order they were asked for; this process is the only writer of these rows. An
 * entry leaves the map when its last append settles.
 */
const appendChains = new Map<string, Promise<boolean>>()

/** Test seam: how many snapshots have an append waiting or running. */
export function __typesafeAppendChainCountForTests(): number {
  return appendChains.size
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
  const key = `${sessionId}:${snapshotId}`
  // The append before this one has its own caller to tell when it fails; it never stops this one.
  const previous = appendChains.get(key)?.catch(() => false) ?? Promise.resolve(false)
  const append = previous.then(() => appendNow(sessionId, snapshotId, records))
  appendChains.set(key, append)
  try {
    return await append
  } finally {
    if (appendChains.get(key) === append) appendChains.delete(key)
  }
}

async function appendNow(sessionId: string, snapshotId: string, records: TypesafeCallRecord[]): Promise<boolean> {
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
    at: record.at,
    // SA-120 P10a: the chip's tooltip names the judge it could not use.
    ...(record.provider ? { provider: { ...record.provider } } : {})
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
