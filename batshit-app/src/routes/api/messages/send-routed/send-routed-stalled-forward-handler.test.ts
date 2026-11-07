// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetWakeRunRegistryForTests } from '$lib/server/services/wakeRunRegistry'
import {
  REPLY_EVENT_FORWARD_LIMIT,
  __resetReplyRecordsForTests,
  isReplyClosed,
  listReplayEvents
} from '$lib/server/services/replyStreamRecord'
import { env } from '$env/dynamic/private'

/**
 * BL-871 (a) through the real send-routed handler and the real `/api/sse` POST, joined by the event
 * fetch, with a tab watching on the live hub: a reply's `start` forward that passes its time limit
 * and finishes after the finalize closed the reply.
 *
 * The forward past its limit makes the reply a gap (BL-775): the chain goes on without it and the
 * finalize saves its own copy. When the stalled start finally reached `/api/sse`, it was taken like
 * an approval resume's start (a start was never refused): the saved reply was opened again, its
 * record replaced with an empty one, every tab got a `start` after the reply's end, and nothing
 * would ever end it. Now a start for a closed reply is refused unless it opens a newer approval
 * resume part; the finalize closes the reply with the version of the part it ended, so an approval
 * resume's own stalled start is refused too.
 *
 * Faked: the compiler's output and the model.
 */

const USER = 'user-bl871'
const AGENT = 'agent-bl871'
const PRESET = 'preset-bl871'
const REPLY = 'msg-reply-bl871'
const CARD = 'msg-card-bl871'
const APPROVAL = 'aitxt-bl871'
const SERVICE_TOKEN = 'test-internal-token-bl871'

const mocks = vi.hoisted(() => ({
  /** The `start` forward the event fetch holds back, released by the test. */
  heldStart: null as null | { release: () => Promise<any> },
  /** Hold the next `start` forward instead of delivering it. */
  holdStart: false
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
    async buildFormattedChatInput(sessionId: string, _messages: unknown, agent: any, _content: unknown, _assigned: unknown, userId: string, options: any) {
      return {
        primarySystemPrompt: 'You are a test agent.',
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId, sessionId, agentId: agent.id, messageId: options.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'Answer me.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const words = ['The first part. ', 'The second part.']
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text: words.join(''), steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
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
let previousLimit = 0
let POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

async function deliver(url: string, init?: RequestInit): Promise<Response> {
  return SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
}

/**
 * The event fetch: a forward to `/api/sse` reaches the real route. A held `start` never answers in
 * time; the test delivers it later, as SvelteKit's in-process fetch would still run the handler.
 */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  if (event.type === 'start' && mocks.holdStart) {
    mocks.holdStart = false
    let answer: (response: Response) => void = () => {}
    const answered = new Promise<Response>((resolve) => {
      answer = resolve
    })
    mocks.heldStart = {
      release: async () => {
        const response = await deliver(url, init)
        answer(response.clone())
        return response.json()
      }
    }
    return answered
  }
  return deliver(url, init)
})

/** A tab on the live hub, subscribed to the chat, that keeps every event it is sent. */
async function openTab() {
  const locals = { user: { id: USER } }
  const hub = await SSE_ROUTE.GET({ url: new URL('http://localhost/api/sse?scope=hub'), locals })
  const reader = hub.body!.getReader()
  const decoder = new TextDecoder()
  const decode = (value: unknown) => (typeof value === 'string' ? value : decoder.decode(value as Uint8Array))
  const first = decode((await reader.read()).value)
  const hubId = JSON.parse(first.slice(first.indexOf('data: ') + 6).split('\n')[0]).hubId
  const patch = await SSE_ROUTE.PATCH({
    request: new Request('http://localhost/api/sse', {
      method: 'PATCH',
      body: JSON.stringify({ hubId, add: [{ id: 'tab', scope: 'session', sessionId: SESSION }] })
    }),
    locals
  })
  expect(patch.status).toBe(200)
  const received: any[] = []
  let buffered = ''
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += decode(value)
      let at: number
      while ((at = buffered.indexOf('\n\n')) !== -1) {
        const frame = buffered.slice(0, at)
        buffered = buffered.slice(at + 2)
        const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
        if (!line) continue
        try {
          const parsed = JSON.parse(line.slice(6))
          received.push(parsed.event ?? parsed.data ?? parsed)
        } catch {
          /* a comment frame */
        }
      }
    }
  })()
  return {
    received,
    close: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await reader.cancel()
      await reading.catch(() => undefined)
    }
  }
}

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

function send(): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT,
        agentType: 'api',
        content: 'Answer me.',
        messageId: REPLY,
        messages: [{ id: `msg-user-${count}`, role: 'user', content: 'Answer me.' }]
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

/** A card waiting for its answer, then the click that resumes it (the API lane, in place). */
async function resumeApprovedCard() {
  const userMessage = { id: 'msg-user-card', session_id: SESSION, user_id: USER, role: 'user', content: 'List the folder.', created_at: '2026-10-18T01:00:00.000Z', metadata: {} }
  const cardMetadata = {
    model: 'claude-sonnet-5',
    agentType: 'api',
    whiteboardContextSnapshot: { schema_version: 1, userId: USER, sessionId: SESSION, agentId: AGENT, messageId: CARD,
      settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    zipIds: [],
    providerMessages: [
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'call_ls', toolName: 'native_bash_execute', input: { command: 'ls' } },
        { type: 'tool-approval-request', approvalId: APPROVAL, toolCallId: 'call_ls' }
      ] }
    ],
    providerMessageSource: { providerId: 'anthropic', connectionId: null, modelId: 'claude-sonnet-5' },
    toolApprovals: { mode: 'all', approvals: [{ approvalId: APPROVAL, toolCallId: 'call_ls', toolName: 'native_bash_execute', status: 'pending', input: { command: 'ls' } }], source: 'vercel' }
  }
  const card = { id: CARD, session_id: SESSION, user_id: USER, agent_id: AGENT, role: 'assistant', status: 'complete', content: 'Asking first.', created_at: '2026-10-18T01:00:05.000Z', metadata: cardMetadata }
  await redis.saveMessage(userMessage as any)
  await redis.saveMessage(card as any)
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION, agentId: AGENT, agentType: 'api', content: '', messageId: CARD,
        messages: [userMessage, card],
        metadata: { ...cardMetadata, toolApprovalMode: 'all', toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: APPROVAL, approved: true, reason: 'User approved' }] }
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

describe('send-routed + /api/sse: a stalled start that lands after the save (BL-871 a, the real handlers)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl871-${count}`
    mocks.heldStart = null
    mocks.holdStart = false
    eventFetch.mockClear()
    previousToken = envRecord.BATSHIT_TOKEN
    envRecord.BATSHIT_TOKEN = SERVICE_TOKEN
    previousLimit = REPLY_EVENT_FORWARD_LIMIT.ms
    REPLY_EVENT_FORWARD_LIMIT.ms = 50
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetWakeRunRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Lark', displayName: 'Lark', agentType: 'api', primary_model_preset_id: PRESET, tool_approval_mode: 'all' } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-871', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    REPLY_EVENT_FORWARD_LIMIT.ms = previousLimit
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('a reply’s own start that lands after the save is refused: the reply stays saved and closed, and no tab is told it started again', async () => {
    const tab = await openTab()
    mocks.holdStart = true
    expect((await send()).status).toBe(200)

    // The start passed its limit: the reply is a gap, saved from its own copy, and closed.
    const saved = await stored(REPLY)
    expect(saved.content).toBe('The first part. The second part.')
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(isReplyClosed(SESSION, REPLY)).toBe(true)

    // The stalled start finally reaches `/api/sse`.
    expect(mocks.heldStart).not.toBeNull()
    expect(await mocks.heldStart!.release()).toMatchObject({ success: false })
    // BL-871 (d): during the stall the terminal events go through their tail, unwaited.
    await vi.waitFor(() => expect(tab.received.some((event) => event?.messageId === REPLY && event.type === 'complete')).toBe(true))
    await tab.close()

    expect(isReplyClosed(SESSION, REPLY)).toBe(true)
    // Nothing of the reply waits in the replay as a running reply: no start without its end.
    const replayed = listReplayEvents(SESSION).filter((event) => event.messageId === REPLY).map((event) => event.type)
    expect(replayed).not.toContain('start')
    // The tab got the reply's end, and no start after it.
    const types = tab.received.filter((event) => event?.messageId === REPLY).map((event) => event.type)
    expect(types).toContain('end')
    expect(types.slice(types.indexOf('end'))).not.toContain('start')
    expect(await stored(REPLY)).toEqual(saved)
  }, 30_000)

  it('an approval resume’s own start that lands after its save is refused: the finalize closed it with the resume’s version', async () => {
    const tab = await openTab()
    mocks.holdStart = true
    expect((await resumeApprovedCard()).status).toBe(200)

    const saved = await stored(CARD)
    expect(saved.content).toBe('Asking first.\n\nThe first part. The second part.')
    expect(saved.metadata.replySavedFromOwnCopy).toBe(true)
    expect(typeof saved.metadata.approvalResumeVersion).toBe('number')

    // The held start opens that same resume part (its version), so it is late, not newer.
    expect(await mocks.heldStart!.release()).toMatchObject({ success: false })
    await vi.waitFor(() => expect(tab.received.some((event) => event?.messageId === CARD && event.type === 'complete')).toBe(true))
    await tab.close()

    expect(isReplyClosed(SESSION, CARD)).toBe(true)
    const types = tab.received.filter((event) => event?.messageId === CARD).map((event) => event.type)
    expect(types).toContain('end')
    expect(types.slice(types.indexOf('end'))).not.toContain('start')
  }, 30_000)
})
