// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests, enqueueSteer } from '$lib/server/services/steerInboxRegistry'
import { __resetTurnOutcomesForTests, watchTurnOutcome, type TurnOutcome } from '$lib/server/services/turnOutcomeRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { env } from '$env/dynamic/private'

/**
 * BL-965 through the real send-routed handler on the Redis fake: the agent's record is read again
 * at the start of each turn. A send that waits (in the chat's line, as a promoted follow-up, as a
 * later speaker of a group round) used the copy the request read when it arrived, so a record
 * made tighter during the wait (Settings, the chat bar, another window) did not bound the run:
 * the older, looser copy ran. BL-941 made the record the upper bound of a Codex or Claude run;
 * this makes it the record as it is when the turn starts.
 *
 * Faked: the compiler's output and the two bridges, which record the runtime settings the route
 * built for each run (and can change the record while a run is on), and the `/api/sse` forwards.
 */

const USER = 'user-bl965'
const CODEX_A = 'agent-bl941-codex-a'
const CODEX_B = 'agent-bl941-codex-b'
const CLAUDE_A = 'agent-bl941-claude-a'
const CLAUDE_B = 'agent-bl941-claude-b'
const CODEX_PRESET = 'preset-bl941-codex'
const CLAUDE_PRESET = 'preset-bl941-claude'
const API_PRESET = 'preset-bl941-api'
const API_AGENT = 'agent-bl941-api'
const CARD = 'msg-card-bl941'
const GROUP = 'group-bl941'
const REPLY = 'msg-reply-bl941'

const mocks = vi.hoisted(() => {
  const state = {
    runs: [] as Array<{ lane: 'codex' | 'claude' | 'api'; agentId: string; settings: any; toolApprovalMode: unknown }>,
    /** The run asks for an approval before it answers (R5: the card summary's mode). */
    approvalRequest: false,
    /** What a control approval click plans (R6); null for every other request. */
    resumePlan: null as any,
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
  function fakeRun(lane: 'codex' | 'claude' | 'api', request: any) {
    const settings = lane === 'codex' ? request.codexSettings : lane === 'claude' ? request.claudeSettings : null
    state.runs.push({
      lane,
      agentId: request.agentId,
      settings: settings ? structuredClone(settings) : null,
      toolApprovalMode: request.toolApprovalMode
    })
    const answer = `${state.groupReplies ? '<batshit-group>{"mode":"responding"}</batshit-group>' : ''}Done.`
    const failAfterRetract = state.failAfterRetract
    const waitForStop = state.waitForStop
    const approvalRequest = state.approvalRequest
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const duringRun = state.duringRun
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

vi.mock('redis', () => ({
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

vi.mock('$lib/server/services/codexBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  CodexBridge: class {
    async streamNativeMode(request: any) {
      return mocks.fakeRun('codex', request)
    }
  }
}))

vi.mock('$lib/server/services/claudeBridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  ClaudeBridge: class {
    async streamNativeMode(request: any) {
      return mocks.fakeRun('claude', request)
    }
  }
}))

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      return mocks.fakeRun('api', request)
    }
  }
}))

// R6: a control approval click on a CLI lane starts a new turn; what the card's records decided is
// faked, the route's own click path is real.
vi.mock('$lib/server/services/brokerControlApprovals', async (importOriginal) => ({
  ...(await importOriginal<Record<string, any>>()),
  planControlApprovalResumeTurn: vi.fn(async () => mocks.state.resumePlan),
  settleControlApprovalCard: vi.fn(async () => undefined)
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
let count = 0
/** The default lane fake's own `saveMessage`, put back after each test. */
let fakeSaveMessage: ((message: any) => Promise<any>) | undefined

/** Every forward to `/api/sse` answers success; nothing else is called. */
const eventFetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))

function codexBlock(permissionMode: string, sandbox?: string) {
  return {
    permissionMode,
    model: 'gpt-6-astra',
    ...(sandbox ? { sandbox } : {}),
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

function claudeBlock(permissionMode: string) {
  return { permissionMode, model: 'sonnet', addDirs: [], allowedTools: [], disallowedTools: [] }
}

async function createCodexAgent(id: string, codexSettings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await redis.createAgent({
    id, user_id: USER, name: id, displayName: id, agentType: 'cli',
    primary_model_provider: 'codex', primary_model_name: 'gpt-6-astra', primary_model_preset_id: CODEX_PRESET,
    codex_settings: codexSettings, ...extra
  } as any)
}

async function createClaudeAgent(id: string, claudeSettings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await redis.createAgent({
    id, user_id: USER, name: id, displayName: id, agentType: 'cli',
    primary_model_provider: 'claude-cli', primary_model_name: 'sonnet', primary_model_preset_id: CLAUDE_PRESET,
    claude_settings: claudeSettings, ...extra
  } as any)
}

function send(agentId: string, metadata: Record<string, unknown>, messageId = REPLY): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId,
        agentType: 'cli',
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
        agentType: 'cli',
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
    mocks.state.groupReplies = false
    mocks.state.failAfterRetract = false
    mocks.state.waitForStop = false
    mocks.state.streamedFirstWords = false
    mocks.state.resumePlan = null
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
    await redis.set(`model:${CODEX_PRESET}`, {
      id: CODEX_PRESET, name: 'Codex', provider: 'codex', modelId: 'gpt-6-astra', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.set(`model:${CLAUDE_PRESET}`, {
      id: CLAUDE_PRESET, name: 'Claude Code', provider: 'claude-cli', modelId: 'sonnet', contextWindow: 200_000, capabilities: {}, settings: {}
    })
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
    await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'))
    await openSession(CODEX_A)
    expect((await send(CODEX_A, { codexPermissionMode: 'agent' })).status).toBe(200)

    expect(mocks.state.runs).toHaveLength(1)
    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'agent', sandbox: 'workspace-write' })
  }, 30_000)

  describe('a send that waits in the chat’s line', () => {
    it('Codex: the record is made Chat while the send waits: the send runs Chat, read-only, with the note', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'))
      await openSession(CODEX_A)

      const final = await bWaitsWhileTheRecordChanges(CODEX_A, { codexPermissionMode: 'agent' }, async () => {
        await setRecordPath(CODEX_A, '$.codex_settings', codexBlock('chat', 'read-only'))
      })

      expect(final.status).toBe(200)
      expect(mocks.state.runs).toHaveLength(2)
      // The first reply started before the change.
      expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'agent', sandbox: 'workspace-write' })
      expect(mocks.state.runs[1].settings).toMatchObject({ permissionMode: 'chat', sandbox: 'read-only' })
      expect((await stored('msg-b-reply'))?.metadata?.modeLimitedByAgentSettings).toEqual({
        program: 'Codex', sentMode: 'agent', ranMode: 'chat', sandbox: 'read-only'
      })
    }, 30_000)

    it('Codex: a saved Read-only level set while the send waits holds for it', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'))
      await openSession(CODEX_A)

      const final = await bWaitsWhileTheRecordChanges(CODEX_A, { codexPermissionMode: 'agent' }, async () => {
        await setRecordPath(CODEX_A, '$.codex_settings', codexBlock('agent', 'read-only'))
      })

      expect(final.status).toBe(200)
      expect(mocks.state.runs[1].settings).toMatchObject({ permissionMode: 'agent', sandbox: 'read-only' })
    }, 30_000)

    it('Claude: the record is made Plan while the send waits: the send runs Plan, with the note', async () => {
      await createClaudeAgent(CLAUDE_A, claudeBlock('acceptEdits'))
      await openSession(CLAUDE_A)

      const final = await bWaitsWhileTheRecordChanges(CLAUDE_A, { claudePermissionMode: 'acceptEdits' }, async () => {
        await setRecordPath(CLAUDE_A, '$.claude_settings', claudeBlock('plan'))
      })

      expect(final.status).toBe(200)
      expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'acceptEdits' })
      expect(mocks.state.runs[1].settings).toMatchObject({ permissionMode: 'plan' })
      expect((await stored('msg-b-reply'))?.metadata?.modeLimitedByAgentSettings).toEqual({
        program: 'Claude Code', sentMode: 'acceptEdits', ranMode: 'plan'
      })
    }, 30_000)

    it('Tool Approval set to all while the send waits holds for it', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'), { tool_approval_mode: 'off' })
      await openSession(CODEX_A)

      const final = await bWaitsWhileTheRecordChanges(CODEX_A, { codexPermissionMode: 'agent' }, async () => {
        await setRecordPath(CODEX_A, '$.tool_approval_mode', 'all')
      })

      expect(final.status).toBe(200)
      expect(mocks.state.runs[0].toolApprovalMode).toBe('off')
      expect(mocks.state.runs[1].toolApprovalMode).toBe('all')
    }, 30_000)

    it('the agent is deleted while the send waits: nothing more runs; the send is kept, Not sent, its words at the end of the chat', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'))
      await openSession(CODEX_A)

      const final = await bWaitsWhileTheRecordChanges(CODEX_A, { codexPermissionMode: 'agent' }, async () => {
        await removeAgentRecord(CODEX_A)
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

  it('a promoted follow-up turn: the record is made Chat during the first reply; the follow-up runs Chat, read-only, with the note', async () => {
    await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'))
    await openSession(CODEX_A)
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
      await redis.updateAgent(CODEX_A, { codex_settings: codexBlock('chat', 'read-only') } as any)
    }
    expect((await send(CODEX_A, { codexPermissionMode: 'agent' })).status).toBe(200)

    expect(mocks.state.runs).toHaveLength(2)
    // The first reply started before the change.
    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'agent', sandbox: 'workspace-write' })
    // The follow-up starts after it.
    expect(mocks.state.runs[1].settings).toMatchObject({ permissionMode: 'chat', sandbox: 'read-only' })
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

    it('Codex: member 2 is made Chat while member 1 speaks: member 2 runs Chat, read-only', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent_full', 'danger-full-access'))
      await createCodexAgent(CODEX_B, codexBlock('agent_full', 'danger-full-access'))
      await openGroup(CODEX_A, CODEX_B)
      mocks.state.duringRun = async (agentId) => {
        if (agentId === CODEX_A) await redis.updateAgent(CODEX_B, { codex_settings: codexBlock('chat', 'read-only') } as any)
      }
      expect((await send(CODEX_A, { codexPermissionMode: 'agent_full' }, 'msg-group-user-1')).status).toBe(200)

      const byAgent = Object.fromEntries(mocks.state.runs.map((run) => [run.agentId, run.settings]))
      expect(byAgent[CODEX_A]).toMatchObject({ permissionMode: 'agent_full', sandbox: 'danger-full-access' })
      expect(byAgent[CODEX_B]).toMatchObject({ permissionMode: 'chat', sandbox: 'read-only' })
    }, 60_000)

    it('member 2 is deleted while member 1 speaks: it does not run, and its turn is saved as a failed reply that says so', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent_full', 'danger-full-access'))
      await createCodexAgent(CODEX_B, codexBlock('agent_full', 'danger-full-access'))
      await openGroup(CODEX_A, CODEX_B)
      mocks.state.duringRun = async (agentId) => {
        if (agentId === CODEX_A) await removeAgentRecord(CODEX_B)
      }
      expect((await send(CODEX_A, { codexPermissionMode: 'agent_full' }, 'msg-group-user-1')).status).toBe(200)

      expect(mocks.state.runs.map((run) => run.agentId)).toEqual([CODEX_A])
      const failed = ((await redis.getMessages(SESSION, 50)) as any[]).find(
        (message) => message.role === 'assistant' && message.agent_id === CODEX_B
      )
      expect(failed?.metadata).toMatchObject({ response_failed: true, failedSpeakerAgentId: CODEX_B, groupChat: true })
      expect(String(failed?.content ?? failed?.metadata?.error_message)).toContain('was deleted or changed before its turn')
    }, 60_000)

    it('Claude: member 2 is made Plan while member 1 speaks: member 2 runs Plan', async () => {
      await createClaudeAgent(CLAUDE_A, claudeBlock('bypassPermissions'))
      await createClaudeAgent(CLAUDE_B, claudeBlock('bypassPermissions'))
      await openGroup(CLAUDE_A, CLAUDE_B)
      mocks.state.duringRun = async (agentId) => {
        if (agentId === CLAUDE_A) await redis.updateAgent(CLAUDE_B, { claude_settings: claudeBlock('plan') } as any)
      }
      expect((await send(CLAUDE_A, { claudePermissionMode: 'bypassPermissions' }, 'msg-group-user-1')).status).toBe(200)

      const byAgent = Object.fromEntries(mocks.state.runs.map((run) => [run.agentId, run.settings]))
      expect(byAgent[CLAUDE_A]).toMatchObject({ permissionMode: 'bypassPermissions' })
      expect(byAgent[CLAUDE_B]).toMatchObject({ permissionMode: 'plan' })
    }, 60_000)
  })
})
