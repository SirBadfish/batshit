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
 * BL-869 through the real send-routed handler and the real `/api/sse` POST, joined by the event
 * fetch: in a group round, the next speaker reads the earlier speaker's reply as it was SAVED.
 *
 * Since BL-775 the server owns a reply's saved record: the finalize rebuilds the reply from the
 * events `/api/sse` recorded after its zip detection, saves that, and `end` carries it to every
 * tab. The group runner still handed the next speaker the stream handler's own copy
 * (`finishSummary.content`), which is a different text whenever the stream path changed what it
 * recorded: an `<error>` block the stream path zipped is still raw text in the own copy (the batch
 * zip pass does not run when the chunks reached `/api/sse`). So the next speaker read
 * `<error>...</error>` where every tab, the saved record, and the next round read a zip.
 *
 * Faked: the compiler's output (it records what each speaker's compile was handed) and the model.
 */

const USER = 'user-bl869'
const AGENT_A = 'agent-bl869-a'
const AGENT_B = 'agent-bl869-b'
const PRESET = 'preset-bl869'
const GROUP = 'group-bl869'
const SERVICE_TOKEN = 'test-internal-token-bl869'
const CONTROL = '<batshit-group>{"mode":"responding"}</batshit-group>'

const mocks = vi.hoisted(() => ({
  /** The text deltas the fake model streams, per model run (1-based). */
  runs: [] as string[][],
  runCount: 0,
  /** What each speaker's compile was handed: its agent, its history, and its current message. */
  compiles: [] as Array<{ agentId: string; messages: any[]; current: unknown; liveFileReadTurn?: unknown }>,
  /** SA-137: the live-read turn each speaker's group precompile was handed. */
  precompiles: [] as Array<{ agentId: string; liveFileReadTurn?: unknown }>,
  /** A forwarded event type the event fetch answers 500 for, without reaching `/api/sse` (a gap). */
  failForwardOf: null as string | null
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
    async prepareGroupHistory(_sessionId: string, _messages: any[], agent: any, _userId: unknown, options?: { liveFileReadTurn?: unknown }) {
      mocks.precompiles.push({ agentId: agent?.id, liveFileReadTurn: options?.liveFileReadTurn })
      return { globalZipSettings: null }
    }

    async buildFormattedChatInput(_sessionId: string, messages: any[], agent: any, current: unknown, _subagents?: unknown, _userId?: unknown,
      options?: { liveFileReadTurn?: unknown }) {
      mocks.compiles.push({ agentId: agent?.id, messages: structuredClone(messages ?? []), current, liveFileReadTurn: options?.liveFileReadTurn })
      return {
        primarySystemPrompt: 'You are a test agent.',
        structuredInput: { messages: [{ role: 'user', content: 'Hello everyone.' }], metadata: {} },
        resolvedProjectPath: null
      }
    }
  }
  return { ...actual, DatabaseService }
})

vi.mock('$lib/server/services/vercelBrain', () => ({
  VercelAIBrain: class {
    async streamNativeMode(request: any) {
      mocks.runCount += 1
      const words = mocks.runs[mocks.runCount - 1] ?? [`${'<batshit-group>{"mode":"listening"}</batshit-group>'}`]
      const text = words.join('')
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* stream() {
        yield { type: 'start' }
        yield { type: 'start-step', request: {}, warnings: [] }
        yield { type: 'text-start', id: 't1' }
        for (const word of words) yield { type: 'text-delta', id: 't1', text: word }
        yield { type: 'text-end', id: 't1' }
        yield { type: 'finish-step', finishReason: 'stop', usage, response: {} }
        await request.onFinish?.({ text, steps: [], totalUsage: usage, usage, reasoning: [], responseMessages: [] })
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
let POST: (event: any) => Promise<Response>
let SSE_ROUTE: any
let SESSION = ''
useSendHandlerFixture({ sessionIds: () => [SESSION], postStartupMcpUsers: () => [USER] })
let count = 0

/** The event fetch: a forward to `/api/sse` reaches the real route; nothing else is called. */
const eventFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (!url.endsWith('/api/sse')) return new Response('{}', { status: 200 })
  const event = JSON.parse(String(init?.body ?? '{}'))
  if (mocks.failForwardOf && event.type === mocks.failForwardOf) return new Response('record failed (test)', { status: 500 })
  return SSE_ROUTE.POST({
    request: new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }),
    locals: { user: { id: USER } }
  })
})

function sendToGroup(): Promise<Response> {
  return POST({
    request: new Request('http://localhost/api/messages/send-routed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION,
        agentId: AGENT_A,
        agentType: 'api',
        content: 'Hello everyone.',
        messageId: `msg-group-user-${count}`,
        messages: [{ id: `msg-group-user-${count}`, role: 'user', content: 'Hello everyone.' }]
      })
    }),
    fetch: eventFetch,
    locals: { user: { id: USER } }
  } as any)
}

async function createAgent(id: string, name: string, extra: Record<string, unknown> = {}) {
  await redis.createAgent({ id, user_id: USER, name, displayName: name, agentType: 'api', primary_model_preset_id: PRESET, ...extra } as any)
}

describe('send-routed + /api/sse: a group round’s later speaker reads the earlier reply as saved (BL-869, the real handlers)', () => {
  beforeAll(async () => {
    ;({ POST } = await import('./+server'))
    SSE_ROUTE = await import('../../sse/+server')
  }, 120_000)

  beforeEach(async () => {
    count += 1
    SESSION = `session-bl869-${count}`
    mocks.runs = []
    mocks.runCount = 0
    mocks.compiles = []
    mocks.precompiles = []
    mocks.failForwardOf = null
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
    ;(redis as any).getGroup = vi.fn(async (id: string) => redis.execute((client: any) => client.json.get(`group:${id}`)))
    await redis.set(`model:${PRESET}`, {
      id: PRESET, name: 'Test model', provider: 'anthropic', modelId: 'claude-sonnet-5', contextWindow: 200_000, capabilities: {}, settings: {}
    })
    // Refreshed File Reads is ON by default since 2026-11-04 (SA-137 D13); these rounds keep it off
    // unless a test turns it on, as they were written.
    await createAgent(AGENT_A, 'Lark', { live_file_reads: false })
    await createAgent(AGENT_B, 'Wren', { live_file_reads: false })
    await redis.createSession({ id: SESSION, user_id: USER, title: 'BL-869', agent_id: AGENT_A } as any)
    await redis.execute((client: any) =>
      client.json.set(`group:${GROUP}`, '$', {
        id: GROUP, user_id: USER, name: 'BL-869 group', agent_ids: [AGENT_A, AGENT_B], driver_mode: true, driver_agent_id: AGENT_A, max_followups_total: 1
      })
    )
    await redis.execute((client: any) => client.json.set(`session:${SESSION}`, '$.metadata', { group_chat: { group_id: GROUP } }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (redis as any).getGroup
    if (previousToken === undefined) delete envRecord.BATSHIT_TOKEN
    else envRecord.BATSHIT_TOKEN = previousToken
    __resetReplyRecordsForTests()
  })

  it('hands the next speaker the saved reply, with its zip and the allow-list that trusts it, not the own copy', async () => {
    mocks.runs = [
      [`${CONTROL}Look: `, '<error>Traceback: boom at line 3</error>', ' Done.'],
      [`${CONTROL}Noted.`]
    ]
    expect((await sendToGroup()).status).toBe(200)

    const messages = (await redis.getMessages(SESSION, 50)) as any[]
    const first = messages.find((message) => message.role === 'assistant' && message.agent_id === AGENT_A)
    // The stream path zipped the error block: the saved reply names the zip, and holds no raw block.
    expect(first?.content).not.toContain('<error>')
    const [zip] = scanZipReferences(first.content)
    expect(zip?.id).toMatch(/^error_/)
    expect(first.metadata.zipIds).toContain(zip.id)

    // The second speaker ran, and its compile was handed the first reply as it was saved.
    const second = mocks.compiles.find((compile) => compile.agentId === AGENT_B)
    expect(second).toBeDefined()
    const earlier = second!.messages.find((message) => message.role === 'assistant' && message.agent_id === AGENT_A)
    expect(earlier?.content).toBe(first.content)
    expect(earlier?.metadata?.zipIds).toEqual(first.metadata.zipIds)
    // And its follow-up prompt quotes the saved words too.
    expect(String(second!.current)).toContain(first.content)
    expect(String(second!.current)).not.toContain('<error>')
  }, 30_000)

  // The review's SHOULD: a speaker's reply saved from its OWN copy (a forward of the reply failed,
  // so its record has a gap) is that copy stripped of Goon cues too, as the rebuild's text is. A
  // reply that is only a cue left the stripped copy empty, the finalize then took the SDK's finish
  // text, which never went through the group strip, and the raw cue markup was saved and handed to
  // the round's later speakers.
  // Review N1: a cue the model wrote BEFORE the group block (the stream's parser drops it first)
  // must not keep the block from being stripped as the leading one. With a cue after the block as
  // well, the streamed copy strips to nothing, so the own copy is the SDK's finish text, cue first.
  it.each([
    ['after the group block', 'after'],
    ['before and after the group block', 'both']
  ])('a gap reply that is only a Goon cue (%s) is saved without its markup, and no later speaker reads it', async (_label, place) => {
    const cue = '<batshit-cue>{"mood":"happy","gesture":"wave"}</batshit-cue>'
    // The reply's start never reaches `/api/sse`: its record has a gap, so its own copy is saved.
    mocks.failForwardOf = 'start'
    mocks.runs = [place === 'after' ? [CONTROL, cue] : [cue, CONTROL, cue], [`${CONTROL}Noted.`]]
    expect((await sendToGroup()).status).toBe(200)

    const messages = (await redis.getMessages(SESSION, 50)) as any[]
    const first = messages.find((message) => message.role === 'assistant' && message.agent_id === AGENT_A)
    expect(first?.metadata?.replySavedFromOwnCopy).toBe(true)
    expect(String(first?.content ?? '')).not.toContain('batshit-cue')
    expect(String(first?.content ?? '')).not.toContain('batshit-group')
    for (const compile of mocks.compiles.filter((entry) => entry.agentId !== AGENT_A)) {
      expect(JSON.stringify(compile.messages)).not.toContain('batshit-cue')
      expect(String(compile.current)).not.toContain('batshit-cue')
    }
  }, 30_000)

  it('SA-137: each API speaker with live file reads on gets its own turn, the same one in its precompile and its compile', async () => {
    const live = { live_file_reads: true, provider_specific_settings: { nativeTools: { executionBackend: 'local' } } }
    await createAgent(AGENT_A, 'Lark', live)
    await createAgent(AGENT_B, 'Wren', live)
    mocks.runs = [[`${CONTROL}First.`], [`${CONTROL}Second.`]]
    expect((await sendToGroup()).status).toBe(200)
    const { LiveFileReadTurn } = await import('$lib/server/services/liveFileReadTurn.server')
    const turnOf = (agentId: string) => {
      const pre = mocks.precompiles.find((entry) => entry.agentId === agentId)?.liveFileReadTurn
      const compiled = mocks.compiles.find((entry) => entry.agentId === agentId)?.liveFileReadTurn
      expect(pre).toBeInstanceOf(LiveFileReadTurn)
      expect(compiled).toBe(pre)
      return pre
    }
    expect(turnOf(AGENT_A)).not.toBe(turnOf(AGENT_B))
  }, 30_000)

  it('SA-137: with live file reads off, no speaker gets a turn', async () => {
    mocks.runs = [[`${CONTROL}First.`], [`${CONTROL}Second.`]]
    expect((await sendToGroup()).status).toBe(200)
    expect(mocks.precompiles.length).toBeGreaterThan(0)
    expect(mocks.precompiles.every((entry) => entry.liveFileReadTurn === undefined)).toBe(true)
    expect(mocks.compiles.every((entry) => entry.liveFileReadTurn === undefined)).toBe(true)
  }, 30_000)
})
