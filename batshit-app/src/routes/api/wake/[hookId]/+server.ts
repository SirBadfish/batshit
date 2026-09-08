import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { deliverWebhookDm, DmToolError } from '$lib/server/services/dm/dmTools'
import {
  recordWakeHookUse,
  validateWakeHookToken
} from '$lib/server/services/dm/wakeHookStore'
import {
  DM_BODY_MAX_CHARS,
  MAX_WAKE_WEBHOOK_CALLS_PER_HOUR
} from '$lib/utils/dmControl'

/**
 * SA-113 P3 (DL-113-09) — the ONE inbound door for waking an agent from outside Batshit.
 *
 * `POST /api/wake/{hookId}` with `Authorization: Bearer <token>`. n8n, a schedule, a Slack
 * or Discord bridge, a CI job — all of them come through here, which is Josh's call: do not
 * integrate with everything, let n8n be the door.
 *
 * ## Why this route authenticates itself
 *
 * The wake token is deliberately NOT added to `resolveNativeToolUser`'s precedence chain,
 * NOT a Portable Skill family, and its actor kind is its own. Two reasons:
 *
 *   - that resolver's order (service → n8n callback → portable → session) is a security
 *     boundary, and inserting a weaker credential ahead of a stronger one is how those
 *     boundaries break;
 *   - a Portable Skill Token forces `allowRisky: true`, so a wake token that lived in that
 *     family would silently gain risky-control approval it has no business holding.
 *
 * A hook can do exactly one thing: write a DM to the one agent it names, and ask for that
 * agent's turn to start. It cannot call a control, read a session, or reach any other agent.
 *
 * ## Exposure
 *
 * The route binds wherever the app binds. A managed Cloudflare tunnel publishes the WHOLE
 * origin, so while a tunnel runs this route is internet-reachable — which is why the token
 * is 32 random bytes compared in constant time, why every failure is the same 403, and why
 * there is a per-hook hourly limit. Exposing it beyond the machine is the user's existing
 * tunnel choice, documented as such.
 */

/** Everything a bad token can produce. One message for all of them, on purpose. */
const UNAUTHORIZED = { error: 'That wake-up webhook or token is not valid.' }

/**
 * F-SEC-2 — the biggest body this route will read.
 *
 * `request.json()` reads whatever arrives, and Docker sets `BODY_SIZE_LIMIT=1G` so ordinary
 * app requests and big Goon imports work. That is the wrong ceiling here: a holder of one
 * valid token could push a gigabyte into memory thirty times an hour and never send a DM.
 * A wake-up body is a message plus a few short fields, so 256 KB is generous — the message
 * itself is already capped at `DM_BODY_MAX_CHARS`.
 *
 * Precedent: `routes/api/cli-runtimes/+server.ts`.
 */
const MAX_WAKE_BODY_BYTES = 256 * 1024

/**
 * Read the body with the cap actually ENFORCED, not merely declared.
 *
 * A `Content-Length` check alone is not a limit: `headers.get` answers `null` when the
 * header is absent, `Number(null)` is `0`, and `0 > MAX_WAKE_BODY_BYTES` is false — so a
 * chunked request (which never carries `Content-Length`) walked straight past the guard
 * into an unbounded `request.json()` and the 1 GB `BODY_SIZE_LIMIT` behind it. That is the
 * exact attack the constant above exists to stop.
 *
 * The header check stays as the cheap early refusal for an honest caller; the streaming
 * counter below is what makes it true for a dishonest one. Both halves together are the
 * `cli-runtimes` precedent — only the first half had been copied.
 */
class WakeBodyTooLarge extends Error {}

async function readBoundedBody(request: Request): Promise<any> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WAKE_BODY_BYTES) {
    throw new WakeBodyTooLarge()
  }
  if (!request.body) return null

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > MAX_WAKE_BODY_BYTES) {
        await reader.cancel()
        throw new WakeBodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * F-SEC-4 — a hook id comes straight off the URL path, so it is attacker-controlled text.
 * Printing it raw lets a crafted path segment write newlines into the server log and forge
 * log lines. The id itself is 96 random bits of hex, so nothing legitimate is lost.
 */
function safeHookIdForLog(hookId: string): string {
  return hookId.slice(0, 80).replace(/[^\w.-]/g, '?')
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/**
 * 30 calls per hook per rolling hour, the `artifacts/share` pattern.
 *
 * Keyed on the HOOK, not the caller: one runaway n8n loop must not be able to spend another
 * hook's budget, and the wake primitive's own per-agent and per-instance hourly caps sit
 * behind this as the second line.
 */
async function enforceHookRateLimit(hookId: string): Promise<number | null> {
  const key = `ratelimit:wake-hook:${hookId}`
  const count = await redis.incr(key)
  // F-SEC-3 — `INCR` then `EXPIRE` is two round trips, and a crash between them leaves a
  // counter with no TTL. Once it passes the limit that hook answers 429 FOREVER, until
  // somebody deletes the key by hand. Re-checking the TTL costs one read and repairs it.
  if (count === 1) await redis.expire(key, 3600)
  else if ((await redis.ttl(key)) === -1) await redis.expire(key, 3600)
  if (count > MAX_WAKE_WEBHOOK_CALLS_PER_HOUR) {
    const ttl = await redis.ttl(key)
    return ttl > 0 ? ttl : 3600
  }
  return null
}

export const POST: RequestHandler = async ({ request, params }) => {
  const hookId = typeof params.hookId === 'string' ? params.hookId.trim() : ''
  if (!hookId) return json(UNAUTHORIZED, { status: 403 })

  const validation = await validateWakeHookToken(hookId, readBearerToken(request))
  if (!validation.valid) {
    // The reason is logged, never returned: a caller must not be able to tell "no such
    // hook" from "wrong token", which is what makes a hook id safe to put in a URL.
    console.warn(
      `[Wake-up webhooks] Refused a call to ${safeHookIdForLog(hookId)}: ${validation.reason}`
    )
    return json(UNAUTHORIZED, { status: 403 })
  }
  const hook = validation.record

  // Deliberately AFTER authentication. Counting failed tokens against the hook's budget
  // would let anyone who merely knows a hook id — it travels in an n8n workflow, not in a
  // vault — silently disable the owner's automation by spending its hour on bad guesses.
  // Unauthenticated hammering is caught by the app-wide API limiter in `hooks.server.ts`.
  const retryAfter = await enforceHookRateLimit(hook.id)
  if (retryAfter !== null) {
    return json(
      {
        error: `This webhook has used its ${MAX_WAKE_WEBHOOK_CALLS_PER_HOUR} calls for the hour.`,
        retry_after_seconds: retryAfter
      },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    )
  }

  // F-SEC-2 — after authentication, so an anonymous caller cannot learn anything from the
  // difference between 403 and 413, and the app-wide limiter has already seen them.
  let body: any
  try {
    body = await readBoundedBody(request)
  } catch (error) {
    if (error instanceof WakeBodyTooLarge) {
      return json(
        { error: 'That wake-up body is too large.', limit_bytes: MAX_WAKE_BODY_BYTES },
        { status: 413 }
      )
    }
    return json({ error: 'A JSON object body is required.' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'A JSON object body is required.' }, { status: 400 })
  }

  const message = typeof body.message === 'string' ? body.message : ''
  if (!message.trim()) {
    return json({ error: '"message" is required.' }, { status: 400 })
  }
  if (message.length > DM_BODY_MAX_CHARS) {
    return json(
      { error: `"message" is ${message.length} characters and the limit is ${DM_BODY_MAX_CHARS}.` },
      { status: 400 }
    )
  }
  if (body.kind !== undefined && body.kind !== 'info' && body.kind !== 'assignment') {
    return json(
      { error: '"kind" must be "info" or "assignment". A webhook cannot send a result.' },
      { status: 400 }
    )
  }
  if (body.deliver !== undefined && body.deliver !== 'wait' && body.deliver !== 'wake') {
    return json({ error: '"deliver" must be "wait" or "wake".' }, { status: 400 })
  }

  try {
    const result = await deliverWebhookDm({
      hook,
      input: {
        message,
        subject: typeof body.subject === 'string' ? body.subject : undefined,
        kind: body.kind,
        deliver: body.deliver,
        priority: body.priority,
        callback_url: typeof body.callback_url === 'string' ? body.callback_url : undefined,
        expires_in_hours:
          typeof body.expires_in_hours === 'number' ? body.expires_in_hours : undefined,
        requested_outcome:
          typeof body.requested_outcome === 'string' ? body.requested_outcome : undefined,
        scope: typeof body.scope === 'string' ? body.scope : undefined
      }
    })

    // Usage is recorded only for a call that produced a DM, so the Admin card's count means
    // "times this hook did something", not "times somebody poked it".
    await recordWakeHookUse(hook.id)

    return json(result, { status: 202 })
  } catch (error) {
    if (error instanceof DmToolError) {
      return json(
        { error: error.message, ...(error.hint ? { fix: error.hint } : {}) },
        { status: 400 }
      )
    }
    console.error('[Wake-up webhooks] A call failed:', error)
    return json({ error: 'The wake-up webhook could not be delivered.' }, { status: 500 })
  }
}
