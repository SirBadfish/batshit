/**
 * BL-1798 (review S1): `redis.deleteSession` reads every message's zip claims and every
 * candidate zip's chat BEFORE its first write, and throws this when one of those reads fails, so
 * nothing of the chat was deleted and a retry is safe. `DELETE /api/sessions/[id]` answers it with
 * its own words. A leaf module, so `redis.ts` and the route can share it.
 */
export const SESSION_SWEEP_READ_FAILED_CODE = 'session_delete_read_failed'
export const SESSION_SWEEP_READ_FAILED_TEXT =
  "This chat's messages or zips could not be read, so nothing was deleted. Try again in a moment."

export class SessionSweepReadError extends Error {
  readonly code = SESSION_SWEEP_READ_FAILED_CODE
  constructor(cause: unknown) {
    super(SESSION_SWEEP_READ_FAILED_TEXT, { cause })
    this.name = 'SessionSweepReadError'
  }
}
