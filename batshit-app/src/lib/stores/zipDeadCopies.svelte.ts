/**
 * SA-129 P2 (BL-333): the dead copies of each open chat, for the zip badges and the Zip Manager.
 *
 * A file read that a later whole read superseded, or that the agent edited since, is compressed
 * in the prompt whatever its buffer says (SA-129 DL-01). The browser cannot tell that from one
 * message, so it asks the server, which runs the compile's own ledger over the whole chat
 * (`/api/zips/dead-copies`). The chat page re-reads it when a chat opens and when a reply ends.
 */

import { normalizeId } from '$lib/utils/idNormalizer'
import type { DeadCopyReason } from '$lib/utils/zipDeadCopies'
import { readSessionLiveReadFacts, type LiveReadCopyFact, type SessionLiveReadFacts } from '$lib/utils/liveFileReadFacts'

let reasonsBySession = $state<Record<string, Record<string, DeadCopyReason>>>({})
// SA-137 P4 (D10): what live file reads did for each open chat's newest turn (same route, same read).
let liveReadsBySession = $state<Record<string, SessionLiveReadFacts | null>>({})
const pending = new Map<string, Promise<void>>()
const again = new Set<string>()

/** Why the chat compresses this read as a dead copy, or null when it is not one. */
export function getDeadCopyReason(sessionId: string | null | undefined, zipId: string | null | undefined): DeadCopyReason | null {
  if (!sessionId || !zipId) return null
  const reasons = reasonsBySession[sessionId]
  if (!reasons) return null
  return reasons[normalizeId(zipId)] ?? reasons[zipId] ?? null
}

/**
 * A copy's live-read fact for the chat's newest reply: from a `current` receipt (refreshed, static or
 * unknown for a copy the receipt could not hold), or `unknown` when no usable record names that reply.
 * Null for a `changed` receipt (the badge shows the stored copy's own state) and for any other copy.
 * `strict` (only ever true, and only from a `current` receipt) says that reply's compile showed a Read
 * File copy only when it refreshed it, so a `static` copy here was not shown to the agent.
 */
export function getLiveReadCopyFact(
  sessionId: string | null | undefined,
  zipId: string | null | undefined
): (LiveReadCopyFact & { replyId: string; delivery: 'prepared' | 'issued' | null; strict?: true }) | null {
  if (!sessionId || !zipId) return null
  const facts = liveReadsBySession[sessionId]
  if (!facts || facts.state === 'changed') return null
  const copy = facts.copies[normalizeId(zipId)] ?? facts.copies[zipId]
  if (!copy) return null
  return {
    ...copy,
    replyId: facts.replyId,
    delivery: facts.state === 'current' ? facts.delivery : null,
    ...(facts.state === 'current' && facts.strict === true ? { strict: true as const } : {})
  }
}

/** The chat's newest-reply live-read facts, or null. */
export function getSessionLiveReadFacts(sessionId: string | null | undefined): SessionLiveReadFacts | null {
  return sessionId ? liveReadsBySession[sessionId] ?? null : null
}

/**
 * Re-reads one chat's dead copies and live-read facts. A failure keeps what was known and says so in
 * the console. A call that arrives while one is running asks again once that one ends (its answer
 * may predate the reply or save that prompted this call), and resolves after that second answer.
 */
export function refreshDeadCopies(sessionId: string | null | undefined, fetcher?: typeof fetch): Promise<void> {
  if (!sessionId) return Promise.resolve()
  const running = pending.get(sessionId)
  if (running) {
    again.add(sessionId)
    return running
  }
  const fetchImpl = fetcher ?? (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) return Promise.resolve()
  const request = (async () => {
    try {
      const response = await fetchImpl(`/api/zips/dead-copies?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { 'x-internal-api-request': '1' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const reasons: Record<string, DeadCopyReason> = {}
      for (const [zipId, reason] of Object.entries(payload?.deadCopies ?? {})) {
        if (reason === 'superseded' || reason === 'stale') reasons[zipId] = reason
      }
      reasonsBySession = { ...reasonsBySession, [sessionId]: reasons }
      liveReadsBySession = { ...liveReadsBySession, [sessionId]: readSessionLiveReadFacts(payload?.liveReads) }
    } catch (error) {
      console.warn('[ZipDeadCopies] Could not read this chat\'s dead copies; the badges may show one as open:', error)
    } finally {
      pending.delete(sessionId)
      if (again.delete(sessionId)) await refreshDeadCopies(sessionId, fetcher)
    }
  })()
  pending.set(sessionId, request)
  return request
}

/**
 * SA-137 P4 (D11): a saved Refreshed File Reads choice changes what the server reports for every chat
 * (a receipt stops or starts being current), so every chat this page holds asks again.
 */
export function refreshAllDeadCopies(fetcher?: typeof fetch): Promise<void> {
  return Promise.all(Object.keys(reasonsBySession).map((sessionId) => refreshDeadCopies(sessionId, fetcher))).then(() => undefined)
}
