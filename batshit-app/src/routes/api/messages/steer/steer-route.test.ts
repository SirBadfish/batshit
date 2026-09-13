import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetStreamAbortRegistryForTests,
  registerSessionTurn,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'
import {
  attachSteerTransport,
  listInFlightSteers,
  listPendingSteers,
  registerSteerRun,
  __resetSteerInboxRegistryForTests
} from '$lib/server/services/steerInboxRegistry'
import { MAX_PENDING_STEERS, STEER_TEXT_MAX_CHARS } from '$lib/utils/steerControl'
import { POST } from './+server'

/**
 * SA-114 P1 (DL-114-03) — `POST /api/messages/steer`.
 *
 * The route is the moment the SERVER takes ownership of what the user typed, so every
 * refusal here is a refusal the client has to fall back from honestly. Cookie-only by
 * design: a steer is the user's own words landing inside a reply, and there is deliberately
 * no service-token lane a token holder could push text through.
 */

useRedisTestServer()

const USER = 'user-steer'
const OTHER = 'user-other'
const SESSION = 'session-steer'
const MESSAGE = 'msg_assistant_1'
const AGENT = 'agent-api'

let sseBodies: any[] = []

async function seed(options: { agentType?: string; group?: boolean } = {}) {
  await redis.set(`agent:${AGENT}`, {
    id: AGENT,
    user_id: USER,
    name: 'Steerable',
    agentType: options.agentType ?? 'api'
  })
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    name: SESSION,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    metadata: options.group ? { group_chat: { group_id: 'group-1' } } : {}
  } as any)
}

/**
 * A live turn, exactly as send-routed registers one: the stream lock, and — separately —
 * the steerability verdict `resolveSteerability` produced for that run (P2, DL-114-09).
 * The route reads the verdict from the run rather than re-deriving it from the agent
 * record, because the transport lane a `cli` primary actually got is a decision the run
 * made, not a field anyone can look up.
 */
function activeTurn(
  messageId = MESSAGE,
  options: {
    kind?: 'single' | 'group'
    steerable?: boolean
    reason?: string | null
    lane?: 'api' | 'codex' | 'claude' | null
    registerRun?: boolean
  } = {}
) {
  registerSessionTurn(SESSION, options.kind ?? 'single', messageId)
  registerStreamAbort(SESSION, messageId, new AbortController())
  if (options.registerRun === false) return
  const steerable = options.steerable ?? true
  registerSteerRun(SESSION, {
    messageId,
    steerable,
    reason: steerable ? null : (options.reason ?? 'nope'),
    lane: steerable ? (options.lane ?? 'api') : null
  })
}

const call = (
  body: Record<string, unknown>,
  userId: string | null = USER
): Promise<Response> =>
  POST({
    request: new Request('http://localhost:5605/api/messages/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: userId ? { id: userId } : null }
  } as any) as Promise<Response>

const goodBody = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  messageId: MESSAGE,
  steerId: 'steer_abc123',
  text: 'also check the tests',
  ...overrides
})

beforeEach(() => {
  __resetStreamAbortRegistryForTests()
  __resetSteerInboxRegistryForTests()
  sseBodies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: any, init: any) => {
      sseBodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
  )
})

afterEach(() => {
  __resetStreamAbortRegistryForTests()
  __resetSteerInboxRegistryForTests()
  vi.unstubAllGlobals()
})

describe('POST /api/messages/steer', () => {
  it('accepts a steer for the live turn and tells every tab about it', async () => {
    await seed()
    activeTurn()

    const response = await call(goodBody())
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      steerId: 'steer_abc123',
      pending: 1,
      lane: 'api'
    })

    expect(listPendingSteers(SESSION).map((row) => [row.steerId, row.text, row.source])).toEqual([
      ['steer_abc123', 'also check the tests', 'user']
    ])

    // Through `/api/sse`'s POST, not `publishSessionEvent`: only that path appends to the
    // replay buffer, so a tab opened mid-turn still sees the steer was queued.
    expect(sseBodies).toHaveLength(1)
    expect(sseBodies[0]).toMatchObject({
      type: 'steer_queued',
      sessionId: SESSION,
      messageId: MESSAGE,
      steerId: 'steer_abc123'
    })
  })

  it('still accepts the steer when the live-update channel fails', async () => {
    await seed()
    activeTurn()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sse down') }))

    expect((await call(goodBody())).status).toBe(202)
    expect(listPendingSteers(SESSION)).toHaveLength(1)
  })

  it('refuses an unauthenticated caller', async () => {
    await seed()
    activeTurn()
    expect((await call(goodBody(), null)).status).toBe(401)
  })

  it('refuses a session the caller does not own', async () => {
    await seed()
    activeTurn()
    expect((await call(goodBody(), OTHER)).status).toBe(404)
  })

  it('refuses a steer id that could break out of the stored placeholder', async () => {
    await seed()
    activeTurn()
    for (const steerId of ['has space', 'closes}}here', '', 'a'.repeat(65), 'colon:id']) {
      const response = await call(goodBody({ steerId }))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('invalid_input')
    }
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  it('refuses empty and oversized text', async () => {
    await seed()
    activeTurn()
    expect((await call(goodBody({ text: '   ' }))).status).toBe(400)
    expect((await call(goodBody({ text: 'x'.repeat(STEER_TEXT_MAX_CHARS + 1) }))).status).toBe(400)
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  it('refuses a group session with a reason (DL-114-12)', async () => {
    await seed({ group: true })
    activeTurn()

    const response = await call(goodBody())
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.code).toBe('not_steerable')
    expect(payload.reason).toContain('Group chats cannot be steered')
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  it('refuses a run the server marked not steerable, with its reason (DL-114-09)', async () => {
    await seed({ agentType: 'cli' })
    activeTurn(MESSAGE, {
      steerable: false,
      reason: 'This Codex agent runs on the one-shot exec transport. Your message interrupts instead.'
    })

    const response = await call(goodBody())
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.code).toBe('not_steerable')
    expect(payload.reason).toContain('exec transport')
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  /**
   * The stream registration and the steerability registration are written in the same
   * breath by send-routed, so a live stream with no verdict means something is wrong. The
   * route fails closed rather than assuming the turn can take the user's words.
   */
  it('refuses a live turn that registered no steerability verdict', async () => {
    await seed()
    activeTurn(MESSAGE, { registerRun: false })

    const response = await call(goodBody())
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('not_steerable')
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  it('refuses when the verdict belongs to a different assistant message', async () => {
    await seed()
    registerSessionTurn(SESSION, 'single', MESSAGE)
    registerStreamAbort(SESSION, MESSAGE, new AbortController())
    registerSteerRun(SESSION, {
      messageId: 'msg_assistant_2',
      steerable: true,
      reason: null,
      lane: 'api'
    })

    expect((await call(goodBody())).status).toBe(409)
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  it('reports the lane the run is actually on (P2)', async () => {
    await seed({ agentType: 'cli' })
    activeTurn(MESSAGE, { lane: 'claude' })

    const response = await call(goodBody())
    expect(response.status).toBe(202)
    expect((await response.json()).lane).toBe('claude')
  })

  /**
   * P2 (DL-114-06, DL-114-08): a managed CLI turn has no `prepareStep` to pull at its next
   * step, so the route pushes the text onto the running transport itself. It is deliberately
   * not awaited — a Codex `turn/steer` is a round trip with a 120-second ceiling and the
   * send button must not hang on it — so the assertion waits for the microtask instead.
   */
  it('pushes a steer to a managed CLI transport (DL-114-06, DL-114-08)', async () => {
    await seed({ agentType: 'cli' })
    activeTurn(MESSAGE, { lane: 'codex' })
    const sent: Array<{ steerIds: string[]; text: string }> = []
    attachSteerTransport(SESSION, MESSAGE, 'codex', async (payload) => {
      sent.push(payload)
      return true
    })

    expect((await call(goodBody())).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sent).toHaveLength(1)
    expect(sent[0].steerIds).toEqual(['steer_abc123'])
    // SA-118 (DL-118-07): one wrapper, and it is the one the guidance teaches.
    expect(sent[0].text).toContain('[The user said, mid-reply:')
    expect(sent[0].text).not.toContain('[Steer —')
    expect(sent[0].text).toContain('also check the tests')
    // Written, not yet echoed: it has left Batshit but the model has not read it.
    expect(listPendingSteers(SESSION)).toHaveLength(0)
    expect(listInFlightSteers(SESSION).map((row) => row.steerId)).toEqual(['steer_abc123'])
  })

  it('returns a refused CLI steer to the inbox so the turn can promote it', async () => {
    await seed({ agentType: 'cli' })
    activeTurn(MESSAGE, { lane: 'codex' })
    attachSteerTransport(SESSION, MESSAGE, 'codex', async () => {
      throw new Error('Codex app-server turn/steer failed: {"code":-32600,"message":"no active turn to steer"}')
    })

    expect((await call(goodBody())).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listInFlightSteers(SESSION)).toHaveLength(0)
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['steer_abc123'])
  })

  it('leaves an API steer waiting for the hook to pull it (no transport)', async () => {
    await seed()
    activeTurn()

    expect((await call(goodBody())).status).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listInFlightSteers(SESSION)).toHaveLength(0)
    expect(listPendingSteers(SESSION)).toHaveLength(1)
  })

  it('refuses when the reply already finished', async () => {
    await seed()
    const response = await call(goodBody())
    expect(response.status).toBe(409)
    expect((await response.json()).reason).toContain('already finished')
  })

  it('refuses a steer aimed at a different assistant message', async () => {
    await seed()
    activeTurn('msg_assistant_2')

    const response = await call(goodBody())
    expect(response.status).toBe(409)
    expect((await response.json()).reason).toContain('already finished')
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  /**
   * F-P1-2 (Faye's review): the route's live-turn check and its enqueue have to sit in ONE
   * synchronous block. With a Redis read between them, a turn that finished during that
   * read had already promoted and cleared its inbox, so the entry landed for a dead
   * assistant id — never delivered, never promoted, pruned six hours later — while the
   * route still answered 202.
   *
   * P2 removed the agent read the original fix was written against (the verdict comes from
   * the run now), so the remaining read is the session lookup — and the invariant is the
   * same one: every `await` is ABOVE the live-turn check, and a turn that ends during one
   * is refused rather than answered 202 for.
   */
  /**
   * The invariant itself, not just one instance of it (F-P1-2). The behavioural test above
   * can only prove that a turn ending during the ONE read the route still makes is refused;
   * this proves the shape that makes that true for every future read — from the live-turn
   * check down to `enqueueSteer` the route does not await at all, so no turn can end in
   * between and strand a steer the route has already answered 202 for.
   */
  it('never awaits between the live-turn check and the enqueue (F-P1-2)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const routeSource = readFileSync(
      resolve(process.cwd(), 'src/routes/api/messages/steer/+server.ts'),
      'utf8'
    )
    // Comments in this region talk ABOUT awaiting; it is the code that must not.
    const code = routeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const checkStart = code.indexOf('const activeStream = getActiveStream(sessionId)')
    const enqueue = code.indexOf('const enqueued = enqueueSteer(sessionId, {', checkStart)

    expect(checkStart).toBeGreaterThan(-1)
    expect(enqueue).toBeGreaterThan(checkStart)
    expect(code.slice(checkStart, enqueue)).not.toContain('await')
  })

  it('refuses when the reply finishes while the session is being read', async () => {
    await seed()
    activeTurn()
    const originalGetSession = redis.getSession.bind(redis)
    vi.spyOn(redis, 'getSession').mockImplementationOnce(async (id: string) => {
      const value = await originalGetSession(id)
      // The turn ends while the route is awaiting Redis.
      __resetStreamAbortRegistryForTests()
      __resetSteerInboxRegistryForTests()
      return value
    })

    const response = await call(goodBody())
    expect(response.status).toBe(409)
    expect((await response.json()).reason).toContain('already finished')
    expect(listPendingSteers(SESSION)).toHaveLength(0)
  })

  /**
   * F-P3-1 (Faye's review): the session-turn lock is registered at the top of send-routed
   * and the stream a few seconds later (gateway discovery, clips, the memory commit). A
   * steer typed in that window was refused as "already finished"; the client then sent it
   * as an ordinary message, which the lock refused with 409 and — not being an interrupt —
   * was never retried. The user's quickest follow-up failed outright. The route now waits
   * for the stream when the lock names this very assistant message.
   */
  it('waits for the stream when the session-turn lock names this reply (F-P3-1)', async () => {
    await seed()
    registerSessionTurn(SESSION, 'single', MESSAGE)
    // No stream yet: send-routed is still compiling.
    setTimeout(() => {
      registerStreamAbort(SESSION, MESSAGE, new AbortController())
      registerSteerRun(SESSION, { messageId: MESSAGE, steerable: true, reason: null, lane: 'api' })
    }, 150)

    const response = await call(goodBody())
    expect(response.status).toBe(202)
    expect(listPendingSteers(SESSION).map((row) => row.steerId)).toEqual(['steer_abc123'])
  })

  it('does not wait for a lock that names a different reply', async () => {
    await seed()
    registerSessionTurn(SESSION, 'single', 'msg_assistant_2')
    const started = Date.now()
    const response = await call(goodBody())
    expect(response.status).toBe(409)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('stops waiting as soon as the lock goes away', async () => {
    await seed()
    registerSessionTurn(SESSION, 'single', MESSAGE)
    setTimeout(() => __resetStreamAbortRegistryForTests(), 150)
    const started = Date.now()
    const response = await call(goodBody())
    expect(response.status).toBe(409)
    expect((await response.json()).reason).toContain('already finished')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('tags the two "already finished" refusals for the client (F-P3-5)', async () => {
    await seed()
    let response = await call(goodBody())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'not_steerable', refusal: 'reply_finished' })

    activeTurn('msg_assistant_2')
    response = await call(goodBody())
    expect(await response.json()).toMatchObject({ code: 'not_steerable', refusal: 'reply_finished' })

    // A refusal that is NOT about timing carries no such tag.
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    activeTurn(MESSAGE, { steerable: false, reason: 'nope' })
    response = await call(goodBody())
    expect((await response.json()).refusal).toBeUndefined()
  })

  it(`refuses a ${MAX_PENDING_STEERS + 1}th waiting steer instead of queueing it`, async () => {
    await seed()
    activeTurn()
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) {
      expect((await call(goodBody({ steerId: `steer_${i}` }))).status).toBe(202)
    }

    const response = await call(goodBody({ steerId: 'steer_overflow' }))
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.code).toBe('steer_inbox_full')
    expect(payload.reason).toContain('Wait for the reply')
  })
})
