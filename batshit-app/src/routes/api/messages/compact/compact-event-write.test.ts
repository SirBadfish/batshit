import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { getContextCompactionState } from '$lib/utils/contextCompaction'

/**
 * BL-622 (rules C1 and C2 of `Plans/2026-09-27-bl622-a-compact-yields-to-a-turn.md`): a Compact
 * writes only its own event, at its own path in the chat's record, and only while the list of
 * events is still the list it read before its summary call.
 *
 * It used to write back the whole `metadata` block it read BEFORE the summary call, with its event
 * added, so whatever another writer put into the chat's metadata during that call was lost: a
 * regular chat's graduation mark, a removal from a group, or a second Compact's event (one summary
 * lost in silence).
 *
 * Drives the REAL `/api/messages/compact` POST. Real Redis 8 under `npm run test:redis` (the
 * write is one Lua script there); the default lane's fake twin under plain `npm test`. Only the
 * model call and the token estimate are stubbed; the stubbed model call is where the other writer
 * acts, because that call is the wait the race lives in.
 */

useRedisTestServer()

const during = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }))

vi.mock('$lib/server/services/summaryGeneration', () => ({
  generateModelSummary: vi.fn(async () => {
    if (during.hook) await during.hook()
    return { summary: 'Summary of the older stretch.', modelLabel: 'Stub', provider: 'stub', modelId: 'stub-model' }
  })
}))

vi.mock('$lib/server/services/contextTokenPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/contextTokenPreview')>()),
  estimateCurrentContextTokens: vi.fn(async () => ({ budget: { contextLimit: 128_000 }, tokens: 1_000 }))
}))

const { POST } = await import('./+server')

const USER = 'zcyield_user'
const SESSION = 'zcyield_session'
const AGENT = 'zcyield_agent'

function messages() {
  const at = (minute: number) => `2026-09-27T10:0${minute}:00.000Z`
  return [
    { id: 'u1', session_id: SESSION, role: 'user', content: 'Plan the garage shelves.', timestamp: at(1) },
    { id: 'a1', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Metal, 6 m wide.', timestamp: at(2) },
    { id: 'u2', session_id: SESSION, role: 'user', content: 'Order them.', timestamp: at(3) },
    { id: 'a2', session_id: SESSION, role: 'assistant', agent_id: AGENT, content: 'Ordered.', timestamp: at(4) }
  ]
}

function otherEvent(id: string) {
  return {
    id,
    createdAt: '2026-09-27T10:30:00.000Z',
    mode: 'manual',
    sourceMessageIds: ['u1'],
    protectedMessageIds: [],
    compactedMessageCount: 1,
    protectedMessageCount: 0,
    summary: `Summary written by ${id}.`
  }
}

async function seed(metadata: Record<string, unknown> | undefined) {
  await redis.json.set(`session:${SESSION}`, '$', {
    id: SESSION,
    user_id: USER,
    name: 'Garage',
    ...(metadata === undefined ? {} : { metadata })
  } as never)
  await redis.set(`agent:${AGENT}`, { id: AGENT, user_id: USER, displayName: 'Probe', agentType: 'api' })
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
  return ((await redis.getSession(SESSION)) as any)?.metadata ?? null
}

beforeEach(() => {
  during.hook = null
})

afterEach(async () => {
  for (const key of [`session:${SESSION}`, `agent:${AGENT}`, `user:${USER}:settings`]) await redis.del(key)
})

describe('a Compact writes only its own event (BL-622, C1 and C2)', () => {
  it('keeps what another writer put into the chat\'s metadata during the summary call', async () => {
    await seed({ origin: { kind: 'user' } })
    during.hook = async () => {
      // A regular chat's graduation mark, written the way its writer writes it (a fresh read).
      const fresh = (await redis.getSession(SESSION)) as any
      await redis.updateSession(SESSION, {
        metadata: { ...(fresh?.metadata ?? {}), memoryGraduation: { version: 1, lastGraduatedMessageId: 'a2' } }
      } as any)
    }

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    const metadata = await storedMetadata()
    expect(metadata.memoryGraduation).toEqual({ version: 1, lastGraduatedMessageId: 'a2' })
    expect(metadata.origin).toEqual({ kind: 'user' })
    const events = getContextCompactionState(metadata).events
    expect(events.map((event) => event.id)).toEqual([body.event.id])
    expect(events[0].sourceMessageIds).toEqual(['u1', 'a1', 'u2', 'a2'])
    // The answer carries the stored block (the page puts it in its session store).
    expect(body.contextCompaction).toEqual(metadata.contextCompaction)
  })

  it('appends after the events it read, keeping their order', async () => {
    await seed({ contextCompaction: { version: 1, events: [otherEvent('evt_older')] } })

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    const events = getContextCompactionState(await storedMetadata()).events
    expect(events.map((event) => event.id)).toEqual(['evt_older', body.event.id])
  })

  it('counts events the way the readers do: a malformed entry after the last event does not refuse the write', async () => {
    await seed({ contextCompaction: { version: 1, events: [otherEvent('evt_older'), { note: 'not an event' }] } })

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    const events = getContextCompactionState(await storedMetadata()).events
    expect(events.map((event) => event.id)).toEqual(['evt_older', body.event.id])
  })

  it('counts an event only when its sourceMessageIds is a list, as the readers do', async () => {
    // A stored event whose `sourceMessageIds` is an object is not an event to the readers
    // (`getContextCompactionState`), so the Compact reads `evt_older` as the last one. Counting it
    // anyway would refuse every later Compact in the chat.
    await seed({
      contextCompaction: {
        version: 1,
        events: [otherEvent('evt_older'), { ...otherEvent('evt_malformed'), sourceMessageIds: { 0: 'u1' } }]
      }
    })

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    const events = getContextCompactionState(await storedMetadata()).events
    expect(events.map((event) => event.id)).toEqual(['evt_older', body.event.id])
  })

  it('writes the first event into a chat record that has no metadata yet', async () => {
    await seed(undefined)

    const { status, body } = await compact()

    expect(status, JSON.stringify(body)).toBe(200)
    const metadata = await storedMetadata()
    expect(metadata.contextCompaction).toEqual({ version: 1, events: [body.event] })
  })

  it('is refused and says so when another Compact added its event first; nothing is lost', async () => {
    await seed({ contextCompaction: { version: 1, events: [otherEvent('evt_older')] } })
    during.hook = async () => {
      const fresh = (await redis.getSession(SESSION)) as any
      const state = getContextCompactionState(fresh?.metadata)
      await redis.updateSession(SESSION, {
        metadata: {
          ...(fresh?.metadata ?? {}),
          contextCompaction: { version: 1, events: [...state.events, otherEvent('evt_second_compact')] }
        }
      } as any)
    }

    const { status, body } = await compact()

    expect(status).toBe(409)
    expect(body.code).toBe('ended_early')
    expect(body.reason).toBe('compaction_changed')
    expect(body.error).toBe('Another Compact finished in this chat first. This Compact wrote nothing.')
    const events = getContextCompactionState(await storedMetadata()).events
    expect(events.map((event) => event.id)).toEqual(['evt_older', 'evt_second_compact'])
  })

  it('writes nothing into a chat deleted during the summary call', async () => {
    await seed({})
    during.hook = async () => {
      await redis.del(`session:${SESSION}`)
    }

    const { status, body } = await compact()

    expect(status).toBe(404)
    expect(body.error).toBe('Session not found')
    expect(await redis.getSession(SESSION)).toBeNull()
  })
})
