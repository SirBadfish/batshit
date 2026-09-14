import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { promoteSteersToNextTurn } from '$lib/server/services/steerPromotion'
import type { SteerEntry } from '$lib/utils/steerControl'

/**
 * SA-114 P1 (DL-114-07) — "nothing you typed is lost".
 *
 * When a reply ends with a steer still waiting, the SERVER writes it as the user's next
 * message and runs the follow-up turn. Doing it server-side is the point: a browser queue
 * loses the text the moment the tab closes.
 */

useRedisTestServer()

const USER = 'user-promote'
const SESSION = 'session-promote'
const AGENT = 'agent-api'

const steer = (
  steerId: string,
  text: string,
  overrides: Partial<SteerEntry> = {}
): SteerEntry => ({
  steerId,
  messageId: 'msg_assistant_1',
  text,
  at: '2026-09-10T12:00:00.000Z',
  source: 'user',
  ...overrides
})

let sseBodies: any[] = []
const eventFetch = vi.fn(async (_url: any, init: any) => {
  sseBodies.push(JSON.parse(init.body))
  return new Response(JSON.stringify({ success: true }), { status: 200 })
})

const request = new Request('http://localhost:5605/api/messages/send-routed', {
  method: 'POST'
})

async function seed() {
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    name: SESSION,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    metadata: {}
  } as any)
}

const promote = (steers: SteerEntry[]) =>
  promoteSteersToNextTurn({
    sessionId: SESSION,
    userId: USER,
    agentId: AGENT,
    steers,
    eventFetch: eventFetch as unknown as typeof fetch,
    request
  })

beforeEach(async () => {
  sseBodies = []
  // Reset the IMPLEMENTATION, not only the call list: the "channel is down" case below
  // sets a rejecting one with `mockRejectedValue`, which is not a spy and so survives
  // `restoreAllMocks` — every suite added after it then ran with a dead SSE channel and
  // saw no events at all.
  eventFetch.mockReset()
  eventFetch.mockImplementation(async (_url: any, init: any) => {
    sseBodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  await seed()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('promoting an undelivered steer (DL-114-07)', () => {
  it('writes the steer as the user’s next message, under the id the client already drew', async () => {
    const result = await promote([steer('steer_one', 'also run the tests')])

    expect(result).not.toBeNull()
    expect(result!.content).toBe('also run the tests')

    const saved = (await redis.get(`message:${SESSION}:steer_one`)) as any
    expect(saved).toMatchObject({
      id: 'steer_one',
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'user',
      content: 'also run the tests'
    })
    expect(saved.metadata.steerPromoted).toEqual({ steerIds: ['steer_one'] })

    // A human typed this, so a woken chat reads as human from here on — the same reason
    // SA-116's approval resume carries no `metadata.wake` either.
    expect(saved.metadata.wake).toBeUndefined()
  })

  it('joins several waiting steers into ONE message under the first id', async () => {
    const result = await promote([
      steer('steer_one', 'also run the tests'),
      steer('steer_two', 'and push it')
    ])

    expect(result!.content).toBe('also run the tests\n\nand push it')
    const saved = (await redis.get(`message:${SESSION}:steer_one`)) as any
    expect(saved.metadata.steerPromoted).toEqual({ steerIds: ['steer_one', 'steer_two'] })
    expect(await redis.get(`message:${SESSION}:steer_two`)).toBeNull()
  })

  it('tells every tab, then hands back a fresh assistant id and re-read history', async () => {
    const result = await promote([steer('steer_one', 'also run the tests')])

    expect(sseBodies.map((body) => body.type)).toEqual(['user_message', 'steer_promoted'])
    expect(sseBodies[0].message.id).toBe('steer_one')
    expect(sseBodies[1]).toMatchObject({ steerIds: ['steer_one'] })
    // PR #106 review F-22: no top-level messageId on the promoted event. The replay buffer is
    // keyed on the assistant id, and an event carrying any other id was never pruned — the
    // session's buffer stayed pinned open for the life of the process.
    expect(sseBodies[1]).not.toHaveProperty('messageId')

    // A NEW assistant id: reusing the one the steer was aimed at would overwrite the reply
    // the user was reading.
    expect(result!.assistantMessageId).not.toBe('msg_assistant_1')
    expect(result!.assistantMessageId).toBeTruthy()

    // History comes from Redis, not from the browser's copy from before the steer.
    expect(result!.history.map((message: any) => message.id)).toContain('steer_one')
  })

  it('stops rather than running a turn with nothing in front of it', async () => {
    vi.spyOn(redis, 'saveMessage').mockRejectedValueOnce(new Error('redis down'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await promote([steer('steer_one', 'also run the tests')])).toBeNull()
    expect(eventFetch).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalled()
  })

  it('still promotes when the live-update channel is down', async () => {
    eventFetch.mockRejectedValue(new Error('sse down'))
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await promote([steer('steer_one', 'also run the tests')])
    expect(result).not.toBeNull()
    expect((await redis.get(`message:${SESSION}:steer_one`)) as any).toBeTruthy()
    expect(warns).toHaveBeenCalled()
  })
})

/**
 * SA-119 P1 (DL-119-05) — Queue promotes through this exact path.
 *
 * A queued message is a steer the transports were told to skip, so when the reply ends it
 * is simply one of the entries still waiting. That is the whole mechanism: no second
 * writer, no second message shape, and one next user message however many were queued.
 */
describe('promoting queued messages (DL-119-05)', () => {
  it('joins two queued messages and a late steer into ONE next message, in acceptance order', async () => {
    const result = await promote([
      steer('steer_q1', 'also run the tests', { deliver: 'end', at: '2026-09-13T10:00:00.000Z' }),
      steer('steer_q2', 'and push it', { deliver: 'end', at: '2026-09-13T10:00:01.000Z' }),
      steer('steer_late', 'one more thing', { at: '2026-09-13T10:00:02.000Z' })
    ])

    expect(result!.content).toBe('also run the tests\n\nand push it\n\none more thing')

    const saved = (await redis.get(`message:${SESSION}:steer_q1`)) as any
    expect(saved.content).toBe('also run the tests\n\nand push it\n\none more thing')
    expect(saved.metadata.steerPromoted).toEqual({
      steerIds: ['steer_q1', 'steer_q2', 'steer_late']
    })

    // ONE message, under the first id the client already drew a bubble for.
    expect(await redis.get(`message:${SESSION}:steer_q2`)).toBeNull()
    expect(await redis.get(`message:${SESSION}:steer_late`)).toBeNull()
  })

  it('settles every queued bubble on the one promoted event', async () => {
    await promote([
      steer('steer_q1', 'first', { deliver: 'end' }),
      steer('steer_q2', 'second', { deliver: 'end' })
    ])

    expect(sseBodies.map((body) => body.type)).toEqual(['user_message', 'steer_promoted'])
    expect(sseBodies[1]).toMatchObject({ steerIds: ['steer_q1', 'steer_q2'] })
  })

  it('writes a plain user message: the timing was a delivery choice, not part of the words', async () => {
    await promote([steer('steer_q1', 'run it when you are done', { deliver: 'end' })])

    const saved = (await redis.get(`message:${SESSION}:steer_q1`)) as any
    expect(saved.content).toBe('run it when you are done')
    expect(saved.metadata.deliver).toBeUndefined()
    expect(saved.metadata.wake).toBeUndefined()
  })
})
