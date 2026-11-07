// @vitest-environment node
import { useSendHandlerFixture } from '$lib/test-utils/sendHandlerFixture'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { __resetStreamAbortRegistryForTests } from '$lib/server/services/streamAbortRegistry'
import { __resetSteerInboxRegistryForTests } from '$lib/server/services/steerInboxRegistry'
import {
  __resetReplyRecordsForTests,
  isLateReplyEvent,
  recordReplyEvent,
  startReplyRecord
} from '$lib/server/services/replyStreamRecord'
import { scanZipReferences } from '$lib/utils/zipReferenceSafety'
import type { SavedModel } from '$lib/types/savedModels'

/**
 * BL-697 through the real send-routed handler: a reply with a tool card between two runs of words.
 *
 * Seen 2026-09-27 on the managed Claude lane (before BL-775): `end` carried a blank line after each
 * `{{batshit-zip:...}}` reference (the `/api/sse` end rebuild places a tool's reference inline,
 * `composeToolStreamContent`), while the reply a tab saved had none, so a reload laid the reply out
 * differently from what the tab showed. Since BL-775 the server saves the rebuild and `end` carries
 * the saved bytes: one copy. This pins that the two are the same bytes for a reply whose tool card
 * sits between words, through the real `redis.saveMessage` (its own clean-up: one reference per
 * zip, three or more line breaks collapsed, the ends trimmed) on the real Redis lane.
 *
 * Every managed lane (API, Claude) feeds the same stream loop and the same finalize, so the
 * API lane's fake model stands in for the Claude adapter's chunks here.
 */

const USER = 'user-bl697'
const AGENT = 'agent-bl697'
const PRESET = 'preset-bl697'
const REPLY = 'msg-reply-bl697'
const BEFORE = 'This is a read-only request, so I can answer directly.\n\n'
const AFTER = 'ExitPlanMode is not available in this session, so here is the answer.'

const mocks = vi.hoisted(() => ({
  forwards: [] as Array<Record<string, any>>
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
    async buildFormattedChatInput(sessionId: string, _messages: unknown, agent: any, _content: unknown, _assigned: unknown, userId: string, options: any) {
      return {
        primarySystemPrompt: 'You are a test agent.',
        whiteboardContextSnapshot: options?.whiteboardContextSnapshot ?? { schema_version: 1, userId, sessionId, agentId: agent.id, messageId: options.whiteboardMessageId,
          settings: { mode: 'neither', whiteboardEnabled: false, preserveReasoning: false, whiteboardBudgetTokens: 1500, showWhiteboard: true }, dcmLines: [] },
        structuredInput: { messages: [{ role: 'user', content: 'Answer it.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        yield { type: 'text-delta', id: 't1', text: BEFORE }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'tool-call', toolCallId: 'call_exit_plan', toolName: 'ExitPlanMode', input: {} }
        yield {
          type: 'tool-result',
          toolCallId: 'call_exit_plan',
          toolName: 'ExitPlanMode',
          input: {},
          output: { success: false, error: 'ExitPlanMode is not available.' }
        }
        yield { type: 'finish-step', finishReason: 'tool-calls', usage, response: {} }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't2' }
        yield { type: 'text-delta', id: 't2', text: AFTER }
        yield { type: 'text-end', id: 't2' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text: BEFORE + AFTER, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
        yield { type: 'finish', finishReason: 'stop', totalUsage: usage }
      }
      return { stream: stream(), steps: Promise.resolve([]), response: Promise.resolve({ messages: [] }) }
    }
  }
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>()
  return { ...actual, publishUserEvent: vi.fn(async () => undefined) }
})

useRedisTestServer()

let POST: (event: any) => Promise<Response>
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

async function stored(id: string) {
  return (await redis.execute((client: any) => client.json.get(`message:${SESSION}:${id}`))) as any
}

/** `/api/sse` as BL-775 wires it: every event of the reply recorded, then `success`. */
const sseForward = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  mocks.forwards.push(event)
  if (isLateReplyEvent(event.sessionId, event)) {
    return new Response(JSON.stringify({ success: false, message: 'The reply was already saved' }), { status: 200 })
  }
  if (event.type === 'start') startReplyRecord(event.sessionId, { ...event })
  else if (event.type !== 'end' && event.messageId) recordReplyEvent(event.sessionId, { ...event })
  return new Response(JSON.stringify({ success: true }), { status: 200 })
})

const model = {
  id: PRESET,
  name: 'Test model',
  provider: 'anthropic',
  modelId: 'claude-sonnet-5',
  modelName: 'Claude Sonnet 5',
  contextWindow: 200_000,
  capabilities: {},
  settings: {},
  pricing: { input: 3, output: 15 },
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z'
} as unknown as SavedModel

describe('BL-697: a reply with a tool card between its words is stored as `end` carries it', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl697-${count}`
    mocks.forwards = []
    sseForward.mockClear()
    __resetStreamAbortRegistryForTests()
    __resetSteerInboxRegistryForTests()
    __resetReplyRecordsForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await redis.set(`model:${PRESET}`, model)
    // The real lane's agent create reads the preset as this user's own (`user:<id>:models`).
    await redis.sAdd(`user:${USER}:models`, PRESET)
    await redis.createAgent({
      id: AGENT,
      user_id: USER,
      name: 'Probe',
      displayName: 'Probe',
      agentType: 'api',
      primary_model_preset_id: PRESET,
      tool_approval_mode: 'off'
    } as any)
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-697', agent_id: AGENT } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetReplyRecordsForTests()
  })

  it('the stored reply and `end` are the same bytes, the blank line after the card included', async () => {
    const response = await POST({
      request: new Request('http://localhost/api/messages/send-routed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION,
          agentId: AGENT,
          agentType: 'api',
          content: 'Answer it.',
          messageId: REPLY,
          messages: [{ id: 'msg-user-1', role: 'user', content: 'Answer it.' }]
        })
      }),
      fetch: sseForward,
      locals: { user: { id: USER } }
    } as any)
    expect(response.status).toBe(200)

    const saved = await stored(REPLY)
    const end = mocks.forwards.find((event) => event.type === 'end')
    expect(end?.savedRecord).toBe(true)
    expect(saved?.metadata?.replySavedFromOwnCopy).toBeUndefined()

    // The tool's card is in the text, between the two runs of words.
    const references = scanZipReferences(saved.content)
    expect(references).toHaveLength(1)
    const reference = saved.content.slice(references[0].start, references[0].end)
    expect(saved.content).toBe(`${BEFORE}${reference}\n\n${AFTER}`)

    // One copy: what every tab shows at `end` is what a reload shows and what the agent reads next.
    expect(end?.content).toBe(saved.content)
  }, 60_000)
})
