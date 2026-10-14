import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { startCodexAppServerRun } from '../services/codexAppServerLane'
import { CodexEventAdapter } from '../services/codexEventAdapter'
import { getCodexRunProcesses } from '../services/codexRunProcesses'
import type { NativeModeRequest } from '../services/vercelBrain'
import { SegmentedText } from '$lib/utils/segmentedText'
import {
  CAPTURED_ANSWER_DROP_AFTER_REASONING,
  CAPTURED_REASONING_DROP,
  CAPTURED_RETRY,
  CAPTURED_RETRY_THEN_FATAL,
  type CapturedNotification
} from '$lib/test-utils/codex-app-server-retries'

/**
 * BL-457 — a Codex retry notice is not the end of the reply.
 *
 * When the model's response stream drops, Codex retries the request itself and tells the client
 * with an `error` notification whose `willRetry` is `true` ("Reconnecting... 1/5"). The lane
 * turned every `error` notification into an `error` event, the event adapter threw on it, and
 * the bridge's cleanup then ended the Codex process that was about to carry on: a short network
 * drop became a failed reply.
 *
 * The notification shapes below are copied from the pinned Codex (codex-cli 0.157.1) itself,
 * captured against a stand-in Responses server that drops the first stream mid-reply
 * (`_local/turn-pack-2026-09-27/w7-bl457/app-server-0.157.1-retry.jsonl` and `-fatal.jsonl`).
 * The protocol type is `ErrorNotification = { error: TurnError, willRetry: boolean, threadId,
 * turnId }` (`codex app-server generate-ts`, 0.157.1); 0.139.0 sends the same shape.
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

afterEach(() => {
  spawnMock.mockReset()
  vi.restoreAllMocks()
})

const THREAD = 'thread-1'
const TURN = 'turn-1'
const DROP_DETAILS =
  'stream disconnected before completion: Transport error: network error: error decoding response body'

/** Codex is about to retry by itself (captured, 0.157.1). */
const RETRY_NOTICE = {
  error: {
    message: 'Reconnecting... 1/5',
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
    additionalDetails: DROP_DETAILS,
    misalignment: null
  },
  willRetry: true,
  threadId: THREAD,
  turnId: TURN
}

/** Codex has given up (captured, 0.157.1, after the last retry). */
const FATAL_ERROR = {
  error: { message: DROP_DETAILS, codexErrorInfo: 'other', additionalDetails: null, misalignment: null },
  willRetry: false,
  threadId: THREAD,
  turnId: TURN
}

/** The `turn/completed` that follows the fatal error (captured, 0.157.1). */
const FAILED_TURN = {
  threadId: THREAD,
  turn: {
    id: TURN,
    items: [],
    itemsView: 'notLoaded',
    status: 'failed',
    error: FATAL_ERROR.error,
    startedAt: 1790577828,
    completedAt: 1790577829,
    durationMs: 502
  }
}

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: (signal?: string) => boolean
}

type Notify = (method: string, params: Record<string, unknown>) => void

/**
 * A fake app server that answers the start-up requests and then plays `script` once the turn is
 * answered. The script can wait on the test between notifications.
 */
function createScriptedAppServer(script: (notify: Notify) => Promise<void>) {
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
        send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: TURN, status: 'inProgress' } } })
        void script(notify)
      }
    }
  })
  return child
}

const agentMessage = (id: string, text: string) => ({
  item: { type: 'agentMessage', id, text, phase: null, memoryCitation: null },
  threadId: THREAD,
  turnId: TURN
})

const delta = (itemId: string, text: string) => ({ threadId: THREAD, turnId: TURN, itemId, delta: text })

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

/**
 * Consumes the run the way `CodexBridge` does: through the event adapter, and the run's
 * `cleanup` (which ends the Codex process) once the adapter's stream ends or throws.
 */
function consumeLikeTheBridge(run: ReturnType<typeof startCodexAppServerRun>) {
  const adapter = new CodexEventAdapter({ request: buildRequest(), transport: 'cli' })
  const chunks: any[] = []
  const state: { failure: Error | null; done: boolean } = { failure: null, done: false }
  const finished = (async () => {
    try {
      for await (const chunk of adapter.stream(run.events)) chunks.push(chunk)
    } catch (error) {
      state.failure = error as Error
    } finally {
      state.done = true
      await run.cleanup()
    }
  })()
  return { adapter, chunks, state, finished }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('BL-457: Codex retry notices on the app-server lane', () => {
  it('carries on through a retry notice: the reply completes with the retried answer and Codex keeps running', async () => {
    let releaseRetry: () => void = () => {}
    const retried = new Promise<void>((resolve) => {
      releaseRetry = resolve
    })
    let noticeSent = false
    const child = createScriptedAppServer(async (notify) => {
      notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
      notify('item/started', agentMessage('msg_1', ''))
      notify('item/agentMessage/delta', delta('msg_1', 'Partial '))
      // The stream dropped; Codex says it is retrying, and does.
      notify('error', RETRY_NOTICE)
      noticeSent = true
      await retried
      notify('item/started', agentMessage('msg_2', ''))
      notify('item/agentMessage/delta', delta('msg_2', 'Hello '))
      notify('item/agentMessage/delta', delta('msg_2', 'after the retry.'))
      notify('item/completed', agentMessage('msg_2', 'Hello after the retry.'))
      notify('turn/completed', {
        threadId: THREAD,
        turn: { id: TURN, items: [], status: 'completed', error: null }
      })
    })
    spawnMock.mockReturnValue(child)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'say hello'
    })
    const endProcesses = vi.spyOn(getCodexRunProcesses(child)!, 'end')
    const consumer = consumeLikeTheBridge(run)

    // The notice has been read, and the reply is still open: nothing threw, and nothing ended
    // the Codex process that is retrying.
    await vi.waitFor(() => expect(noticeSent).toBe(true))
    await settle()
    expect(consumer.state.failure).toBeNull()
    expect(consumer.state.done).toBe(false)
    expect(endProcesses).not.toHaveBeenCalled()
    // Logged, with Codex's own words and details.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.objectContaining({ message: 'Reconnecting... 1/5', additionalDetails: DROP_DETAILS })
    )

    releaseRetry()
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    const text = consumer.chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('')
    expect(text.endsWith('Hello after the retry.')).toBe(true)
    expect(consumer.chunks.at(-1)?.type).toBe('finish')
    // The notice never reached the adapter as an event.
    expect(consumer.adapter.getRawEvents().map((event) => event.type)).not.toContain('error')
  })

  it('still ends the reply at once on a real error (willRetry false), with Codex\'s message', async () => {
    const child = createScriptedAppServer(async (notify) => {
      notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
      notify('item/started', agentMessage('msg_1', ''))
      notify('error', RETRY_NOTICE)
      notify('error', FATAL_ERROR)
      notify('turn/completed', FAILED_TURN)
    })
    spawnMock.mockReturnValue(child)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'say hello'
    })
    const consumer = consumeLikeTheBridge(run)
    await consumer.finished

    expect(consumer.state.failure?.message).toBe(DROP_DETAILS)
    expect(consumer.chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
  })

  it('treats an error notification without willRetry as a real error, without waiting for the turn to end', async () => {
    // An older or unexpected shape: nothing says Codex will carry on, so it is an end. The
    // script sends nothing after it; the reply must not wait for a `turn/completed`.
    const child = createScriptedAppServer(async (notify) => {
      notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
      notify('error', { error: { message: 'Codex hit a wall' }, threadId: THREAD, turnId: TURN })
    })
    spawnMock.mockReturnValue(child)

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'say hello'
    })
    const endProcesses = vi.spyOn(getCodexRunProcesses(child)!, 'end')
    const consumer = consumeLikeTheBridge(run)
    await consumer.finished

    expect(consumer.state.failure?.message).toBe('Codex hit a wall')
    expect(endProcesses).toHaveBeenCalled()
  })

  it('ends the reply as a failure on turn/completed with status failed, with no error notification first', async () => {
    const child = createScriptedAppServer(async (notify) => {
      notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
      notify('turn/completed', FAILED_TURN)
    })
    spawnMock.mockReturnValue(child)

    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'say hello'
    })
    const consumer = consumeLikeTheBridge(run)
    await consumer.finished

    expect(consumer.state.failure?.message).toBe(DROP_DETAILS)
  })
})

/**
 * BL-759 — a retried answer takes back its fragment.
 *
 * Codex starts the retried answer as a NEW item and never completes the dropped one, but the
 * adapter had already sent the dropped item's text: every reader kept it, so the saved reply read
 * `Partial before the drop Hello after the retry.`. Each text chunk now names its segment (the
 * Codex item), and at the retry the adapter takes back each agent message that started and never
 * completed, by that name. The notifications are the pinned Codex's own
 * (`$lib/test-utils/codex-app-server-retries.ts`).
 */
describe('BL-759: a retried answer takes back its fragment', () => {
  function playCaptured(
    notifications: CapturedNotification[],
    extra: (notify: Notify, method: string, params: Record<string, any>) => void = () => {}
  ) {
    const child = createScriptedAppServer(async (notify) => {
      for (const { method, params } of notifications) {
        notify(method, params)
        extra(notify, method, params)
      }
    })
    spawnMock.mockReturnValue(child)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = startCodexAppServerRun({
      executable: 'codex',
      env: {},
      threadParams: { ephemeral: true },
      prompt: 'say hello'
    })
    let finishText: string | null = null
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli',
      onFinish: ({ text }) => {
        finishText = text
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
    return { adapter, chunks, state, finished, finishText: () => finishText }
  }

  /** What a reader that keeps the reply's text holds after every chunk (the shared helper). */
  function keptText(chunks: any[]): string {
    const text = new SegmentedText()
    for (const chunk of chunks) {
      if (chunk.type === 'text-delta') text.append(chunk.text, chunk.segmentId)
      if (chunk.type === 'text-retract') text.retract(chunk.segmentId)
    }
    return text.toString()
  }

  const textEvents = (chunks: any[]) =>
    chunks
      .filter((chunk) => chunk.type === 'text-delta' || chunk.type === 'text-retract')
      .map((chunk) => (chunk.type === 'text-delta' ? [chunk.segmentId, chunk.text] : ['retract', chunk.segmentId]))

  it('names each chunk by its Codex item and takes the dropped item back at the retry, before the retried answer', async () => {
    const consumer = playCaptured(CAPTURED_RETRY)
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    expect(textEvents(consumer.chunks)).toEqual([
      ['msg_1', 'Partial '],
      ['msg_1', 'before the drop '],
      ['retract', 'msg_1'],
      ['msg_2', 'Hello '],
      ['msg_2', 'after '],
      ['msg_2', 'the retry.']
    ])
    expect(consumer.chunks.find((chunk) => chunk.type === 'text-retract')).toMatchObject({
      reason: 'retry',
      message: 'Reconnecting... 1/5'
    })
    expect(keptText(consumer.chunks)).toBe('Hello after the retry.')
    // The same bytes as Codex's own record of the turn and the adapter's finish.
    expect(consumer.finishText()).toBe('Hello after the retry.')
    expect(consumer.chunks.at(-1)?.type).toBe('finish')
    // The retry is in the run's raw event log (the Execution Viewer's), with Codex's words.
    expect(consumer.adapter.getRawEvents()).toContainEqual(
      expect.objectContaining({ type: 'stream.retry', message: 'Reconnecting... 1/5' })
    )
  })

  it('keeps the last attempt\'s partial text when Codex gives up: only a retry takes text back', async () => {
    const consumer = playCaptured(CAPTURED_RETRY_THEN_FATAL)
    await consumer.finished

    expect(consumer.state.failure?.message).toBe(DROP_DETAILS)
    expect(textEvents(consumer.chunks)).toEqual([
      ['msg_1', 'Partial '],
      ['msg_1', 'before the drop '],
      ['retract', 'msg_1'],
      ['msg_2', 'Partial '],
      ['msg_2', 'before the drop ']
    ])
    expect(keptText(consumer.chunks)).toBe('Partial before the drop ')
  })

  it('ignores a late delta or completion of an item it took back', async () => {
    const consumer = playCaptured(CAPTURED_RETRY, (notify, method, params) => {
      if (method === 'item/started' && params.item?.id === 'msg_2') {
        notify('item/agentMessage/delta', { itemId: 'msg_1', delta: 'LATE ' })
        notify('item/completed', {
          item: { type: 'agentMessage', id: 'msg_1', text: 'Partial before the drop LATE ' }
        })
      }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    expect(keptText(consumer.chunks)).toBe('Hello after the retry.')
    expect(consumer.chunks.filter((chunk) => chunk.segmentId === 'msg_1')).toHaveLength(3)
    expect(consumer.finishText()).toBe('Hello after the retry.')
    // Not silent: each ignored event is logged with the item's id.
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('BL-759'), expect.objectContaining({ itemId: 'msg_1' }))
  })

  it('keeps the partial text when every retry fails before Codex writes again', async () => {
    const withoutRetriedItems = CAPTURED_RETRY_THEN_FATAL.filter(
      (entry) => entry.params?.item?.id !== 'msg_2' && entry.params?.itemId !== 'msg_2'
    )
    expect(withoutRetriedItems.map((entry) => entry.method).filter((method) => method === 'error')).toHaveLength(2)
    const consumer = playCaptured(withoutRetriedItems)
    await consumer.finished

    expect(consumer.state.failure?.message).toBe(DROP_DETAILS)
    expect(consumer.chunks.some((chunk) => chunk.type === 'text-retract')).toBe(false)
    expect(keptText(consumer.chunks)).toBe('Partial before the drop ')
  })

  it('keeps the partial text when Codex ends the turn after a retry without writing again', async () => {
    const [started] = CAPTURED_RETRY
    const retry = CAPTURED_RETRY.find((entry) => entry.method === 'error')!
    const consumer = playCaptured([
      started,
      { method: 'item/started', params: agentMessage('msg_1', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_1', 'Partial ') },
      retry,
      { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'completed', error: null } } }
    ])
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    expect(consumer.chunks.map((chunk) => chunk.type)).toEqual(['text-delta', 'finish'])
    expect(keptText(consumer.chunks)).toBe('Partial ')
  })

  // BL-759 review: a steer marker is the one piece of text with no segment that can come
  // between a fragment and the retried answer. Handing the retract on before it keeps the
  // fragment the last words the zip detector read, so it is taken back exactly. The cost, written
  // down in the plan: a steer during a retry's backoff, then every retry fails, loses the partial.
  it('hands on a held retract before a steer, so the fragment is the last words taken back', async () => {
    const adapter = new CodexEventAdapter({ request: buildRequest(), transport: 'cli' })
    async function* events(): AsyncGenerator<any> {
      yield { type: 'item.started', item: { id: 'msg_1', type: 'agent_message', text: '' } }
      yield { type: 'item.updated', item: { id: 'msg_1', type: 'agent_message', text: 'Partial ' } }
      yield { type: 'stream.retry', message: 'Reconnecting... 1/5', details: null }
      yield { type: 'steer.delivered', steer_ids: ['steer-1'] }
      yield { type: 'item.started', item: { id: 'msg_2', type: 'agent_message', text: '' } }
      yield { type: 'item.updated', item: { id: 'msg_2', type: 'agent_message', text: 'Hello.' } }
      yield { type: 'item.completed', item: { id: 'msg_2', type: 'agent_message', text: 'Hello.' } }
      yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
    }
    const chunks: any[] = []
    for await (const chunk of adapter.stream(events())) chunks.push(chunk)

    expect(chunks.map((chunk) => chunk.type)).toEqual(['text-delta', 'text-retract', 'steer', 'text-delta', 'finish'])
    expect(keptText(chunks)).toBe('Hello.')
  })

  it('takes back two unfinished messages of one retry, the newer first', async () => {
    const [started] = CAPTURED_RETRY
    const retry = CAPTURED_RETRY.find((entry) => entry.method === 'error')!
    const consumer = playCaptured([
      started,
      { method: 'item/started', params: agentMessage('msg_a', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_a', 'First part ') },
      { method: 'item/started', params: agentMessage('msg_b', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_b', 'second part ') },
      retry,
      { method: 'item/started', params: agentMessage('msg_c', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_c', 'Whole answer.') },
      { method: 'item/completed', params: agentMessage('msg_c', 'Whole answer.') },
      { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'completed', error: null } } }
    ])
    await consumer.finished

    expect(textEvents(consumer.chunks)).toEqual([
      ['msg_a', 'First part '],
      ['msg_b', 'second part '],
      ['retract', 'msg_b'],
      ['retract', 'msg_a'],
      ['msg_c', 'Whole answer.']
    ])
  })

  it('takes back each dropped attempt of two retries in one reply', async () => {
    const [started, ...rest] = CAPTURED_RETRY
    const retry = rest.find((entry) => entry.method === 'error')!
    const secondRetry = { method: 'error', params: { ...retry.params, error: { ...retry.params.error, message: 'Reconnecting... 2/5' } } }
    const notifications: CapturedNotification[] = [
      started,
      { method: 'item/started', params: agentMessage('msg_1', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_1', 'First try ') },
      retry,
      { method: 'item/started', params: agentMessage('msg_2', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_2', 'Second try ') },
      secondRetry,
      { method: 'item/started', params: agentMessage('msg_3', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_3', 'Third try, whole.') },
      { method: 'item/completed', params: agentMessage('msg_3', 'Third try, whole.') },
      { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'completed', error: null } } }
    ]
    const consumer = playCaptured(notifications)
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    expect(consumer.chunks.filter((chunk) => chunk.type === 'text-retract').map((chunk) => chunk.segmentId)).toEqual([
      'msg_1',
      'msg_2'
    ])
    expect(keptText(consumer.chunks)).toBe('Third try, whole.')
  })

  it('takes back only the unfinished message: a finished message and a tool card before the drop stay', async () => {
    const [started] = CAPTURED_RETRY
    const retry = CAPTURED_RETRY.find((entry) => entry.method === 'error')!
    const tool = { type: 'mcpToolCall', id: 'call_1', server: 'demo', tool: 'ping', arguments: {}, status: 'inProgress' }
    const notifications: CapturedNotification[] = [
      started,
      { method: 'item/started', params: agentMessage('msg_1', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_1', 'Let me check. ') },
      { method: 'item/completed', params: agentMessage('msg_1', 'Let me check. ') },
      { method: 'item/started', params: { item: tool, threadId: THREAD, turnId: TURN } },
      {
        method: 'item/completed',
        params: {
          item: { ...tool, status: 'completed', result: { content: [{ type: 'text', text: 'pong' }] } },
          threadId: THREAD,
          turnId: TURN
        }
      },
      { method: 'item/started', params: agentMessage('msg_2', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_2', 'It said po') },
      retry,
      { method: 'item/started', params: agentMessage('msg_3', '') },
      { method: 'item/agentMessage/delta', params: delta('msg_3', 'It said pong.') },
      { method: 'item/completed', params: agentMessage('msg_3', 'It said pong.') },
      { method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, items: [], status: 'completed', error: null } } }
    ]
    const consumer = playCaptured(notifications)
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    expect(consumer.chunks.map((chunk) => chunk.type)).toEqual([
      'text-delta',
      'tool-call',
      'tool-result',
      'text-delta',
      'text-retract',
      'text-delta',
      'finish'
    ])
    expect(consumer.chunks.find((chunk) => chunk.type === 'text-retract')?.segmentId).toBe('msg_2')
    expect(keptText(consumer.chunks)).toBe('Let me check. It said pong.')
  })

  it('a dropped reasoning item streamed its summary; the retried reasoning replaces it, and no text is taken back (BL-464, build check 2)', async () => {
    const consumer = playCaptured(CAPTURED_REASONING_DROP)
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    // Since BL-464 the lane streams a summary as it is written, so the dropped item's partial
    // summary reached the readers. Each reader keeps reasoning as one snapshot that every update
    // replaces, and the retry reasons again under a new id, so the last snapshot is the retry's.
    expect(
      consumer.chunks.filter((chunk) => chunk.type === 'thinking').map((chunk) => [chunk.itemId, chunk.content, chunk.final])
    ).toEqual([
      ['rs_1', '**Thinking** ', false],
      ['rs_1', '**Thinking** about the drop ', false],
      ['rs_2', '**Thinking** ', false],
      ['rs_2', '**Thinking** after the retry.', false],
      ['rs_2', '**Thinking** after the retry.', true]
    ])
    expect(consumer.chunks.some((chunk) => chunk.type === 'text-retract')).toBe(false)
    expect(keptText(consumer.chunks)).toBe('Hello after the retry.')
  })

  it('a drop after finished reasoning takes back the answer only (build check 2)', async () => {
    const consumer = playCaptured(CAPTURED_ANSWER_DROP_AFTER_REASONING)
    await consumer.finished

    expect(consumer.state.failure).toBeNull()
    // The retried attempt's reasoning streams live (BL-464), but the fragment's retract waits for
    // that reasoning to finish, as it did before the summary streamed: a summary still being
    // written reaches neither the reply's text nor the zip detector.
    expect(
      consumer.chunks.map((chunk) =>
        chunk.type === 'thinking' ? `thinking:${chunk.itemId}${chunk.final ? ':final' : ''}` : chunk.type
      )
    ).toEqual([
      'thinking:rs_1',
      'thinking:rs_1',
      'thinking:rs_1:final',
      'text-delta',
      'text-delta',
      'thinking:rs_2',
      'thinking:rs_2',
      'text-retract',
      'thinking:rs_2:final',
      'text-delta',
      'text-delta',
      'text-delta',
      'finish'
    ])
    expect(consumer.chunks.filter((chunk) => chunk.type === 'text-retract').map((chunk) => chunk.segmentId)).toEqual(['msg_1'])
    expect(keptText(consumer.chunks)).toBe('Hello after the retry.')
  })

  // BL-464 / BL-459 review: a reasoning summary still being written and a plan update stream since
  // those fixes, and neither may count as Codex writing again. A retry that drops again while it
  // reasons or plans, then gives up, keeps the partial text, as it did before either streamed.
  it('keeps the partial text when the retry drops again while reasoning or planning and Codex gives up', async () => {
    const retriedReasoningStart = CAPTURED_ANSWER_DROP_AFTER_REASONING.findIndex(
      (entry) => entry.method === 'item/started' && entry.params.item?.id === 'rs_2'
    )
    const throughRetriedReasoning = CAPTURED_ANSWER_DROP_AFTER_REASONING.slice(0, retriedReasoningStart + 4)
    expect(throughRetriedReasoning.slice(-3).map((entry) => entry.method)).toEqual([
      'item/reasoning/summaryPartAdded',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/summaryTextDelta'
    ])
    const [giveUp, failedTurn] = CAPTURED_RETRY_THEN_FATAL.slice(-2)
    expect(giveUp.params.willRetry).toBe(false)
    const plan = {
      method: 'turn/plan/updated',
      params: { threadId: THREAD, turnId: TURN, explanation: null, plan: [{ step: 'Say hello', status: 'inProgress' }] }
    }
    const consumer = playCaptured([...throughRetriedReasoning, plan, giveUp, failedTurn])
    await consumer.finished

    expect(consumer.state.failure?.message).toBe(DROP_DETAILS)
    // The retried attempt's live summary and its plan went out; the fragment's retract did not.
    expect(consumer.chunks.filter((chunk) => chunk.type === 'thinking' && chunk.itemId === 'rs_2')).toHaveLength(2)
    expect(consumer.chunks.some((chunk) => chunk.toolName === 'codex_plan_update')).toBe(true)
    expect(consumer.chunks.some((chunk) => chunk.type === 'text-retract')).toBe(false)
    expect(keptText(consumer.chunks)).toBe('Partial before the drop ')
  })
})
