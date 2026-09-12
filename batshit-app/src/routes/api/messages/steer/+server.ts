import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { getActiveSessionTurn, getActiveStream } from '$lib/server/services/streamAbortRegistry'
import {
  enqueueSteer,
  flushPendingSteersToTransport,
  getSteerRun
} from '$lib/server/services/steerInboxRegistry'
import { internalServiceHeaders } from '$lib/server/services/internalRequestAuth'
import { waitForStreamRegistration } from '$lib/server/services/steerSetupWait'
import { isValidSteerId, resolveSteerability, STEER_TEXT_MAX_CHARS } from '$lib/utils/steerControl'

/**
 * SA-114 P1 (DL-114-03) — `POST /api/messages/steer`.
 *
 * The user typed while the agent was still replying. This route takes the text, and from
 * that moment the SERVER owns it: if the running turn can hand it to the model at its next
 * tool boundary it does (DL-114-05), and if it cannot, the turn's end promotes it into the
 * next message (DL-114-07). Either way a closed tab cannot lose what was typed — which is
 * the whole reason the text is accepted here rather than queued in the browser.
 *
 * Cookie-only. There is no service-token lane and there must not be one: a steer is the
 * USER's own words landing inside a reply, and the only other source SA-114 allows is an
 * urgent DM, which goes through `sendDmOp` server-side (DL-114-13, P4) rather than through
 * an HTTP door a token holder could push text through.
 */

type SteerRefusal = { status: number; body: Record<string, unknown> }

const notSteerable = (reason: string): SteerRefusal => ({
  status: 409,
  body: { error: reason, code: 'not_steerable', reason }
})

/**
 * F-P3-5: the client has to tell "cannot be steered" from "too late to steer" — only the
 * second may skip the interrupt — and a sentence is not a contract. The tag is, and the
 * sentence stays for people.
 */
const REPLY_FINISHED_REASON = 'That reply already finished. Send your message normally.'
const replyFinished = (): SteerRefusal => ({
  status: 409,
  body: { ...notSteerable(REPLY_FINISHED_REASON).body, refusal: 'reply_finished' }
})

/**
 * F-P3-1: send-routed registers the session-turn lock at its top and the stream only after
 * compile, clips and the memory commit — a few seconds later. A steer typed in that window
 * used to be refused as "already finished"; the client then sent it as an ordinary message,
 * which the lock refused with 409 and, not being an interrupt, never retried — the user's
 * quickest follow-up failed outright. When the lock names THIS assistant message, the route
 * waits for its stream instead (`waitForStreamRegistration`, shared with the DM door since
 * the P4 review). The wait ends the moment the stream is registered, the moment the lock is
 * released or re-owned (the turn died in setup), or at the bound.
 */

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : ''
  const steerId = typeof body?.steerId === 'string' ? body.steerId.trim() : ''
  const rawText = typeof body?.text === 'string' ? body.text : ''
  const text = rawText.trim()

  if (!sessionId || !messageId) {
    return json(
      { error: 'sessionId and messageId are required.', code: 'invalid_input' },
      { status: 400 }
    )
  }

  // The id travels inside stored assistant content as `{{batshit-steer:<id>}}`, so a
  // client-supplied id that could close those braces is refused rather than sanitised:
  // silently rewriting it would make the client's optimistic bubble point at nothing.
  if (!isValidSteerId(steerId)) {
    return json(
      {
        error: 'steerId must be 1-64 characters of letters, digits, underscore or hyphen.',
        code: 'invalid_input'
      },
      { status: 400 }
    )
  }

  if (!text) {
    return json({ error: 'A steer needs some text.', code: 'invalid_input' }, { status: 400 })
  }

  if (text.length > STEER_TEXT_MAX_CHARS) {
    return json(
      {
        error: `That message is too long to steer with (limit ${STEER_TEXT_MAX_CHARS.toLocaleString()} characters).`,
        code: 'invalid_input'
      },
      { status: 400 }
    )
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== userId) {
    return json({ error: 'Session not found or unauthorized' }, { status: 404 })
  }

  const sessionMetadata = (session.metadata ?? {}) as Record<string, any>
  const isGroupSession = typeof sessionMetadata.group_chat?.group_id === 'string'

  // DL-114-12: the group loop is untouched by this story, and its abort granularity is
  // between speakers, so a group session refuses here before anything else is read.
  const groupVerdict = resolveSteerability({ primaryAgentType: null, isGroupSession: true })
  if (isGroupSession && !groupVerdict.steerable) {
    return json(notSteerable(groupVerdict.reason).body, { status: 409 })
  }

  // F-P3-1: a reply that is still being set up has a lock but no stream yet. Waiting here
  // is fine — it sits ABOVE the live-turn check, not between the check and the enqueue.
  if (!getActiveStream(sessionId)) {
    const lockedTurn = getActiveSessionTurn(sessionId)
    if (lockedTurn && lockedTurn.kind === 'single' && lockedTurn.messageId === messageId) {
      await waitForStreamRegistration(sessionId, messageId)
    }
  }

  // Every Redis read the route needs is now ABOVE this line (F-P1-2). From the live-turn
  // check down to the enqueue the route is synchronous, so a turn cannot end in between:
  // with an `await` inside that window, a reply that finished during the read had already
  // promoted and cleared its inbox, and the entry then landed for a dead assistant id —
  // never delivered, never promoted — while the route still answered 202.
  //
  // ---- synchronous from here to `enqueueSteer` ----

  // The turn has to be live AND be the one the client is looking at. `getActiveStream`
  // holds the assistant message id the run registered, so a stale tab steering a reply
  // that already finished is refused rather than silently promoted into the next turn.
  const activeStream = getActiveStream(sessionId)
  const activeTurn = getActiveSessionTurn(sessionId)
  if (!activeStream || !activeTurn) {
    return json(replyFinished().body, { status: 409 })
  }
  if (activeTurn.kind === 'group' && !groupVerdict.steerable) {
    return json(notSteerable(groupVerdict.reason).body, { status: 409 })
  }
  if (activeStream.messageId !== messageId) {
    return json(replyFinished().body, { status: 409 })
  }

  // P2 (DL-114-09): the verdict comes from the RUN, not from a second reading of the agent
  // record. Whether a Codex turn can be steered depends on the transport lane it actually
  // got — `app-server` can, `exec` closed its stdin after the prompt — and that is a
  // decision send-routed made when it started this run, not a field anyone can look up.
  // Re-deriving it here is how the route would come to promise a steer the turn cannot
  // carry. `resolveSteerability` is still THE rule; this reads the answer it already gave.
  //
  // Fails closed when the registration is missing or belongs to another turn: the run
  // registry and this one are written in the same breath, so a live stream with no verdict
  // means something is wrong, not that anything goes.
  const steerRun = getSteerRun(sessionId)
  if (!steerRun || steerRun.messageId !== messageId || !steerRun.steerable || !steerRun.lane) {
    return json(
      notSteerable(
        steerRun?.reason ??
          'This agent cannot be steered mid-reply. Your message interrupts instead.'
      ).body,
      { status: 409 }
    )
  }

  const at = new Date().toISOString()
  const enqueued = enqueueSteer(sessionId, {
    steerId,
    messageId,
    text,
    at,
    source: 'user'
  })

  if (!enqueued.ok) {
    return json(
      { error: enqueued.reason, code: enqueued.code, reason: enqueued.reason },
      { status: 409 }
    )
  }

  // P2: a managed CLI turn has no `prepareStep` to pull at its next step, so the text is
  // pushed onto its wire now and the CLI holds it until its own next tool boundary — the
  // behaviour both vendors document. Not awaited: the API lane registers no transport and
  // returns immediately, but a Codex `turn/steer` is a JSON-RPC round trip with a 120-second
  // ceiling, and the user's send button must not hang on a wedged app server. The server
  // already owns the text either way — a refused write returns it to the inbox, where the
  // end of the turn promotes it (DL-114-07).
  void flushPendingSteersToTransport(sessionId, messageId).then((result) => {
    if (result.reason === 'refused') {
      console.warn('[SA-114] A managed CLI refused a steer; it will be promoted instead', {
        sessionId,
        steerId,
        error: result.error ?? null
      })
    }
  })

  await publishSteerQueued({ request, sessionId, messageId, steerId, text, at })

  return json({ steerId, pending: enqueued.pending, lane: steerRun.lane }, { status: 202 })
}

/**
 * Tell every tab on this chat that the server has the message.
 *
 * It goes through `/api/sse`'s POST rather than `publishSessionEvent` on purpose: only the
 * POST path appends to the session's replay buffer, so a tab opened mid-turn still sees
 * `steer_queued` instead of joining a reply with an unexplained inset in it.
 *
 * Addressed by `request.url`, the same way `send-routed` addresses every one of its own
 * stream-event forwards. `resolveCliHelperBatshitBaseUrl()` is the rule for a turn Batshit
 * STARTS (F-P3-1), and it is the wrong tool here: with no explicit base-url env set it
 * falls back to `localhost:5620`, which on the smoke or first-run lanes would publish this
 * chat's event into a different instance. This route only ever runs inside a request the
 * user's own browser made.
 */
async function publishSteerQueued(payload: {
  request: Request
  sessionId: string
  messageId: string
  steerId: string
  text: string
  at: string
}) {
  try {
    await fetch(new URL('/api/sse', payload.request.url).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-sse-forward': '1',
        ...internalServiceHeaders()
      },
      body: JSON.stringify({
        type: 'steer_queued',
        sessionId: payload.sessionId,
        messageId: payload.messageId,
        steerId: payload.steerId,
        text: payload.text,
        at: payload.at
      })
    })
  } catch (error) {
    // A live-update channel must never be able to fail the steer it is reporting: the
    // server already owns the text, and the turn will deliver or promote it regardless.
    console.warn('[SA-114] Could not forward steer_queued to SSE:', {
      sessionId: payload.sessionId,
      steerId: payload.steerId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
