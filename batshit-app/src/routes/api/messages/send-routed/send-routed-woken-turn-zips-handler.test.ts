// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests, registerWakeRun } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { env } from '$env/dynamic/private'

/**
 * BL-775, condition 5 of the plan: one zip path, the stream path, listener or not. A woken turn
 * runs with no tab watching: `/api/sse` still runs its events through the zip detector (the wake
 * run's headless buffering, AMD-113-01) and answers `success`, and that answer makes send-routed
 * skip its batch zip pass. So the stored reply must carry the stream-made zip's reference, or the
 * zip is left with no reply that names it and the reply keeps the raw block.
 *
 * The real send-routed handler and the real `/api/sse` POST, joined by the event fetch; no tab
 * subscribes. Faked: the compiler's output and the API model, which writes an `<error>` block.
 */

const USER = 'user-bl775-wake'
const AGENT = 'agent-bl775-wake'
const PRESET = 'preset-bl775-wake'
const REPLY = 'msg-reply-bl775-wake'

/**
 * Sealed from any real Redis. The default lane's `$lib/server/redis` is the in-memory fake, but the
 * live hub opens its own clients with `redis.createClient` (the server's external subscriber, and a
 * chat's visual-indicator monitoring). Unstubbed they connected to whatever `REDIS_URL` named, and
 * opening the hub waited for that connection, so the tab test hung until its time limit whenever
 * that Redis was down (a full lane on 2026-09-28 while the native Redis was stopped; reproduced with
 * an unreachable `REDIS_URL`, and gone with this stub). The reply itself never needed it.
 */
vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    isOpen: true,
    isReady: true,
    connect: vi.fn(async () => undefined),
    on: vi.fn(),
    subscribe: vi.fn(async () => undefined),
    pSubscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    pUnsubscribe: vi.fn(async () => undefined),
    publish: vi.fn(async () => 0),
    configSet: vi.fn(async () => 'OK'),
    quit: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined)
  }))
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
    async buildFormattedChatInput() {
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Run it.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

const plan = vi.hoisted(() => ({
  /** Runs after the fake `/api/sse` forwarded a chunk with this text (a tab leaving mid-reply). */
  afterChunk: null as null | { text: string; run: () => Promise<void> }
}))

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const words = ['It failed:\n', '<error>Traceback: boom', ' at line 3</error>', '\nDone.']
      const text = words.join('')
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
        yield { type: 'text-end', id: 't1' }
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
let SSE_POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
let count = 0

/** The event fetch: a forward to `/api/sse` reaches the real route; nothing else is called. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const response = await SSE_POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
  const event = JSON.parse(String(init?.body ?? '{}'))
  if (plan.afterChunk && event.type === 'chunk' && event.content === plan.afterChunk.text) {
    const step = plan.afterChunk
    plan.afterChunk = null
    await step.run()
  }
  return response
})

describe('send-routed + /api/sse: a woken turn with no tab keeps its stream-made zips (BL-775 condition 5)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
    SSE_POST = SSE_ROUTE.POST
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl775-wake-${count}`
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET,
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
    await redis.createSession({ id: SESSION, user_id: USER, title: 'Woken', agent_id: AGENT } as any)
    registerWakeRun({
      sessionId: SESSION,
      agentId: AGENT,
      userId: USER,
      origin: { kind: 'wake' } as any,
      startedAt: Date.now(),
      assistantMessageId: REPLY,
      controller: new AbortController(),
      timer: setTimeout(() => {}, 0)
    } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
  })

  it('stores the reply with the reference of every error zip made for it, and no zip without one', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION,
          agentId: AGENT,
          agentType: 'api',
          content: 'Run it.',
          messageId: REPLY,
          messages: [{ id: 'msg-user-1', role: 'user', content: 'Run it.' }]
        })
      }),
      fetch: eventFetch,
      locals: { user: { id: USER } }
    } as any)
    expect(response.status).toBe(200)

    const zipIds = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
    const zips = await Promise.all(
      zipIds.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any)
    )
    const errorZipsOfReply = zips.filter((zip) => zip?.type === 'error' && zip?.metadata?.messageId === REPLY)
    expect(errorZipsOfReply.length).toBeGreaterThan(0)

    const stored = (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${REPLY}`))) as any
    const referenced = new Set(scanZipReferences(stored.content).map((reference) => reference.id))
    // No raw block left, and every error zip of the reply is named by it and trusted by it.
    expect(stored.content).not.toContain('<error>')
    for (const zip of errorZipsOfReply) {
      expect(referenced.has(zip.id)).toBe(true)
      expect(stored.metadata.zipIds).toContain(zip.id)
    }
    // And every reference it names is a zip that exists.
    for (const id of referenced) {
      expect(zipIds).toContain(id)
    }
  }, 30_000)
})

/**
 * BL-775 (B2): a tab that leaves while a reply streams must not take the reply's stream state with
 * it. The chat's last listener leaving used to clear the zip detector's buffers, so the words of an
 * `<error>` block still open were lost, and the stored reply (the rebuild of the record) lost them.
 * Here a tab watches, leaves right after the block opened, and the reply goes on with no tab.
 */
describe('send-routed + /api/sse: a tab that leaves mid-reply (BL-775 B2)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
    SSE_POST = SSE_ROUTE.POST
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl775-leave-${count}`
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // send-routed's forwards are trusted internal ones, as in the app.
    env.BATSHIT_TOKEN = 'test-internal-token-bl775'
    await redis.set(`model:${PRESET}`, {
      id: PRESET, provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Probe', displayName: 'Probe', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'Left', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (env as any).BATSHIT_TOKEN
    __resetReplyRecordsForTests()
  })

  it('keeps every word of an open error block when the tab leaves inside it', async () => {
    const locals = { user: { id: USER } }
    const hub = await SSE_ROUTE.GET({ url: new URL('http://localhost/api/sse?scope=hub'), locals })
    const reader = hub.body!.getReader()
    const chunk = (await reader.read()).value as unknown
    const first = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array)
    const hubId = JSON.parse(first.slice(first.indexOf('data: ') + 6).split('\n')[0]).hubId
    const patch = (body: Record<string, unknown>) =>
      SSE_ROUTE.PATCH({
        request: new Request('http://localhost/api/sse', { method: 'PATCH', body: JSON.stringify({ hubId, ...body }) }),
        locals
      })
    expect((await patch({ add: [{ id: 'tab', scope: 'session', sessionId: SESSION }] })).status).toBe(200)
    // The tab leaves right after the block opened.
    plan.afterChunk = { text: '<error>Traceback: boom', run: async () => { await patch({ remove: ['tab'] }) } }

    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION, agentId: AGENT, agentType: 'api', content: 'Run it.', messageId: REPLY,
          messages: [{ id: 'msg-user-1', role: 'user', content: 'Run it.' }]
        })
      }),
      fetch: eventFetch,
      locals
    } as any)
    expect(response.status).toBe(200)
    await reader.cancel()

    const stored = (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${REPLY}`))) as any
    expect(stored.metadata.replySavedFromOwnCopy).toBeUndefined()
    expect(stored.content.startsWith('It failed:')).toBe(true)
    expect(stored.content.endsWith('Done.')).toBe(true)
    expect(stored.content).not.toContain('<error>')
    const [reference] = scanZipReferences(stored.content)
    const zip = (await redis.execute((client: any) => client.json.get(`zip:${reference.id}`))) as any
    expect(zip.type).toBe('error')
    expect(zip.content).toContain('Traceback: boom at line 3')
  }, 30_000)
})

