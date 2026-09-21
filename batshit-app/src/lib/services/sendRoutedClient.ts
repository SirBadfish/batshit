/**
 * A browser send without holding a connection for the whole reply (2026-09-18).
 *
 * The page and the approval card awaited `POST /api/messages/send-routed` until the turn was
 * over, and a browser opens at most six HTTP/1.1 connections to one server for ALL its tabs
 * (the live hub already holds one). Each running reply therefore held a connection: five
 * replies at once froze every other request of every tab, and a Stop waited 18.8 s in the
 * browser before it could be sent (`_local/sconn-proof/fivetabs-before.json`).
 *
 * `postSendRouted` asks to be answered once the server owns the turn (RFC 7240
 * `Prefer: respond-async`). The server answers `202 {turnId}` as soon as it has taken the
 * chat's turn lock (`respondAsyncSend.ts`); the turn runs on exactly as before, and this waits
 * for the turn's FINAL answer over the browser's one live connection (`{scope: 'turn'}` on the
 * live hub). What it resolves with is a `Response` built from that answer, byte for byte, so
 * every caller reads what it always read: the status, the error body, a 409 to retry.
 *
 * - An answer that is not a respond-async 202 (every refusal before the lock) is returned as is.
 * - Stop aborts the wait at once with an `AbortError`, as it aborted the request.
 * - The live connection dropping is not a failure: the hub re-adds the turn, and the server
 *   hands an ended turn's answer to a late subscription at once.
 * - A turn the server does not know (`turn_not_found`: it restarted and the reply died with it)
 *   is a failed send; another refusal subscribes again a few times first.
 */

import {
  subscribeLive,
  type LiveSubscription,
  type LiveSubscriptionHandlers,
  type LiveTarget
} from '$lib/services/liveHub/liveHubClient'
import type { TurnOverEvent } from '$lib/services/liveHub/protocol'

export const SEND_ROUTED_URL = '/api/messages/send-routed'

/** Subscribing again after a refusal other than `turn_not_found`: 1 s, 2 s, 4 s … up to 16 s. */
const RESUBSCRIBE_BASE_MS = 1_000
const RESUBSCRIBE_MAX_MS = 16_000
const MAX_RESUBSCRIBES = 5

/** The message a lost turn fails with: the page's existing "Failed to send message" path. */
const FAILED_SEND_MESSAGE = 'Failed to send message'

/** Statuses a `Response` may not carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

export type SendRoutedClientDeps = {
  fetch: typeof fetch
  subscribe: (target: LiveTarget, handlers: LiveSubscriptionHandlers) => LiveSubscription
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

function browserDeps(): SendRoutedClientDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    subscribe: subscribeLive,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function parseTurnOver(text: string, turnId: string): TurnOverEvent | null {
  let event: unknown
  try {
    event = JSON.parse(text)
  } catch {
    return null
  }
  const candidate = event as Partial<TurnOverEvent> | null
  if (candidate?.type !== 'turn_over' || candidate.turnId !== turnId) return null
  if (typeof candidate.status !== 'number' || typeof candidate.body !== 'string') return null
  return candidate as TurnOverEvent
}

function responseFromTurnOver(event: TurnOverEvent): Response {
  const headers = new Headers()
  if (event.contentType) headers.set('content-type', event.contentType)
  return new Response(NULL_BODY_STATUSES.has(event.status) ? null : event.body, {
    status: event.status,
    headers
  })
}

function waitForTurnOutcome(
  turnId: string,
  signal: AbortSignal | undefined,
  deps: SendRoutedClientDeps
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let subscription: LiveSubscription | null = null
    let retryTimer: unknown = null
    let refusals = 0
    let settled = false

    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (retryTimer !== null) deps.clearTimeout(retryTimer)
      subscription?.unsubscribe()
      subscription = null
      outcome()
    }
    const onAbort = () => finish(() => reject(abortError()))
    signal?.addEventListener('abort', onAbort, { once: true })

    const subscribe = () => {
      retryTimer = null
      if (settled) return
      const current = deps.subscribe(
        { scope: 'turn', turnId },
        {
          onEvent: (text) => {
            const event = parseTurnOver(text, turnId)
            if (!event) return
            let response: Response
            try {
              response = responseFromTurnOver(event)
            } catch (error) {
              console.error('[SendRouted] The turn’s answer could not be read:', error)
              finish(() => reject(new Error(FAILED_SEND_MESSAGE)))
              return
            }
            finish(() => resolve(response))
          },
          onStatus: (status, code) => {
            // `open` and `down` need nothing: the hub re-adds the turn after a drop, and the
            // server hands an ended turn's answer to a late subscription at once.
            if (status !== 'refused' || settled || subscription !== current) return
            current.unsubscribe()
            subscription = null
            if (code === 'turn_not_found' || refusals >= MAX_RESUBSCRIBES) {
              console.warn('[SendRouted] Batshit lost this reply’s turn before it ended:', code)
              finish(() => reject(new Error(FAILED_SEND_MESSAGE)))
              return
            }
            const delay = Math.min(RESUBSCRIBE_BASE_MS * 2 ** refusals, RESUBSCRIBE_MAX_MS)
            refusals += 1
            retryTimer = deps.setTimeout(subscribe, delay)
          }
        }
      )
      subscription = current
    }
    subscribe()
  })
}

/**
 * POST a send-routed body (already JSON text) and resolve with the turn's final answer as a
 * `Response`, without holding a connection while the reply runs.
 *
 * `onAccepted` runs once, when the server answers that it owns the turn (the 202), before the
 * turn's final answer. An approval card needs that moment: the server records the click's
 * answer before the resumed run starts, so a later failure of the run does not un-answer it.
 */
export async function postSendRouted(
  bodyText: string,
  options: { signal?: AbortSignal; onAccepted?: () => void } = {},
  deps: SendRoutedClientDeps = browserDeps()
): Promise<Response> {
  const response = await deps.fetch(SEND_ROUTED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
    body: bodyText,
    signal: options.signal
  })
  const applied = response.headers.get('preference-applied') ?? ''
  if (response.status !== 202 || !/(^|,)\s*respond-async\s*(,|$)/i.test(applied)) return response

  const accepted = (await response.json().catch(() => null)) as { turnId?: unknown } | null
  if (typeof accepted?.turnId !== 'string' || !accepted.turnId) {
    console.error('[SendRouted] The server accepted the send without naming its turn.', accepted)
    throw new Error(FAILED_SEND_MESSAGE)
  }
  options.onAccepted?.()
  return waitForTurnOutcome(accepted.turnId, options.signal, deps)
}
