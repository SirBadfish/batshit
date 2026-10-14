// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  __resetStreamAbortRegistryForTests,
  getActiveSessionTurn,
  getQueueCardHold,
  isUserMessageQueued,
  QUEUE_CARD_HOLD_LIMIT_MS
} from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetTurnOutcomesForTests, watchTurnOutcome, type TurnOutcome } from '$lib/server/services/turnOutcomeRegistry'

/**
 * BL-713 — a message that waits in the chat's line, through the real handler, when the reply it
 * waits behind stops at an approval card.
 *
 * The page used to hold a message with a Clip or an `@file` in the tab until the reply ended; a
 * reload or a closed tab lost it. Now the page saves it and posts it at once, and it waits in
 * the chat's line (BL-4). A reply that stops at an approval card has not ended (BL-455): the line
 * holds, so no turn runs beside the card, until the user's own click (its reply goes first),
 * a new message, Send now, or the bound.
 *
 * Faked, and only these: the compiler's OUTPUT (it records the current message each compile was
 * given) and the API lane's model (`VercelAIBrain`: per run, a plain reply or a reply that stops at
 * an approval card; a run can post the user's next message while it runs, as a second tab or the
 * page's own queued send does). Everything between is the handler's own code on the Redis fake.
 */

const USER = 'user-bl713'
const AGENT = 'agent-bl713'
const PRESET = 'preset-bl713'
const FIRST_REPLY = 'msg-first-reply'
const B = 'msg-b'
const B_REPLY = 'msg-b-reply'

type ModelRun = 'reply' | 'card'

const mocks = vi.hoisted(() => ({
  /** What each model run does, by run number (1-based); the rest reply. */
  modelRuns: new Map<number, 'reply' | 'card'>(),
  /** Work the user does while a run runs (by run number), awaited before the run finishes. */
  duringRun: new Map<number, () => Promise<void>>(),
  /** The assistant message id of every model run, in order. */
  brainRuns: [] as string[],
  /** The current message every compile was given, in order. */
  compiledCurrent: [] as unknown[]
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => {}) }
})

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: { cleanupExecutionSandboxesForSession: vi.fn(async () => []) }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput(_sessionId: string, _history: unknown, _agent: unknown, current: unknown) {
      mocks.compiledCurrent.push(current)
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Hello from the compile.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      mocks.brainRuns.push(request.messageId)
      const run = mocks.brainRuns.length
      const plan: ModelRun = mocks.modelRuns.get(run) ?? 'reply'
      const during = mocks.duringRun.get(run)
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      if (plan === 'card') {
        const callId = `call_ls_${run}`
        const approvalId = `aitxt-bl713-${run}`
        const parts = [
          { type: 'tool-call', toolCallId: callId, toolName: 'native_bash_execute', input: { command: 'ls' } },
          { type: 'tool-approval-request', approvalId, toolCallId: callId }
        ]
        async function* paused() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'I need to list the folder.' }
          yield { type: 'text-end', id: 't1' }
          if (during) await during()
          yield { type: 'tool-approval-request', approvalId, toolCallId: callId, toolName: 'native_bash_execute', input: { command: 'ls' } }
          yield { type: 'finish-step', finishReason: 'tool-calls', usage, response: {} }
          await request.onFinish?.({
            text: 'I need to list the folder.',
            steps: [],
            totalUsage: usage,
            usage,
            reasoning: [],
            responseMessages: [{ role: 'assistant', content: parts }]
          })
          yield { type: 'finish', finishReason: 'tool-calls', totalUsage: usage }
        }
        return {
          stream: paused(),
          content: Promise.resolve(parts),
          steps: Promise.resolve([]),
          response: Promise.resolve({ messages: [{ role: 'assistant', content: parts }] })
        }
      }
      const text = `Reply for ${request.messageId}.`
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        if (during) await during()
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0
let forwards: Array<Record<string, any>> = []
/** Every request a test started, until it has finished (its final answer, when answered early). */
let requests: Promise<unknown>[] = []

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, limitMs = 5_000) {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (check()) return true
    await tick(25)
  }
  return check()
}

function request(body: Record<string, unknown>, options: { respondAsync?: boolean } = {}) {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.respondAsync ? { prefer: 'respond-async' } : {})
      },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', ...body })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

/** The page's own message, saved before it posts (the page's `saveMessage`). */
async function saveUserMessage(id: string, content: string, metadata: Record<string, unknown> = {}) {
  const record = {
    id,
    session_id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    role: 'user',
    status: 'complete',
    content,
    created_at: new Date().toISOString(),
    metadata: { client_sent: true, ...metadata }
  }
  await redis.saveMessage(record as any)
  return record
}

/** The first send: its reply is the one the later messages wait behind. */
async function sendFirst() {
  const question = await saveUserMessage('msg-user-1', 'List the folder.')
  return request({ content: 'List the folder.', messageId: FIRST_REPLY, userMessageId: 'msg-user-1', messages: [question] })
}

type Sent = { accepted: Response; outcome: Promise<TurnOutcome> }

/**
 * The page's send of a message while the chat is busy: saved first, then posted at once with
 * `userMessageId` (respond-async). Its final answer comes over the turn's outcome.
 */
async function sendWhileBusy(id: string, content: string, extra: Record<string, unknown> = {}): Promise<Sent> {
  const saved = await saveUserMessage(id, content, { clipIds: ['clip_20260928_bl713'] })
  const accepted = await request(
    {
      content,
      messageId: `${id}-reply`,
      userMessageId: id,
      messages: [{ id: 'msg-user-1', role: 'user', content: 'List the folder.' }, saved],
      metadata: { clipIds: ['clip_20260928_bl713'], fileReferences: [{ path: '/work/probe/notes.md', status: 'ok' }] },
      ...extra
    },
    { respondAsync: true }
  )
  const outcome =
    accepted.status === 202 && accepted.headers.get('preference-applied')
      ? accepted
          .clone()
          .json()
          .then(({ turnId }: { turnId: string }) => new Promise<TurnOutcome>((resolve) => watchTurnOutcome(turnId, USER, resolve)))
      : Promise.resolve({ status: accepted.status, contentType: 'application/json', body: await accepted.clone().text() })
  requests.push(outcome.catch(() => {}))
  return { accepted, outcome }
}

/** The stored card on the first reply, as the page shows it. */
async function storedCard() {
  const card = (await redis.getMessages(SESSION)).find((message: any) => message.id === FIRST_REPLY) as any
  const pending = card?.metadata?.toolApprovals?.approvals?.find((entry: any) => entry.status === 'pending')
  if (!card || !pending) throw new Error('expected a pending card on the first reply')
  return { card, approvalId: pending.approvalId as string }
}

/** The page's Approve (or its own expiry Deny) on the card. */
async function click(options: { approved?: boolean; reason?: string } = {}) {
  const { card, approvalId } = await storedCard()
  return request({
    content: '',
    messageId: FIRST_REPLY,
    messages: [{ id: 'msg-user-1', role: 'user', content: 'List the folder.' }, card],
    metadata: {
      ...card.metadata,
      toolApprovalMode: 'all',
      toolApprovalResponse: [
        {
          type: 'tool-approval-response',
          approvalId,
          approved: options.approved ?? true,
          reason: options.reason ?? (options.approved === false ? 'User denied' : 'User approved')
        }
      ]
    }
  })
}

async function chatIds() {
  return ((await redis.getMessages(SESSION)) as any[]).map((message) => message.id)
}

/** The first reply stops at a card while B waits in the line. */
async function replyStopsAtCardWithBWaiting() {
  let sentB: Sent | null = null
  mocks.modelRuns.set(1, 'card')
  mocks.duringRun.set(1, async () => {
    sentB = await sendWhileBusy(B, 'And summarise the file I attached.')
  })
  const first = await sendFirst()
  expect(first.status).toBe(200)
  if (!sentB) throw new Error('expected B to have been sent during the first reply')
  const b = sentB as Sent
  expect(b.accepted.status).toBe(202)
  return b
}

describe('send-routed: a message waiting in the chat’s line at an approval card (BL-713, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl713-${count}`
    mocks.modelRuns.clear()
    mocks.duringRun.clear()
    mocks.brainRuns = []
    mocks.compiledCurrent = []
    forwards = []
    requests = []
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetTurnOutcomesForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body ?? '{}'))
          if (body && typeof body.type === 'string') forwards.push(body)
        } catch {
          // not a JSON forward
        }
        return new Response('{}', { status: 200 })
      })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET,
      name: 'Test model',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      contextWindow: 200_000,
      capabilities: {},
      settings: {}
    })
    await redis.createAgent({
      id: AGENT,
      user_id: USER,
      name: 'Probe',
      displayName: 'Probe',
      agentType: 'api',
      primary_model_preset_id: PRESET,
      tool_approval_mode: 'all'
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-713', agent_id: AGENT } as any)
  })

  afterEach(async () => {
    __resetStreamAbortRegistryForTests()
    await Promise.race([Promise.allSettled(requests), tick(5_000)])
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetTurnOutcomesForTests()
  }, 15_000)

  it('control: a reply that ends with no card hands the chat to the waiting message, which runs as itself', async () => {
    let sentB: Sent | null = null
    mocks.duringRun.set(1, async () => {
      sentB = await sendWhileBusy(B, 'And summarise the file I attached.')
    })
    expect((await sendFirst()).status).toBe(200)
    const final = await (sentB as unknown as Sent).outcome
    expect(final.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, B_REPLY])
    expect(mocks.compiledCurrent.at(-1)).toBe('And summarise the file I attached.')
    expect(await chatIds()).toEqual(['msg-user-1', FIRST_REPLY, B, B_REPLY])
  }, 30_000)

  it('the reply stops at a card: the waiting message runs no turn beside it, and every tab is told it waits for the card', async () => {
    const b = await replyStopsAtCardWithBWaiting()

    // No turn beside the card, however long it waits.
    expect(await waitUntil(() => mocks.brainRuns.length > 1, 1_500)).toBe(false)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    expect(isUserMessageQueued(SESSION, B)).toBe(true)
    expect(getQueueCardHold(SESSION)?.messageId).toBe(FIRST_REPLY)
    expect(forwards.filter((body) => body.type === 'queued_send_hold')).toEqual([
      { type: 'queued_send_hold', sessionId: SESSION, heldForApprovalCard: { messageId: FIRST_REPLY } }
    ])

    // The user's click goes first: the resume runs into the card's message, then B, as itself.
    const resumed = await click()
    expect(resumed.status).toBe(200)
    const final = await b.outcome
    expect(final.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY, B_REPLY])
    expect(mocks.compiledCurrent.at(-1)).toBe('And summarise the file I attached.')
    expect(await chatIds()).toEqual(['msg-user-1', FIRST_REPLY, B, B_REPLY])
    // The click's registration told every tab the hold ended, before B's message came back.
    const holdEvents = forwards.filter((body) => body.type === 'queued_send_hold')
    expect(holdEvents.at(-1)).toMatchObject({ heldForApprovalCard: null })
    const holdEnd = forwards.indexOf(holdEvents.at(-1) as Record<string, any>)
    const bBack = forwards.findIndex((body) => body.type === 'user_message' && body.message?.id === B)
    expect(bBack).toBeGreaterThan(holdEnd)
  }, 30_000)

  it('a new message while the line holds ends the hold: the waiting message runs first, then the new one', async () => {
    const b = await replyStopsAtCardWithBWaiting()
    expect(await waitUntil(() => mocks.brainRuns.length > 1, 500)).toBe(false)

    const c = await sendWhileBusy('msg-c', 'Actually, skip the card.')
    expect(c.accepted.status).toBe(202)
    expect((await b.outcome).status).toBe(200)
    expect((await c.outcome).status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, B_REPLY, 'msg-c-reply'])
    expect(await chatIds()).toEqual(['msg-user-1', FIRST_REPLY, B, B_REPLY, 'msg-c', 'msg-c-reply'])
  }, 30_000)

  it('Send now on the waiting message adds no second entry: it runs once, and a second press does nothing', async () => {
    const b = await replyStopsAtCardWithBWaiting()
    expect(await waitUntil(() => mocks.brainRuns.length > 1, 500)).toBe(false)

    const now = await request(
      { content: 'And summarise the file I attached.', userMessageId: B, waitingSendNow: true, messages: [] },
      { respondAsync: true }
    )
    expect(now.status).toBe(202)
    expect(await now.json()).toMatchObject({ queuedSend: { userMessageId: B, waiting: true } })
    expect((await b.outcome).status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, B_REPLY])

    const again = await request(
      { content: 'And summarise the file I attached.', userMessageId: B, waitingSendNow: true, messages: [] },
      { respondAsync: true }
    )
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: 'queued_send_not_waiting' })
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, B_REPLY])
    expect((await chatIds()).filter((id) => id === B)).toHaveLength(1)
  }, 30_000)

  it('the page’s own Deny of the expired card keeps the waiting message: unanswered, at the end, with its receipt', async () => {
    const b = await replyStopsAtCardWithBWaiting()
    const denied = await click({ approved: false, reason: 'Approval expired after 3 minutes' })
    expect(denied.status).toBe(200)

    const final = await b.outcome
    expect(final.status).toBe(409)
    expect(JSON.parse(final.body)).toMatchObject({ code: 'queued_send_kept', reason: 'approval_expired' })
    // The resume ended the card; nothing answered B.
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY])
    expect((await chatIds()).at(-1)).toBe(B)
    // Its receipt reaches every tab before its words come back at the end of the chat.
    const dropped = forwards.findIndex(
      (body) => body.type === 'queued_send_dropped' && body.reason === 'approval_expired'
    )
    const back = forwards.findIndex((body) => body.type === 'user_message' && body.message?.id === B)
    expect(forwards[dropped]).toMatchObject({ userMessageIds: [B] })
    expect(back).toBeGreaterThan(dropped)
  }, 30_000)

  it('Send now works for a message whose bubble shows no words (a Clip alone): the server needs only its id (review)', async () => {
    const b = await replyStopsAtCardWithBWaiting()
    expect(await waitUntil(() => mocks.brainRuns.length > 1, 300)).toBe(false)

    const now = await request({ content: '', userMessageId: B, waitingSendNow: true, messages: [] }, { respondAsync: true })
    expect(now.status).toBe(202)
    expect((await b.outcome).status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, B_REPLY])
  }, 30_000)

  it('a refused click puts the hold back and tells every tab so (review)', async () => {
    const b = await replyStopsAtCardWithBWaiting()
    // The click's answer cannot be recorded: it is refused, and the card still waits.
    const updateMessage = vi.mocked(redis.updateMessage)
    const fakeUpdate = updateMessage.getMockImplementation()
    if (!fakeUpdate) throw new Error('expected the Redis fake to implement updateMessage')
    vi.spyOn(redis, 'updateMessage').mockImplementation(async () => {
      throw new Error('Redis connection lost')
    })
    const refused = await click()
    vi.spyOn(redis, 'updateMessage').mockImplementation(fakeUpdate)
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ code: 'approval_record_failed' })

    expect(getQueueCardHold(SESSION)?.messageId).toBe(FIRST_REPLY)
    const holdEvents = forwards.filter((body) => body.type === 'queued_send_hold').map((body) => body.heldForApprovalCard)
    expect(holdEvents).toEqual([{ messageId: FIRST_REPLY }, null, { messageId: FIRST_REPLY }])
    expect(await waitUntil(() => mocks.brainRuns.length > 1, 500)).toBe(false)
    expect(isUserMessageQueued(SESSION, B)).toBe(true)
    void b
  }, 30_000)

  it('a click on a chat deleted meanwhile tells the tabs nothing: the re-read under the lock comes first', async () => {
    await replyStopsAtCardWithBWaiting()
    const holdEventsBefore = forwards.filter((body) => body.type === 'queued_send_hold').length
    // The chat is still there when the click arrives and gone at its re-read under the lock (a
    // delete that swept it while the click waited).
    // The fake's `getSession` is itself a mock: keep its own implementation for the other reads.
    const fakeGetSession = vi.mocked(redis.getSession).getMockImplementation()
    if (!fakeGetSession) throw new Error('expected the Redis fake to implement getSession')
    let readsUnderTheClick = 0
    vi.spyOn(redis, 'getSession').mockImplementation(async (id: string) => {
      if (getActiveSessionTurn(SESSION)?.answersApproval !== true) return fakeGetSession(id)
      readsUnderTheClick += 1
      return null
    })

    const answer = await click()
    expect(answer.status).toBe(404)
    expect(await answer.json()).toMatchObject({ code: 'session_deleted' })
    expect(readsUnderTheClick).toBeGreaterThanOrEqual(1)
    expect(forwards.filter((body) => body.type === 'queued_send_hold')).toHaveLength(holdEventsBefore)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
  }, 30_000)

  it('the bound: a card nobody answers keeps the waiting message after the limit, unanswered', async () => {
    const b = await replyStopsAtCardWithBWaiting()
    const realNow = Date.now.bind(Date)
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + QUEUE_CARD_HOLD_LIMIT_MS + 1)
    const final = await b.outcome
    later.mockRestore()

    expect(final.status).toBe(409)
    expect(JSON.parse(final.body)).toMatchObject({ code: 'queued_send_kept', reason: 'approval_wait' })
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    expect((await chatIds()).at(-1)).toBe(B)
    expect(forwards.some((body) => body.type === 'queued_send_dropped' && body.reason === 'approval_wait')).toBe(true)
  }, 30_000)
})
