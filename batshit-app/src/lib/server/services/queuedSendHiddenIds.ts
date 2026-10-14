/**
 * BL-4 — saved messages whose send is waiting in a chat's line, hidden from every message read.
 *
 * The page saves the user's message BEFORE it posts to send-routed. When that send meets another
 * turn in the chat (a reply another tab started, a woken turn, a queued send ahead of it), it now
 * waits in the chat's line (`streamAbortRegistry.ts`) instead of being refused. While it waits,
 * its message is not part of the conversation yet: no compile, no woken-turn check, no chain-depth
 * check, and no chat load may see it, or the running turn could read words that were sent after
 * it (a context-exhaustion continuation re-reads the chat from Redis), and a human message would
 * make a woken chat read as typed by a person. The message stays in its list and its record the
 * whole time; the list readers in `redis.ts` skip the ids here. When its turn comes it is moved to
 * the end of the chat and revealed; a send that never runs (Stop, shutdown, the line's cap) is
 * moved to the end and revealed too, unanswered, never deleted.
 *
 * A LEAF on purpose, with no imports of its own: `redis.ts` reads it on every list read, the
 * approval gates import `redis.ts`, and `jevNeverApproves.pinning.test.ts` walks every import from
 * those gates. `streamAbortRegistry.ts` is the only writer; `redis.ts` (and the default-lane fake
 * in `vitest-setup.ts`) only read.
 *
 * In-process, like the line it mirrors: a restart forgets it, and the message then simply shows
 * where it was saved, unanswered.
 */

const hiddenBySession = new Map<string, Set<string>>()

/** Hide a waiting send's saved message from every message-list read of its chat. */
export function hideQueuedSendMessage(sessionId: string, messageId: string): void {
  const hidden = hiddenBySession.get(sessionId) ?? new Set<string>()
  hidden.add(messageId)
  hiddenBySession.set(sessionId, hidden)
}

/** Show it again: its send ran, or it was kept at the end of the chat unanswered. */
export function revealQueuedSendMessage(sessionId: string, messageId: string): void {
  const hidden = hiddenBySession.get(sessionId)
  if (!hidden) return
  hidden.delete(messageId)
  if (hidden.size === 0) hiddenBySession.delete(sessionId)
}

export function isQueuedSendMessageHidden(sessionId: string, messageId: string): boolean {
  return hiddenBySession.get(sessionId)?.has(messageId) === true
}

/**
 * The ids of one POSITIONAL page, minus the hidden ones.
 *
 * A page is never widened to make up for a hidden id: the caller asked for list positions (the
 * first N, the last N, a range), and pulling in a neighbour would make the next page repeat it.
 * A page that holds a hidden id is simply shorter, and every visible message is on exactly one
 * page. The same array comes back when the chat hides nothing.
 */
export function filterQueuedSendMessageIds<T extends string>(sessionId: string, ids: T[]): T[] {
  const hidden = hiddenBySession.get(sessionId)
  if (!hidden || hidden.size === 0) return ids
  return ids.filter((id) => !hidden.has(id))
}

/** Test-only reset, like `__resetWakeRunRegistryForTests`. */
export function __resetQueuedSendHiddenIdsForTests(): void {
  hiddenBySession.clear()
}
