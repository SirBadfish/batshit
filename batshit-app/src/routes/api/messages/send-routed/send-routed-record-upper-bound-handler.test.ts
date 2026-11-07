// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { followUpTurnMetadata } from '$lib/server/services/steerPromotion'
import { pickSendFacts } from '$lib/utils/sendFacts'
import { env } from '$env/dynamic/private'

/**
 * BL-941 through the real send-routed handler on the Redis fake. BL-941 made the agent's record
 * the upper bound of a Claude Code CLI run; SA-139 R4 retired that lane, so its cases went with
 * it. What stays is the API lane's own rule for Tool Approval (R5): the send first, then the
 * record.
 *
 * Faked: the compiler's output and the lanes (the API brain, and the Claude bridge as a tripwire:
 * nothing may reach it), which record the runtime settings the route built for each run and
 * stream a short answer. `/api/sse` is not reached (the event fetch answers every forward), so
 * each reply is saved from the route's own copy.
 */

const USER = 'user-bl941'
const API_PRESET = 'preset-bl941-api'
const API_AGENT = 'agent-bl941-api'
const REPLY = 'msg-reply-bl941'

const mocks = vi.hoisted(() => {
  const state = {
    runs: [] as Array<{ lane: 'claude' | 'api'; agentId: string; settings: any; toolApprovalMode: unknown }>
  }
  function fakeRun(lane: 'claude' | 'api', request: any) {
    const settings = lane === 'claude' ? request.claudeSettings : null
    state.runs.push({
      lane,
      agentId: request.agentId,
      settings: settings ? structuredClone(settings) : null,
      toolApprovalMode: request.toolApprovalMode
    })
    const answer = 'Done.'
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    async function* stream() {
      yield { type: 'start' }
      yield { type: 'start-step', request: {}, warnings: [] }
      yield { type: 'text-start', id: 't1' }
      yield { type: 'text-delta', id: 't1', text: answer }
      yield { type: 'text-end', id: 't1' }
      yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
      await request.onFinish?.({ text: answer, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
      yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
    }
    return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
  }
  return { state, fakeRun }
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

    async buildFormattedChatInput() {
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Answer me.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

// SA-139 R5: the Claude Code bridge module is gone, so no run can reach it (its mock went with it).
vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      return mocks.fakeRun('api', request)
    }
  }
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => {}) }
})

useRedisTestServer()

const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined
let POST: (event: any) => Promise<Response>
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

/** Every forward to `/api/sse` answers success; nothing else is called. */
const eventFetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))

async function openSession(agentId: string) {
  await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-941', agent_id: agentId } as any)
}

describe('send-routed: Tool Approval on the API lane (BL-941 R5, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl941-${count}`
    mocks.state.runs = []
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = 'test-internal-token-bl941'
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${API_PRESET}`, {
      id: API_PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('an API agent keeps its own rule: the send first, then the record', async () => {
    await redis.createAgent({ id: API_AGENT, user_id: USER, name: 'Lark', displayName: 'Lark', agentType: 'api', primary_model_preset_id: API_PRESET, tool_approval_mode: 'all' } as any)
    await openSession(API_AGENT)
    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION, agentId: API_AGENT, agentType: 'api', content: 'Answer me.', messageId: REPLY,
          messages: [{ id: `msg-user-${count}`, role: 'user', content: 'Answer me.' }],
          metadata: { toolApprovalMode: 'off' }
        })
      }),
      fetch: eventFetch,
      locals: { user: { id: USER } }
    } as any)
    expect(response.status).toBe(200)
    expect(mocks.state.runs[0]).toMatchObject({ lane: 'api', toolApprovalMode: 'off' })
  }, 30_000)
})

describe('G: the turns that carry a send’s mode without a chat bar keep it, so the same rule bounds them', () => {
  it('a promoted steer keeps the send\'s modes, and held words keep the modes their own user message stored (SEND_FACT_KEYS); a click itself carries none (R6)', () => {
    const facts = pickSendFacts({ claudePermissionMode: 'bypassPermissions', wake: { chainDepth: 1 } })
    expect(facts).toMatchObject({ claudePermissionMode: 'bypassPermissions' })
    expect(followUpTurnMetadata({ claudePermissionMode: 'plan' }, ['steer_a'])).toMatchObject({
      claudePermissionMode: 'plan'
    })
  })
})
