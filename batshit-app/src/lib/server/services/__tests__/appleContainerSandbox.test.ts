import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import {
  __setAppleContainerCommandRunnerForTests,
  __setAppleContainerPlatformForTests,
  buildAppleContainerSandboxName,
  cleanupAppleContainerSandboxesForSession,
  executeAppleContainerSandboxCommand,
  getAppleContainerSandboxStatus
} from '../appleContainerSandbox'

type RecordedCall = { command: string; args: string[] }

function makeRun(stdout = '', exitCode = 0, stderr = '') {
  return {
    command: 'container',
    stdout,
    stderr,
    exitCode,
    signal: null,
    timedOut: false,
    durationMs: 1,
    truncated: false
  }
}

function installFakeRunner(handler: (args: string[], calls: RecordedCall[]) => ReturnType<typeof makeRun>) {
  const calls: RecordedCall[] = []
  const runner = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args })
    return handler(args, calls)
  })
  __setAppleContainerCommandRunnerForTests(runner)
  return { calls, runner }
}

describe('appleContainerSandbox', () => {
  afterEach(() => {
    __setAppleContainerCommandRunnerForTests(null)
    __setAppleContainerPlatformForTests(null)
  })

  it('reports unsupported on non-mac platforms', async () => {
    __setAppleContainerPlatformForTests('linux')
    const status = await getAppleContainerSandboxStatus()

    expect(status.available).toBe(false)
    expect(status.supported).toBe(false)
    expect(status.backend).toBe('apple_container')
    expect(status.reason).toContain('only supported on macOS')
  })

  it('creates the internal sandbox network during status when it is missing', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const { calls } = installFakeRunner((args) => {
      const key = args.join(' ')
      if (key === '--version') return makeRun('container CLI version 0.12.3')
      if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
      if (key === 'network list --format json') {
        return makeRun(JSON.stringify([{ id: 'default', state: 'running' }]))
      }
      if (key === 'network create --internal batshit-apple-sandbox-internal') {
        return makeRun('batshit-apple-sandbox-internal')
      }
      return makeRun('', 1, `unexpected command: ${key}`)
    })

    const status = await getAppleContainerSandboxStatus()

    expect(status.available).toBe(true)
    expect(status.network).toBe('batshit-apple-sandbox-internal')
    expect(calls.map((call) => call.args.join(' '))).toContain(
      'network create --internal batshit-apple-sandbox-internal'
    )
  })

  it('starts Apple Container services during status when they are stopped', async () => {
    __setAppleContainerPlatformForTests('darwin')
    let statusChecks = 0
    const { calls } = installFakeRunner((args) => {
      const key = args.join(' ')
      if (key === '--version') return makeRun('container CLI version 0.12.3')
      if (key === 'system status') {
        statusChecks += 1
        return statusChecks === 1
          ? makeRun('', 1, 'apiserver is not running')
          : makeRun('FIELD VALUE\nstatus running\n')
      }
      if (key === 'system start') return makeRun('started')
      if (key === 'network list --format json') {
        return makeRun(JSON.stringify([{ id: 'batshit-apple-sandbox-internal', state: 'running' }]))
      }
      return makeRun('', 1, `unexpected command: ${key}`)
    })

    const status = await getAppleContainerSandboxStatus()

    expect(status.available).toBe(true)
    expect(calls.map((call) => call.args.join(' '))).toContain('system start')
  })

  it('runs a command in a read-only internal-network sandbox and cleans up one-shot runs', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-sandbox-test-'))
    const cwd = path.join(tempRoot, 'project')
    await mkdir(cwd)
    const workspaceRoot = await realpath(tempRoot)
    const realCwd = await realpath(cwd)

    try {
      const { calls } = installFakeRunner((args) => {
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
        if (key === 'network list --format json') {
          return makeRun(JSON.stringify([{ id: 'batshit-apple-sandbox-internal', state: 'running' }]))
        }
        if (key === 'list --format json --all') return makeRun('[]')
        if (args[0] === 'run' && args.includes('--detach')) {
          return makeRun('batshit-apple-sandbox-user-abcdef1234')
        }
        if (args[0] === 'exec') return makeRun('APPLE_ADAPTER_OK\n')
        if (args[0] === 'delete') return makeRun(args.at(-1) ?? '')
        return makeRun('', 1, `unexpected command: ${key}`)
      })

      const result = await executeAppleContainerSandboxCommand({
        userId: 'Josh',
        workspaceRoot,
        cwd: realCwd,
        command: 'printf APPLE_ADAPTER_OK',
        timeoutMs: 10_000,
        env: { BATSHIT_PROOF: 'yes' }
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.run.stdout).toContain('APPLE_ADAPTER_OK')
      }

      const createCall = calls.find((call) => call.args[0] === 'run' && call.args.includes('--detach'))
      expect(createCall?.args).toEqual(
        expect.arrayContaining([
          '--network',
          'batshit-apple-sandbox-internal',
          '--read-only',
          '--volume',
          `${workspaceRoot}:${workspaceRoot}`,
          '--workdir',
          realCwd
        ])
      )

      const execCall = calls.find((call) => call.args[0] === 'exec')
      expect(execCall?.args).toEqual(
        expect.arrayContaining(['--workdir', realCwd, '--env', 'BATSHIT_PROOF=yes'])
      )
      expect(calls.some((call) => call.args[0] === 'delete')).toBe(true)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps session sandboxes until explicit session cleanup', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-sandbox-session-'))
    const workspaceRoot = await realpath(tempRoot)
    const sessionId = 'session-apple-container-proof'
    const sandboxName = buildAppleContainerSandboxName({
      userId: 'Josh',
      workspaceRoot,
      sessionId
    })
    let cleanupPhase = false

    try {
      const { calls } = installFakeRunner((args) => {
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
        if (key === 'network list --format json') {
          return makeRun(JSON.stringify([{ id: 'batshit-apple-sandbox-internal', state: 'running' }]))
        }
        if (key === 'list --format json --all') {
          return cleanupPhase ? makeRun(JSON.stringify([{ id: sandboxName, state: 'running' }])) : makeRun('[]')
        }
        if (args[0] === 'run' && args.includes('--detach')) return makeRun(sandboxName)
        if (args[0] === 'exec') return makeRun('SESSION_OK\n')
        if (args[0] === 'delete') return makeRun(args.at(-1) ?? '')
        return makeRun('', 1, `unexpected command: ${key}`)
      })

      const result = await executeAppleContainerSandboxCommand({
        userId: 'Josh',
        sessionId,
        workspaceRoot,
        cwd: workspaceRoot,
        command: 'printf SESSION_OK',
        timeoutMs: 10_000
      })
      expect(result.ok).toBe(true)
      expect(calls.some((call) => call.args[0] === 'delete')).toBe(false)

      cleanupPhase = true
      const warnings = await cleanupAppleContainerSandboxesForSession(sessionId)
      expect(warnings).toEqual([])
      expect(calls.some((call) => call.args.join(' ') === `delete --force ${sandboxName}`)).toBe(true)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
