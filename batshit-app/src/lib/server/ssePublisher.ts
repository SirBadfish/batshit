import { redis } from './redis'

const CHANNEL_PREFIX = 'batshit:sse:'

/**
 * SA-113 P1 (DL-113-06) — the user channel rides the SAME `batshit:sse:*` pattern
 * subscription as session events, distinguished by this prefix. `/api/sse` splits on it
 * before treating the suffix as a session id.
 *
 * A session id can never begin with `user:` because `POST /api/sessions` rejects a colon
 * in a client-supplied id, so the split is unambiguous rather than merely unlikely.
 */
const USER_CHANNEL_SEGMENT = 'user:'

export async function publishSessionEvent(sessionId: string, event: Record<string, any>) {
  if (!sessionId) return

  const payload = JSON.stringify({
    sessionId,
    ...event
  })

  await redis.execute(async (client) => {
    await client.publish(`${CHANNEL_PREFIX}${sessionId}`, payload)
  })
}

/**
 * Tell every tab this user has open about something that happened outside their session:
 * a session Batshit created for a wake-up, a run the server started, or an inbox change.
 *
 * Recon 2.4: the sidebar has no push channel, no poll, and no focus refresh, so without
 * this a session created by a wake-up simply never appears until the next page load, and
 * the run spinner and the three-active-chats cap stay blind to server-started runs.
 *
 * Failures are logged, never thrown: a live-update channel must not be able to fail the
 * wake-up that is trying to report through it.
 */
export async function publishUserEvent(userId: string, event: Record<string, any>) {
  if (!userId) return

  const payload = JSON.stringify({
    userId,
    ...event
  })

  try {
    await redis.execute(async (client) => {
      await client.publish(getUserChannel(userId), payload)
    })
  } catch (error) {
    console.warn('[SSE] Failed to publish a user-channel event:', {
      userId,
      type: event?.type,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function getSessionChannel(sessionId: string) {
  return `${CHANNEL_PREFIX}${sessionId}`
}

export function getUserChannel(userId: string) {
  return `${CHANNEL_PREFIX}${USER_CHANNEL_SEGMENT}${userId}`
}

/**
 * THE router rule for a message arriving on the shared `batshit:sse:*` subscription.
 * Returns which channel the message came from, so `/api/sse` never mistakes a user
 * channel for a session whose id happens to look like one.
 */
export function parseSseChannel(
  channel: string
): { scope: 'user'; userId: string } | { scope: 'session'; sessionId: string } | null {
  if (!channel.startsWith(CHANNEL_PREFIX)) return null
  const suffix = channel.slice(CHANNEL_PREFIX.length)
  if (!suffix) return null
  if (suffix.startsWith(USER_CHANNEL_SEGMENT)) {
    const userId = suffix.slice(USER_CHANNEL_SEGMENT.length)
    return userId ? { scope: 'user', userId } : null
  }
  return { scope: 'session', sessionId: suffix }
}
