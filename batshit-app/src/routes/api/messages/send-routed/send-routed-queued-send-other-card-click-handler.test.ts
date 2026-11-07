// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  __resetStreamAbortRegistryForTests,
  getQueueCardHold,
  isUserMessageQueued
} from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import { __resetTurnOutcomesForTests, watchTurnOutcome, type TurnOutcome } from '$lib/server/services/turnOutcomeRegistry'

/**
 * BL-903 (b), review S1 — a click on ANOTHER card does not leave the tabs without the hold.
 *
 * A message waits in the chat's line while the line holds for the approval card on reply C. A click
 * on an older card (reply X, still pending) may take the chat: it answers its own card, and the
 * line's hold on C stands. While that click runs, `/api/sse` sends the tabs no hold (the joining
 * tab's replay rule: no hold while a turn holds the chat), and when the click ends with no new card
 * the hold is still C's. The click's request told the tabs nothing then, so they drew a plain
 * "Queued" with no Send now for up to fifteen minutes. Its end now says the hold again when one
 * stands after its release and its registration ended no hold (`endedCardHold === false`, the
 * only registration that can hold the chat beside a hold; `/api/sse` re-reads the truth).
 *
 * The harness is the card-hold handler's (`send-routed-queued-send-card-hold-handler.test.ts`):
 * faked are the compiler's OUTPUT (with the Whiteboard context a real API compile freezes) and the
 * API lane's model; everything between is the handler's own code on the Redis lane the run selects.
 */

const USER = 'user-bl903s1'
const AGENT = 'agent-bl903s1'
const PRESET = 'preset-bl903s1'
const X_REPLY = 'msg-x-reply'
const C_REPLY = 'msg-c-reply'
const B = 'msg-b'

type ModelRun = 'reply' | 'card'

const mocks = vi.hoisted(() => ({
  modelRuns: new Map<number, 'reply' | 'card'>(),
  duringRun: new Map<number, () => Promise<void>>(),
  brainRuns: [] as string[]
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => {}) }
})

vi.mock('$lib/server/services/nativeTools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeToolService: { cleanupExecutionSandboxesForSession: vi.fn(async () => []) }
}))

vi.mock('$lib/services/databaseRedis.server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  class DatabaseService extends actual.DatabaseService {
    async buildFormattedChatInput(
      sessionId: string,
      _history: unknown,
      agent: unknown,
      _current: unknown,
      _subagents: unknown,
      userId: unknown,
      options?: { whiteboardContextSnapshot?: any; whiteboardMessageId?: string }
    ) {
      return {
        primarySystemPrompt: 'You are a test agent.',
        // What a real API compile freezes; the pause keeps it on the card, the resume needs it.
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? {
          schema_version: 1,
          userId,
          sessionId,
          agentId: (agent as any).id,
          messageId: options?.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true },
          dcmLines: []
        },
        structuredInput: { messages: [{ role: 'user', content: 'Hello from the compile.' }], metadata: {} },
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
      const run = mocks.brainRuns.length
      const plan: ModelRun = mocks.modelRuns.get(run) ?? 'reply'
      const during = mocks.duringRun.get(run)
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      if (plan === 'card') {
        const callId = `call_ls_${run}`
        const approvalId = `aitxt-bl903s1-${run}`
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
          if (during) await during()
          yield { type: 'tool-approval-request', approvalId, toolCallId: callId, toolName: 'native_bash_execute', input: { command: 'ls' } }
          yield { type: 'finish-step', finishReason: 'tool-calls', usage, response: {} }
          await request.onFinish?.({
            text: 'I need to list the folder.',
            steps: [],
            totalUsage: usage,
            usage,
            reasoning: [],
            responseMessages: [{ role: 'assistant', content: parts }]
          })
          yield { type: 'finish', finishReason: 'tool-calls', totalUsage: usage }
        }
        return {
          stream: paused(),
          content: Promise.resolve(parts),
          steps: Promise.resolve([]),
          response: Promise.resolve({ messages: [{ role: 'assistant', content: parts }] })
        }
      }
      const text = `Reply for ${request.messageId}.`
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text }
        yield { type: 'text-end', id: 't1' }
        if (during) await during()
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0
let forwards: Array<Record<string, any>> = []
let requests: Promise<unknown>[] = []

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function request(body: Record<string, unknown>, options: { respondAsync?: boolean } = {}) {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.respondAsync ? { prefer: 'respond-async' } : {})
      },
      body: JSON.stringify({ sessionId: SESSION, agentId: AGENT, agentType: 'api', ...body })
    }),
    fetch: globalThis.fetch,
    locals: { user: { id: USER } }
  } as any)
}

async function saveUserMessage(id: string, content: string) {
  const record = {
    id,
    session_id: SESSION,
    user_id: USER,
    agent_id: AGENT,
    role: 'user',
    status: 'complete',
    content,
    created_at: new Date().toISOString(),
    metadata: { client_sent: true }
  }
  await redis.saveMessage(record as any)
  return record
}

/**
 * The page's send of a message while a reply runs: saved first, posted at once (respond-async).
 * Its final answer comes over the turn's outcome, kept in an object so awaiting the send does not
 * wait for that answer too.
 */
async function sendWhileBusy(id: string, content: string): Promise<{ outcome: Promise<TurnOutcome> }> {
  const saved = await saveUserMessage(id, content)
  const accepted = await request(
    { content, messageId: `${id}-reply`, userMessageId: id, messages: [saved] },
    { respondAsync: true }
  )
  expect(accepted.status).toBe(202)
  const outcome = accepted
    .clone()
    .json()
    .then(({ turnId }: { turnId: string }) => new Promise<TurnOutcome>((resolve) => watchTurnOutcome(turnId, USER, resolve)))
  requests.push(outcome.catch(() => {}))
  return { outcome }
}

/** The page's Approve on the pending card of one reply, with the chat as the page shows it. */
async function approve(replyId: string) {
  const chat = (await redis.getMessages(SESSION)) as any[]
  const card = chat.find((message: any) => message.id === replyId) as any
  const pending = card?.metadata?.toolApprovals?.approvals?.find((entry: any) => entry.status === 'pending')
  if (!card || !pending) throw new Error(`expected a pending card on ${replyId}`)
  return request({
    content: '',
    messageId: replyId,
    messages: chat,
    metadata: {
      ...card.metadata,
      toolApprovalMode: 'all',
      toolApprovalResponse: [{ type: 'tool-approval-response', approvalId: pending.approvalId, approved: true, reason: 'User approved' }]
    }
  })
}

const holdNotices = () => forwards.filter((body) => body.type === 'queued_send_hold')

describe('send-routed: a click on another card keeps the tabs told of the line’s hold (BL-903 b, review S1)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl903s1-${count}`
    mocks.modelRuns.clear()
    mocks.duringRun.clear()
    mocks.brainRuns = []
    forwards = []
    requests = []
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetTurnOutcomesForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body ?? '{}'))
          if (body && typeof body.type === 'string') forwards.push(body)
        } catch {
          // not a JSON forward
        }
        return new Response('{}', { status: 200 })
      })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, {
      id: PRESET,
      name: 'Test model',
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      contextWindow: 200_000,
      capabilities: {},
      settings: {}
    })
    await redis.createAgent({
      id: AGENT,
      user_id: USER,
      name: 'Probe',
      displayName: 'Probe',
      agentType: 'api',
      primary_model_preset_id: PRESET,
      tool_approval_mode: 'all'
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-903 S1', agent_id: AGENT } as any)
  })

  afterEach(async () => {
    __resetStreamAbortRegistryForTests()
    await Promise.race([Promise.allSettled(requests), tick(5_000)])
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    __resetTurnOutcomesForTests()
  }, 15_000)

  it('when the other card’s click ends with no new card, every tab is told again that the line holds for C', async () => {
    // Reply X stops at a card nobody answers yet; nothing waits, so the line holds nothing.
    mocks.modelRuns.set(1, 'card')
    const first = await saveUserMessage('msg-user-1', 'List the folder.')
    expect((await request({ content: 'List the folder.', messageId: X_REPLY, userMessageId: 'msg-user-1', messages: [first] })).status).toBe(200)
    expect(getQueueCardHold(SESSION)).toBeNull()

    // Reply C stops at its own card while B waits in the line: the line holds for C.
    let sentB: { outcome: Promise<TurnOutcome> } | null = null
    mocks.modelRuns.set(2, 'card')
    mocks.duringRun.set(2, async () => {
      sentB = await sendWhileBusy(B, 'And summarise the file I attached.')
    })
    const second = await saveUserMessage('msg-user-2', 'Now list the other folder.')
    expect((await request({ content: 'Now list the other folder.', messageId: C_REPLY, userMessageId: 'msg-user-2', messages: [second] })).status).toBe(200)
    expect(sentB).not.toBeNull()
    expect(getQueueCardHold(SESSION)?.messageId).toBe(C_REPLY)
    expect(holdNotices().at(-1)).toMatchObject({ heldForApprovalCard: { messageId: C_REPLY } })
    const noticesBeforeTheClick = holdNotices().length

    // The user approves the OLDER card, X: its click takes the chat, its reply ends with no card.
    const clicked = await approve(X_REPLY)
    expect(clicked.status).toBe(200)
    expect(mocks.brainRuns).toEqual([X_REPLY, C_REPLY, X_REPLY])

    // The line still holds for C, B still waits, and every tab is told the hold again.
    expect(getQueueCardHold(SESSION)?.messageId).toBe(C_REPLY)
    expect(isUserMessageQueued(SESSION, B)).toBe(true)
    expect(holdNotices().slice(noticesBeforeTheClick)).toEqual([
      { type: 'queued_send_hold', sessionId: SESSION, heldForApprovalCard: { messageId: C_REPLY } }
    ])
  }, 30_000)
})
