/**
 * BL-776: the message ids a user deleted in this process, for a short while.
 *
 * A delete removes a message and its place in the chat's list, and `redis.saveMessage` puts a
 * missing id back on the list. A server writer that saves the same id again after the delete
 * (the LiveKit turn route, which saves a realtime voice transcript every time the sidecar sends
 * a longer one under the same id) would bring the message back. Such a writer asks here first.
 *
 * In process, like `wakeRunRegistry.ts` and the steer inbox: a delete and the late save both run
 * in the one SvelteKit process, so there is no Redis key, no delete-sweep entry, and no backup
 * decision. An id is remembered for `DELETED_MESSAGE_MEMORY_MS` (a voice turn's updates arrive
 * within seconds of each other), at most `DELETED_MESSAGE_MEMORY_CAP` ids, oldest first.
 */
export const DELETED_MESSAGE_MEMORY_MS = 10 * 60 * 1000
export const DELETED_MESSAGE_MEMORY_CAP = 5000

const deletedAt = new Map<string, number>()

function keyOf(sessionId: string, messageId: string) {
  return `${sessionId}\u0000${messageId}`
}

function forgetExpired(now: number) {
  for (const [key, at] of deletedAt) {
    if (now - at < DELETED_MESSAGE_MEMORY_MS) break
    deletedAt.delete(key)
  }
}

/** The user deleted this message now. */
export function noteMessageDeleted(sessionId: string, messageId: string, now = Date.now()) {
  if (!sessionId || !messageId) return
  forgetExpired(now)
  const key = keyOf(sessionId, messageId)
  deletedAt.delete(key)
  deletedAt.set(key, now)
  while (deletedAt.size > DELETED_MESSAGE_MEMORY_CAP) {
    const oldest = deletedAt.keys().next().value
    if (oldest === undefined) break
    deletedAt.delete(oldest)
  }
}

/** Whether the user deleted this message within the memory window. */
export function wasMessageDeleted(sessionId: string, messageId: string, now = Date.now()): boolean {
  forgetExpired(now)
  return deletedAt.has(keyOf(sessionId, messageId))
}

export function __resetDeletedMessagesForTests() {
  deletedAt.clear()
}
