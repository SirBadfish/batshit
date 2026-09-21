/**
 * Live proof against the real Apple `container` CLI (F-P5-1): a chat's parallel first bash
 * calls share one sandbox create. Skipped unless run deliberately on a Mac with Apple
 * Container installed and its system started:
 *
 *   BATSHIT_LIVE_APPLE_CONTAINER=1 npx vitest run src/lib/server/services/__tests__/appleContainerSandbox.live.test.ts
 *
 * It creates managed sandboxes with throwaway names and removes them at the end. Its run-end
 * cleanup also prunes any dead Batshit sandbox, exactly as a chat turn does.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAppleContainerSandboxName,
  cleanupAppleContainerSandboxesForSession,
  executeAppleContainerSandboxCommand
} from '../appleContainerSandbox'

const LIVE = process.env.BATSHIT_LIVE_APPLE_CONTAINER === '1'

function listContainerIds(): string[] {
  const run = spawnSync('container', ['list', '--all', '--format', 'json'], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`container list failed: ${run.stderr}`)
  const entries = JSON.parse(run.stdout || '[]') as Array<{ id?: string; configuration?: { id?: string } }>
  return entries.map((entry) => entry.id ?? entry.configuration?.id ?? '')
}

describe.runIf(LIVE)('appleContainerSandbox (live Apple Container)', () => {
  it('runs a chat’s parallel first commands in one freshly created sandbox', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-live-race-'))
    const workspaceRoot = await realpath(tempRoot)
    const sessionId = `live-parallel-first-calls-${Date.now()}`
    const sandboxName = buildAppleContainerSandboxName({ userId: 'live-proof', workspaceRoot, sessionId })
    const commands = ['echo one', 'echo two', 'echo three', 'echo four', 'pwd']

    try {
      expect(listContainerIds()).not.toContain(sandboxName)
      const results = await Promise.all(
        commands.map((command) =>
          executeAppleContainerSandboxCommand({
            userId: 'live-proof',
            sessionId,
            workspaceRoot,
            cwd: workspaceRoot,
            command,
            timeoutMs: 120_000
          })
        )
      )

      expect(results.map((result) => (result.ok ? result.run.stdout.trim() : result.reason))).toEqual([
        'one',
        'two',
        'three',
        'four',
        workspaceRoot
      ])
      expect(results.every((result) => result.ok && result.run.exitCode === 0)).toBe(true)
      expect(listContainerIds().filter((id) => id === sandboxName)).toHaveLength(1)
    } finally {
      const warnings = await cleanupAppleContainerSandboxesForSession(sessionId)
      await rm(tempRoot, { recursive: true, force: true })
      expect(warnings).toEqual([])
      expect(listContainerIds()).not.toContain(sandboxName)
    }
  }, 240_000)

  // A Stop and a timeout end what the command started inside the sandbox (2026-09-18). Measured
  // before: `container exec` passed SIGTERM to the command's top shell only, and both parts of
  // `sleep 61 & sleep 62` ran on inside until the chat's run-end cleanup removed the sandbox.
  it('a Stop and a timeout end everything the command started inside the sandbox', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-live-end-'))
    const workspaceRoot = await realpath(tempRoot)
    const sessionId = `live-end-${Date.now()}`
    const sandboxName = buildAppleContainerSandboxName({ userId: 'live-proof', workspaceRoot, sessionId })
    const run = (command: string, extra: { abortSignal?: AbortSignal; timeoutMs?: number } = {}) =>
      executeAppleContainerSandboxCommand({
        userId: 'live-proof',
        sessionId,
        workspaceRoot,
        cwd: workspaceRoot,
        command,
        timeoutMs: extra.timeoutMs ?? 120_000,
        abortSignal: extra.abortSignal
      })
    const sleepsWith = (nonce: string) =>
      (spawnSync('container', ['exec', sandboxName, 'ps', '-o', 'args'], { encoding: 'utf8' }).stdout ?? '')
        .split('\n')
        .filter((line) => line.trim().startsWith('sleep ') && line.includes(nonce)).length
    const waitFor = async (check: () => boolean, ms: number) => {
      const deadline = Date.now() + ms
      while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      return check()
    }

    try {
      // The sandbox is up first, so the Stop lands on the command and not on the start.
      expect((await run('true')).ok).toBe(true)

      const stopNonce = String(Date.now() % 100_000).padStart(5, '0')
      const stop = new AbortController()
      const stopping = run(`sleep 61.${stopNonce} & sleep 62.${stopNonce}`, { abortSignal: stop.signal })
      expect(await waitFor(() => sleepsWith(stopNonce) === 2, 20_000)).toBe(true)
      const stoppedAt = Date.now()
      stop.abort('user')
      const stopped = await stopping

      expect(stopped.ok && stopped.run.stopped).toBe(true)
      expect(Date.now() - stoppedAt).toBeLessThan(3_000)
      // Both are gone when the command's result comes back, and the sandbox is still there:
      // the end did it, not the chat's cleanup.
      expect(sleepsWith(stopNonce)).toBe(0)
      expect(listContainerIds()).toContain(sandboxName)

      const timeoutNonce = String((Date.now() + 1) % 100_000).padStart(5, '0')
      const timedOut = await run(`sleep 63.${timeoutNonce} & sleep 64.${timeoutNonce}`, { timeoutMs: 2_000 })

      expect(timedOut.ok && timedOut.run.timedOut).toBe(true)
      expect(sleepsWith(timeoutNonce)).toBe(0)
      expect(listContainerIds()).toContain(sandboxName)
    } finally {
      const warnings = await cleanupAppleContainerSandboxesForSession(sessionId)
      await rm(tempRoot, { recursive: true, force: true })
      expect(warnings).toEqual([])
      expect(listContainerIds()).not.toContain(sandboxName)
    }
  }, 240_000)

  // Every chat turn in every Batshit process on this Mac prunes stopped Batshit sandboxes, and
  // Apple lists a sandbox that is still starting as `stopped`. These sandboxes play the ones
  // another Batshit process owns; this process's run-end cleanup must remove only the dead ones.
  describe('the prune across Batshit processes', () => {
    const NETWORK = 'batshit-apple-sandbox-internal'
    const stamp = (ms: number) => ['--label', `batshit.created-at=${ms}`]
    const containerArgs = (name: string, labels: string[]) => [
      '--name',
      name,
      ...labels,
      '--network',
      NETWORK,
      'bash:5.2',
      'bash',
      '-lc',
      'trap "exit 0" TERM INT; while true; do sleep 1; done'
    ]
    const cli = (args: string[]) => spawnSync('container', args, { encoding: 'utf8' })
    const stateOf = (name: string) => {
      const run = cli(['list', '--all', '--format', 'json'])
      const entry = (JSON.parse(run.stdout || '[]') as Array<{ status?: string; configuration?: { id?: string } }>).find(
        (candidate) => candidate.configuration?.id === name
      )
      return entry?.status ?? 'absent'
    }

    it('keeps sandboxes that have not started, and removes the ones that are dead', async () => {
      const tag = Date.now()
      const names = {
        startingStamped: `batshit-apple-sandbox-live-prune-${tag}-a`,
        startingUnstamped: `batshit-apple-sandbox-live-prune-${tag}-b`,
        neverStartedOld: `batshit-apple-sandbox-live-prune-${tag}-c`,
        ranAndStopped: `batshit-apple-sandbox-live-prune-${tag}-d`
      }
      try {
        // Created, never started: exactly what a sandbox that is still starting lists as.
        expect(cli(['create', ...containerArgs(names.startingStamped, stamp(Date.now()))]).status).toBe(0)
        expect(cli(['create', ...containerArgs(names.startingUnstamped, [])]).status).toBe(0)
        expect(cli(['create', ...containerArgs(names.neverStartedOld, stamp(Date.now() - 11 * 60_000))]).status).toBe(0)
        expect(cli(['run', '--detach', ...containerArgs(names.ranAndStopped, stamp(Date.now()))]).status).toBe(0)
        expect(cli(['stop', '--time', '1', names.ranAndStopped]).status).toBe(0)

        const warnings = await cleanupAppleContainerSandboxesForSession(`live-unrelated-${tag}`)

        expect(warnings).toEqual([])
        expect(stateOf(names.startingStamped)).toBe('stopped')
        expect(stateOf(names.startingUnstamped)).toBe('stopped')
        expect(stateOf(names.neverStartedOld)).toBe('absent')
        expect(stateOf(names.ranAndStopped)).toBe('absent')
      } finally {
        for (const name of Object.values(names)) cli(['delete', '--force', name])
      }
    }, 120_000)

    it('does not delete a sandbox another process is starting at that moment', async () => {
      const name = `batshit-apple-sandbox-live-prune-${Date.now()}-e`
      try {
        const starting = new Promise<{ code: number | null; output: string }>((resolve) => {
          const child = spawn('container', ['run', '--detach', ...containerArgs(name, stamp(Date.now()))])
          let output = ''
          child.stdout.on('data', (chunk) => (output += chunk))
          child.stderr.on('data', (chunk) => (output += chunk))
          child.on('exit', (code) => resolve({ code, output }))
        })
        // Run the cleanup inside the start, while Apple lists the sandbox as `stopped`.
        const deadline = Date.now() + 30_000
        while (stateOf(name) !== 'stopped' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
        expect(stateOf(name)).toBe('stopped')

        await cleanupAppleContainerSandboxesForSession(`live-unrelated-${Date.now()}`)
        const started = await starting

        expect(started.output).not.toContain('not found')
        expect(started.code).toBe(0)
        expect(stateOf(name)).toBe('running')
      } finally {
        cli(['delete', '--force', name])
      }
    }, 120_000)
  })
})
