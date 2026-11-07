// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { publishUserEvent } from '$lib/server/ssePublisher'
import {
  REPLY_EVENT_FORWARD_LIMIT,
  REPLY_ORDERED_FORWARD_GIVE_UP,
  __resetReplyRecordsForTests,
  isLateReplyEvent,
  recordReplyEvent,
  startReplyRecord
} from '$lib/server/services/replyStreamRecord'
import type { SavedModel } from '$lib/types/savedModels'

/**
 * BL-871 (d) through the real send-routed handler: a fully stalled `/api/sse`.
 *
 * Before: once a reply was a gap, each later forward still waited its full limit, so a stalled
 * `/api/sse` moved one event per limit (10 s in the app), the model stream was held back to that
 * pace, and a Stop took about three limits (the chain, `end`, `complete`). Now a forward past its
 * limit starts a stall: until it answers, no later forward is waited for. The reply's live events
 * are not sent (the reply is a gap and saves its own copy; `end` brings the tabs the saved text),
 * and `end`, `error`, `complete` go through a tail that sends each only once the one before it
 * answered, so `complete` never overtakes `end`. A forward that answers within its limit is still
 * waited for, in order.
 *
 * The event fetch stands in for `/api/sse` as `send-routed-reply-record-handler.test.ts` does: it
 * records every forwarded event in `replyStreamRecord` and answers `{ success: true }`, or holds
 * every forward unanswered until the test lets the route recover. Faked beside it: the compiler's
 * output and the API model.
 */

const USER = 'user-bl871d'
const AGENT = 'agent-bl871d'
const PRESET = 'preset-bl871d'
const REPLY = 'msg-reply-bl871d'
const LIMIT_MS = 300
const WORDS = Array.from({ length: 12 }, (_, index) => `Part ${index + 1}. `)

const mocks = vi.hoisted(() => ({
  /** `reply`: words and a finish. `stop`: words, then the user's Stop. */
  plan: 'reply' as 'reply' | 'stop',
  forwards: [] as Array<Record<string, any>>,
  /** What the stand-in route saw, in order: `arrive:<type>` and `answer:<type>`. */
  log: [] as string[],
  /** Hold every forward unanswered until the route recovers. */
  stalled: false,
  held: [] as Array<() => void>,
  /** How long the route takes to answer each forward when it is not stalled. */
  answerAfterMs: 0
}))

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: {
    cleanupExecutionSandboxesForSession: vi.fn(async () => [])
  }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput(sessionId: string, _messages: unknown, agent: any, _content: unknown, _assigned: unknown, userId: string, options: any) {
      return {
        primarySystemPrompt: 'You are a test agent.',
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId, sessionId, agentId: agent.id, messageId: options.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'Count to twelve.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const words = [...WORDS]
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
        if (mocks.plan === 'stop') {
          const stop = new Error('Stream interrupted by user')
          stop.name = 'AbortError'
          throw stop
        }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text: words.join(''), steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => {}) }
})

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0
let previousLimit = 0
let previousGiveUp = 0

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

/**
 * `/api/sse` as the plan wires it: records every event of the reply, then answers `success`. While
 * stalled it holds every forward unanswered; like SvelteKit's in-process fetch, a held forward still
 * runs to its end once the route recovers.
 */
async function sseForward(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  mocks.forwards.push(event)
  mocks.log.push(`arrive:${event.type}`)
  if (mocks.stalled) await new Promise<void>((resolve) => mocks.held.push(resolve))
  else if (mocks.answerAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, mocks.answerAfterMs))
  if (isLateReplyEvent(event.sessionId, event)) {
    mocks.log.push(`answer:${event.type}`)
    return new Response(JSON.stringify({ success: false, message: 'The reply was already saved' }), { status: 200 })
  }
  if (event.type === 'start') startReplyRecord(event.sessionId, { ...event })
  else if (event.messageId) recordReplyEvent(event.sessionId, { ...event })
  mocks.log.push(`answer:${event.type}`)
  return new Response(JSON.stringify({ success: true }), { status: 200 })
}

function recover() {
  mocks.stalled = false
  for (const release of mocks.held.splice(0)) release()
}

function send(): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'Count to twelve.',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'Count to twelve.' }]
      })
    }),
    fetch: sseForward,
    locals: { user: { id: USER } }
  } as any)
}

const model = {
  id: PRESET,
  name: 'Test model',
  provider: 'anthropic',
  modelId: 'claude-sonnet-5',
  modelName: 'Claude Sonnet 5',
  contextWindow: 200_000,
  capabilities: {},
  settings: {},
  pricing: { input: 3, output: 15 },
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z'
} as unknown as SavedModel

const forwardsOf = (type: string) => mocks.forwards.filter((event) => event.type === type)

describe('send-routed: a fully stalled /api/sse costs the reply one limit, and end comes before complete (BL-871 d, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl871d-${count}`
    mocks.plan = 'reply'
    mocks.forwards = []
    mocks.log = []
    mocks.stalled = false
    mocks.held = []
    mocks.answerAfterMs = 0
    previousLimit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = LIMIT_MS
    previousGiveUp = REPLY_ORDERED_FORWARD_GIVE_UP.ms
    ;(publishUserEvent as any).mockClear()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, model)
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Probe', displayName: 'Probe', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-871 d', agent_id: AGENT } as any)
  })

  afterEach(async () => {
    recover()
    // Let the forwards the test released finish before the next test resets the record.
    await new Promise((resolve) => setTimeout(resolve, 20))
    vi.restoreAllMocks()
    REPLY_EVENT_FORWARD_LIMIT.ms = previousLimit
    REPLY_ORDERED_FORWARD_GIVE_UP.ms = previousGiveUp
    __resetReplyRecordsForTests()
  })

  it('a reply whose /api/sse never answers costs one limit, sends no live event after it, and still saves every word', async () => {
    mocks.stalled = true
    const started = Date.now()
    expect((await send()).status).toBe(200)
    const elapsed = Date.now() - started

    // One limit for the first forward, then nothing waits (before: about one limit per event,
    // here 12 words and their start, end and complete: about 15 limits).
    expect(elapsed).toBeLessThan(LIMIT_MS * 8)
    const saved = await stored(REPLY)
    expect(saved.content).toBe(WORDS.join('').trim())
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    // After the stalled first forward no live event was sent; `end` was, and `complete` waits for
    // `end`'s answer.
    expect(forwardsOf('chunk')).toHaveLength(0)
    expect(forwardsOf('end')).toHaveLength(1)
    expect(forwardsOf('complete')).toHaveLength(0)
    expect(
      (console.error as any).mock.calls.filter((call: unknown[]) => String(call[0]).includes('live events are not sent')).length
    ).toBe(1)
  }, 30_000)

  it('end, then complete, reach /api/sse in order once it recovers', async () => {
    mocks.stalled = true
    expect((await send()).status).toBe(200)
    expect(forwardsOf('complete')).toHaveLength(0)

    recover()
    await vi.waitFor(() => expect(forwardsOf('complete')).toHaveLength(1), { timeout: 5_000 })
    // `complete` was sent only after `end` was answered.
    expect(mocks.log.indexOf('answer:end')).toBeGreaterThan(-1)
    expect(mocks.log.indexOf('answer:end')).toBeLessThan(mocks.log.indexOf('arrive:complete'))
    expect(forwardsOf('end')[0]?.savedRecord).toBe(true)
  }, 30_000)

  it('a Stop while /api/sse never answers finishes within about one limit plus the save', async () => {
    mocks.plan = 'stop'
    mocks.stalled = true
    const started = Date.now()
    await send()
    const elapsed = Date.now() - started

    // Before: the chain's forward, then `end`, then `complete`, each its full limit, behind a limit
    // per word (about 15 limits).
    expect(elapsed).toBeLessThan(LIMIT_MS * 8)
    const saved = await stored(REPLY)
    expect(saved?.metadata?.interrupted).toBe(true)
    expect(saved?.content).toBe(WORDS.join('').trim())

    recover()
    await vi.waitFor(() => expect(forwardsOf('complete')).toHaveLength(1), { timeout: 5_000 })
    expect(mocks.log.indexOf('answer:end')).toBeLessThan(mocks.log.indexOf('arrive:complete'))
  }, 30_000)

  // Review S2: when the ordered tail gives up (the event before it never answered), the tabs never
  // get the reply's end, so they would show it running until a reload. The user channel does not
  // go through the `/api/sse` POST: it tells every tab to read the saved reply again, once.
  it('tells the tabs to read the saved reply again when its end can no longer be sent in order', async () => {
    REPLY_ORDERED_FORWARD_GIVE_UP.ms = 400
    mocks.stalled = true
    expect((await send()).status).toBe(200)
    const announced = () =>
      (publishUserEvent as any).mock.calls.filter(
        (call: any[]) => call[1]?.type === 'session_messages_changed' && call[1]?.sessionId === SESSION
      )
    // `end` was sent and never answered; `complete` waits for it, and gives up.
    await vi.waitFor(() => expect(announced()).toHaveLength(1), { timeout: 5_000 })
    expect(announced()[0][0]).toBe(USER)
    expect(announced()[0][1]).toMatchObject({ reason: 'reply_end_not_delivered' })
    expect(forwardsOf('complete')).toHaveLength(0)
    expect((await stored(REPLY))?.metadata?.replySavedFromOwnCopy).toBe(true)
    // Once per reply.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(announced()).toHaveLength(1)
  }, 30_000)

  it('a forward that answers within its limit is still waited for, in order: no gap, every event recorded', async () => {
    mocks.answerAfterMs = 30
    expect((await send()).status).toBe(200)

    // Each forward arrived only after the one before it was answered.
    for (let index = 0; index < mocks.log.length; index += 2) {
      expect(mocks.log[index]).toMatch(/^arrive:/)
      expect(mocks.log[index + 1]).toBe(mocks.log[index].replace('arrive:', 'answer:'))
    }
    expect(forwardsOf('chunk').map((event) => event.content).join('')).toBe(WORDS.join(''))
    const saved = await stored(REPLY)
    expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
    expect(forwardsOf('complete')).toHaveLength(1)
  }, 30_000)
})
