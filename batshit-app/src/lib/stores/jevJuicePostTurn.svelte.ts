/**
 * SA-120 P6 — what the Jev Juice after-reply check noticed, as the chat page sees it.
 *
 * Small on purpose: a map of records by message id, a refresh, and a forget. The SERVER owns
 * the records (`postTurnCheckState.ts` is their only writer) and they are deliberately NOT part
 * of a message's metadata: the check finishes after the session stream has emitted `end`, when
 * the browser already owns the next save of that message. So the chip under a reply reads from
 * here, and this store reads from `/api/jev-juice/post-turn`:
 *   - when a chat is opened (beside its messages), and
 *   - when the user channel says a check just stored something (`jev_juice_post_turn`).
 * No polling. A chat where nothing was ever flagged costs one small request that answers `{}`.
 */

import type { JevJuicePostTurnRecord } from '$lib/types/typesafe'
import { readJevJuicePostTurnRecord } from '$lib/utils/jevJuice'

let recordsBySession = $state<Record<string, Record<string, JevJuicePostTurnRecord>>>({})

function normalize(value?: string | null): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The record for one reply, or `null`. Reactive: a chip that reads it redraws when it lands. */
export function getJevJuicePostTurnRecord(
  sessionId: string | null | undefined,
  messageId: string | null | undefined
): JevJuicePostTurnRecord | null {
  const session = normalize(sessionId)
  const message = normalize(messageId)
  if (!session || !message) return null
  return recordsBySession[session]?.[message] ?? null
}

/** Replaces one chat's records with what the server answered. Unreadable entries are dropped, never guessed. */
export function applyJevJuicePostTurnRecords(sessionId: string, records: unknown): void {
  const session = normalize(sessionId)
  if (!session) return
  const next: Record<string, JevJuicePostTurnRecord> = {}
  if (records && typeof records === 'object' && !Array.isArray(records)) {
    for (const [messageId, value] of Object.entries(records as Record<string, unknown>)) {
      const record = readJevJuicePostTurnRecord(value)
      if (record && record.messageId === messageId) next[messageId] = record
    }
  }
  recordsBySession[session] = next
}

/**
 * Re-reads one chat's records from the server. A failure is logged and leaves what is on
 * screen alone: a missing chip must never be able to break a chat.
 */
export async function refreshJevJuicePostTurnRecords(
  sessionId: string | null | undefined,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const session = normalize(sessionId)
  if (!session) return
  try {
    const response = await fetcher(`/api/jev-juice/post-turn?sessionId=${encodeURIComponent(session)}`)
    if (!response.ok) {
      // A chat that was just deleted answers 404; nothing to draw, nothing to report.
      if (response.status !== 404) console.warn('[Jev Juice] Could not read after-reply notes:', response.status)
      return
    }
    const payload = await response.json().catch(() => null)
    applyJevJuicePostTurnRecords(session, payload?.records)
  } catch (error) {
    console.warn('[Jev Juice] Could not read after-reply notes:', error)
  }
}

/** A chat was deleted or left for good: drop its records from this tab. */
export function forgetJevJuicePostTurnRecords(sessionId: string | null | undefined): void {
  const session = normalize(sessionId)
  if (!session || !(session in recordsBySession)) return
  const { [session]: _gone, ...rest } = recordsBySession
  recordsBySession = rest
}
