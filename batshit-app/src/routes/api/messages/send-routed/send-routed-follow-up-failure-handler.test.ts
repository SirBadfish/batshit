// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests, enqueueSteer } from '$lib/server/services/steerInboxRegistry'
import { sha256Hex } from '$lib/utils/sha256'
import { executionViewerService } from '$lib/server/services/executionViewerService'

/**
 * BL-523 — a follow-up turn that fails before its stream opens writes its failure to ITS OWN
 * assistant message, never to the reply that already finished.
 *
 * One send-routed request can run several turns: the first, a context continuation, and a
 * promoted steer or queued message (each a new assistant message). A follow-up that threw before
 * its stream opened used to land in the POST's catch, which wrote the error onto the FIRST run's
 * message: the finished reply's words became the error sentence, and the promoted message got no
 * reply at all.
 *
 * These run the real handler with the default lane's Redis fake. Two seams are faked, and only
 * them: the compiler's OUTPUT (per compile call, so the follow-up's compile can carry a picture
 * or a prompt too large for the model, or compile to nothing), and the API lane's model
 * (`VercelAIBrain`: a plain text reply, or words and then a context-limit error). Everything
 * between, including the three real refusals (`Unable to compile chat messages`,
 * `IMAGE_INPUT_UNSUPPORTED`, `PROMPT_BUDGET_EXCEEDED`), is the handler's own code.
 * Named save/interleaving cases inject a save failure or hold the actual snapshot owner's
 * final write, invoking its original implementation afterward; they do not replace its logic.
 */

const USER = 'user-bl523'
const AGENT = 'agent-bl523'
const PRESET = 'preset-bl523'
const FIRST_REPLY = 'msg-first-reply'

type CompileAnswer = 'ok' | 'empty' | 'image' | 'huge'
type ModelRun = 'reply' | 'context-exhausted' | 'incomplete-tool-call' | 'empty-incomplete-tool-call' | 'unrelated-stream-error'
  | 'multi-call-error' | 'multi-call-stop' | 'multi-call-success' | 'late-finish-after-error' | 'partial-finish-before-error' | 'held-partial-finish-error' | 'raw-empty-error'

const mocks = vi.hoisted(() => ({
  compileCalls: 0,
  /** What each compile answers, by call number (1-based); the rest answer `ok`. */
  compileAnswers: new Map<number, CompileAnswer>(),
  /** What each model run does, by run number (1-based); the rest reply. */
  modelRuns: new Map<number, ModelRun>(),
  /** The assistant message id of every model run, in order. */
  brainRuns: [] as string[],
  /** The promotion's own work throws once, between two runs. */
  promotionThrows: false,
  lateFinish: null as null | (() => Promise<void>),
  finishStorageBoundary: null as null | Promise<void>,
  inFlightFinish: null as null | Promise<void>
}))

vi.mock('$lib/server/services/steerPromotion', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    promoteSteersToNextTurn: vi.fn(async (...args: any[]) => {
      if (mocks.promotionThrows) {
        mocks.promotionThrows = false
        throw new Error('the promotion failed (test)')
      }
      return actual.promoteSteersToNextTurn(...args)
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
    async buildFormattedChatInput() {
      mocks.compileCalls += 1
      const answer = mocks.compileAnswers.get(mocks.compileCalls) ?? 'ok'
      // About 400,000 tokens: over the preset's 200,000-token window.
      const text = answer === 'huge' ? 'word '.repeat(400_000) : 'Hello from the compile.'
      const content: unknown =
        answer === 'image'
          ? [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } }
            ]
          : text
      return {
        primarySystemPrompt: answer === 'empty' ? '' : 'You are a test agent.',
        structuredInput: {
          messages: answer === 'empty' ? [] : [{ role: 'user', content }],
          metadata: {}
        },
        resolvedProjectPath: null,
        addressSources: { pieces: [], nonTextInputs: 0, unaccountedInputs: 0 }
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      mocks.brainRuns.push(request.messageId)
      const modelMessages = Array.isArray(request.messages) ? request.messages : []
      const promptMessages = modelMessages.map((message: any) => {
        if (message?.role === 'system') return { role: 'system', content: message.content }
        if (message?.role === 'user') {
          const content = typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : (Array.isArray(message.content) ? message.content.flatMap((part: any) =>
                part?.type === 'text' ? [{ type: 'text', text: part.text }] : []) : [])
          return { role: 'user', content }
        }
        return { role: message?.role, content: [] }
      })
      request.onApiModelInput?.({
        compiledMessages: request.imageOriginInput?.compiledMessages ?? modelMessages,
        promptMessages,
        toolDefinitions: [],
        compiledPrefixCount: request.imageOriginInput?.compiledPrefixCount ?? modelMessages.length,
        initialSystem: modelMessages.filter((message: any) => message?.role === 'system'),
        userSources: request.imageOriginInput?.userSources ?? []
      })
      const plan = mocks.modelRuns.get(mocks.brainRuns.length) ?? 'reply'
      if (plan === 'raw-empty-error' || plan.startsWith('multi-call-') || plan === 'late-finish-after-error' || plan === 'partial-finish-before-error' || plan === 'held-partial-finish-error') {
        const firstUsage = { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
        const secondUsage = { inputTokens: 20, outputTokens: 2, totalTokens: 22 }
        const aggregate = { inputTokens: 30, outputTokens: 3, totalTokens: 33 }
        const text = 'Partial work before the last call.'
        async function* accountingStream() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'raw', rawValue: { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } }
          if (plan === 'raw-empty-error') throw new Error('Provider failed before output.')
          yield { type: 'tool-call', toolCallId: 'known-call', toolName: 'native_bash_execute', input: { command: 'printf known' } }
          yield { type: 'tool-result', toolCallId: 'known-call', toolName: 'native_bash_execute', input: { command: 'printf known' },
            output: { success: true, exitCode: 0, stdout: 'known', stderr: '' } }
          yield { type: 'finish-step', finishReason: 'tool-calls', usage: firstUsage, response: {} }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 'last' }
          yield { type: 'text-delta', id: 'last', text }
          yield { type: 'text-end', id: 'last' }
          if (plan === 'multi-call-success') {
            yield { type: 'raw', rawValue: { usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } } }
            yield { type: 'finish-step', finishReason: 'stop', usage: secondUsage, response: {} }
            await request.onFinish?.({ text, steps: [], totalUsage: aggregate, usage: aggregate, reasoning: [], responseMessages: [] })
            yield { type: 'finish', finishReason: 'stop', totalUsage: aggregate }
            return
          }
          if (plan === 'late-finish-after-error' || plan === 'partial-finish-before-error' || plan === 'held-partial-finish-error') {
            // Real SDK7 can end with only earlier numeric counters despite an unknown failed step.
            mocks.lateFinish = () => request.onFinish?.({ text, steps: [
              { finishReason: 'tool-calls', usage: firstUsage, toolCalls: [], toolResults: [] },
              { finishReason: 'error', usage: {}, toolCalls: [], toolResults: [] }
            ], totalUsage: firstUsage, usage: firstUsage, reasoning: [], responseMessages: [] })
            if (plan === 'partial-finish-before-error') await mocks.lateFinish()
            if (plan === 'held-partial-finish-error') {
              mocks.inFlightFinish = mocks.lateFinish()
              // The callback either reaches the actual snapshot write or is refused before it.
              await Promise.race([mocks.finishStorageBoundary!, mocks.inFlightFinish])
            }
          }
          throw Object.assign(new Error('Last call did not finish.'), { name: plan === 'multi-call-stop' ? 'AbortError' : 'Error' })
        }
        return { stream: accountingStream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      const text = plan === 'empty-incomplete-tool-call' ? ''
        : plan === 'reply' ? `Reply for ${request.messageId}.`
        : plan === 'context-exhausted' ? 'Partial words before the limit.'
        : 'Partial words before the stream failed.'
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        if (plan === 'incomplete-tool-call' || plan === 'empty-incomplete-tool-call') {
          const { InvalidResponseDataError } = await import('@ai-sdk/provider')
          throw new InvalidResponseDataError({
            message: "Expected 'function.name' to be a string.",
            data: { index: 0, id: 'unnamed', type: 'function', function: { arguments: '{"private":"never display"}' } }
          })
        }
        if (plan === 'unrelated-stream-error') throw new Error('Unrelated socket failure')
        if (plan === 'context-exhausted') {
          yield { type: 'error', error: new Error("This model's maximum context length is 200000 tokens.") }
          return
        }
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
let forwards: any[] = []
let savedBeforeFailureEvents: any[] = []

function send(metadata?: Record<string, unknown>): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'FIRST',
        metadata,
        messageId: FIRST_REPLY,
        messages: [{ id: 'msg-user-1', role: 'user', content: 'FIRST' }]
      })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

/** A queued message waiting for the first reply to end: the server promotes it into the next turn. */
function queueForTheEnd() {
  const accepted = enqueueSteer(SESSION, {
    steerId: 'msg-queued-1',
    messageId: FIRST_REPLY,
    text: 'SECOND',
    at: new Date().toISOString(),
    source: 'user',
    deliver: 'end'
  })
  expect(accepted.ok).toBe(true)
}

async function chat() {
  const messages = (await redis.getMessages(SESSION)) as any[]
  const byId = new Map(messages.map((message) => [message.id, message]))
  return { messages, byId }
}

async function imageOrigin(messageId: string) {
  return (await redis.execute((client: any) => client.json.get(`image_origin:${SESSION}:${messageId}`))) as any
}

describe('send-routed: a follow-up turn that fails before its stream opens (BL-523, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl523-${count}`
    mocks.compileCalls = 0
    mocks.compileAnswers.clear()
    mocks.modelRuns.clear()
    mocks.brainRuns = []
    mocks.promotionThrows = false
    mocks.lateFinish = null
    mocks.finishStorageBoundary = null
    mocks.inFlightFinish = null
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    // The `/api/sse` forwards (the promoted message, the stream events) answer at once.
    forwards = []
    savedBeforeFailureEvents = []
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        const body = JSON.parse(init.body)
        forwards.push(body)
        if (body.type === 'end' || body.type === 'error') {
          savedBeforeFailureEvents.push({ type: body.type,
            message: ((await redis.getMessages(SESSION)) as any[]).find(message => message.id === body.messageId) })
        }
      }
      return new Response('{}', { status: 200 })
    }))
    // Quiet the handler's expected error lines; a test reads the stored chat, not the log.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET,
      name: 'Text-only test model',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      contextWindow: 200_000,
      // A text-only model: a picture is refused before the provider is called.
      capabilities: { vision: false },
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
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-523', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('control: both turns answer, each in its own message', async () => {
    queueForTheEnd()
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.brainRuns).toHaveLength(2)
    const [, promotedReplyId] = mocks.brainRuns
    const { byId } = await chat()
    expect(byId.get(FIRST_REPLY)).toMatchObject({ content: `Reply for ${FIRST_REPLY}.` })
    expect(byId.get(FIRST_REPLY)?.status).not.toBe('error')
    expect(byId.get('msg-queued-1')).toMatchObject({ role: 'user', content: 'SECOND' })
    expect(byId.get(promotedReplyId)).toMatchObject({ role: 'assistant', content: `Reply for ${promotedReplyId}.` })
    expect(promotedReplyId).not.toBe(FIRST_REPLY)
    expect(byId.get(promotedReplyId)?.metadata?.steerPromoted).toEqual({ steerIds: ['msg-queued-1'] })
    expect(byId.get(FIRST_REPLY)?.metadata?.steerPromoted).toBeUndefined()
    for (const type of ['start', 'end']) {
      expect(forwards.some(body => body.type === type && body.messageId === promotedReplyId &&
        body.metadata?.steerPromoted?.steerIds?.includes('msg-queued-1'))).toBe(true)
    }
    expect(forwards.filter(body => body.type === 'steer_promoted').every(body => !('messageId' in body))).toBe(true)
    expect(byId.get(FIRST_REPLY)?.metadata).toMatchObject({ imageOriginExpected: true, imageOriginExpectedVersion: 1 })
    expect(byId.get(promotedReplyId)?.metadata).toMatchObject({ imageOriginExpected: true, imageOriginExpectedVersion: 1 })

    const firstOrigin = await imageOrigin(FIRST_REPLY)
    const promotedOrigin = await imageOrigin(promotedReplyId)
    expect(firstOrigin).toMatchObject({ messageId: FIRST_REPLY, version: 1, state: 'decided' })
    expect(firstOrigin.textHashes).toContain(sha256Hex(byId.get(FIRST_REPLY).content))
    expect(promotedOrigin).toMatchObject({ messageId: promotedReplyId, version: 1, state: 'decided' })
    expect(promotedOrigin.textHashes).toContain(sha256Hex(byId.get(promotedReplyId).content))
  }, 30_000)

  it.each(['incomplete-tool-call', 'empty-incomplete-tool-call'] as const)(
    'explains %s in the saved failure and terminal events, without continuing (BL-1569)',
    async (plan) => {
      mocks.modelRuns.set(1, plan)
      const response = await send()
      expect(response.status).toBe(502)
      const payload = await response.json()
      expect(payload.code).toBe('MODEL_INCOMPLETE_TOOL_CALL')
      expect(payload.error).toContain('model response contained an incomplete tool call')
      expect(payload.error).toContain('Earlier tool actions may already have run')
      expect(JSON.stringify(payload)).not.toContain('never display')
      expect(mocks.brainRuns).toEqual([FIRST_REPLY])
      const failed = (await chat()).byId.get(FIRST_REPLY)
      expect(failed.metadata).toMatchObject({
        response_failed: true, error_code: payload.code, http_status: 502,
        error_message: payload.error, error_details: "Expected 'function.name' to be a string."
      })
      expect(failed.metadata.failure_kind).toBeUndefined()
      expect(failed.content).toBe(plan === 'incomplete-tool-call'
        ? 'Partial words before the stream failed.' : payload.error)
      const terminal = forwards.filter(body => body.type === 'end' || body.type === 'error')
      expect(terminal.map(body => body.type)).toEqual(plan === 'incomplete-tool-call' ? ['end', 'error'] : ['error'])
      expect(terminal.at(-1).error).toBe(payload.error)
      for (const event of savedBeforeFailureEvents) {
        expect(event.message?.content).toBe(failed.content)
        expect(event.message?.metadata).toMatchObject({ response_failed: true, error_code: payload.code })
      }
      expect(savedBeforeFailureEvents).toHaveLength(terminal.length)
    }, 30_000
  )

  it('keeps unrelated stream failures unchanged (BL-1569)', async () => {
    mocks.modelRuns.set(1, 'unrelated-stream-error')
    const response = await send()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to stream response', details: 'Unrelated socket failure' })
    expect((await chat()).byId.get(FIRST_REPLY)?.metadata).toMatchObject({
      response_failed: true, error_message: 'Unrelated socket failure'
    })
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
  }, 30_000)

  it.each(['multi-call-error', 'multi-call-stop'] as const)('keeps whole usage unknown for %s while retaining the completed call (BL-1596)', async (plan) => {
    mocks.modelRuns.set(1, plan)
    const response = await send()
    expect(response.status).toBe(plan === 'multi-call-stop' ? 499 : 500)
    const failed = (await chat()).byId.get(FIRST_REPLY)
    expect(failed.content).toContain('Partial work before the last call.')
    expect(failed.metadata.zipIds).toHaveLength(1)
    expect(failed.metadata.usage).toBeNull()
    expect(failed.metadata[plan === 'multi-call-stop' ? 'interrupted' : 'response_failed']).toBe(true)
    const end = forwards.find(body => body.type === 'end')
    expect(end.metadata.usage).toBeNull()
    const savedAtEnd = savedBeforeFailureEvents.find(event => event.type === 'end')
    expect(savedAtEnd.message.metadata.usage).toBeNull()
    const snapshot = await executionViewerService.getSnapshot(SESSION, FIRST_REPLY)
    expect(snapshot?.llmCalls).toHaveLength(2)
    expect(snapshot?.llmCalls?.[0].usage?.inputTokens.value).toBe(10)
    expect(snapshot?.llmCalls?.[1].usage?.inputTokens.value).toBeNull()
    expect(snapshot?.llmSummary?.totalUsage.inputTokens.value).toBeNull()
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
  }, 30_000)

  it('writes explicit unknown usage through the empty failure and repeated POST save (BL-1596)', async () => {
    mocks.modelRuns.set(1, 'raw-empty-error')
    const response = await send()
    expect(response.status).toBe(500)
    expect((await chat()).byId.get(FIRST_REPLY)?.metadata.usage).toBeNull()
    expect(savedBeforeFailureEvents.find(event => event.type === 'error')?.message.metadata.usage).toBeNull()
  }, 30_000)

  it.each([false, true])('keeps a complete aggregate when local finalize fails=%s (BL-1596)', async (failFinalize) => {
    mocks.modelRuns.set(1, 'multi-call-success')
    const save = (redis.saveMessage as any).getMockImplementation?.() ?? redis.saveMessage.bind(redis)
    let failOnce = failFinalize
    vi.spyOn(redis, 'saveMessage').mockImplementation(async (message: any) => {
      if (failOnce && message.id === FIRST_REPLY && message.role === 'assistant') {
        failOnce = false
        throw new Error('Synthetic save failure after a complete model run.')
      }
      return save(message)
    })
    const response = await send()
    expect(response.status).toBe(failFinalize ? 500 : 200)
    const metadata = (await chat()).byId.get(FIRST_REPLY)?.metadata
    expect(metadata.usage).toEqual({ inputTokens: 30, outputTokens: 3, totalTokens: 33 })
    expect(metadata.response_failed).toBe(failFinalize ? true : undefined)
  }, 30_000)

  it('a late partial finish callback cannot restore whole usage or replace retained call evidence (BL-1596)', async () => {
    mocks.modelRuns.set(1, 'late-finish-after-error')
    await send()
    const before = await executionViewerService.getSnapshot(SESSION, FIRST_REPLY)
    expect((await chat()).byId.get(FIRST_REPLY)?.metadata.usage).toBeNull()
    expect(mocks.lateFinish).not.toBeNull()
    await mocks.lateFinish!()
    const after = await executionViewerService.getSnapshot(SESSION, FIRST_REPLY)
    expect((await chat()).byId.get(FIRST_REPLY)?.metadata.usage).toBeNull()
    expect(after?.llmCalls).toEqual(before?.llmCalls)
    expect(after?.llmSummary?.totalUsage.inputTokens.value).toBeNull()
    expect(after?.responseSummary?.usage.inputTokens.value ?? null).toBeNull()
    expect(forwards.filter(body => body.type === 'end')).toHaveLength(1)
  }, 30_000)

  it('rejects a partial SDK aggregate even when onEnd ran ahead of the consumed error (BL-1596)', async () => {
    mocks.modelRuns.set(1, 'partial-finish-before-error')
    const response = await send()
    expect(response.status).toBe(500)
    const stored = (await chat()).byId.get(FIRST_REPLY)
    expect(stored.metadata.usage).toBeNull()
    expect(stored.metadata.zipIds).toHaveLength(1)
    const snapshot = await executionViewerService.getSnapshot(SESSION, FIRST_REPLY)
    expect(snapshot?.llmCalls).toHaveLength(2)
    expect(snapshot?.llmCalls?.[0].usage.inputTokens.value).toBe(10)
    expect(snapshot?.llmCalls?.[1].usage.inputTokens.value).toBeNull()
    expect(snapshot?.llmSummary?.totalUsage.inputTokens.value).toBeNull()
    expect(snapshot?.responseSummary?.usage.inputTokens.value ?? null).toBeNull()
  }, 30_000)

  it('an in-flight partial callback cannot replace the terminal snapshot after its actual owner read it (BL-1596 review)', async () => {
    mocks.modelRuns.set(1, 'held-partial-finish-error')
    let entered!: () => void
    let release!: () => void
    mocks.finishStorageBoundary = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const owner = executionViewerService as any
    const write = owner.setSnapshotAt.bind(owner)
    let heldCallbackWrite = false
    vi.spyOn(owner, 'setSnapshotAt').mockImplementation(async (...args: any[]) => {
      const [, key, , snapshot] = args
      if (!heldCallbackWrite && key === `session:${SESSION}:execution_log` &&
          snapshot.responseSummary && snapshot.llmCalls?.length === 2) {
        heldCallbackWrite = true
        entered()
        await held
      }
      return write(...args)
    })
    let before: any
    let after: any
    try {
      const response = await send()
      expect(response.status).toBe(500)
      before = await executionViewerService.getSnapshot(SESSION, FIRST_REPLY)
      expect(before?.runtime?.status).toBe('failed')
    } finally {
      release()
      await mocks.inFlightFinish
      after = await executionViewerService.getSnapshot(SESSION, FIRST_REPLY)
    }
    expect(after?.runtime?.status).toBe('failed')
    expect(after?.llmSummary?.totalUsage.inputTokens.value).toBeNull()
    expect(after?.llmCalls).toHaveLength(2)
    expect(after?.llmCalls?.[0].usage.inputTokens.value).toBe(10)
    expect(after?.llmCalls?.[1].usage.inputTokens.value).toBeNull()
    expect((await chat()).byId.get(FIRST_REPLY)?.metadata.usage).toBeNull()
    expect(forwards.filter(body => body.type === 'end')).toHaveLength(1)
  }, 30_000)

  it.each([
    ['a compile failure', 'empty' as const, undefined, 'Unable to compile chat messages for Batshit agent'],
    ['a picture on a text-only model', 'image' as const, 'IMAGE_INPUT_UNSUPPORTED', 'image'],
    ['a prompt over its budget', 'huge' as const, 'PROMPT_BUDGET_EXCEEDED', 'context window']
  ])(
    'a promoted turn that fails with %s leaves the finished reply alone and fails in its own message',
    async (_label, compileAnswer, code, words) => {
      queueForTheEnd()
      mocks.compileAnswers.set(2, compileAnswer)

      const response = await send()
      // The request's own answer is the follow-up's failure (its status: 500, or 422 for the two
      // refusals); the finished reply was already delivered by its stream.
      expect(response.ok).toBe(false)
      // The follow-up never reached the model: only the first run did.
      expect(mocks.brainRuns).toEqual([FIRST_REPLY])
      expect(mocks.compileCalls).toBe(2)

      const { messages, byId } = await chat()
      // The finished reply keeps its words and is not an error.
      expect(byId.get(FIRST_REPLY)).toMatchObject({ content: `Reply for ${FIRST_REPLY}.` })
      expect(byId.get(FIRST_REPLY)?.status).not.toBe('error')
      expect(byId.get(FIRST_REPLY)?.metadata?.response_failed).toBeUndefined()

      // The promoted message is answered by its own failed reply, right after it.
      const queuedAt = messages.findIndex((message) => message.id === 'msg-queued-1')
      expect(queuedAt).toBeGreaterThan(messages.findIndex((message) => message.id === FIRST_REPLY))
      const failed = messages[queuedAt + 1]
      expect(failed).toMatchObject({ role: 'assistant', status: 'error' })
      expect(failed.id).not.toBe(FIRST_REPLY)
      expect(failed.metadata).toMatchObject({ response_failed: true, steerPromoted: { steerIds: ['msg-queued-1'] } })
      expect(String(failed.content).toLowerCase()).toContain(words.toLowerCase())
      if (code) expect(failed.metadata.error_code).toBe(code)
      expect(messages).toHaveLength(queuedAt + 2)
    },
    30_000
  )

  it('a context continuation that fails before its stream opens keeps the partial reply and fails in its own message', async () => {
    mocks.modelRuns.set(1, 'context-exhausted')
    // Not `empty`: a continuation always compiles its CONTEXT LIMIT CONTINUATION addendum.
    mocks.compileAnswers.set(2, 'huge')

    const response = await send()
    expect(response.ok).toBe(false)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    expect(mocks.compileCalls).toBe(2)

    const { messages, byId } = await chat()
    // The run that ran out of room keeps its partial words, with its own failure (the limit).
    expect(byId.get(FIRST_REPLY)).toMatchObject({ content: 'Partial words before the limit.' })
    expect(byId.get(FIRST_REPLY)?.metadata).toMatchObject({ failure_kind: 'context_exhausted' })
    expect(byId.get(FIRST_REPLY)?.metadata?.error_code).not.toBe('PROMPT_BUDGET_EXCEEDED')
    expect(byId.get(FIRST_REPLY)?.metadata).toMatchObject({ imageOriginExpected: true, imageOriginExpectedVersion: 1 })
    const firstOrigin = await imageOrigin(FIRST_REPLY)
    expect(firstOrigin).toMatchObject({ messageId: FIRST_REPLY, version: 1, state: 'decided' })
    expect(firstOrigin.textHashes).toContain(sha256Hex(byId.get(FIRST_REPLY).content))

    // The continuation's refusal is its own message, after it.
    const continuation = messages[messages.findIndex((message) => message.id === FIRST_REPLY) + 1]
    expect(continuation).toMatchObject({ role: 'assistant', status: 'error' })
    expect(continuation.metadata).toMatchObject({ response_failed: true, error_code: 'PROMPT_BUDGET_EXCEEDED' })
    expect(continuation.id).not.toBe(FIRST_REPLY)
    expect(continuation.metadata).toMatchObject({ imageOriginExpected: true, imageOriginExpectedVersion: 1 })
    const continuationOrigin = await imageOrigin(continuation.id)
    expect(continuationOrigin === null || continuationOrigin.state === 'pending').toBe(true)
    expect((await imageOrigin(FIRST_REPLY))).toEqual(firstOrigin)
  }, 30_000)

  it('a throw between runs (the promotion itself) lands on no reply: the finished one keeps its words (review nit)', async () => {
    queueForTheEnd()
    mocks.promotionThrows = true

    const response = await send()
    expect(response.ok).toBe(false)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])

    const { byId } = await chat()
    expect(byId.get(FIRST_REPLY)).toMatchObject({ content: `Reply for ${FIRST_REPLY}.` })
    expect(byId.get(FIRST_REPLY)?.status).not.toBe('error')
    expect(byId.get(FIRST_REPLY)?.metadata?.response_failed).toBeUndefined()
    expect(forwards).toContainEqual(expect.objectContaining({ type: 'steer_promoted',
      metadata: { steerPromoted: { steerIds: ['msg-queued-1'], disposition: 'unanswered', reason: 'promotion_failed' } } }))
  }, 30_000)
  it('request/body steerPromoted cannot forge a managed answer owner', async () => {
    const response = await send({ steerPromoted: { steerIds: ['forged'] } })
    expect(response.status).toBe(200)
    expect((await chat()).byId.get(FIRST_REPLY)?.metadata?.steerPromoted).toBeUndefined()
    expect(forwards.some(body => body.metadata?.steerPromoted?.steerIds?.includes('forged'))).toBe(false)
  }, 30_000)

})
