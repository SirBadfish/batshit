import { json, type RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import { runScheduleSweep } from '$lib/server/services/schedules/scheduleTicker'

/**
 * SA-115 P1 (DL-115-13) — run one schedule sweep NOW.
 *
 * The ticker runs every 60 seconds and a daily schedule is due once a day, so proving a
 * fire, a late fire, and a missed-run collapse by waiting is not proving anything — it is
 * hoping. This route makes the sweep a thing a test can call, with an optional `now`
 * override so "30 minutes overdue" is one request instead of half an hour.
 *
 * Two gates, both required, copied from `POST /api/internal/wake`:
 *  1. `BATSHIT_ENABLE_WAKE_TEST_TRIGGER=1`, so a normal install never exposes this route
 *     at all. A managed Cloudflare tunnel publishes the WHOLE origin, and a permanently
 *     live lever that can start agent turns would be internet-reachable while one runs.
 *  2. The service token, the same boundary every other route that can start a chat turn
 *     with no browser uses.
 *
 * There is deliberately no cookie lane. P2's `POST /api/schedules/{id}/run-now` is the
 * user-facing way to fire one schedule, and it goes through the ownership checks this
 * route does not have.
 */
export const POST: RequestHandler = async ({ request }) => {
  if (env.BATSHIT_ENABLE_WAKE_TEST_TRIGGER !== '1') {
    return json({ error: 'Not found' }, { status: 404 })
  }
  if (!isTrustedInternalRequest(request)) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const rawNow =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).now
      : undefined

  let now = new Date()
  if (rawNow !== undefined && rawNow !== null) {
    const parsed =
      typeof rawNow === 'number' ? rawNow : typeof rawNow === 'string' ? Date.parse(rawNow) : NaN
    if (!Number.isFinite(parsed)) {
      return json(
        { error: '"now" must be an ISO date string or a millisecond timestamp.' },
        { status: 400 }
      )
    }
    now = new Date(parsed)
  }

  // SA-118 DL-118-01: always walk. This route exists to answer "is anything due now?"
  // about a keyspace the caller has usually just written to — a smoke-test row seeds a
  // schedule and triggers a sweep in the same breath — and the store's due cache is
  // in-process, so it cannot know about that write.
  const report = await runScheduleSweep(now, { walk: true })
  return json(report, { status: 200 })
}
