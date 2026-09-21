import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { startCodexAppServerRun } from '../services/codexAppServerLane'

/**
 * A Stop in the first moments of a managed Codex reply (2026-09-18).
 *
 * Live Codex refuses `turn/interrupt` in the gap between the `turn/start` reply and the
 * `turn/started` notification, "no active turn to interrupt" (-32600), exactly as it refuses a
 * steer there (F-P2-1). The lane sent the interrupt at once, logged the refusal, and waited out
 * its 10 s backstop: Stop 0.4 s after the send ended the request 11.0 s later, while a Stop
 * 1.4 s in took 145 ms (`_local/stopfix-proof/before-codex-stop-*.json`). The fake app server
 * here refuses the interrupt in that gap the same way.
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

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: (signal?: string) => boolean
}

function createFakeAppServer(options: {
  /** Send `turn/started` this long after answering `turn/start`. */
  turnStartedAfterMs: number
  /** Answer `thread/start` only after this long. */
  threadStartAfterMs?: number
  /** Called the moment `turn/start` is answered, before `turn/started`. */
  onTurnStartAnswered?: () => void
}) {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }

  const received: Array<{ method: string; at: number }> = []
  let turnStarted = false
  const send = (msg: Record<string, unknown>) => child.stdout.write(JSON.stringify(msg) + '\n')

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
      received.push({ method: msg.method, at: Date.now() })

      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake' } })
      } else if (msg.method === 'thread/start') {
        const answer = () =>
          send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-1', ephemeral: true } } })
        if (options.threadStartAfterMs) setTimeout(answer, options.threadStartAfterMs)
        else answer()
      } else if (msg.method === 'turn/start') {
        send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
        options.onTurnStartAnswered?.()
        setTimeout(() => {
          turnStarted = true
          send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
          send({
            jsonrpc: '2.0',
            method: 'item/started',
            params: {
              item: { type: 'commandExecution', id: 'call_1', command: 'sleep 20', aggregatedOutput: null, exitCode: null, status: 'inProgress' }
            }
          })
        }, options.turnStartedAfterMs)
      } else if (msg.method === 'turn/interrupt') {
        if (!turnStarted) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'no active turn to interrupt' } })
          continue
        }
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } }
        })
      }
    }
  })

  return { child, received }
}

function startRun(child: FakeChild, signal: AbortSignal) {
  spawnMock.mockReturnValue(child)
  return startCodexAppServerRun({
    executable: 'codex',
    env: {},
    threadParams: { ephemeral: true },
    prompt: 'Run sleep 20.',
    contextGuardEnabled: false,
    signal
  })
}

/** Drain the run's events: how it ended, and how long that took. */
async function drain(run: ReturnType<typeof startRun>, withinMs: number) {
  const started = Date.now()
  const ended = (async () => {
    try {
      for await (const _event of run.events) {
        // keep reading
      }
      return { how: 'finished' as const, error: null as string | null }
    } catch (error) {
      return { how: 'failed' as const, error: (error as Error)?.name ?? String(error) }
    }
  })()
  const timeout = new Promise<{ how: 'still running'; error: null }>((resolve) =>
    setTimeout(() => resolve({ how: 'still running', error: null }), withinMs)
  )
  const outcome = await Promise.race([ended, timeout])
  return { ...outcome, ms: Date.now() - started }
}

describe('a Stop in the first moments of a Codex reply', () => {
  it('interrupts once the turn has started, instead of waiting out the 10 s backstop', async () => {
    const stop = new AbortController()
    const fake = createFakeAppServer({
      turnStartedAfterMs: 300,
      onTurnStartAnswered: () => stop.abort('user')
    })
    const run = startRun(fake.child, stop.signal)

    const outcome = await drain(run, 3_000)
    await run.cleanup()

    expect(outcome.how).toBe('failed')
    expect(outcome.error).toBe('AbortError')
    expect(outcome.ms).toBeLessThan(2_000)
    const interrupts = fake.received.filter((entry) => entry.method === 'turn/interrupt')
    expect(interrupts).toHaveLength(1)
  })

  it('never starts a turn it was told to stop before it began', async () => {
    const stop = new AbortController()
    const fake = createFakeAppServer({ turnStartedAfterMs: 0, threadStartAfterMs: 200 })
    const run = startRun(fake.child, stop.signal)
    setTimeout(() => stop.abort('user'), 50)

    const outcome = await drain(run, 3_000)
    await run.cleanup()

    expect(outcome.how).toBe('failed')
    expect(outcome.error).toBe('AbortError')
    expect(outcome.ms).toBeLessThan(2_000)
    expect(fake.received.map((entry) => entry.method)).not.toContain('turn/start')
  })
})
