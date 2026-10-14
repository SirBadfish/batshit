// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { claudeApiErrorResult, claudeSessionCrashResult } from '$lib/test-utils/claude-stream-error-results'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { buildTokenUsage } from '$lib/server/services/executionViewerLlmCapture'
import { mergeResumedTokenUsage, mergeResumedUsage } from '$lib/server/services/approvalResumeMessage'
import { __resetStreamAbortRegistryForTests, abortStream } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests, enqueueSteer } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests, registerWakeRun } from '$lib/server/services/wakeRunRegistry'
import { internalServiceHeaders } from '$lib/server/services/internalRequestAuth'
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
 * BL-474 step 2 through the real send-routed handler: where each picture of a reply came from is
 * decided by the server at the reply's end, stored beside the reply, and written BEFORE `end`.
 * The harness is BL-775's (`send-routed-reply-record-handler.test.ts`): a fake `/api/sse` that
 * records the reply, a fake compile, and a fake API model.
 *
 * Below, the original notes of that harness:
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

const USER = 'user-bl474'
const AGENT = 'agent-bl474'
const PRESET = 'preset-bl474'
const REPLY = 'msg-reply-bl775'
const CARD = 'msg-card-bl775'
const APPROVAL = 'aitxt-bl775'
const GROUP = 'group-bl474-image-origin'
const GROUP_MEMBER = 'agent-bl474-image-origin-member'
const PAUSE_USAGE = { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 }
const RESUME_USAGE = { inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500 }
const FINAL_UNCONSUMED = 'https://never-consumed.example/x.png'
const SERVICE_TOKEN = 'test-internal-token-bl474-image-origin'
const envRecord = env as Record<string, string | undefined>

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
  plan: 'reply' as 'reply' | 'stop' | 'fail-first' | 'stop-setup' | 'acquire-fail' | 'abort-user-onabort',
  abortDuringStream: null as null | (() => void),
  sdkOnAbortCalls: 0,
  observedAbortReason: undefined as unknown,
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
  storedAtComplete: undefined as any,
  /** The image-origin record of the reply when `start` and when `end` were forwarded. */
  originAtStart: undefined as any,
  originAtEnd: undefined as any,
  originAtEnds: [] as Array<{ messageId: string; record: any }>,
  /** The tool result the fake run delivered (in its response messages). */
  toolResultText: null as string | null,
  /** More than one same-step tool result, in provider delivery order. */
  parallelToolResults: null as string[] | null,
  /** Hides final transcripts to prove the dispatch observer is the source of delivery. */
  omitFinalResponseMessages: false,
  /** Whether the fake SDK consumed that result in a later provider request. */
  observeToolResult: true,
  /** Simulates a prepared-step steer that is taken but never reaches a model request. */
  takeSteerWithoutDispatch: false,
  takenSteers: [] as Array<Record<string, any>>,
  /** Exact API request observations supplied to the route's real collector. */
  apiInputObservations: [] as Array<Record<string, any>>,
  finalResponseMessages: [] as any[],
  onFinishCalls: 0,
  /** A compile refusal before any model request. */
  compileFails: false,
  compileCalls: 0,
  /** A malformed group compile fixture for the pending-record contract. */
  compiledLedgerMode: 'complete' as 'complete' | 'missing',
  /** The SDK may choose final text even when its stream yielded no real text chunk. */
  emitRealText: true,
  finishTextOverride: null as string | null,
  /** Makes the real group scheduler run one follow-up speaker after the driver. */
  groupReplies: false,
  /** The compile's labelled pieces (landing 1's `addressSources`). */
  compiledPieces: [] as Array<{ source: string; text: string; messageId?: string }>,
  /** The options send-routed handed the compile. */
  compileOptions: null as any,
  /** The CLI bridge is fake; its event adapter and the route's result callback are real. */
  managedEvents: [] as any[],
  managedObservedUsage: null as Record<string, number> | null,
  managedRequest: null as any,
  managedSteerIds: [] as string[],
  managedSteerPayloads: [] as Array<{ steerIds: string[]; text: string }>,
  runManaged: null as null | ((lane: 'codex' | 'claude', request: any) => Promise<any>)
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

    async buildFormattedChatInput(...args: any[]) {
      mocks.compileCalls++
      mocks.compileOptions = args[6] ?? null
      mocks.stopDuringSetup?.()
      if (mocks.compileFails) throw new Error('Compiler refused the prompt (test).')
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Say two parts.' }], metadata: {} },
        resolvedProjectPath: null,
        addressSources: {
          pieces: mocks.compiledPieces,
          nonTextInputs: 0,
          ...(mocks.compiledLedgerMode === 'complete' ? { unaccountedInputs: 0 } : {})
        }
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      if (mocks.plan === 'acquire-fail') throw new Error('The provider refused the connection (test).')
      const toV4Prompt = (messages: any[]) => messages.map((message) => {
        if (message?.role === 'system') return { role: 'system', content: message.content }
        if (message?.role === 'user') {
          const content = typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : (Array.isArray(message.content) ? message.content.flatMap((part: any) => {
                if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }]
                if (part?.type === 'image' || part?.type === 'file') {
                  return [{ type: 'file', data: part.data ?? part.image, mediaType: part.mediaType ?? 'image' }]
                }
                return []
              }) : [])
          return { role: 'user', content }
        }
        if (message?.role === 'assistant') {
          return {
            role: 'assistant',
            content: (Array.isArray(message.content) ? message.content : []).flatMap((part: any) => {
              if (part?.type === 'tool-call') return [{
                type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName,
                input: part.input, providerExecuted: part.providerExecuted
              }]
              if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }]
              return []
            })
          }
        }
        if (message?.role === 'tool') {
          return {
            role: 'tool',
            content: (Array.isArray(message.content) ? message.content : []).flatMap((part: any) =>
              part?.type === 'tool-result' ? [{
                type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName,
                output: part.output, providerExecuted: part.providerExecuted
              }] : [])
          }
        }
        return { role: message?.role, content: [] }
      })
      const withApprovedToolResults = (messages: any[]) => {
        const callsByApproval = new Map<string, { toolCallId: string; toolName: string }>()
        for (const message of messages) {
          if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
          const toolCall = message.content.find((part: any) => part?.type === 'tool-call')
          for (const approval of message.content.filter((part: any) => part?.type === 'tool-approval-request')) {
            if (toolCall?.toolCallId && toolCall.toolName && approval?.approvalId) {
              callsByApproval.set(approval.approvalId, { toolCallId: toolCall.toolCallId, toolName: toolCall.toolName })
            }
          }
        }
        const results = messages.flatMap((message) =>
          message?.role === 'tool' && Array.isArray(message.content)
            ? message.content.flatMap((part: any) => {
                if (part?.type !== 'tool-approval-response' || part.approved !== true) return []
                const call = callsByApproval.get(part.approvalId)
                if (!call) return []
                return [{
                  type: 'tool-result',
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  output: { type: 'text', value: 'Approved tool completed in the fake SDK fixture.' }
                }]
              })
            : []
        )
        const appended = results.length ? [...messages, { role: 'tool', content: results }] : messages
        return { messages: appended, responseMessages: results.length ? [{ role: 'tool', content: results }] : [] }
      }
      const observeApiRequest = (messages: any[]) => {
        const compiledMessages = request.imageOriginInput?.compiledMessages ?? request.messages
        const observation = {
          compiledMessages,
          promptMessages: toV4Prompt(messages),
          toolDefinitions: [],
          compiledPrefixCount: request.imageOriginInput?.compiledPrefixCount ?? -1,
          initialSystem: compiledMessages.filter((message: any) => message?.role === 'system'),
          userSources: request.imageOriginInput?.userSources ?? []
        }
        mocks.apiInputObservations.push(observation)
        request.onApiModelInput?.(observation)
      }
      const approvalExecution = withApprovedToolResults(request.messages)
      observeApiRequest(approvalExecution.messages)
      const words = [...mocks.words]
      const groupPrefix = mocks.groupReplies ? '<batshit-group>{"mode":"responding"}</batshit-group>' : ''
      const text = mocks.finishTextOverride ?? `${groupPrefix}${words.join('')}`
      const usage = request.messageId === 'msg-card-bl775' ? { inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500 } : { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        if (mocks.plan === 'fail-first') {
          yield { type: 'error', error: new Error('Provider exploded before a word.') }
          return
        }
        if (mocks.emitRealText) {
          yield { type: 'text-start', id: 't1' }
          for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
        }
        if (mocks.plan === 'stop') {
          const stop = new Error('Stream interrupted by user')
          stop.name = 'AbortError'
          throw stop
        }
        if (mocks.plan === 'abort-user-onabort') {
          mocks.abortDuringStream?.()
          mocks.observedAbortReason = request.abortSignal?.reason
          mocks.sdkOnAbortCalls++
          await request.onAbort?.({ steps: [] })
          const stop = new Error('SDK stream aborted after its onAbort callback')
          stop.name = 'AbortError'
          throw stop
        }
        if (mocks.emitRealText) yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        const toolResultTexts = mocks.parallelToolResults ?? (mocks.toolResultText === null ? [] : [mocks.toolResultText])
        const responseMessages = toolResultTexts.length === 0 ? [] : [
          {
            role: 'assistant',
            content: toolResultTexts.map((_value, index) => ({
              type: 'tool-call',
              toolCallId: index === 0 ? 'call_web' : `call_web_${index + 1}`,
              toolName: index === 0 ? 'web_fetch' : `web_fetch_${index + 1}`,
              input: { url: `https://source-${index + 1}.example.org/` }
            }))
          },
          {
            role: 'tool',
            content: toolResultTexts.map((value, index) => ({
              type: 'tool-result',
              toolCallId: index === 0 ? 'call_web' : `call_web_${index + 1}`,
              toolName: index === 0 ? 'web_fetch' : `web_fetch_${index + 1}`,
              output: { type: 'text', value }
            }))
          }
        ]
        if (mocks.takeSteerWithoutDispatch && responseMessages.length > 0) {
          mocks.takenSteers = request.takeSteers?.(1) ?? []
        }
        // Only a result the model consumes belongs to a later prompt. The final finish
        // transcript alone is deliberately not treated as model-input evidence.
        if (mocks.observeToolResult && responseMessages.length > 0) {
          observeApiRequest([...approvalExecution.messages, ...responseMessages])
        }
        mocks.finalResponseMessages = mocks.omitFinalResponseMessages
          ? approvalExecution.responseMessages
          : [...approvalExecution.responseMessages, ...responseMessages]
        if (request.onFinish) mocks.onFinishCalls++
        await request.onFinish?.({
          text,
          steps: [],
          totalUsage: usage,
          usage,
          reasoning: [],
          responseMessages: mocks.finalResponseMessages
        })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

vi.mock('$lib/server/services/codexBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  CodexBridge: class {
    async streamNativeMode(request: any) { return mocks.runManaged!('codex', request) }
  }
}))

vi.mock('$lib/server/services/claudeBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  ClaudeBridge: class {
    async streamNativeMode(request: any) { return mocks.runManaged!('claude', request) }
  }
}))

mocks.runManaged = async (lane, request) => {
  mocks.managedRequest = request
  const onFinish = async (payload: any) => {
    mocks.onFinishCalls++
    await request.onFinish?.(payload)
  }
  const adapter = lane === 'codex'
    ? new (await import('$lib/server/services/codexEventAdapter')).CodexEventAdapter({ request, transport: 'cli', onFinish, getObservedUsage: () => mocks.managedObservedUsage })
    : new (await import('$lib/server/services/claudeEventAdapter')).ClaudeEventAdapter({ request, transport: 'cli', onFinish })
  async function* events() {
    for (const event of mocks.managedEvents) yield event
  }
  return {
    stream: adapter.stream(events() as any),
    __steerLane: lane,
    __steer: async (payload: { steerIds: string[]; text: string }) => {
      mocks.managedSteerPayloads.push(payload)
      return lane === 'codex' ? { accepted: true } : true
    }
  }
}

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
let GETImageOrigins: (event: any) => Promise<Response>
let SESSION = ''
let count = 0
let previousServiceToken: string | undefined

async function originOf(id: string) {
  return (await redis.execute((client: any) => client.json.get(`image_origin:${SESSION}:${id}`))) as any
}

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
    if (mocks.originAtStart === undefined) mocks.originAtStart = await originOf(event.messageId)
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
    mocks.originAtEnd = await originOf(event.messageId)
    mocks.originAtEnds.push({ messageId: event.messageId, record: mocks.originAtEnd })
  } else if (event.type === 'error' && mocks.storedAtError === undefined) {
    mocks.storedAtError = await stored(event.messageId)
  } else if (event.type === 'complete' && mocks.storedAtComplete === undefined) {
    mocks.storedAtComplete = await stored(event.messageId)
  } else if (event.messageId) {
    recordReplyEvent(event.sessionId, { ...event })
  }
  return new Response(JSON.stringify({ success: true }), { status: 200 })
}

function send(signal?: AbortSignal, messageId = REPLY, agentType: 'api' | 'cli' = 'api'): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType,
        content: 'Say two parts.',
        messageId,
        messages: [{ id: messageId === REPLY ? 'msg-user-1' : `${messageId}-user`, role: 'user', content: 'Say two parts.' }]
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

function createImageOriginApprovalFixture() {
  const requestedAt = new Date().toISOString()
  const replaySteerText = '[The user said, mid-reply: Previous steer https://replayed-user.example/prior.png]'
  const userMessage = {
    id: 'msg-user-approval-bl474', session_id: SESSION, user_id: USER, role: 'user', content: 'List the folder.',
    created_at: requestedAt, metadata: {}
  }
  const cardMetadata = {
    imageOriginExpected: true,
    imageOriginExpectedVersion: 1,
    approvalResumeVersion: 1,
    model: 'claude-sonnet-5',
    agentType: 'api',
    zipIds: [],
    providerMessages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_find', toolName: 'web_fetch', input: { url: 'https://source.example.org/' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_find', toolName: 'web_fetch', output: { type: 'text', value: `found ${PAUSED_READ}` } }] },
      { role: 'user', content: [{ type: 'text', text: replaySteerText }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_ls', toolName: 'native_bash_execute', input: { command: 'ls' } },
          { type: 'tool-approval-request', approvalId: APPROVAL, toolCallId: 'call_ls' }
        ]
      }
    ],
    providerMessageSource: { providerId: 'anthropic', connectionId: null, modelId: 'claude-sonnet-5' },
    providerUserSources: [{
      textHash: sha256Hex(replaySteerText),
      spans: [{ start: 0, end: replaySteerText.length, source: 'user' }]
    }],
    toolApprovals: {
      mode: 'all',
      approvals: [{ approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', requestedAt, input: { command: 'ls' } }],
      source: 'vercel'
    }
  }
  const card = {
    id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', status: 'complete',
    content: `Asking first. <img src="${BUILT}">`, created_at: requestedAt, metadata: cardMetadata
  }
  return { userMessage, cardMetadata, card, replaySteerText }
}

async function seedImageOriginApprovalFixture(fixture: ReturnType<typeof createImageOriginApprovalFixture>) {
  await redis.saveMessage(fixture.userMessage as any)
  await redis.saveMessage(fixture.card as any)
  const record = {
    messageId: CARD,
    version: 1,
    state: 'decided' as const,
    textHashes: [sha256Hex(fixture.card.content)],
    lane: 'api' as const,
    complete: true,
    addresses: {
      [BUILT]: {
        state: 'blocked' as const,
        rule: 4 as const,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
      }
    }
  }
  await redis.writeImageOriginRecord({
    userId: USER, sessionId: SESSION, messageId: CARD, version: 1, state: 'decided', record
  })
  return record
}

function postImageOriginApprovalResume(fixture: ReturnType<typeof createImageOriginApprovalFixture>) {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION, agentId: AGENT, agentType: 'api', content: '', messageId: CARD,
        messages: [fixture.userMessage, fixture.card],
        metadata: {
          ...fixture.cardMetadata,
          toolApprovalMode: 'all',
          toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }]
        }
      })
    }),
    fetch: sseForward,
    locals: { user: { id: USER } }
  } as any)
}

import { sha256Hex } from '$lib/utils/sha256'

const READ = 'https://pictures.example.org/cats/tabby.png'
const BUILT = 'https://collect.example.net/p.png?d=joshs-note'
const EARLIER = 'https://earlier.example.org/e.png'
const PAUSED_READ = 'https://paused.example.org/p.png'
const UNOBSERVED_STEER = 'https://missed-steer.example/x.png'
const PARALLEL_RESULT_TWO = 'https://parallel-two.example.org/second.png'

async function useManagedAgent(lane: 'codex' | 'claude') {
  const provider = lane === 'codex' ? 'codex' : 'claude-cli'
  const modelId = lane === 'codex' ? 'gpt-6-astra' : 'sonnet'
  await redis.set(`model:${PRESET}`, { ...model, provider, modelId, modelName: modelId })
  await redis.createAgent({
    id: AGENT, user_id: USER, name: 'Managed probe', displayName: 'Managed probe', agentType: 'cli',
    primary_model_provider: provider, primary_model_name: modelId, primary_model_preset_id: PRESET,
    ...(lane === 'codex'
      ? { codex_settings: { permissionMode: 'chat', model: modelId, sandbox: 'read-only', approval: 'never', search: true } }
      : { claude_settings: { permissionMode: 'chat', model: modelId, addDirs: [], allowedTools: [], disallowedTools: [] } })
  } as any)
}

function managedReplyEvents(lane: 'codex' | 'claude', text: string, result?: { text: string; displayOnly: string }) {
  const events: any[] = []
  if (result) {
    if (lane === 'codex') {
      events.push(
        { type: 'item.started', item: { id: 'raw-lookup', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', arguments: {} } },
        { type: 'item.completed', item: { id: 'raw-lookup', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: result.text }], structured_content: { image: result.displayOnly } } } }
      )
    } else {
      events.push(
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'raw-lookup', name: 'mcp__docs__lookup', input: {} }] } },
        { type: 'user', tool_use_result: { stdout: result.displayOnly }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'raw-lookup', content: [{ type: 'text', text: result.text }] }] } }
      )
    }
  }
  if (mocks.managedSteerIds.length > 0) events.push(lane === 'codex'
    ? { type: 'steer.delivered', steer_ids: [...mocks.managedSteerIds] }
    : { type: 'batshit_steer_delivered', steer_ids: [...mocks.managedSteerIds] })
  events.push(...(lane === 'codex'
    ? [
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }
      ]
    : [
        { type: 'assistant', message: { content: [{ type: 'text', text }] } },
        { type: 'result', result: text, usage: { input_tokens: 10, output_tokens: 2 } }
      ]))
  return events
}

describe('send-routed: where each picture of a reply came from (BL-474 step 2, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    ;({ GET: GETImageOrigins } = await import('../../image-origins/+server'))
  }, 120_000)

  beforeEach(async () => {
    previousServiceToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    count += 1
    SESSION = `session-bl474-${count}`
    mocks.words = [`Look: <img src="${READ}"> `, `and <img src="${BUILT}">`]
    mocks.forwards = []
    mocks.failForwardOf = null
    mocks.failChunkText = null
    mocks.hangChunkText = null
    mocks.slowChunkText = null
    mocks.slowChunkMs = 0
    mocks.detectZips = false
    mocks.plan = 'reply'
    mocks.abortDuringStream = null
    mocks.sdkOnAbortCalls = 0
    mocks.observedAbortReason = undefined
    mocks.saveFailures = 0
    mocks.noticeThrowsFor = null
    mocks.storedAtEnd = null
    mocks.storedAtError = undefined
    mocks.storedAtComplete = undefined
    mocks.stopDuringSetup = null
    mocks.originAtStart = undefined
    mocks.originAtEnd = undefined
    mocks.originAtEnds = []
    mocks.toolResultText = `{"image":"${READ}"}`
    mocks.parallelToolResults = null
    mocks.omitFinalResponseMessages = false
    mocks.observeToolResult = true
    mocks.takeSteerWithoutDispatch = false
    mocks.takenSteers = []
    mocks.apiInputObservations = []
    mocks.finalResponseMessages = []
    mocks.onFinishCalls = 0
    mocks.compileFails = false
    mocks.compileCalls = 0
    mocks.compiledLedgerMode = 'complete'
    mocks.emitRealText = true
    mocks.finishTextOverride = null
    mocks.groupReplies = false
    mocks.compiledPieces = [{ source: 'user', text: 'Show me the cat you find.' }]
    mocks.managedEvents = []
    mocks.managedObservedUsage = null
    mocks.managedRequest = null
    mocks.managedSteerIds = []
    mocks.managedSteerPayloads = []
    sseForward.mockClear()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetReplyRecordsForTests()
    __resetClaudeApprovalRegistryForTests()
    __resetWakeRunRegistryForTests()
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
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-474', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetReplyRecordsForTests()
    __resetWakeRunRegistryForTests()
    if (previousServiceToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousServiceToken
  })

  // Real adapters, send handler, Redis persistence and reply-event recorder; only the CLI
  // bridge/events and compiler are stand-ins. This closes the combined usage gap without
  // starting a CLI. Resume assertions consume the actual saved half through the shared merge
  // rules; the in-place resume handler itself has its separate accounting suite.
  it.each([true, false])('BL-1361 saves and reloads partial observed usage once after a failure (streamed words: %s)', async (hasWords) => {
    await useManagedAgent('codex')
    mocks.managedObservedUsage = { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 30 }
    mocks.managedEvents = [
      ...(hasWords ? [{ type: 'item.completed', item: { id: 'observed-answer', type: 'agent_message', text: 'Partial observed reply.' } }] : []),
      { type: 'turn.failed', error: { message: 'Synthetic failure after observed work.' } },
    ]
    const writes = vi.spyOn(executionViewerService, 'updateSnapshot')
    const response = await send(undefined, REPLY, 'cli')
    expect(response.status).toBe(500)
    expect(mocks.onFinishCalls).toBe(1)
    const saved = await stored(REPLY)
    const expected = { completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20, cacheCreationInputTokens: 30 } }] }
    expect(saved.metadata.observedUsage).toEqual(expected)
    expect(saved.metadata.usage).toBeNull()
    expect(saved.metadata.response_failed).toBe(true)
    expect(saved.metadata.performance?.outputTokensPerSecond ?? null).toBeNull()
    const snapshot = await executionViewerService.getSnapshot(SESSION, REPLY)
    expect(snapshot?.responseSummary?.observedUsage).toEqual(expected)
    expect(snapshot?.responseSummary?.usage.totalTokens.value).toBeNull()
    expect(snapshot?.llmSummary?.totalUsage.totalTokens.value).toBeNull()
    expect(writes.mock.calls.filter(([, id, patch]) => id === REPLY && Array.isArray(patch.llmCalls))).toHaveLength(1)
    expect(mocks.forwards.filter((event) => event.type === 'finish')).toHaveLength(0)
    const ends = mocks.forwards.filter((event) => event.type === 'end' && event.messageId === REPLY)
    expect(ends).toHaveLength(hasWords ? 1 : 0)
    if (hasWords) {
      expect(saved.content).toBe('Partial observed reply.')
      expect(ends[0].metadata.observedUsage).toEqual(saved.metadata.observedUsage)
      expect(mocks.storedAtEnd.metadata.observedUsage).toEqual(expected)
    }
    const { GET } = await import('../../sessions/[sessionId]/execution-log/+server')
    const reload = await GET({ params: { sessionId: SESSION }, locals: { user: { id: USER } } } as any)
    const entries = (await reload.json()).entries
    expect(entries.find((entry: any) => entry.id === REPLY).responseSummary.observedUsage).toEqual(expected)
  }, 30_000)

  it.each([
    { name: 'Codex absent usage', lane: 'codex' as const, usage: undefined, input: null, output: null, total: null, cacheWrite: null, confidence: 'estimated', failed: false },
    { name: 'Codex partial usage', lane: 'codex' as const, usage: { input_tokens: 10 }, input: 10, output: null, total: null, cacheWrite: null, confidence: 'exact', failed: false },
    { name: 'Codex reported zeros', lane: 'codex' as const, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }, input: 0, output: 0, total: 0, cacheWrite: 0, confidence: 'exact', failed: false },
    { name: 'Codex inclusive input with cache writes (BL-1383)', lane: 'codex' as const, usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 10, reasoning_output_tokens: 0 }, input: 100, output: 10, total: 110, cacheWrite: 30, confidence: 'exact', failed: false },
    { name: 'Claude failed result with reported usage', lane: 'claude' as const, result: claudeApiErrorResult('Usage probe failed after accounted calls.', 503), input: 2566, output: 40, total: 2606, cacheWrite: 512, confidence: 'exact', failed: true },
    { name: 'Claude crash-template zeros stay unknown', lane: 'claude' as const, result: claudeSessionCrashResult(['Usage probe crashed.']), input: null, output: null, total: null, cacheWrite: null, confidence: 'estimated', failed: true }
  ])('$name preserves usage across its one evidence writer, save, end and resume merge', async (probe) => {
    await useManagedAgent(probe.lane)
    const text = 'A measured reply.'
    mocks.managedEvents = probe.lane === 'codex'
      ? [
          { type: 'item.completed', item: { id: 'usage-answer', type: 'agent_message', text } },
          { type: 'turn.completed', usage: probe.usage }
        ]
      : [
          { type: 'assistant', message: { content: [{ type: 'text', text }] } },
          probe.result
        ]
    const writes = vi.spyOn(executionViewerService, 'updateSnapshot')

    const response = await send(undefined, REPLY, 'cli')
    expect(response.status, await response.clone().text()).toBe(probe.failed ? 500 : 200)
    expect(mocks.onFinishCalls).toBe(1)
    const captureWrites = writes.mock.calls.filter(([, id, patch]) => id === REPLY && Array.isArray(patch.llmCalls))
    expect(captureWrites).toHaveLength(1)
    const saved = await stored(REPLY)
    const snapshot = await executionViewerService.getSnapshot(SESSION, REPLY)
    expect(saved.content).toBe(text)
    expect(snapshot?.llmCalls).toHaveLength(1)
    for (const usage of [snapshot?.responseSummary?.usage, snapshot?.llmSummary?.totalUsage]) {
      for (const [field, value] of [['inputTokens', probe.input], ['outputTokens', probe.output], ['totalTokens', probe.total]] as const) {
        expect(usage?.[field].value).toBe(value)
        if (value !== null) expect(usage?.[field].confidence).toBe('exact')
        else if (probe.confidence === 'estimated') expect(usage?.[field].confidence).toBe('estimated')
      }
      expect(usage?.cacheCreationInputTokens?.value ?? null).toBe(probe.cacheWrite)
      if (probe.cacheWrite !== null) expect(usage?.cacheCreationInputTokens?.confidence).toBe('exact')
    }
    if (probe.input === null) {
      expect(saved.metadata?.usage).toBeUndefined()
    } else {
      expect(saved.metadata.usage.inputTokens).toBe(probe.input)
      if (probe.output === null) expect(saved.metadata.usage.outputTokens).toBeUndefined()
      else expect(saved.metadata.usage.outputTokens).toBe(probe.output)
      if (probe.total === null) expect(saved.metadata.usage.totalTokens).toBeUndefined()
      else expect(saved.metadata.usage.totalTokens).toBe(probe.total)
      if (probe.cacheWrite === null) expect(saved.metadata.usage.cacheCreationInputTokens).toBeUndefined()
      else expect(saved.metadata.usage.cacheCreationInputTokens).toBe(probe.cacheWrite)
    }
    const ends = mocks.forwards.filter((event) => event.type === 'end' && event.messageId === REPLY)
    expect(ends).toHaveLength(1)
    expect(ends[0].savedRecord).toBe(true)
    expect(ends[0].metadata.usage).toEqual(saved.metadata?.usage)
    expect(mocks.storedAtEnd.content).toBe(saved.content)
    expect(mocks.storedAtEnd.metadata.usage).toEqual(saved.metadata?.usage)
    expect(mocks.forwards.filter((event) => event.type === 'finish')).toHaveLength(probe.failed || probe.input === null ? 0 : 1)
    if (probe.failed) {
      expect(saved.metadata.response_failed).toBe(true)
      expect(saved.metadata.error_message).toContain(probe.input === null ? 'Usage probe crashed.' : 'Usage probe failed after accounted calls.')
      expect(mocks.storedAtError?.metadata.response_failed).toBe(true)
    } else {
      expect(saved.metadata.response_failed).not.toBe(true)
    }

    const prior = { inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheCreationInputTokens: 2 }
    const resumedUsage = mergeResumedUsage(prior, saved.metadata?.usage)
    const resumedTokens = mergeResumedTokenUsage(buildTokenUsage(prior, 'exact', 'prior'), snapshot?.responseSummary?.usage)
    const summed = { inputTokens: probe.input === null ? null : probe.input + 3, outputTokens: probe.output === null ? null : probe.output + 2, totalTokens: probe.total === null ? null : probe.total + 5 }
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
      expect(resumedTokens?.[field].value).toBe(summed[field])
      if (summed[field] === null) expect(resumedUsage?.[field] ?? null).toBeNull()
      else expect(resumedUsage?.[field]).toBe(summed[field])
    }
    const resumedCacheWrite = probe.cacheWrite === null ? null : probe.cacheWrite + 2
    expect(resumedTokens?.cacheCreationInputTokens?.value ?? null).toBe(resumedCacheWrite)
    expect(resumedUsage?.cacheCreationInputTokens ?? null).toBe(resumedCacheWrite)
  }, 30_000)

  it.each(['codex', 'claude'] as const)('%s raw result callbacks store the right lane, exact as-read evidence, and incomplete unknowns (BL-1024)', async (lane) => {
    await useManagedAgent(lane)
    const absent = 'https://absent-input.example/a.png'
    const displayOnly = 'https://display-only.example/d.png'
    mocks.managedEvents = managedReplyEvents(lane, `<img src="${READ}"><img src="${absent}"><img src="${displayOnly}">`, {
      text: `Fetched ${READ}`, displayOnly
    })
    const response = await send(undefined, REPLY, 'cli')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(mocks.managedRequest.onCliModelResult).toEqual(expect.any(Function))
    expect(mocks.managedRequest.onApiModelInput).toBeUndefined()
    const record = await originOf(REPLY)
    expect(record).toMatchObject({ state: 'decided', lane, complete: false })
    expect(record.addresses[READ]).toEqual({ state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: false } })
    for (const address of [absent, displayOnly]) {
      expect(record.addresses[address]).toEqual({ state: 'unknown', rule: 5, evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: false } })
    }
    expect(record.textHashes).toContain(sha256Hex((await stored(REPLY)).content))
    expect(mocks.originAtEnd).toEqual(record)
  }, 30_000)

  it.each(['codex', 'claude'] as const)('%s with no raw result never invents read evidence from a display or API transcript (BL-1024)', async (lane) => {
    await useManagedAgent(lane)
    mocks.managedEvents = managedReplyEvents(lane, `<img src="${READ}">`)
    const response = await send(undefined, REPLY, 'cli')
    expect(response.status, await response.clone().text()).toBe(200)
    const record = await originOf(REPLY)
    expect(record).toMatchObject({ state: 'decided', lane, complete: false })
    expect(record.addresses[READ]).toMatchObject({ state: 'unknown', rule: 5, evidence: { inRecord: false, complete: false } })
  }, 30_000)

  it.each(['codex', 'claude'] as const)('%s delivered steers preserve user read provenance and agent-note source boundaries (BL-1024)', async (lane) => {
    await useManagedAgent(lane)
    vi.stubEnv('BATSHIT_CODEX_TRANSPORT', 'app-server')
    const userAddress = 'https://user-steer.example/u.png'
    const dmAddress = 'https://dm-steer.example/d.png'
    const secret = 'private-mark-12345'
    const carriesDmText = `https://data-steer.example/p.png?d=${secret}`
    const steers = [
      { steerId: 'managed-user', messageId: REPLY, source: 'user' as const, text: `Show ${userAddress}`, at: new Date().toISOString(), deliver: 'steer' as const },
      { steerId: 'managed-dm', messageId: REPLY, source: 'dm' as const, text: `See ${dmAddress}; code ${secret}`, agentName: 'Mira', at: new Date().toISOString(), deliver: 'steer' as const }
    ]
    for (const steer of steers) expect(enqueueSteer(SESSION, steer).ok).toBe(true)
    mocks.managedSteerIds = steers.map((steer) => steer.steerId)
    mocks.managedEvents = managedReplyEvents(lane, `<img src="${userAddress}"><img src="${dmAddress}"><img src="${carriesDmText}">`)
    try {
      const response = await send(undefined, REPLY, 'cli')
      expect(response.status, await response.clone().text()).toBe(200)
      expect(mocks.managedSteerPayloads).toHaveLength(1)
      expect(mocks.managedSteerPayloads[0].steerIds).toEqual(mocks.managedSteerIds)
      const saved = await stored(REPLY)
      expect(saved.metadata.steers).toEqual(expect.arrayContaining(steers.map((steer) => expect.objectContaining({ steerId: steer.steerId, source: steer.source, text: steer.text }))))
      const record = await originOf(REPLY)
      expect(record).toMatchObject({ state: 'decided', lane, complete: false })
      expect(record.addresses[userAddress]).toMatchObject({ state: 'as_read', rule: 1, evidence: { inRecord: true, complete: false } })
      expect(record.addresses[dmAddress]).toMatchObject({ state: 'unknown', rule: 5, evidence: { inRecord: false, complete: false } })
      expect(record.addresses[carriesDmText]).toMatchObject({ state: 'blocked', rule: 3, evidence: { inRecord: false, sharesChatRun: true, complete: false } })
    } finally {
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it('is pending before the reply streams, and decided before `end`, bound to the saved text', async () => {
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.originAtStart).toEqual({ messageId: REPLY, version: 1, state: 'pending' })

    const saved = await stored(REPLY)
    expect(saved.metadata.imageOriginExpected).toBe(true)
    expect(saved.metadata.imageOriginExpectedVersion).toBe(1)
    expect(mocks.apiInputObservations).toHaveLength(2)
    expect(mocks.apiInputObservations[0].toolDefinitions).toEqual([])
    expect(mocks.apiInputObservations[0].compiledPrefixCount).toBeGreaterThan(0)
    expect(mocks.apiInputObservations[0].initialSystem).toEqual(
      mocks.apiInputObservations[0].compiledMessages.filter((message: any) => message.role === 'system')
    )
    expect(JSON.stringify(mocks.apiInputObservations[1].promptMessages)).toContain(READ)
    // The rebuild trims a reply as the save does, so the saved text and `end`'s text are one text here.
    expect(mocks.forwards.find((event) => event.type === 'end')?.content).toBe(saved.content)
    expect(mocks.originAtEnd).toEqual({
      messageId: REPLY,
      version: 1,
      state: 'decided',
      textHashes: [sha256Hex(saved.content)],
      lane: 'api',
      complete: true,
      addresses: {
        // Delivered in this turn's tool result.
        [READ]: {
          state: 'as_read', rule: 1,
          evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
        },
        // Nowhere in what the agent read (its own tool-call input is its words).
        [BUILT]: {
          state: 'blocked', rule: 4,
          evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
        }
      }
    })
    // The browser's copy of the reply cannot change it: the save route refuses a tab's reply save.
    expect(saved.metadata.imageOrigins).toBeUndefined()
    // Every tab showing the chat is told once, before `end` reaches them.
    const { publishUserEvent } = await import('$lib/server/ssePublisher')
    const told = (publishUserEvent as any).mock.calls.filter((call: any[]) => call[1]?.type === 'image_origin_changed' && call[1]?.sessionId === SESSION)
    expect(told.map((call: any[]) => call[1])).toEqual([{ type: 'image_origin_changed', sessionId: SESSION, messageId: REPLY }])
  }, 30_000)

  it('does not treat a final finish transcript as an unobserved provider request', async () => {
    mocks.words = [`Only in the final reply: <img src="${FINAL_UNCONSUMED}">`]
    mocks.toolResultText = `Tool output not consumed: ${FINAL_UNCONSUMED}`
    mocks.observeToolResult = false

    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.apiInputObservations).toHaveLength(1)
    expect(mocks.originAtEnd.complete).toBe(true)
    expect(mocks.originAtEnd.addresses[FINAL_UNCONSUMED]).toEqual({
      state: 'blocked', rule: 4,
      evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
    })
  }, 30_000)

  it('uses the browser-facing fallback for upload ownership, not the private Docker URL', async () => {
    const browserOwned = 'http://localhost:5600/uploads/browser-owned.png'
    const privateDockerUrl = 'http://batshit-server:5600/uploads/private-only.png'
    vi.stubEnv('BATSHIT_SERVER_URL', 'http://batshit-server:5600')
    mocks.words = [`<img src="${browserOwned}"> <img src="${privateDockerUrl}">`]
    mocks.toolResultText = null
    mocks.compiledPieces = []
    try {
      const response = await send()
      expect(response.status).toBe(200)
      expect(mocks.originAtEnd.addresses).toEqual({
        [privateDockerUrl]: {
          state: 'blocked', rule: 4,
          evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
        }
      })
    } finally {
      vi.unstubAllEnvs()
    }
  }, 30_000)

  it('records both parallel tool outputs from the dispatch prompt even when the final transcript omits them', async () => {
    const secondResultUrl = PARALLEL_RESULT_TWO
    const resultTexts = [`First result ${READ}`, `Second result ${secondResultUrl}`]
    mocks.words = [`Use both: <img src="${READ}"> and <img src="${secondResultUrl}">`]
    mocks.toolResultText = null
    mocks.parallelToolResults = resultTexts
    mocks.omitFinalResponseMessages = true

    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.apiInputObservations).toHaveLength(2)
    const dispatchPrompt = JSON.stringify(mocks.apiInputObservations[1].promptMessages)
    expect(dispatchPrompt).toContain(resultTexts[0])
    expect(dispatchPrompt).toContain(resultTexts[1])
    expect(mocks.finalResponseMessages).toEqual([])
    expect(mocks.originAtEnd.complete).toBe(true)
    expect(mocks.originAtEnd.addresses[READ]).toEqual({
      state: 'as_read', rule: 1,
      evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
    })
    expect(mocks.originAtEnd.addresses[secondResultUrl]).toEqual({
      state: 'as_read', rule: 1,
      evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
    })
  }, 30_000)

  it('binds the final chosen saved text and hash when the SDK emits no streamed text', async () => {
    const finalText = `Chosen at finish only: <img src="${FINAL_UNCONSUMED}">`
    mocks.words = []
    mocks.emitRealText = false
    mocks.finishTextOverride = finalText
    mocks.toolResultText = null
    mocks.parallelToolResults = null
    mocks.omitFinalResponseMessages = false

    const response = await send()
    expect(response.status).toBe(200)
    const saved = await stored(REPLY)
    expect(mocks.forwards.filter((event) => event.type === 'chunk')).toHaveLength(0)
    expect(saved.content).toBe(finalText)
    expect(mocks.forwards.find((event) => event.type === 'end')?.content).toBe(finalText)
    expect(mocks.originAtEnd.textHashes).toEqual([sha256Hex(finalText)])
    expect(mocks.originAtEnd.addresses[FINAL_UNCONSUMED]).toEqual({
      state: 'blocked', rule: 4,
      evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
    })
  }, 30_000)

  it('does not treat a taken steer as read when no later provider request contains it', async () => {
    mocks.words = [`The reply mentions <img src="${UNOBSERVED_STEER}">.`]
    mocks.toolResultText = 'Completed the first tool step.'
    mocks.observeToolResult = false
    mocks.takeSteerWithoutDispatch = true
    const accepted = enqueueSteer(SESSION, {
      steerId: 'steer-never-dispatched',
      messageId: REPLY,
      text: `Please inspect ${UNOBSERVED_STEER}`,
      at: new Date().toISOString(),
      source: 'user',
      deliver: 'steer'
    })
    expect(accepted.ok).toBe(true)

    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.takenSteers).toHaveLength(1)
    expect(mocks.apiInputObservations).toHaveLength(1)
    expect(JSON.stringify(mocks.apiInputObservations[0].promptMessages)).not.toContain(UNOBSERVED_STEER)
    expect(mocks.originAtEnd.complete).toBe(true)
    expect(mocks.originAtEnd.addresses[UNOBSERVED_STEER]).toEqual({
      state: 'blocked', rule: 4,
      evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
    })
  }, 30_000)

  it('keeps the image-origin marker on each follow-up reply id', async () => {
    const firstResponse = await send()
    const followupId = 'msg-follow-up-bl474'
    const followupResponse = await send(undefined, followupId)
    expect(firstResponse.status).toBe(200)
    expect(followupResponse.status).toBe(200)
    expect((await stored(REPLY)).metadata.imageOriginExpected).toBe(true)
    expect((await stored(REPLY)).metadata.imageOriginExpectedVersion).toBe(1)
    expect((await stored(followupId)).metadata.imageOriginExpected).toBe(true)
    expect((await stored(followupId)).metadata.imageOriginExpectedVersion).toBe(1)
    expect((await originOf(followupId)).state).toBe('decided')
  }, 30_000)

  it('preserves image-origin expectation on a compile failure saved before streaming', async () => {
    mocks.compileFails = true
    const response = await send()
    expect(response.status).toBe(500)
    const saved = await stored(REPLY)
    expect(saved?.status).toBe('error')
    expect(saved?.metadata?.imageOriginExpected).toBe(true)
    expect(saved?.metadata?.imageOriginExpectedVersion).toBe(1)
  }, 30_000)

  it('keeps the saved expectation marker when pending and decision Redis writes both fail', async () => {
    const writes: string[] = []
    const spy = vi.spyOn(redis, 'writeImageOriginRecord').mockImplementation(async (input: any) => {
      writes.push(input.state)
      throw new Error(`Redis refused ${input.state} (test)`)
    })
    try {
      const response = await send()
      expect(response.status).toBe(200)
      expect(writes).toEqual(['pending', 'decided'])
      expect((await stored(REPLY)).metadata.imageOriginExpected).toBe(true)
      expect((await stored(REPLY)).metadata.imageOriginExpectedVersion).toBe(1)
      expect(await originOf(REPLY)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it("an earlier reply's picture counts as read only through the server's own decided record", async () => {
    mocks.words = [`Again: <img src="${EARLIER}">`]
    mocks.toolResultText = null
    mocks.compiledPieces = [{ source: 'agent_words', text: `Earlier: <img src="${EARLIER}">`, messageId: 'msg-earlier' }]
    await send()
    expect(mocks.originAtEnd.addresses).toEqual({
      [EARLIER]: {
        state: 'blocked', rule: 4,
        evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true }
      }
    })

    await redis.saveMessage({
      id: 'msg-earlier', session_id: SESSION, user_id: USER, agent_id: AGENT,
      role: 'assistant', status: 'complete', content: `Earlier: <img src="${EARLIER}">`,
      created_at: '2026-09-28T00:59:00.000Z', metadata: { imageOriginExpected: true }
    } as any)

    await redis.writeImageOriginRecord({
      userId: USER,
      sessionId: SESSION,
      messageId: 'msg-earlier',
      version: 1,
      state: 'decided',
      record: {
        messageId: 'msg-earlier', version: 1, state: 'decided', textHashes: ['c'.repeat(64)], lane: 'api', complete: true,
        addresses: { [EARLIER]: { state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true } } }
      }
    })
    __resetReplyRecordsForTests()
    mocks.originAtEnd = undefined
    await send()
    expect(mocks.originAtEnd.addresses).toEqual({
      [EARLIER]: {
        state: 'as_read', rule: 1,
        evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true }
      }
    })
  }, 30_000)

  it('a failed end step leaves the record pending, and the reply is still saved and ended', async () => {
    // The default lane's write is itself a mock: keep its own implementation and put it back.
    const original = (redis.writeImageOriginRecord as any).getMockImplementation?.() ?? redis.writeImageOriginRecord.bind(redis)
    const spy = vi.spyOn(redis, 'writeImageOriginRecord').mockImplementation(async (input: any) => {
      if (input.state === 'decided') throw new Error('Redis connection lost (test)')
      return original(input)
    })
    try {
      const response = await send()
      expect(response.status).toBe(200)
      expect(mocks.originAtEnd).toEqual({ messageId: REPLY, version: 1, state: 'pending' })
      expect(mocks.forwards.filter((event) => event.type === 'end')).toHaveLength(1)
      expect((await stored(REPLY)).content).toContain(READ)
      expect((await stored(REPLY)).metadata.imageOriginExpectedVersion).toBe(1)
    } finally {
      spy.mockImplementation(original)
    }
  }, 30_000)

  it('a stopped reply is decided too, but its run was not observed, so it is not complete', async () => {
    mocks.plan = 'stop'
    await send()
    const origin = await originOf(REPLY)
    expect(origin.state).toBe('decided')
    expect(origin.complete).toBe(false)
    expect(Object.values(origin.addresses).map((decision: any) => decision.state)).not.toContain('as_read')
  }, 30_000)

  it('records a string-valued user abort through SDK onAbort and reloads the same decision through GET', async () => {
    mocks.plan = 'abort-user-onabort'
    mocks.words = [`Stopped with <img src="${FINAL_UNCONSUMED}">`]
    mocks.abortDuringStream = () => {
      expect(abortStream(SESSION, 'user').ok).toBe(true)
    }

    const response = await send()
    expect(response.status).toBe(499)
    expect(mocks.sdkOnAbortCalls).toBe(1)
    expect(mocks.observedAbortReason).toBe('user')
    const saved = await stored(REPLY)
    expect(saved.content).toContain(FINAL_UNCONSUMED)
    const origin = await originOf(REPLY)
    expect(origin).toMatchObject({ messageId: REPLY, version: 1, state: 'decided', complete: false })
    expect(origin.addresses[FINAL_UNCONSUMED].state).toBe('unknown')

    const loaded = await GETImageOrigins({
      url: new URL(`http://localhost/api/image-origins?sessionId=${encodeURIComponent(SESSION)}`),
      locals: { user: { id: USER } }
    } as any)
    expect(loaded.status).toBe(200)
    expect((await loaded.json()).records[REPLY]).toEqual(origin)
  }, 30_000)

  it('an approval resume writes the next version over the first end, judging the whole reply', async () => {
    const approvalRequestedAt = new Date().toISOString()
    const userMessage = {
      id: 'msg-user-1', session_id: SESSION, user_id: USER, role: 'user', content: 'List the folder.',
      created_at: approvalRequestedAt, metadata: {}
    }
    const cardMetadata = {
      imageOriginExpected: true,
      model: 'claude-sonnet-5',
      agentType: 'api',
      zipIds: [],
      providerMessages: [
        // The paused run read a picture address before its card: the resume replays that result.
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_find', toolName: 'web_fetch', input: { url: 'https://source.example.org/' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_find', toolName: 'web_fetch', output: { type: 'text', value: `found ${PAUSED_READ}` } }] },
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
        approvals: [{ approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', requestedAt: approvalRequestedAt, input: { command: 'ls' } }],
        source: 'vercel'
      }
    }
    const card = {
      id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', status: 'complete',
      content: `Asking first. <img src="${BUILT}">`, created_at: approvalRequestedAt, metadata: cardMetadata
    }
    await redis.saveMessage(userMessage as any)
    await redis.saveMessage(card as any)
    // The first end of the card's reply decided it.
    await redis.writeImageOriginRecord({
      userId: USER, sessionId: SESSION, messageId: CARD, version: 1, state: 'decided',
      record: {
        messageId: CARD, version: 1, state: 'decided', textHashes: [sha256Hex(card.content)], lane: 'api', complete: true,
        addresses: { [BUILT]: { state: 'blocked', rule: 4, evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true } } }
      }
    })
    mocks.words = [`The folder has <img src="${READ}"> and <img src="${PAUSED_READ}">.`]
    mocks.toolResultText = null
    mocks.compiledPieces = [{ source: 'user', text: `List the folder; the cat is at ${READ}` }]

    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION, agentId: AGENT, agentType: 'api', content: '', messageId: CARD,
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
    expect(response.status).toBe(200)

    const saved = await stored(CARD)
    expect(saved.metadata.imageOriginExpected).toBe(true)
    expect(saved.metadata.imageOriginExpectedVersion).toBe(mocks.originAtStart.version)
    expect(mocks.originAtStart?.state).toBe('pending')
    expect(mocks.originAtStart?.version).toBeGreaterThan(1)
    expect(mocks.originAtEnd.version).toBe(mocks.originAtStart.version)
    expect(mocks.originAtEnd.textHashes).toContain(sha256Hex(saved.content))
    expect(mocks.originAtEnd.addresses).toEqual({
      [BUILT]: { state: 'blocked', rule: 4, evidence: { inRecord: false, startInRecord: false, sharesChatRun: false, complete: true } },
      [READ]: { state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true } },
      // Read by the paused run before the card, delivered again in the resume's replay.
      [PAUSED_READ]: { state: 'as_read', rule: 1, evidence: { inRecord: true, startInRecord: false, sharesChatRun: false, complete: true } }
    })

    // The first end, arriving late, never writes over the resume's decision.
    const late = await redis.writeImageOriginRecord({
      userId: USER, sessionId: SESSION, messageId: CARD, version: 1, state: 'decided',
      record: { messageId: CARD, version: 1, state: 'decided', textHashes: ['d'.repeat(64)], lane: 'api', complete: true, addresses: {} }
    })
    expect(late).toBe('older')
    expect((await originOf(CARD)).version).toBe(mocks.originAtEnd.version)
  }, 30_000)

  it('keeps a decided v1 record stale when resumed pending and decision writes fail on an unchanged prefix', async () => {
    const fixture = createImageOriginApprovalFixture()
    const oldRecord = await seedImageOriginApprovalFixture(fixture)
    const writes: string[] = []
    const spy = vi.spyOn(redis, 'writeImageOriginRecord').mockImplementation(async (write: any) => {
      writes.push(write.state)
      throw new Error(`Redis refused resumed ${write.state} record (test)`)
    })
    mocks.words = []
    mocks.emitRealText = false
    mocks.finishTextOverride = fixture.card.content
    mocks.toolResultText = null
    try {
      const response = await postImageOriginApprovalResume(fixture)
      expect(response.status).toBe(200)
      expect(writes).toEqual(['pending', 'decided'])

      const saved = await stored(CARD)
      expect(saved.content).toBe(fixture.card.content)
      expect(sha256Hex(saved.content)).toBe(oldRecord.textHashes[0])
      expect(saved.metadata.imageOriginExpected).toBe(true)
      expect(saved.metadata.imageOriginExpectedVersion).toBeGreaterThan(oldRecord.version)
      expect(await originOf(CARD)).toEqual(oldRecord)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it('writes the server-minted expected origin version on an early outer approval-resume failure', async () => {
    const fixture = createImageOriginApprovalFixture()
    const oldRecord = await seedImageOriginApprovalFixture(fixture)
    mocks.plan = 'acquire-fail'

    await postImageOriginApprovalResume(fixture)

    const saved = await stored(CARD)
    const origin = await originOf(CARD)
    expect(saved.content).toBe(fixture.card.content)
    expect(saved.metadata.imageOriginExpected).toBe(true)
    expect(saved.metadata.imageOriginExpectedVersion).toBeGreaterThan(oldRecord.version)
    expect(origin).toMatchObject({ state: 'pending' })
    expect(origin.version).toBe(saved.metadata.imageOriginExpectedVersion)
  }, 30_000)

  it('retains server replay sidecars and provider messages when a resumed run errors before onFinish', async () => {
    const fixture = createImageOriginApprovalFixture()
    await seedImageOriginApprovalFixture(fixture)
    // The real server save merges existing metadata on an in-place resume. Mirror just that
    // persistence contract because Vitest's default Redis fake replaces the whole record.
    const fakeSave = (redis.saveMessage as any).getMockImplementation?.()
    const saveSpy = typeof fakeSave === 'function'
      ? vi.spyOn(redis, 'saveMessage').mockImplementation(async (message: any) => {
          const prior = await stored(message.id)
          return fakeSave(prior ? {
            ...message,
            metadata: { ...(prior.metadata ?? {}), ...(message.metadata ?? {}) }
          } : message)
        })
      : null
    mocks.plan = 'fail-first'
    try {
      await postImageOriginApprovalResume(fixture)

      const saved = await stored(CARD)
      expect(mocks.onFinishCalls).toBe(0)
      expect(mocks.apiInputObservations).toHaveLength(1)
      expect(mocks.apiInputObservations[0].userSources).toEqual(fixture.cardMetadata.providerUserSources)
      expect(saved.content).toContain(fixture.card.content)
      expect(saved.metadata.providerMessages).toEqual(fixture.cardMetadata.providerMessages)
      expect(saved.metadata.providerUserSources).toEqual(fixture.cardMetadata.providerUserSources)
      expect(saved.metadata.imageOriginExpectedVersion).toBeGreaterThan(1)
    } finally {
      saveSpy?.mockRestore()
    }
  }, 30_000)

  it('keeps actual group-speaker image-origin records pending when a compile omits its ledger', async () => {
    const group = {
      id: GROUP,
      user_id: USER,
      name: 'BL-474 group ledger',
      agent_ids: [AGENT, GROUP_MEMBER],
      agent_settings: {
        [AGENT]: { speak_policy: 'balanced', speak_topics: [] },
        [GROUP_MEMBER]: { speak_policy: 'balanced', speak_topics: [] }
      },
      driver_mode: true,
      driver_agent_id: AGENT,
      max_followups_total: 1,
      max_agents: 2
    }
    const previousGetGroup = (redis as any).getGroup
    ;(redis as any).getGroup = vi.fn(async (id: string) =>
      redis.execute((client: any) => client.json.get(`group:${id}`))
    )
    await redis.execute((client: any) => client.json.set(`group:${GROUP}`, '$', group))
    await redis.execute((client: any) => client.json.set(`session:${SESSION}`, '$.metadata', {
      group_chat: { group_id: GROUP }
    }))
    await redis.createAgent({
      id: GROUP_MEMBER, user_id: USER, name: 'Member', displayName: 'Member', agentType: 'api',
      primary_model_preset_id: PRESET, tool_approval_mode: 'all'
    } as any)
    mocks.groupReplies = true
    mocks.compiledLedgerMode = 'missing'
    mocks.toolResultText = null
    mocks.parallelToolResults = null
    try {
      const response = await send()
      expect(response.status).toBe(200)
      expect(mocks.compileCalls).toBeGreaterThanOrEqual(1)
      expect(mocks.compileOptions?.groupContext).toBeTruthy()
      expect(mocks.originAtEnds.length).toBeGreaterThanOrEqual(1)
      expect(mocks.originAtEnds.every(({ record }) => record?.state === 'pending')).toBe(true)
    } finally {
      if (previousGetGroup === undefined) delete (redis as any).getGroup
      else (redis as any).getGroup = previousGetGroup
    }
  }, 30_000)
})

describe('send-routed: a woken turn tells the compile where its message came from (BL-474 step 2)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    previousServiceToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    count += 1
    SESSION = `session-bl474-wake-${count}`
    mocks.words = ['Done.']
    mocks.forwards = []
    mocks.plan = 'reply'
    mocks.abortDuringStream = null
    mocks.sdkOnAbortCalls = 0
    mocks.observedAbortReason = undefined
    mocks.toolResultText = null
    mocks.compiledPieces = []
    mocks.compileOptions = null
    mocks.originAtStart = undefined
    mocks.originAtEnd = undefined
    mocks.originAtEnds = []
    mocks.apiInputObservations = []
    mocks.finalResponseMessages = []
    mocks.onFinishCalls = 0
    mocks.observeToolResult = true
    mocks.takeSteerWithoutDispatch = false
    mocks.takenSteers = []
    mocks.compileFails = false
    mocks.compileCalls = 0
    mocks.compiledLedgerMode = 'complete'
    mocks.emitRealText = true
    mocks.finishTextOverride = null
    mocks.groupReplies = false
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, model)
    await redis.createAgent({
      id: AGENT, user_id: USER, name: 'Probe', displayName: 'Probe', agentType: 'api',
      primary_model_preset_id: PRESET, tool_approval_mode: 'all'
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-474 wake', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetReplyRecordsForTests()
    __resetWakeRunRegistryForTests()
    if (previousServiceToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousServiceToken
  })

  async function sendWoken(
    kind: 'webhook' | 'dm' | 'schedule',
    options: { trusted?: boolean; register?: boolean } = {}
  ) {
    const origin = {
      version: 1 as const,
      kind,
      label: 'Source',
      ...(kind === 'webhook' ? { hookId: 'hook_bl474' } : { dmId: 'dm_1', agentId: 'agent-faye' }),
      at: '2026-09-29T12:00:00.000Z',
      chainDepth: 1
    }
    if (options.register !== false) {
      registerWakeRun({
        sessionId: SESSION,
        agentId: AGENT,
        userId: USER,
        origin,
        startedAt: Date.now(),
        assistantMessageId: REPLY,
        controller: new AbortController(),
        timer: setTimeout(() => {}, 60_000)
      })
    }
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.trusted !== false) {
      for (const [key, value] of Object.entries(internalServiceHeaders())) headers.set(key, value)
    }
    return POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: SESSION, agentId: AGENT, agentType: 'api', content: 'Woken.', messageId: REPLY,
          messages: [{ id: 'msg-wake-user-agent', role: 'user', content: 'Woken.' }],
          metadata: { wake: { chainDepth: 1, dmId: 'dm_1', origin: { kind, label: 'Source' } } }
        })
      }),
      fetch: sseForward,
      locals: { user: { id: USER } }
    } as any)
  }

  it.each([
    ['webhook', 'note'],
    ['dm', undefined],
    ['schedule', undefined]
  ] as const)('a %s wake: the compile is told %s', async (kind, expected) => {
    const response = await sendWoken(kind)
    expect(response.status).toBe(200)
    expect(mocks.compileOptions?.currentMessageFrom).toBe('batshit')
    expect(mocks.compileOptions?.currentMessageAddressSource).toBe(expected)
  }, 30_000)

  it('does not trust a metadata-only webhook wake without a registered internal run', async () => {
    const response = await sendWoken('webhook', { trusted: false, register: false })
    expect(response.status).toBe(200)
    expect(mocks.compileOptions?.currentMessageFrom).toBe('batshit')
    expect(mocks.compileOptions?.currentMessageAddressSource).toBeUndefined()
  }, 30_000)
})
