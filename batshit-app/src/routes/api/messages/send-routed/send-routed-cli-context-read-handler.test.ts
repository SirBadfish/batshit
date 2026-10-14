// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { executionViewerService } from '$lib/server/services/executionViewerService'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  __resetReplyRecordsForTests
} from '$lib/server/services/replyStreamRecord'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetTurnOutcomesForTests } from '$lib/server/services/turnOutcomeRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'

const USER = 'user-bl992-context-send'
const CODEX_AGENT = 'agent-bl992-codex'
const CLAUDE_AGENT = 'agent-bl992-claude'
const CODEX_PRESET = 'preset-bl992-codex'
const CLAUDE_PRESET = 'preset-bl992-claude'
const REPLY = 'msg-bl992-context-reply'
const CONTEXT_READ_WARNING = 'Could not read the saved CLI context limit. The context limit is unknown for this send.'

const mocks = vi.hoisted(() => ({
  runs: [] as Array<{ lane: 'codex' | 'claude'; messageId: string }>,
  contextSelections: [] as any[],
  compiledHistory: [] as any[],
  fakeRun: null as null | ((lane: 'codex' | 'claude', request: any) => any)
}))

vi.mock('redis', async (importOriginal) => {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') {
    return importOriginal<Record<string, any>>()
  }
  return {
    createClient: vi.fn(() => ({
      isOpen: true,
      isReady: true,
      connect: vi.fn(async () => undefined),
      on: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      pSubscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      pUnsubscribe: vi.fn(async () => undefined),
      publish: vi.fn(async () => 0),
      configSet: vi.fn(async () => 'OK'),
      quit: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined)
    }))
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
    async prepareGroupHistory() {
      return { globalZipSettings: null }
    }

    async buildFormattedChatInput(_sessionId: string, history: unknown, agent: { id: string }) {
      mocks.compiledHistory.push(structuredClone(history))
      return {
        primarySystemPrompt: 'You are a test CLI agent.',
        structuredInput: {
          messages: [
            { role: 'user', content: 'Earlier question' },
            { role: 'assistant', content: 'Earlier answer' },
            { role: 'user', content: `Current request for ${agent.id}` }
          ],
          metadata: {}
        },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/codexBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  CodexBridge: class {
    async streamNativeMode(request: any) {
      return mocks.fakeRun!('codex', request)
    }
  }
}))

vi.mock('$lib/server/services/claudeBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  ClaudeBridge: class {
    async streamNativeMode(request: any) {
      return mocks.fakeRun!('claude', request)
    }
  }
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return {
    ...actual,
    publishSessionEvent: vi.fn(async () => undefined),
    publishUserEvent: vi.fn(async () => undefined)
  }
})

useRedisTestServer()

const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined
let POST: (event: any) => Promise<Response>
let CONTEXT_PREVIEW_POST: (event: any) => Promise<Response>
let sessionId = ''
let count = 0

const eventFetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))

function codexBlock() {
  return {
    permissionMode: 'agent_full',
    model: 'gpt-6-luna',
    approval: 'never',
    streamingEffect: true,
    search: true,
    addDirs: [],
    enableFeatures: [],
    disableFeatures: [],
    configOverrides: [],
    workingDirectoryMode: 'project'
  }
}

function claudeBlock() {
  return { permissionMode: 'default', model: 'sonnet', addDirs: [], allowedTools: [], disallowedTools: [] }
}

function agentConfig(runtime: 'codex' | 'claude') {
  if (runtime === 'codex') {
    return {
      id: CODEX_AGENT,
      presetId: CODEX_PRESET,
      provider: 'codex',
      modelId: 'gpt-6-luna',
      setting: codexBlock(),
      connection: { id: 'codex-cli', type: 'direct', service: 'codex', useDeveloperPrefix: false },
      contextWindow: 258_400
    }
  }
  return {
    id: CLAUDE_AGENT,
    presetId: CLAUDE_PRESET,
    provider: 'claude-cli',
    modelId: 'sonnet',
    setting: claudeBlock(),
    connection: { id: 'claude-cli', type: 'direct', service: 'claude-cli', useDeveloperPrefix: false },
    contextWindow: 200_000
  }
}

async function seedAgentAndSession(runtime: 'codex' | 'claude') {
  const config = agentConfig(runtime)
  await redis.set(`model:${config.presetId}`, {
    id: config.presetId,
    name: runtime === 'codex' ? 'Codex CLI' : 'Claude Code CLI',
    provider: config.provider,
    modelId: config.modelId,
    connection: config.connection,
    contextWindow: config.contextWindow,
    capabilities: { streaming: true, tools: true },
    settings: {}
  })
  await redis.createAgent({
    id: config.id,
    user_id: USER,
    name: config.id,
    displayName: config.id,
    agentType: 'cli',
    primary_model_provider: config.provider,
    primary_model_name: config.modelId,
    primary_model_preset_id: config.presetId,
    primary_model_connection: config.connection,
    primary_model_max_tokens: 4096,
    ...(runtime === 'codex' ? { codex_settings: config.setting } : { claude_settings: config.setting })
  } as any)
  await redis.createSession({ id: sessionId, user_id: USER, title: 'BL-992 context read', agent_id: config.id } as any)
}

function send(runtime: 'codex' | 'claude', metadata: Record<string, unknown> = {}) {
  const config = agentConfig(runtime)
  const messages = [
    { id: 'old-user', role: 'user', content: 'Earlier question', created_at: '2026-09-29T11:58:00.000Z' },
    { id: 'old-assistant', role: 'assistant', content: 'Earlier answer', created_at: '2026-09-29T11:59:00.000Z' },
    { id: 'current-user', role: 'user', content: 'Please answer using the full conversation.', created_at: '2026-09-29T12:00:00.000Z' }
  ]
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        agentId: config.id,
        agentType: 'cli',
        content: 'Please answer using the full conversation.',
        messageId: REPLY,
        messages,
        metadata
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

function preview(runtime: 'codex' | 'claude') {
  const config = agentConfig(runtime)
  const messages = [
    { id: 'old-user', role: 'user', content: 'Earlier question', created_at: '2026-09-29T11:58:00.000Z' },
    { id: 'old-assistant', role: 'assistant', content: 'Earlier answer', created_at: '2026-09-29T11:59:00.000Z' },
    { id: 'current-user', role: 'user', content: 'Please answer using the full conversation.', created_at: '2026-09-29T12:00:00.000Z' }
  ]
  return CONTEXT_PREVIEW_POST({
    request: new Request('http://localhost/api/messages/context-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, agentId: config.id, agentType: 'cli', messages })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

describe.each(['codex', 'claude'] as const)('send-routed CLI context report read failure (%s; BL-992)', (runtime) => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    ;({ POST: CONTEXT_PREVIEW_POST } = await import('../context-preview/+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    sessionId = `session-bl992-context-${runtime}-${count}`
    mocks.runs = []
    mocks.contextSelections = []
    mocks.compiledHistory = []
    mocks.fakeRun = (lane, request) => {
      mocks.runs.push({ lane, messageId: request.messageId })
      mocks.contextSelections.push(request.cliContextSelection)
      const text = 'Answer from the fake CLI bridge.'
      const usage = { inputTokens: 30, outputTokens: 8, totalTokens: 38 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 'text-1' }
        yield { type: 'text-delta', id: 'text-1', text }
        yield { type: 'text-end', id: 'text-1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = 'test-internal-token-bl992-context-read'
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    __resetTurnOutcomesForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))
    await seedAgentAndSession(runtime)
  })

  afterEach(() => {
    stopFailingRedisJsonGets()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    __resetTurnOutcomesForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
  })

  it('continues the full-history send after one failed report read and persists an unknown budget warning', async () => {
    let failedThisLogRead = false
    const failure = failRedisJsonGets((key) => {
      if (key !== `session:${sessionId}:execution_log` || failedThisLogRead) return false
      failedThisLogRead = true
      return true
    })

    const response = await send(runtime)

    expect(response.status).toBe(200)
    expect(failure.failures).toBe(1)
    expect(mocks.runs).toEqual([{ lane: runtime, messageId: REPLY }])
    expect(JSON.stringify(mocks.compiledHistory)).toContain('Earlier question')
    expect(JSON.stringify(mocks.compiledHistory)).toContain('Earlier answer')
    const [snapshot] = await executionViewerService.getSnapshots(sessionId)
    expect(snapshot?.id).toBe(REPLY)
    expect(snapshot?.executionMetadata?.promptBudget).toMatchObject({
      contextLimit: null,
      contextWindowWarning: CONTEXT_READ_WARNING
    })
  }, 30_000)

  it('records the preset context limit without a warning when there is no failed read', async () => {
    const response = await send(runtime)

    expect(response.status).toBe(200)
    expect(mocks.runs).toEqual([{ lane: runtime, messageId: REPLY }])
    expect(JSON.stringify(mocks.compiledHistory)).toContain('Earlier question')
    expect(JSON.stringify(mocks.compiledHistory)).toContain('Earlier answer')
    const [snapshot] = await executionViewerService.getSnapshots(sessionId)
    expect(snapshot?.id).toBe(REPLY)
    expect(snapshot?.executionMetadata?.promptBudget).toMatchObject({
      contextLimit: agentConfig(runtime).contextWindow,
      contextWindowWarning: null
    })
  }, 30_000)

  it('context-preview returns an unknown limit and warning when its second Execution Viewer read fails', async () => {
    let executionLogReads = 0
    const failure = failRedisJsonGets((key) => {
      if (key !== `session:${sessionId}:execution_log`) return false
      executionLogReads += 1
      return executionLogReads === 2
    })

    const response = await preview(runtime)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(executionLogReads).toBe(2)
    expect(failure.failures).toBe(1)
    expect(body.tokens).toEqual(expect.any(Number))
    expect(body.tokens).toBeGreaterThan(0)
    expect(body.budget).toMatchObject({
      contextLimit: null,
      contextWindowWarning: CONTEXT_READ_WARNING
    })
    expect(Number.isFinite(body.budget.contextWindowCheckedAt)).toBe(true)
    expect(body.budget.contextWindowCheckedAt).toBeGreaterThan(0)
    expect(mocks.runs).toEqual([])
  }, 30_000)

  it('context-preview keeps the preset context limit when no report read fails', async () => {
    const response = await preview(runtime)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.tokens).toEqual(expect.any(Number))
    expect(body.tokens).toBeGreaterThan(0)
    expect(body.budget).toMatchObject({
      contextLimit: agentConfig(runtime).contextWindow,
      contextWindowWarning: null
    })
    expect(Number.isFinite(body.budget.contextWindowCheckedAt)).toBe(true)
    expect(body.budget.contextWindowCheckedAt).toBeGreaterThan(0)
    expect(mocks.runs).toEqual([])
  }, 30_000)

  it('BL-991: forged request metadata cannot supply the bridge context selection', async () => {
    const response = await send(runtime, { cliContextSelection: {
      model: 'forged-model', presetContextWindow: 999_999_999, settingsKey: 'forged-key',
      priorReport: { runtime: 'claude', model: 'forged-model', contextWindow: 999_999_999, evidence: 'runtime' }
    } })
    expect(response.status).toBe(200)
    if (runtime === 'claude') expect(mocks.contextSelections[0]).toMatchObject({
      model: 'sonnet', presetContextWindow: agentConfig(runtime).contextWindow, priorReport: null
    })
    else expect(mocks.contextSelections[0]).toBeUndefined()
    expect(JSON.stringify(mocks.contextSelections)).not.toContain('forged')
    expect(JSON.stringify(mocks.contextSelections)).not.toContain('999999999')
  }, 30_000)
})
