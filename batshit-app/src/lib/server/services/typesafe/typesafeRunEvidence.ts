/**
 * SA-120 Jev Juice — evidence for a Jev call made MID-RUN, from inside a tool call.
 *
 * A tool lane (`sys.judge.ask`, the memory search rerank) runs after `send-routed` has
 * recorded the turn's Execution Viewer snapshot, in a request that cannot reach the
 * turn's in-memory collector. Its row is appended to the snapshot of the running
 * assistant message, which `getActiveStream` names. No active stream (a service-lane
 * caller, a test) means there is no snapshot to attach to: that is logged, never hidden,
 * and it never fails the tool call.
 *
 * Kept apart from `typesafeEvidence.ts` on purpose: suites mock
 * `appendTypesafeCallRecords` by module path, and a call between two functions of the
 * same module would slip past that mock.
 */

import type { TypesafeCallRecord } from '$lib/types/typesafe'
import { getActiveStream } from '../streamAbortRegistry'
import { appendTypesafeCallRecords } from './typesafeEvidence'

export async function attachTypesafeRecordToActiveStream(
  sessionId: string | null | undefined,
  record: TypesafeCallRecord,
  /** Names the lane in log lines, e.g. `sys.judge.ask`. */
  lane: string
): Promise<void> {
  if (!sessionId) return
  const messageId = getActiveStream(sessionId)?.messageId ?? null
  if (!messageId) {
    console.warn(`[Jev Juice] ${lane} ran with no active stream; the call has no Execution Viewer row`, { sessionId })
    return
  }
  try {
    const attached = await appendTypesafeCallRecords(sessionId, messageId, [record])
    if (!attached) console.warn(`[Jev Juice] ${lane}: no snapshot to attach the call record to`, { sessionId, messageId })
  } catch (error) {
    console.error(`[Jev Juice] ${lane}: failed to attach the Execution Viewer record:`, error)
  }
}
