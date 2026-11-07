// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests, enqueueSteer } from '$lib/server/services/steerInboxRegistry'
import { __resetTurnOutcomesForTests, watchTurnOutcome, type TurnOutcome } from '$lib/server/services/turnOutcomeRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { env } from '$env/dynamic/private'
import * as streamAbortRegistry from '$lib/server/services/streamAbortRegistry'
import * as memoryRecall from '$lib/server/services/memory/memoryRecall'
import { retiredPrimaryAgentRefusal } from '$lib/utils/primaryAgentType'

/**
 * BL-965 through the real send-routed handler on the Redis fake: the agent's record is read again
 * at the start of each turn. A send that waits (in the chat's line, as a promoted follow-up, as a
 * later speaker of a group round) used the copy the request read when it arrived, so a record
 * made tighter during the wait (Settings, the chat bar, another window) did not bound the run:
 * the older, looser copy ran. This makes it the record as it is when the turn starts.
 *
 * SA-139 R4: the Claude Code CLI Primary is retired, so every run here is the API lane; the
 * record field a run reads is its Tool Approval mode. A stored or requested `cli` Primary is
 * refused by type before anything runs (the describe at the end).
 *
 * Faked: the compiler's output and the lanes (the API brain, and the Claude bridge as a tripwire:
 * nothing may reach it), which record the runtime settings the route built for each run (and can
 * change the record while a run is on), and the `/api/sse` forwards.
 */

const USER = 'user-bl965'
const API_PRESET = 'preset-bl941-api'
const API_AGENT = 'agent-bl941-api'
const API_A = 'agent-bl965-api-a'
const API_B = 'agent-bl965-api-b'
const GROUP = 'group-bl941'
const REPLY = 'msg-reply-bl941'

const mocks = vi.hoisted(() => {
  const state = {
    runs: [] as Array<{ lane: 'claude' | 'api'; agentId: string; settings: any; toolApprovalMode: unknown;
      messageId: string; selectedGateways: string[]; toolSelections: string[]; model: string }>,
    exhaustFirstContext: false,
    duringCompile: null as null | (() => Promise<void>),
    /** How many compiles ran (the faked compiler's output was asked for). */
    compiles: 0,
    /** The run asks for an approval before it answers (R5: the card summary's mode). */
    approvalRequest: false,
    /** What a control approval click plans (R6); null for every other request. */
    /** A group speaker opens with the group control. */
    groupReplies: false,
    /** The run streams a fragment, takes it back, and then fails (BL-958 c). */
    failAfterRetract: false,
    /** The run streams its first words and then waits for a Stop. */
    waitForStop: false,
    streamedFirstWords: false,
    /** BL-965: runs while a run is on, before it answers (a record changed during a turn). */
    duringRun: null as null | ((agentId: string) => Promise<void>)
  }
  function fakeRun(lane: 'claude' | 'api', request: any) {
    const settings = lane === 'claude' ? request.claudeSettings : null
    state.runs.push({
      lane,
      agentId: request.agentId,
      settings: settings ? structuredClone(settings) : null,
      toolApprovalMode: request.toolApprovalMode,
      messageId: request.messageId,
      selectedGateways: [...(request.selectedGateways ?? [])], toolSelections: [...(request.toolSelections ?? [])], model: request.model
    })
    const answer = `${state.groupReplies ? '<batshit-group>{"mode":"responding"}</batshit-group>' : ''}Done.`
    const failAfterRetract = state.failAfterRetract
    const waitForStop = state.waitForStop
    const approvalRequest = state.approvalRequest
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const duringRun = state.duringRun
    const exhaust = state.exhaustFirstContext && state.runs.length === 1
    async function* stream() {
      yield { type: 'start' }
      yield { type: 'start-step', request: {}, warnings: [] }
      yield { type: 'text-start', id: 't1' }
      if (failAfterRetract) {
        yield { type: 'text-delta', id: 't1', text: 'Partial before the drop', segmentId: 'm1' }
        yield { type: 'text-retract', segmentId: 'm1', reason: 'retry', message: 'Reconnecting... 1/5' }
        throw new Error('The provider closed the stream.')
      }
      if (waitForStop) {
        yield { type: 'text-delta', id: 't1', text: 'First words' }
        state.streamedFirstWords = true
        await new Promise<void>((resolve) => {
          if (request.abortSignal?.aborted) return resolve()
          request.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw Object.assign(new Error('The run was stopped.'), { name: 'AbortError' })
      }
      if (approvalRequest) {
        yield { type: 'tool-approval-request', approvalId: 'ap-r5', toolCallId: 'call-r5', toolName: 'shell', input: { command: 'ls' } }
      }
      yield { type: 'text-delta', id: 't1', text: answer }
      if (exhaust) {
        if (duringRun) await duringRun(request.agentId)
        // A surviving provider wording (OpenAI's error code); the Codex CLI one left with R1.
        throw new Error('context_length_exceeded')
      }
      yield { type: 'text-end', id: 't1' }
      if (duringRun) await duringRun(request.agentId)
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
      mocks.state.compiles += 1
      await mocks.state.duringCompile?.()
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Answer me.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

// SA-139 R4 kept a tripwire here for the Claude Code bridge; R5 deleted that module, so no run can reach it.
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
/** The default lane fake's own `saveMessage`, put back after each test. */
let fakeSaveMessage: ((message: any) => Promise<any>) | undefined

/** Every forward to `/api/sse` answers success; nothing else is called. */
const eventFetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))

async function createApiAgent(id: string, extra: Record<string, unknown> = {}) {
  await redis.createAgent({
    id, user_id: USER, name: id, displayName: id, agentType: 'api',
    primary_model_provider: 'openai', primary_model_name: 'gpt-4o', primary_model_preset_id: API_PRESET,
    ...extra
  } as any)
}

function send(agentId: string, metadata: Record<string, unknown>, messageId = REPLY, agentType = 'api'): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId,
        agentType,
        content: 'Answer me.',
        messageId,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'Answer me.' }],
        metadata
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

async function openSession(agentId: string) {
  await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-965', agent_id: agentId } as any)
}


/** Every request this test started, until it has finished (its final answer, when answered early). */
let requests: Promise<unknown>[] = []
/** Every event forwarded to the tabs through the global fetch (the line's forwards). */
let forwards: Array<Record<string, any>> = []

function outcomeOf(turnId: string) {
  return new Promise<TurnOutcome>((resolve) => {
    watchTurnOutcome(turnId, USER, resolve)
  })
}

/**
 * A change another window makes to the record while a send waits, written straight to the store.
 * (The fake's `updateAgent` imports its planner on first use, and a dynamic import that starts
 * while a waiting request is parked deadlocks the test runner's module loader.)
 */
async function setRecordPath(agentId: string, path: string, value: unknown) {
  await redis.execute((client: any) => client.json.set(`agent:${agentId}`, path, value))
}

async function removeAgentRecord(agentId: string) {
  await redis.execute(async (client: any) => {
    await client.del(`agent:${agentId}`)
    await client.sRem(`user:${USER}:agents`, agentId)
  })
}

/**
 * B, the page's send of a message while the chat is busy: saved first, then posted at once with
 * `userMessageId` (respond-async). It is answered 202 and waits in the chat's line; its final
 * answer comes over the turn's outcome.
 */
async function sendWhileBusy(agentId: string, metadata: Record<string, unknown>): Promise<{ outcome: Promise<TurnOutcome> }> {
  const saved = {
    id: 'msg-b',
    session_id: SESSION,
    user_id: USER,
    agent_id: agentId,
    role: 'user',
    status: 'complete',
    content: 'Write the file.',
    created_at: new Date().toISOString(),
    metadata: { client_sent: true }
  }
  await redis.saveMessage(saved as any)
  const accepted = await POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId,
        agentType: 'api',
        content: 'Write the file.',
        messageId: 'msg-b-reply',
        userMessageId: 'msg-b',
        messages: [saved],
        metadata
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
  expect(accepted.status).toBe(202)
  expect(accepted.headers.get('preference-applied')).toBeTruthy()
  const { turnId } = (await accepted.clone().json()) as { turnId: string }
  const outcome = outcomeOf(turnId)
  requests.push(outcome)
  // Wrapped: an async function that returns a promise would be awaited through to B's END, and B
  // cannot end before the reply it waits behind, which is waiting for this.
  return { outcome }
}

/**
 * The first reply runs; while it runs, B is sent and waits in the line, and then `change` makes
 * the record tighter (Settings, the chat bar, another window). The first reply ends, B takes the
 * chat and runs. Answers B's final answer.
 */
async function bWaitsWhileTheRecordChanges(
  agentId: string,
  metadata: Record<string, unknown>,
  change: () => Promise<void>
): Promise<TurnOutcome> {
  let outcome: Promise<TurnOutcome> | null = null
  let first = true
  mocks.state.duringRun = async () => {
    if (!first) return
    first = false
    // B's request read the record when it arrived (before its 202 answer); the change comes
    // after that read and before B's turn can start (the first reply still holds the chat).
    ;({ outcome } = await sendWhileBusy(agentId, metadata))
    await change()
  }
  expect((await send(agentId, metadata)).status).toBe(200)
  if (!outcome) throw new Error('expected B to have been sent during the first reply')
  return outcome
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('send-routed: a turn that starts later reads the agent record again (BL-965, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl965-${count}`
    mocks.state.runs = []
    mocks.state.exhaustFirstContext = false
    mocks.state.duringCompile = null
    mocks.state.compiles = 0
    mocks.state.groupReplies = false
    mocks.state.failAfterRetract = false
    mocks.state.waitForStop = false
    mocks.state.streamedFirstWords = false
    mocks.state.approvalRequest = false
    mocks.state.duringRun = null
    requests = []
    eventFetch.mockClear()
    // The line's "Queued" forward and the promoted message's forward use the global fetch.
    forwards = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body ?? '{}'))
          if (body && typeof body.type === 'string') forwards.push(body)
        } catch {
          // not a JSON forward
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      })
    )
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = 'test-internal-token-bl965'
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    __resetTurnOutcomesForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const saveMock = vi.mocked((redis as any).saveMessage)
    fakeSaveMessage ??= saveMock.getMockImplementation()
    saveMock.mockImplementation(async (message: any) => {
      const existing =
        message?.session_id && message?.id
          ? ((await redis.execute((client: any) => client.json.get(`message:${message.session_id}:${message.id}`))) as any)
          : null
      return fakeSaveMessage!(
        existing
          ? { ...message, created_at: existing.created_at, metadata: { ...(existing.metadata ?? {}), ...(message.metadata ?? {}) } }
          : message
      )
    })
    await redis.set(`model:${API_PRESET}`, { id: API_PRESET, provider: 'openai', modelId: 'gpt-4o', settings: {}, capabilities: {} })
  })

  afterEach(async () => {
    mocks.state.duringRun = null
    __resetStreamAbortRegistryForTests()
    const started = requests
    requests = []
    await Promise.race([Promise.allSettled(started), tick(10_000)])
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (fakeSaveMessage) vi.mocked((redis as any).saveMessage).mockImplementation(fakeSaveMessage)
    delete (redis as any).getGroup
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
    __resetTurnOutcomesForTests()
  }, 20_000)

  it('control: a send that does not wait runs with the record as it was read', async () => {
    await createApiAgent(API_A, { tool_approval_mode: 'off' })
    await openSession(API_A)
    expect((await send(API_A, {})).status).toBe(200)

    expect(mocks.state.runs).toHaveLength(1)
    expect(mocks.state.runs[0]).toMatchObject({ lane: 'api', toolApprovalMode: 'off' })
  }, 30_000)

  async function realGatewayBoundary() {
    const { buildDynamicOnlySelectionResetKey } = await import('$lib/server/services/mcpRuntimePolicy')
    const { buildGatewayReferenceCleanupKey } = await import('$lib/server/services/mcpGatewayReferenceCleanup')
    await redis.execute(async (client: any) => {
      await client.set(buildDynamicOnlySelectionResetKey(USER), 'existing-marker')
      await client.set(buildGatewayReferenceCleanupKey(USER), 'existing-marker')
    })
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    vi.spyOn(apiKeyService, 'retrieve').mockResolvedValue(null)
    const { mcpGatewayService } = await import('$lib/server/services/mcpGatewayService')
    vi.spyOn(mcpGatewayService, 'listEnabled').mockResolvedValue(['A', 'B'].map(id => ({ id, name: `Synthetic ${id}`, enabled: true, type: 'custom' } as any)))
    const { mcpGatewayDiscovery } = await import('$lib/server/services/mcpGatewayDiscovery')
    const discover = vi.spyOn(mcpGatewayDiscovery, 'discoverFromMultipleGateways').mockImplementation(async gateways =>
      gateways.map(gateway => ({ gatewayId: gateway.id, gatewayName: gateway.name, gatewayType: gateway.type,
        gateway, success: true, tools: [{ name: 'fresh-tool' }] } as any)))
    return { discover }
  }

  it('api context children preserve their lane-owned selection', async () => {
    await createApiAgent(API_AGENT, { defaultMCPGateways: ['A'], defaultMCPToolSelections: [] })
    await openSession(API_AGENT)
    const { discover } = await realGatewayBoundary()
    const selections = await import('$lib/server/services/mcpSelectionResolver')
    const resolve = vi.spyOn(selections, 'resolveMCPSelections')
    mocks.state.exhaustFirstContext = true
    mocks.state.duringRun = async () => {
      await setRecordPath(API_AGENT, '$.defaultMCPGateways', ['B'])
      await setRecordPath(API_AGENT, '$.defaultMCPToolSelections', ['fresh-tool'])
    }
    const result = await send(API_AGENT, {}, REPLY, 'api')
    const body = await result.clone().json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(mocks.state.runs).toHaveLength(2)
    expect(mocks.state.runs.map(run => run.lane)).toEqual(['api', 'api'])
    expect(mocks.state.runs[1].selectedGateways).toEqual(['A'])
    expect(mocks.state.runs[1].toolSelections).toEqual([])
    // The API ceiling is a private actual preparation, never a native task or
    // a scope/ready field supplied by this send's JSON.
    expect(resolve.mock.calls[0][0].mcpOriginalPreparation).toBeUndefined()
    expect(resolve.mock.calls[1][0].mcpOriginalPreparation).toBeDefined()
    expect(discover).toHaveBeenCalledTimes(0)
  }, 30_000)

  it('preserves the API late preset read after compile instead of hoisting its selection', async () => {
    await redis.set(`model:${API_PRESET}`, { id: API_PRESET, provider: 'openai', modelId: 'before-compile', settings: {}, capabilities: {} })
    await redis.createAgent({ id: API_AGENT, user_id: USER, name: API_AGENT, displayName: API_AGENT, agentType: 'api',
      primary_model_provider: 'openai', primary_model_name: 'before-compile', primary_model_preset_id: API_PRESET } as any)
    await openSession(API_AGENT)
    mocks.state.duringCompile = async () => { await redis.set(`model:${API_PRESET}`,
      { id: API_PRESET, provider: 'openai', modelId: 'after-compile', settings: {}, capabilities: {} }) }
    expect((await send(API_AGENT, {}, REPLY, 'api')).status).toBe(200)
    expect(mocks.state.runs[0]).toMatchObject({ lane: 'api', model: 'after-compile' })
  }, 30_000)

  describe('a send that waits in the chat’s line', () => {
    it('Tool Approval set to all while the send waits holds for it', async () => {
      await createApiAgent(API_A, { tool_approval_mode: 'off' })
      await openSession(API_A)

      const final = await bWaitsWhileTheRecordChanges(API_A, {}, async () => {
        await setRecordPath(API_A, '$.tool_approval_mode', 'all')
      })

      expect(final.status).toBe(200)
      expect(mocks.state.runs[0].toolApprovalMode).toBe('off')
      expect(mocks.state.runs[1].toolApprovalMode).toBe('all')
    }, 30_000)

    it('the agent is deleted while the send waits: nothing more runs; the send is kept, Not sent, its words at the end of the chat', async () => {
      await createApiAgent(API_A)
      await openSession(API_A)

      const final = await bWaitsWhileTheRecordChanges(API_A, {}, async () => {
        await removeAgentRecord(API_A)
      })

      expect(final.status).toBe(409)
      expect(JSON.parse(final.body)).toMatchObject({
        code: 'queued_send_kept',
        reason: 'agent_deleted',
        details: 'The agent was deleted before its turn came. Your message is in the chat, unanswered.'
      })
      expect(mocks.state.runs).toHaveLength(1)
      // Every tab: the "Queued" bubble first, then its "Not sent", then the words back in the chat.
      const lineEvents = forwards
        .filter((event) => ['steer_queued', 'queued_send_dropped', 'user_message'].includes(event.type))
        .map((event) => event.type)
      expect(lineEvents).toEqual(['steer_queued', 'queued_send_dropped', 'user_message'])
      expect(forwards.find((event) => event.type === 'queued_send_dropped')).toMatchObject({
        userMessageIds: ['msg-b'],
        reason: 'agent_deleted'
      })
      // The words are kept, after the reply they waited behind, unanswered.
      const ids = ((await redis.getMessages(SESSION, 50)) as any[]).map((message) => message.id)
      expect(ids.indexOf('msg-b')).toBeGreaterThan(ids.indexOf(REPLY))
      expect(ids).not.toContain('msg-b-reply')
    }, 30_000)
  })

  it('a promoted follow-up turn: Tool Approval is set to all during the first reply; the follow-up holds for it', async () => {
    await createApiAgent(API_A, { tool_approval_mode: 'off' })
    await openSession(API_A)
    let first = true
    mocks.state.duringRun = async () => {
      if (!first) return
      first = false
      // A message typed while the first reply runs waits for its end; the user makes the agent
      // tighter before the reply ends.
      const accepted = enqueueSteer(SESSION, {
        steerId: 'msg-queued-1',
        messageId: REPLY,
        text: 'Now write the file.',
        at: new Date().toISOString(),
        source: 'user',
        deliver: 'end'
      } as any)
      expect(accepted.ok).toBe(true)
      await setRecordPath(API_A, '$.tool_approval_mode', 'all')
    }
    expect((await send(API_A, {})).status).toBe(200)

    expect(mocks.state.runs).toHaveLength(2)
    // The first reply started before the change.
    expect(mocks.state.runs[0].toolApprovalMode).toBe('off')
    // The follow-up starts after it.
    expect(mocks.state.runs[1].toolApprovalMode).toBe('all')
  }, 30_000)

  describe('a group round: a later speaker reads its own record when its turn starts', () => {
    async function openGroup(driver: string, member: string) {
      ;(redis as any).getGroup = vi.fn(async (id: string) => redis.execute((client: any) => client.json.get(`group:${id}`)))
      await redis.execute((client: any) =>
        client.json.set(`group:${GROUP}`, '$', {
          id: GROUP, user_id: USER, name: 'BL-965 group', agent_ids: [driver, member], driver_mode: true, driver_agent_id: driver, max_followups_total: 1
        })
      )
      await openSession(driver)
      await redis.execute((client: any) => client.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: GROUP } }))
      mocks.state.groupReplies = true
    }

    it('member 2 is deleted while member 1 speaks: it does not run, and its turn is saved as a failed reply that says so', async () => {
      await createApiAgent(API_A)
      await createApiAgent(API_B)
      await openGroup(API_A, API_B)
      mocks.state.duringRun = async (agentId) => {
        if (agentId === API_A) await removeAgentRecord(API_B)
      }
      expect((await send(API_A, {}, 'msg-group-user-1')).status).toBe(200)

      expect(mocks.state.runs.map((run) => run.agentId)).toEqual([API_A])
      const failed = ((await redis.getMessages(SESSION, 50)) as any[]).find(
        (message) => message.role === 'assistant' && message.agent_id === API_B
      )
      expect(failed?.metadata).toMatchObject({ response_failed: true, failedSpeakerAgentId: API_B, groupChat: true })
      expect(String(failed?.content ?? failed?.metadata?.error_message)).toContain('was deleted or changed before its turn')
    }, 60_000)

    it('member 2 is set to Tool Approval all while member 1 speaks: member 2 holds for it', async () => {
      await createApiAgent(API_A, { tool_approval_mode: 'off' })
      await createApiAgent(API_B, { tool_approval_mode: 'off' })
      await openGroup(API_A, API_B)
      mocks.state.duringRun = async (agentId) => {
        if (agentId === API_A) await setRecordPath(API_B, '$.tool_approval_mode', 'all')
      }
      expect((await send(API_A, {}, 'msg-group-user-1')).status).toBe(200)

      const byAgent = Object.fromEntries(mocks.state.runs.map((run) => [run.agentId, run.toolApprovalMode]))
      expect(byAgent[API_A]).toBe('off')
      expect(byAgent[API_B]).toBe('all')
    }, 60_000)
  })

  /**
   * SA-139 R4 (D14): `cli` (the Claude Code CLI lane, and the Codex CLI lane R1 removed) is a
   * retired stored Primary type, like `n8n`. A send whose stored record OR request type is `cli`
   * is refused 409 `primary_agent_type_retired` with `retiredPrimaryAgentRefusal`'s sentence
   * before the session-turn lock, any Clip spend, the memory commit and the compile; nothing runs
   * on any lane and the route saves nothing. A group never makes a `cli` member a speaker, and a
   * speaker that turns out to be `cli` when its turn starts gets a failed turn that says so.
   *
   * The opt-in handler fixture supplies only this chat's strict raw session-root read.
   */
  describe('SA-139 R4: a send to a retired Claude Code CLI or Codex CLI Primary', () => {
    const CLI_AGENT = 'agent-sa139-r4-cli'
    const CODEX_AGENT = 'agent-sa139-codex'
    const GPT_CODEX_PRESET = 'preset-sa139-gpt-codex'
    const CODEX_CONNECTION = { type: 'direct', id: 'codex-cli', service: 'codex-cli' }
    let turnLock: ReturnType<typeof vi.spyOn>
    let queuedTurn: ReturnType<typeof vi.spyOn>
    let memoryCommit: ReturnType<typeof vi.spyOn>
    let reads: ReturnType<typeof vi.spyOn>

    /** A Claude Code CLI Primary as an older Batshit saved it: no record is migrated. */
    function claudeCliRecord(id: string) {
      return {
        id, user_id: USER, name: id, displayName: id, agentType: 'cli',
        primary_model_provider: 'claude-cli', primary_model_name: 'sonnet',
        claude_settings: { permissionMode: 'acceptEdits', model: 'sonnet', addDirs: [], allowedTools: [], disallowedTools: [] }
      }
    }

    /** A Codex CLI agent as an older Batshit saved it. */
    function codexCliRecord(id: string) {
      return {
        id, user_id: USER, name: id, displayName: id, agentType: 'cli',
        primary_model_provider: 'openai-codex', primary_model_name: 'codex', primary_model_connection: CODEX_CONNECTION,
        codex_settings: { permissionMode: 'agent', model: 'gpt-6-astra', sandbox: 'workspace-write' }
      }
    }

    beforeEach(() => {
      turnLock = vi.spyOn(streamAbortRegistry, 'registerSessionTurn')
      queuedTurn = vi.spyOn(streamAbortRegistry, 'queueSessionTurn')
      memoryCommit = vi.spyOn(memoryRecall, 'commitMemoryTurnState')
      // The fake's `get` is already a mock: count only this test's reads.
      reads = vi.spyOn(redis, 'get')
      for (const spy of [turnLock, queuedTurn, memoryCommit, reads]) spy.mockClear()
    })

    async function expectRefusedBeforeAnySideEffect(
      response: Response,
      expected: { error: string; details: string; code: string },
      sentence: string,
    ) {
      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body).toEqual({ error: expected.error, code: 'primary_agent_type_retired', details: expected.details })
      expect(expected.code).toBe('primary_agent_type_retired')
      expect(body.error).toBe(sentence)
      expect(turnLock).not.toHaveBeenCalled()
      expect(queuedTurn).not.toHaveBeenCalled()
      expect(streamAbortRegistry.getActiveSessionTurn(SESSION)).toBeNull()
      expect(reads.mock.calls.filter(([key]: unknown[]) => String(key).endsWith(':clip_state'))).toEqual([])
      expect(memoryCommit).not.toHaveBeenCalled()
      expect(mocks.state.compiles).toBe(0)
      expect(mocks.state.runs).toEqual([])
      expect(await stored(REPLY)).toBeNull()
      expect(await redis.getMessages(SESSION, 50)).toEqual([])
    }

    it('a stored Claude Code CLI record is refused 409 primary_agent_type_retired before anything runs', async () => {
      const record = claudeCliRecord(CLI_AGENT)
      await redis.createAgent(record as any)
      await openSession(CLI_AGENT)
      await expectRefusedBeforeAnySideEffect(
        await send(CLI_AGENT, { claudePermissionMode: 'acceptEdits' }, REPLY, 'cli'),
        retiredPrimaryAgentRefusal(record, 'cli')!,
        'The Claude Code CLI lane was removed from Batshit.',
      )
    }, 30_000)

    it('a body agentType of api does not run a stored cli record on the API brain', async () => {
      const record = claudeCliRecord(CLI_AGENT)
      await redis.createAgent(record as any)
      await openSession(CLI_AGENT)
      await expectRefusedBeforeAnySideEffect(
        await send(CLI_AGENT, {}, REPLY, 'api'),
        retiredPrimaryAgentRefusal(record, 'api')!,
        'The Claude Code CLI lane was removed from Batshit.',
      )
    }, 30_000)

    it('a body agentType of cli on an API agent is refused the same way: a request cannot ask for a retired type', async () => {
      await createApiAgent(API_AGENT)
      await openSession(API_AGENT)
      const record = (await redis.getAgents(USER)).find((agent: any) => agent.id === API_AGENT)
      expect(record?.agentType).toBe('api')
      await expectRefusedBeforeAnySideEffect(
        await send(API_AGENT, {}, REPLY, 'cli'),
        retiredPrimaryAgentRefusal(record, 'cli')!,
        'The Claude Code CLI lane was removed from Batshit.',
      )
    }, 30_000)

    it('a stored record that names Codex CLI gets the Codex sentence', async () => {
      const record = codexCliRecord(CODEX_AGENT)
      await redis.createAgent(record as any)
      await openSession(CODEX_AGENT)
      await expectRefusedBeforeAnySideEffect(
        await send(CODEX_AGENT, { codexPermissionMode: 'agent' }, REPLY, 'cli'),
        retiredPrimaryAgentRefusal(record, 'cli')!,
        'Codex CLI agents were removed from Batshit.',
      )
    }, 30_000)

    it('control: an API agent still dispatches to the API brain, through the lock, the commit and the compile', async () => {
      await createApiAgent(API_AGENT)
      await openSession(API_AGENT)
      const response = await send(API_AGENT, {})
      expect(response.status, await response.clone().text()).toBe(200)
      expect(mocks.state.runs.map(run => run.lane)).toEqual(['api'])
      expect(turnLock).toHaveBeenCalled()
      expect(memoryCommit).toHaveBeenCalled()
      expect(mocks.state.compiles).toBeGreaterThan(0)
    }, 30_000)

    it('an API agent on an OpenAI model whose id contains "codex" runs on the API brain', async () => {
      await redis.set(`model:${GPT_CODEX_PRESET}`, { id: GPT_CODEX_PRESET, provider: 'openai', modelId: 'gpt-5-codex', settings: {}, capabilities: {} })
      await redis.createAgent({ id: API_AGENT, user_id: USER, name: API_AGENT, displayName: API_AGENT, agentType: 'api',
        primary_model_provider: 'openai', primary_model_name: 'gpt-5-codex', primary_model_preset_id: GPT_CODEX_PRESET } as any)
      await openSession(API_AGENT)
      const response = await send(API_AGENT, {}, REPLY, 'api')
      expect(response.status, await response.clone().text()).toBe(200)
      expect(mocks.state.runs).toHaveLength(1)
      expect(mocks.state.runs[0]).toMatchObject({ lane: 'api', model: 'gpt-5-codex' })
    }, 30_000)

    describe('a group round', () => {
      async function openGroupOf(driver: string, members: string[]) {
        ;(redis as any).getGroup = vi.fn(async (id: string) => redis.execute((client: any) => client.json.get(`group:${id}`)))
        await redis.execute((client: any) =>
          client.json.set(`group:${GROUP}`, '$', {
            id: GROUP, user_id: USER, name: 'SA-139 group', agent_ids: [driver, ...members], driver_mode: true, driver_agent_id: driver, max_followups_total: 1
          })
        )
        await openSession(driver)
        await redis.execute((client: any) => client.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: GROUP } }))
        mocks.state.groupReplies = true
      }

      async function assistantRepliesOf(agentId: string) {
        return ((await redis.getMessages(SESSION, 50)) as any[]).filter(
          (message) => message.role === 'assistant' && message.agent_id === agentId
        )
      }

      it('skips a cli member: it is no speaker, and nothing of it runs or is saved', async () => {
        await createApiAgent(API_A)
        await createApiAgent(API_B)
        await redis.createAgent(claudeCliRecord(CLI_AGENT) as any)
        await openGroupOf(API_A, [CLI_AGENT, API_B])
        expect((await send(API_A, {}, 'msg-group-user-1')).status).toBe(200)

        expect(mocks.state.runs.map((run) => run.agentId)).toEqual([API_A, API_B])
        expect(mocks.state.runs.every((run) => run.lane === 'api')).toBe(true)
        expect(await assistantRepliesOf(CLI_AGENT)).toEqual([])
      }, 60_000)

      it('a cli member never counts as a speaker: a group of one live agent and one cli agent has too few to run', async () => {
        await createApiAgent(API_A)
        await redis.createAgent(claudeCliRecord(CLI_AGENT) as any)
        await openGroupOf(API_A, [CLI_AGENT])
        const response = await send(API_A, {}, 'msg-group-user-1')
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Group chat requires at least 2 agents.' })

        expect(mocks.state.runs).toEqual([])
        expect(await assistantRepliesOf(CLI_AGENT)).toEqual([])
      }, 60_000)

      it('a member made cli while member 1 speaks does not run; its turn is a failed reply that says so', async () => {
        await createApiAgent(API_A)
        await createApiAgent(API_B)
        await openGroupOf(API_A, [API_B])
        mocks.state.duringRun = async (agentId) => {
          if (agentId !== API_A) return
          await setRecordPath(API_B, '$.agentType', 'cli')
        }
        expect((await send(API_A, {}, 'msg-group-user-1')).status).toBe(200)

        expect(mocks.state.runs.map((run) => run.agentId)).toEqual([API_A])
        const [failed] = await assistantRepliesOf(API_B)
        const refusal = retiredPrimaryAgentRefusal({ agentType: 'cli' })!
        expect(failed?.metadata).toMatchObject({ response_failed: true, failedSpeakerAgentId: API_B, groupChat: true,
          error_code: 'primary_agent_type_retired' })
        expect(String(failed?.content ?? failed?.metadata?.error_message))
          .toContain(`${API_B} did not answer. ${refusal.error} ${refusal.details}`)
      }, 60_000)
    })
  })
})
