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

let reasonsBySession = $state<Record<string, Record<string, DeadCopyReason>>>({})
const pending = new Map<string, Promise<void>>()

/** Why the chat compresses this read as a dead copy, or null when it is not one. */
export function getDeadCopyReason(sessionId: string | null | undefined, zipId: string | null | undefined): DeadCopyReason | null {
  if (!sessionId || !zipId) return null
  const reasons = reasonsBySession[sessionId]
  if (!reasons) return null
  return reasons[normalizeId(zipId)] ?? reasons[zipId] ?? null
}

/** Re-reads one chat's dead copies. A failure keeps what was known and says so in the console. */
export function refreshDeadCopies(sessionId: string | null | undefined, fetcher?: typeof fetch): Promise<void> {
  if (!sessionId) return Promise.resolve()
  const running = pending.get(sessionId)
  if (running) return running
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
    } catch (error) {
      console.warn('[ZipDeadCopies] Could not read this chat\'s dead copies; the badges may show one as open:', error)
    } finally {
      pending.delete(sessionId)
    }
  })()
  pending.set(sessionId, request)
  return request
}
