/**
 * SA-114 — wait through a reply's setup window before deciding it cannot be steered.
 *
 * send-routed registers the session-turn lock at the top of the request and the stream only
 * after compile, clips and the memory commit — 1.5 to 3 seconds later, measured (gateway
 * discovery alone logged 1.3 s). In that window the turn is real and the reply IS being
 * written, but nothing has registered a stream for it yet, so a check that reads
 * `getActiveStream` alone answers "not mid-reply" about an agent that is.
 *
 * Both steer doors share this one wait: the user's route (`POST /api/messages/steer`,
 * F-P3-1) and an agent DM sent with `deliver: 'steer'` (`deliverBySteer`, F-P4-3). It ends
 * the moment the stream is registered, the moment the lock is released or re-owned (the
 * turn died in setup), or at the bound. The caller's own check-and-enqueue runs AFTER it,
 * synchronously, so a reply that finishes between the two cannot strand an entry.
 */

import {
  getActiveSessionTurn,
  getActiveStream
} from '$lib/server/services/streamAbortRegistry'

export const STEER_SETUP_WAIT_MS = 8_000
export const STEER_SETUP_POLL_MS = 100

export async function waitForStreamRegistration(
  sessionId: string,
  messageId: string
): Promise<void> {
  const deadline = Date.now() + STEER_SETUP_WAIT_MS
  while (Date.now() < deadline) {
    if (getActiveStream(sessionId)?.messageId === messageId) return
    const lockedTurn = getActiveSessionTurn(sessionId)
    if (!lockedTurn || lockedTurn.messageId !== messageId) return
    await new Promise((resolve) => setTimeout(resolve, STEER_SETUP_POLL_MS))
  }
}
