// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests, enqueueSteer } from '$lib/server/services/steerInboxRegistry'
import { createPendingApproval } from '$lib/server/services/controlApprovals'
import { keepAnsweredApprovals } from '$lib/server/services/toolApprovalState'

/**
 * BL-455 (with BL-524) — words that wait when a reply stops at an approval card, through the real
 * handler.
 *
 * A reply that stops at an approval card has not ended. The words the user typed while it ran (a
 * steer that found no tool boundary, a queued message) used to be promoted into a whole new turn
 * beside the waiting card. Now they become ONE saved user message that names the card's message
 * (`metadata.waitsForApproval`), no turn runs, and the click's request answers it when the resumed
 * reply ends, if it is still the chat's last message.
 *
 * Faked, and only these: the compiler's OUTPUT (it records the current message each compile was
 * given) and the API lane's model (`VercelAIBrain`: per run, a plain reply, a reply that stops at an
 * approval card, or a reply the user stops). Everything between is the handler's own code on the
 * Redis fake. The paused half of a reply is seeded the way a finished pause leaves it (its card and
 * its replayable transcript), as the BL-525 handler test does.
 */

const USER = 'user-bl455'
const AGENT = 'agent-bl455'
const PRESET = 'preset-bl455'
const FIRST_REPLY = 'msg-first-reply'
const CARD = 'msg-card'
const APPROVAL = 'aitxt-bl455'
const HELD = 'msg-held'

type ModelRun = 'reply' | 'card' | 'stopped' | 'reply-then-lock-cleared' | 'words-then-error' | 'stopped-stream'

const mocks = vi.hoisted(() => ({
  /** What each model run does, by run number (1-based); the rest reply. */
  modelRuns: new Map<number, ModelRun>(),
  /** The assistant message id of every model run, in order. */
  brainRuns: [] as string[],
  /** The current message every compile was given, in order. */
  compiledCurrent: [] as unknown[],
  compiledHistory: [] as any[][],
  /** Who wrote it, as each compile was told (`currentMessageFrom`). */
  compiledFrom: [] as unknown[],
  /** The project and voice state each compile was given. */
  compiledProject: [] as unknown[],
  compiledVoiceTts: [] as unknown[],
  /** Aborts the request under test (a Stop). */
  abortRequest: null as null | (() => void),
  /** The chat under test, for a plan that clears its lock. */
  session: '',
  /** Compile calls (1-based) that compile to nothing, so their turn fails before its stream opens. */
  emptyCompiles: new Set<number>(),
  /** Every user-channel event the handler published. */
  userEvents: [] as Array<Record<string, any>>,
  /** Runs (1-based) during which the user types one more queued message into that run. */
  typedDuring: new Set<number>()
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    publishUserEvent: vi.fn(async (_userId: string, event: Record<string, any>) => {
      mocks.userEvents.push(event)
    })
  }
})

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: {
    cleanupExecutionSandboxesForSession: vi.fn(async () => [])
  }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput(
      _sessionId: string,
      _history: any[],
      _agent: unknown,
      current: unknown,
      _subagents: unknown,
      _userId: unknown,
      options?: { currentMessageFrom?: unknown; projectPath?: unknown; voiceState?: { tts?: unknown } }
    ) {
      mocks.compiledCurrent.push(current)
      mocks.compiledHistory.push(_history)
      mocks.compiledFrom.push(options?.currentMessageFrom)
      mocks.compiledProject.push(options?.projectPath ?? null)
      mocks.compiledVoiceTts.push(options?.voiceState?.tts ?? null)
      const empty = mocks.emptyCompiles.has(mocks.compiledCurrent.length)
      return {
        primarySystemPrompt: empty ? '' : 'You are a test agent.',
        structuredInput: { messages: empty ? [] : [{ role: 'user', content: 'Hello from the compile.' }], metadata: {} },
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
      const plan = mocks.modelRuns.get(run) ?? 'reply'
      if (mocks.typedDuring.has(run)) {
        const inbox = await import('$lib/server/services/steerInboxRegistry')
        inbox.enqueueSteer(mocks.session, {
          steerId: `msg-typed-in-run-${run}`,
          messageId: request.messageId,
          text: `Typed during run ${run}.`,
          at: new Date().toISOString(),
          source: 'user',
          deliver: 'end'
        })
      }
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      if (plan === 'card') {
        const callId = `call_ls_${mocks.brainRuns.length}`
        const approvalId = `aitxt-new-${mocks.brainRuns.length}`
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
          yield {
            type: 'tool-approval-request',
            approvalId,
            toolCallId: callId,
            toolName: 'native_bash_execute',
            input: { command: 'ls' }
          }
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
      if (plan === 'words-then-error') {
        async function* cutShort() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Listing the fol' }
          yield { type: 'error', error: new Error('Provider exploded mid-reply.') }
        }
        return { stream: cutShort(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      if (plan === 'stopped' || plan === 'stopped-stream') {
        async function* stopped() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Listing the fol' }
          if (plan === 'stopped') mocks.abortRequest?.()
          else {
            const registry = await import('$lib/server/services/streamAbortRegistry')
            registry.abortStream(mocks.session, 'user') // Actual interrupt route's stream-only Stop.
          }
          yield { type: 'abort' }
        }
        return { stream: stopped(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      const text = `Reply for ${request.messageId}.`
      const clearsLock = plan === 'reply-then-lock-cleared'
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        if (clearsLock) {
          // A Stop pressed as the reply ends: the interrupt route clears a finishing turn's lock.
          const registry = await import('$lib/server/services/streamAbortRegistry')
          registry.clearSessionTurn(mocks.session, request.messageId)
        }
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

useRedisTestServer()

// Capture the clean facade implementations once, before any per-case once queue.
const originalSaveMessage = vi.mocked(redis.saveMessage).getMockImplementation()!
const originalUpdateMessage = vi.mocked(redis.updateMessage).getMockImplementation()!

/** The shared fake documents replace-on-save. These failure cases require the real
 * trusted writer's stored-metadata merge/answered-approval contract, locally only.
 * This adapter is not evidence for Lua or concurrent persistence.
 */
function installTrustedCardSaveMerge() {
  const save = vi.mocked(redis.saveMessage)
  save.mockImplementation(async (message, options) => {
    if (message.id === CARD && (message as any).role === 'assistant' && !options?.browserMutation) {
      const prior = await redis.json.get(`message:${SESSION}:${CARD}`) as any
      if (prior) {
        const before = prior.metadata && typeof prior.metadata === 'object' ? prior.metadata : {}
        const after = (message as any).metadata && typeof (message as any).metadata === 'object' ? (message as any).metadata : {}
        message = { ...message, created_at: prior.created_at,
          metadata: keepAnsweredApprovals(before, { ...before, ...after }) } as any
      }
    }
    return originalSaveMessage.apply(redis, [message, options])
  })
  return () => save.mockRestore()
}

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0
let forwards: Array<Record<string, any>> = []
let warnSpy: ReturnType<typeof vi.spyOn>

/** The handler's own warning when a turn with words also carries an approval answer. */
const STALE_APPROVAL_WARNING = '[Send-Routed] Ignoring stale tool approval payload on user turn'

function post(body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController()
  mocks.abortRequest = () => controller.abort()
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', ...body }),
      signal: controller.signal
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

function send(): Promise<Response> {
  return post({
    content: 'FIRST',
    messageId: FIRST_REPLY,
    messages: [{ id: 'msg-user-1', role: 'user', content: 'FIRST' }]
  })
}

/** A message the user typed while the first reply ran: a steer or a queued one, never delivered. */
function typeWhileItRuns(steerId: string, text: string, deliver: 'now' | 'end' = 'end') {
  const accepted = enqueueSteer(SESSION, {
    steerId,
    messageId: FIRST_REPLY,
    text,
    at: new Date().toISOString(),
    source: 'user',
    deliver
  })
  expect(accepted.ok).toBe(true)
}

async function chat() {
  const messages = (await redis.getMessages(SESSION)) as any[]
  const byId = new Map(messages.map((message) => [message.id, message]))
  return { messages, byId, ids: messages.map((message) => message.id) }
}

const userMessage = (metadata: Record<string, unknown> = {}) => ({
  id: 'msg-user-1',
  session_id: SESSION,
  user_id: USER,
  role: 'user',
  content: 'List the folder.',
  created_at: '2026-09-27T01:00:00.000Z',
  metadata
})

/** What the page stores on its own message for a send in a project, in Voice Mode. */
const PAGE_SEND_FACTS = { client_sent: true, projectPath: '/work/probe', stt: true, tts: true, voiceMode: true }

/** The paused half of a reply, as its finish left it: its card and its replayable transcript. */
const cardMessage = (overrides: Record<string, unknown> = {}) => ({
  id: CARD,
  session_id: SESSION,
  user_id: USER,
  agent_id: AGENT,
  role: 'assistant',
  status: 'complete',
  content: 'I need to list the folder.',
  created_at: '2026-09-27T01:00:05.000Z',
  metadata: {
    model: 'claude-sonnet-5',
    agentType: 'api',
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
      approvals: [
        { approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', input: { command: 'ls' } }
      ],
      source: 'vercel'
    },
    ...overrides
  }
})

/** The words the user typed before the card, held for it (what Part 1 writes). */
const heldMessage = (cardMessageId = CARD) => ({
  id: HELD,
  session_id: SESSION,
  user_id: USER,
  agent_id: AGENT,
  role: 'user',
  status: 'complete',
  content: 'Then tell me which file is biggest.',
  created_at: '2026-09-27T01:00:06.000Z',
  metadata: { steerPromoted: { steerIds: [HELD] }, waitsForApproval: { messageId: cardMessageId } }
})

async function seedPausedChat(
  options: {
    card?: ReturnType<typeof cardMessage>
    held?: ReturnType<typeof heldMessage>
    after?: any[]
    user?: ReturnType<typeof userMessage>
  } = {}
) {
  const records = [
    options.user ?? userMessage(),
    options.card ?? cardMessage(),
    options.held ?? heldMessage(),
    ...(options.after ?? [])
  ]
  for (const record of records) await redis.saveMessage(record as any)
  return records
}

/** The page's own Approve (or Deny) click on the card. */
function click(options: { approvalId?: string; approved?: boolean; messages?: any[]; card?: any } = {}): Promise<Response> {
  const card = options.card ?? cardMessage()
  return post({
    content: '',
    messageId: CARD,
    messages: options.messages ?? [userMessage(), card, heldMessage()],
    metadata: {
      ...card.metadata,
      toolApprovalMode: 'all',
      toolApprovalResponse: [
        {
          type: 'tool-approval-response',
          approvalId: options.approvalId ?? APPROVAL,
          approved: options.approved ?? true,
          reason: options.approved === false ? 'User denied' : 'User approved'
        }
      ]
    }
  })
}

describe('send-routed: words that wait at an approval card (BL-455, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl455-${count}`
    mocks.session = SESSION
    mocks.modelRuns.clear()
    mocks.brainRuns = []
    mocks.compiledCurrent = []
    mocks.compiledHistory = []
    mocks.compiledFrom = []
    mocks.compiledProject = []
    mocks.compiledVoiceTts = []
    mocks.emptyCompiles = new Set()
    mocks.userEvents = []
    mocks.typedDuring = new Set()
    mocks.abortRequest = null
    forwards = []
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    // The `/api/sse` forwards answer at once; the test reads which ones went.
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
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
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
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-455', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  describe('the reply stops at a card: the words are held, no turn runs', () => {
    it('control: with no card, a queued message is promoted and answered in a second turn', async () => {
      typeWhileItRuns('msg-queued-1', 'SECOND')
      const response = await send()
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      const { byId } = await chat()
      expect(byId.get('msg-queued-1')?.metadata?.waitsForApproval).toBeUndefined()
    }, 30_000)

    it('the promoted run saves its exact awaiting relation on the card for cold reload before a recorded resume', async () => {
      mocks.modelRuns.set(2, 'card')
      typeWhileItRuns('voice-promoted-card', 'SECOND')
      expect((await send()).status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      expect((await chat()).byId.get(mocks.brainRuns[1])?.metadata.steerPromoted).toEqual({
        steerIds: ['voice-promoted-card'], disposition: 'awaiting_approval', approvalResumeVersion: 0 })
    }, 30_000)

    it('a queued message waits for the card: one saved message that names it, and no second turn (BL-524)', async () => {
      mocks.modelRuns.set(1, 'card')
      typeWhileItRuns('msg-queued-1', 'SECOND')

      const response = await send()
      expect(response.status).toBe(200)
      // No turn beside the card.
      expect(mocks.brainRuns).toEqual([FIRST_REPLY])
      expect(mocks.compiledCurrent).toHaveLength(1)

      const { ids, byId } = await chat()
      expect(ids).toEqual([FIRST_REPLY, 'msg-queued-1'])
      expect(byId.get(FIRST_REPLY)?.metadata?.toolApprovals?.approvals?.[0]).toMatchObject({ status: 'pending' })
      expect(byId.get('msg-queued-1')).toMatchObject({
        role: 'user',
        user_id: USER,
        content: 'SECOND',
        metadata: {
          steerPromoted: { steerIds: ['msg-queued-1'] },
          waitsForApproval: { messageId: FIRST_REPLY }
        }
      })
      expect(byId.get('msg-queued-1')?.metadata?.wake).toBeUndefined()

      // Every tab turns the bubble into the message, as for a promotion.
      const sent = forwards.filter((body) => body.type === 'user_message' || body.type === 'steer_promoted')
      expect(sent.map((body) => body.type)).toEqual(['user_message', 'steer_promoted'])
      expect(sent[0].message).toMatchObject({ id: 'msg-queued-1', metadata: { waitsForApproval: { messageId: FIRST_REPLY } } })
      expect(sent[1].steerIds).toEqual(['msg-queued-1'])
    }, 30_000)

    it('a steer that found no tool boundary waits too, joined with a queued message into ONE message in order', async () => {
      mocks.modelRuns.set(1, 'card')
      typeWhileItRuns('msg-steer-1', 'Actually use the other folder.', 'now')
      typeWhileItRuns('msg-queued-2', 'And then summarise it.', 'end')

      await send()
      expect(mocks.brainRuns).toEqual([FIRST_REPLY])
      const { ids, byId } = await chat()
      expect(ids).toEqual([FIRST_REPLY, 'msg-steer-1'])
      expect(byId.get('msg-steer-1')).toMatchObject({
        content: 'Actually use the other folder.\n\nAnd then summarise it.',
        metadata: {
          steerPromoted: { steerIds: ['msg-steer-1', 'msg-queued-2'] },
          waitsForApproval: { messageId: FIRST_REPLY }
        }
      })
    }, 30_000)

    it('a chain that hits its promotion bound at a card holds the rest for that card', async () => {
      // The first reply and three promoted turns (the safety bound); the last one stops at a card
      // with one more message typed into it.
      typeWhileItRuns('msg-queued-1', 'SECOND')
      for (const run of [2, 3, 4]) mocks.typedDuring.add(run)
      mocks.modelRuns.set(4, 'card')

      await send()
      expect(mocks.brainRuns).toHaveLength(4)
      const lastRun = mocks.brainRuns[3]
      const { ids, byId } = await chat()
      expect(ids.at(-1)).toBe('msg-typed-in-run-4')
      expect(byId.get('msg-typed-in-run-4')?.metadata?.waitsForApproval).toEqual({ messageId: lastRun })
      expect(byId.get('msg-typed-in-run-3')?.metadata?.waitsForApproval).toBeUndefined()
    }, 30_000)

    it('a card with nothing typed writes nothing', async () => {
      mocks.modelRuns.set(1, 'card')
      await send()
      expect(mocks.brainRuns).toEqual([FIRST_REPLY])
      const { ids } = await chat()
      expect(ids).toEqual([FIRST_REPLY])
      expect(forwards.some((body) => body.type === 'steer_promoted')).toBe(false)
    }, 30_000)
  })

  describe('a promoted message is the user\u2019s words (found beside BL-455)', () => {
    it('in a woken chat, the promoted steer compiles as the user, not as Batshit', async () => {
      typeWhileItRuns('msg-queued-1', 'Stop after the first file, please.')
      const response = await post({
        content: 'A DM from Cooper: check the build.',
        messageId: FIRST_REPLY,
        messages: [{ id: 'msg-wake-1', role: 'user', content: 'A DM from Cooper: check the build.' }],
        metadata: { wake: { chainDepth: 1, origin: { kind: 'dm' } } }
      })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      // The woken turn's own message is Batshit's; the words the user typed into it are the user's.
      expect(mocks.compiledFrom).toEqual(['batshit', 'user'])
      expect(mocks.compiledCurrent[1]).toBe('Stop after the first file, please.')
    }, 30_000)
  })
  describe('the click\u2019s resumed reply ends: the held message is answered', () => {
    it('Approve: the resume runs, then the held words are answered in their own reply, in this request', async () => {
      await seedPausedChat()
      const response = await click()
      expect(response.status).toBe(200)

      // The resume (into the card's message), then one follow-up turn for the held words.
      expect(mocks.brainRuns).toHaveLength(2)
      const [resumed, followUp] = mocks.brainRuns
      expect(resumed).toBe(CARD)
      expect(followUp).not.toBe(CARD)
      expect(mocks.compiledCurrent[1]).toBe('Then tell me which file is biggest.')
      expect(mocks.compiledFrom[1]).toBe('user')

      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD, followUp])
      expect(byId.get(CARD)?.content).toContain(`Reply for ${CARD}.`)
      expect(byId.get(followUp)).toMatchObject({ role: 'assistant', content: `Reply for ${followUp}.` })
      // An ordinary turn: it carries none of the click's approval answer.
      expect(warnSpy).not.toHaveBeenCalledWith(STALE_APPROVAL_WARNING, expect.anything())
    }, 30_000)

    it('Deny on the API lane: the resume answers the denial, then the held words', async () => {
      await seedPausedChat()
      const response = await click({ approved: false })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      expect(mocks.compiledCurrent[1]).toBe('Then tell me which file is biggest.')
      expect((await chat()).byId.get(mocks.brainRuns[1])?.metadata?.steerPromoted?.steerIds).toContain(HELD)
    }, 30_000)

    it('an API resume that cannot allocate the held answer leaves its exact saved words visibly unanswered', async () => {
      await seedPausedChat()
      const ids = await import('$lib/utils/messageId')
      vi.spyOn(ids, 'generateMessageId').mockResolvedValueOnce(null)
      expect((await click()).status).toBe(200)
      expect(mocks.brainRuns).toEqual([CARD])
      expect((await chat()).byId.get(HELD)).toMatchObject({ content: 'Then tell me which file is biggest.', metadata: {
        waitsForApproval: { messageId: CARD },
        steerPromoted: { steerIds: [HELD], disposition: 'unanswered', reason: 'reply_failed' } } })
      expect(forwards.some(body => body.type === 'user_message' && body.message?.id === HELD &&
        body.message?.metadata?.steerPromoted?.disposition === 'unanswered')).toBe(true)
    }, 30_000)

    it('a second card keeps it waiting: no follow-up turn', async () => {
      await seedPausedChat()
      mocks.modelRuns.set(1, 'card')
      const response = await click()
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toEqual([CARD])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(HELD)?.metadata?.waitsForApproval).toEqual({ messageId: CARD })
      expect(byId.get(CARD)?.metadata?.toolApprovals?.approvals?.some((entry: any) => entry.status === 'pending')).toBe(true)
    }, 30_000)

    it('a second card, with more words typed during the resume: they wait too, and the next click answers the last one', async () => {
      await seedPausedChat()
      mocks.modelRuns.set(1, 'card')
      const accepted = enqueueSteer(SESSION, {
        steerId: 'msg-held-2',
        messageId: CARD,
        text: 'Skip hidden files.',
        at: new Date().toISOString(),
        source: 'user',
        deliver: 'end'
      })
      expect(accepted.ok).toBe(true)

      await click()
      expect(mocks.brainRuns).toEqual([CARD])
      let { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD, 'msg-held-2'])
      expect(byId.get('msg-held-2')?.metadata?.waitsForApproval).toEqual({ messageId: CARD })

      // The second card is on the same message; its click resumes and answers the newest held message.
      const secondCard = byId.get(CARD)
      const secondApproval = secondCard.metadata.toolApprovals.approvals.find((entry: any) => entry.status === 'pending')
      const response = await click({
        approvalId: secondApproval.approvalId,
        card: secondCard,
        messages: [userMessage(), secondCard, byId.get(HELD), byId.get('msg-held-2')]
      })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(3)
      expect(mocks.brainRuns[1]).toBe(CARD)
      expect(mocks.compiledCurrent.at(-1)).toBe('Skip hidden files.')
      ;({ ids } = await chat())
      expect(ids).toEqual(['msg-user-1', CARD, HELD, 'msg-held-2', mocks.brainRuns[2]])
      expect((await chat()).byId.get(mocks.brainRuns[2])?.metadata?.steerPromoted?.steerIds).toEqual([HELD, 'msg-held-2'])
    }, 30_000)

    it('Stop during the resume keeps it unanswered: Stop means stop', async () => {
      await seedPausedChat()
      mocks.modelRuns.set(1, 'stopped')
      const response = await click()
      expect(response.status).toBe(499)
      expect(mocks.brainRuns).toEqual([CARD])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(CARD)?.metadata?.interrupted).toBe(true)
      expect(byId.get(HELD)?.metadata?.steerPromoted).toMatchObject({ steerIds: [HELD], disposition: 'unanswered', reason: 'stopped' })
    }, 30_000)

    it('a Stop in the gap after the resumed reply (its lock cleared) runs no follow-up', async () => {
      await seedPausedChat()
      mocks.modelRuns.set(1, 'reply-then-lock-cleared')
      const response = await click()
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toEqual([CARD])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(HELD)?.metadata?.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'reply_failed' })
    }, 30_000)

    it('a later message stops the follow-up: a later turn has read the words already', async () => {
      const later = [
        { id: 'msg-later', session_id: SESSION, user_id: USER, role: 'user', content: 'Never mind.', created_at: '2026-09-27T01:01:00.000Z', metadata: {} },
        { id: 'msg-later-reply', session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', status: 'complete', content: 'OK.', created_at: '2026-09-27T01:01:05.000Z', metadata: {} }
      ]
      const records = await seedPausedChat({ after: later })
      const response = await click({ messages: records })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toEqual([CARD])
      const { ids } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD, 'msg-later', 'msg-later-reply'])
    }, 30_000)

    it('a click on another card leaves a message held for a different card alone', async () => {
      await seedPausedChat({ held: heldMessage('msg-some-other-card') })
      await click({ messages: [userMessage(), cardMessage(), heldMessage('msg-some-other-card')] })
      expect(mocks.brainRuns).toEqual([CARD])
    }, 30_000)

    it('the page\u2019s own Deny of an EXPIRED card is not the user\u2019s click: the resume ends the card, and the held words wait', async () => {
      // A card raised four minutes ago: past its three minutes. A tab that shows it marks it expired
      // and submits it as a Deny by itself (`processExpiredApprovals`, `buildToolApprovalResponses`).
      const fourMinutesAgo = new Date(Date.now() - 4 * 60_000).toISOString()
      const card = cardMessage({
        toolApprovals: {
          mode: 'all',
          source: 'vercel',
          approvals: [
            {
              approvalId: APPROVAL,
              toolCallId: 'call_ls',
              toolName: 'native_bash_execute',
              status: 'pending',
              input: { command: 'ls' },
              requestedAt: fourMinutesAgo,
              expiresAt: new Date(Date.now() - 60_000).toISOString()
            }
          ]
        }
      })
      await seedPausedChat({ card })
      const response = await post({
        content: '',
        messageId: CARD,
        messages: [userMessage(), card, heldMessage()],
        metadata: {
          ...card.metadata,
          toolApprovalResponse: [
            { type: 'tool-approval-response', approvalId: APPROVAL, approved: false, reason: 'Approval expired after 3 minutes' }
          ]
        }
      })
      expect(response.status).toBe(200)
      // The resume ends the card (it says the command did not run), and nothing answers the words.
      expect(mocks.brainRuns).toEqual([CARD])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(HELD)?.metadata?.approvalCardExpired).toBe(true)
      expect(byId.get(HELD)?.metadata?.steerPromoted).toMatchObject({ steerIds: [HELD], disposition: 'unanswered', reason: 'approval_expired' })
      // Every tab hears it before the resume runs.
      expect(forwards.find((body) => body.type === 'user_message')?.message).toMatchObject({
        id: HELD,
        metadata: { approvalCardExpired: true, waitsForApproval: { messageId: CARD } }
      })
    }, 30_000)

    // BL-905: only a REPLY after the held words means a later turn read them. A user message with
    // no reply after it (a send the chat's line kept at the same card) leaves them waiting.
    it('the expiry marks nothing once a reply follows the held message: a later turn read it', async () => {
      const fourMinutesAgo = new Date(Date.now() - 4 * 60_000).toISOString()
      const card = cardMessage({
        toolApprovals: {
          mode: 'all',
          source: 'vercel',
          approvals: [
            { approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', requestedAt: fourMinutesAgo, expiresAt: fourMinutesAgo }
          ]
        }
      })
      const later = { id: 'msg-later', session_id: SESSION, user_id: USER, role: 'user', content: 'Never mind.', created_at: '2026-09-27T01:01:00.000Z', metadata: {} }
      const laterReply = { id: 'msg-later-reply', session_id: SESSION, user_id: USER, role: 'assistant', content: 'OK.', created_at: '2026-09-27T01:01:30.000Z', metadata: {} }
      const records = await seedPausedChat({ card, after: [later, laterReply] })
      await post({
        content: '',
        messageId: CARD,
        messages: records,
        metadata: {
          ...card.metadata,
          toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: false, reason: 'Approval expired after 3 minutes' }]
        }
      })
      const { byId } = await chat()
      expect(byId.get('msg-later')?.metadata?.approvalCardExpired).toBeUndefined()
      expect(byId.get(HELD)?.metadata?.approvalCardExpired).toBeUndefined()
    }, 30_000)

    it('the expiry marks the held message behind a kept send that no reply follows (BL-905)', async () => {
      const fourMinutesAgo = new Date(Date.now() - 4 * 60_000).toISOString()
      const card = cardMessage({
        toolApprovals: {
          mode: 'all',
          source: 'vercel',
          approvals: [
            { approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', requestedAt: fourMinutesAgo, expiresAt: fourMinutesAgo }
          ]
        }
      })
      const later = { id: 'msg-later', session_id: SESSION, user_id: USER, role: 'user', content: 'Look at this file.', created_at: '2026-09-27T01:01:00.000Z', metadata: {} }
      const records = await seedPausedChat({ card, after: [later] })
      await post({
        content: '',
        messageId: CARD,
        messages: records,
        metadata: {
          ...card.metadata,
          toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: false, reason: 'Approval expired after 3 minutes' }]
        }
      })
      const { byId } = await chat()
      expect(byId.get('msg-later')?.metadata?.approvalCardExpired).toBeUndefined()
      expect(byId.get(HELD)?.metadata?.approvalCardExpired).toBe(true)
    }, 30_000)

    it('a user\u2019s late Approve on an expired card is still the user\u2019s click: it becomes a Deny, and the held words are answered', async () => {
      const card = cardMessage({
        toolApprovals: {
          mode: 'all',
          source: 'vercel',
          approvals: [
            {
              approvalId: APPROVAL,
              toolCallId: 'call_ls',
              toolName: 'native_bash_execute',
              status: 'pending',
              input: { command: 'ls' },
              requestedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
              expiresAt: new Date(Date.now() - 60_000).toISOString()
            }
          ]
        }
      })
      await seedPausedChat({ card })
      const response = await click({ card })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      expect(mocks.compiledCurrent[1]).toBe('Then tell me which file is biggest.')
      const { byId } = await chat()
      expect(byId.get(HELD)?.metadata?.approvalCardExpired).toBeUndefined()
    }, 30_000)

    it('a refused click (already answered) runs nothing and changes nothing', async () => {
      const card = cardMessage({ answeredApprovalIds: [APPROVAL] })
      await seedPausedChat({ card })
      const response = await click({ card })
      expect(response.status).toBe(409)
      expect(((await response.json()) as any).code).toBe('approval_already_answered')
      expect(mocks.brainRuns).toEqual([])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(HELD)).toMatchObject({ content: 'Then tell me which file is biggest.' })
    }, 30_000)

    it('a resume that fails mid-reply runs no follow-up: the held message stays unanswered', async () => {
      await seedPausedChat()
      mocks.modelRuns.set(1, 'words-then-error')
      const response = await click()
      expect(response.ok).toBe(false)
      expect(mocks.brainRuns).toEqual([CARD])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(CARD)?.metadata?.response_failed).toBe(true)
      expect(byId.get(HELD)?.metadata?.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'reply_failed' })
    }, 30_000)

    it('a resume refused inside the run (its step missing from the saved reply) runs no follow-up', async () => {
      const card = cardMessage({ providerMessages: [] })
      await seedPausedChat({ card })
      const response = await click({ card })
      expect(response.ok).toBe(false)
      expect(mocks.brainRuns).toEqual([])
      const { ids, byId } = await chat()
      expect(ids.slice(0, 3)).toEqual(['msg-user-1', CARD, HELD])
      expect(ids.filter((id) => id !== CARD && !['msg-user-1', HELD].includes(id))).toEqual([])
      expect(byId.get(HELD)?.metadata?.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'reply_failed' })
    }, 30_000)
  })
  describe('exact successor ownership corrective boundaries (V2)', () => {
    it('a typed turn assigns held words to the first run actually compiling them, without browser-forged ids', async () => {
      const records = await seedPausedChat()
      const typed = { ...userMessage(), id: 'typed-after-hold', content: 'Now answer both.', created_at: '2026-09-27T01:00:07.000Z' }
      await redis.saveMessage(typed as any)
      const response = await post({ content: typed.content, messageId: FIRST_REPLY, messages: [...records, typed],
        metadata: { steerPromoted: { steerIds: ['browser-forgery'] } } })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toEqual([FIRST_REPLY])
      expect(mocks.compiledHistory[0].some(row => row.id === HELD && row.content === heldMessage().content)).toBe(true)
      expect((await chat()).byId.get(FIRST_REPLY)?.metadata.steerPromoted.steerIds).toEqual([HELD])
    }, 30_000)
    it('a typed steer promoted after a resume owns the held words it actually reads as well', async () => {
      await seedPausedChat()
      mocks.typedDuring.add(1)
      expect((await click()).status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      expect(mocks.compiledHistory[1].some(row => row.id === HELD)).toBe(true)
      expect((await chat()).byId.get(mocks.brainRuns[1])?.metadata.steerPromoted.steerIds).toEqual(['msg-typed-in-run-1', HELD])
    }, 30_000)
    it('a stream-only Stop classifies its unlanded steer as stopped although the session-turn signal was not aborted', async () => {
      mocks.modelRuns.set(1, 'stopped-stream')
      typeWhileItRuns('stop-owned-steer', 'words for stopped reply')
      expect((await send()).status).toBe(499)
      expect(forwards.find(body => body.type === 'steer_promoted' && body.steerIds?.includes('stop-owned-steer')))
        .toMatchObject({ metadata: { steerPromoted: { disposition: 'unanswered', reason: 'stopped' } } })
    }, 30_000)
    it('a post-click card read failure writes visible failure and exact held refusal, rather than an empty-history run', async () => {
      await seedPausedChat()
      const resume = await import('$lib/server/services/approvalResumeMessage')
      vi.spyOn(resume, 'readStoredAssistantRecord').mockRejectedValueOnce(new Error('card read unavailable after click'))
      const response = await click()
      expect(response.status).toBe(500)
      expect(mocks.brainRuns).toEqual([])
      expect((await chat()).byId.get(CARD)?.metadata.response_failed).toBe(true)
      expect((await chat()).byId.get(HELD)?.metadata.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'reply_failed' })
    }, 30_000)
  })

  describe('the answer runs as the send did: its project and its voice (BL-455 review D1)', () => {
    it('Approve: the held words compile in the paused send\u2019s project and in Voice Mode, not with the card\u2019s metadata', async () => {
      // A message held before this fix carries no facts: they come from the user message that
      // raised the card, the way the resume finds its own project.
      await seedPausedChat({ user: userMessage(PAGE_SEND_FACTS) })
      const response = await click({ messages: [userMessage(PAGE_SEND_FACTS), cardMessage(), heldMessage()] })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(2)
      const followUp = mocks.brainRuns[1]
      // The resume compiles its own paused turn's project (BL-322); the follow-up the same.
      expect(mocks.compiledProject).toEqual(['/work/probe', '/work/probe'])
      expect(mocks.compiledVoiceTts[1]).toBe(true)
      const { byId } = await chat()
      // The reply is marked for speech, so a tab in Voice Mode speaks it.
      expect(byId.get(followUp)?.metadata?.voice).toMatchObject({ tts: true, voiceMode: 'voice' })
    }, 30_000)

    it('the hold keeps the send\u2019s facts on the held message, and the answer uses them', async () => {
      // The page saves its message before it posts. The SEND carries more facts than the message
      // keeps (Goons, the approval mode, a project the page set for this send only), so the facts
      // the hold writes are the ones that count; here the saved message keeps none.
      await redis.saveMessage(userMessage() as any)
      mocks.modelRuns.set(1, 'card')
      typeWhileItRuns('msg-queued-1', 'SECOND')
      const sent = await post({
        content: 'List the folder.',
        messageId: FIRST_REPLY,
        messages: [userMessage(PAGE_SEND_FACTS)],
        metadata: { projectPath: '/work/probe', stt: true, tts: true, voiceMode: 'voice' }
      })
      expect(sent.status).toBe(200)
      let { byId } = await chat()
      const held = byId.get('msg-queued-1')
      expect(held?.metadata).toMatchObject({
        projectPath: '/work/probe',
        tts: true,
        voiceMode: 'voice',
        waitsForApproval: { messageId: FIRST_REPLY }
      })
      // The words were typed, so the held message is not marked spoken.
      expect(held?.metadata?.stt).toBeUndefined()

      // The page's click on that card: the card's own metadata, which carries no project.
      const card = byId.get(FIRST_REPLY)
      const approval = card.metadata.toolApprovals.approvals[0]
      const response = await post({
        content: '',
        messageId: FIRST_REPLY,
        messages: [userMessage(), card, held],
        metadata: {
          ...card.metadata,
          toolApprovalResponse: [
            { type: 'tool-approval-response', approvalId: approval.approvalId, approved: true, reason: 'User approved' }
          ]
        }
      })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toHaveLength(3)
      expect(mocks.compiledCurrent.at(-1)).toBe('SECOND')
      expect(mocks.compiledProject.at(-1)).toBe('/work/probe')
      expect(mocks.compiledVoiceTts.at(-1)).toBe(true)
      ;({ byId } = await chat())
      expect(byId.get(mocks.brainRuns[2])?.metadata?.voice).toMatchObject({ tts: true })
    }, 30_000)

    it('a message typed into the resume is promoted with the paused send\u2019s project too', async () => {
      // No held message this time: the chat ends with the card.
      for (const record of [userMessage(PAGE_SEND_FACTS), cardMessage()]) await redis.saveMessage(record as any)
      const accepted = enqueueSteer(SESSION, {
        steerId: 'msg-steer-in-resume',
        messageId: CARD,
        text: 'And the hidden ones.',
        at: new Date().toISOString(),
        source: 'user',
        deliver: 'end'
      })
      expect(accepted.ok).toBe(true)
      await click({ messages: [userMessage(PAGE_SEND_FACTS), cardMessage()] })
      expect(mocks.brainRuns).toHaveLength(2)
      expect(mocks.compiledCurrent[1]).toBe('And the hidden ones.')
      expect(mocks.compiledProject[1]).toBe('/work/probe')
      const { byId } = await chat()
      expect(byId.get('msg-steer-in-resume')?.metadata).toMatchObject({ projectPath: '/work/probe', tts: true })
    }, 30_000)
  })

  describe('a control card on a CLI lane (no in-place resume)', () => {
    /** A Fabric control card on a managed CLI lane: its click starts a new turn, or none for a Deny. */
    async function seedCliCard() {
      const record = await createPendingApproval({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        messageId: CARD,
        controlId: 'sys.skill.import',
        controlTitle: 'Skill Import',
        riskLevel: 'confirm',
        lane: 'cli',
        input: { source: 'https://example.com/skill.zip' }
      })
      const card = cardMessage({
        providerMessages: undefined,
        toolApprovals: {
          mode: 'all',
          source: 'fabric',
          approvals: [
            {
              approvalId: record.id,
              status: 'pending',
              requestedAt: record.requestedAt,
              toolName: 'native_batshit_tool_use',
              source: 'fabric',
              control: {
                approvalId: record.id,
                controlId: record.controlId,
                controlTitle: record.controlTitle,
                riskLevel: record.riskLevel,
                input: { source: 'https://example.com/skill.zip' },
                inputSummary: record.inputSummary,
                lane: 'cli'
              }
            }
          ]
        }
      })
      return { record, card }
    }

    it('Approve: the click\u2019s own resume turn comes after the held message and reads it; no second follow-up', async () => {
      const { record, card } = await seedCliCard()
      await seedPausedChat({ card })
      const response = await click({ card, approvalId: record.id })
      expect(response.status).toBe(200)
      // One turn: the resume turn, whose compile has the held message in its history.
      expect(mocks.brainRuns).toHaveLength(1)
      expect(String(mocks.compiledCurrent[0])).toContain('Approved: Skill Import')
      const { ids, byId } = await chat()
      expect(ids.slice(0, 3)).toEqual(['msg-user-1', CARD, HELD])
      expect(ids).toHaveLength(5)
      expect(byId.get(ids[3])).toMatchObject({ role: 'user', metadata: { approvalResume: { approvalIds: [record.id] } } })
      expect(ids[4]).toBe(mocks.brainRuns[0])
      expect(byId.get(ids[4])?.metadata?.steerPromoted?.steerIds).toContain(HELD)
    }, 30_000)

    it('Deny with words held for the card: the held words are answered now, as their own turn', async () => {
      const { record, card } = await seedCliCard()
      await seedPausedChat({ card, user: userMessage(PAGE_SEND_FACTS) })
      const response = await click({ card, approvalId: record.id, approved: false })
      expect(response.status).toBe(200)
      expect(((await response.json()) as any).approvalResume).toBeUndefined()
      expect(mocks.brainRuns).toHaveLength(1)
      expect(mocks.compiledCurrent[0]).toBe('Then tell me which file is biggest.')
      expect(mocks.compiledFrom[0]).toBe('user')
      // In the paused send's project, and in its voice mode (BL-455 review D1).
      expect(mocks.compiledProject[0]).toBe('/work/probe')
      expect(mocks.compiledVoiceTts[0]).toBe(true)
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD, mocks.brainRuns[0]])
      // An ordinary turn: it carries none of the click's approval answer.
      expect(byId.get(mocks.brainRuns[0])).toMatchObject({ role: 'assistant' })
      expect(warnSpy).not.toHaveBeenCalledWith(STALE_APPROVAL_WARNING, expect.anything())
    }, 30_000)

    it('a held turn after a Deny that fails before its stream opens fails in its own reply, not as a resume', async () => {
      const { record, card } = await seedCliCard()
      await seedPausedChat({ card })
      mocks.emptyCompiles.add(1)
      const response = await click({ card, approvalId: record.id, approved: false })
      expect(response.ok).toBe(false)
      expect(mocks.brainRuns).toEqual([])
      const { ids, byId } = await chat()
      expect(ids.slice(0, 3)).toEqual(['msg-user-1', CARD, HELD])
      expect(ids).toHaveLength(4)
      expect(byId.get(ids[3])).toMatchObject({ role: 'assistant', status: 'error', metadata: { response_failed: true, steerPromoted: { steerIds: [HELD] } } })
      // A new turn's failure, not an approval resume's: the card's message is untouched.
      expect(byId.get(CARD)?.metadata?.response_failed).toBeUndefined()
      const reasons = mocks.userEvents
        .filter((event) => event.type === 'session_messages_changed')
        .map((event) => event.reason)
      expect(reasons).toContain('turn_failed')
      expect(reasons).not.toContain('approval_resume')
    }, 30_000)

    it('a Deny that carries only the expiry reason is not the user\u2019s click: nothing held is run', async () => {
      // A CLI control card has no three-minute clock, so the page never sends this for one; the
      // server still asks the answer itself, the same rule as on the API lane.
      const { record, card } = await seedCliCard()
      card.metadata.steerPromoted = { steerIds: ['spoken-card'], disposition: 'awaiting_approval', approvalResumeVersion: 10 }
      card.metadata.steers = [{ steerId: 'delivered-card', source: 'user' }, { steerId: 'dm-card', source: 'dm' }]
      await seedPausedChat({ card })
      const response = await post({
        content: '',
        messageId: CARD,
        messages: [userMessage(), card, heldMessage()],
        metadata: {
          ...card.metadata,
          toolApprovalResponse: [
            { type: 'tool-approval-response', approvalId: record.id, approved: false, reason: 'Approval expired after 3 minutes' }
          ]
        }
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as any).approvalResume).toBe('denied')
      expect(mocks.brainRuns).toEqual([])
      const { ids, byId } = await chat()
      expect(ids).toEqual(['msg-user-1', CARD, HELD])
      expect(byId.get(CARD)?.metadata.steerPromoted).toEqual({
        steerIds: ['spoken-card', 'delivered-card'], disposition: 'unanswered', reason: 'approval_expired' })
      expect(byId.get(HELD)?.metadata.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'approval_expired' })
      expect(forwards.some(body => body.type === 'complete_message' && body.message?.id === CARD &&
        body.message.metadata.steerPromoted.reason === 'approval_expired')).toBe(true)
    }, 30_000)

    it('recorded CLI Deny without held words gives only its saved card steers an exact terminal', async () => {
      const { record, card } = await seedCliCard()
      card.metadata.steerPromoted = { steerIds: ['spoken-card'] }
      for (const message of [userMessage(), card]) await redis.saveMessage(message as any)
      const response = await click({ card, approvalId: record.id, approved: false, messages: [userMessage(), card] })
      expect(response.status).toBe(200)
      expect(mocks.brainRuns).toEqual([])
      expect((await chat()).byId.get(CARD)?.metadata.steerPromoted).toEqual({
        steerIds: ['spoken-card'], disposition: 'unanswered', reason: 'approval_denied' })
      expect(forwards.some(body => body.type === 'complete_message' && body.message?.id === CARD)).toBe(true)
    }, 30_000)

    it('a strict held-history failure after a recorded CLI approval is visible and runs no model', async () => {
      const { record, card } = await seedCliCard()
      await seedPausedChat({ card })
      const restoreSave = installTrustedCardSaveMerge()
      const update = vi.mocked(redis.updateMessage)
      // This facade method is already vi.fn: delegate to its implementation,
      // not the mock dispatcher whose implementation we are replacing.
      let armed = false
      update.mockImplementation(async (...args: Parameters<typeof redis.updateMessage>) => {
        const result = await originalUpdateMessage.apply(redis, args)
        if (!armed && (args[2] as any)?.metadata?.answeredApprovalIds?.includes(record.id)) {
          armed = true
          vi.spyOn(redis, 'getRecentMessages').mockRejectedValueOnce(new Error('held history unavailable after click'))
        }
        return result
      })
      try {
        const response = await click({ card, approvalId: record.id })
        expect(armed).toBe(true)
        expect(response.status).toBe(500)
        expect(await response.json()).toMatchObject({ details: 'held history unavailable after click' })
        expect(mocks.brainRuns).toEqual([])
        expect((await chat()).byId.get(CARD)?.metadata).toMatchObject({ response_failed: true, answeredApprovalIds: [record.id] })
        expect((await chat()).byId.get(HELD)?.metadata.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'reply_failed' })
      } finally {
        // spyOn an existing vi.fn is not a new registered spy. Restore its
        // implementation/once queue explicitly, even if an assertion fails.
        update.mockRestore()
        vi.mocked(redis.getRecentMessages).mockRestore()
        restoreSave()
      }
    }, 30_000)

    it.each(['reply-id', 'user-save'] as const)('a recorded CLI approval whose %s preparation fails terminates the exact card and held waits', async failure => {
      const { record, card } = await seedCliCard()
      card.metadata.steerPromoted = { steerIds: ['spoken-card'], disposition: 'awaiting_approval', approvalResumeVersion: 0 }
      card.metadata.imageOriginExpected = true
      card.metadata.imageOriginExpectedVersion = 53
      card.content = 'May I? ![Prior picture](https://example.com/prior.png)'
      await seedPausedChat({ card })
      const restoreSave = installTrustedCardSaveMerge()
      if (failure === 'reply-id') {
        const ids = await import('$lib/utils/messageId')
        vi.spyOn(ids, 'generateMessageId').mockResolvedValueOnce('resume-user').mockResolvedValueOnce(null)
      } else {
        const save = vi.mocked(redis.saveMessage)
        // The local merge adapter above has no once queue and must stay inside this wrapper.
        const originalSave = save.getMockImplementation()!
        save.mockImplementation(async (...args: Parameters<typeof redis.saveMessage>) => {
          if ((args[0] as any)?.metadata?.approvalResume?.approvalIds?.includes(record.id)) {
            throw new Error('resume user save unavailable')
          }
          return originalSave.apply(redis, args)
        })
      }
      try {
        expect((await click({ card, approvalId: record.id })).status).toBe(500)
        expect(mocks.brainRuns).toEqual([])
        const { byId } = await chat()
        expect(byId.get(CARD)).toMatchObject({ role: 'assistant', status: 'error', metadata: {
          response_failed: true, steerPromoted: { steerIds: ['spoken-card'] },
          imageOriginExpectedVersion: 53 } })
        expect(byId.get(CARD)?.content).toBe(card.content)
        expect(byId.get(HELD)?.metadata.steerPromoted).toMatchObject({ disposition: 'unanswered', reason: 'reply_failed' })
        expect(mocks.userEvents.some(event => event.type === 'session_messages_changed' && event.reason === 'approval_resume')).toBe(true)
      } finally {
        restoreSave()
      }
    }, 30_000)

    it('control: Deny with nothing held starts no turn, as before', async () => {
      const { record, card } = await seedCliCard()
      for (const message of [userMessage(), card]) await redis.saveMessage(message as any)
      const response = await click({ card, approvalId: record.id, approved: false, messages: [userMessage(), card] })
      expect(response.status).toBe(200)
      expect(((await response.json()) as any).approvalResume).toBe('denied')
      expect(mocks.brainRuns).toEqual([])
    }, 30_000)
  })
})
