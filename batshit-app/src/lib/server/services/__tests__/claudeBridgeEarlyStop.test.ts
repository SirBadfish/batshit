import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

/**
 * A Stop that ends a managed Claude run before anyone reads its events (2026-09-18).
 *
 * Measured on the dev lane: Stop 0.3 s after the send, while the Claude child was starting.
 * The child was killed at once, but the reply's request never ended: its client gave up after
 * 300 s, and the server-side request was still running ten minutes later
 * (`_local/stopfix-proof/before-claude-stop-300.json`). The run's event iterator reads the
 * child's stdout with `for await (const line of rl)` and waits for its `close`, and both were
 * attached only when the iterator first ran. A child that had already exited by then left a
 * closed readline (iterating one waits forever) and a `close` that had already fired.
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
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  exitCode: number | null
  signalCode: string | null
  kill: (signal?: string) => boolean
}

function createFakeClaude(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

/** The child dies the way a Stop kills it: stdout ends, then `close` with SIGTERM. */
async function killBeforeAnyoneReads(child: FakeChild) {
  child.killed = true
  child.signalCode = 'SIGTERM'
  child.stdout.end()
  child.stderr.end()
  await new Promise((resolve) => setTimeout(resolve, 20))
  child.emit('exit', null, 'SIGTERM')
  child.emit('close', null, 'SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Drain the run's events, or report that it hung. */
async function drainWithin(events: AsyncGenerator<any>, ms: number) {
  const seen: any[] = []
  const drained = (async () => {
    for await (const event of events) seen.push(event)
    return 'ended' as const
  })()
  const hung = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))
  return { outcome: await Promise.race([drained, hung]), seen }
}

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

describe('a Claude run stopped before its events are read', () => {
  it('ends instead of waiting forever for a child that is already gone', async () => {
    const child = createFakeClaude()
    spawnMock.mockReturnValue(child)
    const stop = new AbortController()
    const { ClaudeBridge } = await import('../claudeBridge')
    const runner = await (new ClaudeBridge() as any).runViaCli('the prompt', {
      workingDirectory: '/tmp/early-stop-test',
      allowedTools: [],
      signal: stop.signal
    })

    stop.abort('user')
    await killBeforeAnyoneReads(child)

    const { outcome, seen } = await drainWithin(runner.events, 2_000)
    expect(outcome).toBe('ended')
    expect(seen).toEqual([])
    await runner.cleanup?.()
  })

  it('still reads every line a child wrote before it exited', async () => {
    // The same early exit after real output: the lines must not be lost on the way.
    const child = createFakeClaude()
    spawnMock.mockReturnValue(child)
    const { ClaudeBridge } = await import('../claudeBridge')
    const runner = await (new ClaudeBridge() as any).runViaCli('the prompt', {
      workingDirectory: '/tmp/early-stop-test',
      allowedTools: []
    })

    child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n')
    child.exitCode = 0
    child.stdout.end()
    await new Promise((resolve) => setTimeout(resolve, 20))
    child.emit('close', 0, null)

    const { outcome, seen } = await drainWithin(runner.events, 2_000)
    expect(outcome).toBe('ended')
    expect(seen.map((event) => event.type)).toEqual(['system', 'result'])
    await runner.cleanup?.()
  })
})
