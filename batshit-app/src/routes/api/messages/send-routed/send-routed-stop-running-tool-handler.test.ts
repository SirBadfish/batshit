// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests, stopSessionTurn } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { STOPPED_WITHOUT_RESULT_REASON } from '$lib/server/services/lateToolResults'
import { isEmptyStoppedReply } from '$lib/utils/stoppedReplyNote'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { env } from '$env/dynamic/private'

/**
 * BL-1959 through the real send-routed handler and the real `/api/sse` POST: a Stop that lands
 * while a tool runs. The SDK ends that stream with `abort` and drops the call's result, so the
 * stopped reply used to be saved with no step and no zip ("You stopped this reply before it said
 * anything"), whatever the command had already done. Now the call is recorded through the same
 * `tool-result` path as any other: forwarded, zipped, in the saved reply (BL-775 save-then-end).
 */

const USER = 'user-bl1959'
const AGENT = 'agent-bl1959'
const PRESET = 'preset-bl1959'
const REPLY = 'msg-reply-bl1959'
const SERVICE_TOKEN = 'test-internal-token-bl1959'
const COMMAND = 'cd /work && sleep 30 && touch slept.txt'

/** The call the API lane's Bash tool streams. */
const BASH_CALL = { type: 'tool-call', toolCallId: 'call_bash', toolName: 'native_bash_execute', input: { command: COMMAND } }

/** What `nativeBashExecute` returns for a command a Stop ended. */
const STOPPED_BASH_RESULT = {
  success: false, blocked: false, command: COMMAND, stdout: 'started\n', stderr: '', exitCode: null, signal: 'SIGTERM',
  timedOut: false, stopped: true, reason: 'The command was stopped.', durationMs: 9000, truncated: false,
  policyMode: 'dangerous', accessMode: 'dangerous', backend: 'local', backendLabel: 'This Mac', cwd: '/work', workspaceRoot: '/work',
  mappedToolName: 'native_bash_execute', mappedToolInput: { command: COMMAND }, mappedReason: 'fallback-command'
}

/** SA-126 item 2: a patch that applied, then its test, stopped while the test ran (the real shape). */
const PATCH_COMMAND = "apply_patch <<'PATCH' && echo started && sleep 30\n*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\nPATCH"
const STOPPED_PATCH_TEST_RESULT = {
  ...STOPPED_BASH_RESULT, command: PATCH_COMMAND, shell: '/bin/zsh', stdout: 'started\n', durationMs: 404,
  mappedToolName: 'batshit_server_edit_file', mappedReason: 'apply-patch',
  mappedToolInput: { command: PATCH_COMMAND, innerCommand: PATCH_COMMAND, filePath: 'a.txt', path: 'a.txt', touchedPaths: ['a.txt'] },
  managedApplyPatch: {
    managed: true, applied: true, operationsApplied: 1, touchedPaths: ['a.txt'],
    afterPatch: { command: 'echo started && sleep 30', tail: 'echo started && sleep 30' }, afterPatchStarted: true
  }
}

const mocks = vi.hoisted(() => ({
  /** The tool call the fake model makes. */
  call: {} as Record<string, any>,
  /** What that call's `execute` returns (a promise; one that never settles never returns). */
  execution: Promise.resolve({}) as Promise<unknown>,
  /** An approval click's resume: the call's `tool-call` part is not streamed. */
  resumedCall: false,
  /** BL-1978: what the running call reports of itself (an applied patch), or null. */
  reported: null as null | Record<string, unknown>,
  /** Called once the call reached the loop: the test presses Stop here. */
  onToolCallStreamed: null as null | (() => void),
  /** Every event send-routed forwarded to `/api/sse`, in order. */
  forwards: [] as Array<Record<string, any>>
}))

// Physical monitoring and subscribers are isolated by the opt-in handler fixture.


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
        structuredInput: { messages: [{ role: 'user', content: 'Run the long command.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', async () => {
  const { noteToolProgress, trackToolExecution } = await import('$lib/server/services/lateToolResults')
  return {
    VercelAIBrain: class {
      async streamNativeMode(request: any) {
        const call = mocks.call
        // What the SDK does (pinned in `lateToolResults.test.ts`): the call starts its `execute`
        // (tracked, as `vercelBrain.ts`'s tool wrapper does), the Stop lands, the SDK waits for the
        // execute and ends the stream with `abort` and no result; a tool that never returns keeps
        // the stream open.
        async function* stream() {
          yield { type: 'start' }
          yield { type: 'start-step', request: {}, warnings: [] }
          yield { type: 'text-start', id: 't1' }
          yield { type: 'text-delta', id: 't1', text: 'Running it now. ' }
          yield { type: 'text-end', id: 't1' }
          trackToolExecution(request.abortSignal, call.toolCallId, call.toolName, call.input, mocks.execution)
          if (mocks.reported) noteToolProgress(request.abortSignal, call.toolCallId, mocks.reported)
          // An approval click's resume streams the approved call's result only, never its call.
          if (!mocks.resumedCall) yield call
          mocks.onToolCallStreamed?.()
          await new Promise<void>((resolve) => {
            if (request.abortSignal?.aborted) resolve()
            else request.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
          })
          await mocks.execution.catch(() => undefined)
          request.onAbort?.({ steps: [] })
          yield { type: 'abort', reason: 'user' }
        }
        return { stream: stream(), steps: Promise.reject(new Error('user')).catch(() => []), response: Promise.resolve({ messages: [] }) }
      }
    }
  }
})

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => {}) }
})

useRedisTestServer()

const envRecord = env as Record<string, string | undefined>
let previousToken: string | undefined
let POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

/** The event fetch: a forward to `/api/sse` reaches the real route; nothing else is called. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  mocks.forwards.push(JSON.parse(String(init?.body ?? '{}')))
  return SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
})

function send(): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'Run the long command.',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'Run the long command.' }]
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

/** The index of the first forward that matches, -1 when none does. */
const forwardIndex = (match: (event: Record<string, any>) => boolean) => mocks.forwards.findIndex(match)

describe('send-routed + /api/sse: a Stop during a running tool call records the call (BL-1959, the real handlers)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl1959-${count}`
    mocks.call = BASH_CALL
    mocks.execution = Promise.resolve(STOPPED_BASH_RESULT)
    mocks.onToolCallStreamed = () => setTimeout(() => stopSessionTurn(SESSION, 'user'), 20)
    mocks.forwards = []
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    mocks.resumedCall = false
    mocks.reported = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Lark', displayName: 'Lark', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-1959', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('saves the stopped command as a step with its zip, after the words before it, and publishes end after the save', async () => {
    await send()

    const resultAt = forwardIndex((event) => event.type === 'tool-result' && event.toolCallId === 'call_bash')
    const endAt = forwardIndex((event) => event.type === 'end')
    expect(resultAt).toBeGreaterThan(-1)
    expect(endAt).toBeGreaterThan(resultAt)
    const zipReference = mocks.forwards[resultAt].zipReferences?.[0]?.reference as string
    expect(zipReference).toContain('batshit-zip:cool_tool_')

    const saved = await stored(REPLY)
    expect(saved.metadata.interrupted).toBe(true)
    expect(saved.content.indexOf(zipReference)).toBeGreaterThan(saved.content.indexOf('Running it now.'))
    expect(scanZipReferences(saved.content)).toHaveLength(1)
    expect(saved.metadata.zipIds).toEqual([mocks.forwards[resultAt].zipReferences[0].zipId])
    expect((saved.intermediateSteps ?? []).map((step: any) => step.toolName)).toEqual(['native_bash_execute'])
    expect(saved.intermediateSteps[0].toolResult).toMatchObject({ stopped: true, reason: 'The command was stopped.', stdout: 'started\n' })
    // The bubble no longer says the reply was stopped before it said anything.
    expect(isEmptyStoppedReply(saved)).toBe(false)
    // `end` carries the saved bytes (BL-775): the same zip, the same step.
    expect(mocks.forwards[endAt].content ?? mocks.forwards[endAt].metadata?.content ?? '').toContain(zipReference)
  }, 30_000)

  it('a Stop before any words: the reply is saved with the step, not as empty', async () => {
    mocks.onToolCallStreamed = () => setTimeout(() => stopSessionTurn(SESSION, 'user'), 5)
    await send()
    const saved = await stored(REPLY)
    expect((saved.intermediateSteps ?? []).map((step: any) => step.toolName)).toEqual(['native_bash_execute'])
    expect(saved.metadata.zipIds).toHaveLength(1)
  }, 30_000)

  it('an approved call resumed and then stopped is saved with its step too', async () => {
    mocks.resumedCall = true
    await send()
    const saved = await stored(REPLY)
    expect((saved.intermediateSteps ?? []).map((step: any) => step.toolName)).toEqual(['native_bash_execute'])
    expect(saved.metadata.zipIds).toHaveLength(1)
  }, 30_000)

  it('a tool that never returns after the Stop is saved as stopped with no result', async () => {
    mocks.execution = new Promise(() => {})
    const started = Date.now()
    await send()
    expect(Date.now() - started).toBeLessThan(15_000)
    const saved = await stored(REPLY)
    expect((saved.intermediateSteps ?? []).map((step: any) => step.toolName)).toEqual(['native_bash_execute'])
    expect(saved.intermediateSteps[0].toolResult).toMatchObject({ stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON })
  }, 30_000)

  it('a patch that applied, then its test stopped: the reply keeps the edit and the stopped test (SA-126 item 2)', async () => {
    mocks.call = { ...BASH_CALL, input: { command: PATCH_COMMAND } }
    mocks.execution = Promise.resolve(STOPPED_PATCH_TEST_RESULT)
    await send()
    const saved = await stored(REPLY)
    expect(saved.metadata.interrupted).toBe(true)
    // One call, two parts: the applied edit, then the stopped test.
    expect(saved.metadata.zipIds).toHaveLength(2)
    expect(scanZipReferences(saved.content)).toHaveLength(2)
    expect(saved.content).toMatch(/:::edit_file: a\.txt - \d+ lines?\}\}/)
    expect(saved.content).toMatch(/:::bash: echo started && sleep 30 - error - \d+ lines?\}\}/)
    expect(saved.content.indexOf(':::edit_file:')).toBeLessThan(saved.content.indexOf(':::bash:'))
    expect(saved.intermediateSteps ?? []).toHaveLength(1)
    expect(saved.intermediateSteps[0].toolResult).toMatchObject({ stopped: true, managedApplyPatch: { applied: true, afterPatchStarted: true } })
  }, 30_000)

  it('a patch whose commands never return after the Stop keeps the applied edit (BL-1978)', async () => {
    mocks.call = { ...BASH_CALL, input: { command: PATCH_COMMAND } }
    mocks.execution = new Promise(() => {})
    // What `nativeBashExecute` reports once the patch applied (`onPatchApplied`).
    const { stdout: _o, durationMs: _d, stopped: _s, reason: _r, signal: _g, exitCode: _e, ...applied } = STOPPED_PATCH_TEST_RESULT
    const { afterPatchStarted: _started, ...patchFacts } = STOPPED_PATCH_TEST_RESULT.managedApplyPatch
    mocks.reported = { ...applied, managedApplyPatch: patchFacts }
    await send()
    const saved = await stored(REPLY)
    expect(saved.metadata.zipIds).toHaveLength(2)
    expect(saved.content).toMatch(/:::edit_file: a\.txt - \d+ lines?\}\}/)
    expect(saved.content).toMatch(/:::bash: echo started && sleep 30 - error - \d+ lines?\}\}/)
    expect(saved.content.indexOf(':::edit_file:')).toBeLessThan(saved.content.indexOf(':::bash:'))
    expect(saved.intermediateSteps ?? []).toHaveLength(1)
    expect(saved.intermediateSteps[0].toolResult).toMatchObject({
      stopped: true, neverReturned: true, reason: STOPPED_WITHOUT_RESULT_REASON, managedApplyPatch: { applied: true }
    })
  }, 30_000)
})
