// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import {
  __resetReplyRecordsForTests,
  recordReplyEvent,
  REPLY_EVENT_FORWARD_LIMIT,
  isLateReplyEvent,
  listReplayEvents,
  replyZipDetection,
  startReplyRecord
} from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import {
  __resetClaudeApprovalRegistryForTests,
  recordClaudeApprovalCard,
  settleClaudeApproval
} from '$lib/server/services/claudeApprovalRegistry'
import type { SavedModel } from '$lib/types/savedModels'

/**
 * BL-775 through the real send-routed handler: the server owns a reply's saved record.
 *
 * - The finalize saves the reply's text from the stream's RECORD (what `/api/sse` recorded after
 *   its zip detection), not its own copy, and saves it BEFORE it publishes `end`, so every reader
 *   that acts on `end` finds the record, with the bytes `end` carries.
 * - It writes the fields only a tab used to write: `status`, `model`, `provider`, and the
 *   `zipIds` allow-list, always (a record without it trusts every reference in its text).
 * - When the record cannot be had (a forward of the reply did not reach it), it saves its own full
 *   text, marks the record `replySavedFromOwnCopy`, and says so loudly (condition 3 of the plan).
 * - An approval resume's rebuilt text already holds the part before the card: it is not joined a
 *   second time, and the numbers of the two halves are summed once.
 *
 * The event fetch stands in for `/api/sse` as the plan wires it: it records every forwarded event
 * of the reply in `replyStreamRecord` (a chunk's text is marked, as the zip detector would change
 * it, so a saved copy of send-routed's own text is told apart), and answers `{ success: true }`.
 * Faked beside it: the compiler's output and the API model.
 */

const USER = 'user-bl775'
const AGENT = 'agent-bl775'
const PRESET = 'preset-bl775'
const REPLY = 'msg-reply-bl775'
const CARD = 'msg-card-bl775'
const APPROVAL = 'aitxt-bl775'
const PAUSE_USAGE = { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 }
const RESUME_USAGE = { inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500 }

const mocks = vi.hoisted(() => ({
  /** The words the fake model streams, one text-delta each. */
  words: ['The first part. ', 'The second part.'],
  forwards: [] as Array<Record<string, any>>,
  /** A forwarded event type the fake `/api/sse` answers 500 for (its record then has a gap). */
  failForwardOf: null as string | null,
  /** A chunk text the fake `/api/sse` answers 500 for. */
  failChunkText: null as string | null,
  /** A chunk text the fake `/api/sse` never answers. */
  hangChunkText: null as string | null,
  /** A chunk text the fake `/api/sse` answers late (after `slowChunkMs`), then records normally. */
  slowChunkText: null as string | null,
  slowChunkMs: 0,
  /** Run chunks through the stream path's zip detector, as `/api/sse` does. */
  detectZips: false,
  /**
   * `reply`: words and a finish. `stop`: words, then the user's Stop. `fail-first`: an error before
   * any word. `stop-setup`: the user's Stop while the turn is still being set up. `acquire-fail`:
   * the model call itself throws before it returns a stream.
   */
  plan: 'reply' as 'reply' | 'stop' | 'fail-first' | 'stop-setup' | 'acquire-fail',
  /** Aborts the send's request (the user's Stop) while the turn is set up. */
  stopDuringSetup: null as null | (() => void),
  /** Saves of the reply that throw, counted down. */
  saveFailures: 0,
  /** `publishUserEvent` throws for this reason. */
  noticeThrowsFor: null as string | null,
  /** The stored reply at the moment `end` was forwarded. */
  storedAtEnd: null as any,
  /** The stored reply at the moment the first `error` or `complete` was forwarded. */
  storedAtError: undefined as any,
  storedAtComplete: undefined as any
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
      mocks.stopDuringSetup?.()
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Say two parts.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      if (mocks.plan === 'acquire-fail') throw new Error('The provider refused the connection (test).')
      const words = [...mocks.words]
      const text = words.join('')
      const usage = request.messageId === 'msg-card-bl775' ? { inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500 } : { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        if (mocks.plan === 'fail-first') {
          yield { type: 'error', error: new Error('Provider exploded before a word.') }
          return
        }
        yield { type: 'text-start', id: 't1' }
        for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
        if (mocks.plan === 'stop') {
          const stop = new Error('Stream interrupted by user')
          stop.name = 'AbortError'
          throw stop
        }
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
  return {
    ...actual,
    publishUserEvent: vi.fn(async (_userId: string, event: Record<string, any>) => {
      if (mocks.noticeThrowsFor && event?.reason === mocks.noticeThrowsFor) throw new Error('notice failed (test)')
    })
  }
})

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

/**
 * `/api/sse` as the plan wires it: records every event of the reply, then answers `success`. Like
 * SvelteKit's in-process fetch, an abort of the request rejects the caller's promise but does not
 * stop the handler: it runs to the end and still records the event.
 */
const sseForward = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const handled = handleSseForward(input, init)
  const signal = init?.signal
  if (!signal) return handled
  return Promise.race([
    handled,
    new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason))
    })
  ])
})

async function handleSseForward(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  mocks.forwards.push(event)
  // As `/api/sse`'s POST does on arrival: a content or tool event of a reply the finalize already
  // rebuilt is late.
  if (isLateReplyEvent(event.sessionId, event)) {
    return new Response(JSON.stringify({ success: false, message: 'The reply was already saved' }), { status: 200 })
  }
  if (mocks.hangChunkText !== null && event.type === 'chunk' && event.content === mocks.hangChunkText) {
    return new Promise<Response>(() => {})
  }
  // The route's own awaits between the arrival check and the zip detection.
  if (mocks.slowChunkText !== null && event.type === 'chunk' && event.content === mocks.slowChunkText) {
    await new Promise((resolve) => setTimeout(resolve, mocks.slowChunkMs))
  }
  if (mocks.failForwardOf && event.type === mocks.failForwardOf) {
    return new Response('record failed', { status: 500 })
  }
  if (mocks.failChunkText !== null && event.type === 'chunk' && event.content === mocks.failChunkText) {
    return new Response('record failed', { status: 500 })
  }
  if (event.type === 'start') {
    startReplyRecord(event.sessionId, { ...event })
  } else if (event.type === 'chunk' && mocks.detectZips) {
    // As the route does: checked again right before the zip detection.
    if (isLateReplyEvent(event.sessionId, event)) {
      return new Response(JSON.stringify({ success: false, message: 'The reply was already saved' }), { status: 200 })
    }
    const processed = await replyZipDetection.processChunk(event.sessionId, event.messageId, String(event.content))
    if (processed.shouldStream) recordReplyEvent(event.sessionId, { ...event, content: processed.content })
  } else if (event.type === 'chunk') {
    recordReplyEvent(event.sessionId, { ...event, content: String(event.content).replace('part', 'PART') })
  } else if (event.type === 'end') {
    mocks.storedAtEnd = await stored(event.messageId)
  } else if (event.type === 'error' && mocks.storedAtError === undefined) {
    mocks.storedAtError = await stored(event.messageId)
  } else if (event.type === 'complete' && mocks.storedAtComplete === undefined) {
    mocks.storedAtComplete = await stored(event.messageId)
  } else if (event.messageId) {
    recordReplyEvent(event.sessionId, { ...event })
  }
  return new Response(JSON.stringify({ success: true }), { status: 200 })
}

function send(signal?: AbortSignal): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'Say two parts.',
        messageId: REPLY,
        messages: [{ id: 'msg-user-1', role: 'user', content: 'Say two parts.' }]
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
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z'
} as unknown as SavedModel

describe('send-routed: the server owns a reply’s saved record (BL-775, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl775-${count}`
    mocks.words = ['The first part. ', 'The second part.']
    mocks.forwards = []
    mocks.failForwardOf = null
    mocks.failChunkText = null
    mocks.hangChunkText = null
    mocks.slowChunkText = null
    mocks.slowChunkMs = 0
    mocks.detectZips = false
    mocks.plan = 'reply'
    mocks.saveFailures = 0
    mocks.noticeThrowsFor = null
    mocks.storedAtEnd = null
    mocks.storedAtError = undefined
    mocks.storedAtComplete = undefined
    mocks.stopDuringSetup = null
    sseForward.mockClear()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetReplyRecordsForTests()
    __resetClaudeApprovalRegistryForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, model)
    await redis.createAgent({
      id: AGENT,
      user_id: USER,
      name: 'Probe',
      displayName: 'Probe',
      agentType: 'api',
      primary_model_preset_id: PRESET,
      tool_approval_mode: 'all'
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-775', agent_id: AGENT } as any)
    // The default lane's `saveMessage` is itself a mock: keep its own implementation.
    const original = (redis.saveMessage as any).getMockImplementation?.() ?? redis.saveMessage.bind(redis)
    vi.spyOn(redis, 'saveMessage').mockImplementation(async (message: any) => {
      if (message?.role === 'assistant' && mocks.saveFailures > 0) {
        mocks.saveFailures -= 1
        throw new Error('Redis connection lost (test)')
      }
      return original(message)
    })
  })

  const replySaves = (id: string) =>
    (redis.saveMessage as any).mock.calls.filter((call: any[]) => call[0]?.id === id && call[0]?.role === 'assistant').length
  const forwardsOf = (type: string) => mocks.forwards.filter((event) => event.type === type)

  afterEach(() => {
    vi.restoreAllMocks()
    __resetReplyRecordsForTests()
  })

  it('saves the recorded text, before `end`, with the fields a tab used to write', async () => {
    const response = await send()
    expect(response.status).toBe(200)

    const saved = await stored(REPLY)
    // The record's text (the marked chunks), not send-routed's own copy of the words.
    expect(saved.content).toBe('The first PART. The second PART.')
    expect(saved.status).toBe('complete')
    expect(saved.model).toBe('claude-sonnet-5')
    expect(saved.provider).toBe('anthropic')
    expect(saved.metadata.zipIds).toEqual([])
    expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()

    // Saved first, then published: the record was already there when `end` went out, and `end`
    // carries the saved bytes.
    expect(mocks.storedAtEnd?.content).toBe('The first PART. The second PART.')
    const end = mocks.forwards.find((event) => event.type === 'end')
    expect(end?.content).toBe(saved.content)
    expect(end?.savedRecord).toBe(true)
    expect(end?.metadata?.zipIds).toEqual([])
  }, 30_000)

  it('saves its own full text when the record has a gap, marks the record, and says so loudly', async () => {
    mocks.failForwardOf = 'chunk'

    const response = await send()
    expect(response.status).toBe(200)

    const saved = await stored(REPLY)
    expect(saved.content).toBe('The first part. The second part.')
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(saved.metadata.zipIds).toEqual([])
    expect(saved.status).toBe('complete')
    expect(
      (console.error as any).mock.calls.some((call: unknown[]) => String(call[0]).includes('BL-775'))
    ).toBe(true)
    const end = mocks.forwards.find((event) => event.type === 'end')
    expect(end?.content).toBe(saved.content)
    expect(end?.metadata?.replySavedFromOwnCopy).toBe(true)
  }, 30_000)

  it('a reply saved from its own copy leaves no stream-made zip without a reference (condition 5)', async () => {
    mocks.words = ['It failed:\n', '<error>Traceback: boom</error>', '\nDone.']
    mocks.detectZips = true
    mocks.failChunkText = '\nDone.'

    expect((await send()).status).toBe(200)

    const saved = await stored(REPLY)
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(saved.content).not.toContain('<error>')
    const zipIds = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
    const zips = await Promise.all(zipIds.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
    const errorZips = zips.filter((zip) => zip?.type === 'error' && zip?.metadata?.messageId === REPLY)
    const referenced = new Set(scanZipReferences(saved.content).map((reference) => reference.id))
    expect(errorZips).toHaveLength(1)
    expect(referenced.has(errorZips[0].id)).toBe(true)
    expect(saved.metadata.zipIds).toContain(errorZips[0].id)
  }, 30_000)

  // BL-775 deep read: the zip detector HOLDS the last words of a reply that ends inside an `<error>`
  // block that never closes, or in a lone start of the tag (`<`, `<e`, ... `<erro`). Only the
  // finalize can hand them on, and it must do it BEFORE it closes the reply: a closed reply refuses
  // every content event, so words written after the close were lost from the stored reply and `end`.
  describe('a reply that ends while the zip detector still holds its last words', () => {
    // The rebuild still keeps words it finds held at a closed reply, but says so with an error: the
    // finalize must have flushed them into the open record first, so that error must not appear.
    const heldWordsFoundAtClose = () =>
      (console.error as any).mock.calls.some((call: unknown[]) => String(call[0]).includes('flushHeldReplyText'))

    const errorZips = async () => {
      const zipIds = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
      const zips = await Promise.all(zipIds.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
      return zips.filter((zip) => zip?.type === 'error' && zip?.metadata?.messageId === REPLY)
    }

    it('keeps every word of a reply that ends inside an error block that never closed, in order', async () => {
      mocks.words = ['Some words ', '<error>Traceback: never closed']
      mocks.detectZips = true

      expect((await send()).status).toBe(200)

      const saved = await stored(REPLY)
      expect(saved.content).toBe('Some words <error>Traceback: never closed')
      expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
      expect(heldWordsFoundAtClose()).toBe(false)
      expect(saved.metadata.zipIds).toEqual([])
      expect(await errorZips()).toHaveLength(0)
      expect(mocks.storedAtEnd?.content).toBe(saved.content)
      const end = mocks.forwards.find((event) => event.type === 'end')
      expect(end?.content).toBe(saved.content)
    }, 30_000)

    it('keeps the start of an error tag a reply ended on', async () => {
      mocks.words = ['Some words ', 'and then <er']
      mocks.detectZips = true

      expect((await send()).status).toBe(200)

      const saved = await stored(REPLY)
      expect(saved.content).toBe('Some words and then <er')
      expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
      expect(heldWordsFoundAtClose()).toBe(false)
      const end = mocks.forwards.find((event) => event.type === 'end')
      expect(end?.content).toBe(saved.content)
    }, 30_000)

    it('keeps them when the reply is stopped inside the error block', async () => {
      mocks.words = ['Some words ', '<error>Traceback: stopped here']
      mocks.detectZips = true
      mocks.plan = 'stop'

      await send()

      const saved = await stored(REPLY)
      expect(saved?.metadata?.interrupted).toBe(true)
      expect(saved?.content).toBe('Some words <error>Traceback: stopped here')
      expect(heldWordsFoundAtClose()).toBe(false)
      expect(mocks.storedAtEnd?.content).toBe(saved.content)
    }, 30_000)
  })

  /** A card waiting for its answer, then the click that resumes it (the API lane, in place). */
  async function resumeApprovedCard() {
    const userMessage = {
      id: 'msg-user-1',
      session_id: SESSION,
      user_id: USER,
      role: 'user',
      content: 'List the folder.',
      created_at: '2026-09-28T01:00:00.000Z',
      metadata: {}
    }
    const cardMetadata = {
      model: 'claude-sonnet-5',
      agentType: 'api',
      usage: PAUSE_USAGE,
      zipIds: [],
      providerMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call_ls', toolName: 'native_bash_execute', input: { command: 'ls' } },
            { type: 'tool-approval-request', approvalId: APPROVAL, toolCallId: 'call_ls' }
          ]
        }
      ],
      providerMessageSource: { providerId: 'anthropic', connectionId: null, modelId: 'claude-sonnet-5' },
      toolApprovals: {
        mode: 'all',
        approvals: [{ approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', input: { command: 'ls' } }],
        source: 'vercel'
      }
    }
    const card = {
      id: CARD,
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'assistant',
      status: 'complete',
      // An older record can still hold a live clip reference: the rebuild neutralizes it, so the
      // rebuilt text no longer begins with the stored words, and joining again would double them.
      content: 'Asking first. {{batshit-clip:clip_1790000000001_abcd}}',
      created_at: '2026-09-28T01:00:05.000Z',
      intermediateSteps: [{ toolCallId: 'call_before', toolName: 'read_file' }],
      metadata: cardMetadata
    }
    await redis.saveMessage(userMessage as any)
    await redis.saveMessage(card as any)
    const savesBefore = replySaves(CARD)

    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION,
          agentId: AGENT,
          agentType: 'api',
          content: '',
          messageId: CARD,
          messages: [userMessage, card],
          metadata: {
            ...cardMetadata,
            toolApprovalMode: 'all',
            toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }]
          }
        })
      }),
      fetch: sseForward,
      locals: { user: { id: USER } }
    } as any)
    return { response, savesBefore }
  }

  it('an approval resume keeps the part before the card once, and counts both halves once', async () => {
    mocks.words = ['The folder has three files.']
    mocks.noticeThrowsFor = 'approval_resume'
    const { response, savesBefore } = await resumeApprovedCard()
    expect(response.status).toBe(200)

    const saved = await stored(CARD)
    expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
    expect(saved.content).toBe('Asking first. [clip reference omitted]\n\nThe folder has three files.')
    expect(saved.content.match(/Asking first\./g)).toHaveLength(1)
    expect(saved.metadata.usage).toEqual({
      inputTokens: PAUSE_USAGE.inputTokens + RESUME_USAGE.inputTokens,
      outputTokens: PAUSE_USAGE.outputTokens + RESUME_USAGE.outputTokens,
      totalTokens: PAUSE_USAGE.totalTokens + RESUME_USAGE.totalTokens
    })
    expect(saved.intermediateSteps.filter((step: any) => step.toolCallId === 'call_before')).toHaveLength(1)
    const end = mocks.forwards.find((event) => event.type === 'end')
    expect(end?.content).toBe(saved.content)
    // A notice after the save that fails neither saves nor ends the reply a second time.
    expect(replySaves(CARD) - savesBefore).toBe(1)
    expect(forwardsOf('end')).toHaveLength(1)
    expect(forwardsOf('error')).toHaveLength(0)
  }, 30_000)

  // BL-775: an approval resume whose model call throws after its early start is saved first,
  // then the tabs get `error`; the POST's own catch does not save it a second time.
  it('an approval resume whose model call fails is saved before the tabs are told, once', async () => {
    mocks.plan = 'acquire-fail'
    const { savesBefore } = await resumeApprovedCard()
    expect(forwardsOf('start')).toHaveLength(1)
    expect(forwardsOf('error')).toHaveLength(1)
    expect(mocks.storedAtError?.status).toBe('error')
    expect(mocks.storedAtError?.metadata?.response_failed).toBe(true)
    expect(typeof mocks.storedAtError?.metadata?.approvalResumeVersion).toBe('number')
    expect(mocks.storedAtError?.content).toContain('Asking first.')
    expect(replySaves(CARD) - savesBefore).toBe(1)
  }, 30_000)

  it('a stopped reply whose first save fails is saved on the retry, then ended', async () => {
    mocks.plan = 'stop'
    mocks.saveFailures = 1
    await send()
    const saved = await stored(REPLY)
    expect(saved?.content).toBe('The first PART. The second PART.')
    expect(saved?.metadata?.interrupted).toBe(true)
    // Saved first, then ended.
    expect(mocks.storedAtEnd?.content).toBe('The first PART. The second PART.')
    expect(forwardsOf('end')).toHaveLength(1)
    expect(forwardsOf('complete')).toHaveLength(1)
    expect(forwardsOf('error')).toHaveLength(0)
  }, 30_000)

  it('a stopped reply that cannot be saved tells the tab in plain words, not only the log', async () => {
    mocks.plan = 'stop'
    mocks.saveFailures = 2
    await send()
    expect(await stored(REPLY)).toBeNull()
    expect(forwardsOf('end')).toHaveLength(0)
    expect(forwardsOf('error').map((event) => event.error)).toEqual(['This reply could not be saved.'])
    expect(forwardsOf('complete')).toHaveLength(0)
  }, 30_000)

  it('a reply that failed before a word keeps its allow-list, model and provider', async () => {
    mocks.plan = 'fail-first'
    await send()
    const saved = await stored(REPLY)
    expect(saved.status).toBe('error')
    expect(saved.metadata.response_failed).toBe(true)
    expect(saved.metadata.zipIds).toEqual([])
    expect(saved.model).toBe('claude-sonnet-5')
    expect(saved.provider).toBe('anthropic')
    // Saved first, then the tabs are told: a tab that reads the chat on `error` finds the record.
    expect(forwardsOf('error')).toHaveLength(1)
    expect(mocks.storedAtError?.status).toBe('error')
  }, 30_000)

  // BL-775: a Stop while the turn is still being set up is saved like a Stop mid-reply.
  it('a Stop during setup whose first save fails is saved on the retry, then ended', async () => {
    const stop = new AbortController()
    mocks.stopDuringSetup = () => stop.abort('user')
    mocks.saveFailures = 1
    expect((await send(stop.signal)).status).toBe(499)
    const saved = await stored(REPLY)
    expect(saved?.metadata?.interrupted).toBe(true)
    expect(saved?.metadata?.interruptedDuringSetup).toBe(true)
    // Nothing streamed, so there was no record to have: not a gap, and no notice.
    expect(saved?.metadata?.replySavedFromOwnCopy).toBeUndefined()
    expect(mocks.storedAtComplete?.metadata?.interrupted).toBe(true)
    expect(forwardsOf('complete')).toHaveLength(1)
    expect(forwardsOf('error')).toHaveLength(0)
  }, 30_000)

  it('a Stop during setup that cannot be saved tells the tab in plain words and sends no complete', async () => {
    const stop = new AbortController()
    mocks.stopDuringSetup = () => stop.abort('user')
    mocks.saveFailures = 2
    expect((await send(stop.signal)).status).toBe(499)
    expect(await stored(REPLY)).toBeNull()
    expect(forwardsOf('error').map((event) => event.error)).toEqual(['This reply could not be saved.'])
    expect(forwardsOf('complete')).toHaveLength(0)
  }, 30_000)

  // BL-496, BL-775: a Claude card lives in the server's registry beside its run, and a tab used
  // to carry it from `end` into its save. The finalize writes the reply's cards into the record
  // it saves, so a reply nobody watched keeps them: one answered, one that expired unanswered.
  it('saves the reply’s Claude approval cards, answered and expired, with no tab watching', async () => {
    const card = (approvalId: string, toolName: string) => ({
      sessionId: SESSION,
      messageId: REPLY,
      approvalId,
      toolName,
      input: { command: 'ls' },
      requestedAt: '2026-09-28T01:00:00.000Z',
      expiresAt: '2026-09-28T01:10:00.000Z'
    })
    recordClaudeApprovalCard(card('claude-approved', 'Bash'))
    recordClaudeApprovalCard(card('claude-expired', 'Edit'))
    settleClaudeApproval(SESSION, 'claude-approved', { status: 'approved' })
    settleClaudeApproval(SESSION, 'claude-expired', { status: 'expired', expiryReason: 'unanswered' })

    expect((await send()).status).toBe(200)

    const saved = await stored(REPLY)
    const approvals = saved.metadata.toolApprovals?.approvals ?? []
    expect(approvals.map((entry: any) => [entry.approvalId, entry.status]).sort()).toEqual([
      ['claude-approved', 'approved'],
      ['claude-expired', 'expired']
    ])
    expect(approvals.find((entry: any) => entry.approvalId === 'claude-expired')?.expiryReason).toBe('unanswered')
    expect(forwardsOf('end')[0]?.metadata?.toolApprovals?.approvals).toHaveLength(2)
  }, 30_000)

  // BL-353 with BL-775: a first finalize whose save throws goes through the failure path's second
  // finalize, which saves the same rebuild once and publishes `end` once.
  it('a second finalize after a failed save saves the recorded text and ends once', async () => {
    mocks.saveFailures = 1
    await send()
    const saved = await stored(REPLY)
    expect(saved?.content).toBe('The first PART. The second PART.')
    expect(saved?.metadata?.replySavedFromOwnCopy).toBeUndefined()
    expect(forwardsOf('end')).toHaveLength(1)
    expect(mocks.storedAtEnd?.content).toBe(saved.content)
  }, 30_000)

  it('an approval resume whose record has a gap saves its own copy once, marked, after the part before the card', async () => {
    mocks.words = ['The folder has three files.']
    mocks.failForwardOf = 'chunk'
    const userMessage = { id: 'msg-user-1', session_id: SESSION, user_id: USER, role: 'user', content: 'List the folder.', created_at: '2026-09-28T01:00:00.000Z', metadata: {} }
    const cardMetadata = {
      model: 'claude-sonnet-5',
      agentType: 'api',
      usage: PAUSE_USAGE,
      providerMessages: [
        { role: 'assistant', content: [
          { type: 'tool-call', toolCallId: 'call_ls', toolName: 'native_bash_execute', input: { command: 'ls' } },
          { type: 'tool-approval-request', approvalId: APPROVAL, toolCallId: 'call_ls' }
        ] }
      ],
      providerMessageSource: { providerId: 'anthropic', connectionId: null, modelId: 'claude-sonnet-5' },
      toolApprovals: { mode: 'all', approvals: [{ approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', input: { command: 'ls' } }], source: 'vercel' }
    }
    const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', status: 'complete', content: 'Asking first.', created_at: '2026-09-28T01:00:05.000Z', metadata: cardMetadata }
    await redis.saveMessage(userMessage as any)
    await redis.saveMessage(card as any)

    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION, agentId: AGENT, agentType: 'api', content: '', messageId: CARD,
          messages: [userMessage, card],
          metadata: { ...cardMetadata, toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }] }
        })
      }),
      fetch: sseForward,
      locals: { user: { id: USER } }
    } as any)
    expect(response.status).toBe(200)
    const saved = await stored(CARD)
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(saved.content).toBe('Asking first.\n\nThe folder has three files.')
    expect(saved.metadata.usage.inputTokens).toBe(PAUSE_USAGE.inputTokens + RESUME_USAGE.inputTokens)
    expect(forwardsOf('end')).toHaveLength(1)
    expect(forwardsOf('end')[0].content).toBe(saved.content)
  }, 30_000)

  // A forward slower than usual but within its limit is waited for, in order: not a gap.
  // SvelteKit's in-process fetch runs `/api/sse`'s handler to the end, so the event is recorded.
  it('a forward that answers within its time limit is not a gap: no notice, no zip without its reference', async () => {
    const limit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = 2000
    try {
      mocks.words = ['It failed:\n', '<error>Traceback: boom', ' at line 3</error>', '\nDone.']
      mocks.detectZips = true
      mocks.slowChunkText = ' at line 3</error>'
      mocks.slowChunkMs = 600

      expect((await send()).status).toBe(200)

      const saved = await stored(REPLY)
      expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
      expect(saved.content).not.toContain('<error>')
      expect(saved.content).toContain('Done.')
      const zipIds = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
      const zips = await Promise.all(zipIds.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
      const errorZips = zips.filter((zip) => zip?.type === 'error' && zip?.metadata?.messageId === REPLY)
      expect(errorZips).toHaveLength(1)
      expect(new Set(scanZipReferences(saved.content).map((reference) => reference.id)).has(errorZips[0].id)).toBe(true)
      expect(saved.metadata.zipIds).toContain(errorZips[0].id)
    } finally {
      REPLY_EVENT_FORWARD_LIMIT.ms = limit
    }
  }, 30_000)

  // A forward that never answers makes the reply a gap at once, and nothing waits for it: `end`
  // and `complete` still reach the tabs promptly, and the own copy is saved with the notice.
  it('a forward that never answers is a gap, and end and complete are still forwarded promptly', async () => {
    const limit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = 50
    try {
      mocks.hangChunkText = 'The first part. '
      const started = Date.now()
      expect((await send()).status).toBe(200)
      expect(Date.now() - started).toBeLessThan(5000)
      const saved = await stored(REPLY)
      expect(saved.content).toBe('The first part. The second part.')
      expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
      expect(forwardsOf('end')).toHaveLength(1)
      expect(forwardsOf('complete')).toHaveLength(1)
      expect(forwardsOf('end')[0].metadata?.replySavedFromOwnCopy).toBe(true)
    } finally {
      REPLY_EVENT_FORWARD_LIMIT.ms = limit
    }
  }, 30_000)

  it('a Stop while a forward never answers still saves the reply and sends complete', async () => {
    const limit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = 50
    try {
      mocks.plan = 'stop'
      mocks.hangChunkText = 'The first part. '
      const started = Date.now()
      await send()
      expect(Date.now() - started).toBeLessThan(5000)
      const saved = await stored(REPLY)
      expect(saved?.metadata?.interrupted).toBe(true)
      expect(forwardsOf('complete')).toHaveLength(1)
    } finally {
      REPLY_EVENT_FORWARD_LIMIT.ms = limit
    }
  }, 30_000)

  // A forward past its limit is a gap; when it finally goes on, after the reply was saved, the
  // route's second check refuses it before the zip detection: no record, no zip without a reference.
  it('a forward that passes its limit and goes on after the save records nothing and makes no zip', async () => {
    const limit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = 50
    try {
      mocks.words = ['It failed:\n', '<error>Traceback: boom', ' at line 3</error>', '\nDone.']
      mocks.detectZips = true
      mocks.slowChunkText = ' at line 3</error>'
      mocks.slowChunkMs = 800

      expect((await send()).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const saved = await stored(REPLY)
      expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
      const zipIds = (await redis.execute((client: any) => client.sMembers(`session:${SESSION}:zips`))) as string[]
      const zips = await Promise.all(zipIds.map(async (id) => (await redis.execute((client: any) => client.json.get(`zip:${id}`))) as any))
      const referenced = new Set(scanZipReferences(saved.content).map((reference) => reference.id))
      for (const zip of zips.filter((entry) => entry?.metadata?.messageId === REPLY)) {
        expect(referenced.has(zip.id)).toBe(true)
      }
      const lateRecorded = listReplayEvents(SESSION).filter(
        (event) => event.messageId === REPLY && event.type === 'chunk' && String(event.content).includes('line 3')
      )
      expect(lateRecorded).toEqual([])
    } finally {
      REPLY_EVENT_FORWARD_LIMIT.ms = limit
    }
  }, 30_000)
})

