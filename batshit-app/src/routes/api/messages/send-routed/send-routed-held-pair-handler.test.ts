// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests, replyZipDetection } from '$lib/server/services/replyStreamRecord'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { env } from '$env/dynamic/private'

/**
 * BL-779 (a) through the real send-routed handler and the real `/api/sse` POST, joined by the event
 * fetch. The stream path holds a closed `<error>` pair whose opening tag follows a stray backtick
 * (a later backtick may still make it code); the finalize's flush settles it before the reply is
 * closed (BL-775 order), so a watched reply saves what the full-reply pass saves: words when it was
 * code, a zip its saved reply names when it was not. A gap reply (saved from its own copy) leaves no
 * zip that no message names.
 *
 * Faked: the compiler's output and the model, which writes `plan.words`.
 */

const USER = 'user-bl779'
const AGENT = 'agent-bl779'
const PRESET = 'preset-bl779'
const REPLY = 'msg-reply-bl779'
const SERVICE_TOKEN = 'test-internal-token-bl779'

const plan = vi.hoisted(() => ({
  words: [] as string[],
  /** A chunk forward with this text is answered without success and never reaches the route (a gap). */
  dropChunk: null as string | null
}))

/** Sealed from any real Redis (see `send-routed-woken-turn-zips-handler.test.ts`). */


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
      const words = [...plan.words]
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
let POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

/** The event fetch: a forward to `/api/sse` reaches the real route, except a dropped chunk. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  if (plan.dropChunk !== null && event.type === 'chunk' && event.content === plan.dropChunk) {
    return new Response(JSON.stringify({ success: false, message: 'dropped by the test' }), { status: 200 })
  }
  return SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
})

async function send(words: string[]) {
  plan.words = words
  const response = await POST({
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
  expect(response.status).toBe(200)
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${REPLY}`))) as any
}

async function errorZipsOfReply() {
  const ids = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
  const zips = await Promise.all(ids.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
  return zips.filter((zip) => zip?.type === 'error' && zip?.metadata?.messageId === REPLY)
}

/** The full-reply pass's reading of the same words: a zip reference becomes `⟦its words⟧`. */
async function fullPassWords(text: string) {
  const processed = await new ZipDetectionService().processFullContent(`${SESSION}-full`, 'm', text)
  const contents = new Map<string, string>()
  for (const ref of processed.references) {
    const zip = (await redis.execute((client: any) => client.json.get(`zip:${ref.zipId}`))) as any
    contents.set(ref.zipId, zip?.content ?? '')
  }
  return wordsOf(processed.content, contents)
}

function wordsOf(content: string, contents: Map<string, string>) {
  let out = ''
  let from = 0
  for (const ref of scanZipReferences(content)) {
    out += `${content.slice(from, ref.start)}⟦${contents.get(ref.id) ?? '?'}⟧`
    from = ref.end
  }
  return out + content.slice(from)
}

describe('send-routed + /api/sse: a pair held after a stray backtick is saved as the full pass reads it (BL-779 a)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl779-${count}`
    plan.dropChunk = null
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Wren', displayName: 'Wren', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-779', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('saves words, and makes no zip, when a later backtick shows the pair was code', async () => {
    const words = ['Use `<error>boom</error>', ' and `x` later.']

    const stored = await send(words)

    expect(stored.metadata.replySavedFromOwnCopy).toBeUndefined()
    expect(stored.content).toBe(words.join(''))
    expect(stored.content).toBe(await fullPassWords(words.join('')))
    expect(await errorZipsOfReply()).toEqual([])
  }, 30_000)

  it('zips the held pair at the reply end and saves the reply naming it, recorded before the close', async () => {
    const words = ['Use `<error>boom</error>', ' and more.']

    const stored = await send(words)

    expect(stored.metadata.replySavedFromOwnCopy).toBeUndefined()
    const zips = await errorZipsOfReply()
    expect(zips.map((zip) => zip.content)).toEqual(['boom'])
    expect(scanZipReferences(stored.content).map((ref) => ref.id)).toEqual([zips[0].id])
    expect(stored.metadata.zipIds).toContain(zips[0].id)
    expect(wordsOf(stored.content, new Map([[zips[0].id, 'boom']]))).toBe(await fullPassWords(words.join('')))
    expect(replyZipDetection.getMessageReferences(SESSION, REPLY)).toEqual([])
  }, 30_000)

  it('leaves no zip that no message names when the reply is a gap, saved from its own copy', async () => {
    plan.dropChunk = ' and more.'

    const stored = await send(['Use `<error>boom</error>', ' and more.'])

    expect(stored.metadata.replySavedFromOwnCopy).toBe(true)
    const referenced = new Set(scanZipReferences(stored.content).map((ref) => ref.id))
    const zips = await errorZipsOfReply()
    expect(zips).toHaveLength(1)
    for (const zip of zips) expect(referenced.has(zip.id)).toBe(true)
  }, 30_000)
})
