/**
 * Live proof of Batshit's host Docker Sandbox lane against Docker's real `sbx` CLI.
 * Skipped unless run deliberately on a computer with sbx installed, signed in
 * (`sbx login`), and set up (`sbx policy init …`):
 *
 *   BATSHIT_LIVE_DOCKER_SANDBOX=1 npx vitest run src/lib/server/services/__tests__/dockerSandbox.live.test.ts
 *
 * It creates one throwaway session sandbox and removes it at the end. Its run-end cleanup
 * also prunes Batshit sandboxes left unused for an hour, the way a chat turn does.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeToolService } from '../nativeTools'

const LIVE = process.env.BATSHIT_LIVE_DOCKER_SANDBOX === '1'

function sbxSandboxes(): Array<{ name: string; status: string }> {
  const out = execFileSync('sbx', ['ls', '--json'], { encoding: 'utf8' })
  return JSON.parse(out).sandboxes ?? []
}

describe.runIf(LIVE)('Docker Sandbox host lane (live sbx)', () => {
  it('runs a chat’s parallel first commands in one sandbox, keeps it through an idle stop, and cleans up', async () => {
    const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-sbx-live-')))
    const sessionId = `live-sbx-${Date.now()}`
    const bash = (command: string) =>
      nativeToolService.nativeBashExecute({
        userId: 'live-proof',
        sessionId,
        command,
        cwd: workspace,
        workspaceRoot: workspace,
        backend: 'docker_sandbox',
        accessMode: 'dangerous',
        timeoutMs: 120_000
      })

    try {
      const first = await Promise.all([
        bash('echo one'),
        bash('echo two'),
        bash('pwd; echo kept > /tmp/batshit-live-state.txt')
      ])
      expect(first.map((result) => result.reason ?? result.stdout.trim())).toEqual([
        'one',
        'two',
        workspace
      ])
      const name = first[0].sandboxName as string
      expect(first.map((result) => result.sandboxName)).toEqual([name, name, name])
      expect(sbxSandboxes().filter((sandbox) => sandbox.name === name)).toHaveLength(1)

      const network = await bash(
        'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/ || echo blocked'
      )
      expect(network.stdout.trim()).not.toBe('200')

      // sbx stops an idle sandbox about 30 s after its last command. Stopping it here instead
      // of waiting keeps the window short: a Batshit process on this computer that still runs
      // the older cleanup deletes every stopped `batshit-` sandbox on its next chat turn.
      execFileSync('sbx', ['stop', name])
      expect(sbxSandboxes().find((sandbox) => sandbox.name === name)?.status).toBe('stopped')
      const afterIdle = await bash('cat /tmp/batshit-live-state.txt')
      expect(afterIdle.reason ?? afterIdle.stdout.trim()).toBe('kept')
      expect(afterIdle.sandboxName).toBe(name)
    } finally {
      const warnings = await nativeToolService.cleanupDockerSandboxesForSession(sessionId)
      await rm(workspace, { recursive: true, force: true })
      expect(warnings).toEqual([])
      expect(sbxSandboxes().some((sandbox) => sandbox.name.includes('live-proof'))).toBe(false)
    }
  }, 300_000)

  // A Stop and a timeout end what the command started inside the sandbox (2026-09-18). Measured
  // before: `sbx exec` passes no signal into the sandbox, so the whole command ran on after its
  // client was killed, until the chat's run-end cleanup removed the sandbox; and the client
  // itself exited 28.9 s after its SIGTERM.
  it('a Stop and a timeout end everything the command started inside the sandbox', async () => {
    const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-sbx-live-end-')))
    const sessionId = `live-sbx-end-${Date.now()}`
    const bash = (command: string, extra: { abortSignal?: AbortSignal; timeoutMs?: number } = {}) =>
      nativeToolService.nativeBashExecute({
        userId: 'live-proof',
        sessionId,
        command,
        cwd: workspace,
        workspaceRoot: workspace,
        backend: 'docker_sandbox',
        accessMode: 'dangerous',
        timeoutMs: extra.timeoutMs ?? 120_000,
        abortSignal: extra.abortSignal
      })
    let name = ''
    const sleepsWith = (nonce: string) => {
      try {
        return execFileSync('sbx', ['exec', name, 'ps', '-eo', 'args'], { encoding: 'utf8' })
          .split('\n')
          .filter((line) => line.trim().startsWith('sleep ') && line.includes(nonce)).length
      } catch {
        return -1
      }
    }
    const waitFor = async (check: () => boolean, ms: number) => {
      const deadline = Date.now() + ms
      while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      return check()
    }

    try {
      // The sandbox is up first, so the Stop lands on the command and not on the start.
      const warm = await bash('true')
      name = warm.sandboxName as string
      expect(name).toMatch(/^batshit-live-proof-/)

      const stopNonce = String(Date.now() % 100_000).padStart(5, '0')
      const stop = new AbortController()
      const stopping = bash(`sleep 61.${stopNonce} & sleep 62.${stopNonce}`, { abortSignal: stop.signal })
      expect(await waitFor(() => sleepsWith(stopNonce) === 2, 30_000)).toBe(true)
      const stoppedAt = Date.now()
      stop.abort('user')
      const stopped = await stopping

      expect(stopped).toMatchObject({ success: false, stopped: true })
      expect(Date.now() - stoppedAt).toBeLessThan(3_000)
      // Both are gone when the command's result comes back, and the sandbox is still there:
      // the end did it, not the chat's cleanup.
      expect(sleepsWith(stopNonce)).toBe(0)
      expect(sbxSandboxes().some((sandbox) => sandbox.name === name)).toBe(true)

      const timeoutNonce = String((Date.now() + 1) % 100_000).padStart(5, '0')
      const timedOut = await bash(`sleep 63.${timeoutNonce} & sleep 64.${timeoutNonce}`, { timeoutMs: 2_000 })

      expect(timedOut).toMatchObject({ success: false, timedOut: true })
      expect(sleepsWith(timeoutNonce)).toBe(0)
    } finally {
      const warnings = await nativeToolService.cleanupDockerSandboxesForSession(sessionId)
      await rm(workspace, { recursive: true, force: true })
      expect(warnings).toEqual([])
      expect(sbxSandboxes().some((sandbox) => sandbox.name.includes('live-proof'))).toBe(false)
    }
  }, 300_000)
})
