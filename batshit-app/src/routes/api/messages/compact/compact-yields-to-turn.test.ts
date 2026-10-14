import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetStreamAbortRegistryForTests,
  clearSessionTurn,
  registerSessionTurn,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import { COMPACT_PENDING_APPROVAL_MESSAGE, getContextCompactionState } from '$lib/utils/contextCompaction'

/**
 * BL-622 (rule C3 of `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`): a Compact does not
 * start beside a turn. The route asks the turn registry at its start; while a turn runs in the
 * chat it answers 409 `turn_running` and calls no model. "Runs" is the lock (setting up,
 * replying, finishing) and also a request whose lock went while it still writes
 * (`hasRunningRequest`: "a lock is not a request").
 *
 * Drives the REAL `/api/messages/compact` POST on both lanes; only the model call and the token
 * estimate are stubbed.
 */

useRedisTestServer()

const calls = vi.hoisted(() => ({ summaries: 0 }))

vi.mock('$lib/server/services/summaryGeneration', () => ({
  generateModelSummary: vi.fn(async () => {
    calls.summaries += 1
    return { summary: 'Summary of the older stretch.', modelLabel: 'Stub', provider: 'stub', modelId: 'stub-model' }
  })
}))

vi.mock('$lib/server/services/contextTokenPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/contextTokenPreview')>()),
  estimateCurrentContextTokens: vi.fn(async () => ({ budget: { contextLimit: 128_000 }, tokens: 1_000 }))
}))

const { POST } = await import('./+server')

// The default lane's JSON.GET is already a vi.fn: spyOn returns that same mock. Capture
// its implementation once, before a fixture can replace it, rather than binding the mock
// (which would recurse). Do not acquire a real client before the DB15 harness starts.
const originalFakeJsonGet = vi.isMockFunction(redis.execute)
  ? await redis.execute(async (client) => {
      const implementation = vi.mocked(client.json.get).getMockImplementation()
      if (!implementation) throw new Error('The Redis fake has no JSON.GET implementation')
      return implementation
    })
  : null

async function withJsonGetOverride(
  override: (key: string, args: any[], delegate: () => Promise<unknown>) => Promise<unknown>,
  assertion: () => Promise<void>
) {
  await redis.execute(async (client) => {
    const get = originalFakeJsonGet ?? client.json.get
    const spy = vi.spyOn(client.json, 'get').mockImplementation(((key: string, ...args: any[]) =>
      override(key, args, () => Reflect.apply(get, client.json, [key, ...args]))
    ) as any)
    try {
      await assertion()
    } finally {
      spy.mockRestore()
      // mockRestore does not promise to retain an existing vi.fn's implementation.
      if (originalFakeJsonGet) vi.mocked(client.json.get).mockImplementation(originalFakeJsonGet)
    }
  })
}

const USER = 'zcyield_user'
const SESSION = 'zcyield_turn_session'
const AGENT = 'zcyield_agent'
const GROUP = 'zcyield_group'
const storedMessageIds: string[] = []

async function storeApproval(status = 'pending', extra: Record<string, unknown> = {}) {
  storedMessageIds.push('approval-card')
  await redis.saveMessage({
    id: 'approval-card', session_id: SESSION, user_id: USER, agent_id: AGENT,
    role: 'assistant', status: 'complete', content: 'The action needs your answer.',
    created_at: '2026-01-01T00:00:00.000Z',
    metadata: { answeredApprovalIds: [], toolApprovals: { approvals: [{ approvalId: 'approve-1', status }] }, ...extra }
  } as any)
}

function messages() {
  const at = (minute: number) => `2026-09-27T10:0${minute}:00.000Z`
  return [
    { id: 'u1', session_id: SESSION, role: 'user', content: 'Plan the garage shelves.', timestamp: at(1) },
    { id: 'a1', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Metal, 6 m wide.', timestamp: at(2) },
    { id: 'u2', session_id: SESSION, role: 'user', content: 'Order them.', timestamp: at(3) },
    { id: 'a2', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Ordered.', timestamp: at(4) }
  ]
}

async function compact(extra: Record<string, unknown> = {}) {
  const request = new Request('http://localhost/api/messages/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, mode: 'manual', messages: messages(), ...extra })
  })
  const response = await POST({ request, locals: { user: { id: USER } }, fetch: globalThis.fetch } as any)
  return { status: response.status, body: await response.json() }
}

async function storedEvents() {
  return getContextCompactionState(((await redis.getSession(SESSION)) as any)?.metadata).events
}

beforeEach(async () => {
  calls.summaries = 0
  storedMessageIds.length = 0
  __resetStreamAbortRegistryForTests()
  await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: USER, name: 'Garage', metadata: {} } as never)
  await redis.set(`agent:${AGENT}`, { id: AGENT, user_id: USER, displayName: 'Probe', agentType: 'api' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  __resetStreamAbortRegistryForTests()
  for (const key of [`session:${SESSION}`, `agent:${AGENT}`, `group:${GROUP}`, `user:${USER}:settings`, `messages:${SESSION}`,
    ...storedMessageIds.map(id => `message:${SESSION}:${id}`)]) await redis.del(key)
})

const TURN_RUNNING = {
  error: 'A reply is running in this chat. Compact runs after it.',
  code: 'turn_running'
}

describe('a Compact does not start beside a turn (BL-622, C3)', () => {
  it.each([{ mode: 'manual' }, { mode: 'manual', previewOnly: true }, { mode: 'auto' }])(
    'refuses a stored pending approval before estimating or calling a model, despite a browser history with no card: %j (BL-711)',
    async (extra) => {
      await storeApproval()
      const { status, body } = await compact(extra)
      expect(status).toBe(409)
      expect(body).toEqual({ error: COMPACT_PENDING_APPROVAL_MESSAGE, code: 'approval_pending' })
      expect(calls.summaries).toBe(0)
      expect(await storedEvents()).toEqual([])
    }
  )

  it('does not lose an older waiting card behind held messages or a newer assistant reply', async () => {
    await storeApproval()
    for (let index = 0; index < 6; index += 1) {
      const id = `held-${index}`
      storedMessageIds.push(id)
      await redis.saveMessage({ id, session_id: SESSION, user_id: USER, role: index === 0 ? 'assistant' : 'user',
        content: 'Held words', status: 'complete', created_at: `2026-01-01T00:00:0${index + 1}.000Z` } as any)
    }
    expect((await compact()).body.code).toBe('approval_pending')
    expect(calls.summaries).toBe(0)
  })

  it.each(['approved', 'denied', 'expired'])('allows Compact after the stored card is %s', async (status) => {
    await storeApproval(status)
    expect((await compact()).status).toBe(200)
    expect(calls.summaries).toBe(1)
  })

  it('honors the server\'s recorded answer even if an older card entry still says pending', async () => {
    await storeApproval('pending', { answeredApprovalIds: ['approve-1'] })
    expect((await compact()).status).toBe(200)
  })

  it('keeps Compact usable for a converted group with a visible CLI card, while a one-member group still waits', async () => {
    await storeApproval('pending', { toolApprovals: { approvals: [
      { approvalId: 'approve-1', status: 'pending', control: { lane: 'cli' } }
    ] } })
    await redis.json.set(`group:${GROUP}`, '$', { id: GROUP, user_id: USER, agent_ids: [AGENT, 'other-agent'] } as never)
    await redis.json.set(`session:${SESSION}`, '$.metadata.group_chat', { group_id: GROUP } as never)
    expect((await compact()).status).toBe(200)
    expect(calls.summaries).toBe(1)
    // The same group marker below the runner's threshold is a single-agent chat.
    await redis.json.set(`group:${GROUP}`, '$.agent_ids', [AGENT] as never)
    await redis.json.set(`session:${SESSION}`, '$.metadata.contextCompaction', { version: 1, events: [] } as never)
    expect((await compact()).body.code).toBe('approval_pending')
    expect(calls.summaries).toBe(1)
  })

  it('does not read or block on a pending card an earlier Compact already hid; its original record stays unchanged', async () => {
    await storeApproval()
    const previous = { id: 'previous-compact', createdAt: '2026-01-01T01:00:00.000Z',
      sourceMessageIds: ['approval-card'], summary: 'The earlier conversation.' }
    await redis.json.set(`session:${SESSION}`, '$.metadata.contextCompaction', { version: 1, events: [previous] } as never)
    await withJsonGetOverride(async (key, args, delegate) => {
      if (key === `message:${SESSION}:approval-card` && args[0]?.path) {
        throw new Error('A hidden card must not be scanned')
      }
      return delegate()
    }, async () => {
      expect((await compact()).status).toBe(200)
      expect(calls.summaries).toBe(1)
      const events = await storedEvents()
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual(previous)
    })
    expect((await redis.get(`message:${SESSION}:approval-card`))?.metadata.toolApprovals.approvals[0].status).toBe('pending')
  })

  it.each([
    { missing: [], pending: true }, { missing: [null], pending: true },
    { missing: [], pending: false }, { missing: [null], pending: false }
  ])('reads named JSONPaths regardless of key order and missing-field shape: %j', async ({ missing, pending }) => {
    await storeApproval()
    await withJsonGetOverride(async (key, args, delegate) => {
      if (key !== `message:${SESSION}:approval-card` || !args[0]?.path) return delegate()
      expect(args[0].path).toEqual(['$.role', '$.metadata.toolApprovals', '$.metadata.answeredApprovalIds'])
      return {
        '$.metadata.answeredApprovalIds': missing,
        '$.metadata.toolApprovals': pending ? [{ approvals: [{ approvalId: 'approve-1', status: 'pending' }] }] : missing,
        '$.role': ['assistant']
      }
    }, async () => {
      const { status, body } = await compact()
      expect(status).toBe(pending ? 409 : 200)
      expect(calls.summaries).toBe(pending ? 0 : 1)
      if (pending) expect(body.code).toBe('approval_pending')
    })
  })

  it('fails visibly instead of admitting a Compact when a stored approval record cannot be read', async () => {
    await storeApproval()
    await withJsonGetOverride(async (key, _args, delegate) => {
      if (key === `message:${SESSION}:approval-card`) throw new Error('Approval read unavailable')
      return delegate()
    }, async () => {
      const { status, body } = await compact()
      expect(status).toBe(500)
      expect(body.error).toBe(`Could not read Compact approval state for message:${SESSION}:approval-card: Approval read unavailable`)
      expect(calls.summaries).toBe(0)
      expect(await storedEvents()).toEqual([])
    })
  })

  it('answers 409 turn_running while a turn holds the chat, and calls no model', async () => {
    const turn = registerSessionTurn(SESSION, 'single', 'msg_reply')
    expect(turn.ok).toBe(true)

    const { status, body } = await compact()

    expect(status).toBe(409)
    expect(body).toEqual(TURN_RUNNING)
    expect(calls.summaries).toBe(0)
    expect(await storedEvents()).toEqual([])
  })

  it('refuses the preview too, so a pressed Compact learns it before the confirm step', async () => {
    registerSessionTurn(SESSION, 'single', 'msg_reply')

    const { status, body } = await compact({ previewOnly: true })

    expect(status).toBe(409)
    expect(body).toEqual(TURN_RUNNING)
  })

  it('also refuses while a request of the chat still runs after its lock went', async () => {
    const turn = registerSessionTurn(SESSION, 'single', 'msg_reply')
    if (!turn.ok) throw new Error('registration refused')
    // The lock goes (a Stop's clear, the grace after an aborted stream) while the request writes.
    clearSessionTurn(SESSION, 'msg_reply')

    const refused = await compact()
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual(TURN_RUNNING)

    // Once the request lets go of its own registration, the Compact runs.
    releaseSessionTurn(SESSION, turn.entry.turnId)
    const done = await compact()
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(calls.summaries).toBe(1)
    expect((await storedEvents()).map((event) => event.id)).toEqual([done.body.event.id])
  })

  it('a turn of another chat does not refuse this chat\'s Compact', async () => {
    registerSessionTurn('zcyield_other_chat', 'single', 'msg_other')

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
  })
})
