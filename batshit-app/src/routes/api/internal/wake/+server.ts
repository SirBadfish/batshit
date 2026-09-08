import { json, type RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { requestAgentWakeup } from '$lib/server/services/agentWakeups'
import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import type { SessionOriginKind } from '$lib/utils/sessionOrigin'

/**
 * SA-113 P1 — an internal trigger for the wake primitive, so P1 can be proved end to end
 * before P2's `sys.dm.send` and P3's webhook exist.
 *
 * Two gates, both required:
 *  1. `BATSHIT_ENABLE_WAKE_TEST_TRIGGER=1`, so a normal install never exposes this route
 *     at all. A managed Cloudflare tunnel publishes the WHOLE origin, so a permanently
 *     live test lever would be internet-reachable while a tunnel runs.
 *  2. The service token, the same boundary `/api/voice/livekit/turn` uses for the one
 *     other route that can start a chat turn with no browser.
 *
 * There is deliberately no cookie lane: this is not a user-facing feature, and a wake-up
 * a browser could ask for directly would bypass the DM and webhook contracts that own it.
 */
export const POST: RequestHandler = async ({ request }) => {
  if (env.BATSHIT_ENABLE_WAKE_TEST_TRIGGER !== '1') {
    return json({ error: 'Not found' }, { status: 404 })
  }
  if (!isTrustedInternalRequest(request)) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'A JSON object body is required.' }, { status: 400 })
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const content = typeof body.content === 'string' ? body.content : ''
  if (!userId || !agentId || !content.trim()) {
    return json(
      { error: '"userId", "agentId", and "content" are required.' },
      { status: 400 }
    )
  }

  const originKind: SessionOriginKind = body?.origin?.kind === 'webhook' ? 'webhook' : 'dm'
  const fromLabel =
    typeof body?.origin?.fromLabel === 'string' && body.origin.fromLabel.trim()
      ? body.origin.fromLabel.trim()
      : 'Wake test'

  const target =
    body?.target?.kind === 'session' && typeof body.target.sessionId === 'string'
      ? ({ kind: 'session', sessionId: body.target.sessionId } as const)
      : body?.target?.kind === 'auto'
        ? ({ kind: 'auto', subject: body?.subject ?? null } as const)
        : ({ kind: 'new-session', subject: body?.subject ?? null } as const)

  const result = await requestAgentWakeup({
    userId,
    agentId,
    target,
    content,
    origin: {
      kind: originKind,
      fromLabel,
      agentId: body?.origin?.agentId ?? null,
      dmId: body?.origin?.dmId ?? null,
      hookId: body?.origin?.hookId ?? null
    },
    chainDepth:
      typeof body.chainDepth === 'number' && Number.isFinite(body.chainDepth)
        ? body.chainDepth
        : 0
  })

  return json(result, { status: result.ok ? 202 : 200 })
}
