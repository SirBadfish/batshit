// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests, listReplayEvents } from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { env } from '$env/dynamic/private'

/**
 * BL-759 phase 2 through the real send-routed handler and the real `/api/sse` POST, joined by the
 * event fetch: a managed lane takes back a message its vendor never finished and started again.
 *
 * Codex's app-server lane retries a dropped response stream by itself and starts the answer again
 * as a NEW agent message; the dropped one never completes. Its adapter names each text chunk's
 * segment (the message) and, once Codex writes again, hands on a `text-retract` for the segment it
 * dropped (phase 1, `codexEventAdapter.ts`). The fake model here streams those same parts.
 *
 * - send-routed keeps its own copy of the reply by segment and takes the segment out of it, and
 *   forwards the retract to `/api/sse`.
 * - `/api/sse` takes the segment out of the reply's record and rewinds the zip detector, or
 *   answers the forward without success when it cannot (`superseded`): the reply is then a gap
 *   and the finalize saves send-routed's own copy, already taken back by segment.
 * - Every tab gets `content_reset` with the reply's text as it now reads, and so does a tab that
 *   joins later (the replay).
 * - The saved reply, and `end`, hold the retried answer only, and say that the answer started
 *   again (`restartedAfterLostConnection`).
 *
 * The reply is recorded with no tab watching (a trusted internal forward of a running request,
 * BL-775), except where a tab subscribes. Faked: the compiler's output and the model.
 */

const USER = 'user-bl759'
const AGENT = 'agent-bl759'
const AGENT_B = 'agent-bl759-b'
const PRESET = 'preset-bl759'
const REPLY = 'msg-reply-bl759'
const GROUP = 'group-bl759'
const SERVICE_TOKEN = 'test-internal-token-bl759'

type Part =
  | { type: 'text-delta'; text: string; segmentId?: string }
  | { type: 'text-retract'; segmentId: string; reason: 'retry'; message: string | null }

const mocks = vi.hoisted(() => ({
  /** The parts the fake model streams, per model run (1-based); the last list repeats. */
  runs: [] as Array<Array<Record<string, any>>>,
  runCount: 0,
  /** What the model's `onFinish` says its text was (Codex: its last finished message). */
  finishText: '',
  /** A forwarded event type the event fetch answers 500 for, without reaching `/api/sse`. */
  failForwardOf: null as string | null,
  /** `/api/sse`'s answers, by forwarded event type. */
  answers: [] as Array<{ type: string; body: any }>,
  /** The chat's replay buffer at the moment `end` was forwarded. */
  replayAtEnd: null as any[] | null
}))

/**
 * Sealed from any real Redis: the live hub opens its own clients with `redis.createClient` (see
 * `send-routed-woken-turn-zips-handler.test.ts`).
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
    async prepareGroupHistory() {
      return { globalZipSettings: null }
    }

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
      mocks.runCount += 1
      const parts = mocks.runs[Math.min(mocks.runCount, mocks.runs.length) - 1] ?? []
      const text = mocks.runCount === 1 ? mocks.finishText : parts.filter((part) => part.type === 'text-delta').map((part) => part.text).join('')
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        for (const part of parts) yield { ...part, ...(part.type === 'text-delta' ? { id: 't1' } : {}) }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
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
let count = 0

/** The event fetch: a forward to `/api/sse` reaches the real route; nothing else is called. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  if (mocks.failForwardOf && event.type === mocks.failForwardOf) {
    return new Response('record failed (test)', { status: 500 })
  }
  if (event.type === 'end') mocks.replayAtEnd = listReplayEvents(SESSION)
  const response: Response = await SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
  const body = await response.clone().json().catch(() => null)
  mocks.answers.push({ type: event.type, body })
  return response
})

function send(content = 'Answer me.', messageId = REPLY): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content,
        messageId,
        messages: [{ id: `msg-user-${count}`, role: 'user', content }]
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

async function errorZipsOf(messageId: string) {
  const ids = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
  const zips = await Promise.all(ids.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
  return zips.filter((zip) => zip?.type === 'error' && zip?.metadata?.messageId === messageId)
}

const text = (value: string, segmentId?: string): Part => ({ type: 'text-delta', text: value, ...(segmentId ? { segmentId } : {}) })
const retract = (segmentId: string): Part => ({ type: 'text-retract', segmentId, reason: 'retry', message: 'Reconnecting... 1/5' })

async function createAgent(id: string, name: string) {
  await redis.createAgent({ id, user_id: USER, name, displayName: name, agentType: 'api', primary_model_preset_id: PRESET } as any)
}

describe('send-routed + /api/sse: a retried answer takes back its fragment (BL-759 phase 2, the real handlers)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl759-${count}`
    mocks.runs = []
    mocks.runCount = 0
    mocks.finishText = ''
    mocks.failForwardOf = null
    mocks.answers = []
    mocks.replayAtEnd = null
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    // send-routed's forwards are trusted internal ones, as in the app, so a reply no tab watches
    // is recorded whole (BL-775).
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
    await createAgent(AGENT, 'Lark')
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-759', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (redis as any).getGroup
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('saves the retried answer only, keeps a finished message before it, and says the answer started again', async () => {
    mocks.runs = [[text('Intro. ', 'm0'), text('Partial before ', 'm1'), text('the drop', 'm1'), retract('m1'), text('Hello after the retry.', 'm2')]]
    mocks.finishText = 'Hello after the retry.'
    expect((await send()).status).toBe(200)

    const saved = await stored(REPLY)
    expect(saved.content).toBe('Intro. Hello after the retry.')
    expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
    expect(saved.metadata.restartedAfterLostConnection).toEqual({ program: expect.any(String) })
    // `/api/sse` took the retract and said so.
    expect(mocks.answers.filter((answer) => answer.type === 'text_retract')).toEqual([
      { type: 'text_retract', body: { success: true } }
    ])
    // `end` carries the saved bytes.
    const endForward = eventFetch.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body ?? '{}')))
      .find((event) => event.type === 'end')
    expect(endForward.content).toBe('Intro. Hello after the retry.')
  }, 30_000)

  it('a tab that joins later gets content_reset from the replay, and no chunk of the fragment', async () => {
    mocks.runs = [[text('Intro. ', 'm0'), text('Partial before the drop', 'm1'), retract('m1'), text('Hello after the retry.', 'm2')]]
    mocks.finishText = 'Hello after the retry.'
    expect((await send()).status).toBe(200)

    const replay = mocks.replayAtEnd ?? []
    const chunks = replay.filter((event) => event.type === 'chunk').map((event) => event.content)
    expect(chunks.join('')).toBe('Intro. Hello after the retry.')
    const resets = replay.filter((event) => event.type === 'content_reset')
    expect(resets).toHaveLength(1)
    expect(resets[0].content).toBe('Intro. ')
    expect(resets[0].messageId).toBe(REPLY)
    // It sits where the fragment was: after the words before it, before the retried answer.
    const order = replay.filter((event) => event.type === 'chunk' || event.type === 'content_reset').map((event) => event.type === 'chunk' ? event.content : 'RESET')
    expect(order).toEqual(['Intro. ', 'RESET', 'Hello after the retry.'])
  }, 30_000)

  it('two retries in one reply take back both fragments', async () => {
    mocks.runs = [[text('First try ', 'm1'), retract('m1'), text('Second try ', 'm2'), retract('m2'), text('The answer.', 'm3')]]
    mocks.finishText = 'The answer.'
    expect((await send()).status).toBe(200)
    expect((await stored(REPLY)).content).toBe('The answer.')
  }, 30_000)

  it('a fragment that closed an error block an earlier message opened leaves no zip; the retried close makes the one zip', async () => {
    mocks.runs = [[text('Look: <error>boom', 'm0'), text(' at 3</error> tail', 'm1'), retract('m1'), text(' at 4</error> done.', 'm2')]]
    mocks.finishText = ' at 4</error> done.'
    expect((await send()).status).toBe(200)

    const saved = await stored(REPLY)
    const zips = await errorZipsOf(REPLY)
    expect(zips).toHaveLength(1)
    expect(zips[0].content).toContain('boom at 4')
    expect(zips[0].content).not.toContain('at 3')
    const references = scanZipReferences(saved.content)
    expect(references.map((reference) => reference.id)).toEqual([zips[0].id])
    expect(saved.content.startsWith('Look: ')).toBe(true)
    expect(saved.content.endsWith(' done.')).toBe(true)
    expect(saved.content).not.toContain('tail')
    expect(saved.metadata.zipIds).toEqual([zips[0].id])
  }, 30_000)

  it('a fragment that opened an error block leaves no open block and no held words', async () => {
    mocks.runs = [[text('Partial <error>open trace', 'm1'), retract('m1'), text('Answer.', 'm2')]]
    mocks.finishText = 'Answer.'
    expect((await send()).status).toBe(200)

    expect((await stored(REPLY)).content).toBe('Answer.')
    expect(await errorZipsOf(REPLY)).toHaveLength(0)
  }, 30_000)

  it('a retract that did not reach /api/sse makes the reply a gap; its own copy has no fragment', async () => {
    mocks.failForwardOf = 'text_retract'
    mocks.runs = [[text('Intro. ', 'm0'), text('Partial before the drop', 'm1'), retract('m1'), text('Hello after the retry.', 'm2')]]
    mocks.finishText = 'Hello after the retry.'
    expect((await send()).status).toBe(200)

    const saved = await stored(REPLY)
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(saved.content).toBe('Intro. Hello after the retry.')
    expect(saved.metadata.restartedAfterLostConnection).toEqual({ program: expect.any(String) })
  }, 30_000)

  it('a fragment that other words followed is superseded: /api/sse answers without success, and the own copy is taken back by segment', async () => {
    // Words with no segment land after the fragment (the Codex adapter never lets this happen:
    // it hands the retract on first). The zip detector then cannot take the fragment back exactly.
    mocks.runs = [[text('Partial <error>boom', 'm1'), text(' kept', undefined), retract('m1'), text('Answer.', 'm2')]]
    mocks.finishText = 'Answer.'
    expect((await send()).status).toBe(200)

    expect(mocks.answers.find((answer) => answer.type === 'text_retract')?.body?.success).not.toBe(true)
    const saved = await stored(REPLY)
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    // The own copy (trimmed as every saved reply is) keeps the words with no segment.
    expect(saved.content).toBe('keptAnswer.')
    // No zip is left that no saved message names.
    expect(await errorZipsOf(REPLY)).toHaveLength(0)
  }, 30_000)

  it('a tab watching gets the fragment, then content_reset with the text before it, then the retried answer', async () => {
    const locals = { user: { id: USER } }
    const hub = await SSE_ROUTE.GET({ url: new URL('http://localhost/api/sse?scope=hub'), locals })
    const reader = hub.body!.getReader()
    const decoder = new TextDecoder()
    const decode = (value: unknown) => (typeof value === 'string' ? value : decoder.decode(value as Uint8Array))
    const first = decode((await reader.read()).value)
    const hubId = JSON.parse(first.slice(first.indexOf('data: ') + 6).split('\n')[0]).hubId
    const patch = await SSE_ROUTE.PATCH({
      request: new Request('http://localhost/api/sse', {
        method: 'PATCH',
        body: JSON.stringify({ hubId, add: [{ id: 'tab', scope: 'session', sessionId: SESSION }] })
      }),
      locals
    })
    expect(patch.status).toBe(200)

    const received: any[] = []
    let buffered = ''
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffered += decode(value)
        let at: number
        while ((at = buffered.indexOf('\n\n')) !== -1) {
          const frame = buffered.slice(0, at)
          buffered = buffered.slice(at + 2)
          const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
          if (!line) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            received.push(parsed.event ?? parsed.data ?? parsed)
          } catch {
            /* a comment frame */
          }
        }
      }
    })()

    mocks.runs = [[text('Intro. ', 'm0'), text('Partial before the drop', 'm1'), retract('m1'), text('Hello after the retry.', 'm2')]]
    mocks.finishText = 'Hello after the retry.'
    expect((await send()).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await reader.cancel()
    await reading.catch(() => undefined)

    const seen = received
      .filter((event) => event?.messageId === REPLY && ['chunk', 'content_reset', 'end'].includes(event?.type))
      .map((event) => (event.type === 'chunk' ? event.content : event.type === 'content_reset' ? `RESET:${event.content}` : `END:${event.content}`))
    expect(seen).toEqual([
      'Intro. ',
      'Partial before the drop',
      'RESET:Intro. ',
      'Hello after the retry.',
      'END:Intro. Hello after the retry.'
    ])
  }, 30_000)

  describe('a group speaker (buffered group controls)', () => {
    async function userSendGroup() {
      return POST({
        request: new Request('http://localhost/api/messages/send-routed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: SESSION,
            agentId: AGENT,
            agentType: 'api',
            content: 'Hello everyone.',
            messageId: 'msg-group-user-1',
            messages: [{ id: 'msg-group-user-1', role: 'user', content: 'Hello everyone.' }]
          })
        }),
        fetch: eventFetch,
        locals: { user: { id: USER } }
      } as any)
    }

    beforeEach(async () => {
      ;(redis as any).getGroup = vi.fn(async (id: string) => redis.execute((client: any) => client.json.get(`group:${id}`)))
      await createAgent(AGENT_B, 'Wren')
      await redis.execute((client: any) =>
        client.json.set(`group:${GROUP}`, '$', {
          id: GROUP, user_id: USER, name: 'BL-759 group', agent_ids: [AGENT, AGENT_B], driver_mode: true, driver_agent_id: AGENT, max_followups_total: 1
        })
      )
      await redis.execute((client: any) => client.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: GROUP } }))
    })

    it('a fragment still held for the group control goes with the retract; the retried control resolves', async () => {
      const control = '<batshit-group>{"mode":"responding"}</batshit-group>'
      mocks.runs = [[text('<batshit-gr', 'm1'), retract('m1'), text(`${control}Answer.`, 'm2')]]
      mocks.finishText = `${control}Answer.`
      expect((await userSendGroup()).status).toBe(200)

      const messages = (await redis.getMessages(SESSION, 50)) as any[]
      const speaker = messages.find((message) => message.role === 'assistant' && message.agent_id === AGENT)
      expect(speaker?.content).toBe('Answer.')
    }, 30_000)

    it('a fragment that decided the group control is read again from the retried answer, split over deltas', async () => {
      const control = '<batshit-group>{"mode":"responding"}</batshit-group>'
      mocks.runs = [[
        text(`${control}Partial`, 'm1'),
        retract('m1'),
        text('<batshit-group>{"mode":"respo', 'm2'),
        text('nding"}</batshit-group>Answer.', 'm2')
      ]]
      mocks.finishText = `${control}Answer.`
      expect((await userSendGroup()).status).toBe(200)

      const messages = (await redis.getMessages(SESSION, 50)) as any[]
      const speaker = messages.find((message) => message.role === 'assistant' && message.agent_id === AGENT)
      expect(speaker?.content).toBe('Answer.')
    }, 30_000)
  })
})
