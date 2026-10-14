// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { createPendingApproval } from '$lib/server/services/controlApprovals'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { loadPostTurnRecord, writePostTurnRecord } from '$lib/server/services/postTurnCheckState'

/**
 * BL-527 — the Judge Juice after-reply steps (Check Replies and smart zip's rezip) judge a WHOLE
 * reply, once, at its successful end, through the real handler.
 *
 * Before: a reply that stopped at an approval card was never checked (skipped at the pause, and
 * the resume, which has no user message, built no lane), while smart zip judged the half reply at
 * the pause and could rezip results the resume still needed; a context continuation was never
 * judged; a reply cut at the output limit was judged as if finished; and a managed CLI
 * control-approval resume ran both lanes in its compile but never stored what they used.
 *
 * Faked, and only these: the compiler's OUTPUT (it records the options each compile was handed,
 * and, like the real one, asks the Judge Juice providers it is given), the API lane's model
 * (`VercelAIBrain`, one plan per run), and Jev itself (the four `compute*` lane calls, so no
 * network and no key). The inferred zip-state writers are spies (their own suite proves them on
 * real Redis). Everything between is the handler's own code on the Redis fake: the pause, the
 * card, the click, the resume as a second finalize of the same message, the continuation loop,
 * the after-reply site, the post-turn record, and the Execution Viewer rows.
 */

const USER = 'user-bl527'
const AGENT = 'agent-bl527'
const PRESET = 'preset-bl527'
const CARD = 'msg-card'
const REQUEST = 'List the folder.'

type ModelRun = 'reply' | 'card' | 'exhausted' | 'length'

const mocks = vi.hoisted(() => ({
  modelRuns: new Map<number, ModelRun>(),
  brainRuns: [] as string[],
  /** What each compile was handed: its current message and its Judge Juice options. */
  compiles: [] as Array<{ current: unknown; hintProvider: boolean; smartZipProvider: boolean; exposedObserver: boolean }>,
  userEvents: [] as Array<Record<string, any>>
}))

const lanes = vi.hoisted(() => ({
  computeSmartZipHints: vi.fn(),
  computeSmartZipRezips: vi.fn(),
  computeReplyCheck: vi.fn(),
  computeStyleCoach: vi.fn()
}))

const zipState = vi.hoisted(() => ({
  writeInferredUnzips: vi.fn(async (_sessionId: string, items: Array<{ zipId: string }>) => items.map((item) => item.zipId)),
  writeInferredRezips: vi.fn(async (_sessionId: string, items: Array<{ zipId: string }>) => items.map((item) => item.zipId)),
  loadUntoldInferredRezips: vi.fn(async () => [] as Array<Record<string, unknown>>),
  markInferredRezipsTold: vi.fn(async () => undefined)
}))

vi.mock('$lib/server/services/smartZip.jev', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeSmartZipHints: lanes.computeSmartZipHints,
  computeSmartZipRezips: lanes.computeSmartZipRezips
}))

vi.mock('$lib/server/services/postTurnCheck.jev', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeReplyCheck: lanes.computeReplyCheck,
  computeStyleCoach: lanes.computeStyleCoach
}))

vi.mock('$lib/server/services/zipStateInferred', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...zipState
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
      options?: Record<string, any>
    ) {
      mocks.compiles.push({
        current,
        hintProvider: typeof options?.jevJuiceHintProvider === 'function',
        smartZipProvider: typeof options?.jevJuiceSmartZipProvider === 'function',
        exposedObserver: typeof options?.jevJuiceSmartZipExposedObserver === 'function'
      })
      // Like the real compiler: the smart zip provider is asked after the history pass of a
      // compile with a current message, and the one tail provider closes the prompt.
      if (options?.jevJuiceSmartZipProvider && current) {
        await options.jevJuiceSmartZipProvider({ currentUserMessage: current, zippedItems: [] })
        options.jevJuiceSmartZipExposedObserver?.([])
      }
      if (options?.jevJuiceHintProvider) {
        await options.jevJuiceHintProvider({ skills: [], discoverable: [], resolvedGatewayIds: [] })
      }
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
      const plan = mocks.modelRuns.get(mocks.brainRuns.length) ?? 'reply'
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      if (plan === 'card') {
        const callId = `call_ls_${mocks.brainRuns.length}`
        const approvalId = `aitxt-bl527-${mocks.brainRuns.length}`
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
      if (plan === 'exhausted') {
        async function* outOfRoom() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Listing the folder first.' }
          yield { type: 'error', error: new Error("This model's maximum context length is 200000 tokens.") }
        }
        return { stream: outOfRoom(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      const text = plan === 'length' ? 'The folder holds' : `Reply for ${request.messageId}.`
      const finishReason = plan === 'length' ? 'length' : 'stop'
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason, usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason, totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0

const CHECK_ROW = { feature: 'reply_check', status: 'ok', latencyMs: 120, usage: null }
const ZIP_ROW = { feature: 'smart_zip', status: 'ok', latencyMs: 90, usage: null }
const CLAIMED = { id: 'claimed_action', lane: 'reply_check', source: 'inferred', probability: 0.91 }

function post(body: Record<string, unknown>): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', ...body })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

const userMessage = () => ({
  id: 'msg-user-1',
  session_id: SESSION,
  user_id: USER,
  role: 'user',
  content: REQUEST,
  created_at: '2026-10-12T01:00:00.000Z',
  metadata: {}
})

/** The page's own send: it saved the user message, then posts it with the reply's id. */
async function send(messageId: string): Promise<Response> {
  await redis.saveMessage(userMessage() as any)
  return post({ content: REQUEST, messageId, messages: [userMessage()] })
}

async function stored(messageId: string): Promise<any> {
  return redis.execute((client: any) => client.json.get(`message:${SESSION}:${messageId}`))
}

/** The page's own Approve click on the card, with the card as the chat now shows it. */
async function approve(card: any, approvalId: string): Promise<Response> {
  return post({
    content: '',
    messageId: card.id,
    messages: [userMessage(), card],
    metadata: {
      ...card.metadata,
      toolApprovalMode: 'all',
      toolApprovalResponse: [{ type: 'tool-approval-response', approvalId, approved: true, reason: 'User approved' }]
    }
  })
}

async function typesafeRows(messageId: string): Promise<Array<Record<string, unknown>>> {
  const snapshot = await executionViewerService.getSnapshot(SESSION, messageId)
  return (snapshot?.executionMetadata?.typesafeCalls ?? []) as Array<Record<string, unknown>>
}

const afterReplyCalls = () => ({
  check: lanes.computeReplyCheck.mock.calls.length,
  style: lanes.computeStyleCoach.mock.calls.length,
  rezip: lanes.computeSmartZipRezips.mock.calls.length
})

describe('send-routed: Judge Juice after-reply steps judge a whole reply, once (BL-527, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl527-${count}`
    mocks.modelRuns.clear()
    mocks.brainRuns = []
    mocks.compiles = []
    mocks.userEvents = []
    for (const lane of Object.values(lanes)) lane.mockReset()
    lanes.computeSmartZipHints.mockResolvedValue({ opens: [], lines: [], record: null, note: null })
    lanes.computeSmartZipRezips.mockResolvedValue({ rezips: [], record: ZIP_ROW, decision: null })
    lanes.computeReplyCheck.mockResolvedValue({ findings: [CLAIMED], record: CHECK_ROW, note: null })
    lanes.computeStyleCoach.mockResolvedValue({ findings: [], record: null, note: null })
    for (const spy of Object.values(zipState)) spy.mockClear()
    zipState.loadUntoldInferredRezips.mockResolvedValue([])
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
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
      tool_approval_mode: 'all',
      jev_juice_reply_check: true
    } as any)
    // Smart zip has ONE global switch.
    await redis.updateUserSettings(USER, { global_zip_settings: { jev_juice_smart_zip: true } })
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-527', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('control: a reply that ends normally is judged once by both steps, with its own request', async () => {
    expect((await send('msg-reply')).status).toBe(200)
    expect(afterReplyCalls()).toEqual({ check: 1, style: 1, rezip: 1 })
    expect(lanes.computeReplyCheck.mock.calls[0][0]).toMatchObject({ userRequest: REQUEST, reply: 'Reply for msg-reply.' })
    expect(lanes.computeSmartZipRezips.mock.calls[0][0]).toMatchObject({ userRequest: REQUEST, reply: 'Reply for msg-reply.' })
    expect(await typesafeRows('msg-reply')).toEqual([ZIP_ROW, CHECK_ROW])
  }, 30_000)

  it('(a) a reply paused for Approve is judged ONCE, at the resume’s end, whole; nothing is judged or rezipped at the pause', async () => {
    mocks.modelRuns.set(1, 'card')
    expect((await send(CARD)).status).toBe(200)

    // The pause: the reply waits at its card. Neither step runs, so nothing is rezipped on half a reply.
    const card = await stored(CARD)
    const approvalId = card.metadata.toolApprovals.approvals[0].approvalId
    expect(card.metadata.toolApprovals.approvals[0].status).toBe('pending')
    expect(afterReplyCalls()).toEqual({ check: 0, style: 0, rezip: 0 })
    expect(zipState.writeInferredRezips).not.toHaveBeenCalled()
    expect(await loadPostTurnRecord(SESSION, CARD)).toBeNull()
    expect(mocks.compiles[0]).toMatchObject({ current: REQUEST, smartZipProvider: true, hintProvider: true })

    // The click: the resume continues the SAME message, a second finalize of it.
    expect((await approve(card, approvalId)).status).toBe(200)
    expect(mocks.brainRuns).toEqual([CARD, CARD])
    expect((await stored(CARD)).content).toBe('I need to list the folder.\n\nReply for msg-card.')

    // Judged once, at the resume's end, the whole reply against the paused turn's request.
    expect(afterReplyCalls()).toEqual({ check: 1, style: 1, rezip: 1 })
    const whole = 'I need to list the folder.\n\nReply for msg-card.'
    expect(lanes.computeReplyCheck.mock.calls[0][0]).toMatchObject({ userRequest: REQUEST, reply: whole })
    expect(lanes.computeSmartZipRezips.mock.calls[0][0]).toMatchObject({ userRequest: REQUEST, reply: whole, exposed: [] })

    // The resume is not a new user turn: its compile was handed no Judge Juice lane at all.
    expect(mocks.compiles).toHaveLength(2)
    expect(mocks.compiles[1]).toMatchObject({ current: REQUEST, smartZipProvider: false, exposedObserver: false, hintProvider: false })
    expect(lanes.computeSmartZipHints).toHaveBeenCalledTimes(1)

    // What was noticed lives on the message, told to every tab once; one row per lane on its snapshot.
    expect(await loadPostTurnRecord(SESSION, CARD)).toMatchObject({ messageId: CARD, findings: [CLAIMED], toldAgent: false })
    expect(mocks.userEvents.filter((event) => event.type === 'jev_juice_post_turn')).toEqual([
      { type: 'jev_juice_post_turn', sessionId: SESSION, messageId: CARD }
    ])
    expect(await typesafeRows(CARD)).toEqual([ZIP_ROW, CHECK_ROW])
  }, 30_000)

  it('(a) a resume that stops at a second card judges nothing; the click that ends the reply judges it once, whole', async () => {
    mocks.modelRuns.set(1, 'card')
    mocks.modelRuns.set(2, 'card')
    await send(CARD)
    const first = await stored(CARD)
    expect((await approve(first, first.metadata.toolApprovals.approvals[0].approvalId)).status).toBe(200)
    expect(afterReplyCalls()).toEqual({ check: 0, style: 0, rezip: 0 })

    const second = await stored(CARD)
    const pending = second.metadata.toolApprovals.approvals.find((entry: any) => entry.status === 'pending')
    expect((await approve(second, pending.approvalId)).status).toBe(200)
    expect(mocks.brainRuns).toEqual([CARD, CARD, CARD])
    expect(afterReplyCalls()).toEqual({ check: 1, style: 1, rezip: 1 })
    // The words judged are the saved reply's words, every part of it (the saved join does not
    // repeat words a resume wrote again, and neither does the judgment).
    const saved = (await stored(CARD)).content
    expect(saved).toBe('I need to list the folder.\n\nReply for msg-card.')
    expect(lanes.computeReplyCheck.mock.calls[0][0].reply).toBe(saved)
    expect(lanes.computeSmartZipRezips.mock.calls[0][0].reply).toBe(saved)
  }, 30_000)

  it('(b) a context continuation is judged once, at its end, as the whole reply to the request', async () => {
    mocks.modelRuns.set(1, 'exhausted')
    expect((await send('msg-out-of-room')).status).toBe(200)
    expect(mocks.brainRuns).toHaveLength(2)
    const [outOfRoom, continuation] = mocks.brainRuns
    expect(outOfRoom).toBe('msg-out-of-room')
    expect((await stored(outOfRoom)).metadata).toMatchObject({ response_failed: true, failure_kind: 'context_exhausted' })

    expect(afterReplyCalls()).toEqual({ check: 1, style: 1, rezip: 1 })
    const whole = `Listing the folder first.\n\nReply for ${continuation}.`
    expect(lanes.computeReplyCheck.mock.calls[0][0]).toMatchObject({ userRequest: REQUEST, reply: whole })
    expect(lanes.computeSmartZipRezips.mock.calls[0][0]).toMatchObject({ userRequest: REQUEST, reply: whole })
    // The record and the rows belong to the message that finished the reply.
    expect(await loadPostTurnRecord(SESSION, continuation)).toMatchObject({ messageId: continuation, findings: [CLAIMED] })
    expect(await loadPostTurnRecord(SESSION, outOfRoom)).toBeNull()
    expect(await typesafeRows(continuation)).toEqual([ZIP_ROW, CHECK_ROW])
    // The continuation is not a new user turn: no lane before its reply.
    expect(mocks.compiles[1]).toMatchObject({ smartZipProvider: false, hintProvider: false })
  }, 30_000)

  it('(c) a reply cut at the output limit is judged by neither step', async () => {
    mocks.modelRuns.set(1, 'length')
    expect((await send('msg-cut')).status).toBe(200)
    expect((await stored('msg-cut')).metadata).toMatchObject({ response_failed: true, failure_kind: 'output_limit' })
    expect(afterReplyCalls()).toEqual({ check: 0, style: 0, rezip: 0 })
    expect(zipState.writeInferredRezips).not.toHaveBeenCalled()
    expect(await loadPostTurnRecord(SESSION, 'msg-cut')).toBeNull()
    expect(await typesafeRows('msg-cut')).toEqual([])
  }, 30_000)

  it('(d) a managed CLI control-approval resume stores what its compile’s lanes used, once, and judges its reply once', async () => {
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
    const card = {
      id: CARD,
      session_id: SESSION,
      user_id: USER,
      agent_id: AGENT,
      role: 'assistant',
      status: 'complete',
      content: 'I need your approval to import the skill.',
      created_at: '2026-10-12T01:00:05.000Z',
      metadata: {
        model: 'claude-sonnet-5',
        agentType: 'api',
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
      }
    }
    for (const message of [userMessage(), card]) await redis.saveMessage(message as any)
    // What the resume's compile will tell the agent: a note about the card message, and an earlier rezip.
    await writePostTurnRecord({ messageId: CARD, sessionId: SESSION, agentId: AGENT, at: 'x', findings: [CLAIMED], notes: [], toldAgent: false } as any)
    zipState.loadUntoldInferredRezips.mockResolvedValue([
      {
        zipId: 'zip_old',
        sessionId: SESSION,
        source: 'inferred',
        rezippedAt: 1,
        reason: 'jev_done_with_it',
        description: 'read_file: a.ts - 9 lines',
        done: 0.9,
        again: 0.1,
        toldAgent: false
      }
    ])
    // What Jev opens for the resume's message.
    lanes.computeSmartZipHints.mockResolvedValue({
      opens: [{ zipId: 'zip_open', description: 'read_file: b.ts - 9 lines', tokens: 500, probability: 0.8, durationMessages: 2 }],
      lines: ['jev_juice_zips (Batshit unzipped 1 of them for you):'],
      record: ZIP_ROW,
      note: null
    })

    expect((await approve(card, record.id)).status).toBe(200)

    // One new turn, whose message is the approval, and whose compile ran both lanes.
    expect(mocks.brainRuns).toHaveLength(1)
    const resumeReply = mocks.brainRuns[0]
    expect(String(mocks.compiles[0].current)).toContain('Approved: Skill Import')
    expect(mocks.compiles[0]).toMatchObject({ smartZipProvider: true, hintProvider: true })

    // The accepted-send writes, once each: the opens the compile used, the told rezip, the told note.
    expect(zipState.writeInferredUnzips).toHaveBeenCalledTimes(1)
    expect(zipState.writeInferredUnzips).toHaveBeenCalledWith(SESSION, [
      { zipId: 'zip_open', description: 'read_file: b.ts - 9 lines', tokens: 500, probability: 0.8, durationMessages: 2 }
    ])
    expect(zipState.markInferredRezipsTold).toHaveBeenCalledTimes(1)
    expect(zipState.markInferredRezipsTold).toHaveBeenCalledWith(SESSION, ['zip_old'])
    expect(await loadPostTurnRecord(SESSION, CARD)).toMatchObject({ toldAgent: true })
    expect((await stored(resumeReply)).metadata.jevJuice?.zips?.opened).toEqual([{ zipId: 'zip_open', probability: 0.8 }])

    // Its reply is its own turn's, judged once at its end.
    expect(afterReplyCalls()).toEqual({ check: 1, style: 1, rezip: 1 })
    expect(lanes.computeReplyCheck.mock.calls[0][0].reply).toBe(`Reply for ${resumeReply}.`)
  }, 30_000)
})
