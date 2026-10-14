// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'

/**
 * The reply-end step (`finalizeReplyControl`) runs once per reply; a second finalize of the same
 * reply (its save threw, so the failure path finalized again) reuses its result. Two things that
 * reuse lost, through the real handler:
 *
 * - BL-537: a first finalize that ran the step and died BEFORE its save (and so before its
 *   `zip_state_changed` notice) left the reuse with `zipStateChanged: null`: the step changed the
 *   chat's zip state and no tab was told. Now the notice is sent once per reply, whichever finalize
 *   gets there.
 * - BL-542: when both finalize saves failed, the error-only writer kept only the failure facts: the
 *   memory-save chips and the hold record of saves and holds that DID happen were lost. Now the
 *   failed record carries them (joined with the part before the card on an approval resume).
 *
 * Faked: the compiler's output, the API model (words and a finish), the reply-end step (a canned
 * result, counted), and the failures themselves (`buildJevJuiceMessageMetadata` throwing once, the
 * message save throwing for the reply). The user-channel notices are counted at `publishUserEvent`.
 */

const USER = 'user-replyend'
const AGENT = 'agent-replyend'
const PRESET = 'preset-replyend'
const REPLY = 'msg-reply'
const CARD = 'msg-card'
const APPROVAL = 'aitxt-replyend'

const mocks = vi.hoisted(() => ({
  replyControlCalls: 0,
  /** The next N calls of `buildJevJuiceMessageMetadata` throw (the finalize dies before its save). */
  jevJuiceMetadataThrows: 0,
  /** Saves of these message ids that throw, counted down per id. */
  saveFailures: new Map<string, number>(),
  /**
   * Saves of these message ids that WRITE the record and then throw (review D2): the real
   * `saveMessage` writes the message, then pushes it on the list and touches the chat, and either
   * of those can throw after the record is already stored.
   */
  saveFailuresAfterWrite: new Map<string, number>(),
  notices: [] as Array<Record<string, any>>
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
        structuredInput: { messages: [{ role: 'user', content: 'Hold the file.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const text = 'Holding b.ts and saving a note.'
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

vi.mock('$lib/server/services/replyControlFinalize', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finalizeReplyControl: vi.fn(async (input: any) => {
    mocks.replyControlCalls += 1
    return {
      content: String(input.content ?? ''),
      metadata: {
        replyControlFinalized: true,
        memorySaves: [{ id: 'mem_resume', lane: 'ltm', gist: 'saved after the card' }],
        zipHolds: { held: [{ path: 'b.ts', zipId: 'zip_b' }] },
        zipControl: {
          unzip: [], zip: [], hold: ['b.ts'],
          toolResultsSummary: [{ toolName: 'read_file', summary: 'b.ts: resumed read' }]
        },
        controlErrors: [{ tag: 'batshit-memory', error: 'Resume note rejected', at: '2026-09-27T01:01:04.000Z' }]
      },
      zipStateChanged: 'agent',
      hadMemoryBlock: true
    }
  })
}))

vi.mock('$lib/server/services/typesafe/jevJuiceTurn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    buildJevJuiceMessageMetadata: vi.fn((...args: any[]) => {
      if (mocks.jevJuiceMetadataThrows > 0) {
        mocks.jevJuiceMetadataThrows -= 1
        throw new Error('finalize died before its save (test)')
      }
      return actual.buildJevJuiceMessageMetadata(...args)
    })
  }
})

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    publishUserEvent: vi.fn(async (_userId: string, event: Record<string, any>) => {
      mocks.notices.push(event)
    })
  }
})

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0

/**
 * The message save, failing for the ids the test names. The default lane's fake REPLACES a stored
 * record where the real `redis.saveMessage` merges its metadata key by key (`redis.ts`); a failure
 * record is written twice (the stream handler's writer, then the POST's), so this merges like the
 * real one, or the second write would wipe what the first carried on the fake alone.
 */
function failSavesAndMergeLikeRedis() {
  const original = (redis.saveMessage as any).getMockImplementation?.() ?? redis.saveMessage.bind(redis)
  return vi.spyOn(redis, 'saveMessage').mockImplementation(async (message: any) => {
    const left = mocks.saveFailures.get(message?.id) ?? 0
    if (left > 0) {
      mocks.saveFailures.set(message.id, left - 1)
      throw new Error('Redis connection lost')
    }
    const existing = (await redis.execute((client: any) => client.json.get(`message:${message.session_id}:${message.id}`))) as any
    const merged = existing?.metadata
      ? { ...message, metadata: { ...existing.metadata, ...(message.metadata ?? {}) } }
      : message
    const result = await original(merged)
    const afterWrite = mocks.saveFailuresAfterWrite.get(message?.id) ?? 0
    if (afterWrite > 0) {
      mocks.saveFailuresAfterWrite.set(message.id, afterWrite - 1)
      throw new Error('Redis connection lost after the write')
    }
    return result
  })
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
        content: 'Hold the file.',
        messageId: REPLY,
        messages: [{ id: 'msg-user-1', role: 'user', content: 'Hold the file.' }]
      })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

const zipNotices = () => mocks.notices.filter((event) => event.type === 'zip_state_changed')

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

describe('send-routed: a second finalize of the same reply (BL-537, BL-542, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-replyend-${count}`
    mocks.replyControlCalls = 0
    mocks.jevJuiceMetadataThrows = 0
    mocks.saveFailures.clear()
    mocks.saveFailuresAfterWrite.clear()
    mocks.notices = []
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
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
      primary_model_preset_id: PRESET,
      tool_approval_mode: 'all'
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'Reply end', agent_id: AGENT } as any)
    failSavesAndMergeLikeRedis()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('the zip state notice (BL-537)', () => {
    it('a first finalize that died before its save: the second one still tells the tabs, once', async () => {
      mocks.jevJuiceMetadataThrows = 1

      const response = await send()

      // The words are kept: the failure path finalized the reply again, and that save landed.
      expect(response.ok).toBe(false)
      expect((await stored(REPLY))?.content).toBe('Holding b.ts and saving a note.')
      // The step ran once; its change was told once.
      expect(mocks.replyControlCalls).toBe(1)
      expect(zipNotices()).toEqual([
        { type: 'zip_state_changed', sessionId: SESSION, source: 'agent', opened: [], rezipped: [] }
      ])
    }, 30_000)

    it('a first finalize whose save failed told the tabs already: the second one does not tell them again', async () => {
      mocks.saveFailures.set(REPLY, 1)

      await send()

      expect(mocks.replyControlCalls).toBe(1)
      expect(zipNotices()).toHaveLength(1)
    }, 30_000)

    it('a reply that finishes tells the tabs once', async () => {
      const response = await send()
      expect(response.status).toBe(200)
      expect(zipNotices()).toHaveLength(1)
    }, 30_000)
  })

  describe('the failed record keeps the reply-end record (BL-542)', () => {
    it('both finalize saves failed: the error record keeps the memory-save chip and the hold record', async () => {
      mocks.saveFailures.set(REPLY, 2)

      const response = await send()

      expect(response.ok).toBe(false)
      const record = await stored(REPLY)
      expect(record.status).toBe('error')
      expect(record.metadata.response_failed).toBe(true)
      expect(record.metadata.memorySaves.map((save: any) => save.id)).toEqual(['mem_resume'])
      expect(record.metadata.zipHolds).toEqual({ held: [{ path: 'b.ts', zipId: 'zip_b' }] })
      expect(record.metadata.replyControlFinalized).toBe(true)
    }, 30_000)

    /** A stored card (the part before it saved a chip, held a.ts, and wrote one control error), then Approve. */
    async function approveStoredCard(armFailures: () => void) {
      await redis.saveMessage({
        id: 'msg-user-1',
        session_id: SESSION,
        user_id: USER,
        role: 'user',
        content: 'Hold the file.',
        created_at: '2026-09-27T01:00:00.000Z',
        metadata: {}
      } as any)
      const cardMetadata = {
        model: 'claude-sonnet-5',
        agentType: 'api',
        memorySaves: [{ id: 'mem_pause', lane: 'ltm', gist: 'saved before the card' }],
        zipHolds: { held: [{ path: 'a.ts', zipId: 'zip_a' }] },
        zipControl: {
          unzip: [], zip: [], hold: ['a.ts'],
          toolResultsSummary: [{ toolName: 'read_file', summary: 'a.ts: paused read' }]
        },
        controlErrors: [{ tag: 'batshit-tool-notes', error: 'You have no whole read of c.ts', at: '2026-09-27T01:00:04.000Z' }],
        replyControlFinalized: true,
        usage: null,
        observedUsage: { completeness: 'partial', parts: [{
          source: 'codex-app-server-progress',
          counts: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20, cacheCreationInputTokens: 30, reasoningTokens: 0 }
        }] },
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
        content: 'Holding a.ts first.',
        created_at: '2026-09-27T01:00:05.000Z',
        metadata: cardMetadata
      }
      await redis.saveMessage(card as any)
      armFailures()

      return POST({
        request: new Request('http://localhost/api/messages/send-routed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: SESSION,
            agentId: AGENT,
            agentType: 'api',
            content: '',
            messageId: CARD,
            messages: [{ id: 'msg-user-1', role: 'user', content: 'Hold the file.' }, card],
            metadata: {
              ...cardMetadata,
              toolApprovalMode: 'all',
              toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }]
            }
          })
        }),
        fetch: globalThis.fetch,
        locals: { user: { id: USER } }
      } as any)
    }

    function expectBothHalvesOnce(record: any, content: string) {
      expect(record.status).toBe('error')
      // The words the record holds stay (the resume's failure rule): the fresh read is for them.
      expect(record.content).toBe(content)
      expect(record.metadata.memorySaves.map((save: any) => save.id)).toEqual(['mem_pause', 'mem_resume'])
      expect(record.metadata.zipHolds).toEqual({
        held: [
          { path: 'a.ts', zipId: 'zip_a' },
          { path: 'b.ts', zipId: 'zip_b' }
        ]
      })
      expect(record.metadata.zipControl).toEqual({
        unzip: [], zip: [], hold: ['a.ts', 'b.ts'],
        toolResultsSummary: [
          { toolName: 'read_file', summary: 'a.ts: paused read' },
          { toolName: 'read_file', summary: 'b.ts: resumed read' }
        ]
      })
      expect(record.metadata.controlErrors).toEqual([
        { tag: 'batshit-tool-notes', error: 'You have no whole read of c.ts', at: '2026-09-27T01:00:04.000Z' },
        { tag: 'batshit-memory', error: 'Resume note rejected', at: '2026-09-27T01:01:04.000Z' }
      ])
      expect(record.metadata.replyControlFinalized).toBe(true)
      expect(mocks.replyControlCalls).toBe(1)
      expect(record.metadata.usage).toBeNull()
      expect(record.metadata.observedUsage).toEqual({ completeness: 'partial', parts: [
        { source: 'codex-app-server-progress', counts: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20, cacheCreationInputTokens: 30, reasoningTokens: 0 } },
        { source: 'run-usage-prefix', counts: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      ] })
    }

    it('on an approval resume: the part before the card and the resume both keep their chips and holds', async () => {
      const response = await approveStoredCard(() => mocks.saveFailures.set(CARD, 2))
      expect(response.ok).toBe(false)
      expectBothHalvesOnce(await stored(CARD), 'Holding a.ts first.')
    }, 30_000)

    it('a finalize save that wrote the joined record and then threw: nothing is joined twice (review D2)', async () => {
      // Both finalize saves write the continued record (both halves' chips and holds), then throw.
      const response = await approveStoredCard(() => mocks.saveFailuresAfterWrite.set(CARD, 2))
      expect(response.ok).toBe(false)
      // The save that wrote before it threw left the continued words, and they stay.
      expectBothHalvesOnce(await stored(CARD), 'Holding a.ts first.\n\nHolding b.ts and saving a note.')
    }, 30_000)
  })
})
