// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { buildDelegatedExecutionSummary } from '$lib/server/services/delegatedRunAccounting'
import { buildTokenStat, buildTokenUsage } from '$lib/server/services/executionViewerLlmCapture'
import { summarizeRunningCost } from '$lib/utils/tokenPanel'
import type { SavedModel } from '$lib/types/savedModels'

/**
 * BL-525 — after Approve, the resume's finish counts BOTH halves of the reply, through the real
 * handler: the message's usage, performance, reasoning, and Subagent spend, and the Execution
 * Viewer snapshot's `responseSummary`, `llmSummary`, `delegated`, and Judge Juice rows, which the
 * Token Panel's running cost reads.
 *
 * The paused half is stored the way a finished pause leaves it (the record with its card, its
 * replayable transcript, and its numbers; its snapshot). The click is the page's own body. Faked:
 * the compiler's output and the API model (`VercelAIBrain`, which answers the resume with words and
 * its own usage); everything else is the handler's own code on the Redis fake.
 */

const USER = 'user-bl525'
const AGENT = 'agent-bl525'
const PRESET = 'preset-bl525'
const CARD = 'msg-card'
const APPROVAL = 'aitxt-bl525'

const PAUSE_USAGE = { inputTokens: 10_000, outputTokens: 1_000, totalTokens: 11_000 }
const RESUME_USAGE = { inputTokens: 12_000, outputTokens: 500, totalTokens: 12_500 }

const mocks = vi.hoisted(() => ({
  brainRuns: [] as string[],
  /** `reply`: words and a finish. `subagent-then-error`: a Subagent call and result, then a provider error. */
  plan: 'reply' as 'reply' | 'subagent-then-error' | 'words-then-error' | 'acquire-error'
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
        structuredInput: { messages: [{ role: 'user', content: 'List the folder.' }], metadata: {} },
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
      if (mocks.plan === 'acquire-error') throw new Error('Synthetic acquisition failure before any new usage.')
      const text = 'The folder has three files.'
      if (mocks.plan === 'subagent-then-error') {
        const helperResult = {
          kind: 'subagent',
          status: 'completed',
          subagentName: 'Helper',
          modelId: 'claude-sonnet-5',
          provider: 'anthropic',
          usage: { inputTokens: 4_000, outputTokens: 400, totalTokens: 4_400 },
          durationMs: 1000,
          output: 'The helper looked.'
        }
        async function* failing() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Asking the helper.' }
          yield { type: 'text-end', id: 't1' }
          yield { type: 'tool-call', toolCallId: 'call_helper', toolName: 'native_run_subagent', input: { task: 'look' } }
          yield { type: 'tool-result', toolCallId: 'call_helper', toolName: 'native_run_subagent', input: { task: 'look' }, output: helperResult }
          yield { type: 'finish-step', finishReason: 'tool-calls', usage: PAUSE_USAGE, response: {} }
          yield { type: 'error', error: new Error('Provider exploded after the helper ran.') }
        }
        return { stream: failing(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      if (mocks.plan === 'words-then-error') {
        async function* cutShort() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'The folder' }
          yield { type: 'error', error: new Error('Provider exploded mid-reply.') }
        }
        return { stream: cutShort(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage: RESUME_USAGE, response: {} }
        await request.onFinish?.({
          text,
          steps: [],
          totalUsage: RESUME_USAGE,
          usage: RESUME_USAGE,
          reasoning: [],
          responseMessages: []
        })
        yield { type: 'finish', finishReason: 'stop', totalUsage: RESUME_USAGE }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
let count = 0

const model: SavedModel = {
  id: PRESET,
  name: 'Test model',
  provider: 'anthropic',
  modelId: 'claude-sonnet-5',
  modelName: 'Claude Sonnet 5',
  contextWindow: 200_000,
  capabilities: {},
  settings: {},
  pricing: { input: 3, output: 15 },
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z'
} as unknown as SavedModel

const subagentStep = {
  toolCallId: 'call_helper',
  toolName: 'native_run_subagent',
  toolResult: {
    kind: 'subagent',
    status: 'completed',
    subagentName: 'Helper',
    modelId: 'claude-sonnet-5',
    provider: 'anthropic',
    usage: { inputTokens: 4_000, outputTokens: 400, totalTokens: 4_400 },
    durationMs: 1000
  }
}

const userMessage = () => ({
  id: 'msg-user-1',
  session_id: SESSION,
  user_id: USER,
  role: 'user',
  content: 'List the folder.',
  created_at: '2026-09-27T01:00:00.000Z',
  metadata: {}
})

const cardMetadata = () => ({
  model: 'claude-sonnet-5',
  agentType: 'api',
  usage: PAUSE_USAGE,
  performance: { schemaVersion: 1, source: 'ai-sdk', timeToFirstOutputMs: 900, outputTokensPerSecond: 40, responseTimeMs: 3000, modelCalls: 2 },
  reasoningSummary: 'Ask a helper, then list the folder.',
  delegated: buildDelegatedExecutionSummary([subagentStep]),
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
})

const cardMessage = () => ({
  id: CARD,
  session_id: SESSION,
  user_id: USER,
  agent_id: AGENT,
  role: 'assistant',
  status: 'complete',
  content: 'Asking the helper first.',
  created_at: '2026-09-27T01:00:05.000Z',
  intermediateSteps: [subagentStep],
  metadata: cardMetadata()
})

/** The paused half's snapshot, as its finish left it. */
async function recordPausedSnapshot() {
  await executionViewerService.recordSnapshot({
    id: CARD,
    sessionId: SESSION,
    userId: USER,
    agentId: AGENT,
    agentName: 'Probe',
    createdAt: '2026-09-27T01:00:00.000Z',
    structuredInput: {},
    executionMetadata: { typesafeCalls: [{ feature: 'memory_recall', status: 'ok', usage: null }] },
    runtime: { runtimeId: 'vercel', providerId: 'anthropic', connectionId: null, modelName: 'claude-sonnet-5' }
  })
  await executionViewerService.updateSnapshot(SESSION, CARD, {
    llmSummary: {
      callsCount: buildTokenStat(2, 'exact'),
      totalUsage: buildTokenUsage(PAUSE_USAGE, 'exact', 'provider'),
      breakdownConfidence: 'exact'
    },
    delegated: buildDelegatedExecutionSummary([subagentStep]),
    responseSummary: {
      content: { value: 'Asking the helper first.', confidence: 'exact' },
      usage: buildTokenUsage(PAUSE_USAGE, 'exact', 'provider'),
      toolCallsCount: buildTokenStat(2, 'exact', 'vercel ai sdk')
    }
  })
}

function approve(): Promise<Response> {
  const card = cardMessage()
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
        messages: [userMessage(), card],
        metadata: {
          ...card.metadata,
          toolApprovalMode: 'all',
          toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }]
        }
      })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

describe('send-routed: an approval resume counts both halves of the reply (BL-525, the real handler)', () => {
  it('BL-1361 explicitly clears prior canonical totals when the new half fails before usage or observations', async () => {
    mocks.plan = 'acquire-error'
    const response = await approve()
    expect(response.status).toBe(500)
    const stored = await redis.execute((client: any) => client.json.get(`message:${SESSION}:${CARD}`)) as any
    expect(stored.metadata.usage).toBeNull()
    expect(stored.metadata.response_failed).toBe(true)
    expect(stored.metadata.observedUsage).toEqual({ completeness: 'partial', parts: [{ source: 'run-usage-prefix', counts: PAUSE_USAGE }] })
    const snapshot = await executionViewerService.getSnapshot(SESSION, CARD)
    expect(snapshot?.responseSummary?.usage.totalTokens.value).toBeNull()
    expect(snapshot?.llmSummary?.totalUsage.totalTokens.value).toBeNull()
    expect(snapshot?.responseSummary?.observedUsage?.parts).toEqual([{ source: 'run-usage-prefix', counts: PAUSE_USAGE }])
    // The old completed Subagent remains separately counted; no parent observation is priced.
    const cost = summarizeRunningCost([snapshot!], model, null, [model])
    expect(cost.state).toBe('estimated')
    expect(cost.cost).toBeCloseTo((4_000 / 1e6) * 3 + (400 / 1e6) * 15, 10)
  }, 30_000)
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl525-${count}`
    mocks.brainRuns = []
    mocks.plan = 'reply'
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
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
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-525', agent_id: AGENT } as any)
    await redis.saveMessage(userMessage() as any)
    await redis.saveMessage(cardMessage() as any)
    await recordPausedSnapshot()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('the saved message and its snapshot count both halves, and the running cost includes the paused half and its Subagent', async () => {
    const response = await approve()
    expect(response.status).toBe(200)
    expect(mocks.brainRuns).toEqual([CARD])

    const stored = (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${CARD}`))) as any
    expect(stored.content).toBe('Asking the helper first.\n\nThe folder has three files.')
    expect(stored.metadata.usage).toEqual({ inputTokens: 22_000, outputTokens: 1_500, totalTokens: 23_500 })
    expect(stored.metadata.performance).toMatchObject({ timeToFirstOutputMs: 900 })
    expect(stored.metadata.delegated.runs.map((run: any) => run.name)).toEqual(['Helper'])

    const [snapshot] = await executionViewerService.getSnapshots(SESSION)
    expect(snapshot.id).toBe(CARD)
    expect(snapshot.responseSummary?.usage.inputTokens.value).toBe(22_000)
    expect(snapshot.responseSummary?.usage.outputTokens.value).toBe(1_500)
    expect(snapshot.llmSummary?.totalUsage.inputTokens.value).toBe(22_000)
    expect(snapshot.delegated?.runs).toHaveLength(1)
    expect(snapshot.executionMetadata?.typesafeCalls).toEqual([{ feature: 'memory_recall', status: 'ok', usage: null }])

    // $3/M in, $15/M out: both halves (22,000 in, 1,500 out) and the Subagent (4,000 in, 400 out).
    const cost = summarizeRunningCost([snapshot], model, null, [model])
    const expected = (22_000 / 1e6) * 3 + (1_500 / 1e6) * 15 + (4_000 / 1e6) * 3 + (400 / 1e6) * 15
    expect(cost.cost).toBeCloseTo(expected, 10)
    expect(cost.delegatedRunCount).toBe(1)
  }, 30_000)

  it('a run that fails after a Subagent ran keeps that Subagent\u2019s spend, on the record and in the snapshot', async () => {
    mocks.plan = 'subagent-then-error'
    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION,
          agentId: AGENT,
          agentType: 'api',
          content: 'Ask the helper.',
          messageId: 'msg-failed-reply',
          messages: [userMessage(), cardMessage(), { id: 'msg-user-2', role: 'user', content: 'Ask the helper.' }]
        })
      }),
      fetch: globalThis.fetch,
      locals: { user: { id: USER } }
    } as any)
    expect(response.ok).toBe(false)
    expect(mocks.brainRuns).toEqual(['msg-failed-reply'])

    const stored = (await redis.execute((client: any) => client.json.get(`message:${SESSION}:msg-failed-reply`))) as any
    expect(stored.metadata.response_failed).toBe(true)
    expect(stored.metadata.delegated?.runs?.map((run: any) => run.name)).toEqual(['Helper'])

    const snapshot = (await executionViewerService.getSnapshots(SESSION)).find((entry) => entry.id === 'msg-failed-reply')
    expect(snapshot?.delegated?.runs).toHaveLength(1)
    expect(snapshot?.delegated?.totals.usage).toMatchObject({ inputTokens: 4_000, outputTokens: 400 })
    // The parent run's own usage is unknown (its call never finished), and the Subagent's is known.
    const cost = summarizeRunningCost([snapshot!], model, null, [model])
    expect(cost.delegatedCost).toBeCloseTo((4_000 / 1e6) * 3 + (400 / 1e6) * 15, 10)
  }, 30_000)

  it('a resume that called the model and then failed leaves the reply\u2019s usage unknown, not the paused half\u2019s as exact', async () => {
    mocks.plan = 'words-then-error'
    const response = await approve()
    expect(response.ok).toBe(false)

    const [snapshot] = await executionViewerService.getSnapshots(SESSION)
    expect(snapshot.id).toBe(CARD)
    // The resume's call never finished: its usage is unknown, so the reply's is too.
    expect(snapshot.responseSummary?.usage.inputTokens.value).toBeNull()
    expect(snapshot.llmSummary?.totalUsage.inputTokens.value).toBeNull()
    // The paused half's words stay the summary's text; its Subagent still counts.
    expect(snapshot.responseSummary?.content.value).toBe('Asking the helper first.')
    expect(snapshot.delegated?.runs).toHaveLength(1)
    const cost = summarizeRunningCost([snapshot], model, null, [model])
    expect(cost.state).not.toBe('exact')
    expect(cost.cost).toBeCloseTo((4_000 / 1e6) * 3 + (400 / 1e6) * 15, 10)
  }, 30_000)
})
