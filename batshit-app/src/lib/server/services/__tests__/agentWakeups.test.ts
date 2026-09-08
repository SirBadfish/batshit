import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { MAX_WAKE_CHAIN_DEPTH } from '$lib/utils/dmControl'
import {
  __resetWakeRunRegistryForTests,
  getWakeAbortSignal,
  hasActiveWakeRun
} from '$lib/server/services/wakeRunRegistry'
import { getDm } from '$lib/server/services/dm/dmStore'
import {
  clearSessionTurn,
  registerSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  abortWokenTurnForInterrupt,
  endWokenTurn,
  requestAgentWakeup,
  selectCurrentSessionForAgent
} from '$lib/server/services/agentWakeups'
import { resolveSessionOrigin } from '$lib/utils/sessionOrigin'
import type { ChatSessionRow } from '$lib/types/database'

/**
 * SA-113 P1 (DL-113-05, DL-113-15) — the wake primitive.
 *
 * Every refusal is asserted, because the whole safety contract is "nothing is dropped and
 * nothing retries: a wake that cannot happen degrades to `wait` with a readable reason".
 *
 * `fetch` is stubbed, so nothing here starts a real turn; the assertion is on the checks,
 * the session/message writes, and which request the primitive would have made.
 */

useRedisTestServer()

const USER = 'user-wake-test'

const fetchCalls: { url: string; init: any }[] = []

/**
 * When set, the send-routed call hangs on this promise instead of resolving at once, so a
 * test can observe the woken turn while it is still "running". Without it the stubbed
 * fetch resolves in the same microtask and the registry entry is already cleared.
 */
let holdSendRouted: Promise<void> | null = null

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = String(input)
      fetchCalls.push({ url, init })
      if (holdSendRouted && url.includes('/api/messages/send-routed')) {
        await holdSendRouted
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
  )
}

async function seedAgent(overrides: Record<string, any> = {}) {
  const agent = {
    id: 'agent-cooper',
    user_id: USER,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    ...overrides
  }
  await redis.createAgent(agent as any)
  return agent
}

async function seedSession(
  id: string,
  overrides: Partial<ChatSessionRow> = {}
): Promise<ChatSessionRow> {
  return redis.createSession({
    id,
    user_id: USER,
    name: id,
    agent_id: 'agent-cooper',
    created_at: '2026-09-07T09:00:00.000Z',
    last_modified_at: '2026-09-07T09:00:00.000Z',
    metadata: { agent_id: 'agent-cooper', last_agent_id: 'agent-cooper' },
    ...overrides
  } as any)
}

function baseInput(overrides: Record<string, any> = {}) {
  return {
    userId: USER,
    agentId: 'agent-cooper',
    target: { kind: 'new-session' as const, subject: 'Verify the package' },
    content: '[Agent DM — from Faye, not from the user] assignment — Verify the package',
    origin: { kind: 'dm' as const, fromLabel: 'Faye', agentId: 'agent-faye', dmId: 'dm_1' },
    chainDepth: 0,
    ...overrides
  }
}

// `$env/dynamic/private` is the mocked object in `$lib/test-utils/env-mock`, so the
// service token is set on it directly rather than through `vi.stubEnv`, which only
// touches `process.env`.
const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined
let previousGatewayToken: string | undefined

beforeEach(() => {
  fetchCalls.length = 0
  holdSendRouted = null
  previousToken = envRecord.BATSHIT_TOKEN
  previousGatewayToken = envRecord.MCP_GATEWAY_AUTH_TOKEN
  envRecord.BATSHIT_TOKEN = 'test-service-token'
  delete envRecord.MCP_GATEWAY_AUTH_TOKEN
  stubFetch()
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
  if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
  else envRecord.BATSHIT_TOKEN = previousToken
  if (previousGatewayToken === undefined) delete envRecord.MCP_GATEWAY_AUTH_TOKEN
  else envRecord.MCP_GATEWAY_AUTH_TOKEN = previousGatewayToken
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('refusals, in the locked order (DL-113-05)', () => {
  it('refuses when the Admin master switch is off', async () => {
    await seedAgent()
    await redis.updateUserSettings(USER, {
      admin_settings: { agent_wakeups_enabled: false }
    } as any)

    const result = await requestAgentWakeup(baseInput())
    expect(result).toMatchObject({ ok: false, degraded: 'wait', code: 'wake_disabled_instance' })
  })

  it('refuses when the agent does not exist', async () => {
    const result = await requestAgentWakeup(baseInput({ agentId: 'nobody' }))
    expect(result).toMatchObject({ ok: false, code: 'agent_not_found' })
  })

  it('refuses when the agent has "May be woken" off', async () => {
    await seedAgent({ wake_enabled: false })
    const result = await requestAgentWakeup(baseInput())
    expect(result).toMatchObject({ ok: false, code: 'wake_disabled_agent' })
    if (!result.ok) expect(result.reason).toContain('Cooper')
  })

  it('refuses a retired n8n primary, so only live API/CLI agents are woken', async () => {
    await seedAgent({ agentType: 'n8n' })
    const result = await requestAgentWakeup(baseInput())
    expect(result).toMatchObject({ ok: false, code: 'agent_not_primary' })
  })

  it(`refuses past chain depth ${MAX_WAKE_CHAIN_DEPTH}`, async () => {
    await seedAgent()
    const result = await requestAgentWakeup(baseInput({ chainDepth: MAX_WAKE_CHAIN_DEPTH }))
    expect(result).toMatchObject({ ok: false, code: 'chain_depth_exceeded' })
  })

  it('allows the last permitted link in a chain', async () => {
    await seedAgent()
    const result = await requestAgentWakeup(
      baseInput({ chainDepth: MAX_WAKE_CHAIN_DEPTH - 1 })
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.chainDepth).toBe(MAX_WAKE_CHAIN_DEPTH)
  })

  it('refuses a target session that does not exist', async () => {
    await seedAgent()
    const result = await requestAgentWakeup(
      baseInput({ target: { kind: 'session', sessionId: 'gone' } })
    )
    expect(result).toMatchObject({ ok: false, code: 'session_not_found' })
  })

  it('refuses a group session as a target, because a group owns its own turn queue', async () => {
    await seedAgent()
    await seedSession('sess-group', {
      metadata: { agent_id: 'agent-cooper', group_chat: { group_id: 'g1' } }
    })
    const result = await requestAgentWakeup(
      baseInput({ target: { kind: 'session', sessionId: 'sess-group' } })
    )
    expect(result).toMatchObject({ ok: false, code: 'session_is_group' })
  })

  it("refuses a target session belonging to a different agent", async () => {
    await seedAgent()
    await seedSession('sess-other', {
      agent_id: 'agent-someone-else',
      metadata: { agent_id: 'agent-someone-else' }
    })
    const result = await requestAgentWakeup(
      baseInput({ target: { kind: 'session', sessionId: 'sess-other' } })
    )
    expect(result).toMatchObject({ ok: false, code: 'session_agent_mismatch' })
  })

  it('refuses a busy target session and degrades to wait', async () => {
    await seedAgent()
    await seedSession('sess-busy')
    registerSessionTurn('sess-busy', 'single', 'msg-1')
    try {
      const result = await requestAgentWakeup(
        baseInput({ target: { kind: 'session', sessionId: 'sess-busy' } })
      )
      expect(result).toMatchObject({ ok: false, degraded: 'wait', code: 'agent_busy' })
      if (!result.ok) expect(result.reason).toContain('mid-task')
    } finally {
      clearSessionTurn('sess-busy', 'msg-1')
    }
  })

  it('runs the caller-supplied guard LAST and reports its reason (P2 hook)', async () => {
    await seedAgent()
    const extraGuard = vi.fn(async () => ({
      ok: false as const,
      code: 'assignment_in_progress',
      reason: 'Cooper is already working an assignment.'
    }))
    const result = await requestAgentWakeup(baseInput({ extraGuard }))
    expect(extraGuard).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: false, code: 'assignment_in_progress' })
  })

  it('fails loudly when no service token is configured instead of sending empty headers', async () => {
    await seedAgent()
    delete envRecord.BATSHIT_TOKEN
    delete envRecord.MCP_GATEWAY_AUTH_TOKEN
    const result = await requestAgentWakeup(baseInput())
    expect(result).toMatchObject({ ok: false, code: 'service_token_missing' })
  })

  it('writes nothing when a check refuses', async () => {
    await seedAgent({ wake_enabled: false })
    await requestAgentWakeup(baseInput())
    const sessions = await redis.getSessions(USER, true)
    expect(sessions).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('accepting a wake-up (DL-113-05, DL-113-08)', () => {
  it('creates a named session carrying the origin, saves the user message, and posts to send-routed', async () => {
    await seedAgent()
    const result = await requestAgentWakeup(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.createdSession).toBe(true)
    const session = await redis.getSession(result.sessionId)
    expect(session?.name).toBe('DM from Faye: Verify the package')
    expect(session?.agent_id).toBe('agent-cooper')

    const origin = resolveSessionOrigin(session)
    expect(origin).toMatchObject({
      kind: 'dm',
      label: 'Faye',
      agentId: 'agent-faye',
      dmId: 'dm_1',
      chainDepth: 1
    })

    const messages = await redis.getMessages(result.sessionId, 50)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('not from the user')
    // F-SEC-1b: `dmId` rides here too, not only on `origin`, so `useControl` can stamp the
    // right DM from the one read it already does — and so "One at a time" (waking INTO an
    // existing chat, whose session origin belongs to the FIRST wake) still points at the
    // DM this turn is actually about.
    expect(messages[0].metadata?.wake).toEqual({ chainDepth: 1, dmId: 'dm_1' })

    const sendRouted = fetchCalls.find((call) => call.url.includes('/api/messages/send-routed'))
    expect(sendRouted).toBeDefined()
    const body = JSON.parse(sendRouted!.init.body)
    expect(body).toMatchObject({
      sessionId: result.sessionId,
      agentId: 'agent-cooper',
      userId: USER
    })
    // History is re-read from Redis, never trusted from the caller.
    expect(body.messages).toHaveLength(1)
    expect(body.metadata.wake).toMatchObject({ chainDepth: 1, dmId: 'dm_1' })
    expect(sendRouted!.init.headers['x-batshit-service-token']).toBe('test-service-token')
    expect(sendRouted!.init.signal).toBeDefined()
  })

  /**
   * F-P3-1. The primitive used to accept a `requestUrl` and prefer its origin, so an
   * inbound caller on a lane without `ORIGIN` could choose the host that receives
   * `x-batshit-service-token`. There is now one rule and no input to override it.
   */
  it('always self-calls the server-owned base, never anything an inbound request could set', async () => {
    await seedAgent()
    envRecord.BATSHIT_CLI_HELPER_BASE_URL = 'http://127.0.0.1:5605'
    try {
      const result = await requestAgentWakeup({
        ...baseInput(),
        // Still refused if it ever comes back as an input.
        requestUrl: 'http://evil.example/api/wake/hook_1'
      } as any)
      expect(result.ok).toBe(true)

      for (const call of fetchCalls) {
        expect(new URL(call.url).origin).toBe('http://127.0.0.1:5605')
      }
      expect(fetchCalls.some((call) => call.url.includes('/api/messages/send-routed'))).toBe(true)
    } finally {
      delete envRecord.BATSHIT_CLI_HELPER_BASE_URL
    }
  })

  it('registers the turn while it runs so /api/sse buffers its events (AMD-113-01)', async () => {
    await seedAgent()
    let release: () => void = () => {}
    holdSendRouted = new Promise<void>((resolve) => {
      release = resolve
    })

    const result = await requestAgentWakeup(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(hasActiveWakeRun(result.sessionId)).toBe(true)

    release()
    await holdSendRouted
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Completion clears the registry, so a later event for this session is dropped again.
    expect(hasActiveWakeRun(result.sessionId)).toBe(false)
  })

  it('forwards the wake-up user message to SSE without a top-level messageId', async () => {
    await seedAgent()
    await requestAgentWakeup(baseInput())
    const sse = fetchCalls.find((call) => call.url.endsWith('/api/sse'))
    expect(sse).toBeDefined()
    const body = JSON.parse(sse!.init.body)
    expect(body.type).toBe('user_message')
    expect(body.messageId).toBeUndefined()
  })

  it('runs a targeted existing session in place instead of creating one', async () => {
    await seedAgent()
    await seedSession('sess-original')
    const result = await requestAgentWakeup(
      baseInput({ target: { kind: 'session', sessionId: 'sess-original' } })
    )
    expect(result).toMatchObject({ ok: true, sessionId: 'sess-original', createdSession: false })
    const sessions = await redis.getSessions(USER, true)
    expect(sessions.map((s) => s.id)).toEqual(['sess-original'])
  })
})

describe('working style (DL-113-15)', () => {
  it('Parallel opens a new session even when the agent already has one', async () => {
    await seedAgent({ wake_target: 'new-session' })
    await seedSession('sess-existing')
    const result = await requestAgentWakeup(baseInput({ target: { kind: 'auto' } }))
    expect(result).toMatchObject({ ok: true, createdSession: true })
    if (result.ok) expect(result.sessionId).not.toBe('sess-existing')
  })

  it('One at a time lands in the agent’s current chat', async () => {
    await seedAgent({ wake_target: 'current-session' })
    await seedSession('sess-older', { last_modified_at: '2026-09-07T08:00:00.000Z' })
    await seedSession('sess-newer', { last_modified_at: '2026-09-07T10:00:00.000Z' })
    const result = await requestAgentWakeup(baseInput({ target: { kind: 'auto' } }))
    expect(result).toMatchObject({ ok: true, sessionId: 'sess-newer', createdSession: false })
  })

  it('One at a time falls back to a new session when the agent has no chat yet', async () => {
    await seedAgent({ wake_target: 'current-session' })
    const result = await requestAgentWakeup(baseInput({ target: { kind: 'auto' } }))
    expect(result).toMatchObject({ ok: true, createdSession: true })
    if (result.ok) {
      const session = await redis.getSession(result.sessionId)
      expect(resolveSessionOrigin(session)?.kind).toBe('dm')
    }
  })

  it('One at a time degrades to wait when the current chat is mid-turn', async () => {
    await seedAgent({ wake_target: 'current-session' })
    await seedSession('sess-current')
    registerSessionTurn('sess-current', 'single', 'msg-1')
    try {
      const result = await requestAgentWakeup(baseInput({ target: { kind: 'auto' } }))
      expect(result).toMatchObject({ ok: false, degraded: 'wait', code: 'agent_busy' })
    } finally {
      clearSessionTurn('sess-current', 'msg-1')
    }
  })
})

describe('selectCurrentSessionForAgent (DL-113-15)', () => {
  const make = (over: Partial<ChatSessionRow>): ChatSessionRow =>
    ({
      id: 'x',
      user_id: USER,
      agent_id: 'agent-cooper',
      created_at: '',
      last_modified_at: '2026-09-07T09:00:00.000Z',
      archived: false,
      locked: false,
      metadata: {},
      ...over
    }) as ChatSessionRow

  it('picks the most recently touched chat', () => {
    const picked = selectCurrentSessionForAgent(
      [
        make({ id: 'a', last_modified_at: '2026-09-07T08:00:00.000Z' }),
        make({ id: 'b', last_modified_at: '2026-09-07T12:00:00.000Z' }),
        make({ id: 'c', last_modified_at: '2026-09-07T10:00:00.000Z' })
      ],
      'agent-cooper'
    )
    expect(picked?.id).toBe('b')
  })

  it('skips archived chats, group chats, and other agents’ chats', () => {
    const picked = selectCurrentSessionForAgent(
      [
        make({ id: 'archived', archived: true, last_modified_at: '2026-09-07T23:00:00.000Z' }),
        make({
          id: 'group',
          metadata: { group_chat: { group_id: 'g1' } },
          last_modified_at: '2026-09-07T22:00:00.000Z'
        }),
        make({
          id: 'other-agent',
          agent_id: 'agent-faye',
          metadata: {},
          last_modified_at: '2026-09-07T21:00:00.000Z'
        }),
        make({ id: 'keeper', last_modified_at: '2026-09-07T07:00:00.000Z' })
      ],
      'agent-cooper'
    )
    expect(picked?.id).toBe('keeper')
  })

  it('resolves the agent through the metadata aliases a session may carry', () => {
    const picked = selectCurrentSessionForAgent(
      [
        make({
          id: 'aliased',
          agent_id: undefined,
          metadata: { last_agent_id: 'agent-cooper' }
        })
      ],
      'agent-cooper'
    )
    expect(picked?.id).toBe('aliased')
  })

  it('returns null when the agent has no chat', () => {
    expect(selectCurrentSessionForAgent([], 'agent-cooper')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * P1 review follow-ups (Faye, 2026-09-07)
 * ------------------------------------------------------------------ */

describe('F-P1-1: a woken turn owns its session-turn lock', () => {
  it('posts an assistant message id, distinct from the user message it saved', async () => {
    await seedAgent()
    const result = await requestAgentWakeup(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sendRouted = fetchCalls.find((call) => call.url.includes('/api/messages/send-routed'))
    const body = JSON.parse(sendRouted!.init.body)

    // send-routed registers AND releases the session-turn lock under this id, and an
    // unowned release (`messageId: undefined`) deletes whatever lock it finds — which
    // could be a live turn the user started in the same chat.
    expect(typeof body.messageId).toBe('string')
    expect(body.messageId.length).toBeGreaterThan(0)
    expect(body.messageId).not.toBe(result.messageId)
  })
})

describe('F-P1-3: the running slot is held from the moment the caps pass', () => {
  it('lets only ONE of two same-instant wakes for one agent through', async () => {
    await seedAgent()
    let release: () => void = () => {}
    holdSendRouted = new Promise<void>((resolve) => {
      release = resolve
    })

    const [first, second] = await Promise.all([
      requestAgentWakeup(baseInput()),
      requestAgentWakeup(baseInput({ content: 'second wake' }))
    ])

    const accepted = [first, second].filter((result) => result.ok)
    const refused = [first, second].filter((result) => !result.ok)
    expect(accepted).toHaveLength(1)
    expect(refused[0]).toMatchObject({
      degraded: 'wait',
      code: 'wake_running_limit_agent'
    })
    release()
  })

  it('gives the slot back when a later check refuses, so the next wake can run', async () => {
    await seedAgent()
    // Refused at the target step, which is AFTER the cap check took the slot.
    const refused = await requestAgentWakeup(
      baseInput({ target: { kind: 'session', sessionId: 'no-such-session' } })
    )
    expect(refused).toMatchObject({ ok: false, code: 'session_not_found' })

    const accepted = await requestAgentWakeup(baseInput())
    expect(accepted.ok).toBe(true)
  })

  it('gives the slot back when the accepted turn finishes', async () => {
    await seedAgent()
    const first = await requestAgentWakeup(baseInput())
    expect(first.ok).toBe(true)
    // The stubbed fetch resolves at once, so the run has already cleared.
    const second = await requestAgentWakeup(baseInput({ content: 'second wake' }))
    expect(second.ok).toBe(true)
  })
})

describe('F-P1-4: a 409 from send-routed is `agent_busy`, not a failure', () => {
  it('records a wait degrade on the DM instead of "the woken turn failed"', async () => {
    await seedAgent()
    // The DM the wake is carrying, written the way `sys.dm.send` writes it.
    await redis.json.set('dm:dm_1', '$', {
      id: 'dm_1',
      messageId: 'dm_1',
      userId: USER,
      kind: 'info',
      priority: 'normal',
      from: { kind: 'agent', agentId: 'agent-faye', name: 'Faye' },
      to: 'agent-cooper',
      subject: 'Heads up',
      body: 'Something happened.',
      deliver: 'wake',
      status: 'new',
      createdAt: '2026-09-07T09:00:00.000Z',
      createdTs: Date.parse('2026-09-07T09:00:00.000Z'),
      expiresAt: '2026-09-14T09:00:00.000Z',
      delivery: { requested: 'wake', actual: 'wake' }
    } as never)

    // The user starts a turn in that chat between the busy check and the POST.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input)
        fetchCalls.push({ url, init })
        if (url.includes('/api/messages/send-routed')) {
          return new Response(
            JSON.stringify({ error: 'Another response is already in progress for this session.', code: 'session_turn_in_progress' }),
            { status: 409 }
          )
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      })
    )

    const result = await requestAgentWakeup(baseInput())
    expect(result.ok).toBe(true)

    // The POST is fire-and-forget on purpose, and the stamp rides a dynamic import plus a
    // Redis write behind it, so poll for the outcome rather than guessing a delay.
    let dm = await getDm('dm_1')
    for (let attempt = 0; attempt < 100 && !dm?.delivery?.outcome; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      dm = await getDm('dm_1')
    }
    expect(dm?.delivery).toMatchObject({
      requested: 'wake',
      actual: 'wait',
      outcome: 'agent_busy'
    })
    expect(dm?.delivery.reason).toMatch(/started another turn/i)
  })
})

describe('F-P1-5: Stop and the hard timeout are told apart on the signal', () => {
  it('aborts with `wake_timeout` for the timer and `wake_stop` for a Stop', async () => {
    await seedAgent()
    let release: () => void = () => {}
    holdSendRouted = new Promise<void>((resolve) => {
      release = resolve
    })

    const stopped = await requestAgentWakeup(baseInput())
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) return
    abortWokenTurnForInterrupt(stopped.sessionId)
    // send-routed reads this reason to decide whether the message says the user stopped
    // the turn or the wake-up time limit did.
    expect(getWakeAbortSignal(stopped.sessionId)?.reason).toBe('wake_stop')
    release()
  })

  /**
   * The signal carried the distinction; what was RECORDED threw it away.
   *
   * `endWokenTurn` aborts the controller and only reaches its own
   * `finishWokenTurn('timed_out')` after an awaited HTTP round trip to the interrupt route,
   * so the aborted `fetch`'s own handler always won the single-winner `clearWakeRun` race —
   * and that handler reported a flat `'stopped'`. Every hard timeout was therefore filed as
   * a user Stop, while the finalized assistant message said "timeout".
   */
  it('records a hard timeout as timed_out, not as a user Stop', async () => {
    await seedAgent()
    await redis.json.set('dm:dm_1', '$', {
      id: 'dm_1',
      messageId: 'dm_1',
      userId: USER,
      kind: 'assignment',
      priority: 'normal',
      from: { kind: 'agent', agentId: 'agent-faye', name: 'Faye' },
      to: 'agent-cooper',
      subject: 'Verify the package',
      body: 'Run the audit.',
      deliver: 'wake',
      status: 'working',
      createdAt: '2026-09-08T09:00:00.000Z',
      createdTs: Date.parse('2026-09-08T09:00:00.000Z'),
      expiresAt: '2026-09-15T09:00:00.000Z',
      delivery: { requested: 'wake', actual: 'wake' }
    } as never)

    let release: () => void = () => {}
    holdSendRouted = new Promise<void>((resolve) => {
      release = resolve
    })

    const started = await requestAgentWakeup(baseInput())
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await endWokenTurn({
      sessionId: started.sessionId,
      reason: 'timed_out',
      originBase: 'http://localhost:5620',
      userId: USER
    })
    release()

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await getDm('dm_1'))?.delivery?.outcome) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect((await getDm('dm_1'))?.delivery?.outcome).toBe('timed_out')
  })
})

describe('F-SEC-1b — a woken turn that ends stuck on the user says so', () => {
  /**
   * Josh's reason, in his words: "the user might not even know that they need to do it."
   * A woken turn that stops at a Bash or MCP approval card ENDS normally — the run spinner
   * clears, the DM stays `working`, and nothing anywhere says a person is the holdup.
   */
  async function runWakeAndFinish(seedTail: (sessionId: string) => Promise<void>) {
    await seedAgent()
    // The DM the wake is carrying, written the way `sys.dm.send` writes it.
    await redis.json.set('dm:dm_1', '$', {
      id: 'dm_1',
      messageId: 'dm_1',
      userId: USER,
      kind: 'assignment',
      priority: 'normal',
      from: { kind: 'agent', agentId: 'agent-faye', name: 'Faye' },
      to: 'agent-cooper',
      subject: 'Verify the package',
      body: 'Run the audit and report what it says.',
      requestedOutcome: 'A pass/fail with the audit output.',
      deliver: 'wake',
      status: 'working',
      createdAt: '2026-09-08T09:00:00.000Z',
      createdTs: Date.parse('2026-09-08T09:00:00.000Z'),
      expiresAt: '2026-09-15T09:00:00.000Z',
      delivery: { requested: 'wake', actual: 'wake' }
    } as never)

    let release: () => void = () => {}
    holdSendRouted = new Promise<void>((resolve) => {
      release = resolve
    })

    const result = await requestAgentWakeup(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('the wake was refused')

    // The turn writes its assistant message before send-routed answers, exactly as a real
    // one does; only then does the primitive get to look at how it ended.
    await seedTail(result.sessionId)
    release()
    // The POST is fire-and-forget, and the stamp rides a dynamic import plus a Redis write
    // behind it, so poll for the outcome rather than guessing a delay (as F-P1-4 does).
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await getDm('dm_1'))?.delivery?.outcome) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return result
  }

  it('stamps the DM when the turn ended on a pending tool approval', async () => {
    await runWakeAndFinish(async (sessionId) => {
      await redis.saveMessage({
        id: 'msg-assistant-approval',
        session_id: sessionId,
        user_id: USER,
        agent_id: 'agent-cooper',
        role: 'assistant',
        status: 'complete',
        content: 'I need to run the audit script first.',
        created_at: '2026-09-08T09:00:01.000Z',
        metadata: { toolApprovals: [{ id: 'approval-1', toolName: 'native_bash_execute' }] }
      } as any)
    })

    const dm = await getDm('dm_1')
    expect(dm?.delivery.outcome).toBe('completed')
    expect(dm?.delivery.needsUser?.reason).toContain('approve a tool')
  })

  it('leaves an ordinary finished turn alone', async () => {
    await runWakeAndFinish(async (sessionId) => {
      await redis.saveMessage({
        id: 'msg-assistant-done',
        session_id: sessionId,
        user_id: USER,
        agent_id: 'agent-cooper',
        role: 'assistant',
        status: 'complete',
        content: 'Done — the audit passed.',
        created_at: '2026-09-08T09:00:01.000Z',
        metadata: {}
      } as any)
    })

    const dm = await getDm('dm_1')
    expect(dm?.delivery.outcome).toBe('completed')
    expect(dm?.delivery.needsUser).toBeUndefined()
  })
})
