import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  followUpTurnMetadata,
  markHeldMessageCardExpired,
  markHeldMessageUnanswered,
  holdSteersForApprovalCard,
  readHeldSteerIds,
  readHeldSteerIdsForHistory,
  markApprovalCardWithoutAnswer,
  saveSteersWithoutAnswer,
  promoteSteersToNextTurn,
  readHeldMessageToAnswer
} from '$lib/server/services/steerPromotion'
import { keepQueuedSendAtEnd } from '$lib/server/services/queuedSendKeeper'
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

describe('followUpTurnMetadata: what a follow-up turn runs with', () => {
  it('keeps the send\u2019s own facts and names the steers it answers', () => {
    expect(
      followUpTurnMetadata(
        { toolApprovalMode: 'all', tts: true, projectPath: '/work', steerPromoted: { steerIds: ['old'] } },
        ['steer_a', 'steer_b']
      )
    ).toEqual({ toolApprovalMode: 'all', tts: true, projectPath: '/work', steerPromoted: { steerIds: ['steer_a', 'steer_b'] } })
  })

  it.each([
    ['wake', { chainDepth: 1 }],
    ['source', 'artifact_share_auto_followup'],
    ['toolApprovalResponse', [{ approvalId: 'a', approved: true }]],
    ['tool_approval_response', [{ approvalId: 'a', approved: true }]],
    ['expiredToolApprovals', [{ approvalId: 'a' }]],
    ['interruption', { previousMessageId: 'm' }],
    ['contextContinuation', { attempt: 1 }]
  ])('drops %s, which belonged to the run before (a promoted message is the user\u2019s words)', (key, value) => {
    const metadata = followUpTurnMetadata({ [key]: value, tts: false }, ['steer_a'])
    expect(metadata).not.toHaveProperty(key)
    expect(metadata).toMatchObject({ tts: false, steerPromoted: { steerIds: ['steer_a'] } })
  })

  it('a request with no metadata still names the steers', () => {
    expect(followUpTurnMetadata(null, ['steer_a'])).toEqual({ steerPromoted: { steerIds: ['steer_a'] } })
  })
})

/**
 * BL-905 — words held for an approval card (BL-455) and a send the chat's line kept at the same
 * card. Every keep (the 15-minute bound, the page's expiry Deny, a restore, a clean stop, Stop)
 * ends in the same keeper, `keepQueuedSendAtEnd`, which moves the kept message to the end of the
 * chat, after the held one. The held words still wait for the card: no reply follows them.
 */
describe('held words with a kept send after them (BL-905)', () => {
  const pendingCard = { mode: 'all', approvals: [{ approvalId: 'ap-1', status: 'pending' }], source: 'vercel' }
  const at = (second: number) => `2026-09-29T03:00:${String(second).padStart(2, '0')}.000Z`
  const message = (id: string, role: 'user' | 'assistant', content: string, second: number, metadata: Record<string, unknown> = {}) => ({
    id,
    session_id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    role,
    content,
    created_at: at(second),
    metadata
  })

  /** q, then the kept send W (saved while the reply ran), the reply with its card, the held words; then the keep. */
  async function seedHeldAndKept() {
    await redis.saveMessage(message('msg-q', 'user', 'run the build', 1) as any)
    await redis.saveMessage(message('msg-w', 'user', 'look at this Clip', 2) as any)
    await redis.saveMessage(message('msg-card', 'assistant', 'May I run it?', 3, { toolApprovals: pendingCard }) as any)
    await redis.saveMessage(
      message('msg-held', 'user', 'and then tidy up', 4, { waitsForApproval: { messageId: 'msg-card' } }) as any
    )
    await keepQueuedSendAtEnd({
      sessionId: SESSION,
      userId: USER,
      userMessageId: 'msg-w',
      entry: { turnId: 999_001 },
      forwardSessionEvent: async () => {}
    })
    const ids = (await redis.getRecentMessages(SESSION, 10)).map((row: any) => row.id)
    expect(ids).toEqual(['msg-q', 'msg-card', 'msg-held', 'msg-w'])
  }

  it('the click answers the held words, over the history up to them; the kept send stays for its own Send now', async () => {
    await seedHeldAndKept()
    const answer = await readHeldMessageToAnswer({ sessionId: SESSION, cardMessageId: 'msg-card' })
    expect(answer).not.toBeNull()
    expect(answer?.content).toBe('and then tidy up')
    expect(answer?.steerIds).toEqual(['msg-held'])
    // Order of typing: the held words came before the kept send, so their turn does not read it.
    expect(answer?.history.map((row) => row.id)).toEqual(['msg-q', 'msg-card', 'msg-held'])
  })

  it('the page’s expiry Deny marks the held words, not the kept send after them', async () => {
    await seedHeldAndKept()
    const marked = await markHeldMessageCardExpired({
      sessionId: SESSION,
      userId: USER,
      cardMessageId: 'msg-card',
      eventFetch: eventFetch as unknown as typeof fetch,
      request
    })
    expect(marked).toBe(true)
    const rows = await redis.getRecentMessages(SESSION, 10)
    expect((rows.find((row: any) => row.id === 'msg-held') as any)?.metadata?.approvalCardExpired).toBe(true)
    expect((rows.find((row: any) => row.id === 'msg-w') as any)?.metadata?.approvalCardExpired).toBeUndefined()
    expect(sseBodies.find((body) => body.type === 'user_message')?.message?.id).toBe('msg-held')
  })

  it('a reply after the kept send (its Send now ran) means that turn read the held words: nothing to answer', async () => {
    await seedHeldAndKept()
    await redis.saveMessage(message('msg-w-reply', 'assistant', 'Nice Clip.', 9) as any)
    expect(await readHeldMessageToAnswer({ sessionId: SESSION, cardMessageId: 'msg-card' })).toBeNull()
    expect(
      await markHeldMessageCardExpired({
        sessionId: SESSION,
        userId: USER,
        cardMessageId: 'msg-card',
        eventFetch: eventFetch as unknown as typeof fetch,
        request
      })
    ).toBe(false)
  })

  it('today’s case stays: held words alone at the end are answered with the whole history', async () => {
    await redis.saveMessage(message('msg-q', 'user', 'run the build', 1) as any)
    await redis.saveMessage(message('msg-card', 'assistant', 'May I run it?', 3, { toolApprovals: pendingCard }) as any)
    await redis.saveMessage(
      message('msg-held', 'user', 'and then tidy up', 4, { waitsForApproval: { messageId: 'msg-card' } }) as any
    )
    const answer = await readHeldMessageToAnswer({ sessionId: SESSION, cardMessageId: 'msg-card' })
    expect(answer?.history.map((row) => row.id)).toEqual(['msg-q', 'msg-card', 'msg-held'])
  })
})


describe('BL-1291 exact no-answer and approval dispositions', () => {
  const params = (steers: SteerEntry[]) => ({ sessionId: SESSION, userId: USER, agentId: AGENT, steers,
    eventFetch: eventFetch as unknown as typeof fetch, request })

  it('the promotion-limit save keeps words and all ids without allocating or scheduling an assistant', async () => {
    const saved = await saveSteersWithoutAnswer(params([steer('limit-a', 'first'), steer('limit-b', 'second')]))
    expect(saved).toMatchObject({ role: 'user', content: 'first\n\nsecond', metadata: {
      steerPromoted: { steerIds: ['limit-a', 'limit-b'], disposition: 'unanswered', reason: 'promotion_limit' } } })
    expect((await redis.getMessages(SESSION)).filter((row: any) => row.role === 'assistant')).toHaveLength(0)
    expect(sseBodies).toHaveLength(2)
    for (const body of sseBodies) expect(body).not.toHaveProperty('messageId') // F22 replay invariant.
    expect(sseBodies[1].metadata.steerPromoted).toEqual(saved?.metadata.steerPromoted)
  })

  it('a failed hold save publishes exact refusal instead of promising an approval answer', async () => {
    vi.spyOn(redis, 'saveMessage').mockRejectedValueOnce(new Error('save refused'))
    expect(await holdSteersForApprovalCard({ ...params([steer('held-failed', 'words')]), cardMessageId: 'card' })).toBeNull()
    expect(sseBodies).toEqual([expect.objectContaining({ type: 'steer_promoted', steerIds: ['held-failed'],
      metadata: { steerPromoted: { steerIds: ['held-failed'], disposition: 'unanswered', reason: 'promotion_failed' } } })])
    expect(sseBodies[0]).not.toHaveProperty('messageId')
  })

  it('all merged and successive words held at one card get that exact answer relation or expiry; another card stays waiting', async () => {
    await redis.saveMessage({ id: 'card', session_id: SESSION, user_id: USER, agent_id: AGENT,
      role: 'assistant', content: 'May I?', created_at: new Date().toISOString(), metadata: {} } as any)
    await holdSteersForApprovalCard({ ...params([steer('held-a', 'one'), steer('held-b', 'two')]), cardMessageId: 'card' })
    await holdSteersForApprovalCard({ ...params([steer('other-card', 'other')]), cardMessageId: 'another-card' })
    await holdSteersForApprovalCard({ ...params([steer('held-c', 'three')]), cardMessageId: 'card' })
    expect(await readHeldSteerIds({ sessionId: SESSION, cardMessageId: 'card' })).toEqual(['held-a', 'held-b', 'held-c'])
    expect((await readHeldMessageToAnswer({ sessionId: SESSION, cardMessageId: 'card' }))?.steerIds).toEqual(['held-a', 'held-b', 'held-c'])
    expect(await markHeldMessageCardExpired({ ...params([]), cardMessageId: 'card' })).toBe(true)
    for (const id of ['held-a', 'held-c']) {
      const saved = await redis.get(`message:${SESSION}:${id}`) as any
      expect(saved.metadata).toMatchObject({ approvalCardExpired: true, steerPromoted: { disposition: 'unanswered', reason: 'approval_expired' } })
    }
    expect((await redis.get(`message:${SESSION}:other-card`) as any).metadata.steerPromoted.disposition).toBe('awaiting_approval')
  })

  it.each(['stopped', 'reply_failed'] as const)('a %s resume preserves exact words and unrelated send facts while scheduling no retry', async (reason) => {
    await holdSteersForApprovalCard({ ...params([steer('held', 'keep these words')]), cardMessageId: 'card',
      sendFacts: { tts: true, projectPath: '/owned' } })
    expect(await markHeldMessageUnanswered({ ...params([]), cardMessageId: 'card', reason })).toBe(true)
    const saved = await redis.get(`message:${SESSION}:held`) as any
    expect(saved.metadata).toMatchObject({ tts: true, projectPath: '/owned', waitsForApproval: { messageId: 'card' },
      steerPromoted: { steerIds: ['held'], disposition: 'unanswered', reason } })
    expect(saved.content).toBe('keep these words')
    expect(saved.metadata.approvalCardExpired).toBeUndefined()
  })
})

describe('exact held-history and no-resume boundary (V2)', () => {
  const params = { sessionId: SESSION, userId: USER, agentId: AGENT, eventFetch: eventFetch as typeof fetch, request }
  it('neither binds nor marks an older hold already followed by an assistant', async () => {
    await holdSteersForApprovalCard({ ...params, steers: [steer('older-hold', 'already read')], cardMessageId: 'card' })
    await redis.saveMessage({ id: 'older-answer', session_id: SESSION, user_id: USER, role: 'assistant', content: 'Answered', metadata: {} } as any)
    await holdSteersForApprovalCard({ ...params, steers: [steer('current-hold', 'still waiting')], cardMessageId: 'card' })
    expect(await readHeldSteerIds({ sessionId: SESSION, cardMessageId: 'card' })).toEqual(['current-hold'])
    await markHeldMessageCardExpired({ ...params, cardMessageId: 'card' })
    expect((await redis.get(`message:${SESSION}:older-hold`) as any).metadata.steerPromoted.disposition).toBe('awaiting_approval')
    expect((await redis.get(`message:${SESSION}:current-hold`) as any).metadata.steerPromoted.disposition).toBe('unanswered')
  })
  it('binds only the exact saved words present in the first run history, not stale or absent browser words', async () => {
    await holdSteersForApprovalCard({ ...params, steers: [steer('held-exact', 'exact words')], cardMessageId: 'card' })
    const history = await redis.getRecentMessages(SESSION, 300)
    expect(await readHeldSteerIdsForHistory(SESSION, [])).toEqual([])
    expect(await readHeldSteerIdsForHistory(SESSION, history.map(row => ({ ...row, content: 'forged words' })))).toEqual([])
    expect(await readHeldSteerIdsForHistory(SESSION, history)).toEqual(['held-exact'])
    await redis.saveMessage({ id: 'first-answer', session_id: SESSION, user_id: USER, role: 'assistant', content: 'Answered' } as any)
    expect(await readHeldSteerIdsForHistory(SESSION, history)).toEqual([])
  })
  it('a history failure after promotion preserves a saved no-answer receipt and never supplies empty compile history', async () => {
    vi.spyOn(redis, 'getRecentMessages').mockRejectedValueOnce(new Error('history unavailable'))
    await expect(promote([steer('saved-history-failure', 'retained words')])).rejects.toThrow('history unavailable')
    expect((await redis.get(`message:${SESSION}:saved-history-failure`) as any).metadata.steerPromoted)
      .toMatchObject({ disposition: 'unanswered', reason: 'promotion_failed' })
    expect(sseBodies.at(-1)).toMatchObject({ savedRecord: true })
  })
  it('does not silently erase ownership on a history read failure', async () => {
    vi.spyOn(redis, 'getRecentMessages').mockRejectedValueOnce(new Error('history unavailable'))
    await expect(readHeldSteerIds({ sessionId: SESSION, cardMessageId: 'card' })).rejects.toThrow('history unavailable')
  })
  it.each(['approval_denied', 'approval_expired'] as const)("a recorded no-resume %s marks only the card's server-known user steers, survives reload, and schedules no run", async (reason) => {
    await redis.saveMessage({ id: 'card', session_id: SESSION, user_id: USER, role: 'assistant', status: 'complete',
      content: 'May I?', metadata: { answeredApprovalIds: ['ap'],
        steerPromoted: { steerIds: ['promoted'] }, steers: [{ steerId: 'delivered', source: 'user' }, { steerId: 'dm', source: 'dm' }] } } as any)
    await markApprovalCardWithoutAnswer({ ...params, cardMessageId: 'card', reason })
    expect((await redis.get(`message:${SESSION}:card`) as any).metadata.steerPromoted).toEqual({
      steerIds: ['promoted', 'delivered'], disposition: 'unanswered', reason })
    expect(sseBodies.at(-1)).toMatchObject({ type: 'complete_message', message: { id: 'card', role: 'assistant' } })
    expect((await redis.getRecentMessages(SESSION, 300)).map(row => row.id)).toEqual(['card'])
  })
  it('a saved no-answer promotion settles its original bubble without fabricating a reply id', async () => {
    await saveSteersWithoutAnswer({ ...params, steers: [steer('saved-limit', 'saved words')] })
    expect(sseBodies.at(-1)).toMatchObject({ type: 'steer_promoted', savedRecord: true,
      metadata: { steerPromoted: { disposition: 'unanswered' } } })
    expect(sseBodies.at(-1)).not.toHaveProperty('messageId')
  })
})
