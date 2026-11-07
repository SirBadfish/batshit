// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { redisStreamService } from '$lib/server/redisStreamService'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import {
  REPLY_EVENT_FORWARD_LIMIT,
  __resetReplyRecordsForTests,
  isReplyClosed,
  replyZipDetection
} from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { env } from '$env/dynamic/private'

/**
 * BL-871 (c) through the real send-routed handler and the real `/api/sse` POST, joined by the event
 * fetch: a chunk forward that gets stuck INSIDE its zip detection, in a reply that becomes a gap.
 *
 * The chunk that closes an `<error>` block passes the route's late checks and waits inside the zip
 * detector's Redis work. Its forward passes the time limit, so the reply is a gap: the finalize saves
 * its own copy (with its own batch zip pass) and sweeps the stream-made zips it can find. The stuck
 * detection then finishes and writes its Error zip, which no saved reply names (it was listed in the
 * Zip Manager and taken into every backup), and puts the zip back into the detector's list for a
 * reply already saved. Now the route sees the close right after the detection, drops that call's new
 * zips from the list, and removes the ones no message names.
 *
 * Faked: the compiler's output and the model.
 */

const USER = 'user-bl871c'
const AGENT = 'agent-bl871c'
const PRESET = 'preset-bl871c'
const REPLY = 'msg-reply-bl871c'
const SERVICE_TOKEN = 'test-internal-token-bl871c'
const CLOSING_CHUNK = ' at line 3</error>'

const mocks = vi.hoisted(() => ({
  /** The route's answers still running when the send returned (the stuck forward among them). */
  pending: [] as Array<Promise<Response>>
}))

// Physical monitoring and subscribers are isolated by the opt-in handler fixture.


vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: {
    cleanupExecutionSandboxesForSession: vi.fn(async () => [])
  }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput() {
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Answer me.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const words = ['It failed:\n', '<error>Traceback: boom', CLOSING_CHUNK, '\nDone.']
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
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

const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined
let previousLimit = 0
let POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

/** The event fetch: a forward to `/api/sse` reaches the real route; nothing else is called. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const answer: Promise<Response> = SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
  mocks.pending.push(answer)
  return answer
})

function send(): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'Answer me.',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'Answer me.' }]
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

async function zipsOfReply() {
  const ids = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
  const zips = await Promise.all(ids.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
  return zips.filter((zip) => zip?.metadata?.messageId === REPLY)
}

describe('send-routed + /api/sse: a chunk stuck in its zip detection past the save (BL-871 c, the real handlers)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl871c-${count}`
    mocks.pending = []
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    previousLimit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = 50
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Lark', displayName: 'Lark', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-871 c', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    REPLY_EVENT_FORWARD_LIMIT.ms = previousLimit
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('leaves no zip without a saved reference, and no detector reference, once the stuck detection finishes', async () => {
    // The stream path's zip detection of the closing chunk waits here, inside its Redis work, until
    // the reply has been saved.
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const track = redisStreamService.trackConcurrentBlock.bind(redisStreamService)
    let stalled = false
    vi.spyOn(redisStreamService, 'trackConcurrentBlock').mockImplementation(async (sessionId, messageId, type) => {
      if (!stalled && messageId === REPLY) {
        stalled = true
        await released
      }
      return track(sessionId, messageId, type)
    })

    expect((await send()).status).toBe(200)
    expect(stalled).toBe(true)
    const saved = await stored(REPLY)
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(isReplyClosed(SESSION, REPLY)).toBe(true)

    // The stuck detection finishes after the save, and its forward's answer comes back.
    release()
    await Promise.all(mocks.pending)

    const referenced = new Set(scanZipReferences(saved.content).map((reference) => reference.id))
    const zips = await zipsOfReply()
    expect(zips.length).toBeGreaterThan(0)
    for (const zip of zips) expect(referenced.has(zip.id)).toBe(true)
    expect(replyZipDetection.getMessageReferences(SESSION, REPLY)).toEqual([])
    // The saved reply is untouched.
    expect(await stored(REPLY)).toEqual(saved)
  }, 30_000)
})
