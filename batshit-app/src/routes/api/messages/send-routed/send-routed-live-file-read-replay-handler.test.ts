// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { resetLiveFileReadPermitsForTests } from '$lib/server/services/liveFileReadSnapshot.server'
import { liveFileReadReplayTimersForTests, readLiveFileReadReplay, type LiveFileReadSnapshot, type LiveReadCandidate } from '$lib/server/services/liveFileReadTurn.server'
import { sealLiveFileReadReplay } from '$lib/server/services/fileReadProofSeal'
import { keepAnsweredApprovals } from '$lib/server/services/toolApprovalState'

/**
 * SA-137 P2 (D2, D5, D7), through the real handler: an API turn with live file reads on reads its
 * open copy once at turn start through the compile; a reply that stops at an approval card keeps
 * that call's own snapshot on the paused record, sealed and never sent to a tab; the click's resume
 * replays those exact bytes and reads nothing; a changed snapshot refuses the resume before any
 * model call; the end of the resumed reply clears it; with the setting off nothing is written; a
 * Stop during the reads ends the turn before any model call.
 *
 * Faked, and only these: the compile's OUTPUT (it asks the turn's snapshot for one open copy of a
 * real file, as the canonical compile does, and records it) and the API lane's model. The reads
 * use the real anchored reader on a real temporary project.
 */

const USER = 'user-sa137'
const AGENT = 'agent-sa137-replay'
const PRESET = 'preset-sa137'
const FIRST_REPLY = 'msg-sa137-reply'
const READ_ZIP = 'cool_tool_1790000137099_replay'
const OTHER_AGENT = 'agent-sa137-other'
const DELETED_AGENT = 'agent-sa137-deleted'

type ModelRun = 'reply' | 'card' | 'card-odd-id' | 'fails' | 'exhausted'

const mocks = vi.hoisted(() => ({
  modelRuns: new Map<number, ModelRun>(),
  brainRuns: [] as string[],
  /** The turn each compile was given (undefined when the route gave none). */
  compiledTurn: [] as unknown[],
  /** The history each compile was given. */
  compiledHistory: [] as unknown[][],
  /** The snapshot each compile got from that turn. */
  snapshots: [] as Array<LiveFileReadSnapshot | null>,
  /** Builds the one open copy the compile offers the turn. */
  candidates: (() => []) as () => LiveReadCandidate[],
  root: '',
  /** Stop the request inside the compile, before the reads. */
  stopBeforeReads: false,
  abortRequest: null as null | (() => void),
  /** Runs when a model call starts (1-based), before it answers: lets a test change the saved agent mid-reply. */
  onBrainRun: null as null | ((run: number) => Promise<void> | void),
  /** Model requests that passed the route's last check and left (the mock's provider requests). */
  requestsSent: 0,
  /** Per model run: whether the route gave it a last check (`modelDispatchGate`). */
  lastChecks: [] as boolean[],
  /** Per model run: the compile's `refreshedFileReadsTurn` as the route handed it to the brain. */
  refreshedTurnFlags: [] as unknown[]
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
      _sessionId: string,
      _history: any[],
      _agent: unknown,
      _current: unknown,
      _subagents: unknown,
      _userId: unknown,
      options?: { liveFileReadTurn?: any; whiteboardContextSnapshot?: any; whiteboardMessageId?: string }
    ) {
      const turn = options?.liveFileReadTurn
      mocks.compiledTurn.push(turn)
      mocks.compiledHistory.push(_history)
      if (mocks.stopBeforeReads) mocks.abortRequest?.()
      mocks.snapshots.push(turn ? await turn.snapshotFor('appended', async () => mocks.candidates(), mocks.root) : null)
      return {
        primarySystemPrompt: 'You are a test agent.',
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId: _userId, sessionId: _sessionId, agentId: (_agent as any).id, messageId: options?.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'Hello from the compile.' }], metadata: {} },
        resolvedProjectPath: mocks.root,
        // As the canonical compile answers in the appended layout: this turn runs Refreshed File Reads.
        refreshedFileReadsTurn: Boolean(turn)
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      mocks.lastChecks.push(typeof request.modelDispatchGate?.beforeRequest === 'function')
      mocks.refreshedTurnFlags.push(request.refreshedFileReadsTurn)
      const result: any = await this.plannedRun(request)
      const planned = result.stream
      // As the real innermost model middleware does: the route's last check runs right before the
      // provider request leaves, after this run's setup; a refusal sends nothing (an error part).
      result.stream = (async function* () {
        try {
          await request.modelDispatchGate?.beforeRequest()
        } catch (error) {
          yield { type: 'start' }
          yield { type: 'error', error }
          return
        }
        mocks.requestsSent += 1
        request.modelDispatchGate?.requestSent()
        yield* planned
      })()
      return result
    }

    async plannedRun(request: any) {
      mocks.brainRuns.push(request.messageId)
      await mocks.onBrainRun?.(mocks.brainRuns.length)
      const plan = mocks.modelRuns.get(mocks.brainRuns.length) ?? 'reply'
      if (plan === 'exhausted') {
        // The window fills after some work: the route saves that partial reply and continues it.
        async function* filling() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Partial work before the window filled.' }
          yield { type: 'text-end', id: 't1' }
          yield { type: 'error', error: Object.assign(new Error("This model's maximum context length is 131072 tokens."), { code: 'context_length_exceeded', statusCode: 400 }) }
        }
        return { stream: filling(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      if (plan === 'fails') {
        // The provider fails inside the stream, before any text or tool.
        async function* failing() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'error', error: Object.assign(new Error('Provider exploded before any text.'), { statusCode: 500 }) }
        }
        return { stream: failing(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
      }
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      if (plan === 'card' || plan === 'card-odd-id') {
        const callId = `call_ls_${mocks.brainRuns.length}`
        const approvalId = plan === 'card' ? `aitxt-sa137-${mocks.brainRuns.length}` : `odd id ${mocks.brainRuns.length}`
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
          await request.onFinish?.({ text: 'I need to list the folder.', steps: [], totalUsage: usage, usage, reasoning: [],
            responseMessages: [{ role: 'assistant', content: parts }] })
          yield { type: 'finish', finishReason: 'tool-calls', totalUsage: usage }
        }
        return { stream: paused(), content: Promise.resolve(parts), steps: Promise.resolve([]),
          response: Promise.resolve({ messages: [{ role: 'assistant', content: parts }] }) }
      }
      const text = `Reply for ${request.messageId}.`
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

let POST: (event: any) => Promise<Response>
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0
let forwards: Array<Record<string, any>> = []
let rootIdentity = ''

function post(body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController()
  mocks.abortRequest = () => controller.abort()
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', ...body }),
      signal: controller.signal
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

const userMessage = () => ({ id: 'msg-user-1', session_id: SESSION, user_id: USER, role: 'user', content: 'Read a.js, then list the folder.',
  created_at: '2026-10-21T01:00:00.000Z', metadata: {} })

function send(): Promise<Response> {
  return post({ content: 'Read a.js, then list the folder.', messageId: FIRST_REPLY, messages: [userMessage()] })
}

async function stored(id = FIRST_REPLY): Promise<any> {
  return redis.json.get(`message:${SESSION}:${id}`)
}

/** The page's own Approve click on the paused card, with what the page holds (no replay fields). */
async function click(): Promise<Response> {
  const card = await stored()
  const { liveFileReadSnapshot: _l, whiteboardContextSnapshot: _w, ...pageMetadata } = card.metadata
  const approvalId = card.metadata.toolApprovals.approvals[0].approvalId
  return post({
    content: '',
    messageId: FIRST_REPLY,
    messages: [userMessage(), { ...card, metadata: pageMetadata }],
    metadata: {
      ...pageMetadata,
      toolApprovalMode: 'all',
      toolApprovalResponse: [{ type: 'tool-approval-response', approvalId, approved: true, reason: 'User approved' }]
    }
  })
}

function openCopy(options: { zip?: string; file?: string; readerAgentId?: string } = {}): LiveReadCandidate {
  const file = options.file ?? 'a.js'
  const zip = options.zip ?? READ_ZIP
  return {
    rawZipId: zip,
    zipId: zip,
    source: {
      version: 1,
      owner: { userId: USER, agentId: options.readerAgentId ?? AGENT, sessionId: SESSION, messageId: 'msg-read', toolCallId: 'call-read' },
      backend: 'local',
      workspaceRoot: mocks.root,
      rootIdentity,
      cwd: mocks.root,
      locator: file,
      view: { kind: 'whole', numbering: 'none' },
      liveReadsOn: true
    },
    payload: {
      toolName: 'read_file',
      originalToolName: 'native_bash_execute',
      operationKind: 'read_file',
      toolCallId: 'call-read',
      toolArgs: { filePath: file, path: file, innerCommand: `cat ${file}` },
      toolResult: { filePath: file, content: 'const a = 0\n', lineCount: 1 }
    },
    metadata: { toolName: 'read_file', operationKind: 'read_file', promptTokens: 10 }
  }
}

const refreshedText = (snapshot: LiveFileReadSnapshot | null | undefined) => {
  const outcome = snapshot?.copies.get(READ_ZIP)
  return outcome?.status === 'refreshed' ? outcome.text : null
}

async function createAgent(liveFileReads: boolean, overrides: Record<string, unknown> = {}) {
  await redis.createAgent({
    id: AGENT, user_id: USER, name: 'Probe', displayName: 'Probe', agentType: 'api',
    primary_model_preset_id: PRESET, tool_approval_mode: 'all',
    // The local backend, so the probe does not depend on the Mac's default sandbox.
    provider_specific_settings: { nativeTools: { executionBackend: 'local' } },
    // Explicit both ways: the factory value is ON since 2026-11-04 (SA-137 D13).
    live_file_reads: liveFileReads,
    ...overrides
  } as any)
}

describe('send-routed: live file reads at turn start, the paused snapshot and its replay (SA-137 P2)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-sa137-${count}`
    mocks.modelRuns.clear()
    mocks.brainRuns = []
    mocks.compiledTurn = []
    mocks.compiledHistory = []
    mocks.snapshots = []
    mocks.stopBeforeReads = false
    mocks.abortRequest = null
    mocks.onBrainRun = null
    mocks.requestsSent = 0
    mocks.lastChecks = []
    mocks.refreshedTurnFlags = []
    mocks.root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa137-handler-')))
    const details = statSync(mocks.root, { bigint: true })
    rootIdentity = `${details.dev}:${details.ino}`
    writeFileSync(path.join(mocks.root, 'a.js'), 'const a = 1\n')
    mocks.candidates = () => [openCopy()]
    forwards = []
    resetLiveFileReadPermitsForTests()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      try {
        const body = JSON.parse(String(init?.body ?? '{}'))
        if (body && typeof body.type === 'string') forwards.push(body)
      } catch {
        // not a JSON forward
      }
      return new Response('{}', { status: 200 })
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, { id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5',
      contextWindow: 200_000, capabilities: {}, settings: {} })
    await redis.createSession({ id: SESSION, user_id: USER, title: 'SA-137', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    rmSync(mocks.root, { recursive: true, force: true })
  })

  it('a pause keeps its sealed snapshot on the paused record only; the resume replays it with no read, then clears it', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    const timersBefore = liveFileReadReplayTimersForTests()
    const response = await send()
    expect(response.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    // The pause armed its expiry timer.
    expect(liveFileReadReplayTimersForTests()).toBe(timersBefore + 1)

    // The turn read the open copy once, at turn start, and labelled it.
    const paused = refreshedText(mocks.snapshots[0])
    expect(paused).toContain('const a = 1')
    // The label is the first line of the copy, with the file and its range (Round 2).
    expect(paused!.startsWith('REFRESHED: a.js, whole file (at the start of this turn)\n')).toBe(true)
    expect(paused).not.toContain('Refreshed at the start of this turn from')

    // The paused record keeps that call's own snapshot, sealed to this user, chat, agent and reply.
    const card = await stored()
    expect(card.metadata.toolApprovals.approvals[0].status).toBe('pending')
    const replay = readLiveFileReadReplay(card.metadata.liveFileReadSnapshot,
      { userId: USER, sessionId: SESSION, agentId: AGENT, messageId: FIRST_REPLY })
    expect(replay.copies).toHaveLength(1)
    expect(replay.compileId).toBe(mocks.snapshots[0]!.compileId)
    // The reply's parts ride with the replay (just this reply here).
    expect(replay.replyMessageIds).toEqual([FIRST_REPLY])

    // No tab receives it: not the handler's answer, not any forward (`end` included), not the list.
    expect(await response.text()).not.toContain('liveFileReadSnapshot')
    expect(forwards.some((body) => body.type === 'end')).toBe(true)
    expect(JSON.stringify(forwards)).not.toContain('liveFileReadSnapshot')
    expect(JSON.stringify(forwards)).not.toContain('whiteboardContextSnapshot')

    // The file changes, then goes: the resume must read nothing and replay the paused bytes.
    writeFileSync(path.join(mocks.root, 'a.js'), 'const a = 2\n')
    unlinkSync(path.join(mocks.root, 'a.js'))
    const resumed = await click()
    expect(resumed.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY])
    expect(refreshedText(mocks.snapshots[1])).toBe(paused)
    // Frozen bytes and the original label, and still strict: the reply's own message is the turn's reply.
    expect(refreshedText(mocks.snapshots[1])!.startsWith('REFRESHED: a.js, whole file (at the start of this turn)\n')).toBe(true)
    expect(mocks.snapshots[1]).toMatchObject({ strict: true, replyMessageId: FIRST_REPLY })
    expect(mocks.snapshots[1]!.compileId).toBe(mocks.snapshots[0]!.compileId)

    // The resumed reply ended without a new card: its snapshot is cleared.
    expect((await stored()).metadata.liveFileReadSnapshot).toBeNull()
  }, 30_000)

  it('a snapshot whose seal does not verify is never used: the resume runs without live reads, and the end clears it', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    const card = await stored()
    const forged = structuredClone(card.metadata.liveFileReadSnapshot)
    forged.copies[0].parts[0].text = 'const a = 999\n'
    await redis.json.set(`message:${SESSION}:${FIRST_REPLY}`, '$.metadata.liveFileReadSnapshot', forged)

    const resumed = await click()
    expect(resumed.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY])
    // No turn: the forged bytes never reach the compile, and nothing is read.
    // It reads nothing and keeps every copy static, and the turn knows why (P2: the reason).
    expect((mocks.compiledTurn[1] as any)?.replayUnavailable).toBe('replay-unverifiable')
    expect([...(mocks.snapshots[1] as any).copies.values()]).toEqual([{ status: 'static', reason: 'replay-unverifiable' }])
    expect((mocks.snapshots[1] as any).refreshed.size).toBe(0)
    expect((await stored()).metadata.liveFileReadSnapshot).toBeNull()
  }, 30_000)

  it('a snapshot of the wrong owner refuses the resume (409) before any model call, and the spent pause is cleared', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    await redis.json.set(`message:${SESSION}:${FIRST_REPLY}`, '$.metadata.liveFileReadSnapshot.agentId', 'agent-someone-else')
    const resumed = await click()
    expect(resumed.status).toBe(409)
    expect(await resumed.json()).toMatchObject({ code: 'APPROVAL_RESUME_CONTEXT_MISSING' })
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    // The click is spent and can never run again: the refused pause's snapshot is cleared, not left inert.
    expect((await stored()).metadata.liveFileReadSnapshot).toBeNull()
  }, 30_000)

  it('a resume whose model call fails before any text clears the spent pause\'s snapshot', async () => {
    // The real save merges a server writer's metadata into the stored record (an omitted key is
    // kept: `redis.saveMessage`); the default fake replaces it. Mirror the real rule for this reply.
    const save = vi.mocked(redis.saveMessage)
    const original = save.getMockImplementation()!
    save.mockImplementation(async (message: any, options?: any) => {
      if (message?.id === FIRST_REPLY && !options?.browserMutation) {
        const prior = await redis.json.get(`message:${SESSION}:${FIRST_REPLY}`) as any
        if (prior?.metadata) message = { ...message, metadata: keepAnsweredApprovals(prior.metadata, { ...prior.metadata, ...(message.metadata ?? {}) }) }
      }
      return original.apply(redis, [message, options])
    })
    try {
      await createAgent(true)
      mocks.modelRuns.set(1, 'card')
      mocks.modelRuns.set(2, 'fails')
      expect((await send()).status).toBe(200)
      expect((await stored()).metadata.liveFileReadSnapshot).toBeTruthy()
      const resumed = await click()
      expect(resumed.status).toBeGreaterThanOrEqual(400)
      expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY])
      const record = await stored()
      expect(record.metadata.response_failed).toBe(true)
      expect(record.metadata.liveFileReadSnapshot).toBeNull()
    } finally {
      save.mockImplementation(original)
    }
  }, 30_000)

  it('a sealed snapshot past its expiry resumes without live reads (never a refusal), and the end clears it', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    const { seal: _seal, ...replay } = (await stored()).metadata.liveFileReadSnapshot
    await redis.json.set(`message:${SESSION}:${FIRST_REPLY}`, '$.metadata.liveFileReadSnapshot',
      sealLiveFileReadReplay({ ...replay, expiresAt: new Date(Date.now() - 1).toISOString() }))
    const resumed = await click()
    expect(resumed.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY])
    // It reads nothing and keeps every copy static, and the turn knows why (P2: the reason).
    expect((mocks.compiledTurn[1] as any)?.replayUnavailable).toBe('replay-expired')
    expect([...(mocks.snapshots[1] as any).copies.values()]).toEqual([{ status: 'static', reason: 'replay-expired' }])
    expect((mocks.snapshots[1] as any).refreshed.size).toBe(0)
    expect((await stored()).metadata.liveFileReadSnapshot).toBeNull()
  }, 30_000)

  it('a resume that pauses again keeps a new pause of the same snapshot, naming only the new card', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    mocks.modelRuns.set(2, 'card')
    expect((await send()).status).toBe(200)
    const first = (await stored()).metadata.liveFileReadSnapshot
    expect((await click()).status).toBe(200)
    const owner = { userId: USER, sessionId: SESSION, agentId: AGENT, messageId: FIRST_REPLY }
    const second = readLiveFileReadReplay((await stored()).metadata.liveFileReadSnapshot, owner)!
    expect(second.compileId).toBe(first.compileId)
    expect(second.pauseId).not.toBe(first.pauseId)
    expect(second.approvalIds).toEqual(['aitxt-sa137-2'])
    expect(second.copies).toEqual(first.copies)
  }, 30_000)

  it('a paused record whose snapshot was cleared (null) resumes without live reads and says so', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    await redis.json.set(`message:${SESSION}:${FIRST_REPLY}`, '$.metadata.liveFileReadSnapshot', null)

    const resumed = await click()
    expect(resumed.status).toBe(200)
    expect(mocks.brainRuns).toEqual([FIRST_REPLY, FIRST_REPLY])
    // It reads nothing and keeps every copy static, and the turn knows why (P2: the reason).
    expect((mocks.compiledTurn[1] as any)?.replayUnavailable).toBe('replay-missing')
    expect([...(mocks.snapshots[1] as any).copies.values()]).toEqual([{ status: 'static', reason: 'replay-missing' }])
    expect((mocks.snapshots[1] as any).refreshed.size).toBe(0)
  }, 30_000)

  it('a resume with no usable snapshot that pauses again keeps none: null, never a sealed static replay', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    mocks.modelRuns.set(2, 'card')
    expect((await send()).status).toBe(200)
    await redis.json.set(`message:${SESSION}:${FIRST_REPLY}`, '$.metadata.liveFileReadSnapshot', null)
    expect((await click()).status).toBe(200)
    expect((mocks.compiledTurn[1] as any)?.replayUnavailable).toBe('replay-missing')
    expect((await stored()).metadata.toolApprovals.approvals.some((entry: any) => entry.status === 'pending')).toBe(true)
    expect((await stored()).metadata.liveFileReadSnapshot).toBeNull()
  }, 30_000)

  it('an ON reply that pauses with nothing open keeps null, and its resume says the snapshot is missing', async () => {
    mocks.candidates = () => []
    await createAgent(true)
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    expect((await stored()).metadata.liveFileReadSnapshot).toBeNull()
    expect((await click()).status).toBe(200)
    expect((mocks.compiledTurn[1] as any)?.replayUnavailable).toBe('replay-missing')
    expect((mocks.snapshots[1] as any).copies.size).toBe(0)
  }, 30_000)

  it('a built snapshot is strict and names the reply it is for', async () => {
    await createAgent(true)
    expect((await send()).status).toBe(200)
    expect(mocks.snapshots[0]).toMatchObject({ strict: true, replyMessageId: FIRST_REPLY })
  }, 30_000)

  it('another agent of the user\'s copy refreshes through the route\'s reader check; a deleted reader\'s copy stays zipped (R2-4)', async () => {
    writeFileSync(path.join(mocks.root, 'b.js'), 'const b = 1\n')
    await createAgent(true)
    await createAgent(false, { id: OTHER_AGENT, name: 'Other', displayName: 'Other' })
    const theirs = openCopy({ zip: 'cool_tool_1790000137100_theirs', file: 'b.js', readerAgentId: OTHER_AGENT })
    const deleted = openCopy({ zip: 'cool_tool_1790000137101_deleted', readerAgentId: DELETED_AGENT })
    mocks.candidates = () => [openCopy(), theirs, deleted]
    expect((await send()).status).toBe(200)
    const snapshot = mocks.snapshots[0]!
    expect(snapshot.copies.get(READ_ZIP)?.status).toBe('refreshed')
    const outcome = snapshot.copies.get(theirs.zipId) as any
    expect(outcome.status).toBe('refreshed')
    expect(outcome.text.startsWith('REFRESHED: b.js, whole file (at the start of this turn)\n')).toBe(true)
    expect(outcome.text).toContain('const b = 1')
    expect(snapshot.copies.get(deleted.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
    // The reader was still confirmed right before the request left (Round 2 follow-up): it went.
    expect(mocks.lastChecks).toEqual([true])
    expect(mocks.requestsSent).toBe(1)
  }, 30_000)

  it('the other reader goes during the run\'s setup, after the after-read ask: the last check sends nothing and the reply fails visibly (Round 2 follow-up)', async () => {
    writeFileSync(path.join(mocks.root, 'b.js'), 'const b = 1\n')
    await createAgent(true)
    await createAgent(false, { id: OTHER_AGENT, name: 'Other', displayName: 'Other' })
    const theirs = openCopy({ zip: 'cool_tool_1790000137100_theirs', file: 'b.js', readerAgentId: OTHER_AGENT })
    mocks.candidates = () => [openCopy(), theirs]
    // The model run's own setup (tools, gateways) is awaited after the compile; the reader is deleted then.
    mocks.onBrainRun = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      await redis.json.del(`agent:${OTHER_AGENT}`)
    }
    const response = await send()
    expect(response.status).toBeGreaterThanOrEqual(400)
    // The compile did refresh it (both earlier asks allowed it) ...
    expect(mocks.snapshots[0]!.copies.get(theirs.zipId)?.status).toBe('refreshed')
    // ... yet no model request left, and the saved reply says why in plain words.
    expect(mocks.brainRuns).toEqual([FIRST_REPLY])
    expect(mocks.requestsSent).toBe(0)
    const record = await stored()
    expect(record.metadata.response_failed).toBe(true)
    expect(JSON.stringify(record)).toContain('Batshit sent nothing to the model')
  }, 30_000)

  it('a turn that refreshed only the agent\'s own copies gets no last check: the request goes as before', async () => {
    await createAgent(true)
    expect((await send()).status).toBe(200)
    expect(mocks.snapshots[0]!.copies.get(READ_ZIP)?.status).toBe('refreshed')
    expect(mocks.lastChecks).toEqual([false])
    expect(mocks.requestsSent).toBe(1)
  }, 30_000)

  it.each([
    ['a CLI agent', { agentType: 'cli' }],
    ['an API agent with Bash off', { provider_specific_settings: { nativeTools: { executionBackend: 'local', bashEnabled: false } } }]
  ])('another agent that is %s is not a confirmed reader: its copy stays zipped (security review)', async (_name, overrides) => {
    await createAgent(true)
    await createAgent(false, { id: OTHER_AGENT, name: 'Other', displayName: 'Other', ...overrides })
    const theirs = openCopy({ zip: 'cool_tool_1790000137102_nonreader', readerAgentId: OTHER_AGENT })
    mocks.candidates = () => [openCopy(), theirs]
    expect((await send()).status).toBe(200)
    expect(mocks.snapshots[0]!.copies.get(READ_ZIP)?.status).toBe('refreshed')
    expect(mocks.snapshots[0]!.copies.get(theirs.zipId)).toEqual({ status: 'static', reason: 'reader-gone' })
  }, 30_000)

  it('the paused record keeps another member\'s refreshed copy with the same frozen bytes, and the resume reads and asks nothing', async () => {
    writeFileSync(path.join(mocks.root, 'b.js'), 'const b = 1\n')
    await createAgent(true)
    await createAgent(false, { id: OTHER_AGENT, name: 'Other', displayName: 'Other' })
    const theirs = openCopy({ zip: 'cool_tool_1790000137100_theirs', file: 'b.js', readerAgentId: OTHER_AGENT })
    mocks.candidates = () => [openCopy(), theirs]
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    const first = (mocks.snapshots[0]!.copies.get(theirs.zipId) as any).text
    // The other reader goes, the file changes: the resume still replays the pause's bytes.
    await redis.json.del(`agent:${OTHER_AGENT}`)
    expect((await redis.getAgents(USER)).some((agent: any) => agent.id === OTHER_AGENT)).toBe(false)
    writeFileSync(path.join(mocks.root, 'b.js'), 'const b = 2\n')
    expect((await click()).status).toBe(200)
    expect((mocks.snapshots[1]!.copies.get(theirs.zipId) as any).text).toBe(first)
    // The paused call's request passed the last check; the resume replays bytes it already sent,
    // so it gets none and is never refused for the reader that left (frozen replay contract).
    expect(mocks.lastChecks).toEqual([true, false])
    expect(mocks.requestsSent).toBe(2)
  }, 30_000)

  it('with the inline Zip view the route gives the compile no turn: nothing refreshes and nothing is zipped early', async () => {
    await createAgent(true, { zip_ai_view_mode: 'inline' })
    expect((await send()).status).toBe(200)
    expect(mocks.compiledTurn).toEqual([undefined])
    expect(mocks.snapshots).toEqual([null])
  }, 30_000)

  it('the route gives no turn on a Linux host for a sandbox backend, and never touches the saved setting', async () => {
    const platform = vi.spyOn(os, 'platform').mockReturnValue('linux')
    try {
      await createAgent(true, { provider_specific_settings: { nativeTools: { executionBackend: 'apple_container' } } })
      expect((await send()).status).toBe(200)
      expect(mocks.compiledTurn).toEqual([undefined])
      expect((await redis.getAgents(USER)).find((agent: any) => agent.id === AGENT)?.live_file_reads).toBe(true)
    } finally { platform.mockRestore() }
  }, 30_000)

  it.runIf(process.platform === 'darwin').each(['apple_container', 'docker_sandbox'])('on a Mac the route gives an API agent on %s a turn (the sandbox mounts the host folder)', async (executionBackend) => {
    await createAgent(true, { provider_specific_settings: { nativeTools: { executionBackend } } })
    expect((await send()).status).toBe(200)
    expect(mocks.compiledTurn[0]).toBeDefined()
    expect(mocks.snapshots[0]).toMatchObject({ strict: true, replyMessageId: FIRST_REPLY })
  }, 30_000)

  it('the route hands the brain the compile\'s own Refreshed File Reads answer, which shapes edit_file\'s text (Josh, 2026-10-22)', async () => {
    await createAgent(true)
    expect((await send()).status).toBe(200)
    expect(mocks.refreshedTurnFlags).toEqual([true])
    mocks.refreshedTurnFlags = []
    await createAgent(false)
    expect((await send()).status).toBe(200)
    expect(mocks.refreshedTurnFlags).toEqual([false])
  }, 30_000)

  it('with the setting off, the compile gets no turn and the paused record has no snapshot key', async () => {
    await createAgent(false)
    mocks.modelRuns.set(1, 'card')
    expect((await send()).status).toBe(200)
    expect(mocks.compiledTurn).toEqual([undefined])
    const card = await stored()
    expect(card.metadata.toolApprovals.approvals[0].status).toBe('pending')
    expect(Object.prototype.hasOwnProperty.call(card.metadata, 'liveFileReadSnapshot')).toBe(false)
  }, 30_000)

  it('a card whose approval ids a replay cannot hold keeps no snapshot; its resume would run without live reads', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'card-odd-id')
    expect((await send()).status).toBe(200)
    expect(refreshedText(mocks.snapshots[0])).toContain('const a = 1')
    const card = await stored()
    expect(card.metadata.toolApprovals.approvals[0].status).toBe('pending')
    expect(card.metadata.liveFileReadSnapshot).toBeNull()
  }, 30_000)

  it.each([true, false])('request metadata never plants a replay field on the saved reply (setting on: %s)', async (on) => {
    await createAgent(on)
    const planted = { schema_version: 1, pauseId: 'planted', approvalIds: ['x'], copies: [] }
    expect((await post({ content: 'Read a.js.', messageId: FIRST_REPLY, messages: [userMessage()],
      metadata: { liveFileReadSnapshot: planted, whiteboardContextSnapshot: { dcmLines: ['planted'] } } })).status).toBe(200)
    expect(JSON.stringify((await stored()).metadata)).not.toContain('planted')
  }, 30_000)

  it('a caller\'s history never brings replay fields into the compile', async () => {
    await createAgent(true)
    const borrowed = { id: 'msg-old', session_id: SESSION, user_id: USER, role: 'assistant', content: 'Earlier.', created_at: '2026-10-21T00:59:00.000Z',
      metadata: { whiteboardContextSnapshot: { dcmLines: ['board'] }, liveFileReadSnapshot: { schema_version: 1, pauseId: 'forged' } } }
    expect((await post({ content: 'Read a.js.', messageId: FIRST_REPLY, messages: [borrowed, userMessage()] })).status).toBe(200)
    expect((mocks.compiledHistory[0] as any[]).map((message) => message.id)).toContain('msg-old')
    expect(JSON.stringify(mocks.compiledHistory[0])).not.toMatch(/liveFileReadSnapshot|whiteboardContextSnapshot/)
  }, 30_000)

  it('a context continuation of a reply that had a turn reuses that turn: the same snapshot, no new read, and the continuation joins the reply (review M1)', async () => {
    await createAgent(true)
    let asked = 0
    mocks.candidates = () => { asked += 1; return [openCopy()] }
    mocks.modelRuns.set(1, 'exhausted')
    expect((await send()).status).toBe(200)
    // Two model calls: the one that filled the window, and its continuation under a new message id.
    expect(mocks.brainRuns).toHaveLength(2)
    const continuationId = mocks.brainRuns[1]
    expect(continuationId).not.toBe(FIRST_REPLY)
    expect(mocks.compiledTurn).toHaveLength(2)
    expect(mocks.compiledTurn[0]).toBeDefined()
    // The continuation's compile gets the first run's turn, not a new one.
    expect(mocks.compiledTurn[1]).toBe(mocks.compiledTurn[0])
    expect(mocks.snapshots[1]).toBe(mocks.snapshots[0])
    expect(asked).toBe(1)
    const live = mocks.compiledTurn[0] as any
    expect([...live.replyMessageIds].sort()).toEqual([FIRST_REPLY, continuationId].sort())
    expect(live.replyMessageId).toBe(FIRST_REPLY)
  }, 30_000)

  it('a continuation that then pauses keeps every part of the reply in its replay (review M1)', async () => {
    await createAgent(true)
    mocks.modelRuns.set(1, 'exhausted')
    mocks.modelRuns.set(2, 'card')
    expect((await send()).status).toBe(200)
    expect(mocks.brainRuns).toHaveLength(2)
    const pausedId = mocks.brainRuns[1]
    const card = await stored(pausedId)
    expect(card.metadata.toolApprovals.approvals[0].status).toBe('pending')
    const replay = readLiveFileReadReplay(card.metadata.liveFileReadSnapshot, { userId: USER, sessionId: SESSION, agentId: AGENT, messageId: pausedId })
    expect(replay?.replyMessageIds?.slice().sort()).toEqual([FIRST_REPLY, pausedId].sort())
    // It is the first run's snapshot, carried through the continuation.
    expect(replay?.compileId).toBe(mocks.snapshots[0]!.compileId)
  }, 30_000)

  it('a context continuation of a reply that had no turn creates none, even if the setting was turned on mid-reply: no read, nothing hidden (continuesReply)', async () => {
    await createAgent(false)
    mocks.modelRuns.set(1, 'exhausted')
    mocks.onBrainRun = async (run) => {
      // The user turns Refreshed File Reads on while the first run works; the continuation re-reads the agent.
      if (run === 1) await createAgent(true)
    }
    let asked = 0
    mocks.candidates = () => { asked += 1; return [openCopy()] }
    expect((await send()).status).toBe(200)
    expect(mocks.brainRuns).toHaveLength(2)
    expect((await redis.getAgents(USER)).find((agent: any) => agent.id === AGENT)?.live_file_reads).toBe(true)
    // Neither compile had a turn: nothing was read, no candidate was asked for, so nothing could be hidden.
    expect(mocks.compiledTurn).toEqual([undefined, undefined])
    expect(mocks.snapshots).toEqual([null, null])
    expect(asked).toBe(0)
    // The next ordinary send in the chat is a new reply and does get a turn.
    mocks.compiledTurn = []
    mocks.snapshots = []
    expect((await post({ content: 'Read a.js again.', messageId: 'msg-sa137-next', messages: [userMessage()] })).status).toBe(200)
    expect(mocks.compiledTurn[0]).toBeDefined()
  }, 30_000)

  it('a Stop during the reads ends the turn before any model call; nothing is refreshed', async () => {
    await createAgent(true)
    mocks.stopBeforeReads = true
    await send()
    expect(mocks.brainRuns).toEqual([])
    expect([...mocks.snapshots[0]!.copies.values()]).toEqual([{ status: 'static', reason: 'stopped' }])
  }, 30_000)
})
