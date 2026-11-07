import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createClient as createPhysicalRedisClient } from 'redis'
import * as physicalRedisModule from 'redis'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
vi.unmock('ai')
// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import * as originalTask from '$lib/server/services/appActions/mcp/originalTask'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
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
import type { SavedModel } from '$lib/types/savedModels'
import { buildDynamicOnlySelectionResetKey } from '$lib/server/services/mcpRuntimePolicy'

// The default handler lane owns an in-memory store and explicit SSE forwarding.
// A direct client must never reach the workstation's real Redis. The established
// admitted real lane retains the actual factory and its existing custody checks.
const physicalRedis = vi.hoisted(() => ({ attempts: 0 }))
vi.mock('redis', async importOriginal => {
  const actual = await importOriginal<typeof import('redis')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  const createClient = vi.fn(() => {
    physicalRedis.attempts += 1
    throw new Error('Physical Redis is not admitted in the default reply-record fixture.')
  })
  const defaultExport = (actual as any).default
  return { ...actual, createClient,
    ...(defaultExport ? { default: { ...defaultExport, createClient } } : {}) }
})
vi.mock('$lib/server/visualIndicatorService', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/visualIndicatorService')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return actual
  return { ...actual, initializeKeyspaceNotifications: vi.fn(async () => {}),
    setupSessionMonitoring: vi.fn(async () => async () => {}) }
})

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
  sdkModel: null as any, sdkRequests: [] as any[], onEnd: null as null | ((event: any) => Promise<void>), realCompiler: false, realTools: false, compiles: [] as any[],
  sdkTools: null as null | ((context: { p5ApiRun?: Parameters<typeof originalTask.p5ApiRunMustPause>[0]; [key: string]: any }, actual?: any) => Promise<any>),
  sdkDispatchObserver: null as null | ((request: any) => Promise<void>),
  reasoning: '',
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
  failedNotices: [] as Array<{ event: Record<string, any>; record: any; beforeHttpResponse: boolean }>,
  httpResponseReturned: false,
  storedAtComplete: undefined as any
}))

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, nativeToolService: { ...actual.nativeToolService, cleanupExecutionSandboxesForSession: vi.fn(async () => []) } }
})

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput(sessionId: string, _messages: unknown, agent: any, _content: unknown, _assigned: unknown, userId: string, options: any) {
      mocks.stopDuringSetup?.()
      if (mocks.realCompiler) {
        const observation = { sessionId, messages: _messages, content: _content, options, compiler: this, finalized: false }
        mocks.compiles.push(observation)
        const result = await super.buildFormattedChatInput(sessionId, _messages as any, agent, _content as any, _assigned as any, userId, options)
        const finalize = result.finalizeAgentSetup?.bind(result)
        return !finalize ? result : { ...result, finalizeAgentSetup: async (...args: Parameters<typeof finalize>) => {
          const finalized = await finalize(...args)
          observation.finalized = true // observation of the actual one-use owner, never readiness authority
          return finalized
        } }
      }
      return {
        primarySystemPrompt: 'You are a test agent.',
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId, sessionId, agentId: agent.id, messageId: options.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'Say two parts.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/providers', () => {
  const factory = () => ({ getModel: () => { if (!mocks.sdkModel) throw new Error('No provider model is admitted in this fixture.'); return mocks.sdkModel }, listAvailableModels: () => [] })
  const ProviderManager = vi.fn(function(this: Record<string, unknown>) { Object.assign(this, factory()) })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return { ProviderManager, resolveProviderAccess: vi.fn(async () => ({ apiKeys: {} })) }
})
vi.mock('$lib/server/services/vercelBrain', async importOriginal => {
  const actual = await importOriginal<typeof import('$lib/server/services/vercelBrain')>()
  return { ...actual, VercelAIBrain: class {
    private brain?: InstanceType<typeof actual.VercelAIBrain>
    private actualRuntime() {
      if (!this.brain) {
        const brain = new actual.VercelAIBrain()
        const actualBuild = (brain as any).buildToolsForMode3.bind(brain)
        ;(brain as any).buildToolsForMode3 = vi.fn(async (...args: any[]) => {
          if (mocks.realTools) { const built = await actualBuild(...args); return mocks.sdkTools ? mocks.sdkTools(args[9], built) : built }
          return mocks.sdkTools ? mocks.sdkTools(args[9]) : ({ tools: undefined, maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: [] })
        })
        this.brain = brain
      }
      return this.brain
    }
    async prepareApiToolset(request: any) {
      // The actual registration WeakMap and its one-use consumption must belong
      // to the same real brain; a prepared DTO from another instance is invalid.
      return this.actualRuntime().prepareApiToolset(request)
    }
    async streamNativeMode(request: any) {
      if (mocks.sdkModel) {
        mocks.sdkRequests.push(request)
        await mocks.sdkDispatchObserver?.(request)
        return this.actualRuntime().streamNativeMode(request)
      }
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
        if (mocks.reasoning) yield { type: 'reasoning-delta', text: mocks.reasoning }
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
  } }
})

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    publishUserEvent: vi.fn(async (_userId: string, event: Record<string, any>) => {
      if (mocks.noticeThrowsFor && event?.reason === mocks.noticeThrowsFor) throw new Error('notice failed (test)')
      if (event?.type === 'session_messages_changed' && event.reason === 'turn_failed') {
        const record = await stored(REPLY)
        mocks.failedNotices.push({ event: { ...event }, record, beforeHttpResponse: !mocks.httpResponseReturned })
      }
    })
  }
})


// No Judge Juice vendor call can escape this model-free disposition fixture. The
// actual turn/controller builders below still run; their post-turn methods are observed.
const pauseJudges = vi.hoisted(() => ({
  hints: vi.fn(async () => { throw new Error('Unexpected Smart Zip model call') }),
  rezips: vi.fn(async () => { throw new Error('Unexpected Smart Zip model call') }),
  check: vi.fn(async () => { throw new Error('Unexpected reply-check model call') }),
  style: vi.fn(async () => { throw new Error('Unexpected style model call') })
}))
vi.mock('$lib/server/services/smartZip.jev', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), computeSmartZipHints: pauseJudges.hints, computeSmartZipRezips: pauseJudges.rezips
}))
vi.mock('$lib/server/services/postTurnCheck.jev', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()), computeReplyCheck: pauseJudges.check, computeStyleCoach: pauseJudges.style
}))

// SA-139 (Faye's P3 Part 1 read): the Claude plan cases run Claude Code's test double in a folder of
// their own; every other case never reaches the Claude plan connection.
const claudePlanFixture = vi.hoisted(() => ({ folder: '' }))
vi.mock('$lib/server/services/claudePlanReadiness', () => ({ readClaudePlanReadiness: vi.fn(async () => ({ state: 'ready' })) }))
vi.mock('$lib/server/services/claudePlanModel', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveClaudePlanWorkingDirectory: vi.fn(async () => {
    if (!claudePlanFixture.folder) throw new Error('No Claude plan fixture folder in this case.')
    return claudePlanFixture.folder
  })
}))

const realRedis = process.env.VITEST_USE_REAL_REDIS === 'true'
const strictAdmission = createSettingsRedisAdmission(redis)
const redisAdmission = useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())

it.runIf(!realRedis)('refuses a physical Redis client before connection in the default reply-record lane', () => {
  try {
    expect(physicalRedis.attempts).toBe(0)
    expect(createPhysicalRedisClient).not.toHaveBeenCalled()
    expect(() => createPhysicalRedisClient({ url: 'redis://127.0.0.1:1/15', database: 15 }))
      .toThrow('Physical Redis is not admitted')
    const defaultCreate = (physicalRedisModule as any).default?.createClient
    if (defaultCreate) {
      expect(defaultCreate).toBe(createPhysicalRedisClient)
      expect(() => defaultCreate({ url: 'redis://127.0.0.1:1/15', database: 15 })).toThrow('Physical Redis is not admitted')
    }
    expect(createPhysicalRedisClient).toHaveBeenCalledTimes(defaultCreate ? 2 : 1)
    expect(physicalRedis.attempts).toBe(defaultCreate ? 2 : 1)
  } finally { physicalRedis.attempts = 0; vi.mocked(createPhysicalRedisClient).mockClear() }
})

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0
let originalExecute: typeof redis.execute | undefined

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
    await mocks.onEnd?.(event)
  } else if (event.type === 'error' && mocks.storedAtError === undefined) {
    mocks.storedAtError = await stored(event.messageId)
  } else if (event.type === 'complete' && mocks.storedAtComplete === undefined) {
    mocks.storedAtComplete = await stored(event.messageId)
  } else if (event.messageId) {
    recordReplyEvent(event.sessionId, { ...event })
  }
  return new Response(JSON.stringify({ success: true }), { status: 200 })
}

function send(signal?: AbortSignal, history?: Array<{ id: string; role: string; content: string }>, extra: Record<string, unknown> = {}): Promise<Response> {
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
        messages: history ?? [{ id: 'msg-user-1', role: 'user', content: 'Say two parts.' }], ...extra
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

// One owned temporary root for the actual local-child cases in THIS existing
// strict owner. No new launcher/server dependency/fixture framework or network.
let installedStdioRoot: string | undefined
let installedStdioFailed = false
const installedStdioLogs: string[] = []
function savedStdioFixture(suffix: string) {
  installedStdioRoot ??= mkdtempSync(join(tmpdir(), 'batshit-p5-installed-stdio-'))
  const script = join(installedStdioRoot, 'saved-server.cjs'), log = join(installedStdioRoot, `${suffix}.jsonl`)
  if (!existsSync(script)) {
    const require = createRequire(import.meta.url)
    writeFileSync(script, [
      `const fs = require('node:fs')`,
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))})`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))})`,
      `const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))})`,
      `const [log, mode, toolName = 'remote_tool'] = process.argv.slice(2)`,
      `const note = method => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, method }) + '\\n')`,
      `const delaySecondInitialize = mode === 'original-second-init' && fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.method === 'spawn').length === 1`,
      `note('spawn'); process.on('exit', () => note('exit')); process.on('SIGTERM', () => process.exit(0))`,
      `if (mode === 'original-capacity') for (let i = 1; i < 12; i++) if (process.env['A_REF_' + i] !== 'CONTROLLED_SYNTHETIC_HANDLER_VALUE') throw new Error('Exact original reference handoff failed')`,
      `if (mode === 'no-env' ? process.env.SERVER_TOKEN !== undefined || Object.hasOwn(process.env, '__proto__') : mode.startsWith('original') ? process.env.SERVER_TOKEN !== 'CONTROLLED_SYNTHETIC_HANDLER_VALUE' || Object.hasOwn(process.env, '__proto__') : process.env.SERVER_TOKEN !== 'CONTROLLED_SYNTHETIC_HANDLER_VALUE' || !Object.hasOwn(process.env, '__proto__') || process.env['__proto__'] !== 'CONTROLLED_SYNTHETIC_HANDLER_VALUE') throw new Error('Exact own saved env/default-only contract failed')`,
      `let input = ''; process.stdin.on('data', chunk => { input += chunk; let at; while ((at = input.indexOf('\\n')) >= 0) { const line = input.slice(0, at); input = input.slice(at + 1); try { const message = JSON.parse(line); if (message.method) note(message.method) } catch {} } })`,
      `const start = () => {`,
      ` const server = new Server({ name: 'installed-saved', version: '1.0.0' }, { capabilities: { tools: {} } })`,
      ` server.setRequestHandler(ListToolsRequestSchema, async () => { if (mode === 'late-list') await new Promise(resolve => setTimeout(resolve, 1500)); return { tools: [{ name: toolName, description: 'Installed saved tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] } })`,
      ` server.setRequestHandler(CallToolRequestSchema, async request => { if (mode === 'slow-call' || mode === 'original-slow-call') await new Promise(resolve => setTimeout(resolve, 10000)); note('effect'); return { content: [{ type: 'text', text: JSON.stringify({ success: true, value: request.params.arguments.value }) }] } })`,
      ` server.connect(new StdioServerTransport())`,
      `}`,
      `if (mode === 'late-init' || delaySecondInitialize) setTimeout(start, 1500); else start()`
    ].join('\n'))
  }
  installedStdioLogs.push(log)
  return { script, log }
}
function stdioWire(log: string): Array<{ pid: number; method: string }> {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
afterAll(() => {
  // Failure leaves exact owned evidence for Root; never remove a live child's
  // entry/logs or reset product lifetime to make a retry appear clean.
  for (const log of installedStdioLogs) {
    const rows = stdioWire(log)
    for (const { pid } of rows.filter(row => row.method === 'spawn')) {
      let alive = false
      try { process.kill(pid, 0); alive = true } catch {}
      if (alive) throw new Error(`Owned STDIO child ${pid} still alive; retained ${installedStdioRoot}`)
    }
  }
  if (installedStdioFailed) { console.warn('Retained owned STDIO fixture after failed proof:', installedStdioRoot); return }
  if (installedStdioRoot) rmSync(installedStdioRoot, { recursive: true, force: true })
})

describe('send-routed: the server owns a reply’s saved record (BL-775, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    if (!realRedis) {
      expect(physicalRedis.attempts).toBe(0)
      expect(createPhysicalRedisClient).not.toHaveBeenCalled()
    }
    count += 1
    SESSION = `session-bl775-${count}`
    mocks.words = ['The first part. ', 'The second part.']
    mocks.reasoning = ''
    mocks.forwards = []
    mocks.failForwardOf = null
    mocks.failChunkText = null
    mocks.hangChunkText = null
    mocks.slowChunkText = null
    mocks.slowChunkMs = 0
    mocks.detectZips = false
    mocks.sdkModel = null; mocks.sdkRequests = []; mocks.sdkTools = null; mocks.sdkDispatchObserver = null; mocks.realCompiler = false; mocks.realTools = false; mocks.compiles = []; mocks.onEnd = null
    mocks.plan = 'reply'
    mocks.saveFailures = 0
    mocks.noticeThrowsFor = null
    mocks.storedAtEnd = null
    mocks.storedAtError = undefined
    mocks.failedNotices = []; mocks.httpResponseReturned = false
    mocks.storedAtComplete = undefined
    mocks.stopDuringSetup = null
    sseForward.mockClear()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (!realRedis) {
      // This consumer starts after startup maintenance. Declare its exact fake
      // user's existing v1 state before actors/events; do not simulate reset Lua.
      await redis.execute(client => client.set(buildDynamicOnlySelectionResetKey(USER), '2026-10-27T00:00:00.000Z'))
    }
    await redis.set(`model:${PRESET}`, model)
    await redis.sAdd(`user:${USER}:models`, PRESET)
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
    if (!realRedis) {
      // The actual accepted-send memory owner reads the session as raw JSON
      // BEFORE its normal memory-off exit. Supply only that existing no-path
      // primitive from this same store; keep all owner checks and no fake EVAL.
      originalExecute = redis.execute
      const execute = originalExecute
      ;(redis as any).execute = async (operation: (client: any) => unknown) => execute.call(redis, async (client: any) =>
        operation(new Proxy(Object.create(null), {
          get(_target, property) {
            if (property === 'sendCommand') return async (args: string[]) => {
              if (args.length !== 2 || args[0] !== 'JSON.GET' || args[1] !== `session:${SESSION}`) {
                throw new Error('Unsupported raw command in the reply-record fixture.')
              }
              const row = await client.json.get(args[1])
              return row === null ? null : JSON.stringify(row)
            }
            const value = Reflect.get(client, property, client)
            return typeof value === 'function' ? value.bind(client) : value
          },
          has(_target, property) { return property === 'sendCommand' || property in client }
        })))
    }
    // The default lane's `saveMessage` is itself a mock: keep its own implementation.
    const original = (redis.saveMessage as any).getMockImplementation?.() ?? redis.saveMessage.bind(redis)
    vi.spyOn(redis, 'saveMessage').mockClear().mockImplementation(async (message: any) => {
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

  afterEach(context => {
    try {
      if (context.task.result?.state === 'fail' && installedStdioRoot) installedStdioFailed = true
      // spyOn(existing vi.fn) reuses the fake; descriptor restoration alone leaves
      // this wrapper installed. Restore its original storage implementation locally.
      if (vi.isMockFunction(redis.saveMessage)) redis.saveMessage.mockRestore()
      vi.restoreAllMocks()
      __resetReplyRecordsForTests()
      if (!realRedis) {
        expect(physicalRedis.attempts).toBe(0)
        expect(createPhysicalRedisClient).not.toHaveBeenCalled()
      }
    } finally {
      if (originalExecute) (redis as any).execute = originalExecute
      originalExecute = undefined
    }
  })

  it('saves an actual SDK management pause before outer disposition and skips real intermediate Jev controllers under original []', async () => {
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const { tool, jsonSchema } = await import('ai')
    const { settingsOperationRegistry } = await import('$lib/server/services/appActions/settings/managementRuntime')
    const { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES } = await import('$lib/appActions/settings/mcpConfiguration')
    const jev = await import('$lib/server/services/typesafe/jevJuiceTurn')
    const agent = await redis.json.get(`agent:${AGENT}`) as Record<string, unknown>
    await redis.json.set(`agent:${AGENT}`, '$', { ...agent, jev_juice_reply_check: true } as any)
    await redis.updateUserSettings(USER, { global_zip_settings: { jev_juice_smart_zip: true } })
    for (const compute of Object.values(pauseJudges)) compute.mockClear()
    const postRuns: Array<{ mock: { calls: unknown[] } }> = []
    const actualSmart = jev.buildSmartZipTurn, actualCheck = jev.buildPostTurnCheckTurn
    const smart = vi.spyOn(jev, 'buildSmartZipTurn').mockImplementation(input => {
      const value = actualSmart(input); if (value) postRuns.push(vi.spyOn(value, 'runPostTurn')); return value
    })
    const check = vi.spyOn(jev, 'buildPostTurnCheckTurn').mockImplementation(input => {
      const value = actualCheck(input); if (value) postRuns.push(vi.spyOn(value, 'runPostTurn')); return value
    })
    const input = { op: 'change', requestId: `${settingsOperationRegistry.boot}:handler-managed-pause-${SESSION}`,
      reportId: `asr_${settingsOperationRegistry.boot}_mcp_${'2'.repeat(32)}`, semanticId: MCP_CONFIGURATION_ID,
      changes: { source: { candidateId: `mcpc_${'3'.repeat(32)}` } } }
    const review = { kind: 'mcp-configuration' as const, planId: `mcpp_${'4'.repeat(32)}`, candidateId: `mcpc_${'3'.repeat(32)}`,
      mode: 'create' as const, resource: { kind: 'mcp-gateway' as const, gatewayId: 'C' }, before: null,
      after: { id: 'C', slug: 'controlled-c', name: 'Controlled C', type: 'custom' as const, enabled: true, url: 'https://fixture.invalid/mcp' }, stages: [...MCP_CONFIGURATION_STAGES] }
    const effect = vi.fn(async () => [])
    const operation = settingsOperationRegistry.capture({ actor: { userId: USER, kind: 'native', id: AGENT, sessionId: SESSION, generation: 1, label: 'Actual API source recipe' },
      requestId: input.requestId, input, resource: review.resource, preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: review },
      permission: 'ask', preimages: { planId: review.planId, disclosure: review }, refresh: async () => {}, execute: effect })
    let actualRun: Parameters<typeof originalTask.p5ApiRunMustPause>[0] | undefined
    const called = vi.fn(async () => {
      if (!actualRun) throw new Error('No actual API run reached the builder')
      const context = { userId: USER, agentId: AGENT, sessionId: SESSION, messageId: REPLY, actorType: 'in-process' as const, p5ApiRun: actualRun }
      const held = await settingsOperationRegistry.bindP5ApiMcpOperation(context, input)
      expect(held).toBeDefined()
      expect(originalTask.captureP5ApiManagement(context, 'C', { operationId: operation.operationId, requestId: input.requestId })).toBeDefined()
      return { status: 'pending', reason: 'MCP_SETUP_POSTIMAGE_REQUIRED' } // No save/verified-use result.
    })
    mocks.sdkTools = async context => {
      actualRun = context.p5ApiRun
      expect(actualRun).toBeDefined()
      return { tools: { reserve_setup: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }), execute: called }) },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: [] }
    }
    let calls = 0
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    mocks.sdkModel = new MockLanguageModelV3({ provider: 'fixture', modelId: 'claude-sonnet-5', doStream: async () => {
      calls++
      if (calls > 1) throw new Error('A restrictive management pause must prevent the next SDK issue')
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'managed-pause-text' },
        { type: 'text-delta', id: 'managed-pause-text', delta: 'The source still needs verified setup.' }, { type: 'text-end', id: 'managed-pause-text' },
        { type: 'tool-call', toolCallId: 'managed-pause-call', toolName: 'reserve_setup', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
      ]) }
    } })
    const outer = originalTask.takeP5ApiVerifiedContinuation
    const dispositions: unknown[] = []
    const disposition = vi.spyOn(originalTask, 'takeP5ApiVerifiedContinuation').mockImplementation(async preparation => {
      const request = mocks.sdkRequests[0]
      expect(originalTask.p5CanonicalReplySealed(preparation, REPLY, request.mcpApiPart)).toBe(true)
      const record = await stored(REPLY)
      expect(record?.content).toContain('The source still needs verified setup.')
      expect(record?.metadata?.response_failed).not.toBe(true)
      expect(originalTask.p5ApiPreparedScope(preparation)?.gateways).toEqual([])
      const continuation = await outer(preparation)
      dispositions.push(continuation)
      return continuation
    })
    try {
      const result = await send()
      expect(result.status).toBe(200)
      expect(calls).toBe(1); expect(called).toHaveBeenCalledTimes(1)
      expect(mocks.sdkRequests).toHaveLength(1)
      expect(disposition).toHaveBeenCalledTimes(1); expect(dispositions).toEqual([undefined])
      expect(smart.mock.results.some(value => value.value !== undefined)).toBe(true)
      expect(check.mock.results.some(value => value.value !== undefined)).toBe(true)
      expect(postRuns).toHaveLength(2)
      for (const run of postRuns) expect(run.mock.calls).toHaveLength(0)
      for (const compute of Object.values(pauseJudges)) expect(compute).not.toHaveBeenCalled()
      expect(effect).not.toHaveBeenCalled()
      expect(mocks.storedAtEnd?.content).toContain('The source still needs verified setup.')
      expect(originalTask.p5ApiPreparedScope(mocks.sdkRequests[0].mcpOriginalPreparation)?.gateways).toEqual([])
    } finally { disposition.mockRestore(); smart.mockRestore(); check.mockRestore() }
  }, 30_000)

  // Full positive conjunction belongs to THIS existing handler/strict-Redis
  // owner. The Boot facade deliberately cannot invent a successful Lua ACK.
  it.runIf(realRedis).each([
    ['allow','self',false], ['approve','self',true], ['deny','self',false], ['allow','other',false],
    ['allow','remove',false], ['allow','max3',false], ['allow','C1-after-C2',false], ['allow','inherit',true],
    ['allow','source',false], ['allow','source-header',false], ['allow','key',false], ['allow','policy',false],
    ['allow','actor',false], ['allow','Stop',false], ['allow','deadline',false], ['allow','remove-readd',false],
    ['allow','collision',true], ['allow','missing-A-names',true], ['allow','neutral-source',false], ['allow','neutral-key',false],
    ['allow','entry-discovery',false], ['allow','context-after-C',false],
    ['allow','stdio-entry',false], ['approve','stdio-self',false], ['deny','stdio-self',false],
    ['allow','stdio-enabled',true], ['allow','stdio-no-env-fixed',false], ['allow','stdio-source',false], ['allow','stdio-key',false], ['allow','stdio-file',false],
    ['allow','stdio-bind-Stop',false], ['allow','stdio-late-init',false], ['allow','stdio-late-list',false], ['allow','stdio-call-Stop',false],
    ['allow','mixed-stdio',true], ['approve','mixed-collision',true], ['allow','mixed-warm-cache',true],
    ['allow','mixed-legacy-trim',true], ['allow','mixed-legacy-proto',true], ['allow','mixed-source',true], ['allow','mixed-key',true], ['allow','mixed-file',true],
    ['allow','mixed-sealed-resolver',true], ['allow','mixed-issued-Stop',true], ['allow','mixed-initial-close-pending',true], ['allow','mixed-remove-key',true],
    ['allow','mixed-startup-latency',true], ['allow','mixed-capacity16',true], ['allow','mixed-remove-trim',true], ['allow','mixed-remove-proto',true],
    ['allow','mixed-remove-unknown-close',true], ['allow','mixed-B-row-shift',true]
  ] as const)('joins actual API %s / %s / originalA=%s Lua, SDK, canonical and fresh source owners', async (decision, scenario, withA) => {
    redisAdmission.requireAdmission()
    // The real compiler reads a user whose startup/sign-in initialization has
    // already completed. Its legacy skill cleanup must stay in an owned home.
    const home = process.env.BATSHIT_HOME_DIR
    if (!home || !isAbsolute(home)) throw new Error('The real P5 handler fixture requires an explicit owned BATSHIT_HOME_DIR.')
    const homeOwner = await import('$lib/server/services/batshitHome')
    const skills = await import('$lib/server/services/skillRegistry')
    expect(homeOwner.getBatshitHomeDir()).toBe(resolve(home))
    expect(homeOwner.getBatshitHomeDir()).not.toBe(homeOwner.getDefaultBatshitHomeDir())
    expect(skills.getSkillCacheRoot()).toBe(join(resolve(home), 'skills'))
    await (await import('$lib/server/services/systemSlashCommands')).initializeSystemSlashCommandsForUser(USER)
    const { readP5ApiStreamSettlement } = await import('$lib/server/services/vercelBrain')
    const stdioCase = scenario.startsWith('stdio-'), stdioEntry = scenario === 'stdio-entry'
    const local = stdioCase ? savedStdioFixture(String(count)) : undefined
    const mixed = scenario.startsWith('mixed-'), mixedCollision = scenario === 'mixed-collision', mixedRemoval = scenario.startsWith('mixed-remove-')
    const removedMismatch = scenario === 'mixed-remove-trim' || scenario === 'mixed-remove-proto' || scenario === 'mixed-remove-unknown-close'
    const removedUnknown = scenario === 'mixed-remove-unknown-close', mixedCapacity = scenario === 'mixed-capacity16'
    const mixedRefusal = ['mixed-legacy-trim','mixed-legacy-proto','mixed-source','mixed-key','mixed-file','mixed-issued-Stop','mixed-initial-close-pending'].includes(scenario)
    const mixedRace = scenario === 'mixed-sealed-resolver' || scenario === 'mixed-issued-Stop'
    const originalLocal = mixed ? savedStdioFixture(`original-a-${count}`) : undefined
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const { tool, jsonSchema } = await import('ai')
    const runtime = await import('$lib/server/services/appActions/settings/managementRuntime')
    const { defaultAppActionsPolicy } = await import('$lib/appActions/settings/managementContract')
    const { nativePolicyResponse, saveNativePolicy } = await import('$lib/server/services/appActions/settings/authority')
    const topology = await import('$lib/server/services/appActions/runtime')
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    const gatewayOwner = await import('$lib/server/services/mcpGatewayService')
    const discovery = await import('$lib/server/services/mcpGatewayDiscovery')
    const shared = await import('$lib/server/services/dynamicMcpTools')
    const sharedFind = vi.spyOn(shared, 'executeDynamicMcpFind') // passive actual owner, no substituted result
    const http = await import('$lib/server/services/n8nMCPGatewayClient')
    const clipOwner = await import('$lib/server/services/sessionClipState')
    const steerOwner = await import('$lib/server/services/steerInboxRegistry')
    const turns = await import('$lib/server/services/streamAbortRegistry')
    const transport = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    // Same explicit worker-topology substitution as management.redis.test;
    // this proves actual data/SDK ownership, never installed topology/account.
    vi.spyOn(topology, 'requireAppActionTopology').mockImplementation(() => {})
    mocks.realCompiler = true; mocks.realTools = true
    await redis.updateUserSettings(USER, { global_zip_settings: {} })
    const otherId = `other-${SESSION}`, originalScope = withA || scenario === 'remove' ? ['A'] : []
    const stamp = '2026-10-21T00:00:00.000Z', sourceBase = 'https://positive-source.example/mcp/'
    const keyName = `positive-handler-${count}`
    await apiKeyService.store(keyName, 'CONTROLLED_SYNTHETIC_HANDLER_VALUE', USER)
    const aKeyNames = mixedCapacity ? Array.from({ length: 12 }, (_, i) => `positive-original-a-${count}-${i}`) : [keyName]
    if (mixedCapacity) for (const name of aKeyNames) await apiKeyService.store(name, 'CONTROLLED_SYNTHETIC_HANDLER_VALUE', USER)
    if (scenario === 'mixed-legacy-trim' || scenario === 'mixed-remove-trim') {
      // Legacy encrypted data, not the current normalizing store producer.
      const { apiKeyEncryption } = await import('$lib/services/encryption.server')
      await redis.json.set(apiKeyService.storedKeyName(keyName, USER), '$', { ...apiKeyEncryption.encrypt(' CONTROLLED_SYNTHETIC_HANDLER_VALUE '), updatedAt: stamp })
    }
    const savedB = { id: 'saved-B', slug: 'saved-b', name: 'Saved B', type: 'custom', enabled: true, created_at: stamp, url: 'https://saved-b.example/mcp' }
    // Case-specific actual cache inputs exercise A's controlled list/failure; no
    // global cache reset or extra fixture/runtime is needed.
    const originalA: any = mixed ? { id: 'A', slug: 'original-a', name: 'Original A', type: 'stdio', enabled: true, created_at: stamp,
      stdioConfig: { command: process.execPath, args: [originalLocal!.script, originalLocal!.log, scenario === 'mixed-issued-Stop' ? 'original-second-init' : mixedCapacity ? 'original-capacity' : 'original', mixedCollision ? 'remote_tool' : 'a_tool'],
        cwdPolicy: 'none', envRefs: [...aKeyNames.map((savedKeyRef, index) => ({ envVar: index === 0 ? 'SERVER_TOKEN' : `A_REF_${index}`, savedKeyRef })), ...(['mixed-legacy-proto','mixed-remove-proto','mixed-remove-unknown-close'].includes(scenario) ? [{ envVar: '__proto__', savedKeyRef: keyName }] : [])], startupTimeoutMs: 1000, toolCallTimeoutMs: 15000 } } :
      { id: 'A', slug: 'original-a', name: 'Original A', type: 'custom', enabled: true, created_at: stamp, url: `https://original-a.example/mcp/${count}` }
    const savedC = local ? { id: `saved-installed-${count}`, slug: `saved-installed-${count}`, name: 'Controlled C1', type: 'stdio', enabled: scenario === 'stdio-enabled', created_at: stamp,
      stdioConfig: { command: process.execPath, args: [local.script, local.log, scenario === 'stdio-late-init' ? 'late-init' : scenario === 'stdio-late-list' ? 'late-list' : scenario === 'stdio-call-Stop' ? 'slow-call' : scenario === 'stdio-no-env-fixed' ? 'no-env' : 'normal'],
        cwdPolicy: scenario === 'stdio-no-env-fixed' ? 'fixed' : 'none', ...(scenario === 'stdio-no-env-fixed' ? { cwdValue: installedStdioRoot } : {}),
        envRefs: scenario === 'stdio-no-env-fixed' ? [] : [{ envVar: 'SERVER_TOKEN', savedKeyRef: keyName }, { envVar: '__proto__', savedKeyRef: keyName }], startupTimeoutMs: 1000, toolCallTimeoutMs: 15000 } } : undefined
    await redis.json.set(`mcp_gateways:${USER}`, '$', { gateways: [savedB, ...(withA ? [originalA] : []), ...(savedC ? [savedC] : [])] } as any)
    await redis.createAgent({ id: otherId, user_id: USER, agentType: 'api', displayName: 'Other actual Primary', created_at: stamp, defaultMCPGateways: [] } as any)
    const actor = await redis.json.get(`agent:${AGENT}`) as any
    await redis.json.set(`agent:${AGENT}`, '$', { ...actor, defaultMCPGateways: ['saved-B', ...(scenario === 'remove' || mixedRemoval ? ['A'] : [])], memory_enabled: false,
      jev_juice_reply_check: false, jev_juice_style_coach: false, provider_specific_settings: { ...(actor.provider_specific_settings ?? {}), nativeTools: {
        batshitToolsEnabled: true, dynamicMcpEnabled: true, cliToolsEnabled: false, artifactRuntimeEnabled: false, fetchZipEnabled: false,
        agentBrowserEnabled: false, webSearchEnabled: false, bashEnabled: false } },
      ...(scenario === 'inherit' || scenario === 'collision' || mixedCollision ? { custom_tool_settings: [{ tool_name: 'remote_tool', buffer_size: 8, auto_zip: true, future: { keep: true } }] } : {}) } as any)
    const base = await nativePolicyResponse(USER, AGENT), policy = defaultAppActionsPolicy()
    policy.enabled = true; policy.scope = { mode: 'all', subjects: [], except: [] }; policy.ordinaryChanges = false
    policy.management.mcpManagement = decision === 'allow' ? 'allow' : 'ask'; policy.protected.contextManagement = 'allow'
    await saveNativePolicy(USER, AGENT, { expectedGeneration: base.generation, expectedSubjectRevision: base.subjectRevision, policy })
    const sourceWrites = vi.spyOn(gatewayOwner.mcpGatewayService, 'commitPreparedGatewaySave')
    const actualMatchOriginal = gatewayOwner.mcpGatewayService.matchOriginalMcpStdioLaunch.bind(gatewayOwner.mcpGatewayService)
    const matchOriginal = vi.spyOn(gatewayOwner.mcpGatewayService, 'matchOriginalMcpStdioLaunch') // actual data comparison, never a substituted verdict
    const { managedSettingsStore } = await import('$lib/server/services/appActions/settings/managedStore')
    const targetWrites = vi.spyOn(managedSettingsStore, 'writeMcpTarget') // passive actual target writer
    let comparisonsAfterSdkHandoff = 0, delayedComparisons = 0, ordinaryTimingStage = 0
    if (scenario === 'mixed-startup-latency') {
      const sdkHandoffs = new WeakSet<object>() // identity only; never retain/copy env values
      const stdio = await import('$lib/server/services/stdioMCPGatewayClient')
      const actualOwner = Reflect.get(stdio, 'stdioMCPGatewayClient'), create = Reflect.get(actualOwner, 'createTransport')
      expect(typeof create).toBe('function')
      vi.spyOn(actualOwner, 'createTransport').mockImplementation(async (input: any) => {
        const actual = await Reflect.apply(create, actualOwner, [input])
        if (input.originalObservation) sdkHandoffs.add(actual.resolved)
        return actual // SAME actual transport/config; next owner code arms its unchanged SDK timer
      })
      matchOriginal.mockImplementation(async (...input) => {
        if (input[0].gatewayId === 'A') {
          if (sdkHandoffs.has(input[1])) comparisonsAfterSdkHandoff++
          delayedComparisons++
          await new Promise(resolve => setTimeout(resolve, 1500)) // only optional provenance; unchanged saved startup1000
        }
        return actualMatchOriginal(...input)
      })
    }

    const realTake = originalTask.takeP5ApiVerifiedContinuation
    const activations: Array<{ preparation: any; scope: readonly string[]; part: any; reply: string }> = []
    const issuedInputs: any[] = [], contexts: any[] = [], prompts: any[] = [], wire: Array<{ url: string; method: string }> = []
    const networkAttempts: Array<{ url: string; method: string }> = []
    let currentInput: any, modelCalls = 0, actionsIssued = 0, activeC = false, changed = false, readded = false, useIssued = false
    let searchIssued = false, neutralIssued = false, neutralResultObserved = false, usedRef: string | undefined, neutralContactsBefore: number | undefined
    let originalARef: string | undefined, originalAUsed = false, mixedMutated = false, raceDiscoveryStarted = false, replayIssued = false
    let bRowShifted = false, originalARawBeforeShift: string | null | undefined
    const initialObservations: Array<Parameters<typeof discovery.readP5McpClientSettlement>[0]> = []
    const registerInitial = originalTask.registerP5InitialStdioObservation
    if (mixed) vi.spyOn(originalTask, 'registerP5InitialStdioObservation').mockImplementation((owner, id, admission) => {
      const registered = registerInitial(owner, id, admission); if (registered && id === 'A') initialObservations.push(admission); return registered
    })
    let contextAfterCFailed = false
    let contextAfterCFailedSegment: number | undefined
    let postContextSameSdkProviderCalls = 0
    const postContextProviderSegments: number[] = []
    let freshSegmentDiagnosticReadFailed = false
    const freshSegmentObservations: Array<Awaited<ReturnType<typeof readFreshSegmentFacts>>> = []
    async function readFreshSegmentFacts(preparation: Parameters<typeof originalTask.assertP5ApiFreshSegment>[0], phase: 'before' | 'resolved' | 'refused') {
      const counters = { sdkSegments: mocks.sdkRequests.length, modelSteps: modelCalls, compiles: mocks.compiles.length,
        sourceWrites: sourceWrites.mock.calls.length, activations: activations.length, networkAttempts: networkAttempts.length,
        toolCalls: wire.filter(event => event.method === 'tools/call').length, activeC, contextAfterCFailed }
      const runs = contexts.map((context, index) => {
        let stream: ReturnType<typeof readP5ApiStreamSettlement> = undefined, readFailed = false
        try { if (context.p5ApiRun) stream = readP5ApiStreamSettlement(context.p5ApiRun) } catch { readFailed = true }
        return { contextIndex: index, runPresent: !!context.p5ApiRun, streamFactPresent: stream !== undefined,
          consumerConsumed: stream?.consumerConsumed === true, finishKnown: stream?.finishKnown === true, readFailed }
      })
      const parts = await Promise.all(mocks.sdkRequests.map(async (request, index) => {
        let sealed = false, sealedReadFailed = false, storedReadFailed = false, saved: Awaited<ReturnType<typeof stored>> = undefined
        const hasMessageId = typeof request.messageId === 'string' && request.messageId.length > 0
        try { sealed = originalTask.p5CanonicalReplySealed(request.mcpOriginalPreparation, request.messageId, request.mcpApiPart) }
        catch { sealedReadFailed = true }
        try { if (hasMessageId) saved = await stored(request.messageId) } catch { storedReadFailed = true }
        return { sdkSegment: index + 1, samePreparation: request.mcpOriginalPreparation === preparation,
          preparationPresent: !!request.mcpOriginalPreparation, partPresent: !!request.mcpApiPart, hasMessageId,
          canonicalReplySealed: sealed, sealedReadFailed, storedRecordPresent: !!saved, storedReadFailed,
          storedResponseFailed: saved?.metadata?.response_failed === true, storedStatusComplete: saved?.status === 'complete',
          storedStatusError: saved?.status === 'error', storedStatusInProgress: saved?.status === 'in_progress',
          storedMetadataStatusError: saved?.metadata?.status === 'error' }
      }))
      return { phase, ...counters, runs, parts }
    }
    if (scenario === 'context-after-C') {
      const realFreshSegment = originalTask.assertP5ApiFreshSegment
      const observeFreshSegment = async (preparation: Parameters<typeof realFreshSegment>[0], phase: 'before' | 'resolved' | 'refused') => {
        // Read existing owner facts only; a failed diagnostic must not replace the real guard's outcome.
        try { freshSegmentObservations.push(await readFreshSegmentFacts(preparation, phase)) }
        catch { freshSegmentDiagnosticReadFailed = true }
      }
      vi.spyOn(originalTask, 'assertP5ApiFreshSegment').mockImplementation(async preparation => {
        await observeFreshSegment(preparation, 'before')
        try { await realFreshSegment(preparation) }
        catch (error) { await observeFreshSegment(preparation, 'refused'); throw error }
        await observeFreshSegment(preparation, 'resolved')
      })
    }
    const neutralDrift = scenario === 'neutral-source' || scenario === 'neutral-key'
    let entryStage = 0, reportRef: string | undefined, changeRef: string | undefined, entrySchemasObserved = false, entryIdentityChecked = false
    let sourceHeaderCut: { sdkSegments: number; modelSteps: number; compiles: number; networkAttempts: number } | undefined
    const mediaJoin = scenario === 'self' && decision === 'allow' && !withA
    const clipId = `positive-clip-${count}`, clipStateKey = `session:${SESSION}:clip_state`
    if (mediaJoin) {
      await redis.json.set(`clip:${USER}:${clipId}`, '$', { id: clipId, user_id: USER, filename: 'retained-source02.txt', fileType: 'text', mimeType: 'text/plain', content: 'SOURCE02_RETAINED_TEXT_CLIP', storageMode: 'local', created_at: stamp } as any)
      await redis.set(clipStateKey, { sessionId: SESSION, clips: [{ clipId, attachedAt: stamp, attachedToMessageId: 'msg-user-1', unclipAfter: 3, messagesUntilUnclip: 3 }] } as any)
      mocks.onEnd = async event => { if (event.messageId === REPLY) {
        expect(steerOwner.enqueueSteer(SESSION, { steerId: `positive-steer-${count}`, messageId: REPLY, text: 'Preserve the source results.', at: new Date().toISOString(), source: 'user' })).toMatchObject({ ok: true })
      } }
    }
    const refile = vi.spyOn(steerOwner, 'refileUndeliveredSteers')
    const promptSegments: number[] = []
    const sourceIds: string[] = [], png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
    const observedRegistries: any[] = []
    const stdioOwner = await import('$lib/server/services/stdioMCPGatewayClient')
    const stdioSdk = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const actualStdioStart = stdioSdk.StdioClientTransport.prototype.start
    const stdioCloses: Array<{ pid: number | null; closed: boolean }> = []
    let releaseInitialClose: (() => void) | undefined, initialCloseWithheld = false
    if (stdioCase || mixed) vi.spyOn(stdioSdk.StdioClientTransport.prototype, 'start').mockImplementation(async function(this: InstanceType<typeof stdioSdk.StdioClientTransport>) {
      const observation = { pid: null as number | null, closed: false }; stdioCloses.push(observation)
      const onclose = this.onclose
      this.onclose = () => {
        const deliverActualClose = () => { observation.closed = true; onclose?.() }
        if (scenario === 'mixed-initial-close-pending' && !initialCloseWithheld) {
          initialCloseWithheld = true; releaseInitialClose = deliverActualClose // delay ONLY this real event; no close/result is fabricated
        } else deliverActualClose()
      }
      await actualStdioStart.call(this); observation.pid = this.pid
    })
    if (removedUnknown) {
      const close = stdioSdk.StdioClientTransport.prototype.close
      vi.spyOn(stdioSdk.StdioClientTransport.prototype, 'close').mockImplementation(async function(this: InstanceType<typeof stdioSdk.StdioClientTransport>) {
        await close.call(this)
        throw new Error('Controlled original SDK close acknowledgement lost') // actual child/one flight retained as unknown, no invented close
      })
    }
    if (scenario === 'mixed-warm-cache') {
      const warm = await discovery.mcpGatewayDiscovery.discoverFromGateway(originalA, USER)
      expect(warm.success).toBe(true); await expect.poll(() => stdioCloses.every(value => value.closed)).toBe(true)
    }
    const stdioSetup = vi.spyOn(stdioOwner.stdioMCPGatewayClient, 'listForHeldApi') // passive actual owner, not a substituted client
    let boundBeforeStop: Parameters<typeof discovery.readP5McpClientSettlement>[0] | undefined
    const setupEnvCopies: Array<Record<string, string>> = []
    if (scenario === 'stdio-bind-Stop') {
      const read = gatewayOwner.mcpGatewayService.readPreparedMcpStdioLaunch.bind(gatewayOwner.mcpGatewayService)
      vi.spyOn(gatewayOwner.mcpGatewayService, 'readPreparedMcpStdioLaunch').mockImplementation(plan => {
        const actual = read(plan); setupEnvCopies.push(actual.env); return actual
      })
      const bind = originalTask.bindP5ApiSetupClientWork
      vi.spyOn(originalTask, 'bindP5ApiSetupClientWork').mockImplementation((reservation, admission) => {
        bind(reservation, admission); boundBeforeStop = admission // genuine retained owner first
        turns.stopSessionTurn(SESSION, 'Actual Stop after setup bind, before SDK construction')
      })
    }

    let releaseOrdinary: (() => void) | undefined, ordinaryReached: (() => void) | undefined
    const ordinaryAtResolver = new Promise<void>(resolve => { ordinaryReached = resolve })
    const ordinaryRelease = new Promise<void>(resolve => { releaseOrdinary = resolve })
    let raceDiscovery: ReturnType<typeof discovery.mcpGatewayDiscovery.discoverFromGateway> | undefined
    let raceAdmission: Parameters<typeof discovery.readP5McpClientSettlement>[0] | undefined
    let raceAtCapture: ReturnType<typeof stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement> | undefined
    let raceResolverHeld = false
    if (mixedRace) {
      const capture = originalTask.captureP5ApiManagement
      vi.spyOn(originalTask, 'captureP5ApiManagement').mockImplementation((...input) => {
        const actual = capture(...input) // genuine synchronous seal/adoption first; no awaited fixture gate
        expect(actual).toBeDefined(); expect(raceAdmission).toBeDefined()
        expect(originalTask.p5ApiManagedMcpActiveForDiscovery(mocks.compiles[0].options.p5McpOwner)).toBe(true)
        raceAtCapture = stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement(raceAdmission!)
        if (scenario === 'mixed-sealed-resolver') {
          expect(raceAtCapture).toEqual({ constructor: 'not_started', requests: 'not_started', initialize: 'not_started', list: 'not_started', execute: 'not_started', close: 'not_started' })
        } else {
          expect(raceAtCapture.constructor).toBe('started')
          expect(raceAtCapture.initialize, JSON.stringify(raceAtCapture)).toBe('pending')
          expect(raceAtCapture.list).toBe('not_started'); expect(raceAtCapture.execute).toBe('not_started')
          const spawned = stdioWire(originalLocal!.log).filter(row => row.method === 'spawn').at(-1)
          expect(spawned?.pid).toEqual(expect.any(Number))
          expect(stdioCloses.find(value => value.pid === spawned?.pid)?.closed).toBe(false)
          expect(stdioWire(originalLocal!.log).some(row => row.pid === spawned?.pid && row.method === 'initialize')).toBe(true)
        }
        releaseOrdinary!()
        if (scenario === 'mixed-issued-Stop') turns.stopSessionTurn(SESSION, 'Actual Stop after second ordinary A initialization and management seal')
        return actual
      })
    }

    type ActualMcpFrame = { kind: 'read' | 'source' | 'target'; keys: string[]; actualKeys: string[]; paths: string[][]; afterBShift: boolean; result?: string }
    const actualFrames: ActualMcpFrame[] = []
    if (mixedCapacity || scenario === 'mixed-B-row-shift') {
      const write = await import('$lib/server/services/appActions/mcp/gatewayWriteContext')
      const target = await import('$lib/server/services/appActions/settings/conditionalAgentSettings'), execute = redis.execute.bind(redis)
      function observed(client: any): any {
        return new Proxy(client, { get(object, property) {
          if (property === 'withAbortSignal') return (signal: AbortSignal) => observed(object.withAbortSignal(signal))
          if (property === 'eval') return (script: string, options: any) => {
            const kind = script === gatewayOwner.READ_MCP_PREREQUISITE_CUT_SCRIPT ? 'read' : script === write.CONDITIONAL_MCP_GATEWAY_WRITE_SCRIPT ? 'source' : script === target.CONDITIONAL_MCP_TARGET_SCRIPT ? 'target' : undefined
            const paths = kind ? JSON.parse(options.arguments[kind === 'read' ? 1 : kind === 'source' ? 4 : 0]) : undefined
            const frame: ActualMcpFrame | undefined = kind ? { kind, keys: options.keys.slice(kind === 'read' ? 2 : kind === 'source' ? 1 : 0, kind === 'target' ? -1 : undefined),
              actualKeys: [...options.keys], paths: paths.map((entries: any[]) => entries.map(entry => entry[0])), afterBShift: bRowShifted } : undefined
            if (frame) actualFrames.push(frame)
            const flight = object.eval(script, options)
            if (frame) void flight.then((answer: unknown) => { frame.result = Array.isArray(answer) && typeof answer[0] === 'string' ? answer[0] : undefined }, () => {})
            return flight // actual eval result/ACK unchanged; this records no raw or plaintext values
          }
          const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value
        } })
      }
      vi.spyOn(redis, 'execute').mockImplementation((operation: any) => execute(client => operation(observed(client))))
    }

    const actualHeaders = (transport.StreamableHTTPClientTransport.prototype as any)._commonHeaders
    vi.spyOn(transport.StreamableHTTPClientTransport.prototype as any, '_commonHeaders').mockImplementation(async function(this: any) {
      const answer = await actualHeaders.call(this)
      if (scenario === 'source-header' && activeC && !changed && String(this._url).startsWith(sourceBase)) {
        sourceHeaderCut = { sdkSegments: mocks.sdkRequests.length, modelSteps: modelCalls, compiles: mocks.compiles.length, networkAttempts: networkAttempts.length }
        changed = true
        const rows = await redis.json.get(`mcp_gateways:${USER}`) as any
        const index = rows.gateways.findIndex((row: any) => row.id === sourceIds[0])
        await redis.json.set(`mcp_gateways:${USER}`, `$.gateways[${index}].url`, 'https://changed-after-header.example/mcp')
      }
      return answer
    })
    const getClip = vi.spyOn(redis, 'get'), spend = vi.spyOn(clipOwner, 'decrementSessionClipDurations')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      // Record attempted contact before the refusal, so a wrong-URL/key cache
      // miss cannot disappear merely because this fixture rejects its response.
      networkAttempts.push({ url, method: init?.method ?? 'GET' })
      if (!url.startsWith(sourceBase) && url !== originalA.url) throw new Error('Controlled fixture forbids all unrelated network contact, including saved B.')
      if (init?.method === 'GET') { wire.push({ url, method: 'GET' }); return new Response(null, { status: 405 }) }
      if (init?.method !== 'POST') throw new Error('Controlled fixture forbids an unexpected HTTP method.')
      if (url.startsWith(sourceBase)) expect(new Headers(init.headers).get('authorization')).toBe('Bearer CONTROLLED_SYNTHETIC_HANDLER_VALUE')
      const message = JSON.parse(String(init.body)); wire.push({ url, method: message.method })
      if (scenario === 'mixed-B-row-shift' && !bRowShifted && url.startsWith(sourceBase) && message.method === 'initialize') {
        const registryKey = `mcp_gateways:${USER}`, registry = await redis.json.get(registryKey) as any
        expect(registry.gateways.map((row: any) => row.id)).toEqual(['saved-B','A',sourceIds[0]])
        originalARawBeforeShift = await redis.json.getRaw(registryKey, '$.gateways[1]')
        expect(stdioWire(originalLocal!.log).some(row => row.method === 'tools/call')).toBe(false) // paused A has not issued
        await redis.json.set(registryKey, '$.gateways', [registry.gateways[1], registry.gateways[0], registry.gateways[2]])
        expect(await redis.json.getRaw(registryKey, '$.gateways[?(@.id=="A")]')).toBe(originalARawBeforeShift)
        bRowShifted = true
      }

      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (scenario === 'missing-A-names' && url === originalA.url && message.method === 'tools/list') return new Response('controlled ordinary A discovery failure', { status: 503 })
      const name = url === originalA.url && scenario !== 'collision' ? 'a_tool' : 'remote_tool'
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'controlled actual MCP', version: '1' } } :
        message.method === 'tools/list' ? { tools: [{ name, description: 'Controlled actual source tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] } :
        message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ success: true, source: url, value: message.params.arguments.value }) }] } : undefined
      if (!result) throw new Error('No unplanned RPC can be executed by this fixture.')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } })
    })
    mocks.sdkTools = async (context, built) => {
      expect(context.p5ApiRun).toBeDefined(); contexts.push(context)
      expect(originalTask.p5ApiNeedsPrerequisiteDcm(context.p5ApiRun)).toBe(false) // already-associated API run
      if (!built?.ephemeralImages) throw new Error('The actual composed Brain image registry is missing.')
      observedRegistries.push(built.ephemeralImages)
      if (scenario !== 'self' || decision !== 'allow' || withA) return built
      const registry = built.ephemeralImages
      return { ...built, tools: { ...built.tools, produce_image: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async (_input, options) => { registry.register(options.toolCallId, 'positive-pending-source', [{ mediaType: 'image/png', data: png }], 'controlled positive image', 'synthetic_user'); return { completed: true } } }) } }
    }
    mocks.sdkDispatchObserver = async request => {
      const context = contexts.at(-1)
      expect(context?.p5ApiRun).toBeDefined()
      expect(mocks.compiles.at(-1)?.finalized).toBe(true)
      expect(request.preparedApiToolset).toBeDefined()
      const priorModelCalls = modelCalls
      if ((scenario === 'entry-discovery' || stdioEntry) && !entryIdentityChecked) {
        const compile = mocks.compiles[0], before = networkAttempts.length
        expect(compile.options.p5McpOwner).toBeDefined()
        expect(originalTask.p5ApiHasVerifiedMcpSource(compile.options.p5McpOwner)).toBe(false)
        // SAME actual compiler instance and opaque preparation, initial/pre-C.
        // Exercise only its DCM catch seam so Clip/history compilation is not
        // repeated. No fake owner, ACK or readiness result is supplied.
        const dcm = Reflect.get(compile.compiler, 'buildDynamicMcpDcm')
        await expect(Reflect.apply(dcm, compile.compiler, [{ userId: 'different-metadata-user', agentId: AGENT,
          p5McpOwner: compile.options.p5McpOwner, mcpGatewayScope: [], nativeDynamicMcpEnabled: false,
          nativeCliToolsEnabled: false }])).rejects.toThrow('original API discovery identity changed')
        await expect(Reflect.apply(dcm, compile.compiler, [{ userId: '   ', agentId: AGENT,
          p5McpOwner: compile.options.p5McpOwner, mcpGatewayScope: [], nativeDynamicMcpEnabled: false,
          nativeCliToolsEnabled: false }])).rejects.toThrow('original API discovery identity changed')
        expect(networkAttempts).toHaveLength(before); entryIdentityChecked = true
      }
      if (mixed && !mixedMutated) {
        mixedMutated = true
        expect(initialObservations.length).toBeGreaterThan(0)
        if (mixedRace) {
          const preparation = mocks.compiles[0].options.p5McpOwner
          expect(preparation).toBeDefined(); expect(preparation).toBe(request.mcpOriginalPreparation)
          const first = initialObservations.map(admission => stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement(admission))
          expect(first.some(fact => fact.constructor === 'started' && fact.initialize === 'known' && fact.list === 'known' && fact.close === 'known')).toBe(true)
          expect(stdioWire(originalLocal!.log).filter(row => row.method === 'spawn')).toHaveLength(1)
          if (scenario === 'mixed-sealed-resolver') {
            const config = await import('$lib/server/services/mcpGatewayStdio'), resolve = config.resolveStdioGatewayProcessConfig
            vi.spyOn(config, 'resolveStdioGatewayProcessConfig').mockImplementation(async input => {
              if (input.gateway.id === 'A' && !raceResolverHeld) {
                raceResolverHeld = true; ordinaryReached!(); await ordinaryRelease
              }
              return resolve(input) // same ordinary producer, never a supplied resolved config
            })
          }
          // Explicit second fresh cold-client race through the SAME frozen owner, not compiler scheduling.
          const before = initialObservations.length
          raceDiscoveryStarted = true
          raceDiscovery = discovery.mcpGatewayDiscovery.discoverFromGateway(originalA, USER, { p5Owner: preparation, fresh: true })
          void raceDiscovery.catch(() => {}) // SAME promise is observed/awaited below and in protected finally
          expect(initialObservations).toHaveLength(before + 1); raceAdmission = initialObservations.at(-1)
          expect(discovery.readP5McpClientSettlement(raceAdmission!).run).toBe(preparation)
          if (scenario === 'mixed-sealed-resolver') await ordinaryAtResolver
          else await expect.poll(() => {
            const phase = stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement(raceAdmission!)
            const spawned = stdioWire(originalLocal!.log).filter(row => row.method === 'spawn').at(-1)
            return phase.constructor === 'started' && phase.initialize === 'pending' && phase.list === 'not_started' &&
              stdioCloses.some(value => value.pid === spawned?.pid && !value.closed) &&
              stdioWire(originalLocal!.log).some(row => row.pid === spawned?.pid && row.method === 'initialize')
          }, { timeout: 30000 }).toBe(true)
        }
        if (scenario === 'mixed-initial-close-pending') {
          expect(releaseInitialClose).toBeDefined()
          expect(initialObservations.some(admission => discovery.readP5McpClientSettlement(admission).close === 'pending')).toBe(true)
          expect(context.p5ApiRun).toBeDefined() // SAME ordinary association survived a physically unconfirmed close
        }
        if (scenario === 'mixed-source') await redis.json.set(`mcp_gateways:${USER}`, '$.gateways[1].stdioConfig.args', ['/changed/original-entry.cjs'])
        if (scenario === 'mixed-key') await apiKeyService.store(keyName, 'CONTROLLED_CHANGED_ORIGINAL_A_VALUE', USER)
        if (scenario === 'mixed-remove-key') await redis.del(`api_keys:${USER}:${keyName}`)
        if (scenario === 'mixed-file') { const bytes = readFileSync(originalLocal!.script); renameSync(originalLocal!.script, `${originalLocal!.script}.${count}.old`); writeFileSync(originalLocal!.script, bytes) }
      }
      const need = scenario === 'max3' ? 4 : scenario === 'C1-after-C2' ? 2 : 1
      if (scenario !== 'entry-discovery' && !stdioEntry && issuedInputs.length < need) {
        const stage = issuedInputs.length + 1
        const target = { subject: { kind: 'primary', id: scenario === 'other' ? otherId : AGENT },
          ...((scenario === 'remove' || mixedRemoval) ? { gatewayId: 'A', membership: 'disable' } : { ...(savedC ? { gatewayId: savedC.id } : {}), membership: 'enable' }),
          ...(scenario === 'inherit' ? { zip: { toolName: 'remote_tool', mode: 'inherit' } } : withA && !mixedRemoval ? { zip: { toolName: 'remote_tool', zipThreshold: 0, autoZip: false } } : {}) }
        const query = { domain: 'mcp-configuration', query: { kind: 'prerequisite', target,
          ...((scenario === 'remove' || mixedRemoval) || stdioCase ? {} : { candidate: { kind: 'http', name: `Controlled C${stage}`, url: `${sourceBase}${stage}`, savedKeyRef: keyName,
            evidence: { kind: 'supplied', uri: 'https://positive-source.example/docs' } } }) } }
        const held: any = await runtime.settingsManagementReports.report({ userId: USER, agentId: AGENT, sessionId: SESSION, messageId: request.messageId,
          actorType: 'in-process', abortSignal: request.abortSignal, p5ApiRun: context.p5ApiRun }, 'native', query)
        const row = held.report.rows[0]
        currentInput = { op: 'change', requestId: `${held.bootNamespace}:outer-${count}-${stage}`, reportId: held.reportId, semanticId: 'mcp.workflow.configure',
          changes: { ...((scenario === 'remove' || mixedRemoval) ? {} : { source: { candidateId: row.candidateId } }), target: { ...target, gatewayId: row.gatewayId } } }
        issuedInputs.push(currentInput); if (scenario !== 'remove' && !mixedRemoval) sourceIds.push(row.gatewayId)
      }
      expect(modelCalls).toBe(priorModelCalls) // actual SDK model has not run during this observer
    }
    const disposition = vi.spyOn(originalTask, 'takeP5ApiVerifiedContinuation').mockImplementation(async preparation => {
      const previous = mocks.sdkRequests.at(-1)
      expect(originalTask.p5CanonicalReplySealed(preparation, previous.messageId, previous.mcpApiPart)).toBe(true)
      expect((await stored(previous.messageId))?.metadata?.response_failed).not.toBe(true)
      const next = await realTake(preparation)
      if (next) {
        expect(originalTask.p5ApiNeedsPrerequisiteDcm(preparation)).toBe(true)
        if (stdioCase) { expect(stdioCloses).toHaveLength(1); expect(stdioCloses[0].closed).toBe(true); expect(stdioWire(local!.log).some(row => row.method === 'tools/call')).toBe(false) }
        activations.push({ preparation, scope: next.gateways, part: previous.mcpApiPart, reply: previous.messageId }); activeC = true
        if (!changed && ['source','key','policy','actor','Stop','deadline','remove-readd','inherit','stdio-source','stdio-key','stdio-file'].includes(scenario)) {
          changed = true
          if (scenario === 'stdio-file') {
            const bytes = readFileSync(local!.script)
            renameSync(local!.script, `${local!.script}.${count}.old`); writeFileSync(local!.script, bytes)
          }
          if (scenario === 'stdio-source') await redis.json.set(`mcp_gateways:${USER}`, `$.gateways[${(await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.findIndex((row: any) => row.id === savedC!.id)}].stdioConfig.args`, ['/changed/entry.cjs'])
          if (scenario === 'stdio-key') await apiKeyService.store(keyName, 'CONTROLLED_CHANGED_STDIO_VALUE', USER)
          if (scenario === 'source') {
            const rows = await redis.json.get(`mcp_gateways:${USER}`) as any
            await redis.json.set(`mcp_gateways:${USER}`, `$.gateways[${rows.gateways.findIndex((row: any) => row.id === sourceIds[0])}].url`, 'https://changed-before-compile.example/mcp')
          }
          if (scenario === 'key') await apiKeyService.store(keyName, 'CONTROLLED_CHANGED_HANDLER_VALUE', USER)
          if (scenario === 'policy') { const value = await nativePolicyResponse(USER, AGENT); await saveNativePolicy(USER, AGENT, { expectedGeneration: value.generation, expectedSubjectRevision: value.subjectRevision, policy: { ...value.policy, management: { ...value.policy.management, mcpManagement: 'block' } } }) }
          if (scenario === 'actor') await redis.json.set(`agent:${AGENT}`, '$.created_at', 'different-actual-incarnation')
          if (scenario === 'Stop') turns.stopSessionTurn(SESSION, 'controlled Stop after actual canonical activation')
          if (scenario === 'deadline') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180001)
          if (scenario === 'inherit') await redis.updateUserSettings(USER, { global_zip_settings: { buffer_size_all_other_tools: 3, zip_threshold_all_other_tools: 0, auto_zip_all_other_tools: false } })
          if (scenario === 'remove-readd') {
            const prior = await redis.json.get(`agent:${AGENT}`) as any
            await redis.json.set(`agent:${AGENT}`, '$.defaultMCPGateways', prior.defaultMCPGateways.filter((id: string) => id !== sourceIds[0]))
            await expect(originalTask.readP5ApiVerifiedMcpAuthority(preparation, sourceIds[0])).rejects.toThrow()
            await redis.json.set(`agent:${AGENT}`, '$.defaultMCPGateways', prior.defaultMCPGateways); readded = true
            expect(originalTask.p5ApiPreparedGatewayFrontier(preparation)).not.toContain(sourceIds[0])
          }
        }
      }
      return next
    })
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    mocks.sdkModel = new MockLanguageModelV3({ provider: 'fixture', modelId: 'claude-sonnet-5', doStream: async options => {
      if (scenario === 'context-after-C' && contextAfterCFailed) {
        const segment = mocks.sdkRequests.length
        postContextProviderSegments.push(segment)
        if (segment === contextAfterCFailedSegment) {
          postContextSameSdkProviderCalls++
          throw new Error('The context-error tail attempted another provider step in the SAME SDK segment.')
        }
      }
      modelCalls++; prompts.push(structuredClone(options.prompt)); promptSegments.push(mocks.sdkRequests.length)
      const need = scenario === 'max3' ? 4 : scenario === 'C1-after-C2' ? 2 : 1
      const content: LanguageModelV3StreamPart[] = []
      // These are the actual installed provider prompt's tool-result parts,
      // produced by the genuine native helper/formatter and consumed by the next
      // SDK step. No held capability, result or reference is supplied by a fake.
      const toolText = (toolCallId: string): string => {
        const part = (options.prompt as any[]).flatMap(message => Array.isArray(message.content) ? message.content : [])
          .findLast(part => part.type === 'tool-result' && part.toolCallId === toolCallId)
        expect(part).toBeDefined(); expect(part.output.type).toBe('text'); expect(typeof part.output.value).toBe('string')
        return part.output.value
      }
      const finish = () => content.push({ type: 'text-start', id: 'positive-final' }, { type: 'text-delta', id: 'positive-final', delta: 'The original task finished through actual owned boundaries.' }, { type: 'text-end', id: 'positive-final' })
      if ((scenario === 'entry-discovery' || stdioEntry) && entryStage < (stdioEntry ? 4 : 3)) {
        if (entryStage === 0) {
          // Initial original API Search, BEFORE any report/setup/C. This must
          // receive the full schema from the genuine native/Fabric passage.
          expect(activeC).toBe(false); expect(sourceWrites).not.toHaveBeenCalled(); expect(issuedInputs).toHaveLength(0)
          expect(originalTask.p5ApiNeedsPrerequisiteDcm(mocks.sdkRequests[0].mcpOriginalPreparation)).toBe(false)
          content.push({ type: 'tool-call', toolCallId: 'entry-settings-search', toolName: 'native_batshit_tool_search', input: JSON.stringify({ family: 'fabric', domain: 'agent-settings', query: 'MCP', schemaMode: 'full' }) })
          entryStage = 1
        } else if (entryStage === 1) {
          const text = toolText('entry-settings-search')
          const found = new Map<string, { ref: string; schema?: any }>()
          let leaf: string | undefined
          for (const line of text.split('\n')) {
            const match = /^- fabric: (fabric:sys\.app_settings\.native\.(report|change)) /.exec(line)
            if (match) { leaf = match[2]; found.set(leaf, { ref: match[1] }) }
            else if (leaf && line.trimStart().startsWith('full_schema: ')) found.get(leaf)!.schema = JSON.parse(line.trimStart().slice('full_schema: '.length))
          }
          const report = found.get('report'), change = found.get('change')
          expect(report?.schema.oneOf[1].properties.domain.const).toBe('mcp-configuration')
          expect(change?.schema.oneOf[1].properties.semanticId.const).toBe('mcp.workflow.configure')
          expect(report?.schema.oneOf[1].properties.query.oneOf[2].properties.candidate.properties.savedKeyRef.description).toContain('never its value')
          reportRef = report!.ref; changeRef = change!.ref; entrySchemasObserved = true
          if (stdioEntry) {
            expect(report!.schema.oneOf[1].properties.query.description).toContain('already-installed saved STDIO')
            content.push({ type: 'tool-call', toolCallId: 'entry-saved-sources', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: reportRef, input: { domain: 'mcp-configuration', query: { kind: 'sources' } } }) })
          } else content.push({ type: 'tool-call', toolCallId: 'entry-settings-report', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: reportRef, input: {
            domain: 'mcp-configuration', query: { kind: 'prerequisite', candidate: { kind: 'http', name: 'Controlled C1', url: `${sourceBase}1`, savedKeyRef: keyName,
              evidence: { kind: 'supplied', uri: 'https://positive-source.example/docs' } }, target: { subject: { kind: 'primary', id: AGENT }, membership: 'enable',
              zip: { toolName: 'remote_tool', zipThreshold: 0, autoZip: false } } }
          } }) })
          entryStage = 2
        } else if (stdioEntry && entryStage === 2) {
          const text = toolText('entry-saved-sources'), marker = '\nresult:\n'
          expect(text).toContain(`batshit_tool_use succeeded: ${reportRef}`)
          const rows = JSON.parse(text.slice(text.indexOf(marker) + marker.length)).result.report.rows
          const source = rows.find((row: any) => row.type === 'stdio' && row.name === 'Controlled C1')
          expect(source).toMatchObject({ enabled: false, readiness: 'unknown' })
          content.push({ type: 'tool-call', toolCallId: 'entry-settings-report', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: reportRef, input: {
            domain: 'mcp-configuration', query: { kind: 'prerequisite', target: { subject: { kind: 'primary', id: AGENT }, gatewayId: source.id, membership: 'enable', zip: { toolName: 'remote_tool', zipThreshold: 0, autoZip: false } } }
          } }) })
          entryStage = 3
        } else {
          const text = toolText('entry-settings-report'), marker = '\nresult:\n'
          expect(text).toContain(`batshit_tool_use succeeded: ${reportRef}`); expect(text.includes(marker)).toBe(true)
          const held = JSON.parse(text.slice(text.indexOf(marker) + marker.length)).result, row = held.report.rows[0]
          expect(held.domain).toBe('mcp-configuration'); expect(row.kind).toBe('prerequisite')
          expect(row.target).toEqual({ kind: 'primary', id: AGENT }); expect(row.membership).toBe('enable')
          expect(row.gatewayId).toEqual(expect.any(String)); expect(row.candidateId).toEqual(expect.any(String))
          currentInput = { op: 'change', requestId: `${held.bootNamespace}:model-entry-${count}`, reportId: held.reportId, semanticId: 'mcp.workflow.configure',
            changes: { source: { candidateId: row.candidateId }, target: { subject: row.target, gatewayId: row.gatewayId, membership: row.membership, zip: row.zip } } }
          issuedInputs.push(currentInput); sourceIds.push(row.gatewayId); actionsIssued++
          content.push({ type: 'tool-call', toolCallId: 'complete-setup-1', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: changeRef, input: currentInput }) })
          entryStage = stdioEntry ? 4 : 3
        }
      } else if (decision === 'deny' && modelCalls > 1) content.push({ type: 'text-start', id: 'denied' }, { type: 'text-delta', id: 'denied', delta: 'The complete setup was denied.' }, { type: 'text-end', id: 'denied' })
      else if (scenario === 'mixed-startup-latency' && ordinaryTimingStage < 3) {
        if (ordinaryTimingStage === 0) {
          ordinaryTimingStage = 1
          content.push({ type: 'tool-call', toolCallId: 'ordinary-timing-search', toolName: 'native_batshit_tool_search', input: JSON.stringify({ family: 'mcp', query: 'a_tool', schemaMode: 'full' }) })
        } else if (ordinaryTimingStage === 1) {
          const text = toolText('ordinary-timing-search'), line = text.split('\n').find(line => line.startsWith('- mcp: ') && line.includes('source=Original A'))
          const ref = line?.match(/^- mcp: (mcp:[A-Za-z0-9_-]+) /)?.[1]; expect(ref).toBeDefined()
          ordinaryTimingStage = 2
          content.push({ type: 'tool-call', toolCallId: 'ordinary-timing-use', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref, input: { value: 'ordinary-before-management' } }) })
        } else {
          expect(toolText('ordinary-timing-use')).toContain('batshit_tool_use succeeded:')
          expect(sourceWrites).not.toHaveBeenCalled(); expect(activeC).toBe(false)
          ordinaryTimingStage = 3; actionsIssued++
          content.push({ type: 'tool-call', toolCallId: 'complete-setup-1', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: 'fabric:sys.app_settings.native.change', input: currentInput }) })
        }
      }
      else if (actionsIssued < need) {
        actionsIssued++
        if (scenario === 'self' && decision === 'allow' && !withA) content.push({ type: 'tool-call', toolCallId: 'positive-image', toolName: 'produce_image', input: '{}' })
        content.push({ type: 'tool-call', toolCallId: `complete-setup-${actionsIssued}`, toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: 'fabric:sys.app_settings.native.change', input: currentInput }) })
        if (removedMismatch) content.push({ type: 'tool-call', toolCallId: 'repeat-exact-removal', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: 'fabric:sys.app_settings.native.change', input: currentInput }) }) // same real SDK step/request, one actual target write
      } else if (!activeC || mixedRefusal || mixedRemoval) {
        // Approved SDK replay can finish a step under original A before the actual canonical take.
        // Finish that segment; only the delegated realTake above activates verified-C Search/Use.
        finish()
      } else if (mixed && !mixedRefusal && !mixedRemoval) {
        if (!searchIssued) {
          searchIssued = true
          content.push({ type: 'tool-call', toolCallId: 'mixed-returned-search', toolName: 'native_batshit_tool_search', input: JSON.stringify({ family: 'mcp', query: 'tool', schemaMode: 'full' }) })
        } else if (!useIssued) {
          const text = toolText('mixed-returned-search')
          const ref = (name: string) => text.split('\n').find(line => line.startsWith('- mcp: ') && line.includes(`source=${name}`))?.match(/^- mcp: (mcp:[A-Za-z0-9_-]+) /)?.[1]
          usedRef = ref('Controlled C1'); originalARef = ref('Original A')
          expect(usedRef).toBeDefined(); expect(originalARef).toBeDefined(); expect(usedRef).not.toBe(originalARef)
          if (mixedCollision) { expect(originalARef).toBe('mcp:remote_tool'); expect(usedRef).toBe('mcp:Controlled_C1_remote_tool') }
          useIssued = true
          content.push({ type: 'tool-call', toolCallId: 'mixed-C-use', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: usedRef!, input: { value: 'controlled-C' } }) })
        } else if (!originalAUsed) {
          expect(toolText('mixed-C-use')).toContain('batshit_tool_use succeeded:')
          originalAUsed = true
          content.push({ type: 'tool-call', toolCallId: 'mixed-A-use', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: originalARef!, input: { value: 'controlled-A' } }) })
        } else if (mixedCapacity && !replayIssued) {
          expect(toolText('mixed-A-use')).toContain('batshit_tool_use succeeded:'); replayIssued = true
          content.push({ type: 'tool-call', toolCallId: 'mixed-C-replay', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: 'fabric:sys.app_settings.native.change', input: currentInput }) })
        } else { if (mixedCapacity) expect(toolText('mixed-C-replay')).toContain('batshit_tool_use succeeded:'); else expect(toolText('mixed-A-use')).toContain('batshit_tool_use succeeded:'); finish() }
      } else if (neutralDrift) {
        if (!neutralIssued) {
          // The genuine continuation and its fresh compiler already succeeded.
          // Drift occurs at the actual provider/tool boundary, exposing a Find
          // custody drop even though a later direct Use would still refuse it.
          expect(activeC).toBe(true); expect(mocks.compiles.length).toBeGreaterThan(1)
          neutralContactsBefore = networkAttempts.filter(event => event.url.startsWith(sourceBase)).length
          if (scenario === 'neutral-source') {
            const rows = await redis.json.get(`mcp_gateways:${USER}`) as any
            const index = rows.gateways.findIndex((row: any) => row.id === sourceIds[0])
            await redis.json.set(`mcp_gateways:${USER}`, `$.gateways[${index}].url`, 'https://changed-at-neutral-find.example/mcp')
          } else await apiKeyService.store(keyName, 'CONTROLLED_CHANGED_NEUTRAL_FIND_VALUE', USER)
          neutralIssued = true
          content.push({ type: 'tool-call', toolCallId: 'actual-neutral-find', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: 'batshit:sys.mcp.dynamic.find', input: { tool: 'remote_tool', exact: true, includeSchema: true } }) })
        } else {
          expect(toolText('actual-neutral-find')).toContain('batshit_tool_use failed: batshit:sys.mcp.dynamic.find')
          neutralResultObserved = true; finish()
        }
      } else if (scenario !== 'stdio-late-init' && scenario !== 'stdio-late-list' && scenario !== 'other' && scenario !== 'remove' && scenario !== 'max3' && scenario !== 'remove-readd') {
        if ((scenario === 'collision' || stdioEntry) && !neutralIssued) {
          // Unchanged ordinary A remains usable through the same neutral owner,
          // narrowed by its real selected-gateway filter. C gets no A authority.
          neutralIssued = true
          content.push({ type: 'tool-call', toolCallId: 'ordinary-A-neutral-find', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: 'batshit:sys.mcp.dynamic.find', input: { tool: 'remote_tool', exact: true, includeSchema: true, ...(stdioEntry ? {} : { selectedGateways: ['A'] }) } }) })
        } else {
          if ((scenario === 'collision' || stdioEntry) && !neutralResultObserved) {
            const text = toolText('ordinary-A-neutral-find'), marker = '\nresult:\n'
            expect(text).toContain('batshit_tool_use succeeded: batshit:sys.mcp.dynamic.find')
            expect(text.includes(marker)).toBe(true)
            const actual = JSON.parse(text.slice(text.indexOf(marker) + marker.length))
            expect(actual.result.results).toHaveLength(1)
            expect(actual.result.results[0]).toMatchObject({ gatewayId: stdioEntry ? sourceIds[0] : 'A', toolName: 'remote_tool' })
            neutralResultObserved = true
          }
          if (!searchIssued) {
            searchIssued = true
            content.push({ type: 'tool-call', toolCallId: 'actual-verified-search', toolName: 'native_batshit_tool_search', input: JSON.stringify({ family: 'mcp', query: 'remote_tool', schemaMode: 'full' }) })
          } else if (!useIssued) {
            const text = toolText('actual-verified-search')
            const line = text.split('\n').find(line => line.startsWith('- mcp: ') && line.includes('source=Controlled C1'))
            usedRef = line?.match(/^- mcp: (mcp:[A-Za-z0-9_-]+) /)?.[1]
            expect(usedRef).toBeDefined()
            if (scenario === 'collision') {
              expect(text).toContain('- mcp: mcp:remote_tool (remote_tool) source=Original A')
              expect(usedRef).toBe('mcp:Controlled_C1_remote_tool')
            }
            useIssued = true
            content.push({ type: 'tool-call', toolCallId: 'actual-verified-use', toolName: 'native_batshit_tool_use', input: JSON.stringify({ ref: usedRef!, input: { value: 'controlled' } }) })
          } else if (scenario === 'context-after-C' && !contextAfterCFailed) {
            contextAfterCFailed = true
            contextAfterCFailedSegment = mocks.sdkRequests.length
            const exhausted = Object.assign(new Error("This model's maximum context length is 131072 tokens."), { code: 'context_length_exceeded' })
            return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
              { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'after-C-context' },
              { type: 'text-delta', id: 'after-C-context', delta: 'The verified source returned its result before ordinary context recovery.' },
              { type: 'text-end', id: 'after-C-context' }, { type: 'error', error: exhausted },
              { type: 'finish', finishReason: { unified: 'error', raw: 'context_length_exceeded' }, usage }
            ]) }
          } else finish()
        }
      } else finish()
      const usesTools = content.some(part => part.type === 'tool-call')
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([{ type: 'stream-start', warnings: [] }, ...content,
        { type: 'finish', finishReason: { unified: usesTools ? 'tool-calls' : 'stop', raw: usesTools ? 'tool_calls' : 'stop' }, usage }]) }
    } })
    let stopTask: Promise<void> | undefined
    try {
      if (scenario === 'stdio-call-Stop') stopTask = (async () => {
        await expect.poll(() => stdioWire(local!.log).some(row => row.method === 'tools/call'), { timeout: 30000 }).toBe(true)
        turns.stopSessionTurn(SESSION, 'Actual Stop after STDIO tools/call, before delayed effect')
      })()
      if (stopTask) void stopTask.catch(() => {}) // SAME promise is awaited below/finally
      let response = await send(undefined, [{ id: 'msg-user-1', role: 'user', content: 'Say two parts.' }], { metadata: { selectedGateways: originalScope } })
      if (decision !== 'allow') {
        const paused = await stored(REPLY), approval = paused.metadata.toolApprovals.approvals.find((entry: any) => entry.status === 'pending')
        expect(approval.control.settingsPreview.preview.resource.variant).toBe('prerequisite')
        expect(approval.control.settingsPreview.preview.targets).toHaveLength(1)
        expect(sourceWrites).not.toHaveBeenCalled()
        response = await send(undefined, [{ id: 'msg-user-1', role: 'user', content: 'Say two parts.' }, paused] as any, { content: '',
          metadata: { selectedGateways: originalScope, toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: approval.approvalId, approved: decision === 'approve' }] } })
      }
      if (['source','source-header','key','policy','actor','Stop','deadline','missing-A-names','stdio-source','stdio-key','stdio-file'].includes(scenario)) expect(response.status).not.toBe(200)
      else if (scenario === 'stdio-call-Stop' || scenario === 'stdio-bind-Stop' || scenario === 'mixed-issued-Stop') expect(response.status).toBe(499)
      else {
        const failure = response.status === 200 ? undefined : await response.clone().json()
        expect(response.status, JSON.stringify({ scenario, decision, status: response.status, failure,
          sdkSegments: mocks.sdkRequests.length, modelSteps: modelCalls, compiles: mocks.compiles.length, sourceHeaderCut,
          ...(scenario === 'context-after-C' ? { freshSegmentObservations, freshSegmentDiagnosticReadFailed,
            contextAfterCFailedSegment, postContextSameSdkProviderCalls, postContextProviderSegments } : {}) })).toBe(200)
      }
      expect(networkAttempts.every(event => event.url !== savedB.url)).toBe(true)
      const expectedWrites = mixedRefusal || mixedRemoval ? 0 : decision === 'deny' || scenario === 'remove' || scenario === 'missing-A-names' || scenario === 'stdio-enabled' ? 0 : scenario === 'max3' ? 3 : scenario === 'C1-after-C2' ? 2 : 1
      expect(sourceWrites).toHaveBeenCalledTimes(expectedWrites)
      expect(activations).toHaveLength(mixedRefusal || removedUnknown ? 0 : decision === 'deny' || scenario === 'missing-A-names' || scenario === 'stdio-late-init' || scenario === 'stdio-late-list' || scenario === 'stdio-bind-Stop' ? 0 : scenario === 'max3' ? 3 : scenario === 'C1-after-C2' ? 2 : 1)
      for (const activation of activations) expect(activation.scope).not.toContain('saved-B')
      if (activations.length) expect(activations.every(value => value.preparation === activations[0].preparation)).toBe(true)
      if (scenario === 'other' || scenario === 'remove' || scenario === 'remove-readd') {
        expect(wire.some(event => event.method === 'tools/call')).toBe(false)
        expect(originalTask.p5ApiPreparedGatewayFrontier(activations.at(-1)?.preparation)).not.toContain(sourceIds[0])
      }
      if (scenario === 'remove') expect(wire).toEqual([])
      if (scenario === 'max3') expect(actionsIssued).toBe(4)
      if (scenario === 'remove-readd') expect(readded).toBe(true)
      if (scenario === 'C1-after-C2') expect(wire.filter(event => event.method === 'tools/call').map(event => event.url)).toEqual([`${sourceBase}1`])
      if (scenario === 'source-header') {
        // The real compiler propagates this refused C discovery before a child
        // provider call. Only setup contacted the original source.
        expect(sourceHeaderCut).toMatchObject({ sdkSegments: 1, modelSteps: 1, compiles: 2 })
        expect(mocks.sdkRequests).toHaveLength(1); expect(modelCalls).toBe(1)
        expect(networkAttempts).toHaveLength(sourceHeaderCut!.networkAttempts)
        expect(wire.filter(event => event.url.startsWith(sourceBase) && event.method === 'initialize')).toHaveLength(1)
        expect(wire.some(event => event.method === 'tools/call')).toBe(false)
        expect(await response.clone().json()).toMatchObject({ error: expect.any(String) })
      }
      for (const compile of mocks.compiles.slice(1)) expect(compile.options.countsPendingUserMessage).toBe(false)
      if (decision === 'allow' && scenario === 'self' && !withA) {
        const successor = mocks.compiles[1]
        expect(successor.content).toBe(''); expect(successor.options.p5McpOwner).toBe(activations[0].preparation)
        const successorPrompt = prompts.find((_prompt, index) => promptSegments[index] === 2)
        expect(successorPrompt).toBeDefined()
        const delivered = successorPrompt.filter((message: any) => message.role === 'user').flatMap((message: any) => message.content)
          .filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')
        expect(delivered.split('<dynamic_info>')).toHaveLength(2)
        const afterHistory = delivered.slice(delivered.lastIndexOf('</conversation>') + '</conversation>'.length)
        expect(afterHistory).toContain('<dynamic_info>'); expect(afterHistory).not.toMatch(/<user(?:\s|>)/)
        for (const judge of Object.values(pauseJudges)) expect(judge).not.toHaveBeenCalled()
      }
      if (scenario === 'self' && decision === 'allow' && !withA) {
        for (const prompt of prompts.slice(1)) {
          expect(JSON.stringify(prompt).split('Images returned by positive-pending-source (controlled positive image)')).toHaveLength(2)
          const images = prompt.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === 'file' && part.mediaType === 'image/png')
          expect(images).toHaveLength(1); expect(images[0].data).toBe(png)
        }
        expect(observedRegistries.at(-1).pending()).toBe(0)
      }
      if (mediaJoin) {
        expect(spend).toHaveBeenCalledOnce()
        expect((await redis.get(clipStateKey) as any).clips[0].messagesUntilUnclip).toBe(2)
        expect(refile.mock.calls.some(([session, from, to]) => session === SESSION && from === REPLY && to === mocks.sdkRequests[1].messageId)).toBe(true)
        expect(JSON.stringify(prompts.slice(1))).toContain('Preserve the source results.')
        for (const prompt of prompts) expect(JSON.stringify(prompt).split('SOURCE02_RETAINED_TEXT_CLIP')).toHaveLength(2)
      } else {
        expect(getClip.mock.calls.filter(([key]) => typeof key === 'string' && key.startsWith('clip:'))).toHaveLength(0)
        expect(spend).not.toHaveBeenCalled()
      }
      if (scenario === 'context-after-C') {
        expect(contextAfterCFailed).toBe(true); expect(useIssued).toBe(true)
        expect(contextAfterCFailedSegment).toBe(2)
        expect(postContextSameSdkProviderCalls).toBe(0)
        expect(postContextProviderSegments).toEqual([3])
        expect(mocks.sdkRequests).toHaveLength(3); expect(mocks.compiles).toHaveLength(3)
        const failedPartId = mocks.sdkRequests[1].messageId
        const failedPart = await stored(failedPartId)
        expect(failedPart?.metadata).toMatchObject({ response_failed: true, failure_kind: 'context_exhausted', usage: null })
        expect(failedPart?.content).toContain('ordinary context recovery.')
        expect(mocks.forwards.filter(event => event.messageId === failedPartId && event.type === 'finish')).toEqual([])
        expect(mocks.forwards.find(event => event.messageId === failedPartId && event.type === 'end')?.metadata?.usage).toBeNull()
        expect(mocks.sdkRequests.every(request => request.mcpOriginalPreparation === activations[0].preparation)).toBe(true)
        expect(mocks.compiles[2].content).toBeUndefined(); expect(mocks.compiles[2].options.countsPendingUserMessage).toBe(false)
        const ordinaryPrompt = prompts.find((_prompt, index) => promptSegments[index] === 3)
        expect(ordinaryPrompt).toBeDefined()
        const ordinaryText = ordinaryPrompt.filter((message: any) => message.role === 'user').flatMap((message: any) => message.content)
          .filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')
        expect(ordinaryText).not.toContain('<dynamic_info>')
        expect(disposition).toHaveBeenCalledOnce(); expect(activations).toHaveLength(1)
        expect(wire.filter(event => event.method === 'tools/call').map(event => event.url)).toEqual([`${sourceBase}1`])
      }
      if (scenario === 'entry-discovery' || stdioEntry) {
        expect(entryStage).toBe(stdioEntry ? 4 : 3); expect(entrySchemasObserved).toBe(true); expect(entryIdentityChecked).toBe(true)
        expect(reportRef).toBe('fabric:sys.app_settings.native.report'); expect(changeRef).toBe('fabric:sys.app_settings.native.change')
        expect(issuedInputs).toHaveLength(1); expect(issuedInputs[0].changes.target.zip).toEqual({ toolName: 'remote_tool', zipThreshold: 0, autoZip: false })
        expect(searchIssued).toBe(true); expect(useIssued).toBe(true); expect(usedRef).toBe('mcp:remote_tool')
        if (!stdioEntry) expect(wire.filter(event => event.method === 'tools/call').map(event => event.url)).toEqual([`${sourceBase}1`])
        const review: any = runtime.settingsOperationRegistry.nativeApprovalPreview(USER, AGENT, SESSION, currentInput.requestId)
        expect(review.preview.resource).toMatchObject({ variant: 'prerequisite', intent: currentInput.changes.target, target: { settingsIdentity: 'remote_tool' } })
      }
      if (scenario === 'collision') {
        expect(neutralResultObserved).toBe(true); expect(searchIssued).toBe(true)
        expect(sharedFind).toHaveBeenCalledTimes(2)
        expect(sharedFind.mock.calls.every(([input]) => input.p5ApiRun === contexts.at(-1).p5ApiRun)).toBe(true)
        const preview: any = runtime.settingsOperationRegistry.nativeApprovalPreview(USER, AGENT, SESSION, issuedInputs[0].requestId)
        expect(preview.preview.resource.target.settingsIdentity).toBe('Controlled_C1_remote_tool')
        const saved = await redis.json.get(`agent:${AGENT}`) as any
        expect(saved.custom_tool_settings).toContainEqual({ tool_name: 'Controlled_C1_remote_tool', zip_threshold: 0, auto_zip: false })
        expect(saved.custom_tool_settings).toContainEqual({ tool_name: 'remote_tool', buffer_size: 8, auto_zip: true, future: { keep: true } })
        expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.map((row: any) => row.id)).toEqual(['saved-B','A',sourceIds[0]])
        expect(usedRef).toBe(`mcp:${preview.preview.resource.target.settingsIdentity}`)
        expect(wire.filter(event => event.method === 'tools/call').map(event => event.url)).toEqual([`${sourceBase}1`])
      }
      if (scenario === 'missing-A-names') {
        expect(modelCalls).toBe(0); expect(issuedInputs).toHaveLength(0)
        expect(networkAttempts.every(event => event.url === originalA.url)).toBe(true)
        expect(wire.some(event => event.url === originalA.url && event.method === 'tools/list')).toBe(true)
        expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.map((row: any) => row.id)).toEqual(['saved-B','A'])
        expect((await redis.json.get(`agent:${AGENT}`) as any).defaultMCPGateways).toEqual(['saved-B'])
        expect(await response.clone().json()).toMatchObject({ error: expect.any(String), details: expect.stringContaining('complete retained ordinary tool identity result') })
      }
      if (neutralDrift) {
        expect(neutralIssued).toBe(true); expect(neutralResultObserved).toBe(true)
        expect(sharedFind).toHaveBeenCalledOnce()
        expect(sharedFind.mock.calls[0][0].p5ApiRun).toBe(contexts.at(-1).p5ApiRun)
        expect(sharedFind.mock.calls[0][0].p5ApiRun).toBeDefined()
        expect(neutralContactsBefore).toBeDefined()
        expect(networkAttempts.filter(event => event.url.startsWith(sourceBase))).toHaveLength(neutralContactsBefore!)
        expect(networkAttempts.some(event => event.url === 'https://changed-at-neutral-find.example/mcp')).toBe(false)
        expect(wire.some(event => event.method === 'tools/call')).toBe(false)
        expect(useIssued).toBe(false)
      }
      if (stdioCase) {
        if (stopTask) await stopTask
        await expect.poll(() => stdioCloses.every(value => value.closed), { timeout: 15000 }).toBe(true)
        const rows = stdioWire(local!.log)
        expect(rows.some(row => row.method === 'effect')).toBe(decision !== 'deny' && !['stdio-source','stdio-key','stdio-file','stdio-late-init','stdio-late-list','stdio-call-Stop','stdio-bind-Stop'].includes(scenario))
        expect(rows.filter(row => row.method === 'tools/call')).toHaveLength(decision === 'deny' || ['stdio-source','stdio-key','stdio-file','stdio-late-init','stdio-late-list','stdio-bind-Stop'].includes(scenario) ? 0 : 1)
        expect(rows.some(row => row.method === 'spawn')).toBe(decision !== 'deny' && scenario !== 'stdio-bind-Stop')
        if (scenario === 'stdio-bind-Stop') {
          expect(boundBeforeStop).toBeDefined(); expect(stdioSetup).not.toHaveBeenCalled(); expect(stdioCloses).toEqual([])
          expect(setupEnvCopies).toHaveLength(1); expect(Object.keys(setupEnvCopies[0])).toEqual([])
          const observed = vi.spyOn(discovery, 'readP5McpClientSettlement')
          await originalTask.refreshP5OriginalRequest(originalTask.p5ApiDiscoveryRequest(contexts[0].p5ApiRun))
          expect(observed.mock.calls.some(([handle]) => handle === boundBeforeStop)).toBe(true)
          expect(discovery.readP5McpClientSettlement(boundBeforeStop!)).toMatchObject({ constructor: 'not_started', requests: 'not_started', initialize: 'not_started', list: 'not_started', execute: 'not_started', close: 'not_started' })
          await expect(stdioOwner.stdioMCPGatewayClient.listForHeldApi(boundBeforeStop!)).rejects.toThrow()
          expect(stdioCloses).toEqual([]); expect((await redis.json.get(`agent:${AGENT}`) as any).defaultMCPGateways).toEqual(['saved-B'])
        } else if (decision !== 'deny') {
          const admission = stdioSetup.mock.calls[0]?.[0]
          expect(admission).toBeDefined()
          const setup = stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement(admission!)
          expect(setup.execute, JSON.stringify(setup)).toBe('not_started'); expect(setup.close, JSON.stringify(setup)).toBe('known')
          await expect(stdioOwner.stdioMCPGatewayClient.executeForHeldApi(admission!)).rejects.toThrow('setup client cannot execute')
          if (stdioEntry) { expect(neutralResultObserved).toBe(true); expect(sharedFind.mock.calls.some(([input]) => input.p5ApiRun === contexts.at(-1).p5ApiRun)).toBe(true) }
          if (scenario === 'stdio-late-init' || scenario === 'stdio-late-list') {
            await expect(stdioSetup.mock.results[0].value).rejects.toEqual(new Error('The held STDIO stage timed out; physical custody is retained.'))
            expect(stdioCloses).toHaveLength(1); expect(useIssued).toBe(false)
            expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.find((row: any) => row.id === savedC!.id).enabled).toBe(true)
            expect((await redis.json.get(`agent:${AGENT}`) as any).defaultMCPGateways).toEqual(['saved-B'])
            await expect(stdioOwner.stdioMCPGatewayClient.listForHeldApi(admission!)).rejects.toThrow()
            expect(stdioCloses).toHaveLength(1)
          } else {
            expect(setup).toMatchObject({ requests: 'known', initialize: 'known', list: 'known' })
            const preview: any = runtime.settingsOperationRegistry.nativeApprovalPreview(USER, AGENT, SESSION, currentInput.requestId)
            expect(preview.preview.resource).toMatchObject({ sourceAction: scenario === 'stdio-enabled' ? 'unchanged' : 'save', before: { enabled: scenario === 'stdio-enabled' }, after: { enabled: true, type: 'stdio' } })
          }
          if (scenario === 'stdio-source' || scenario === 'stdio-key' || scenario === 'stdio-file') expect(stdioCloses).toHaveLength(1)
        } else { expect(stdioSetup).not.toHaveBeenCalled(); expect(stdioCloses).toEqual([]) }
        expect(networkAttempts.every(event => event.url === originalA.url)).toBe(true)
      }
      if (mixed) {
        if (scenario === 'mixed-initial-close-pending') {
          expect(sourceWrites).not.toHaveBeenCalled(); expect(activations).toEqual([]); expect(releaseInitialClose).toBeDefined()
          expect(initialObservations.some(admission => discovery.readP5McpClientSettlement(admission).close === 'pending')).toBe(true)
          releaseInitialClose!()
          await expect.poll(() => initialObservations.filter(admission => discovery.readP5McpClientSettlement(admission).constructor === 'started')
            .every(admission => discovery.readP5McpClientSettlement(admission).close === 'known')).toBe(true)
        }
        await expect.poll(() => stdioCloses.every(value => value.closed), { timeout: 15000 }).toBe(true)
        const rows = stdioWire(originalLocal!.log), facts = initialObservations.map(admission => discovery.readP5McpClientSettlement(admission))
        expect(facts.length).toBeGreaterThan(0)
        expect(networkAttempts.every(event => event.url.startsWith(sourceBase))).toBe(true)
        if (mixedRefusal || mixedRemoval) {
          expect(sourceWrites).not.toHaveBeenCalled(); expect(wire).toEqual([]); expect(useIssued).toBe(false)
          if (mixedRemoval && !removedUnknown) expect(activations.map(value => value.scope)).toEqual([[]]) // ordinary empty continuation grants no positive MCP authority
          else expect(activations).toEqual([])
          expect(modelCalls).toBeGreaterThan(0) // ordinary initial capture/producer mismatch did not newly reject association
          if (scenario === 'mixed-legacy-trim' || scenario === 'mixed-legacy-proto' || removedMismatch) {
            expect(matchOriginal).toHaveBeenCalled()
            await expect(matchOriginal.mock.results[0].value).rejects.toThrow('differs from its frozen original')
          }
          expect(rows.some(row => row.method === 'effect')).toBe(false)
          if (scenario === 'mixed-issued-Stop') {
            expect(raceDiscoveryStarted).toBe(true); expect(raceAtCapture?.constructor).toBe('started')
            expect(raceAtCapture?.initialize, JSON.stringify(raceAtCapture)).toBe('pending')
            expect(raceAtCapture?.list).toBe('not_started'); expect(raceAtCapture?.execute).toBe('not_started')
            expect(rows.filter(row => row.method === 'spawn')).toHaveLength(2) // complete first naming + actual second pending initialize
            expect(rows.filter(row => row.method === 'initialize')).toHaveLength(2)
            expect(rows.filter(row => row.method === 'tools/call')).toHaveLength(0)
            const phase = stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement(raceAdmission!)
            expect(phase.initialize === 'pending' || phase.initialize === 'unknown' || phase.list === 'pending' || phase.list === 'unknown', JSON.stringify(phase)).toBe(true)
            expect((await raceDiscovery!).success).toBe(false)
            const observed = vi.spyOn(discovery, 'readP5McpClientSettlement')
            try {
              await originalTask.refreshP5OriginalRequest(originalTask.p5ApiDiscoveryRequest(contexts[0].p5ApiRun))
              expect(observed.mock.calls.some(([handle]) => handle === raceAdmission)).toBe(true) // SAME issued observation was adopted
            } finally { observed.mockRestore() }
            const before = stdioCloses.length
            expect(() => originalTask.readP5ApiMcpAuthority(contexts[0].p5ApiRun, 'A')).toThrow()
            expect(stdioCloses).toHaveLength(before) // stopped original cannot reissue; same actual obligations remain
          } else expect(rows.some(row => row.method === 'tools/call')).toBe(false)
          if (mixedRemoval) {
            expect(targetWrites).toHaveBeenCalledOnce()
            if (removedMismatch) expect(actionsIssued).toBe(1) // duplicate exact request consumed without a second management/effect
            if (removedUnknown) expect(facts.some(fact => fact.constructor === 'started' && fact.close === 'unknown')).toBe(true)
            else expect(facts.filter(fact => fact.constructor === 'started').every(fact => fact.close === 'known')).toBe(true)
            expect((await redis.json.get(`agent:${AGENT}`) as any).defaultMCPGateways).toEqual(['saved-B'])
            expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.find((row: any) => row.id === 'A')).toEqual(originalA)
          }
        } else {
          expect(originalAUsed).toBe(true); expect(searchIssued).toBe(true); expect(useIssued).toBe(true)
          expect(wire.filter(event => event.method === 'tools/call').map(event => event.url)).toEqual([`${sourceBase}1`])
          expect(rows.filter(row => row.method === 'tools/call')).toHaveLength(scenario === 'mixed-startup-latency' ? 2 : 1); expect(rows.filter(row => row.method === 'effect')).toHaveLength(scenario === 'mixed-startup-latency' ? 2 : 1)
          expect(activations[0].scope).toEqual(['A', sourceIds[0]].sort())
          expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.find((row: any) => row.id === 'A')).toEqual(originalA)
          const saved = await redis.json.get(`agent:${AGENT}`) as any
          expect(saved.defaultMCPGateways).toEqual(['saved-B', sourceIds[0]]) // preserve saved defaults as data; they never enter the original A+C authority
          expect(saved.custom_tool_settings).toContainEqual({ tool_name: mixedCollision ? 'Controlled_C1_remote_tool' : 'remote_tool', zip_threshold: 0, auto_zip: false })
          if (mixedCollision) expect(saved.custom_tool_settings).toContainEqual({ tool_name: 'remote_tool', buffer_size: 8, auto_zip: true, future: { keep: true } })
          expect(facts.filter(fact => fact.constructor === 'started').every(fact => fact.close === 'known' && fact.initialize === 'known' && fact.list === 'known')).toBe(true)
          if (scenario === 'mixed-warm-cache') expect(facts.every(fact => fact.constructor === 'not_started' && fact.close === 'not_started')).toBe(true)
          if (scenario === 'mixed-startup-latency') {
            expect(originalA.stdioConfig.startupTimeoutMs).toBe(1000); expect(ordinaryTimingStage).toBe(3)
            expect(delayedComparisons).toBeGreaterThanOrEqual(3); expect(comparisonsAfterSdkHandoff).toBe(0)
            expect(facts.some(fact => fact.execute === 'known')).toBe(true) // real ordinary use before management, not just fresh held use
          }
          if (mixedCapacity) {
            expect(aKeyNames).toHaveLength(12); expect(replayIssued).toBe(true); expect(sourceWrites).toHaveBeenCalledOnce(); expect(targetWrites).toHaveBeenCalledOnce()
            const expected = [...aKeyNames.map(name => apiKeyService.storedKeyName(name, USER)), apiKeyService.storedKeyName(keyName, USER), `mcp_gateways:${USER}`, `agent:${AGENT}`, `user:${USER}:settings`].sort()
            expect(expected).toHaveLength(16)
            expect(actualFrames.filter(frame => frame.kind === 'source').map(frame => frame.result)).toEqual(['OK'])
            expect(actualFrames.filter(frame => frame.kind === 'target').map(frame => frame.result)).toEqual(['SAVED'])
            for (const frame of actualFrames) {
              expect(frame.keys).toEqual([...new Set(frame.keys)]); expect(frame.keys.length).toBeLessThanOrEqual(16)
              expect(frame.paths.every(paths => paths.length <= 64 && paths.length === new Set(paths).size)).toBe(true)
              if (frame.kind === 'source' || frame.kind === 'target') expect([...frame.keys].sort()).toEqual(expected)
              if (frame.kind === 'source') expect(frame.actualKeys[0]).toBe(`mcp_gateways:${USER}`)
              if (frame.kind === 'target') { expect(frame.actualKeys[0]).toBe(`agent:${AGENT}`); expect(frame.actualKeys.at(-1)).toBe(`mcp_gateways:${USER}`) }
            }
          }
          if (scenario === 'mixed-B-row-shift') {
            expect(bRowShifted).toBe(true); expect(originalARawBeforeShift).toEqual(expect.any(String))
            expect(await redis.json.getRaw(`mcp_gateways:${USER}`, '$.gateways[?(@.id=="A")]')).toBe(originalARawBeforeShift)
            expect(actualFrames.some(frame => frame.afterBShift && frame.result === 'OK' && frame.paths.flat().includes('$.gateways[?(@.id=="A")]'))).toBe(true)
            expect((await redis.json.get(`mcp_gateways:${USER}`) as any).gateways.map((row: any) => row.id)).toEqual(['A','saved-B',sourceIds[0]])
            expect(targetWrites).toHaveBeenCalledOnce(); expect(sourceWrites).toHaveBeenCalledOnce()
          }

          if (scenario === 'mixed-sealed-resolver') {
            expect(raceDiscoveryStarted).toBe(true); expect(raceResolverHeld).toBe(true)
            expect((await raceDiscovery!).success).toBe(false)
            expect(stdioOwner.stdioMCPGatewayClient.readHeldApiSettlement(raceAdmission!)).toEqual({ constructor: 'not_started', requests: 'not_started', initialize: 'not_started', list: 'not_started', execute: 'not_started', close: 'not_started' })
            expect(rows.filter(row => row.method === 'spawn')).toHaveLength(2) // complete first naming + genuine fresh A use; second resolver never constructed
          }
        }
      }
      // All known source/target facts came from actual Lua, actual SDK consume/
      // finish and the route's canonical writer, never a test-issued positive cap.
      if (scenario === 'missing-A-names' || decision === 'deny' || scenario === 'stdio-bind-Stop' || scenario === 'mixed-issued-Stop') expect(disposition).not.toHaveBeenCalled()
      else expect(disposition).toHaveBeenCalled()
    } finally {
      if (stopTask) await stopTask
      releaseOrdinary?.(); releaseInitialClose?.()
      try {
        if (raceDiscovery) await raceDiscovery
        if (mixedRace) await expect.poll(() => stdioCloses.every(value => value.closed), { timeout: 15000 }).toBe(true)
      } finally {
        if (mixedCapacity) for (const name of aKeyNames) await redis.del(apiKeyService.storedKeyName(name, USER))
        for (const key of [`agent:${otherId}`, `api_keys:${USER}:${keyName}`, `mcp_gateways:${USER}`, `user:${USER}:settings`, `clip:${USER}:${clipId}`, clipStateKey]) await redis.del(key)
        mocks.realCompiler = false; mocks.realTools = false; mocks.onEnd = null
      }
    }
  }, 120_000)

  it('keeps the actual ordinary partial context failure and canonical ACK before exactly one SDK successor under the same original empty scope', async () => {
    const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test')
    const contextFailure = Object.assign(new Error("This model's maximum context length is 131072 tokens."), { code: 'context_length_exceeded' })
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }
    let calls = 0
    mocks.sdkModel = new MockLanguageModelV3({ provider: 'fixture', modelId: 'claude-sonnet-5', doStream: async () => {
      calls++
      if (calls === 2) {
        const prior = await stored(REPLY)
        expect(prior?.metadata?.response_failed).toBe(true)
        expect(prior?.content).toContain('Actual PARTial')
        const nextRequest = mocks.sdkRequests[1]
        expect(originalTask.p5ApiPreparedScope(nextRequest.mcpOriginalPreparation)?.gateways).toEqual([])
      }
      return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>(calls === 1 ? [
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'ordinary-context' },
        { type: 'text-delta', id: 'ordinary-context', delta: 'Actual partial work.' },
        { type: 'text-end', id: 'ordinary-context' }, { type: 'error', error: contextFailure },
        { type: 'finish', finishReason: { unified: 'error', raw: 'context_length_exceeded' }, usage }
      ] : [
        { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'ordinary-next' },
        { type: 'text-delta', id: 'ordinary-next', delta: 'The ordinary bounded successor finished.' },
        { type: 'text-end', id: 'ordinary-next' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
      ]) }
    } })
    const custodyFailure = vi.spyOn(originalTask, 'failP5CanonicalCustody')
    const result = await send(undefined, [
      { id: 'earlier-user', role: 'user', content: 'Keep the earlier conversation in this reply.' },
      { id: 'earlier-assistant', role: 'assistant', content: 'The earlier response remains in history.' },
      { id: 'msg-user-1', role: 'user', content: 'Say two parts.' }
    ])
    expect(result.status).toBe(200); expect(calls).toBe(2)
    expect(mocks.sdkRequests).toHaveLength(2)
    expect(mocks.sdkRequests[1].mcpOriginalPreparation).toBe(mocks.sdkRequests[0].mcpOriginalPreparation)
    expect(custodyFailure).not.toHaveBeenCalled()
    // Real SDK+route/canonical owners, synthetic model/storage/SSE only; no vendor call.
  }, 30_000)

  it('passes the actual bound acquisition-failure part to the real canonical save before outward error', async () => {
    mocks.plan = 'acquire-fail'
    const begin = vi.spyOn(originalTask, 'beginP5CanonicalWrite')
    const failure = vi.spyOn(originalTask, 'failP5CanonicalCustody')
    const result = await send()
    mocks.httpResponseReturned = true
    expect(result.status).toBeGreaterThanOrEqual(400)
    const failed = begin.mock.calls.filter(([preparation, message]) => preparation && message.id === REPLY)
    expect(failed.length).toBeGreaterThan(0)
    const [preparation, , part] = failed[0]
    expect(part).toBeDefined()
    expect(failed.every(([, , observed]) => observed === part)).toBe(true)
    expect(originalTask.p5CanonicalReplySealed(preparation, REPLY, part)).toBe(true)
    const notices = mocks.failedNotices.filter(notice => notice.event.sessionId === SESSION)
    expect(notices.length).toBeGreaterThan(0)
    for (const notice of notices) {
      expect(notice.record).toMatchObject({ id: REPLY, session_id: SESSION, status: 'error', metadata: { response_failed: true } })
      expect(notice.beforeHttpResponse).toBe(true)
    }
    expect(failure).not.toHaveBeenCalled()
  }, 30_000)

  it('saves the recorded text, before `end`, with the fields a tab used to write', async () => {
    const response = await send()
    expect(response.status, await response.clone().text()).toBe(200)

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

  it('keeps a known canonical save and one end when P5 bookkeeping refuses (BL-1891)', async () => {
    vi.spyOn(originalTask, 'beginP5CanonicalWrite').mockImplementation(() => { throw new Error('P5 custody refused') })
    const receipt = vi.spyOn(originalTask, 'observeP5CanonicalReceipt')
    expect((await send()).status).toBe(200)
    expect((await stored(REPLY))?.content).toBe('The first PART. The second PART.')
    expect(mocks.storedAtEnd?.status).toBe('complete')
    expect(replySaves(REPLY)).toBe(1)
    expect(forwardsOf('end')).toHaveLength(1)
    expect(forwardsOf('error')).toHaveLength(0)
    expect(receipt).not.toHaveBeenCalled()
  }, 30_000)

  it('preserves the saved provider failure and existing enrichment when P5 bookkeeping refuses (BL-1891)', async () => {
    const begin = vi.spyOn(originalTask, 'beginP5CanonicalWrite').mockImplementation(() => { throw new Error('P5 custody refused') })
    const receipt = vi.spyOn(originalTask, 'observeP5CanonicalReceipt')
    mocks.plan = 'fail-first'
    await send()
    const saved = await stored(REPLY)
    expect(saved).toMatchObject({ id: REPLY, session_id: SESSION, status: 'error', content: 'Provider exploded before a word.',
      metadata: { response_failed: true, error_message: 'Provider exploded before a word.', http_status: 500, agentType: 'api' } })
    expect(mocks.storedAtError).toMatchObject({ id: REPLY, session_id: SESSION, status: 'error', content: saved.content,
      metadata: { response_failed: true, error_message: saved.metadata.error_message } })
    // The existing inner error save precedes its event; the POST may enrich the
    // SAME stored record. Each canonical writer invocation still MUST save.
    expect(begin).toHaveBeenCalled()
    expect(replySaves(REPLY)).toBe(begin.mock.calls.length)
    const messageIds = await redis.execute(client => client.lRange(`messages:${SESSION}`, 0, -1))
    expect(messageIds.filter(id => id === REPLY)).toHaveLength(1)
    expect(forwardsOf('error')).toHaveLength(1)
    expect(forwardsOf('end')).toHaveLength(0)
    expect(receipt).not.toHaveBeenCalled()
    // This default lane proves handler identity/order/list behavior. Actual
    // metadata merge and first-date preservation belong to the real-only owner.
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

  it('SA-133 captures, streams and saves exposed API reasoning with Display off', async () => {
    await redis.json.set(`agent:${AGENT}`, '$.show_reasoning', false as never)
    await redis.json.set(`agent:${AGENT}`, '$.api_reasoning_retention', 'preserve' as never)
    mocks.reasoning = 'A provider-supplied useful conclusion.'
    expect((await send()).status).toBe(200)
    const saved = await stored(REPLY)
    expect(saved.metadata.reasoningSummary).toBe(mocks.reasoning)
    expect(saved.metadata.whiteboardContextSnapshot).toBeNull()
    expect(mocks.forwards.some((event) => event.type === 'thinking' && event.content === mocks.reasoning)).toBe(true)
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
      whiteboardContextSnapshot: { schema_version: 1, userId: USER, sessionId: SESSION, agentId: AGENT, messageId: CARD,
        settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
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
    expect(saved.metadata.whiteboardContextSnapshot).toBeNull()
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
      whiteboardContextSnapshot: { schema_version: 1, userId: USER, sessionId: SESSION, agentId: AGENT, messageId: CARD,
        settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
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
      // BL-871 (d): during the stall `complete` goes through the terminal tail, sent once `end` is
      // answered; the request does not wait for it.
      await vi.waitFor(() => expect(forwardsOf('complete')).toHaveLength(1))
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
      // BL-871 (d): the terminal tail sends `complete` once `end` is answered.
      await vi.waitFor(() => expect(forwardsOf('complete')).toHaveLength(1))
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

  describe('SA-139: a Claude plan reply at its limits (Faye\'s P3 Part 1 read, the real handler)', () => {
    const FAKE = join(process.cwd(), 'src/lib/server/services/__tests__/fixtures/claude-plan/fake-claude.mjs')
    async function onClaudePlan(scenario: Record<string, unknown>) {
      const { MockLanguageModelV3 } = await import('ai/test')
      const { normaliseClaudePlanPreset } = await import('$lib/server/services/claudePlanPreset')
      const { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE } = await import('$lib/utils/claudePlanConnection')
      claudePlanFixture.folder = mkdtempSync(join(tmpdir(), 'sa139-handler-'))
      writeFileSync(join(claudePlanFixture.folder, 'scenario.json'), JSON.stringify(scenario))
      vi.stubEnv('BATSHIT_CLAUDE_CLI_PATH', FAKE)
      await redis.set(`model:${PRESET}`, normaliseClaudePlanPreset({ ...model, modelId: 'claude-haiku-5-5',
        connection: { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE } } as any))
      // The real brain runs; ProviderManager is never reached on this connection.
      mocks.sdkModel = new MockLanguageModelV3({ provider: 'fixture', modelId: 'never', doStream: async () => { throw new Error('ProviderManager was reached') } })
    }
    const fakeLog = () => {
      const file = join(claudePlanFixture.folder, 'fake-log.jsonl')
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    }
    afterEach(async () => {
      const registry = await import('$lib/server/services/claudePlanRunRegistry')
      await registry.endClaudePlanRuns({}, 'test over')
      registry.resetClaudePlanRunRegistryForTests()
      vi.unstubAllEnvs()
      if (claudePlanFixture.folder) rmSync(claudePlanFixture.folder, { recursive: true, force: true })
      claudePlanFixture.folder = ''
    })

    /** A saved approval card, its reply's connection named as `send-routed` names it. */
    async function savedCard(claudePlanReply: boolean) {
      const userMessage = { id: 'msg-user-1', session_id: SESSION, user_id: USER, role: 'user', content: 'List the folder.', created_at: '2026-09-28T01:00:00.000Z', metadata: {} }
      const cardMetadata = {
        model: claudePlanReply ? 'claude-haiku-5-5' : 'claude-sonnet-5', agentType: 'api', usage: PAUSE_USAGE,
        ...(claudePlanReply ? { claudePlanReply: true } : {}),
        providerMessages: [{ role: 'assistant', content: [
          { type: 'tool-call', toolCallId: 'call_ls', toolName: 'native_bash_execute', input: { command: 'ls' } },
          { type: 'tool-approval-request', approvalId: APPROVAL, toolCallId: 'call_ls' }
        ] }],
        providerMessageSource: { providerId: 'anthropic', connectionId: claudePlanReply ? 'claude-plan:local' : null, modelId: claudePlanReply ? 'claude-haiku-5-5' : 'claude-sonnet-5' },
        toolApprovals: { mode: 'all', approvals: [{ approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', input: { command: 'ls' } }], source: 'vercel' }
      }
      // Raised a moment ago, so its own three-minute clock has not expired it.
      const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', status: 'complete', content: 'Asking first.', created_at: new Date().toISOString(), metadata: cardMetadata }
      await redis.saveMessage(userMessage as any)
      await redis.saveMessage(card as any)
      return POST({
        request: new Request('http://localhost/api/messages/send-routed', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', content: '', messageId: CARD, messages: [userMessage, card],
            metadata: { ...cardMetadata, toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }] } }) }),
        fetch: sseForward, locals: { user: { id: USER } }
      } as any)
    }

    it('review A M1: a Claude plan card clicked after the agent moved to another connection runs nothing, says why, and ends the held run', async () => {
      const registry = await import('$lib/server/services/claudePlanRunRegistry')
      const run = { isEnded: false, owner: { userId: USER, sessionId: SESSION, agentId: AGENT }, stopped: [] as unknown[], settled: Promise.resolve('exited'),
        stop(error: unknown) { this.stopped.push(error); this.isEnded = true } }
      registry.holdClaudePlanRun(run as any, { sessionId: SESSION, replyId: CARD, version: '0' }, Date.now() + 60_000, {} as any, ['call_ls'])
      // The agent is on the fixture's ordinary Anthropic preset now.
      const response = await savedCard(true)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ success: true, approvalResume: 'denied', reason: 'claude_plan_switched_away' })
      const saved = await stored(CARD)
      expect(saved.metadata.answeredApprovalIds).toContain(APPROVAL)
      expect(saved.metadata.toolApprovals.approvals[0]).toMatchObject({ approvalId: APPROVAL, status: 'expired', expiryReason: 'run_ended' })
      await vi.waitFor(() => expect(run.stopped).toHaveLength(1))
      expect(registry.isClaudePlanRunHeld({ sessionId: SESSION, replyId: CARD, version: '0' })).toBe(false)
      // Nothing ran: no model was asked, and no reply started.
      expect(mocks.sdkRequests).toHaveLength(0)
      expect(forwardsOf('start')).toHaveLength(0)
    }, 30_000)

    it('Faye S1: an API reply\'s card clicked after the agent moved onto the Claude plan runs nothing and says why', async () => {
      await onClaudePlan({})
      const response = await savedCard(false)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ success: true, approvalResume: 'denied', reason: 'claude_plan_other_connection' })
      const saved = await stored(CARD)
      expect(saved.metadata.answeredApprovalIds).toContain(APPROVAL)
      expect(saved.metadata.toolApprovals.approvals[0]).toMatchObject({ approvalId: APPROVAL, status: 'expired', expiryReason: 'run_ended' })
      expect(mocks.sdkRequests).toHaveLength(0)
      expect(forwardsOf('start')).toHaveLength(0)
      // No Claude Code process was started for it.
      expect(fakeLog().filter(entry => entry.kind === 'start')).toHaveLength(0)
    }, 30_000)

    it('BL-2368 through the real handler: a misnamed call runs nothing, the saved reply keeps it as a failed call, and the same reply goes on', async () => {
      await onClaudePlan({ turns: [
        { blocks: [{ type: 'tool_use', id: 'toolu_misnamed', name: 'batshit__batshit__save_note', input: { title: 'Step' } }] },
        { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Step' } }] },
        { blocks: [{ type: 'text', text: 'Saved it.' }] }
      ] })
      const { tool, jsonSchema } = await import('ai')
      const saved: string[] = []
      mocks.sdkTools = async () => ({
        tools: { save_note: tool({ description: 'Save a note.', inputSchema: jsonSchema<{ title: string }>({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }),
          execute: async ({ title }) => { saved.push(title); return `saved ${title}` } }) },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: []
      })
      expect((await send()).status).toBe(200)
      const reply = await stored(REPLY)
      expect(reply.status).not.toBe('error')
      expect(reply.content).toContain('Saved it.')
      // Only the listed call ran, once.
      expect(saved).toEqual(['Step'])
      // Rule 3 (BL-775): what streamed is what is saved: the misnamed call stays in the record as a failed call.
      const steps = [].concat(...(reply.intermediateSteps ?? []).map((step: any) => [].concat(step))) as any[]
      const misnamed = steps.find(step => step.toolCallId === 'toolu_misnamed')
      expect(misnamed).toMatchObject({ toolName: 'batshit__batshit__save_note', toolResult: { success: false, error: expect.stringMatching(/unavailable tool 'batshit__batshit__save_note'/) } })
      expect(reply.content).toMatch(/batshit__batshit__save_note - error/)
      // BL-775: the stream carried that same failed result, and `end` published what was saved.
      expect(forwardsOf('tool-result').find((event: any) => event.toolCallId === 'toolu_misnamed')?.result).toEqual(misnamed.toolResult)
      expect(forwardsOf('end')[0].intermediateSteps.find((step: any) => step.toolCallId === 'toolu_misnamed')?.toolResult).toEqual(misnamed.toolResult)
      expect(steps.some(step => step.toolName === 'save_note')).toBe(true)
      // One Claude Code process for the whole reply, three model calls.
      expect(fakeLog().filter(entry => entry.kind === 'start')).toHaveLength(1)
      expect(fakeLog().filter(entry => entry.kind === 'model-call')).toHaveLength(3)
    }, 30_000)

    /** A Claude plan reply that stops at an approval card for `save_note`, its run held; returns the card and the click. */
    async function heldAtCard(after: string) {
      await onClaudePlan({ turns: [
        { blocks: [{ type: 'text', text: 'Asking first. ' }, { type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Step' } }] },
        { blocks: [{ type: 'text', text: after }] }
      ] })
      const { tool, jsonSchema } = await import('ai')
      const saved: string[] = []
      mocks.sdkTools = async () => ({
        tools: { save_note: tool({ description: 'Save a note.', inputSchema: jsonSchema<{ title: string }>({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }),
          execute: async ({ title }) => { saved.push(title); return `saved ${title}` } }) },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: { save_note: 'user-approval' }, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: []
      })
      expect((await send()).status).toBe(200)
      const card = await stored(REPLY)
      const approvalId = card.metadata.toolApprovals.approvals[0].approvalId
      const click = () => {
        const userMessage = { id: 'msg-user-1', session_id: SESSION, user_id: USER, role: 'user', content: 'Say two parts.', created_at: new Date().toISOString(), metadata: {} }
        return POST({
          request: new Request('http://localhost/api/messages/send-routed', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', content: '', messageId: REPLY, messages: [userMessage, card],
              metadata: { ...card.metadata, toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId, approved: true, reason: 'User approved' }] } }) }),
          fetch: sseForward, locals: { user: { id: USER } }
        } as any)
      }
      return { card, approvalId, saved, click }
    }

    it('Part 3 through the real handler: a Claude plan reply stops at its card with its run held, and Approve runs the call in that same run and finishes the reply', async () => {
      const { card, saved, click } = await heldAtCard('Done.')
      const registry = await import('$lib/server/services/claudePlanRunRegistry')
      const key = { sessionId: SESSION, replyId: REPLY, version: '0' }
      expect(registry.isClaudePlanRunHeld(key)).toBe(true)
      expect(card.metadata.claudePlanReply).toBe(true)
      expect(saved).toEqual([])
      const response = await click()
      expect(response.status).toBe(200)
      expect(saved).toEqual(['Step'])
      // Review B delta nit: the click's segment told its tools it resumes the held run; the first reply did not.
      expect(mocks.sdkRequests).toHaveLength(2)
      expect(mocks.sdkRequests[0].claudePlanResumesHeldRun).toBeFalsy()
      expect(mocks.sdkRequests[1].claudePlanResumesHeldRun).toBe(true)
      // One Claude Code process for the whole reply: the click continued it.
      expect(fakeLog().filter(entry => entry.kind === 'start')).toHaveLength(1)
      expect(fakeLog().filter(entry => entry.kind === 'model-call')).toHaveLength(2)
      const after = await stored(REPLY)
      expect(after.content).toContain('Asking first.')
      expect(after.content).toContain('Done.')
      expect(after.metadata.response_failed).not.toBe(true)
      expect(registry.isClaudePlanRunHeld(key)).toBe(false)
      await vi.waitFor(() => expect(registry.listClaudePlanRuns()).toHaveLength(0), { timeout: 5000 })
    }, 60_000)

    it('Faye S2: a reply held at its card on Claude Code, then a changed effort: the click runs nothing, the card reads the reply ended, and the run ends', async () => {
      // This lane's store replaces a saved record; real Redis merges a server save's metadata onto it and keeps
      // answered approvals (`redis.saveMessage`). Saved here by that same rule, so the card is what Redis keeps.
      const { keepAnsweredApprovals } = await import('$lib/server/services/toolApprovalState')
      const laneSave = (redis.saveMessage as any).getMockImplementation()
      vi.spyOn(redis, 'saveMessage').mockImplementation(async (message: any, options?: any) => {
        const existing = message?.id && message?.session_id ? await stored(message.id) : null
        const merged = existing?.metadata && !options?.browserMutation
          ? { ...message, metadata: keepAnsweredApprovals(existing.metadata, { ...existing.metadata, ...(message.metadata ?? {}) }) } : message
        return laneSave(merged, options)
      })
      const { card, saved, click: clickNow } = await heldAtCard('never')
      const registry = await import('$lib/server/services/claudePlanRunRegistry')
      const key = { sessionId: SESSION, replyId: REPLY, version: '0' }
      expect(registry.isClaudePlanRunHeld(key)).toBe(true)
      expect(card.metadata.claudePlanReply).toBe(true)
      // The agent's preset changes its effort while the card waits.
      const { normaliseClaudePlanPreset } = await import('$lib/server/services/claudePlanPreset')
      const { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE } = await import('$lib/utils/claudePlanConnection')
      await redis.set(`model:${PRESET}`, normaliseClaudePlanPreset({ ...model, modelId: 'claude-haiku-5-5', settings: { anthropicEffort: 'high' },
        connection: { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE } } as any))
      const click = await clickNow()
      expect(click.status).not.toBe(200)
      expect(JSON.stringify(await click.json())).toContain('changed while the approval card waited')
      // Nothing ran, and Claude Code made no second model call.
      expect(saved).toEqual([])
      expect(fakeLog().filter(entry => entry.kind === 'model-call')).toHaveLength(1)
      // The failed record keeps the card (the save merges), and its entry reads "Expired: the reply ended", never
      // Approved; the reply says why nothing ran, its words before the card kept.
      const after = await stored(REPLY)
      expect(after.metadata).toMatchObject({ response_failed: true, error_code: 'resume_changed' })
      expect(after.metadata.error_message).toContain('changed while the approval card waited')
      expect(after.metadata.toolApprovals.approvals[0]).toMatchObject({ status: 'expired', expiryReason: 'run_ended' })
      expect(after.content).toContain('Asking first.')
      expect(registry.isClaudePlanRunHeld(key)).toBe(false)
      await vi.waitFor(() => expect(registry.listClaudePlanRuns()).toHaveLength(0), { timeout: 5000 })
    }, 60_000)

    it('a reply cut at Claude\'s output limit is saved as output_limit, with no retry, and its run ends', async () => {
      await onClaudePlan({ turns: [{ stop_reason: 'max_tokens', blocks: [{ type: 'text', text: 'Cut off here' }] }] })
      const result = await send()
      expect(result.status).toBe(200)
      const { OUTPUT_LIMIT_ERROR_CODE, OUTPUT_LIMIT_FAILURE_KIND } = await import('$lib/server/services/outputLimitStop')
      const record = await stored(REPLY)
      expect(record?.content).toContain('Cut off here')
      expect(record?.metadata).toMatchObject({ response_failed: true, failure_kind: OUTPUT_LIMIT_FAILURE_KIND, error_code: OUTPUT_LIMIT_ERROR_CODE, claudePlanReply: true })
      // No retry and no continuation: one request, one Claude Code process, one model call.
      expect(mocks.sdkRequests).toHaveLength(1)
      expect(fakeLog().filter(entry => entry.kind === 'start')).toHaveLength(1)
      expect(fakeLog().filter(entry => entry.kind === 'model-call')).toHaveLength(1)
      const { listClaudePlanRuns } = await import('$lib/server/services/claudePlanRunRegistry')
      await vi.waitFor(() => expect(listClaudePlanRuns()).toHaveLength(0), { timeout: 5000 })
    }, 30_000)

    it('a reply out of Claude\'s context after saved work continues with a fresh model and a fresh Claude Code run, at most three times', async () => {
      // As on the API lane, a reply continues only from saved work: each run takes one tool step, then its
      // next model call finds Claude's context full. (A first call that fails with nothing saved is not continued.)
      await onClaudePlan({ turns: [
        { blocks: [{ type: 'text', text: 'Working on it. ' }, { type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Step' } }] },
        { apiError: { text: 'Prompt is too long: 210000 tokens > 200000 maximum', status: 400 } }
      ] })
      const { tool, jsonSchema } = await import('ai')
      const saved: string[] = []
      mocks.sdkTools = async () => ({
        tools: { save_note: tool({ description: 'Save a note.', inputSchema: jsonSchema<{ title: string }>({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }),
          execute: async ({ title }) => { saved.push(title); return `saved ${title}` } }) },
        maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() }, toolApprovals: {}, ephemeralImages: null, initialImageToolIds: [], imageDeferrals: []
      })
      const result = await send()
      expect(saved).toEqual(['Step', 'Step', 'Step', 'Step'])
      // The reply and its three continuations: four requests, each under its own reply id.
      expect(mocks.sdkRequests).toHaveLength(4)
      expect(new Set(mocks.sdkRequests.map(request => request.messageId)).size).toBe(4)
      expect(mocks.sdkRequests.slice(1).every(request => !request.claudePlanHeld)).toBe(true)
      // Each one started its own Claude Code process: four runs, four processes.
      const starts = fakeLog().filter(entry => entry.kind === 'start')
      expect(starts).toHaveLength(4)
      expect(new Set(starts.map(entry => entry.pid)).size).toBe(4)
      const { listClaudePlanRuns } = await import('$lib/server/services/claudePlanRunRegistry')
      await vi.waitFor(() => expect(listClaudePlanRuns()).toHaveLength(0), { timeout: 5000 })
    }, 60_000)
  })

})
