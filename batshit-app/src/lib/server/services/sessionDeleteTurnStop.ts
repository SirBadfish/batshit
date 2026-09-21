/**
 * Deleting a chat stops its running turn, and sweeps the chat only once that turn's request is
 * done (2026-09-18).
 *
 * Measured before, on the dev lane (`_local/deletemid-proof/before-*.json`): a chat deleted while
 * its Codex or API reply ran `sleep 20` was swept in 35-85 ms, and nothing stopped the reply. Its
 * request ran on for another 20 seconds and wrote the reply's message, the message list, the
 * tool result's zip and the session zip set, and (when the delete beat its first snapshot) the
 * Execution Viewer log, into a chat that no longer existed. Nothing sweeps those later, and the
 * reply spent tokens and ran commands for a chat nobody had.
 *
 * The rejected alternative was to make every late writer refuse a chat that no longer exists:
 * one check in each writer (the finalize, the Execution Viewer snapshot, every zip writer, the
 * approval, steer, and Jev Juice writers, and every writer yet to come), each racing the delete
 * unless it is atomic with its write, while the reply runs on. The session-turn registry already
 * knows which requests are running, so this one place owns the rule instead:
 *
 * 1. The chat is marked (`beginSessionDelete`) and takes no new turn.
 * 2. Every request of the chat that is still running is stopped the way a Stop stops it (its
 *    own stop signal, which also reaches a turn still setting up; its stream; its group run; a
 *    woken turn's own controller). A Stop ends the request's commands and everything they
 *    started, in a sandbox too (`commandEnd.ts`), and every such request is a `send-routed`
 *    request, whose run-end sweep removes the chat's sandboxes before it lets go. The delete
 *    used to remove them itself as well, from before a Stop ended commands; that second removal
 *    found nothing and logged "failed to delete container … not found" (2026-09-18).
 * 3. The delete waits until each of those requests has released its own registration
 *    (`hasRunningRequest`), not merely until the chat's LOCK is gone: the interrupt route's
 *    release of a finishing turn's lock and the five-second grace after an aborted stream or a
 *    Stop end a lock while its request may still be writing. Then it sweeps. There is no silent
 *    fallback: a request still running at the bound makes the delete refuse (409) and sweep
 *    nothing, and a retry waits for that same request again.
 * 4. The mark ends after the sweep. A send that read the chat before the delete and registers
 *    after it re-reads the chat under its lock (send-routed) and answers "not found".
 * 5. Every tab of the chat's owner is told (`session_deleted` on the user channel), so the chat
 *    leaves every sidebar and every screen showing it, not only the tab that deleted it.
 */

import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import {
  abortGroupChat,
  abortStream,
  beginSessionDelete,
  endSessionDelete,
  hasRunningRequest,
  stopRunningRequests
} from '$lib/server/services/streamAbortRegistry'
import { abortWakeRun } from '$lib/server/services/wakeRunRegistry'

export const SESSION_DELETE_TURN_STOP_MS = 30_000
export const SESSION_DELETE_TURN_POLL_MS = 100
/** The abort reason a stopped turn sees, beside a Stop's `user`. */
export const SESSION_DELETED_ABORT_REASON = 'session_deleted'
/**
 * What a request stopped for a delete answers, in place of a Stop's "Stream interrupted by
 * user": the tab that sent the reply shows it while the chat disappears from its sidebar.
 */
export const SESSION_DELETED_STOP_MESSAGE = 'Stopped because this chat was deleted.'

export function isStoppedForSessionDelete(abortReason: unknown): boolean {
  return abortReason === SESSION_DELETED_ABORT_REASON
}

export type SessionDeleteRefusalCode = 'session_delete_in_progress' | 'session_turn_still_stopping'

const REFUSAL_MESSAGES: Record<SessionDeleteRefusalCode, string> = {
  session_delete_in_progress: 'This chat is already being deleted.',
  session_turn_still_stopping:
    'This chat’s reply is still stopping, so nothing was deleted. Try again in a moment.'
}

/** The delete did not sweep: nothing was deleted, and the route answers 409 with the reason. */
export class SessionDeleteRefusedError extends Error {
  readonly code: SessionDeleteRefusalCode
  readonly status = 409

  constructor(code: SessionDeleteRefusalCode) {
    super(REFUSAL_MESSAGES[code])
    this.name = 'SessionDeleteRefusedError'
    this.code = code
  }
}

export type SessionDeleteTurnStop =
  | { kind: 'no_turn' }
  | { kind: 'stopped'; waitedMs: number }

/**
 * Stop whatever runs in the chat now: every running request through its own stop signal (which
 * reaches a turn still setting up), and the stream and group run under the lock.
 */
function stopWhatRuns(sessionId: string) {
  stopRunningRequests(sessionId, SESSION_DELETED_ABORT_REASON)
  abortStream(sessionId, SESSION_DELETED_ABORT_REASON)
  abortGroupChat(sessionId, SESSION_DELETED_ABORT_REASON)
}

/**
 * Delete a chat: stop its running requests, wait until each has released its own registration,
 * then `sweep`.
 *
 * Throws `SessionDeleteRefusedError` without sweeping when another delete of this chat is
 * running, or when a request of the chat is still running after `SESSION_DELETE_TURN_STOP_MS`.
 */
export async function deleteSessionAfterItsTurn(
  sessionId: string,
  sweep: () => Promise<void>
): Promise<SessionDeleteTurnStop> {
  if (!beginSessionDelete(sessionId)) {
    throw new SessionDeleteRefusedError('session_delete_in_progress')
  }

  try {
    if (!hasRunningRequest(sessionId)) {
      await sweep()
      return { kind: 'no_turn' }
    }

    const startedAt = Date.now()
    stopWhatRuns(sessionId)
    abortWakeRun(sessionId, 'stopped')

    while (hasRunningRequest(sessionId)) {
      if (Date.now() - startedAt >= SESSION_DELETE_TURN_STOP_MS) {
        throw new SessionDeleteRefusedError('session_turn_still_stopping')
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_DELETE_TURN_POLL_MS))
      stopWhatRuns(sessionId)
    }

    await sweep()
    return { kind: 'stopped', waitedMs: Date.now() - startedAt }
  } finally {
    endSessionDelete(sessionId)
  }
}

/**
 * THE way a server route deletes a chat: the session route, and Delete Folder + Sessions through
 * `redis.deleteFolder`'s `deleteSession` option. Never `redis.deleteSession` directly, which is
 * the sweep alone (pinned by `session-delete-callers-contract.test.ts`). The rule lives here and
 * not in that facade because the approval gates import the facade, and the gates must not be
 * able to reach this module's command stopper (`jevNeverApproves.pinning.test.ts`).
 *
 * A locked chat is refused before anything of it is stopped.
 */
export async function deleteSessionStoppingItsTurn(
  sessionId: string
): Promise<SessionDeleteTurnStop> {
  const session = await redis.getSession(sessionId)
  if (session?.locked) {
    throw new Error('Session is locked and cannot be deleted until unlocked')
  }
  const outcome = await deleteSessionAfterItsTurn(sessionId, () => redis.deleteSession(sessionId))
  // Tell every tab of the owner, once the chat is really gone (2026-09-18). Nothing else says a
  // chat was deleted: seen live, it stayed in every other tab's sidebar, and on screen in a tab
  // showing it, until that tab reloaded. `publishUserEvent` never throws.
  const ownerId = typeof session?.user_id === 'string' ? session.user_id : null
  if (ownerId) await publishUserEvent(ownerId, { type: 'session_deleted', sessionId })
  return outcome
}
