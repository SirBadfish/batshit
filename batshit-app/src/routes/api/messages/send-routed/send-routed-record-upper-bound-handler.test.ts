// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests, abortStream } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { followUpTurnMetadata, pickSendFacts } from '$lib/server/services/steerPromotion'
import { env } from '$env/dynamic/private'

/**
 * BL-941 through the real send-routed handler on the Redis fake: the agent's record is the upper
 * bound of a Codex or Claude run. The chat bar's mode (`metadata.codexPermissionMode`,
 * `metadata.claudePermissionMode`) can make a run tighter than the record, never looser; when the
 * record made it tighter, the saved reply says so (`modeLimitedByAgentSettings`).
 *
 * Faked: the compiler's output and the two bridges, which record the runtime settings the route
 * built for each run and stream a short answer. `/api/sse` is not reached (the event fetch answers
 * every forward), so each reply is saved from the route's own copy.
 */

const USER = 'user-bl941'
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
    streamedFirstWords: false
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
  await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-941', agent_id: agentId } as any)
}

describe('send-routed: the record is the upper bound of a CLI run (BL-941, the real handler)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl941-${count}`
    mocks.state.runs = []
    mocks.state.groupReplies = false
    mocks.state.failAfterRetract = false
    mocks.state.waitForStop = false
    mocks.state.streamedFirstWords = false
    mocks.state.resumePlan = null
    mocks.state.approvalRequest = false
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = 'test-internal-token-bl941'
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The real client merges a saved message's metadata into the stored record and keeps its
    // date (`redis.ts` saveMessage); the default lane's fake replaces the record. A failed reply
    // is saved by two writers (the stream's failure path, then the request's), so this file uses
    // the real rule.
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
    await redis.set(`model:${API_PRESET}`, {
      id: API_PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (fakeSaveMessage) vi.mocked((redis as any).saveMessage).mockImplementation(fakeSaveMessage)
    delete (redis as any).getGroup
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('A: the record holds Agent with Read-only and the send carries Agent: the run is read-only, with no note', async () => {
    await createCodexAgent(CODEX_A, codexBlock('agent', 'read-only'))
    await openSession(CODEX_A)
    expect((await send(CODEX_A, { codexPermissionMode: 'agent' })).status).toBe(200)

    expect(mocks.state.runs).toHaveLength(1)
    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'agent', sandbox: 'read-only' })
    const saved = await stored(REPLY)
    expect(saved.content).toBe('Done.')
    expect(saved.metadata.modeLimitedByAgentSettings).toBeUndefined()
  }, 30_000)

  it('C: an older window sends Agent to a record that holds Chat: Chat runs, and the reply holds the note', async () => {
    await createCodexAgent(CODEX_A, codexBlock('chat', 'read-only'))
    await openSession(CODEX_A)
    expect((await send(CODEX_A, { codexPermissionMode: 'agent' })).status).toBe(200)

    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'chat', sandbox: 'read-only' })
    expect((await stored(REPLY)).metadata.modeLimitedByAgentSettings).toEqual({
      program: 'Codex', sentMode: 'agent', ranMode: 'chat', sandbox: 'read-only'
    })
  }, 30_000)

  it('C for Claude: a sent Edit automatically to a record with Plan runs Plan, with the note', async () => {
    await createClaudeAgent(CLAUDE_A, claudeBlock('plan'))
    await openSession(CLAUDE_A)
    expect((await send(CLAUDE_A, { claudePermissionMode: 'acceptEdits' })).status).toBe(200)

    expect(mocks.state.runs[0]).toMatchObject({ lane: 'claude', settings: { permissionMode: 'plan' } })
    expect((await stored(REPLY)).metadata.modeLimitedByAgentSettings).toEqual({
      program: 'Claude Code', sentMode: 'acceptEdits', ranMode: 'plan'
    })
  }, 30_000)

  it('D: a send tighter than the record runs the sent mode, with no note', async () => {
    await createCodexAgent(CODEX_A, codexBlock('agent_full', 'danger-full-access'))
    await openSession(CODEX_A)
    expect((await send(CODEX_A, { codexPermissionMode: 'agent' })).status).toBe(200)

    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'agent', sandbox: 'workspace-write' })
    expect((await stored(REPLY)).metadata.modeLimitedByAgentSettings).toBeUndefined()
  }, 30_000)

  it('E: isolated test driver sends Chat to a record with Agent (full access): read-only, as before', async () => {
    await createCodexAgent(CODEX_A, codexBlock('agent_full', 'danger-full-access'))
    await openSession(CODEX_A)
    expect((await send(CODEX_A, { codexPermissionMode: 'chat' })).status).toBe(200)

    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'chat', sandbox: 'read-only' })
    expect((await stored(REPLY)).metadata.modeLimitedByAgentSettings).toBeUndefined()
  }, 30_000)

  it('F: a send with no mode: the record decides, its saved level as it is', async () => {
    await createCodexAgent(CODEX_A, codexBlock('chat', 'workspace-write'))
    await openSession(CODEX_A)
    expect((await send(CODEX_A, {})).status).toBe(200)

    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'chat', sandbox: 'workspace-write' })
    expect((await stored(REPLY)).metadata.modeLimitedByAgentSettings).toBeUndefined()
  }, 30_000)

  it('a Stop keeps the note on the stopped reply', async () => {
    await createCodexAgent(CODEX_A, codexBlock('chat', 'read-only'))
    await openSession(CODEX_A)
    mocks.state.waitForStop = true
    const pending = send(CODEX_A, { codexPermissionMode: 'agent_full' })
    await vi.waitFor(() => expect(mocks.state.streamedFirstWords).toBe(true), { timeout: 10_000 })
    expect(abortStream(SESSION, 'user').ok).toBe(true)
    await pending

    const saved = await stored(REPLY)
    expect(saved.content).toBe('First words')
    expect(saved.metadata.interrupted).toBe(true)
    expect(saved.metadata.modeLimitedByAgentSettings).toEqual({
      program: 'Codex', sentMode: 'agent_full', ranMode: 'chat', sandbox: 'read-only'
    })
  }, 30_000)

  it('a failure after the only words were taken back keeps both notes (BL-958 c)', async () => {
    await createCodexAgent(CODEX_A, codexBlock('chat', 'read-only'))
    await openSession(CODEX_A)
    mocks.state.failAfterRetract = true
    await send(CODEX_A, { codexPermissionMode: 'agent' })

    const saved = await stored(REPLY)
    expect(saved.status).toBe('error')
    expect(saved.metadata.response_failed).toBe(true)
    expect(saved.metadata.restartedAfterLostConnection).toEqual({ program: 'Codex' })
    expect(saved.metadata.modeLimitedByAgentSettings).toEqual({
      program: 'Codex', sentMode: 'agent', ranMode: 'chat', sandbox: 'read-only'
    })
  }, 30_000)

  describe('R5: Tool Approval; the record is the upper bound on a CLI lane (all is tighter than off)', () => {
    it('a record with On Request and a send that names off: the run asks (all)', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'), { tool_approval_mode: 'all' })
      await openSession(CODEX_A)
      mocks.state.approvalRequest = true
      expect((await send(CODEX_A, { codexPermissionMode: 'agent', toolApprovalMode: 'off' })).status).toBe(200)
      expect(mocks.state.runs[0].toolApprovalMode).toBe('all')
      // The card summary saved with the reply names the mode the run used.
      expect((await stored(REPLY)).metadata.toolApprovals).toMatchObject({ mode: 'all', approvals: [{ approvalId: 'ap-r5' }] })
    }, 30_000)

    it('a record with Never and a send that names all: the run asks (tighter than the record)', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent', 'workspace-write'), { tool_approval_mode: 'off' })
      await openSession(CODEX_A)
      expect((await send(CODEX_A, { codexPermissionMode: 'agent', toolApprovalMode: 'all' })).status).toBe(200)
      expect(mocks.state.runs[0].toolApprovalMode).toBe('all')
    }, 30_000)

    it('the same for Claude, and a send that names none keeps the record', async () => {
      await createClaudeAgent(CLAUDE_A, claudeBlock('acceptEdits'), { tool_approval_mode: 'all' })
      await openSession(CLAUDE_A)
      expect((await send(CLAUDE_A, { claudePermissionMode: 'acceptEdits', toolApprovalMode: 'off' })).status).toBe(200)
      expect((await send(CLAUDE_A, { claudePermissionMode: 'acceptEdits' }, 'msg-reply-bl941-2')).status).toBe(200)
      expect(mocks.state.runs.map((run) => run.toolApprovalMode)).toEqual(['all', 'all'])
    }, 30_000)

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

  it('R6: an approval click carries no mode; the turn it starts runs with the record as it is', async () => {
    await createCodexAgent(CODEX_A, codexBlock('chat', 'workspace-write'))
    await openSession(CODEX_A)
    // The paused turn's user message (which carried a mode) and the card's reply.
    await redis.saveMessage({
      id: 'msg-user-card', session_id: SESSION, user_id: USER, agent_id: CODEX_A, role: 'user', content: 'Run it.',
      created_at: '2026-09-29T09:00:00.000Z', metadata: { codexPermissionMode: 'chat' }
    } as any)
    await redis.saveMessage({
      id: CARD, session_id: SESSION, user_id: USER, agent_id: CODEX_A, role: 'assistant', content: 'May I?',
      created_at: '2026-09-29T09:00:01.000Z',
      metadata: { toolApprovals: { mode: 'all', source: 'codex', approvals: [{ approvalId: 'ap-1', status: 'pending', control: { approvalId: 'apr_1' } }] } }
    } as any)
    mocks.state.resumePlan = {
      mode: 'resume-turn', cardMessageId: CARD, approved: [{ recordId: 'apr_1', controlId: 'files.write', controlTitle: 'Write a file' }], denied: []
    }
    // The page posts the paused REPLY's metadata with the answer: no mode.
    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION, agentId: CODEX_A, agentType: 'cli', content: '', messageId: CARD,
          messages: [],
          metadata: { toolApprovalResponse: [{ approvalId: 'ap-1', approved: true }] }
        })
      }),
      fetch: eventFetch,
      locals: { user: { id: USER } }
    } as any)
    expect(response.status).toBe(200)
    expect(mocks.state.runs).toHaveLength(1)
    // No sent mode: Chat with the saved Workspace write (a sent Chat would have given read-only).
    expect(mocks.state.runs[0].settings).toMatchObject({ permissionMode: 'chat', sandbox: 'workspace-write', permissionOverridden: false })
    expect(mocks.state.runs[0].settings.modeLimitedByAgentSettings).toBeUndefined()
  }, 30_000)

  describe('B: a group chat gives each member the sender’s mode; each member’s own record bounds it', () => {
    async function openGroup(driver: string, member: string) {
      ;(redis as any).getGroup = vi.fn(async (id: string) => redis.execute((client: any) => client.json.get(`group:${id}`)))
      await redis.execute((client: any) =>
        client.json.set(`group:${GROUP}`, '$', {
          id: GROUP, user_id: USER, name: 'BL-941 group', agent_ids: [driver, member], driver_mode: true, driver_agent_id: driver, max_followups_total: 1
        })
      )
      await openSession(driver)
      await redis.execute((client: any) => client.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: GROUP } }))
      mocks.state.groupReplies = true
    }

    async function memberReply(agentId: string) {
      const messages = (await redis.getMessages(SESSION, 50)) as any[]
      return messages.find((message) => message.role === 'assistant' && message.agent_id === agentId)
    }

    it('two Codex members; the send carries Agent (full access); member 2 holds Chat: member 2 runs read-only in Chat, with the note', async () => {
      await createCodexAgent(CODEX_A, codexBlock('agent_full', 'danger-full-access'))
      await createCodexAgent(CODEX_B, codexBlock('chat', 'read-only'))
      await openGroup(CODEX_A, CODEX_B)
      expect((await send(CODEX_A, { codexPermissionMode: 'agent_full' }, 'msg-group-user-1')).status).toBe(200)

      const byAgent = Object.fromEntries(mocks.state.runs.map((run) => [run.agentId, run.settings]))
      expect(byAgent[CODEX_A]).toMatchObject({ permissionMode: 'agent_full', sandbox: 'danger-full-access' })
      expect(byAgent[CODEX_B]).toMatchObject({ permissionMode: 'chat', sandbox: 'read-only' })
      expect((await memberReply(CODEX_A))?.metadata?.modeLimitedByAgentSettings).toBeUndefined()
      expect((await memberReply(CODEX_B))?.metadata?.modeLimitedByAgentSettings).toEqual({
        program: 'Codex', sentMode: 'agent_full', ranMode: 'chat', sandbox: 'read-only'
      })
    }, 60_000)

    it('two Claude members; the send carries Bypass permissions; member 2 holds Ask before edits: member 2 runs default, with the note', async () => {
      await createClaudeAgent(CLAUDE_A, claudeBlock('bypassPermissions'))
      await createClaudeAgent(CLAUDE_B, claudeBlock('default'))
      await openGroup(CLAUDE_A, CLAUDE_B)
      expect((await send(CLAUDE_A, { claudePermissionMode: 'bypassPermissions' }, 'msg-group-user-1')).status).toBe(200)

      const byAgent = Object.fromEntries(mocks.state.runs.map((run) => [run.agentId, run.settings]))
      expect(byAgent[CLAUDE_A]).toMatchObject({ permissionMode: 'bypassPermissions' })
      expect(byAgent[CLAUDE_B]).toMatchObject({ permissionMode: 'default' })
      expect((await memberReply(CLAUDE_A))?.metadata?.modeLimitedByAgentSettings).toBeUndefined()
      expect((await memberReply(CLAUDE_B))?.metadata?.modeLimitedByAgentSettings).toEqual({
        program: 'Claude Code', sentMode: 'bypassPermissions', ranMode: 'default'
      })
    }, 60_000)
  })
})

describe('G: the turns that carry a send’s mode without a chat bar keep it, so the same rule bounds them', () => {
  it('a promoted steer keeps the send\'s modes, and held words keep the modes their own user message stored (SEND_FACT_KEYS); a click itself carries none (R6)', () => {
    const facts = pickSendFacts({ codexPermissionMode: 'agent_full', claudePermissionMode: 'bypassPermissions', wake: { chainDepth: 1 } })
    expect(facts).toMatchObject({ codexPermissionMode: 'agent_full', claudePermissionMode: 'bypassPermissions' })
    expect(followUpTurnMetadata({ codexPermissionMode: 'agent', claudePermissionMode: 'plan' }, ['steer_a'])).toMatchObject({
      codexPermissionMode: 'agent',
      claudePermissionMode: 'plan'
    })
  })
})
