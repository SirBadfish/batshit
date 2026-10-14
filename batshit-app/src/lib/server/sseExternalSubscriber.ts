/**
 * The server's one Redis subscriber for `batshit:sse:*`: the chat and user channels that
 * processes outside a request publish on (`publishSessionEvent`, `publishUserEvent`, and the
 * Claude permission helper).
 *
 * It lived inside `/api/sse/+server.ts` and started only when a browser opened its live hub,
 * so an event published while no browser had connected since the app started reached nobody,
 * the server included. BL-496 moved it here, for one reason: a managed Claude run with
 * approvals On Request must be able to wait for it BEFORE it launches
 * (`ensureSseExternalSubscriber`), because the permission helper publishes its card on this
 * channel and nothing else would hear it. A route module cannot be imported by a service, and
 * SvelteKit loads `/api/sse` only when a request reaches it.
 *
 * Every session event passes `noteClaudeApprovalEvent` first, so the server records a Claude
 * approval card whether or not a tab watches the chat or `/api/sse` has loaded. Then the
 * route's sinks, registered when the route loads, forward events to the tabs.
 */

import { createClient } from 'redis'
import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'
import { resolveRedisConnectionUrl } from '$lib/server/redisConnection'
import { parseSseChannel } from '$lib/server/ssePublisher'
import { noteClaudeApprovalEvent } from '$lib/server/services/claudeApprovalEvents'
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

  try {
    noteClaudeApprovalEvent(parsed.sessionId, payload)
  } catch (error) {
    console.error('[SSE] Could not record a Claude approval event', error)
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

/**
 * BL-496: wait for the subscriber, at most `timeoutMs`. A Redis that cannot be reached keeps a
 * client connecting for as long as it retries; a run that must not start without the
 * subscriber gets a plain no instead of waiting with it. The start carries on in the background.
 */
export async function waitForSseExternalSubscriber(timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([ensureSseExternalSubscriber(), timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

// The subscriber closes at shutdown even when `/api/sse` never loaded (a run started it). It
// waits for running turns first, as the route's own task does, so a card raised during the
// shutdown wait is still heard; the route's task closing it too is harmless (the close is
// idempotent).
registerRuntimeShutdownTask('sse-external-subscriber', async () => {
  await waitForRunningTurns(TURN_SHUTDOWN_WAIT_MS)
  await closeSseExternalSubscriber()
})
