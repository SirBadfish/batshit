import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetStreamAbortRegistryForTests,
  registerSessionTurn,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import { getContextCompactionState } from '$lib/utils/contextCompaction'

/**
 * BL-622 (rule C4 of `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`): a Compact looks
 * again after its summary call and before its write. When a turn runs now, or one started since
 * the Compact started, or a selected message became protected during the call, it writes nothing
 * and answers 409 `ended_early` with the reason. (The third look, an unchanged list of events, is
 * rule C2's conditional write: `compact-event-write.test.ts`.)
 *
 * Drives the REAL `/api/messages/compact` POST. Only the model call, the token estimate, and the
 * protections read are stubbed; the stubbed model call is where the turn starts or the protection
 * lands, because that call is the wait the race lives in.
 */

useRedisTestServer()

const during = vi.hoisted(() => ({
  hook: null as null | (() => Promise<void> | void),
  protections: { protectedUnzippedZipIds: [] as string[], userUnzippedZipIds: [] as string[], activeClipIds: [] as string[] }
}))

vi.mock('$lib/server/services/summaryGeneration', () => ({
  generateModelSummary: vi.fn(async () => {
    if (during.hook) await during.hook()
    return { summary: 'Summary of the older stretch.', modelLabel: 'Stub', provider: 'stub', modelId: 'stub-model' }
  })
}))

vi.mock('$lib/server/services/contextTokenPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/contextTokenPreview')>()),
  estimateCurrentContextTokens: vi.fn(async () => ({ budget: { contextLimit: 128_000 }, tokens: 1_000 })),
  loadContextProtections: vi.fn(async () => ({
    protectedUnzippedZipIds: [...during.protections.protectedUnzippedZipIds],
    userUnzippedZipIds: [...during.protections.userUnzippedZipIds],
    activeClipIds: [...during.protections.activeClipIds]
  }))
}))

const { POST } = await import('./+server')

const USER = 'zcyield_user'
const SESSION = 'zcyield_look_session'
const AGENT = 'zcyield_agent'

function messages() {
  const at = (minute: number) => `2026-09-27T10:0${minute}:00.000Z`
  return [
    { id: 'u1', session_id: SESSION, role: 'user', content: 'Plan the garage shelves.', timestamp: at(1) },
    {
      id: 'a1',
      session_id: SESSION,
      role: 'assistant',
      agent_id: AGENT,
      content: 'Metal, 6 m wide.',
      timestamp: at(2),
      metadata: { zipIds: ['zip_shelf_plan'] }
    },
    { id: 'u2', session_id: SESSION, role: 'user', content: 'Order them.', timestamp: at(3) },
    { id: 'a2', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Ordered.', timestamp: at(4) }
  ]
}

async function compact() {
  const request = new Request('http://localhost/api/messages/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, mode: 'manual', messages: messages() })
  })
  const response = await POST({ request, locals: { user: { id: USER } }, fetch: globalThis.fetch } as any)
  return { status: response.status, body: await response.json() }
}

async function storedMetadata() {
  return ((await redis.getSession(SESSION)) as any)?.metadata
}

beforeEach(async () => {
  during.hook = null
  during.protections = { protectedUnzippedZipIds: [], userUnzippedZipIds: [], activeClipIds: [] }
  __resetStreamAbortRegistryForTests()
  await redis.json.set(`session:${SESSION}`, '$', {
    id: SESSION,
    user_id: USER,
    name: 'Garage',
    metadata: { keep: 'me' }
  } as never)
  await redis.set(`agent:${AGENT}`, { id: AGENT, user_id: USER, displayName: 'Probe', agentType: 'api' })
})

afterEach(async () => {
  __resetStreamAbortRegistryForTests()
  for (const key of [`session:${SESSION}`, `agent:${AGENT}`, `user:${USER}:settings`,
    `messages:${SESSION}`, `message:${SESSION}:card-arrived`]) await redis.del(key)
})

describe('a Compact looks again before it writes (BL-622, C4)', () => {
  it('the final watermark catches a new card even when its creating turn ended during the summary (BL-711)', async () => {
    during.hook = async () => {
      const turn = registerSessionTurn(SESSION, 'single', 'card-arrived')
      if (!turn.ok) throw new Error('registration refused')
      await redis.saveMessage({ id: 'card-arrived', session_id: SESSION, user_id: USER,
        role: 'assistant', status: 'complete', content: 'Approve this?', created_at: new Date().toISOString(),
        metadata: { toolApprovals: { approvals: [{ approvalId: 'new-card', status: 'pending' }] } } } as any)
      releaseSessionTurn(SESSION, turn.entry.turnId)
    }
    const { status, body } = await compact()
    expect(status).toBe(409)
    expect(body.code).toBe('ended_early')
    expect(body.reason).toBe('turn_started')
    expect(await storedMetadata()).toEqual({ keep: 'me' })
  })

  it('writes nothing and ends early when a turn starts during the summary call and still runs', async () => {
    during.hook = () => {
      const turn = registerSessionTurn(SESSION, 'single', 'msg_reply')
      expect(turn.ok).toBe(true)
    }

    const { status, body } = await compact()

    expect(status).toBe(409)
    expect(body).toEqual({
      error: 'A reply started in this chat. This Compact wrote nothing.',
      code: 'ended_early',
      reason: 'turn_started'
    })
    expect(await storedMetadata()).toEqual({ keep: 'me' })
  })

  it('also ends early when that turn started AND ended during the call (it left no lock behind)', async () => {
    during.hook = () => {
      const turn = registerSessionTurn(SESSION, 'single', 'msg_reply')
      if (!turn.ok) throw new Error('registration refused')
      releaseSessionTurn(SESSION, turn.entry.turnId)
    }

    const { status, body } = await compact()

    expect(status).toBe(409)
    expect(body.code).toBe('ended_early')
    expect(body.reason).toBe('turn_started')
    expect(await storedMetadata()).toEqual({ keep: 'me' })
  })

  it('a turn that ended before the Compact started does not end it', async () => {
    const before = registerSessionTurn(SESSION, 'single', 'msg_earlier')
    if (!before.ok) throw new Error('registration refused')
    releaseSessionTurn(SESSION, before.entry.turnId)

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
  })

  it('writes nothing and ends early when a selected message becomes protected during the call', async () => {
    during.hook = () => {
      during.protections.protectedUnzippedZipIds = ['zip_shelf_plan']
      during.protections.userUnzippedZipIds = ['zip_shelf_plan']
    }

    const { status, body } = await compact()

    expect(status).toBe(409)
    expect(body).toEqual({
      error: 'A message this Compact summarized is now protected. This Compact wrote nothing.',
      code: 'ended_early',
      reason: 'message_protected'
    })
    expect(await storedMetadata()).toEqual({ keep: 'me' })
  })

  it('control: with no change during the call it writes its event as before', async () => {
    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    const metadata = await storedMetadata()
    expect(metadata.keep).toBe('me')
    const events = getContextCompactionState(metadata).events
    expect(events.map((event) => event.id)).toEqual([body.event.id])
    expect(body.event.sourceMessageIds).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})
