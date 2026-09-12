import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

/**
 * SA-114 P2 (DL-114-08, AMD-114-01) — steering a managed Claude Code run.
 *
 * Three things are pinned here, and they are one fact seen from three sides.
 *
 * 1. stdin stays OPEN for the run. Closing it right after the prompt is what made Batshit
 *    unable to steer at all — the stream-json frame the CLI wants was already correct, the
 *    pipe was just shut.
 * 2. Delivery is the `--replay-user-messages` ECHO, not the write. P0 measured the echo
 *    firing 2-6 ms after the tool result that precedes delivery, at consumption.
 * 3. The FIRST `result` ends the run. With stdin open the CLI sits waiting instead of
 *    exiting (P0 scenario A: 20.0 s to 45.0 s), and a line it has already read but not
 *    consumed starts a SECOND turn in the same process — which ending stdin does NOT
 *    prevent, because the pipe was closed after the read (P0 scenario C). So the bridge
 *    stops consuming, ends stdin, and kills the child when a written steer went unechoed.
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

const mockDetectClaudeCliStatus = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/claudeCliStatus', () => ({
  detectClaudeCliStatus: mockDetectClaudeCliStatus,
  resolveClaudeCliExecutable: vi.fn(() => '/fake/claude')
}))

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService: { list: vi.fn(async () => []) }
}))

type FakeChild = EventEmitter & {
  stdin: PassThrough & { writableEndedOverride?: boolean }
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  exitCode: number | null
  kill: (signal?: string) => boolean
  killSignals: string[]
}

function createFakeClaude(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough() as FakeChild['stdin']
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.exitCode = null
  child.killSignals = []
  child.kill = (signal?: string) => {
    child.killed = true
    child.killSignals.push(signal ?? 'SIGTERM')
    return true
  }
  return child
}

/** Everything the CLI writes, as one JSON line. */
const emit = (child: FakeChild, event: Record<string, unknown>) =>
  child.stdout.write(JSON.stringify(event) + '\n')

const userEvent = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] }
})

const toolResultEvent = (toolUseId: string, alsoText?: string) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' },
      ...(alsoText ? [{ type: 'text', text: alsoText }] : [])
    ]
  }
})

const STEER_TEXT = '[Steer — from the user, mid-reply]\nstart with PINEAPPLE'

async function startRun(child: FakeChild, options: Record<string, unknown> = {}) {
  spawnMock.mockReturnValue(child)
  const { ClaudeBridge } = await import('../claudeBridge')
  const bridge = new ClaudeBridge()
  const runner = await (bridge as any).runViaCli('the prompt', {
    workingDirectory: '/tmp/steer-test',
    allowedTools: [],
    ...options
  })
  return runner as {
    transport: string
    events: AsyncGenerator<any>
    cleanup?: () => void | Promise<void>
    steer?: (payload: { steerIds: string[]; text: string }) => Promise<boolean>
  }
}

/** The exact arg list the bridge spawned with. */
const spawnedArgs = (): string[] => spawnMock.mock.calls[0][1]

/** Everything written to the child's stdin, as parsed JSON lines. */
function readStdin(child: FakeChild): any[] {
  const raw = child.stdin.read()
  if (!raw) return []
  return String(raw)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { raw: line }
      }
    })
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectClaudeCliStatus.mockResolvedValue({
    available: true,
    executable: '/fake/claude',
    version: '2.1.185',
    source: 'path'
  })
})

afterEach(() => {
  spawnMock.mockReset()
})

describe('Claude steering (DL-114-08, AMD-114-01)', () => {
  it('asks the CLI to replay stdin user messages', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    expect(spawnedArgs()).toContain('--replay-user-messages')
    expect(spawnedArgs()).toContain('--input-format=stream-json')
    await runner.cleanup?.()
  })

  it('writes the prompt and leaves stdin open', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)

    expect(child.stdin.writableEnded).toBe(false)
    expect(readStdin(child)).toEqual([{ raw: 'the prompt' }])
    await runner.cleanup?.()
  })

  it('writes a steer as one stream-json user line', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    readStdin(child)

    await expect(runner.steer!({ steerIds: ['steer_1'], text: STEER_TEXT })).resolves.toBe(true)

    expect(readStdin(child)).toEqual([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: STEER_TEXT }] } }
    ])
    await runner.cleanup?.()
  })

  it('marks delivery from the replay echo, never from the write', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const seen: any[] = []

    const pump = (async () => {
      for await (const event of runner.events) seen.push(event)
    })()

    await runner.steer!({ steerIds: ['steer_1'], text: STEER_TEXT })
    await tick()
    // Written, not yet echoed: nothing may claim delivery.
    expect(seen.some((event) => event.type === 'batshit_steer_delivered')).toBe(false)

    emit(child, toolResultEvent('tool_1'))
    emit(child, userEvent(STEER_TEXT))
    await tick()

    expect(
      seen.filter((event) => event.type === 'batshit_steer_delivered')
    ).toEqual([{ type: 'batshit_steer_delivered', steer_ids: ['steer_1'] }])
    // The echo arrives AFTER the tool result, which is where the transcript marker belongs.
    const echoIndex = seen.findIndex((event) => event.type === 'batshit_steer_delivered')
    const toolIndex = seen.findIndex(
      (event) => event.type === 'user' && event.message?.content?.[0]?.type === 'tool_result'
    )
    expect(toolIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(toolIndex)

    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    child.exitCode = 0
    await tick()
    child.emit('close', 0, null)
    await pump
  })

  /**
   * A `user` event carrying a tool result is a tool result, whatever text rides along with
   * it. This is not hypothetical: a steer often ASKS for something, so the very next tool
   * can print the steer's own words back — `cat` on a file, an MCP server echoing its
   * input — and matching on text alone would then claim delivery at the tool's position
   * instead of at the CLI's own replay, or claim it twice.
   */
  it('never mistakes a tool result for a steer echo, even one carrying the same text', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const seen: any[] = []
    const pump = (async () => {
      for await (const event of runner.events) seen.push(event)
    })()

    await runner.steer!({ steerIds: ['steer_1'], text: STEER_TEXT })
    emit(child, toolResultEvent('tool_1', STEER_TEXT))
    emit(child, toolResultEvent('tool_2'))
    await tick()

    expect(seen.some((event) => event.type === 'batshit_steer_delivered')).toBe(false)

    // The real echo still lands, and lands once.
    emit(child, userEvent(STEER_TEXT))
    await tick()
    expect(
      seen.filter((event) => event.type === 'batshit_steer_delivered')
    ).toEqual([{ type: 'batshit_steer_delivered', steer_ids: ['steer_1'] }])

    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    child.exitCode = 0
    await tick()
    child.emit('close', 0, null)
    await pump
  })

  it('matches two steers to their own echoes, in the order they were consumed', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const second = '[Steer — from the user, mid-reply]\nalso the exit code'
    const seen: any[] = []
    const pump = (async () => {
      for await (const event of runner.events) seen.push(event)
    })()

    await runner.steer!({ steerIds: ['steer_1'], text: STEER_TEXT })
    await runner.steer!({ steerIds: ['steer_2'], text: second })
    emit(child, userEvent(second))
    emit(child, userEvent(STEER_TEXT))
    await tick()

    expect(
      seen
        .filter((event) => event.type === 'batshit_steer_delivered')
        .map((event) => event.steer_ids)
    ).toEqual([['steer_2'], ['steer_1']])

    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    child.exitCode = 0
    await tick()
    child.emit('close', 0, null)
    await pump
  })

  it('ends stdin at the first result', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const pump = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of runner.events) {
        // drain
      }
    })()

    expect(child.stdin.writableEnded).toBe(false)
    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    await tick()
    expect(child.stdin.writableEnded).toBe(true)

    child.exitCode = 0
    child.emit('close', 0, null)
    await pump
  })

  /**
   * The one that matters most. P0 scenario C: a line the CLI has already read starts a
   * second turn after the first `result`, and ending stdin does not stop it. If the bridge
   * kept consuming stdout, that second turn's answer would be appended to a reply the user
   * already has — silently, with no way to tell where the first reply ended.
   */
  it('a leftover line cannot produce a second turn’s output', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const seen: any[] = []
    const pump = (async () => {
      for await (const event of runner.events) seen.push(event)
    })()

    // Queued after the last boundary: written, and never echoed before `result`.
    await runner.steer!({ steerIds: ['steer_late'], text: STEER_TEXT })
    emit(child, { type: 'result', subtype: 'success', result: 'the first answer' })
    await tick()

    // The CLI goes on to run a whole second turn in the same process.
    emit(child, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'PINEAPPLE second turn' }] }
    })
    emit(child, userEvent(STEER_TEXT))
    emit(child, { type: 'result', subtype: 'success', result: 'the second answer', num_turns: 1 })
    await tick()
    await pump

    const results = seen.filter((event) => event.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0].result).toBe('the first answer')
    expect(JSON.stringify(seen)).not.toContain('PINEAPPLE second turn')
    expect(JSON.stringify(seen)).not.toContain('the second answer')
    // And the echo that arrived after `result` is not a delivery either.
    expect(seen.some((event) => event.type === 'batshit_steer_delivered')).toBe(false)
    // The child is killed outright rather than left to finish that turn.
    expect(child.killed).toBe(true)
    expect(child.killSignals).toContain('SIGKILL')
  })

  it('lets a clean run exit on its own when nothing was steered', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const seen: any[] = []
    const pump = (async () => {
      for await (const event of runner.events) seen.push(event)
    })()

    emit(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    await tick()

    // No steer was written, so the run is not killed: stdin is ended and the child's own
    // exit code is still checked, exactly as it was before this story.
    expect(child.killed).toBe(false)
    expect(child.stdin.writableEnded).toBe(true)

    child.exitCode = 0
    child.emit('close', 0, null)
    await pump
    expect(seen.map((event) => event.type)).toEqual(['assistant', 'result'])
  })

  /**
   * F-P2-2 (Faye's review): the run now ends at the first `result`, and stdin is ended
   * BEFORE that event is yielded — so the CLI can exit, and the child can emit `close`,
   * while the consumer still holds the `result` and the generator is suspended at the
   * yield. The `close` listener used to be registered only after the loop, so a close that
   * had already happened was never seen and the wait never resolved. The exit is now
   * captured from the start of the run.
   */
  it('does not hang when the child closes before the consumer pulls the result', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const seen: any[] = []

    const pump = (async () => {
      for await (const event of runner.events) {
        seen.push(event)
        if (event.type === 'result') {
          // The CLI exits on the stdin EOF the fence sent — before this consumer pulls again.
          child.exitCode = 0
          child.emit('close', 0, null)
        }
      }
    })()

    emit(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
    emit(child, { type: 'result', subtype: 'success', result: 'done' })

    await expect(
      Promise.race([
        pump.then(() => 'finished'),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 1500))
      ])
    ).resolves.toBe('finished')
    expect(seen.map((event) => event.type)).toEqual(['assistant', 'result'])
  })

  it('surfaces a non-zero exit for an unsteered run', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const pump = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of runner.events) {
        // drain
      }
    })()

    child.stderr.write('boom\n')
    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    await tick()
    child.exitCode = 2
    child.emit('close', 2, null)

    await expect(pump).rejects.toThrow(/exited with code 2/)
  })

  it('refuses to write a steer once stdin has been ended', async () => {
    const child = createFakeClaude()
    const runner = await startRun(child)
    const pump = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of runner.events) {
        // drain
      }
    })()

    emit(child, { type: 'result', subtype: 'success', result: 'done' })
    await tick()

    await expect(runner.steer!({ steerIds: ['steer_1'], text: STEER_TEXT })).resolves.toBe(false)

    child.exitCode = 0
    child.emit('close', 0, null)
    await pump
  })
})
