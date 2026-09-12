import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { startCodexAppServerRun } from '../services/codexAppServerLane'
import type { ThreadEvent } from '$lib/types/codexProtocol'

/**
 * SA-114 P2 (DL-114-06, AMD-114-02) — `turn/steer` on the managed Codex app-server lane.
 *
 * Driven against a fake app server that speaks the wire P0 measured on the pinned 0.141.0:
 * `turn/start` emits a `userMessage` item for the ORIGINAL prompt, an accepted `turn/steer`
 * answers `{turnId}` and then emits `item/started` + `item/completed` for its own
 * `userMessage` item carrying the steered text, and every refusal is a `-32600` error with
 * one of three exact messages.
 *
 * What these pin is the difference between "Codex took it" and "the model read it". Only
 * the echo means the second, and only the second may write a marker into the transcript.
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
})

const PROMPT = 'Run three commands, then summarise.'
const STEER_TEXT = '[Steer — from the user, mid-reply]\nstart with PINEAPPLE'

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: (signal?: string) => boolean
}

/** The three refusals P0 read off the wire, verbatim. All `-32600`. */
const STEER_REFUSALS = {
  noActiveTurn: 'no active turn to steer',
  wrongTurnId: (expected: string, actual: string) =>
    `expected active turn id \`${expected}\` but found \`${actual}\``,
  afterCompleted: 'no active turn to steer'
} as const

function createFakeAppServer(
  options: {
    /** Refuse `turn/steer` with this `-32600` message instead of accepting it. */
    refuseSteerWith?: string
    /** Accept the steer but never emit the `userMessage` echo for it. */
    swallowEcho?: boolean
    /** Answer `turn/start` at once but send `turn/started` only after this many ms. */
    delayTurnStartedMs?: number
  } = {}
) {
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
  const steerRequests: any[] = []

  const emitUserMessageItem = (id: string, text: string) => {
    const item = { type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] }
    send({ jsonrpc: '2.0', method: 'item/started', params: { item, threadId: 'thread-1' } })
    send({ jsonrpc: '2.0', method: 'item/completed', params: { item, threadId: 'thread-1' } })
  }

  /**
   * The first item of a NEW model call. P0's trace and the review's slow-tool run agree on
   * the shape: Codex echoes a steer when its loop picks the input up — after the
   * in-progress tool has run — and the model call that reads it then produces items. The
   * first of those is the delivery point.
   */
  const emitModelCallStart = (id: string) => {
    send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: { item: { type: 'agentMessage', id, text: '' }, threadId: 'thread-1' }
    })
  }

  const completeCommand = () => {
    send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'call_1',
          command: 'ls',
          aggregatedOutput: 'ok\n',
          exitCode: 0,
          status: 'completed'
        }
      }
    })
  }

  const completeTurn = (options: { withModelCall?: boolean } = {}) => {
    completeCommand()
    if (options.withModelCall !== false) emitModelCallStart('final-message')
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
    })
  }

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
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { thread: { id: 'thread-1', ephemeral: true } }
        })
      } else if (msg.method === 'turn/start') {
        send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
        if (options.delayTurnStartedMs) {
          // Live Codex answered the review's early steer with a refusal when it was sent in
          // the gap between this reply and the `turn/started` notification.
          setTimeout(() => {
            send({
              jsonrpc: '2.0',
              method: 'turn/started',
              params: { threadId: 'thread-1', turn: { id: 'turn-1' } }
            })
          }, options.delayTurnStartedMs)
        } else {
          send({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-1' } }
          })
        }
        // P0: the app server emits a `userMessage` item for the turn's OWN prompt too.
        emitUserMessageItem('prompt-item', PROMPT)
        send({
          jsonrpc: '2.0',
          method: 'item/started',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call_1',
              command: 'ls',
              aggregatedOutput: null,
              exitCode: null,
              status: 'inProgress'
            }
          }
        })
      } else if (msg.method === 'turn/steer') {
        steerRequests.push(msg.params)
        if (options.refuseSteerWith) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32600, message: options.refuseSteerWith }
          })
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-1' } })
          if (!options.swallowEcho) {
            const text = msg.params?.input?.[0]?.text ?? ''
            emitUserMessageItem(`steer-item-${steerRequests.length}`, text)
          }
        }
      }
    }
  })

  return { child, steerRequests, completeTurn, completeCommand, emitUserMessageItem, emitModelCallStart }
}

function startRun(child: FakeChild) {
  spawnMock.mockReturnValue(child)
  return startCodexAppServerRun({
    executable: 'codex',
    env: {},
    threadParams: { ephemeral: true },
    prompt: PROMPT,
    contextGuardEnabled: false
  })
}

/** Pull events until `turn.completed`, or until `stopAfter` events have arrived. */
async function collect(
  events: AsyncGenerator<ThreadEvent>,
  onFirstCommand?: () => Promise<void> | void
): Promise<ThreadEvent[]> {
  const seen: ThreadEvent[] = []
  let hookRun = false
  for await (const event of events) {
    seen.push(event)
    if (!hookRun && event.type === 'item.started' && onFirstCommand) {
      hookRun = true
      await onFirstCommand()
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed') break
  }
  return seen
}

describe('Codex app-server steering (DL-114-06, AMD-114-02)', () => {
  it('sends turn/steer with the active turn id and reports acceptance', async () => {
    const fake = createFakeAppServer()
    const run = startRun(fake.child)

    const events = await collect(run.events, async () => {
      const result = await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      expect(result).toEqual({ accepted: true, turnId: 'turn-1' })
      fake.completeTurn()
    })

    expect(fake.steerRequests).toHaveLength(1)
    expect(fake.steerRequests[0]).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: STEER_TEXT }],
      expectedTurnId: 'turn-1'
    })
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true)
    await run.cleanup()
  })

  it("turns the app server's own userMessage echo into one steer.delivered event", async () => {
    const fake = createFakeAppServer()
    const run = startRun(fake.child)

    const events = await collect(run.events, async () => {
      await run.steer({ steerIds: ['steer_1', 'steer_2'], text: STEER_TEXT })
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.completeTurn()
    })

    const delivered = events.filter((event) => event.type === 'steer.delivered')
    expect(delivered).toEqual([{ type: 'steer.delivered', steer_ids: ['steer_1', 'steer_2'] }])
  })

  /**
   * The decisive one. `turn/start` emits a `userMessage` item for the prompt, so a lane
   * that matched echoes by arrival order rather than by text would confirm the steer
   * against the PROMPT's echo — writing the transcript marker before the steer had even
   * been sent, and at a position the model never read it at.
   */
  it("never mistakes the turn's own prompt echo for a steer", async () => {
    const fake = createFakeAppServer()
    const run = startRun(fake.child)

    const events = await collect(run.events, async () => {
      // The prompt's `userMessage` item has already arrived by now; steer afterwards.
      await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.completeTurn()
    })

    const delivered = events.filter((event) => event.type === 'steer.delivered')
    expect(delivered).toHaveLength(1)
    // And no `userMessage` ever reaches the adapter as an item.
    expect(
      events.some(
        (event) =>
          (event.type === 'item.started' ||
            event.type === 'item.completed' ||
            event.type === 'item.updated') &&
          (event as any).item?.type === 'userMessage'
      )
    ).toBe(false)
  })

  /**
   * F-P2-3 (Faye's review), measured live with `sleep 8`: Codex accepted the steer at once
   * but echoed it only 6.3 s later, when its loop picked the input up for the NEXT model
   * call — and that echo reached Batshit BEFORE the finished command's own `item/completed`.
   * Marking delivered at the echo put the transcript marker before the tool result the model
   * read the steer after. Delivery is the first item of the model call that follows the
   * echo: after everything the previous step produced, before anything the reading call
   * produces.
   */
  it('marks delivery at the first item of the model call after the echo, not at the echo', async () => {
    const fake = createFakeAppServer({ swallowEcho: true })
    const run = startRun(fake.child)
    const seen: ThreadEvent[] = []

    const pump = (async () => {
      for await (const event of run.events) {
        seen.push(event)
        if (event.type === 'turn.completed' || event.type === 'turn.failed') break
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 20))
    await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
    // The echo arrives while the command is still running — and before its completion.
    fake.emitUserMessageItem('echo-a', STEER_TEXT)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen.some((event) => event.type === 'steer.delivered')).toBe(false)

    fake.completeCommand()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen.some((event) => event.type === 'steer.delivered')).toBe(false)

    fake.emitModelCallStart('reading-call')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const types = seen.map((event) => event.type)
    const delivered = types.indexOf('steer.delivered')
    const completedCommand = seen.findIndex(
      (event) => event.type === 'item.completed' && (event as any).item?.id === 'call_1'
    )
    const readingCall = seen.findIndex(
      (event) => event.type === 'item.started' && (event as any).item?.id === 'reading-call'
    )
    expect(delivered).toBeGreaterThan(completedCommand)
    expect(delivered).toBeLessThan(readingCall)

    fake.completeTurn({ withModelCall: false })
    await pump
  })

  it('does not count an echo the turn ended on without a model call', async () => {
    const fake = createFakeAppServer({ swallowEcho: true })
    const run = startRun(fake.child)

    const events = await collect(run.events, async () => {
      await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      fake.emitUserMessageItem('echo-a', STEER_TEXT)
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.completeTurn({ withModelCall: false })
    })

    // Echoed, but nothing read it: the steer stays in flight and the end of the turn
    // promotes it (DL-114-07) rather than the transcript claiming a delivery.
    expect(events.some((event) => event.type === 'steer.delivered')).toBe(false)
  })

  it('counts one delivery even though started and completed both carry the item', async () => {
    const fake = createFakeAppServer()
    const run = startRun(fake.child)

    const events = await collect(run.events, async () => {
      await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.completeTurn()
    })

    expect(events.filter((event) => event.type === 'steer.delivered')).toHaveLength(1)
  })

  /**
   * Matched by TEXT, not by arrival order. The app server emits `userMessage` items for
   * things Batshit did not steer, and two steers can be acknowledged out of the order they
   * were sent — an order-based match would then confirm the wrong one and put its marker
   * at a position the model never read it at.
   */
  it('matches two steers to their own echoes even when the echoes arrive reversed', async () => {
    const fake = createFakeAppServer({ swallowEcho: true })
    const run = startRun(fake.child)
    const second = '[Steer — from the user, mid-reply]\nand mention the exit code'

    const events = await collect(run.events, async () => {
      await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      await run.steer({ steerIds: ['steer_2'], text: second })
      fake.emitUserMessageItem('echo-b', second)
      fake.emitUserMessageItem('echo-a', STEER_TEXT)
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.completeTurn()
    })

    expect(
      events
        .filter((event) => event.type === 'steer.delivered')
        .map((event) => (event as any).steer_ids)
    ).toEqual([['steer_2'], ['steer_1']])
  })

  it('ignores a userMessage item that is not one of the steers in flight', async () => {
    const fake = createFakeAppServer({ swallowEcho: true })
    const run = startRun(fake.child)
    const seen: ThreadEvent[] = []

    const pump = (async () => {
      for await (const event of run.events) {
        seen.push(event)
        if (event.type === 'turn.completed' || event.type === 'turn.failed') break
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 20))
    await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })

    fake.emitUserMessageItem('other-item', 'a userMessage Batshit did not steer')
    fake.emitModelCallStart('call-after-other')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen.filter((event) => event.type === 'steer.delivered')).toHaveLength(0)

    fake.emitUserMessageItem('echo-a', STEER_TEXT)
    fake.emitModelCallStart('call-after-echo')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      seen
        .filter((event) => event.type === 'steer.delivered')
        .map((event) => (event as any).steer_ids)
    ).toEqual([['steer_1']])

    fake.completeTurn()
    await pump
  })

  /**
   * `item/started` and `item/completed` both carry the SAME item. With two steers whose
   * text happens to match — "hurry up", twice — a lane that did not remember which items it
   * had already counted would confirm the second steer against the FIRST item's second
   * notification, marking it delivered before its own echo had arrived at all.
   */
  it('counts one delivery per item, even when two steers carry identical text', async () => {
    const fake = createFakeAppServer({ swallowEcho: true })
    const run = startRun(fake.child)
    const seen: ThreadEvent[] = []

    const pump = (async () => {
      for await (const event of run.events) {
        seen.push(event)
        if (event.type === 'turn.completed' || event.type === 'turn.failed') break
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 20))
    await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
    await run.steer({ steerIds: ['steer_2'], text: STEER_TEXT })

    fake.emitUserMessageItem('echo-a', STEER_TEXT)
    fake.emitModelCallStart('call-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen.filter((event) => event.type === 'steer.delivered')).toHaveLength(1)

    fake.emitUserMessageItem('echo-b', STEER_TEXT)
    fake.emitModelCallStart('call-b')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      seen
        .filter((event) => event.type === 'steer.delivered')
        .map((event) => (event as any).steer_ids)
    ).toEqual([['steer_1'], ['steer_2']])

    fake.completeTurn()
    await pump
  })

  it('drops a refused steer from the echo watch list', async () => {
    const fake = createFakeAppServer({ refuseSteerWith: STEER_REFUSALS.noActiveTurn })
    const run = startRun(fake.child)
    const seen: ThreadEvent[] = []

    const pump = (async () => {
      for await (const event of run.events) {
        seen.push(event)
        if (event.type === 'turn.completed' || event.type === 'turn.failed') break
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 20))
    const refused = await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
    expect(refused.accepted).toBe(false)

    // The user's words are still in Batshit's inbox, so the same text can be sent again
    // under a new id. A refused attempt left watching would swallow this one's echo.
    fake.emitUserMessageItem('echo-a', STEER_TEXT)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen.filter((event) => event.type === 'steer.delivered')).toHaveLength(0)

    fake.completeTurn()
    await pump
  })

  describe('the three refusals (all -32600)', () => {
    /**
     * F-P2-1 (Faye's review): the lane starts `initialize` → `thread/start` → `turn/start`
     * the moment it is created, and send-routed attaches the steer channel as soon as
     * `streamNativeMode` resolves — BEFORE those round trips have answered. A steer flushed
     * in that window used to be refused as "no active turn", returned to the inbox, and
     * never pushed again, so the user's earliest correction — typed right after sending —
     * arrived only as the NEXT turn. The lane now waits for its turn to start.
     */
    it('waits for the turn to start rather than refusing a steer sent before it', async () => {
      const fake = createFakeAppServer()
      const run = startRun(fake.child)

      // No `turn/start` has been answered yet, so the lane has no turn id.
      const result = await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      expect(result).toEqual({ accepted: true, turnId: 'turn-1' })
      expect(fake.steerRequests).toHaveLength(1)
      expect(fake.steerRequests[0].expectedTurnId).toBe('turn-1')
      await run.cleanup()
    })

    /**
     * The `turn/start` reply carries the turn id, but live Codex refused a `turn/steer`
     * sent in the gap between that reply and its `turn/started` notification (the review's
     * early-steer run). The notification is what says the turn is running.
     */
    it('waits for the turn/started notification, not just the turn/start reply', async () => {
      const fake = createFakeAppServer({ delayTurnStartedMs: 40 })
      const run = startRun(fake.child)
      const pump = (async () => {
        for await (const event of run.events) {
          if (event.type === 'turn.completed' || event.type === 'turn.failed') break
        }
      })()

      const steered = run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      // The reply has been answered by now; the notification has not.
      await new Promise((resolve) => setTimeout(resolve, 15))
      expect(fake.steerRequests).toHaveLength(0)

      const result = await steered
      expect(result.accepted).toBe(true)
      expect(fake.steerRequests).toHaveLength(1)
      fake.completeTurn()
      await pump
    })

    it('refuses a steer that was still waiting for a turn when the run closed', async () => {
      const fake = createFakeAppServer()
      // Never answer `turn/start`: the run stays turn-less until it is cleaned up.
      fake.child.stdin.removeAllListeners('data')
      const run = startRun(fake.child)

      const pending = run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      await new Promise((resolve) => setTimeout(resolve, 20))
      await run.cleanup()

      const result = await pending
      expect(result.accepted).toBe(false)
      if (result.accepted) throw new Error('expected a refusal')
      expect(fake.steerRequests).toHaveLength(0)
    })

    for (const [label, message] of [
      ['no active turn', STEER_REFUSALS.noActiveTurn],
      ['a turn-id mismatch', STEER_REFUSALS.wrongTurnId('turn_wrong', 'turn-1')],
      ['a steer after turn/completed', STEER_REFUSALS.afterCompleted]
    ] as const) {
      it(`reports ${label} as undelivered rather than throwing`, async () => {
        const fake = createFakeAppServer({ refuseSteerWith: message })
        const run = startRun(fake.child)

        let result: Awaited<ReturnType<typeof run.steer>> | null = null
        await collect(run.events, async () => {
          result = await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
          fake.completeTurn()
        })

        expect(result).toBeTruthy()
        expect(result!.accepted).toBe(false)
        if (result!.accepted) throw new Error('expected a refusal')
        expect(result!.reason).toContain(message)
      })
    }

    it('emits no steer.delivered for a refused steer', async () => {
      const fake = createFakeAppServer({ refuseSteerWith: STEER_REFUSALS.noActiveTurn })
      const run = startRun(fake.child)

      const events = await collect(run.events, async () => {
        await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
        await new Promise((resolve) => setTimeout(resolve, 20))
        fake.completeTurn()
      })

      expect(events.some((event) => event.type === 'steer.delivered')).toBe(false)
    })

    it('emits no steer.delivered when an accepted steer is never echoed', async () => {
      const fake = createFakeAppServer({ swallowEcho: true })
      const run = startRun(fake.child)

      const events = await collect(run.events, async () => {
        const result = await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
        expect(result.accepted).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 20))
        fake.completeTurn()
      })

      // Accepted is not delivered. Nothing writes a marker, and the steer stays in the
      // inbox where the end of the turn promotes it (DL-114-07).
      expect(events.some((event) => event.type === 'steer.delivered')).toBe(false)
    })

    it('refuses once the run has closed', async () => {
      const fake = createFakeAppServer()
      const run = startRun(fake.child)
      await collect(run.events, async () => {
        fake.completeTurn()
      })

      const result = await run.steer({ steerIds: ['steer_1'], text: STEER_TEXT })
      expect(result.accepted).toBe(false)
      if (result.accepted) throw new Error('expected a refusal')
      expect(result.reason).toContain('already finished')
    })
  })
})
