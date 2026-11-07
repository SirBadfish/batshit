// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  __resetStreamAbortRegistryForTests,
  countQueuedSessionTurns,
  getActiveSessionTurn,
  isUserMessageQueued
} from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetTurnOutcomesForTests } from '$lib/server/services/turnOutcomeRegistry'

/**
 * BL-903 (e) — the two empty sends the route refuses, through the real handler.
 *
 * - An empty send that is not Send now (no words, no approval answer) is refused 400 before
 *   anything else, the line included: nothing waits, nothing runs, nothing is saved.
 * - Send now names a message waiting in the chat's line by its id and needs no words of its own
 *   (a Clip alone shows none, BL-713). Pressed for a message that is no longer waiting (it already
 *   went, or Batshit restarted and its line is gone), the empty Send now is refused 409
 *   `queued_send_not_waiting`, and it must never run the message again or queue it a second time.
 *
 * Faked, and only these: the compiler's OUTPUT and the API lane's model (`VercelAIBrain`: a plain
 * reply; a run can do the user's next move while it runs). Everything between is the handler's own
 * code on the Redis lane the run selects.
 */

const USER = 'user-bl903e'
const AGENT = 'agent-bl903e'
const PRESET = 'preset-bl903e'
const FIRST_REPLY = 'msg-first-reply'
const B = 'msg-b'
const B_REPLY = 'msg-b-reply'

const mocks = vi.hoisted(() => ({
  /** Work the user does while a run runs (by run number), awaited before the run finishes. */
  duringRun: new Map<number, () => Promise<void>>(),
  /** The assistant message id of every model run, in order. */
  brainRuns: [] as string[]
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
    async buildFormattedChatInput() {
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
      const during = mocks.duringRun.get(mocks.brainRuns.length)
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
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
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0
let forwards: Array<Record<string, any>> = []

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
async function saveUserMessage(id: string, content: string) {
  const record = {
    id,
    session_id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    role: 'user',
    status: 'complete',
    content,
    created_at: new Date().toISOString(),
    metadata: { client_sent: true }
  }
  await redis.saveMessage(record as any)
  return record
}

async function chatIds() {
  return ((await redis.getMessages(SESSION)) as any[]).map((message) => message.id)
}

/** The empty Send now the page posts for a waiting bubble (`sendWaitingSendNow` in `+page.svelte`). */
function emptySendNow(userMessageId: string) {
  return request({ content: '', userMessageId, waitingSendNow: true, messages: [] }, { respondAsync: true })
}

describe('send-routed: the empty sends it refuses (BL-903 e, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl903e-${count}`
    mocks.duringRun.clear()
    mocks.brainRuns = []
    forwards = []
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
      primary_model_preset_id: PRESET
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-903 e', agent_id: AGENT } as any)
  })

  afterEach(() => {
    __resetStreamAbortRegistryForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetTurnOutcomesForTests()
  })

  it('an empty send that is not Send now is refused 400: nothing waits, nothing runs, nothing is saved', async () => {
    const response = await request(
      { content: '', messageId: B_REPLY, userMessageId: B, messages: [] },
      { respondAsync: true }
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Missing required fields') })
    expect(mocks.brainRuns).toEqual([])
    expect(getActiveSessionTurn(SESSION)).toBeNull()
    expect(countQueuedSessionTurns(SESSION)).toBe(0)
    expect(await chatIds()).toEqual([])
    expect(forwards).toEqual([])
  }, 30_000)

  it('the same while a reply runs: refused 400 before the line, and the reply goes on alone', async () => {
    let busyAnswer: Response | null = null
    let queuedDuringRun = -1
    mocks.duringRun.set(1, async () => {
      await saveUserMessage(B, '')
      busyAnswer = await request(
        { content: '', messageId: B_REPLY, userMessageId: B, messages: [] },
        { respondAsync: true }
      )
      queuedDuringRun = countQueuedSessionTurns(SESSION)
    })
    const question = await saveUserMessage('msg-user-1', 'Hello.')
    const first = await request({ content: 'Hello.', messageId: FIRST_REPLY, userMessageId: 'msg-user-1', messages: [question] })

    expect(first.status).toBe(200)
    expect((busyAnswer as Response | null)?.status).toBe(400)
    expect(queuedDuringRun).toBe(0)
    expect(isUserMessageQueued(SESSION, B)).toBe(false)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    expect(forwards.some((body) => body.type === 'steer_queued' && body.steerId === B)).toBe(false)
  }, 30_000)

  it('an empty Send now of a message that already went is refused 409 and never runs it again', async () => {
    const saved = await saveUserMessage(B, 'Second question.')
    const ran = await request({ content: 'Second question.', messageId: B_REPLY, userMessageId: B, messages: [saved] })
    expect(ran.status).toBe(200)
    expect(mocks.brainRuns).toEqual([B_REPLY])
    const before = await chatIds()
    expect(before).toEqual([B, B_REPLY])
    forwards = []

    const now = await emptySendNow(B)

    expect(now.status).toBe(409)
    expect(await now.json()).toMatchObject({ code: 'queued_send_not_waiting' })
    expect(mocks.brainRuns).toEqual([B_REPLY])
    expect(await chatIds()).toEqual(before)
    expect(getActiveSessionTurn(SESSION)).toBeNull()
    expect(isUserMessageQueued(SESSION, B)).toBe(false)
    // No tab is told it waits again (no Queued bubble, no hold change).
    expect(forwards.filter((body) => body.type === 'steer_queued' || body.type === 'queued_send_hold')).toEqual([])
  }, 30_000)

  it('an empty Send now after Batshit restarted (its line is gone) is refused 409 and queues nothing', async () => {
    await saveUserMessage(B, 'Words that waited before the restart.')

    const now = await emptySendNow(B)

    expect(now.status).toBe(409)
    expect(await now.json()).toMatchObject({ code: 'queued_send_not_waiting' })
    expect(mocks.brainRuns).toEqual([])
    expect(countQueuedSessionTurns(SESSION)).toBe(0)
    expect(getActiveSessionTurn(SESSION)).toBeNull()
    expect(await chatIds()).toEqual([B])
    expect(forwards).toEqual([])
  }, 30_000)
})
