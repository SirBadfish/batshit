import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleSubagentRunWork, waitForProcessExit } from '../subagentRunSettle'

/**
 * BL-287 (2026-09-27): a registered Subagent run counts as running until its lane's work has
 * settled AND its CLI process has exited, because the Subagent's delete removes the folder that
 * process writes into. A CLI that ignores its stop is killed at the grace; an unproven exit at
 * the bound rejects so delete retains the profile for a later verified retry.
 *
 * These use real processes: the exit is the thing under test.
 */

const started: ChildProcess[] = []

/** A node process that exits `exitAfterTermMs` after SIGTERM, or ignores SIGTERM (`null`). */
function startCli(exitAfterTermMs: number | null): Promise<ChildProcess> {
  const onTerm =
    exitAfterTermMs === null ? '' : `setTimeout(() => process.exit(0), ${exitAfterTermMs})`
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => { ${onTerm} }); console.log('up'); setInterval(() => {}, 1000)`],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  started.push(child)
  // Ready once its SIGTERM handler is installed, so a SIGTERM is never the default one.
  return new Promise((resolve) => child.stdout!.once('data', () => resolve(child)))
}

function alive(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null
}

afterEach(() => {
  for (const child of started.splice(0)) if (alive(child)) child.kill('SIGKILL')
  vi.restoreAllMocks()
})

describe('settleSubagentRunWork (BL-287)', () => {
  it('waits for the CLI process to EXIT, not only for the lane’s stream to end', async () => {
    const cli = await startCli(150)
    const stop = new AbortController()
    const events: string[] = []
    cli.once('exit', () => events.push('CLI exited'))

    // The app-server lane's shape: the stream ends the moment SIGTERM is SENT.
    const work = new Promise<void>((resolve) =>
      stop.signal.addEventListener('abort', () => {
        cli.kill('SIGTERM')
        events.push('stream ended')
        resolve()
      })
    )
    const settled = settleSubagentRunWork({ work, cliProcesses: [cli], stopSignal: stop.signal, label: 'Helper' }).completion.then(
      () => events.push('run settled')
    )

    stop.abort('subagent_deleted')
    await settled

    expect(events).toEqual(['stream ended', 'CLI exited', 'run settled'])
  })

  it('kills a CLI that ignores its stop at the grace (SIGKILL), and then settles', async () => {
    const cli = await startCli(null)
    const stop = new AbortController()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const work = new Promise<void>((resolve) =>
      stop.signal.addEventListener('abort', () => {
        cli.kill('SIGTERM')
        resolve()
      })
    )

    const startedAt = Date.now()
    stop.abort('user')
    await settleSubagentRunWork({
      work,
      cliProcesses: [cli],
      stopSignal: stop.signal,
      label: 'Stubborn',
      killGraceMs: 150,
      boundMs: 5_000
    }).completion

    expect(cli.signalCode).toBe('SIGKILL')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Stubborn's CLI \(pid \d+\) had not exited 150 ms.*SIGKILL/)
  })

  it('rejects at the bound when the work never settles, and says so', async () => {
    const stop = new AbortController()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const startedAt = Date.now()
    stop.abort('subagent_deleted')
    await expect(settleSubagentRunWork({
      work: new Promise(() => {}),
      cliProcesses: [],
      stopSignal: stop.signal,
      label: 'Hung',
      killGraceMs: 50,
      boundMs: 200
    }).completion).rejects.toThrow(/had not settled or its command processes had not been confirmed exited/)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190)
    expect(error.mock.calls.flat().join(' ')).toMatch(/Hung's run had not settled.*after 200 ms/)
  })

  it('a later retry succeeds only after previously unverified work has settled', async () => {
    const stop = new AbortController()
    let finishWork!: () => void
    const work = new Promise<void>((resolve) => { finishWork = resolve })
    stop.abort('subagent_deleted')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const settlement = settleSubagentRunWork({
      work, cliProcesses: [], stopSignal: stop.signal, label: 'Retry', boundMs: 100
    })
    await expect(settlement.completion).rejects.toThrow(/not been confirmed exited/)
    finishWork()
    await expect(settlement.retryCleanup()).resolves.toBeUndefined()
  })

  it('starts no clock while the run is still running and nobody stopped it', async () => {
    const cli = await startCli(null)
    const stop = new AbortController()
    let finishWork!: () => void
    const work = new Promise<void>((resolve) => (finishWork = resolve))
    let settled = false
    const settling = settleSubagentRunWork({
      work,
      cliProcesses: [cli],
      stopSignal: stop.signal,
      label: 'Busy',
      killGraceMs: 50,
      boundMs: 100
    }).completion.then(() => (settled = true))

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(cli)).toBe(true)
    expect(settled).toBe(false)

    // The lane's own end starts the clock too: a CLI that does not exit after a normal end goes.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    finishWork()
    await settling
    expect(cli.signalCode).toBe('SIGKILL')
  })

  it('reads the exit from the process itself when a bridge took its listeners away', async () => {
    const cli = await startCli(50)
    const exited = waitForProcessExit(cli)
    // `claudeBridge` and the Codex exec lane call this in their cleanup.
    cli.removeAllListeners()
    cli.kill('SIGTERM')

    await exited
    expect(alive(cli)).toBe(false)
  })

  it('a process that never started counts as exited', async () => {
    const neverStarted = spawn('/nonexistent/batshit-cli-that-is-not-there')
    neverStarted.on('error', () => {})

    await expect(waitForProcessExit(neverStarted)).resolves.toBeUndefined()
  })
})
