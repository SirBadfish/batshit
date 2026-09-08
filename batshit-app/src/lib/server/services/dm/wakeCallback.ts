/**
 * SA-113 P3 (DL-113-09) — the wake-up webhook's one-shot result callback.
 *
 * A caller that sends an `assignment` through a hook can name a `callback_url`. When the
 * agent closes that item, Batshit POSTs the outcome there ONCE — ten seconds, no retry,
 * and the attempt's outcome is written onto the DM as `callbackStatus` so a user looking at
 * the drawer can see what happened rather than wondering.
 *
 * No retry is deliberate. A retrying callback needs a queue, a backoff, and a dead-letter
 * story, and the honest alternative in a single-user app is to say plainly that it fired
 * once and what came back. n8n's own Wait node covers the case where the caller wants to
 * block until the answer arrives.
 */

import { WAKE_CALLBACK_TIMEOUT_MS } from '$lib/utils/dmControl'
import type { DmRecord } from '$lib/types/dm'

/**
 * Only http and https. A `file:` or `data:` callback would turn a webhook token into a
 * local-file read, and no other scheme has a meaning here.
 *
 * Loopback and private addresses are deliberately ALLOWED: n8n on `127.0.0.1:5678` or
 * `host.docker.internal` is the main thing this exists for, so an SSRF block list would
 * break the feature it was written for. The token holder is the instance owner's own
 * automation, and the callback body carries no secret.
 */
export function isAllowedCallbackUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export interface WakeCallbackPayload {
  dm_id: string
  status: DmRecord['status']
  result: string
  agent: { id: string; name: string }
  completed_at: string
}

/**
 * Fire one callback and return a short status string for `callbackStatus`.
 *
 * Never throws: the agent's work is done and its result is stored, so a callback that
 * cannot be delivered must not turn a successful close into a failed tool call.
 */
export async function deliverWakeCallback(
  url: string,
  payload: WakeCallbackPayload
): Promise<string> {
  if (!isAllowedCallbackUrl(url)) return 'skipped: callback_url is not an http(s) URL'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WAKE_CALLBACK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      // A callback that bounces through a redirect is more likely a misconfiguration than
      // an intention, and following one would send the payload somewhere the user did not
      // name.
      redirect: 'manual'
    })
    return response.ok ? `delivered: ${response.status}` : `failed: ${response.status}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return controller.signal.aborted
      ? `failed: no answer within ${Math.round(WAKE_CALLBACK_TIMEOUT_MS / 1000)}s`
      : `failed: ${message}`
  } finally {
    clearTimeout(timer)
  }
}
