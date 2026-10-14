import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { mapAppServerItem, mapAppServerPlan, startCodexAppServerRun } from '../services/codexAppServerLane'
import { CodexEventAdapter } from '../services/codexEventAdapter'
import type { NativeModeRequest } from '../services/vercelBrain'
import { toolStepFailureMessage } from '$lib/utils/toolResultProcessor'
import { CAPTURED_ANSWER_DROP_AFTER_REASONING } from '$lib/test-utils/codex-app-server-retries'
import { hasUsageValues, normalizeUsageLike } from '../services/apiProviderUsage'
import { buildTokenUsage } from '../services/executionViewerLlmCapture'
import { mergeResumedTokenUsage, mergeResumedUsage } from '../services/approvalResumeMessage'

// `approvalResumeMessage.ts` imports the Redis client; its merge rules read none of it.
vi.mock('$lib/server/redis', () => ({
  redis: new Proxy(
    {},
    {
      get() {
        throw new Error('This test reaches no Redis.')
      }
    }
  )
}))

/**
 * BR-1 packet 2 — four app-server notifications that never reached the event adapter as the exec
 * stream's shapes: plan updates (BL-459), live reasoning (BL-464), an opened page's URL (BL-460),
 * and a failed MCP call (BL-461). Each test plays notifications through a fake `codex app-server`
 * into the real lane and the real adapter, the way `CodexBridge` reads a run. BL-1376 adds the
 * turn's usage: only the counts Codex reported, never a zero for one it did not.
 *
 * The reasoning deltas are the pinned Codex's own (captured from codex-cli 0.157.1,
 * `$lib/test-utils/codex-app-server-retries.ts`). No live capture of a plan update, a web search
 * or a failed MCP call exists; those shapes follow Codex's own protocol, field for field: the
 * schema `codex app-server generate-json-schema` wrote for 0.157.1
 * (`_local/turn-pack-2026-09-27/w7-bl457/protocol-0.157.1-json/` on the Mac) and the source of the
 * pinned 0.160.0 (`app-server-protocol/src/protocol/v2/{turn,item,mcp}.rs`,
 * `ext/items/src/web_search.rs`, `core/src/mcp_tool_call.rs`).
 */

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: any[]) => spawnMock(...args)
  return {
    ...original,
    spawn,
    default: { ...((original as any).default ?? original), spawn }
  }
})

beforeEach(() => {
  // Nothing here may reach batshit-server or any other endpoint.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('This test reaches no endpoint.')
    })
  )
})

afterEach(() => {
  spawnMock.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const THREAD = 'thread-1'
const TURN = 'turn-1'

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: (signal?: string) => boolean
}

type Notify = (method: string, params: Record<string, unknown>) => void

/** A fake app server that answers the start-up requests, then plays `script` once the turn starts. */
function createScriptedAppServer(script: (notify: Notify) => Promise<void>, beforeTurnReply?: (notify: Notify) => void) {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  const send = (msg: Record<string, unknown>) => child.stdout.write(JSON.stringify(msg) + '\n')
  const notify: Notify = (method, params) => send({ jsonrpc: '2.0', method, params })

  let buffered = ''
  child.stdin.on('data', (chunk) => {
    buffered += String(chunk)
    let index = buffered.indexOf('\n')
    while (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      index = buffered.indexOf('\n')
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake' } })
      } else if (msg.method === 'thread/start') {
        send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: THREAD, ephemeral: true } } })
      } else if (msg.method === 'turn/start') {
        beforeTurnReply?.(notify)
        send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: TURN, status: 'inProgress' } } })
        void script(notify)
      }
    }
  })
  return child
}

function buildRequest(): NativeModeRequest {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'agent-1',
    userId: 'user-1',
    model: 'codex/codex-cli',
    messages: [{ role: 'user', content: 'say hello' }],
    availableTools: [],
    maxToolRounds: 1
  }
}

/** Plays a run through the real lane and the real adapter, the way `CodexBridge` reads it. */
function play(script: (notify: Notify) => Promise<void>, options: { signal?: AbortSignal; beforeTurnReply?: (notify: Notify) => void } = {}) {
  const child = createScriptedAppServer(script, options.beforeTurnReply)
  spawnMock.mockReturnValue(child)
  const run = startCodexAppServerRun({
    executable: 'codex',
    env: {},
    threadParams: { ephemeral: true },
    prompt: 'say hello',
    signal: options.signal,
  })
  let finishSteps: any[] = []
  const finishUsages: unknown[] = []
  const finishObservations: unknown[] = []
  const adapter = new CodexEventAdapter({
    request: buildRequest(),
    transport: 'cli',
    getObservedUsage: run.getObservedUsage,
    onFinish: ({ steps, totalUsage, observedUsage }) => {
      finishSteps = steps
      finishUsages.push(totalUsage)
      finishObservations.push(observedUsage)
    }
  })
  const chunks: any[] = []
  const state: { failure: Error | null } = { failure: null }
  const finished = (async () => {
    try {
      for await (const chunk of adapter.stream(run.events)) chunks.push(chunk)
    } catch (error) {
      state.failure = error as Error
    } finally {
      await run.cleanup()
    }
  })()
  return { adapter, run, child, chunks, state, finished, steps: () => finishSteps, finishUsages, finishObservations }
}

const turnStarted = { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } }
const turnCompleted = {
  threadId: THREAD,
  turn: { id: TURN, items: [], status: 'completed', error: null }
}
const itemParams = (item: Record<string, unknown>) => ({ item, threadId: THREAD, turnId: TURN })

describe('BL-459: Codex plan updates on the app-server lane', () => {
  /** `TurnPlanUpdatedNotification` (0.160.0 `v2/turn.rs`): `{ threadId, turnId, explanation, plan }`. */
  const planUpdate = (plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>) => ({
    threadId: THREAD,
    turnId: TURN,
    explanation: null,
    plan
  })

  it('maps each step to the exec to-do item: its text, and completed only when completed', () => {
    expect(
      mapAppServerPlan([
        { step: 'Read the file', status: 'completed' },
        { step: 'Fix the bug', status: 'inProgress' },
        { step: 'Run the tests', status: 'pending' }
      ])
    ).toEqual([
      { text: 'Read the file', completed: true },
      { text: 'Fix the bug', completed: false },
      { text: 'Run the tests', completed: false }
    ])
    expect(mapAppServerPlan(undefined)).toEqual([])
  })

  it('streams every turn/plan/updated as the plan update the reply shows, under one id for the turn', async () => {
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      notify(
        'turn/plan/updated',
        planUpdate([
          { step: 'Read the file', status: 'inProgress' },
          { step: 'Fix the bug', status: 'pending' }
        ])
      )
      notify(
        'turn/plan/updated',
        planUpdate([
          { step: 'Read the file', status: 'completed' },
          { step: 'Fix the bug', status: 'inProgress' }
        ])
      )
      notify('item/started', itemParams({ type: 'agentMessage', id: 'msg_1', text: '' }))
      notify('item/completed', itemParams({ type: 'agentMessage', id: 'msg_1', text: 'Done.' }))
      notify('turn/completed', turnCompleted)
    })
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    const plans = consumer.chunks.filter((chunk) => chunk.toolName === 'codex_plan_update')
    // send-routed turns each of these into a `plan_update` event (`isPlanUpdateTool`).
    expect(plans.map((chunk) => [chunk.type, chunk.toolCallId, chunk.result])).toEqual([
      [
        'tool-result',
        `turn-plan-${TURN}`,
        [
          { text: 'Read the file', completed: false },
          { text: 'Fix the bug', completed: false }
        ]
      ],
      [
        'tool-result',
        `turn-plan-${TURN}`,
        [
          { text: 'Read the file', completed: true },
          { text: 'Fix the bug', completed: false }
        ]
      ]
    ])
    // A plan is not a tool step: the adapter keeps none for it (send-routed's own plan filter,
    // `isPlanUpdateTool`, is not exercised here).
    expect(consumer.steps()).toEqual([])
    expect(consumer.chunks.map((chunk) => chunk.type)).toEqual([
      'tool-result',
      'tool-result',
      'text-delta',
      'finish'
    ])
  })
})

describe('BL-464: Codex reasoning streams live on the app-server lane', () => {
  /** The first reasoning item of the pinned Codex's own capture: started, two summary deltas, completed. */
  const capturedReasoning = CAPTURED_ANSWER_DROP_AFTER_REASONING.filter(
    ({ method, params }) =>
      (method.startsWith('item/reasoning/') && params.itemId === 'rs_1') ||
      ((method === 'item/started' || method === 'item/completed') && params.item?.id === 'rs_1')
  )

  it('sends the summary as it is written, before the reasoning item completes', async () => {
    expect(capturedReasoning.map(({ method }) => method)).toEqual([
      'item/started',
      'item/reasoning/summaryPartAdded',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/summaryTextDelta',
      'item/completed'
    ])
    let releaseCompletion: () => void = () => {}
    const completion = new Promise<void>((resolve) => {
      releaseCompletion = resolve
    })
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      for (const { method, params } of capturedReasoning) {
        if (method === 'item/completed') await completion
        notify(method, params)
      }
      notify('turn/completed', turnCompleted)
    })

    // The reasoning item has not completed yet, and its summary is already out.
    await vi.waitFor(() =>
      expect(consumer.chunks.filter((chunk) => chunk.type === 'thinking')).toHaveLength(2)
    )
    expect(consumer.chunks.map((chunk) => [chunk.itemId, chunk.content, chunk.final])).toEqual([
      ['rs_1', '**Thinking** ', false],
      ['rs_1', '**Thinking** about the drop ', false]
    ])

    releaseCompletion()
    await consumer.finished
    expect(consumer.state.failure).toBeNull()
    const thinking = consumer.chunks.filter((chunk) => chunk.type === 'thinking')
    // Codex's own finished text closes it: the same words the deltas built.
    expect(thinking.at(-1)).toMatchObject({ itemId: 'rs_1', content: '**Thinking** about the drop ', final: true })
  })

  it('joins summary parts the way a finished item joins them, and leaves raw reasoning out', async () => {
    const reasoningItem = (summary: string[]) => itemParams({ type: 'reasoning', id: 'rs_9', summary, content: [] })
    const summaryDelta = (summaryIndex: number, delta: string) => ({
      threadId: THREAD,
      turnId: TURN,
      itemId: 'rs_9',
      delta,
      summaryIndex
    })
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      notify('item/started', reasoningItem([]))
      notify('item/reasoning/summaryPartAdded', { threadId: THREAD, turnId: TURN, itemId: 'rs_9', summaryIndex: 0 })
      notify('item/reasoning/summaryTextDelta', summaryDelta(0, 'First part.'))
      // Raw reasoning (`ReasoningTextDeltaNotification`) is not the summary Batshit shows.
      notify('item/reasoning/textDelta', { threadId: THREAD, turnId: TURN, itemId: 'rs_9', delta: 'raw', contentIndex: 0 })
      notify('item/reasoning/summaryPartAdded', { threadId: THREAD, turnId: TURN, itemId: 'rs_9', summaryIndex: 1 })
      notify('item/reasoning/summaryTextDelta', summaryDelta(1, 'Second '))
      notify('item/reasoning/summaryTextDelta', summaryDelta(1, 'part.'))
      notify('item/completed', reasoningItem(['First part.', 'Second part.']))
      notify('turn/completed', turnCompleted)
    })
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    expect(
      consumer.chunks.filter((chunk) => chunk.type === 'thinking').map((chunk) => [chunk.content, chunk.final])
    ).toEqual([
      ['First part.', false],
      ['First part.\nSecond ', false],
      ['First part.\nSecond part.', false],
      ['First part.\nSecond part.', true]
    ])
  })
})

describe('BL-460: an opened page keeps its URL on the app-server lane', () => {
  /** `WebSearchItem` (0.160.0 `ext/items/src/web_search.rs`): `{ id, query, action, results }`. */
  const webSearch = (query: string, action: Record<string, unknown> | null) =>
    itemParams({ type: 'webSearch', id: 'ws_1', query, action, results: null })

  it('maps each action to the exec shape and leaves out a field Codex sent as null', () => {
    expect(
      mapAppServerItem({ type: 'webSearch', id: 'ws_1', query: 'https://example.com/a', action: { type: 'openPage', url: 'https://example.com/a' } })
    ).toEqual({ id: 'ws_1', type: 'web_search', query: 'https://example.com/a', action: { type: 'open_page', url: 'https://example.com/a' } })
    expect(
      mapAppServerItem({ type: 'webSearch', id: 'ws_2', query: "'pricing' in https://example.com/a", action: { type: 'findInPage', url: 'https://example.com/a', pattern: 'pricing' } })
    ).toMatchObject({ action: { type: 'find_in_page', url: 'https://example.com/a', pattern: 'pricing' } })
    expect(
      mapAppServerItem({ type: 'webSearch', id: 'ws_3', query: 'svelte runes', action: { type: 'search', query: 'svelte runes', queries: ['svelte runes', 'svelte 5'] } })
    ).toMatchObject({ action: { type: 'search', query: 'svelte runes', queries: ['svelte runes', 'svelte 5'] } })
    expect(
      mapAppServerItem({ type: 'webSearch', id: 'ws_4', query: '', action: { type: 'openPage', url: null } })
    ).toEqual({ id: 'ws_4', type: 'web_search', query: '', action: { type: 'open_page' } })
    expect(mapAppServerItem({ type: 'webSearch', id: 'ws_5', query: '', action: { type: 'other' } })).toMatchObject({
      action: { type: 'other' }
    })
    expect(mapAppServerItem({ type: 'webSearch', id: 'ws_6', query: 'q', action: null })).toEqual({
      id: 'ws_6',
      type: 'web_search',
      query: 'q'
    })
  })

  it('stores an opened page with its URL as the result row, and its query', async () => {
    const url = 'https://example.com/docs/page'
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      notify('item/started', webSearch('', null))
      notify('item/completed', webSearch(url, { type: 'openPage', url }))
      notify('turn/completed', turnCompleted)
    })
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    const result = consumer.chunks.find((chunk) => chunk.type === 'tool-result')
    expect(result).toMatchObject({ toolName: 'codex_web_search', args: { query: url } })
    expect(result.result).toMatchObject({
      results: [{ title: url, url, source: 'Opened page' }],
      totalMatches: 1,
      query: url
    })
    const [step] = consumer.steps()
    expect(step.toolResult.results).toEqual([expect.objectContaining({ url, source: 'Opened page' })])
  })
})

describe('BL-461: a failed MCP tool call is stored as a failure', () => {
  /** `ThreadItem::McpToolCall` (0.160.0 `v2/item.rs`), as the app server writes it. */
  const mcpCall = (fields: Record<string, unknown>) =>
    itemParams({
      type: 'mcpToolCall',
      id: 'call_mcp_1',
      server: 'docs',
      tool: 'lookup',
      arguments: { topic: 'x' },
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
      status: 'inProgress',
      ...fields
    })

  async function playMcp(completed: Record<string, unknown>) {
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      notify('item/started', mcpCall({}))
      notify('item/completed', mcpCall({ durationMs: 12, ...completed }))
      notify('turn/completed', turnCompleted)
    })
    await consumer.finished
    expect(consumer.state.failure).toBeNull()
    const chunk = consumer.chunks.find((entry) => entry.type === 'tool-result')
    const [step] = consumer.steps()
    return { chunk, step }
  }

  it('marks a tool that answered with an error result (Codex: status failed, the result kept, no error)', async () => {
    const content = [{ type: 'text', text: 'Topic "x" not found.' }]
    const { chunk, step } = await playMcp({
      status: 'failed',
      result: { content, structuredContent: null, _meta: null }
    })

    expect(chunk.result).toEqual({
      content,
      structured_content: null,
      success: false,
      error: 'Topic "x" not found.'
    })
    expect(step.toolResult).toEqual(chunk.result)
    // The shared reader every stored copy of a step uses calls it a failure, with that reason.
    expect(toolStepFailureMessage(chunk.toolName, chunk.args, chunk.result)).toBe('Topic "x" not found.')
  })

  it('marks a call that never reached its tool (Codex: status failed, an error, no result)', async () => {
    const { chunk } = await playMcp({ status: 'failed', error: { message: 'tool call failed: server docs is not running' } })

    expect(chunk.result).toEqual({ success: false, error: 'tool call failed: server docs is not running' })
    expect(toolStepFailureMessage(chunk.toolName, chunk.args, chunk.result)).toBe(
      'tool call failed: server docs is not running'
    )
  })

  it("keeps a tool's own error text when its shaped result already has one", async () => {
    // A Dynamic MCP find's result is unwrapped into its own fields, which can name the error.
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      const find = { server: 'gateway', tool: 'dynamic_mcp_find', arguments: { query: '' } }
      notify('item/started', mcpCall(find))
      notify(
        'item/completed',
        mcpCall({
          ...find,
          status: 'failed',
          result: {
            content: [{ type: 'text', text: '{"error":"The query was empty.","results":[]}' }],
            structuredContent: null,
            _meta: null
          }
        })
      )
      notify('turn/completed', turnCompleted)
    })
    await consumer.finished

    const chunk = consumer.chunks.find((entry) => entry.type === 'tool-result')
    expect(chunk.result).toMatchObject({ success: false, error: 'The query was empty.', results: [] })
  })

  it('gives a reason when a failed result has no text', async () => {
    const { chunk } = await playMcp({ status: 'failed', result: { content: [], structuredContent: null, _meta: null } })

    expect(chunk.result).toMatchObject({ success: false, error: 'Codex reported that this tool call failed.' })
  })

  it('leaves a completed call exactly as it was', async () => {
    const content = [{ type: 'text', text: 'Found it.' }]
    const { chunk } = await playMcp({ status: 'completed', result: { content, structuredContent: { ok: true }, _meta: null } })

    expect(chunk.result).toEqual({ content, structured_content: { ok: true } })
    expect(toolStepFailureMessage(chunk.toolName, chunk.args, chunk.result)).toBeUndefined()
  })
})

describe("BL-1376: a Codex turn's usage is what Codex reported, never a made-up zero", () => {
  /**
   * `thread/tokenUsage/updated` as the pinned Codex sends it. The shape is the 0.160.0 source's
   * (`app-server-protocol/src/protocol/v2/thread.rs`: `ThreadTokenUsageUpdatedNotification`,
   * `ThreadTokenUsage`, `TokenUsageBreakdown`, every count required), which matches field for field
   * the 0.157.1 capture the counts below come from
   * (`_local/turn-pack-2026-09-27/w7-bl457/app-server-0.157.1-retry.jsonl`). 0.160.0 sends it only
   * when Codex has usage info (`app-server/src/bespoke_event_handling.rs`, `handle_token_count_event`),
   * so a turn without one is a real case; a missing single count is not a shape it sends. `total` is
   * the turn so far; the lane reports the last one it got.
   */
  const tokenUsage = (total: Record<string, number>, last = total) => ({
    threadId: THREAD,
    turnId: TURN,
    tokenUsage: { total, last, modelContextWindow: 258_400 }
  })
  /** The captured notification's own counts: 100 in (0 of them cached), 10 out, 0 reasoning. */
  const CAPTURED_TOTAL = {
    totalTokens: 110,
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 0
  }
  /**
   * A failed turn as Codex 0.157.1 ended it (`app-server-0.157.1-fatal.jsonl`), with no usage sent
   * first. Its `turn` fields are those of 0.160.0's `Turn` that the lane reads (`status`, `error.message`).
   */
  const turnFailed = {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: [],
      itemsView: 'notLoaded',
      status: 'failed',
      error: {
        message: 'stream disconnected before completion: Transport error: network error: error decoding response body',
        codexErrorInfo: 'other',
        additionalDetails: null
      }
    }
  }
  /** The paused half of an approval resume, with every count reported. */
  const PAUSED_HALF = { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedInputTokens: 20, cacheCreationInputTokens: 7, reasoningTokens: 2 }

  async function playTurn(script: (notify: Notify) => void) {
    const consumer = play(async (notify) => {
      notify('turn/started', turnStarted)
      notify('item/started', itemParams({ type: 'agentMessage', id: 'msg_1', text: '' }))
      notify('item/completed', itemParams({ type: 'agentMessage', id: 'msg_1', text: 'Hello.' }))
      script(notify)
    })
    await consumer.finished
    expect(consumer.finishUsages).toHaveLength(1)
    return {
      consumer,
      finish: consumer.chunks.find((chunk) => chunk.type === 'finish'),
      usage: consumer.finishUsages[0] as Record<string, number> | undefined
    }
  }

  it('keeps every count Codex reported, its reported zeros included', async () => {
    const { consumer, finish, usage } = await playTurn((notify) => {
      notify('thread/tokenUsage/updated', tokenUsage(CAPTURED_TOTAL))
      notify('turn/completed', turnCompleted)
    })

    expect(consumer.state.failure).toBeNull()
    const expected = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 }
    expect(usage).toEqual(expected)
    expect(finish.totalUsage).toEqual(expected)
    // The Execution Viewer's counts are the reported ones, the 0s as counts.
    const stats = buildTokenUsage(usage ?? null, 'exact', 'codex')
    expect(stats.inputTokens.value).toBe(100)
    expect(stats.cachedInputTokens?.value).toBe(0)
    expect(stats.cacheCreationInputTokens?.value).toBe(0)
    expect(stats.reasoningTokens?.value).toBe(0)
    expect(stats.totalTokens.value).toBe(110)
  })

  it('keeps a turn whose every count is a reported 0 at an exact zero', async () => {
    const zeros = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
    const { usage } = await playTurn((notify) => {
      notify('thread/tokenUsage/updated', tokenUsage(zeros))
      notify('turn/completed', turnCompleted)
    })

    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 })
    // Reported usage: the call row and the summary may say exact (R2's `reportedUsageConfidence`
    // is exact exactly when this holds).
    expect(hasUsageValues(usage)).toBe(true)
    // An approval resume adds a reported 0 like any count.
    expect(mergeResumedUsage(PAUSED_HALF, usage)).toMatchObject({ inputTokens: 50, outputTokens: 5, totalTokens: 55, cacheCreationInputTokens: 7 })
  })

  it('keeps the latest aggregate cache writes once through the real lane, adapter, EV and resume rules (BL-1383)', async () => {
    // Synthetic discriminator in the pinned 0.160 shape, not a live cache measurement.
    const { finish, usage } = await playTurn((notify) => {
      notify('thread/tokenUsage/updated', tokenUsage({ ...CAPTURED_TOTAL, inputTokens: 80, totalTokens: 90, cacheWriteInputTokens: 15 }))
      notify('thread/tokenUsage/updated', tokenUsage(
        { ...CAPTURED_TOTAL, cachedInputTokens: 20, cacheWriteInputTokens: 30 },
        { inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedInputTokens: 2, cacheWriteInputTokens: 3 }
      ))
      notify('turn/completed', turnCompleted)
    })
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20, cacheCreationInputTokens: 30, reasoningTokens: 0 })
    expect(finish.totalUsage).toEqual(usage)
    const stats = buildTokenUsage(usage ?? null, 'exact', 'codex')
    expect(stats.cacheCreationInputTokens?.value).toBe(30)
    expect(mergeResumedUsage(PAUSED_HALF, usage)).toMatchObject({ inputTokens: 150, outputTokens: 15, totalTokens: 165, cacheCreationInputTokens: 37 })
    const merged = mergeResumedTokenUsage(buildTokenUsage(PAUSED_HALF, 'exact', 'codex'), stats)
    expect(merged?.cacheCreationInputTokens?.value).toBe(37)
    expect(merged?.totalTokens.value).toBe(165)
  })

  it('retains a defensive cache-write-only report while other EV and resume counts stay unknown', async () => {
    const { finish, usage } = await playTurn((notify) => {
      notify('thread/tokenUsage/updated', tokenUsage({ cacheWriteInputTokens: 30 }))
      notify('turn/completed', turnCompleted)
    })
    expect(usage).toEqual({ cacheCreationInputTokens: 30 })
    expect(finish.totalUsage).toEqual(usage)
    const stats = buildTokenUsage(usage ?? null, 'exact', 'codex')
    expect(stats.cacheCreationInputTokens?.value).toBe(30)
    expect([stats.inputTokens.value, stats.outputTokens.value, stats.totalTokens.value]).toEqual([null, null, null])
    expect(mergeResumedUsage(PAUSED_HALF, usage)).toEqual({ cacheCreationInputTokens: 37 })
    const merged = mergeResumedTokenUsage(buildTokenUsage(PAUSED_HALF, 'exact', 'codex'), stats)
    expect(merged?.cacheCreationInputTokens?.value).toBe(37)
    expect(merged?.totalTokens.value).toBeNull()
  })

  it('gives a finished turn that got no usage notification no usage at all, not zeros', async () => {
    const { consumer, finish, usage } = await playTurn((notify) => {
      notify('turn/completed', turnCompleted)
    })

    expect(consumer.state.failure).toBeNull()
    expect(usage).toBeUndefined()
    // The finish chunk still ends the stream, but carries no usage, so send-routed sends no
    // usage in its `finish` event and the reply's usage stays unknown.
    expect(finish).toEqual({ type: 'finish' })
    expect(hasUsageValues(usage)).toBe(false)
    const stats = buildTokenUsage(usage ?? null, 'exact', 'codex')
    expect([stats.inputTokens.value, stats.outputTokens.value, stats.totalTokens.value]).toEqual([null, null, null])
    // An approval resume over this half keeps the message's usage unknown, and every snapshot
    // count unknown, instead of passing the paused half's numbers off as the whole reply's.
    expect(mergeResumedUsage(PAUSED_HALF, usage)).toBeNull()
    const merged = mergeResumedTokenUsage(buildTokenUsage(PAUSED_HALF, 'exact', 'codex'), stats)
    expect(merged?.inputTokens.value).toBeNull()
    expect(merged?.totalTokens.value).toBeNull()
  })

  it('leaves a count Codex left out unknown, and the total with it', async () => {
    // Codex's schema sends every count; a notification without one must not turn it into a 0.
    const { usage } = await playTurn((notify) => {
      notify('thread/tokenUsage/updated', tokenUsage({ outputTokens: 7, reasoningOutputTokens: 3 }))
      notify('turn/completed', turnCompleted)
    })

    expect(usage).toEqual({ outputTokens: 7, reasoningTokens: 3 })
    expect(hasUsageValues(usage)).toBe(true)
    const stats = buildTokenUsage(usage ?? null, 'exact', 'codex')
    expect(stats.outputTokens.value).toBe(7)
    expect(stats.inputTokens.value).toBeNull()
    expect(stats.totalTokens.value).toBeNull()
    // The message's usage keeps the known count and no made-up input or total.
    expect(normalizeUsageLike(usage)).toMatchObject({ outputTokens: 7 })
    expect(normalizeUsageLike(usage)?.inputTokens).toBeUndefined()
    expect(normalizeUsageLike(usage)?.totalTokens).toBeUndefined()
    // An approval resume adds only what both halves reported.
    const resumed = mergeResumedUsage(PAUSED_HALF, usage)
    expect(resumed).toMatchObject({ outputTokens: 12, reasoningTokens: 5 })
    expect(resumed?.inputTokens).toBeUndefined()
    expect(resumed?.totalTokens).toBeUndefined()
    const merged = mergeResumedTokenUsage(buildTokenUsage(PAUSED_HALF, 'exact', 'codex'), stats)
    expect(merged?.outputTokens.value).toBe(12)
    expect(merged?.inputTokens.value).toBeNull()
  })

  it.each([
    ['after a usage notification', true],
    ['with no usage notification (the pinned Codex capture)', false]
  ])('gives a failed turn %s unknown usage, never zeros, from its one finish callback', async (_label, reported) => {
    const { consumer, finish, usage } = await playTurn((notify) => {
      if (reported) notify('thread/tokenUsage/updated', tokenUsage(CAPTURED_TOTAL))
      notify('turn/completed', turnFailed)
    })

    expect(consumer.state.failure?.message).toBe(turnFailed.turn.error.message)
    expect(finish).toBeUndefined()
    // Whole-run usage stays unknown. BL-1361 retains reports separately as partial observations.
    expect(usage).toBeUndefined()
    expect(hasUsageValues(usage)).toBe(false)
  })
})

describe('BL-1361: observed Codex usage is separate from a complete failed bill', () => {
  const total = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 30 }
  const report = (counts: Record<string, unknown>, threadId = THREAD, turnId = TURN) => ({
    threadId, turnId, tokenUsage: { total: counts, last: { inputTokens: 1, outputTokens: 1 }, modelContextWindow: 1000 },
  })
  const expected = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20, cacheCreationInputTokens: 30 }
  const failed = { threadId: THREAD, turn: { id: TURN, status: 'failed', error: { message: 'synthetic failed after usage' } } }

  it.each(['failed', 'fatal error', 'process exit'])('keeps observed counts after %s without a finish chunk or canonical total', async (ending) => {
    const consumer = play(async (notify) => {
      await Promise.resolve()
      notify('thread/tokenUsage/updated', report(total))
      if (ending === 'failed') notify('turn/completed', failed)
      else if (ending === 'fatal error') notify('error', { message: 'synthetic fatal error', willRetry: false })
      else consumer.child.emit('close', 1, null)
    })
    await consumer.finished
    expect(consumer.state.failure).not.toBeNull()
    expect(consumer.chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
    expect(consumer.finishUsages).toEqual([undefined])
    expect(consumer.finishObservations).toEqual([{ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: expected }] }])
  })

  it('replaces aggregates, retains the last valid report through malformed input, and freezes before late updates', async () => {
    const consumer = play(async (notify) => {
      await Promise.resolve()
      notify('thread/tokenUsage/updated', report({ inputTokens: 80, outputTokens: 5 }))
      notify('thread/tokenUsage/updated', report(total))
      notify('thread/tokenUsage/updated', report({ inputTokens: null, cacheWriteInputTokens: 'bad' }))
      notify('turn/completed', failed)
      notify('thread/tokenUsage/updated', report({ inputTokens: 999, outputTokens: 999 }))
    })
    await consumer.finished
    expect(consumer.finishObservations).toEqual([{ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: expected }] }])
    expect(consumer.finishUsages).toEqual([undefined])
    expect(consumer.run.getObservedUsage()).toEqual({ input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 10 })
  })

  it('admits an early matching notification only after the RPC identity confirms it, not a foreign or stale turn', async () => {
    const consumer = play(async (notify) => {
      await Promise.resolve()
      notify('thread/tokenUsage/updated', report({ inputTokens: 999 }, 'foreign-thread'))
      notify('thread/tokenUsage/updated', report({ inputTokens: 888 }, THREAD, 'stale-turn'))
      notify('turn/completed', failed)
    }, { beforeTurnReply: (notify) => {
      notify('thread/tokenUsage/updated', report(total))
      notify('thread/tokenUsage/updated', report({ inputTokens: 777 }, THREAD, 'foreign-early-turn'))
    } })
    await consumer.finished
    expect(consumer.finishObservations).toEqual([{ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: expected }] }])
  })

  it.each([
    [{ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 }],
    [{ cacheWriteInputTokens: 30 }, { cacheCreationInputTokens: 30 }],
    [{ reasoningOutputTokens: 3 }, { reasoningTokens: 3 }],
  ])('keeps only the members actually reported in a defensive partial observation (%j)', async (counts, canonical) => {
    const consumer = play(async (notify) => {
      await Promise.resolve()
      notify('thread/tokenUsage/updated', report(counts))
      notify('turn/completed', failed)
    })
    await consumer.finished
    expect(consumer.finishObservations).toEqual([{ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: canonical }] }])
    expect(consumer.finishUsages).toEqual([undefined])
  })

  it('never splices an older aggregate member into a newer partial report', async () => {
    const consumer = play(async (notify) => {
      await Promise.resolve()
      notify('thread/tokenUsage/updated', report(total))
      notify('thread/tokenUsage/updated', report({ cacheWriteInputTokens: 0 }))
      notify('turn/completed', failed)
    })
    await consumer.finished
    expect(consumer.finishObservations).toEqual([{ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: { cacheCreationInputTokens: 0 } }] }])
  })

  it('keeps a Stop interrupted with partial evidence, never a successful completion', async () => {
    const controller = new AbortController()
    const consumer = play(async (notify) => {
      await Promise.resolve()
      notify('turn/started', turnStarted)
      notify('thread/tokenUsage/updated', report(total))
      controller.abort()
      notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } })
    }, { signal: controller.signal })
    await consumer.finished
    expect(consumer.state.failure?.name).toBe('AbortError')
    expect(consumer.finishUsages).toEqual([undefined])
    expect(consumer.finishObservations).toEqual([{ completeness: 'partial', parts: [{ source: 'codex-app-server-progress', counts: expected }] }])
  })

  it('keeps no-report failure unknown and a reported successful completion unchanged', async () => {
    const missing = play(async (notify) => { notify('turn/completed', failed) })
    await missing.finished
    expect(missing.finishObservations).toEqual([undefined])
    const success = play(async (notify) => {
      await Promise.resolve()
      notify('thread/tokenUsage/updated', report(total))
      notify('turn/completed', turnCompleted)
    })
    await success.finished
    expect(success.finishUsages).toEqual([expected])
    expect(success.finishObservations).toEqual([undefined])
  })
})
