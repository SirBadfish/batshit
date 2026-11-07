// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import { __resetReplyRecordsForTests } from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { env } from '$env/dynamic/private'

/**
 * BL-610 through the real send-routed handler and the real `/api/sse` POST, joined by the event
 * fetch: the API lane's Subagent tools (and workflow tools) are the AI SDK's `dynamicTool`s, so
 * their stream parts carry `dynamic: true`. send-routed's stream loop skipped every `dynamic`
 * tool-result, so a Subagent call that SUCCEEDED got no result during the stream: its card stayed
 * open (and the page held back every later word) until the reply ended, and its zip, step and
 * Execution Viewer row were left to the finish. When the reply also ran an ordinary tool, the
 * finish read the stream's steps only, so the Subagent call lost its step, its zip, and its spend
 * (`metadata.delegated`). A Subagent call that threw already went through the stream path (BL-450:
 * the `tool-error` part is turned into a failed result without `dynamic`).
 *
 * The fake model streams the parts the installed SDK streams for a `dynamicTool` (`dynamic: true`
 * on both the call and the result) and hands `onFinish` the same steps. Faked beside it: the
 * compiler's output and the model.
 */

const USER = 'user-bl610'
const AGENT = 'agent-bl610'
const PRESET = 'preset-bl610'
const REPLY = 'msg-reply-bl610'
const SERVICE_TOKEN = 'test-internal-token-bl610'
const STEP_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

const SUBAGENT_CALL = {
  type: 'tool-call',
  toolCallId: 'call_sub',
  toolName: 'researcher',
  input: { chatInput: 'Find the release date.' },
  dynamic: true
}

/** What `vercelBrain`'s Subagent tool returns for a completed run. */
const SUBAGENT_OUTPUT = {
  kind: 'subagent',
  success: true,
  subagentName: 'Researcher',
  subagentType: 'api',
  output: 'The release date is March 3.',
  intermediateSteps: [],
  usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
  modelId: 'claude-sonnet-5',
  provider: 'anthropic',
  durationMs: 2400,
  status: 'completed',
  thread: 'fresh'
}

const SUBAGENT_RESULT = {
  type: 'tool-result',
  toolCallId: 'call_sub',
  toolName: 'researcher',
  input: SUBAGENT_CALL.input,
  output: SUBAGENT_OUTPUT,
  dynamic: true
}

const READ_CALL = {
  type: 'tool-call',
  toolCallId: 'call_read',
  toolName: 'read_file',
  input: { path: '/notes/plan.md' }
}

const READ_RESULT = {
  type: 'tool-result',
  toolCallId: 'call_read',
  toolName: 'read_file',
  input: READ_CALL.input,
  output: { content: 'Ship on Tuesday.' }
}

const mocks = vi.hoisted(() => ({
  /** The tool parts the fake model streams in its first step, in order. */
  toolParts: [] as Array<Record<string, any>>,
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
        structuredInput: { messages: [{ role: 'user', content: 'When is the release?' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const toolParts = [...mocks.toolParts]
      const before = 'Asking the specialist. '
      const after = 'The release is on March 3.'
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text: before }
        yield { type: 'text-end', id: 't1' }
        for (const part of toolParts) yield part
        yield { type: 'finish-step', finishReason: 'tool-calls', usage: STEP_USAGE, response: {} }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't2' }
        yield { type: 'text-delta', id: 't2', text: after }
        yield { type: 'text-end', id: 't2' }
        yield { type: 'finish-step', finishReason: 'stop', usage: STEP_USAGE, response: {} }
        const steps = [
          { content: [{ type: 'text', text: before }, ...toolParts], usage: STEP_USAGE },
          { content: [{ type: 'text', text: after }], usage: STEP_USAGE }
        ]
        const totalUsage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
        await request.onFinish?.({ text: `${before}${after}`, steps, totalUsage, usage: STEP_USAGE, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
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
        content: 'When is the release?',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'When is the release?' }]
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

describe('send-routed + /api/sse: a Subagent call that succeeds closes its card on its result (BL-610, the real handlers)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl610-${count}`
    mocks.toolParts = []
    mocks.forwards = []
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    // send-routed's forwards are trusted internal ones, as in the app, so a reply no tab watches
    // is recorded whole (BL-775).
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Lark', displayName: 'Lark', agentType: 'api', primary_model_preset_id: PRESET } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-610', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('forwards the result while the reply streams, with its zip, before the words after it, and saves it in place', async () => {
    mocks.toolParts = [SUBAGENT_CALL, SUBAGENT_RESULT]
    expect((await send()).status).toBe(200)

    // The card's result reached `/api/sse` during the stream, before the words written after the
    // call: the page closes the card and lets those words through as they arrive.
    const resultAt = forwardIndex((event) => event.type === 'tool-result' && event.toolCallId === 'call_sub')
    const laterWordsAt = forwardIndex((event) => event.type === 'chunk' && String(event.content).includes('March 3'))
    const endAt = forwardIndex((event) => event.type === 'end')
    expect(resultAt).toBeGreaterThan(-1)
    expect(resultAt).toBeLessThan(laterWordsAt)
    expect(resultAt).toBeLessThan(endAt)
    const resultForward = mocks.forwards[resultAt]
    const zipReference = resultForward.zipReferences?.[0]?.reference as string
    expect(zipReference).toContain('batshit-zip:cool_tool_')

    // The saved reply names that zip, in the call's place, and keeps the call's step and spend.
    const saved = await stored(REPLY)
    expect(saved.metadata.replySavedFromOwnCopy).toBeUndefined()
    const at = saved.content.indexOf(zipReference)
    expect(at).toBeGreaterThan(saved.content.indexOf('Asking the specialist.'))
    expect(at).toBeLessThan(saved.content.indexOf('The release is on March 3.'))
    expect(scanZipReferences(saved.content)).toHaveLength(1)
    const zipId = resultForward.zipReferences[0].zipId
    expect(saved.metadata.zipIds).toEqual([zipId])
    expect((saved.intermediateSteps ?? []).map((step: any) => step.toolCallId)).toEqual(['call_sub'])
    expect(saved.metadata.delegated?.runs).toEqual([
      expect.objectContaining({ kind: 'subagent', name: 'Researcher', status: 'completed', usage: expect.objectContaining({ totalTokens: 1500 }) })
    ])
  }, 30_000)

  it('keeps the Subagent call’s step, zip and spend when the reply also ran an ordinary tool', async () => {
    mocks.toolParts = [READ_CALL, READ_RESULT, SUBAGENT_CALL, SUBAGENT_RESULT]
    expect((await send()).status).toBe(200)

    // The finish read the stream's steps only, so a skipped Subagent result lost its step, its zip
    // and its spend from the saved reply.
    const saved = await stored(REPLY)
    expect((saved.intermediateSteps ?? []).map((step: any) => step.toolCallId)).toEqual(['call_read', 'call_sub'])
    expect(saved.metadata.delegated?.runs).toEqual([expect.objectContaining({ kind: 'subagent', status: 'completed' })])
    const references = scanZipReferences(saved.content)
    expect(references).toHaveLength(2)
    expect(saved.metadata.zipIds).toHaveLength(2)
    for (const reference of references) expect(saved.metadata.zipIds).toContain(reference.id)

    const results = mocks.forwards.filter((event) => event.type === 'tool-result').map((event) => event.toolCallId)
    expect(results).toEqual(['call_read', 'call_sub'])
  }, 30_000)
})
