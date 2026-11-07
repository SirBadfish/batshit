// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin } from '$lib/test-utils/skillSessionCommitTwin'
useSkillSessionCommitTwin()
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { abortStream, __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { createPendingApproval } from '$lib/server/services/controlApprovals'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { loadPostTurnRecord, writePostTurnRecord } from '$lib/server/services/postTurnCheckState'
import { initializedBuiltinPluginEntries } from '$lib/test-utils/initialized-builtin-plugin'
import { openSkillSessionRead, readOpenSkillSessions } from '$lib/server/services/skillSessions'
import { __resetReplyRecordsForTests, isLateReplyEvent, recordReplyEvent, startReplyRecord, REPLY_SAVED_FROM_OWN_COPY_KEY } from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { replyProseForJudgment } from '$lib/server/services/typesafe/jevJuiceTurn'
import { resolveHeldMessageReceipt } from '$lib/utils/heldForApproval'

const isolatedHome = vi.hoisted(() => ({ directory: '', previous: process.env.BATSHIT_HOME_DIR }))
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>()
  const nodePath = await import('node:path')
  isolatedHome.directory = nodePath.join(actual.tmpdir(), `batshit-skill-handler-home-${process.pid}-${Date.now()}`)
  process.env.BATSHIT_HOME_DIR = nodePath.join(isolatedHome.directory, '.batshit')
  const homedir = () => isolatedHome.directory
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('$lib/server/services/systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))
// These unrelated owners have real socket/raw-client boundaries outside this fake-lane
// dispatcher proof. Memory is OFF in every fixture; monitoring mirrors the SSE suite's no-op.

vi.mock('$lib/server/services/memory/memoryRecall', async (original) => ({
  ...await original<Record<string, unknown>>(),
  commitMemoryTurnState: vi.fn(async () => ({ committed: false, insertedNewIds: [], refreshedIds: [], heldIds: [], items: [] }))
}))

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
 * network and no key), the unrelated memory-OFF commit, and socket monitoring. The inferred zip-state writers are spies (their own suite proves them on
 * real Redis). Everything between is the handler's own code on the Redis fake: the pause, the
 * card, the click, the resume as a second finalize of the same message, the continuation loop,
 * the after-reply site, the post-turn record, and the Execution Viewer rows.
 */

const USER = 'user-bl527'
const AGENT = 'agent-bl527'
const PRESET = 'preset-bl527'
const CARD = 'msg-card'
const REQUEST = 'List the folder.'

type ModelRun = 'reply' | 'card' | 'exhausted' | 'length' | 'failed' | 'stopped' | 'mixed' | 'skill-read'
const MIXED_PREFIX = 'I read the instructions first.\n'
const MIXED_TAIL = '\nThe requested work is complete.'

const mocks = vi.hoisted(() => ({
  modelRuns: new Map<number, ModelRun>(),
  brainRuns: [] as string[],
  /** What each compile was handed: its current message and its Judge Juice options. */
  compiles: [] as Array<{ current: unknown; hintProvider: boolean; smartZipProvider: boolean; exposedObserver: boolean; hintLines: string[] }>,
  userEvents: [] as Array<Record<string, any>>,
  /** What the compile reports it left open (the smart zip seam's exposed observer). */
  exposed: [] as Array<Record<string, unknown>>,
  skillHistory: [] as any[],
  beforeReply: null as null | ((messageId: string, runNumber: number) => Promise<void>),
  failChunk: null as string | null,
  sdkFinishTexts: [] as string[]
}))

const lanes = vi.hoisted(() => ({
  computeSmartZipHints: vi.fn(),
  computeSmartZipRezips: vi.fn(),
  computeReplyCheck: vi.fn(),
  computeStyleCoach: vi.fn(),
  computeSkillSessionCloses: vi.fn()
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

vi.mock('$lib/server/services/skillSessions.jev', async (original) => ({
  ...await original<Record<string, unknown>>(), computeSkillSessionCloses: lanes.computeSkillSessionCloses
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
      const compiled = {
        current,
        hintProvider: typeof options?.jevJuiceHintProvider === 'function',
        smartZipProvider: typeof options?.jevJuiceSmartZipProvider === 'function',
        exposedObserver: typeof options?.jevJuiceSmartZipExposedObserver === 'function',
        hintLines: [] as string[]
      }
      mocks.compiles.push(compiled)
      // Like the real compiler: the smart zip provider is asked after the history pass of a
      // compile with a current message, and the one tail provider closes the prompt.
      if (options?.jevJuiceSmartZipProvider && current) {
        await options.jevJuiceSmartZipProvider({ currentUserMessage: current, zippedItems: [] })
        options.jevJuiceSmartZipExposedObserver?.(mocks.exposed)
      }
      if (options?.jevJuiceHintProvider) {
        compiled.hintLines = await options.jevJuiceHintProvider({ skills: [], discoverable: [], resolvedGatewayIds: [] })
      }
      return {
        primarySystemPrompt: 'You are a test agent.',
        // Shaped like the real compiler's snapshot, as in the sibling handler tests (a26ea0697): an API card
        // saves it and its resume needs it. The per-agent snapshot contract is databaseRedis.compileContract.test.ts.
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId: _userId, sessionId: _sessionId, agentId: (_agent as any).id, messageId: options?.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'Hello from the compile.' }], metadata: {} },
        resolvedProjectPath: null,
        previewOpenSkillContext: async () => ({ text: 'open_skills: Skill Creator', fingerprint: 'fixture-open-context' })
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
      await mocks.beforeReply?.(request.messageId, mocks.brainRuns.length)
      if (plan === 'skill-read') {
        const toolCallId = 'actual-early-skill-call', toolName = 'native_batshit_tool_use'
        const inner = { skillId: 'skill_creator', action: 'invoke' }, input = { ref: 'batshit:sys.skill.use', input: inner }
        const skillMarkdown = '# Skill Creator\nThe actual fixture read.'
        const result = await request.skillReadDelivery.execute(inner, async () => ({ success: true, action: 'invoke',
          skill: { id: 'skill_creator', name: 'Skill Creator' }, skillMarkdown, sourceSha256: 'a'.repeat(64),
          offset: 0, originalChars: skillMarkdown.length, returnedChars: skillMarkdown.length }))
        const output = { success: true, controlId: 'sys.skill.use', ref: input.ref, family: 'batshit', target: 'sys.skill.use', operationKind: 'skill_read', rendererFamily: 'skill_read', result }
        const view = { type: 'text', value: JSON.stringify(output) }
        await request.skillReadDelivery.delivered({ toolName, toolCallId, input, output, before: view, after: view })
        async function* read() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'tool-call', toolCallId, toolName, input }
          yield { type: 'tool-result', toolCallId, toolName, input, output }
          yield { type: 'text-start', id: 'after-read' }
          yield { type: 'text-delta', id: 'after-read', text: 'I used the admitted skill.' }
          yield { type: 'text-end', id: 'after-read' }
          yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
          await request.onFinish?.({ text: 'I used the admitted skill.', steps: [{ toolName, toolCallId, toolInput: input, toolOutput: output }], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
          yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
        }
        const actual = await vi.importActual<typeof import('$lib/server/services/vercelBrain')>('$lib/server/services/vercelBrain')
        const maps = { gatewayTools: new Map(), subagentTools: new Map(), workflowTools: new Map() }
        return { stream: read(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }),
          __detectToolSource: (name: string) => (actual.VercelAIBrain.prototype as any).detectMode3ToolSource(name, maps) }
      }
      if (plan === 'mixed') {
        const toolCallId = `mixed-call-${mocks.brainRuns.length}`
        const input = { command: 'pwd' }
        const output = { success: true, command: 'pwd', stdout: '/work/project\n', stderr: '', exitCode: 0, backend: 'local' }
        async function* mixed() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 'before-tool' }
          yield { type: 'text-delta', id: 'before-tool', text: MIXED_PREFIX }
          yield { type: 'text-end', id: 'before-tool' }
          yield { type: 'tool-call', toolCallId, toolName: 'native_bash_execute', input }
          yield { type: 'tool-result', toolCallId, toolName: 'native_bash_execute', input, output }
          yield { type: 'text-start', id: 'after-tool' }
          yield { type: 'text-delta', id: 'after-tool', text: MIXED_TAIL }
          yield { type: 'text-end', id: 'after-tool' }
          yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
          mocks.sdkFinishTexts.push(MIXED_TAIL)
          // Actual SDK finish text may cover only the final step. The recorded stream above
          // owns every earlier word and the intervening trusted tool-result card.
          await request.onFinish?.({ text: MIXED_TAIL, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
          yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
        }
        return { stream: mixed(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      if (plan === 'failed' || plan === 'stopped') {
        async function* unfinished() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Work is still in progress.' }
          if (plan === 'stopped') abortStream(request.sessionId, 'user')
          else yield { type: 'error', error: new Error('Injected provider failure before completion.') }
        }
        return { stream: unfinished(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
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
afterAll(async () => {
  await fs.rm(isolatedHome.directory, { recursive: true, force: true })
  if (isolatedHome.previous === undefined) delete process.env.BATSHIT_HOME_DIR
  else process.env.BATSHIT_HOME_DIR = isolatedHome.previous
})

let POST: (event: any) => Promise<Response>
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER], rawSessionRead: false })
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
  return post({ content: REQUEST, messageId, messages: [...mocks.skillHistory, userMessage()] })
}

async function stored(messageId: string): Promise<any> {
  return redis.execute((client: any) => client.json.get(`message:${SESSION}:${messageId}`))
}

/** The page's own Approve click on the card, with the card as the chat now shows it. */
async function approve(card: any, approvalId: string): Promise<Response> {
  return post({
    content: '',
    messageId: card.id,
    messages: [...mocks.skillHistory, userMessage(), card],
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

/** The existing BL-775 stream-record owner, used by the sibling saved-reply handler suite. */
async function recordSseForward(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!String(input).endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  if (isLateReplyEvent(event.sessionId, event)) return new Response(JSON.stringify({ success: false, message: 'The reply was already saved' }), { status: 200 })
  if (event.type === 'chunk' && event.content === mocks.failChunk) return new Response('record failed', { status: 500 })
  if (event.type === 'start') startReplyRecord(event.sessionId, { ...event })
  else if (!['end', 'error', 'complete'].includes(event.type) && event.messageId) recordReplyEvent(event.sessionId, { ...event })
  return new Response(JSON.stringify({ success: true }), { status: 200 })
}

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
    mocks.exposed = []
    mocks.skillHistory = []
    mocks.beforeReply = null
    mocks.failChunk = null
    mocks.sdkFinishTexts = []
    for (const lane of Object.values(lanes)) lane.mockReset()
    lanes.computeSmartZipHints.mockResolvedValue({ opens: [], lines: [], record: null, note: null })
    lanes.computeSmartZipRezips.mockResolvedValue({ rezips: [], record: ZIP_ROW, decision: null })
    lanes.computeReplyCheck.mockResolvedValue({ findings: [CLAIMED], record: CHECK_ROW, note: null })
    lanes.computeStyleCoach.mockResolvedValue({ findings: [], record: null, note: null })
    lanes.computeSkillSessionCloses.mockImplementation(async (input) => ({
      record: { feature: 'skill_tool_hints', model: 'jev-test', status: 'ok', latencyMs: 1, usage: null,
        deadlineHit: false, questionCount: 2, at: '2026-10-25T00:00:00.000Z' }, note: null, skipped: [],
      decision: { close: input.candidates.map((candidate: any) => ({ candidate, completed: 0.99, again: 0.01 })), kept: [], summary: 'close' }
    }))
    for (const spy of Object.values(zipState)) spy.mockClear()
    zipState.loadUntoldInferredRezips.mockResolvedValue([])
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetReplyRecordsForTests()
    vi.stubGlobal('fetch', vi.fn(recordSseForward))
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
    // The real subject owner requires the preset's actual user membership as well as its row.
    await redis.sAdd(`user:${USER}:models`, PRESET)
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
    __resetReplyRecordsForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Existing handler harness, with one fully accounted actual-read lifecycle to make closure observable. */
  async function manageOnlySkill() {
    for (const [key, value] of initializedBuiltinPluginEntries(USER)) await redis.json.set(key, '$', value)
    await redis.json.set(`agent:${AGENT}`, '$.jev_juice_skill_tool_hints', 'manage')
    await redis.json.set(`agent:${AGENT}`, '$.jev_juice_reply_check', false)
    await redis.json.set(`agent:${AGENT}`, '$.jev_juice_style_coach', false)
    await redis.updateUserSettings(USER, { global_zip_settings: { jev_juice_smart_zip: false } })
    await redis.json.set('batshit:typesafe_config', '$', { enabled: true })
    await redis.json.set(`slash_command:${USER}:example`, '$', { id: 'example', user_id: USER,
      name: 'example', type: 'skill', skill_id: 'example', enabled_for_all_agents: true, is_active: true, can_be_invoked_in_chat: true })
    const rawZipId = 'cool_tool_1790000000000_handlerSkill'
    const opener = { id: 'msg-skill-opener', session_id: SESSION, user_id: USER, agent_id: AGENT,
      role: 'assistant', content: `{{batshit-zip:${rawZipId}:::Example skill}}`, created_at: '2026-10-12T00:59:59.000Z', metadata: { zipIds: [rawZipId] } }
    const task = { id: 'msg-skill-task', session_id: SESSION, user_id: USER, role: 'user',
      content: 'Create the requested artifact, then finish its review.', created_at: '2026-10-12T00:59:58.000Z', metadata: {} }
    for (const message of [task, opener]) await redis.saveMessage(message as any)
    await redis.json.set(`zip:${rawZipId}`, '$', { id: rawZipId, type: 'cool_tool', tokens: 10,
      metadata: { sessionId: SESSION, messageId: opener.id, operationKind: 'skill_read', promptTokens: 10, tokenBasis: 'ai_expanded' },
      content: JSON.stringify({ schemaVersion: 1, type: 'tool', toolName: 'native_skill', originalToolName: 'native_skill', operationKind: 'skill_read',
        toolArgs: { action: 'invoke', skillId: 'example' }, toolResult: { success: true, action: 'invoke', skillId: 'example', content: '# Skill',
          sourceSha256: 'a'.repeat(64), offset: 0, returnedChars: 7, originalChars: 7 } }) })
    await redis.sAdd(`session:${SESSION}:zips`, rawZipId)
    expect(await openSkillSessionRead({ userId: USER, sessionId: SESSION, agentId: AGENT, messageId: opener.id, rawZipId })).toBe(true)
    mocks.skillHistory = [task, opener]
    return { opener, task }
  }

  const openManagedSkills = () => readOpenSkillSessions({ userId: USER, sessionId: SESSION, agentId: AGENT })

  it('judges the confirmed whole saved mixed tool/prose reply once when the SDK finish text contains only its final step', async () => {
    await manageOnlySkill()
    mocks.modelRuns.set(1, 'mixed')
    const response = await send('msg-managed-mixed')
    expect(response.status, await response.clone().text()).toBe(200)
    const saved = await stored('msg-managed-mixed')
    expect(saved.metadata[REPLY_SAVED_FROM_OWN_COPY_KEY]).not.toBe(true)
    expect(saved.content).toContain(MIXED_PREFIX.trim())
    expect(saved.content).toContain(MIXED_TAIL.trim())
    const cards = scanZipReferences(saved.content)
    expect(cards).toHaveLength(1)
    expect(saved.metadata.zipIds).toContain(cards[0].id)
    expect(mocks.sdkFinishTexts).toEqual([MIXED_TAIL])
    expect(afterReplyCalls()).toEqual({ check: 0, style: 0, rezip: 0 })
    expect(lanes.computeSkillSessionCloses).toHaveBeenCalledTimes(1)
    expect(lanes.computeSkillSessionCloses.mock.calls[0][0].evidence.reply).toBe(replyProseForJudgment(saved.content))
    expect(lanes.computeSkillSessionCloses.mock.calls[0][0].evidence.reply).not.toBe(MIXED_TAIL.trim())
    expect(await openManagedSkills()).toEqual([])
  }, 30_000)

  it('never judges or closes from a saved own-copy fallback after a recorded-stream gap', async () => {
    await manageOnlySkill()
    mocks.modelRuns.set(1, 'mixed')
    mocks.failChunk = MIXED_TAIL
    expect((await send('msg-managed-record-gap')).status).toBe(200)
    const saved = await stored('msg-managed-record-gap')
    expect(saved.metadata[REPLY_SAVED_FROM_OWN_COPY_KEY]).toBe(true)
    expect(lanes.computeSkillSessionCloses).not.toHaveBeenCalled()
    expect(await openManagedSkills()).toHaveLength(1)
    expect((await typesafeRows('msg-managed-record-gap')).some((row) => row.feature === 'skill_tool_hints' && row.reason === 'local_error')).toBe(true)
  }, 30_000)

  it('Manage alone reaches one close check on a normal complete reply while Smart Zip and both P6 lanes remain OFF', async () => {
    await manageOnlySkill()
    const response = await send('msg-managed-complete')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(afterReplyCalls()).toEqual({ check: 0, style: 0, rezip: 0 })
    expect(lanes.computeSkillSessionCloses).toHaveBeenCalledTimes(1)
    expect(lanes.computeSkillSessionCloses.mock.calls[0][0].evidence).toMatchObject({ request: REQUEST, reply: 'Reply for msg-managed-complete.', origin: 'user' })
    expect(await openManagedSkills()).toEqual([])
  }, 30_000)

  it('Manage alone waits at an API approval pause, then judges the complete saved reply once after its valid resume', async () => {
    await manageOnlySkill()
    mocks.modelRuns.set(1, 'card')
    expect((await send(CARD)).status).toBe(200)
    expect(lanes.computeSkillSessionCloses).not.toHaveBeenCalled()
    expect(await openManagedSkills()).toHaveLength(1)
    const card = await stored(CARD)
    expect((await approve(card, card.metadata.toolApprovals.approvals[0].approvalId)).status).toBe(200)
    expect(lanes.computeSkillSessionCloses).toHaveBeenCalledTimes(1)
    expect(lanes.computeSkillSessionCloses.mock.calls[0][0].evidence).toMatchObject({ request: REQUEST,
      reply: 'I need to list the folder.\n\nReply for msg-card.', origin: 'trusted_resume' })
    expect(await openManagedSkills()).toEqual([])
  }, 30_000)

  it('Manage alone judges a valid context continuation once with every saved reply part', async () => {
    await manageOnlySkill()
    mocks.modelRuns.set(1, 'exhausted')
    expect((await send('msg-managed-context')).status).toBe(200)
    expect(mocks.brainRuns).toHaveLength(2)
    expect(lanes.computeSkillSessionCloses).toHaveBeenCalledTimes(1)
    expect(lanes.computeSkillSessionCloses.mock.calls[0][0].evidence).toMatchObject({ request: REQUEST,
      reply: `Listing the folder first.\n\nReply for ${mocks.brainRuns[1]}.`, origin: 'trusted_resume' })
    expect(await openManagedSkills()).toEqual([])
  }, 30_000)

  it.each(['length', 'failed', 'stopped'] as const)('Manage alone never judges or closes a %s reply', async (plan) => {
    await manageOnlySkill()
    mocks.modelRuns.set(1, plan)
    const response = await send(`msg-managed-${plan}`)
    expect(response.status).toBe(plan === 'length' ? 200 : plan === 'stopped' ? 499 : 500)
    expect(lanes.computeSkillSessionCloses).not.toHaveBeenCalled()
    expect(await openManagedSkills()).toHaveLength(1)
  }, 30_000)

  it.each(['missing', 'unreadable'] as const)('Manage alone keeps open when a required saved original-task part becomes %s before the reply ends', async (kind) => {
    const { opener } = await manageOnlySkill()
    mocks.beforeReply = async () => {
      if (kind === 'missing') await redis.json.set(`message:${SESSION}:${opener.id}`, '$', null)
      else await redis.execute(async (client: any) => { await client.del(`message:${SESSION}:${opener.id}`); await client.set(`message:${SESSION}:${opener.id}`, 'not-json') })
    }
    expect((await send(`msg-managed-${kind}`)).status).toBe(200)
    expect(lanes.computeSkillSessionCloses).not.toHaveBeenCalled()
    expect(await openManagedSkills()).toHaveLength(1)
    expect((await typesafeRows(`msg-managed-${kind}`)).some((row) => row.feature === 'skill_tool_hints' && row.reason === 'local_error')).toBe(true)
  }, 30_000)

  it.each(['missing', 'unreadable'] as const)('Manage alone keeps open when a context continuation earlier reply part is %s despite a complete browser copy', async (kind) => {
    await manageOnlySkill()
    mocks.modelRuns.set(1, 'exhausted')
    mocks.beforeReply = async (_id, run) => {
      if (run !== 2) return
      if (kind === 'missing') await redis.json.set(`message:${SESSION}:msg-managed-lost-part`, '$', null)
      else await redis.execute(async (client: any) => { await client.del(`message:${SESSION}:msg-managed-lost-part`); await client.set(`message:${SESSION}:msg-managed-lost-part`, 'not-json') })
    }
    expect((await send('msg-managed-lost-part')).status).toBe(200)
    expect(mocks.brainRuns).toHaveLength(2)
    expect(lanes.computeSkillSessionCloses).not.toHaveBeenCalled()
    expect(await openManagedSkills()).toHaveLength(1)
    expect((await typesafeRows(mocks.brainRuns[1])).some((row) => row.feature === 'skill_tool_hints' && row.reason === 'local_error')).toBe(true)
  }, 30_000)

  it('reuses a privately admitted API broker skill read at actual stream reconciliation without rewriting RAW or losing saved refs', async () => {
    for (const [key, value] of initializedBuiltinPluginEntries(USER)) await redis.json.set(key, '$', key.startsWith('agent_plugin:') ? { ...value, enabled_agent_ids: [AGENT] } : value)
    await redis.updateAgent(AGENT, { jev_juice_skill_tool_hints: false, jev_juice_smart_zip: false, jev_juice_reply_check: false, jev_juice_style_coach: false } as any)
    mocks.modelRuns.set(1, 'skill-read')
    const response = await send('msg-api-early-read')
    expect(response.status, await response.clone().text()).toBe(200)
    const saved = await stored('msg-api-early-read')
    expect(saved.metadata.controlErrors ?? []).toEqual([])
    expect(saved.metadata.zipIds).toHaveLength(1)
    expect(scanZipReferences(saved.content).filter(ref => saved.metadata.zipIds.includes(ref.id))).toHaveLength(1)
    const ids = await redis.sMembers(`session:${SESSION}:zips`)
    expect(ids).toHaveLength(2)
    expect(await readOpenSkillSessions({ userId: USER, sessionId: SESSION, agentId: AGENT })).toHaveLength(1)
  }, 30_000)

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

    // The resume is not a new user turn. Only the lifecycle's read-only notice replay remains
    // available; with no prior lifecycle notice it emits no bytes and asks no judge.
    expect(mocks.compiles).toHaveLength(2)
    expect(mocks.compiles[1]).toMatchObject({ current: REQUEST, smartZipProvider: false, exposedObserver: false, hintProvider: true, hintLines: [] })
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
    // The continuation gets no before-reply judgment; its notice-only lifecycle replay is empty.
    expect(mocks.compiles[1]).toMatchObject({ smartZipProvider: false, hintProvider: true, hintLines: [] })
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

  it.each([true, false])('retires a saved control card without granting or running (approved=%s)', async approved => {
    const record = await createPendingApproval({ userId: USER, agentId: AGENT, sessionId: SESSION,
      messageId: CARD, controlId: 'sys.skill.import', controlTitle: 'Skill Import', riskLevel: 'confirm',
      lane: 'api', input: { source: 'https://example.test/skill' } })
    await redis.json.set(`control_approval:${record.id}`, '$.lane', 'cli')
    const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant',
      content: 'Approval requested.', created_at: new Date().toISOString(), metadata: { toolApprovals: {
        mode: 'all', source: 'fabric', approvals: [{ approvalId: record.id, status: 'pending',
          control: { approvalId: record.id, controlId: record.controlId, lane: 'cli' } }] } } }
    await redis.saveMessage(userMessage() as any)
    await redis.saveMessage(card as any)
    const before = await stored(CARD)
    const response = await post({ content: '', messageId: CARD, messages: [userMessage(), card], metadata: {
      toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: record.id, approved }] } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ reason: 'retired', retiredApprovalIds: [record.id] })
    expect((await stored(CARD)).content).toBe(before.content)
    expect((await stored(CARD)).metadata.toolApprovals.approvals[0]).toMatchObject({ status: 'expired', expiryReason: 'run_ended' })
    expect(await redis.json.get(`control_approval:${record.id}`)).toMatchObject({ lane: 'cli', status: 'expired' })
    expect(mocks.brainRuns).toHaveLength(0)
    expect(afterReplyCalls()).toEqual({ check: 0, style: 0, rezip: 0 })
  }, 30_000)

  it('refuses a mixed API and retired control click as a whole before either answer', async () => {
    const old = await createPendingApproval({ userId: USER, agentId: AGENT, sessionId: SESSION,
      messageId: CARD, controlId: 'sys.skill.import', controlTitle: 'Skill Import', riskLevel: 'confirm',
      lane: 'api', input: { source: 'https://example.test/skill' } })
    await redis.json.set(`control_approval:${old.id}`, '$.lane', 'cli')
    const current = await createPendingApproval({ userId: USER, agentId: AGENT, sessionId: SESSION,
      messageId: CARD, controlId: 'sys.memory.delete', controlTitle: 'Delete Memory', riskLevel: 'confirm',
      lane: 'api', input: { memory_id: 'mem_1' } })
    const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant',
      content: 'Approvals requested.', created_at: new Date().toISOString(), metadata: { toolApprovals: {
        mode: 'all', source: 'vercel', approvals: [
          { approvalId: 'sdk-current', status: 'pending', control: { approvalId: current.id, lane: 'api' } },
          { approvalId: old.id, status: 'pending', control: { approvalId: old.id, lane: 'cli' } }
        ] } } }
    await redis.saveMessage(userMessage() as any)
    await redis.saveMessage(card as any)
    const before = await stored(CARD)
    const response = await post({ content: '', messageId: CARD, messages: [userMessage(), card], metadata: {
      toolApprovalResponse: [
        { type: 'tool-approval-response', approvalId: 'sdk-current', approved: true },
        { type: 'tool-approval-response', approvalId: old.id, approved: true }
      ] } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'approval_run_retired' })
    expect((await stored(CARD)).content).toBe(before.content)
    expect((await stored(CARD)).metadata.toolApprovals.approvals).toMatchObject([
      { approvalId: 'sdk-current', status: 'pending' }, { approvalId: old.id, status: 'expired', expiryReason: 'run_ended' }
    ])
    expect(await redis.json.get(`control_approval:${old.id}`)).toMatchObject({ lane: 'cli', status: 'expired' })
    expect(await redis.json.get(`control_approval:${current.id}`)).toMatchObject({ lane: 'api', status: 'pending' })
    expect(mocks.brainRuns).toHaveLength(0)
  }, 30_000)

  it('retires a saved mixed Claude permission and CLI control without submitting a permission answer', async () => {
    const record = await createPendingApproval({ userId: USER, agentId: AGENT, sessionId: SESSION,
      messageId: CARD, controlId: 'sys.skill.import', controlTitle: 'Skill Import', riskLevel: 'confirm',
      lane: 'api', input: { source: 'https://example.test/skill' } })
    await redis.json.set(`control_approval:${record.id}`, '$.lane', 'cli')
    const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant',
      content: 'Old approvals.', created_at: new Date().toISOString(), metadata: { toolApprovals: {
        mode: 'all', source: 'claude', approvals: [
          { approvalId: 'old-permission', status: 'pending', source: 'claude' },
          { approvalId: record.id, status: 'pending', source: 'fabric', control: { approvalId: record.id, lane: 'cli' } }
        ] } } }
    await redis.saveMessage(userMessage() as any)
    await redis.saveMessage(card as any)
    const response = await post({ content: '', messageId: CARD, messages: [userMessage(), card],
      metadata: { retireSavedApprovalId: record.id } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ reason: 'retired', retiredApprovalIds: ['old-permission', record.id] })
    expect((await stored(CARD)).metadata.toolApprovals.approvals).toMatchObject([
      { status: 'expired', expiryReason: 'run_ended' }, { status: 'expired', expiryReason: 'run_ended' }
    ])
    expect(mocks.brainRuns).toHaveLength(0)
  }, 30_000)

  it('does not let a request claim a current API approval is historical', async () => {
    const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant',
      content: 'Current approval.', created_at: new Date().toISOString(), metadata: { claudePlanReply: true,
        toolApprovals: { mode: 'all', source: 'vercel', approvals: [{ approvalId: 'sdk-current', status: 'pending', source: 'vercel' }] } } }
    await redis.saveMessage(userMessage() as any)
    await redis.saveMessage(card as any)
    const before = await stored(CARD)
    const response = await post({ content: '', messageId: CARD, messages: [userMessage(), card],
      metadata: { retireSavedApprovalId: 'sdk-current', toolApprovals: { source: 'claude' } } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'approval_run_retired' })
    expect(await stored(CARD)).toEqual(before)
    expect(mocks.brainRuns).toHaveLength(0)
  }, 30_000)

  it.each(['retired-only', 'mixed', 'live-answer'] as const)('group card %s: only stored retired entries may settle, with no run', async variant => {
    const group = 'bl2437-group'
    const descriptor = Object.getOwnPropertyDescriptor(redis, 'getGroup')
    if (typeof redis.getGroup !== 'function') Object.defineProperty(redis, 'getGroup', { configurable: true,
      value: (id: string) => redis.execute(client => client.json.get(`group:${id}`)) })
    try {
      await redis.json.set(`group:${group}`, '$', { id: group, user_id: USER, name: 'Group', agent_ids: [AGENT, 'other-agent'] })
      await redis.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: group } })
      const old = { approvalId: 'old-control', status: 'pending', source: 'fabric', control: { lane: 'cli' } }
      const current = { approvalId: 'live-api', status: 'pending', source: 'vercel', control: { lane: 'api' } }
      const entries = variant === 'retired-only' ? [old] : variant === 'mixed' ? [old, current] : [current]
      const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant',
        content: 'Group card.', created_at: new Date().toISOString(), metadata: { toolApprovals: { source: 'vercel', approvals: entries } } }
      await redis.saveMessage(card as any)
      const before = await stored(CARD)
      const metadata = variant === 'live-answer'
        ? { toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: 'live-api', approved: true }] }
        : { retireSavedApprovalId: 'old-control' }
      const response = await post({ content: '', messageId: CARD, messages: [card], metadata })
      if (variant === 'live-answer') {
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'approval_unavailable_in_group' })
        expect(await stored(CARD)).toEqual(before)
      } else {
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ reason: 'retired', stillPending: variant === 'mixed' })
        const saved = await stored(CARD)
        expect(saved.metadata.toolApprovals.approvals[0]).toMatchObject({ status: 'expired', expiryReason: 'run_ended' })
        if (variant === 'mixed') expect(saved.metadata.toolApprovals.approvals[1]).toMatchObject({ status: 'pending' })
        expect(saved.metadata.answeredApprovalIds).toBeUndefined()
      }
      expect(mocks.brainRuns).toHaveLength(0)
    } finally {
      if (!descriptor && process.env.VITEST_USE_REAL_REDIS !== 'true') delete (redis as any).getGroup
      await redis.del(`group:${group}`)
    }
  }, 30_000)

  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('retires an actual card with steers without rewriting raw card siblings or held words', async () => {
    const heldId = 'held-precise'
    const cardKey = `message:${SESSION}:${CARD}`, heldKey = `message:${SESSION}:${heldId}`
    const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant',
      content: 'Old approval.', created_at: new Date().toISOString(), metadata: {
        futureExact: '__BIG__', steerPromoted: { steerIds: ['voice-steer'], futureExact: '__BIG__' },
        toolApprovals: { source: 'fabric', approvals: [{ approvalId: 'old-control', status: 'pending', source: 'fabric',
          control: { lane: 'cli', input: { exact: '__BIG__' } } }] } } }
    const held = { id: heldId, session_id: SESSION, user_id: USER, role: 'user', content: 'Words to keep.',
      created_at: new Date().toISOString(), metadata: { waitsForApproval: { messageId: CARD }, futureExact: '__BIG__' } }
    const encoded = (value: unknown) => JSON.stringify(value).replaceAll('"__BIG__"', '9007199254740993')
    await redis.saveMessage(userMessage() as any)
    await redis.execute(async client => {
      await client.sendCommand(['JSON.SET', cardKey, '$', encoded(card)])
      await client.sendCommand(['JSON.SET', heldKey, '$', encoded(held)])
      await client.rPush(`messages:${SESSION}`, [CARD, heldId])
    })
    const beforeCard = await redis.json.getRaw(cardKey, '$.metadata.futureExact')
    const beforeSteer = await redis.json.getRaw(cardKey, '$.metadata.steerPromoted.futureExact')
    const beforeInput = await redis.json.getRaw(cardKey, '$.metadata.toolApprovals.approvals[0].control.input.exact')
    const beforeHeld = await redis.json.getRaw(heldKey, '$')
    expect(beforeCard).toBe('[9007199254740993]')
    expect(beforeSteer).toBe('[9007199254740993]')
    expect(beforeInput).toBe('[9007199254740993]')
    expect(beforeHeld).toContain('9007199254740993')
    const response = await post({ content: '', messageId: CARD, messages: [], metadata: { retireSavedApprovalId: 'old-control' } })
    expect(response.status).toBe(200)
    expect(await redis.json.getRaw(cardKey, '$.metadata.futureExact')).toBe(beforeCard)
    expect(await redis.json.getRaw(cardKey, '$.metadata.steerPromoted.futureExact')).toBe(beforeSteer)
    expect(await redis.json.getRaw(cardKey, '$.metadata.toolApprovals.approvals[0].control.input.exact')).toBe(beforeInput)
    expect(await redis.json.getRaw(heldKey, '$')).toBe(beforeHeld)
    const saved = await stored(CARD)
    expect(saved.metadata).toMatchObject({ retiredApprovalSettled: true,
      steerPromoted: { steerIds: ['voice-steer'], disposition: 'unanswered', reason: 'approval_expired' } })
    expect(resolveHeldMessageReceipt({ messages: await redis.getRecentMessages(SESSION, 20), busy: false })).toMatchObject({ messageId: heldId, state: 'expired' })
    expect(mocks.brainRuns).toHaveLength(0)
  }, 30_000)

})
