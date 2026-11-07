// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The real SDK, the real AI Gateway client and the real Anthropic client (the shared setup fakes them).
vi.unmock('ai')
vi.unmock('@ai-sdk/anthropic')

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { env } from '$env/dynamic/private'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import {
  ANTHROPIC_DIRECT_TOOL_CALL_EVENTS,
  GATEWAY_V2_FINISH_TEXT_EVENTS,
  GATEWAY_V2_FINISH_TOOL_CALL_EVENTS,
  eventStreamResponse
} from '$lib/server/services/__tests__/fixtures/gatewayV2FinishStreams'

/**
 * BL-1782 through the real send-routed handler, the real `VercelAIBrain`, the real
 * `ProviderManager`, the real `@ai-sdk/gateway` and `ai`: a primary on the API lane whose preset
 * names no connection resolves `claude-haiku-5-5` by name to the Vercel AI Gateway (the BL-266
 * behaviour), and the Gateway answers with the stream captured on 2026-10-18, whose `finish` part
 * has the older shape. The tool call never ran and the reply failed as "The model provider returned
 * an empty response." (PROVIDER_EMPTY_RESPONSE, 502); it now fails with the named error.
 *
 * Faked: the network (a stubbed fetch answers the Gateway and Anthropic URLs with the captured
 * streams and refuses every other URL), the compiler's output, the tool list (one Subagent-style
 * `dynamicTool`), and the live hub's Redis clients.
 */

const USER = 'user-bl1782'
const AGENT = 'agent-bl1782'
const PRESET = 'preset-bl1782'
const REPLY = 'msg-reply-bl1782'
const SERVICE_TOKEN = 'test-internal-token-bl1782'
const GATEWAY_BASE_URL = 'https://gateway.test/v3/ai'
const NAMED_ERROR =
  'The Vercel AI Gateway replied in a stream format this Batshit version cannot read, so the tool call test-researcher did not run; use a direct provider connection for this model.'

const mocks = vi.hoisted(() => ({
  toolRuns: [] as unknown[],
  /** The tool asks for approval (the call-level policy shape `vercelBrain` hands the SDK). */
  approval: false,
  /** Every event send-routed forwarded to `/api/sse`, in order. */
  forwards: [] as Array<Record<string, any>>,
  /** The stored reply at the moment each `error` event reached `/api/sse` (BL-775: saved first). */
  savedAtError: [] as any[]
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
    async buildFormattedChatInput(
      sessionId: string,
      _history: unknown[],
      agent: { id?: string },
      _current: unknown,
      _subagents: unknown,
      userId: unknown,
      options?: { whiteboardContextSnapshot?: unknown; whiteboardMessageId?: string }
    ) {
      return {
        primarySystemPrompt: 'For every user question you MUST call the test-researcher tool exactly once.',
        // What the real compiler returns beside the prompt; an approval resume needs it (SA-133).
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId, sessionId, agentId: agent?.id, messageId: options?.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'What is 2 plus 2? Answer with one number.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

// The real brain with two tools: the app's Subagent tools are the AI SDK's `dynamicTool`s.
vi.mock('$lib/server/services/vercelBrain', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  const { dynamicTool } = await import('ai')
  const { z } = await import('zod')
  class VercelAIBrain extends actual.VercelAIBrain {
    async buildToolsForMode3() {
      return {
        tools: {
          'test-researcher': dynamicTool({
            description: 'Ask the Researcher subagent a question.',
            inputSchema: z.object({ chatInput: z.string() }),
            execute: async (input: unknown) => {
              mocks.toolRuns.push(input)
              return 'The researcher says: 4'
            }
          }),
          'test-reader': dynamicTool({
            description: 'Read a note.',
            inputSchema: z.object({ path: z.string() }),
            execute: async (input: unknown) => {
              mocks.toolRuns.push(input)
              return 'Ship on Tuesday.'
            }
          })
        },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
        toolApprovals: mocks.approval ? { 'test-researcher': async () => 'user-approval' as const } : {},
        ephemeralImages: null
      }
    }
  }
  return { ...actual, VercelAIBrain }
})

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => {}) }
})

useRedisTestServer()

const envRecord = env as Record<string, string | undefined>
const ENV_KEYS = ['BATSHIT_TOKEN', 'AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'] as const
let previousEnv: Record<string, string | undefined> = {}
let POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0
let gatewayAnswer: ReadonlyArray<Record<string, unknown>> = []
/** The provider URLs the run called, in order. */
const providerRequests: string[] = []
let anthropicCalls = 0

/** Anthropic's second answer, after the tool result: words only. */
const ANTHROPIC_TEXT_EVENTS = [
  {
    type: 'message_start',
    message: { id: 'msg_fixture_1782_4', model: 'claude-haiku-5-5', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 600, output_tokens: 1 } }
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The researcher says 4.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
  { type: 'message_stop' }
]

/** The only network: the two provider URLs. Anything else fails the test loudly. */
function stubProviderNetwork() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(`${GATEWAY_BASE_URL}/`)) {
      providerRequests.push(url)
      return eventStreamResponse(gatewayAnswer)
    }
    if (url.startsWith('https://api.anthropic.com/')) {
      providerRequests.push(url)
      anthropicCalls += 1
      return eventStreamResponse(anthropicCalls === 1 ? ANTHROPIC_DIRECT_TOOL_CALL_EVENTS : ANTHROPIC_TEXT_EVENTS, { eventLines: true })
    }
    throw new Error(`BL-1782 test: no network for ${url}`)
  }))
}

/** The event fetch: a forward to `/api/sse` reaches the real route; nothing else is called. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const forward = JSON.parse(String(init?.body ?? '{}'))
  mocks.forwards.push(forward)
  if (forward.type === 'error') mocks.savedAtError.push(await stored(REPLY))
  return SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
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
        content: 'What is 2 plus 2? Answer with one number.',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'What is 2 plus 2? Answer with one number.' }]
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

/** The page's Approve on the card the first send saved: the paused reply's metadata plus the answer. */
function approve(card: any): Promise<Response> {
  const approvalId = card.metadata.toolApprovals.approvals[0].approvalId
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: '',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'What is 2 plus 2? Answer with one number.' }, card],
        metadata: {
          ...card.metadata,
          toolApprovalResponse: [{ type: 'tool-approval-response', approvalId, approved: true, reason: 'User approved' }]
        }
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

async function usePreset(connection: Record<string, unknown> | null) {
  await redis.set(`model:${PRESET}`, {
    id: PRESET,
    name: 'Claude Haiku 5.5',
    provider: 'anthropic',
    modelId: 'claude-haiku-5-5',
    contextWindow: 200_000,
    capabilities: {},
    settings: {},
    ...(connection ? { connection } : {})
  })
}

describe('send-routed: a Vercel AI Gateway tool call the installed SDK cannot run (BL-1782, the real handler and SDK)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl1782-${count}`
    mocks.toolRuns = []
    mocks.approval = false
    mocks.forwards = []
    mocks.savedAtError = []
    providerRequests.length = 0
    anthropicCalls = 0
    eventFetch.mockClear()
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, envRecord[key]]))
    // send-routed's forwards are trusted internal ones, as in the app (BL-775).
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    // The Gateway key on the instance: a preset with no connection resolves to it by name.
    envRecord.AI_GATEWAY_API_KEY = 'test-bl1782-gateway-key'
    envRecord.AI_GATEWAY_BASE_URL = GATEWAY_BASE_URL
    stubProviderNetwork()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Lark', displayName: 'Lark', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-1782', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete envRecord[key]
      else envRecord[key] = previousEnv[key]
    }
    __resetReplyRecordsForTests()
  })

  it('fails the reply with GATEWAY_STREAM_FORMAT and its named words, not the empty-response 502', async () => {
    await usePreset(null)
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const response = await send()

    expect(providerRequests).toEqual([`${GATEWAY_BASE_URL}/language-model`])
    expect(mocks.toolRuns).toEqual([])
    const body = await response.json()
    expect({ status: response.status, body }).toEqual({
      status: 502,
      body: { error: NAMED_ERROR, code: 'GATEWAY_STREAM_FORMAT' }
    })

    // The failed record names the code and the words, and it was saved before the tabs were told
    // (BL-775): the `error` event found it in Redis.
    const failedRecord = {
      status: 'error',
      metadata: expect.objectContaining({
        response_failed: true,
        error_message: NAMED_ERROR,
        error_code: 'GATEWAY_STREAM_FORMAT',
        http_status: 502,
        usage: null
      })
    }
    const saved = await stored(REPLY)
    expect(saved).toMatchObject(failedRecord)
    expect(saved.content).toContain(NAMED_ERROR)
    expect(mocks.savedAtError).toHaveLength(1)
    expect(mocks.savedAtError[0]).toMatchObject(failedRecord)
    const errorEvent = mocks.forwards.find((event) => event.type === 'error')
    expect(JSON.stringify(errorEvent)).toContain(NAMED_ERROR)
    expect(JSON.stringify(errorEvent)).toContain('GATEWAY_STREAM_FORMAT')
    expect(mocks.forwards.some((event) => event.type === 'tool-result')).toBe(false)

    // The Execution Viewer has the failure recorder's account of the call, not a finished reply:
    // the SDK still called onEnd, and before the refusal that callback wrote an exact summary that
    // counted the call that never ran, and took the record from the failure path (BL-1596, BL-245).
    const snapshot: any = await executionViewerService.getSnapshot(SESSION, REPLY)
    expect(snapshot?.runtime?.status).toBe('failed')
    expect(snapshot?.responseSummary).toBeUndefined()
    // The recorder's row for the one call: its own raw per-call counts may show; no result ran.
    expect(snapshot?.llmCalls).toHaveLength(1)
    expect(snapshot?.llmCalls?.[0]).toMatchObject({ toolCallsCount: 1, toolResultsCount: 0 })
    // A failed reply's whole bill stays unknown (BL-1596), never the finish path's exact sum.
    expect(snapshot?.llmSummary?.totalUsage?.inputTokens?.value ?? null).toBeNull()
    expect(snapshot?.llmSummary?.totalUsage?.outputTokens?.value ?? null).toBeNull()
  }, 60_000)

  it('fails a step that raised a card for one call and left a plain call unrun, naming the plain one', async () => {
    await usePreset(null)
    mocks.approval = true
    // Synthetic: the captured answer with a second call (a tool with no approval) before its finish.
    const finishAt = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.findIndex((event) => event.type === 'finish')
    gatewayAnswer = [
      ...GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.slice(0, finishAt),
      { type: 'tool-input-start', id: 'toolu_fixture_1782_9', toolName: 'test-reader' },
      { type: 'tool-input-delta', id: 'toolu_fixture_1782_9', delta: '{"path": "/notes/plan.md"}' },
      { type: 'tool-input-end', id: 'toolu_fixture_1782_9' },
      { type: 'tool-call', toolCallId: 'toolu_fixture_1782_9', toolName: 'test-reader', input: '{"path": "/notes/plan.md"}' },
      ...GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.slice(finishAt)
    ]
    const response = await send()

    const readerError = NAMED_ERROR.replace('the tool call test-researcher', 'the tool call test-reader')
    expect(mocks.toolRuns).toEqual([])
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: readerError, code: 'GATEWAY_STREAM_FORMAT' })
    expect(mocks.forwards.some((event) => event.type === 'tool_approval_request')).toBe(true)
    const saved = await stored(REPLY)
    expect(saved).toMatchObject({ status: 'error', metadata: expect.objectContaining({ error_message: readerError, error_code: 'GATEWAY_STREAM_FORMAT' }) })
    // The reply failed, so its record holds no card to answer.
    expect(saved.metadata?.toolApprovals).toBeUndefined()
    expect(mocks.savedAtError).toHaveLength(1)
    expect(mocks.savedAtError[0]?.metadata?.error_code).toBe('GATEWAY_STREAM_FORMAT')
  }, 60_000)

  it('keeps the words written before the call and fails the reply by name, where it was saved as finished', async () => {
    await usePreset(null)
    // The captured answer with words before its tool call (the text parts as the Gateway sends them).
    const metadataAt = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.findIndex((event) => event.type === 'response-metadata')
    gatewayAnswer = [
      ...GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.slice(0, metadataAt + 1),
      { type: 'text-start', id: 'txt_fixture_1782_2' },
      { type: 'text-delta', id: 'txt_fixture_1782_2', delta: 'Let me ask the researcher. ' },
      { type: 'text-end', id: 'txt_fixture_1782_2' },
      ...GATEWAY_V2_FINISH_TOOL_CALL_EVENTS.slice(metadataAt + 1)
    ]
    const response = await send()

    expect(mocks.toolRuns).toEqual([])
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: NAMED_ERROR, code: 'GATEWAY_STREAM_FORMAT' })
    const saved = await stored(REPLY)
    expect(saved.content).toContain('Let me ask the researcher.')
    expect(saved.metadata).toMatchObject({
      response_failed: true,
      error_message: NAMED_ERROR,
      error_code: 'GATEWAY_STREAM_FORMAT',
      http_status: 502
    })
    expect(mocks.savedAtError).toHaveLength(1)
    expect(mocks.savedAtError[0]?.content).toContain('Let me ask the researcher.')
    expect(mocks.savedAtError[0]?.metadata).toMatchObject({ response_failed: true, error_code: 'GATEWAY_STREAM_FORMAT' })
  }, 60_000)

  it('raises and saves a Gateway tool call\'s approval card as before, and Approve runs the tool', async () => {
    await usePreset(null)
    mocks.approval = true
    gatewayAnswer = GATEWAY_V2_FINISH_TOOL_CALL_EVENTS
    const response = await send()

    // As on base: the card is the reply, saved complete with its pending approval, 200.
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, messageId: REPLY })
    expect(mocks.toolRuns).toEqual([])
    const card = await stored(REPLY)
    expect(card.status).toBe('complete')
    expect(card.metadata?.response_failed).toBeUndefined()
    expect(card.metadata?.toolApprovals?.approvals?.map((entry: any) => ({ toolName: entry.toolName, status: entry.status }))).toEqual([
      { toolName: 'test-researcher', status: 'pending' }
    ])
    expect(mocks.forwards.map((event) => event.type)).toEqual(expect.arrayContaining(['tool_approval_request', 'end', 'complete']))
    expect(mocks.forwards.some((event) => event.type === 'error')).toBe(false)

    // Approve: the SDK runs the approved call before the next model call, which answers in words.
    mocks.forwards = []
    gatewayAnswer = GATEWAY_V2_FINISH_TEXT_EVENTS
    const click = await approve(card)

    expect(click.status).toBe(200)
    expect(mocks.toolRuns).toEqual([{ chatInput: 'What is 2 plus 2? Answer with one number.' }])
    expect(providerRequests).toEqual([`${GATEWAY_BASE_URL}/language-model`, `${GATEWAY_BASE_URL}/language-model`])
    const resumed = await stored(REPLY)
    expect(resumed.metadata?.response_failed).toBeUndefined()
    expect(resumed.content).toContain('Two plus two is 4.')
    expect(mocks.forwards.some((event) => event.type === 'tool-result')).toBe(true)
    expect(mocks.forwards.some((event) => event.type === 'error')).toBe(false)
  }, 60_000)

  it('saves a Gateway reply of words only as before', async () => {
    await usePreset(null)
    gatewayAnswer = GATEWAY_V2_FINISH_TEXT_EVENTS
    const response = await send()

    expect(providerRequests).toEqual([`${GATEWAY_BASE_URL}/language-model`])
    expect(response.status).toBe(200)
    const saved = await stored(REPLY)
    expect(saved.content).toBe('Two plus two is 4.')
    expect(saved.metadata?.response_failed).toBeUndefined()
    expect(saved.metadata?.error_code).toBeUndefined()
    expect(mocks.forwards.some((event) => event.type === 'error')).toBe(false)
  }, 60_000)

  it('runs the tool on a direct Anthropic connection, as before', async () => {
    await usePreset({ type: 'direct', service: 'anthropic', id: 'direct:anthropic' })
    const response = await send()

    expect(providerRequests).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages'])
    expect(response.status).toBe(200)
    expect(mocks.toolRuns).toEqual([{ chatInput: 'What is 2 plus 2? Answer with one number.' }])
    const saved = await stored(REPLY)
    expect(saved.metadata?.response_failed).toBeUndefined()
    expect(saved.content).toContain('The researcher says 4.')
    expect(mocks.forwards.some((event) => event.type === 'tool-result')).toBe(true)
  }, 60_000)
})
