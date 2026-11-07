/**
 * The server's one Redis subscriber for `batshit:sse:*`: the chat and user channels that
 * processes outside a request publish on (`publishSessionEvent`, `publishUserEvent`).
 *
 * `/api/sse` starts it when a browser opens its live hub (`ensureSseExternalSubscriber`), and
 * the route's sinks, registered when the route loads, forward events to the tabs. BL-496 moved
 * it out of the route so a managed Claude run could wait for it before launch; SA-139 R4 removed
 * that run and the approval sink it fed, and this module stays the one subscriber.
 */

import { createClient } from 'redis'
import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { parseSseChannel } from '$lib/server/ssePublisher'
import { registerRuntimeShutdownTask } from '$lib/server/services/runtimeShutdown'
import { TURN_SHUTDOWN_WAIT_MS, waitForRunningTurns } from '$lib/server/services/turnOutcomeRegistry'

export const EXTERNAL_CHANNEL_PREFIX = 'batshit:sse:'

export interface SseExternalSinks {
  session: (sessionId: string, payload: any) => void
  user: (userId: string, payload: any) => void
}

let sinks: SseExternalSinks | null = null
let subscriber: ReturnType<typeof createClient> | null = null
let ready: Promise<boolean> | null = null

/** `/api/sse` hands over its forwarders when it loads. The last registration wins. */
export function registerSseExternalSinks(next: SseExternalSinks): void {
  sinks = next
}

function handleMessage(message: string, channel: string) {
  // SA-113 P1: the same pattern carries two channel shapes. `parseSseChannel` is THE rule that
  // tells them apart, so a user event can never be mistaken for a session whose id happens to
  // start with the user segment.
  const parsed = parseSseChannel(channel)
  if (!parsed) return

  let payload: any = { type: 'external_event', raw: message }
  try {
    payload = JSON.parse(message)
  } catch {
    // keep fallback payload
  }

  if (parsed.scope === 'user') {
    sinks?.user(parsed.userId, payload)
    return
  }

  sinks?.session(parsed.sessionId, payload)
}

/**
 * Start the subscriber once and wait until it listens. Answers false when it could not start;
 * the next call tries again.
 */
export function ensureSseExternalSubscriber(): Promise<boolean> {
  if (ready) return ready

  ready = (async () => {
    let client: ReturnType<typeof createClient> | null = null
    try {
      client = createClient({ url: resolveRedisConnectionUrl(env) })
      client.on('error', (err) => {
        console.error('[SSE] External subscriber error', err)
      })

      await client.connect()
      await client.pSubscribe(`${EXTERNAL_CHANNEL_PREFIX}*`, handleMessage)

      subscriber = client
      logger.debug('[SSE] External event subscriber ready')
      return true
    } catch (err) {
      console.error('[SSE] Failed to start external subscriber', err)
      if (client?.isOpen) {
        await client.disconnect().catch((disconnectError) => {
          console.error('[SSE] Failed to close partial external subscriber', disconnectError)
        })
      }
      ready = null
      return false
    }
  })()

  return ready
}

/** Shutdown: close the subscriber (after `/api/sse` has let its running turns finish). */
export async function closeSseExternalSubscriber(): Promise<void> {
  const pending = ready
  if (pending) await pending.catch(() => false)
  const client = subscriber
  subscriber = null
  ready = null
  if (client?.isOpen) {
    try {
      await client.disconnect()
    } catch (error) {
      console.error('[SSE] External subscriber disconnect failed; forcing socket destruction', error)
      client.destroy()
      if (client.isOpen) throw error
    }
  }
}

// The subscriber closes at shutdown whoever started it. It waits for running turns first, as the
// route's own task does, so an event published during the shutdown wait is still heard; the
// route's task closing it too is harmless (the close is idempotent).
registerRuntimeShutdownTask('sse-external-subscriber', async () => {
  await waitForRunningTurns(TURN_SHUTDOWN_WAIT_MS)
  await closeSseExternalSubscriber()
})
