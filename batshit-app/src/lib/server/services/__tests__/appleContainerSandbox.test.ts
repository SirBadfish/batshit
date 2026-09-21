import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import {
  __runAppleContainerCommandForTests,
  __setAppleContainerCommandRunnerForTests,
  __setAppleContainerExistingStartWaitForTests,
  __setAppleContainerPlatformForTests,
  buildAppleContainerSandboxName,
  cleanupAppleContainerSandboxesForSession,
  executeAppleContainerSandboxCommand,
  getAppleContainerSandboxStatus
} from '../appleContainerSandbox'
import { SANDBOX_COMMAND_END_TIMEOUT_MS, sandboxCommandEndArgv } from '../commandEnd'

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

const NETWORK = 'batshit-apple-sandbox-internal'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type ContainerState = 'stopped' | 'running'

type RealisticContainerCli = {
  calls: string[][]
  containers: Map<string, ContainerState>
  // Apple's `startedDate` (seconds since 2001-01-01): null until the container first runs, and
  // kept after it stops.
  startedDates: Map<string, number | null>
  labels: Map<string, Record<string, string>>
  networks: Set<string>
  count: (predicate: (args: string[]) => boolean) => number
}

// Apple dates are seconds since 2001-01-01.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
const appleDate = (ms: number) => (ms - APPLE_EPOCH_MS) / 1000

function labelsFromArgs(args: string[]): Record<string, string> {
  const labels: Record<string, string> = {}
  args.forEach((arg, index) => {
    if (arg !== '--label') return
    const [key, ...value] = (args[index + 1] ?? '').split('=')
    labels[key] = value.join('=')
  })
  return labels
}

/**
 * A fake `container` CLI that keeps the behaviors the sandbox races depend on, as measured
 * against container CLI 0.12.3 (2026-09-17 and 2026-09-18): a create for a name the CLI
 * already has fails at once with "already exists"; a container it is still starting lists as
 * `stopped` with no `startedDate` until it runs, with its labels from the first moment it is
 * listed; a container that ran and stopped keeps its `startedDate`; a create whose container is
 * deleted while it starts fails "container with ID … not found"; and an exec in a container
 * deleted under it is killed.
 */
function installRealisticContainerCli(
  options: {
    networkMissing?: boolean
    // Apple's container system is not running until a `system start` (a cold Mac).
    systemStopped?: boolean
    startMsFor?: (name: string) => number
    execMsFor?: (command: string) => number
    // Lets a test play a second process that creates the same thing first.
    beforeCreate?: (kind: 'network' | 'container', name: string, cli: RealisticContainerCli) => void
    // Lets a test play another process acting between two of this process's lists.
    beforeList?: (cli: RealisticContainerCli, listNumber: number) => void
  } = {}
): RealisticContainerCli {
  const cli: RealisticContainerCli = {
    calls: [],
    containers: new Map(),
    startedDates: new Map(),
    labels: new Map(),
    networks: new Set(['default', ...(options.networkMissing ? [] : [NETWORK])]),
    count: (predicate) => cli.calls.filter(predicate).length
  }
  let lists = 0
  let systemRunning = !options.systemStopped
  const startMsFor = options.startMsFor ?? (() => 20)

  __setAppleContainerCommandRunnerForTests(async (_command, args) => {
    cli.calls.push(args)
    const key = args.join(' ')
    if (key === '--version') return makeRun('container CLI version 0.12.3')
    if (key === 'system status') {
      return systemRunning
        ? makeRun('FIELD VALUE\nstatus running\n')
        : makeRun('', 1, 'apiserver is not running and not registered with launchd')
    }
    if (key === 'system start') {
      await sleep(20)
      systemRunning = true
      return makeRun('Verifying apiserver is running...')
    }
    if (!systemRunning) return makeRun('', 1, 'Error: apiserver is not running')
    if (key === 'network list --format json') {
      return makeRun(JSON.stringify([...cli.networks].map((id) => ({ id, state: 'running' }))))
    }
    if (args[0] === 'network' && args[1] === 'create') {
      const id = args.at(-1) ?? ''
      options.beforeCreate?.('network', id, cli)
      if (cli.networks.has(id)) return makeRun('', 1, `Error: network ${id} already exists`)
      cli.networks.add(id)
      await sleep(10)
      return makeRun(id)
    }
    if (key === 'list --format json --all') {
      lists += 1
      options.beforeList?.(cli, lists)
      return makeRun(
        JSON.stringify(
          [...cli.containers].map(([id, status]) => ({
            status,
            startedDate: cli.startedDates.get(id) ?? null,
            configuration: { id, labels: cli.labels.get(id) ?? {} }
          }))
        )
      )
    }
    if (args[0] === 'run' && args.includes('--detach')) {
      const name = args[args.indexOf('--name') + 1]
      options.beforeCreate?.('container', name, cli)
      if (cli.containers.has(name)) {
        return makeRun(
          '',
          1,
          `[0/6] [0s]\n[6/6] Starting container [0s]\nError: failed to create container (cause: "exists: "container already exists: ${name}"")`
        )
      }
      cli.containers.set(name, 'stopped')
      cli.startedDates.set(name, null)
      cli.labels.set(name, labelsFromArgs(args))
      await sleep(startMsFor(name))
      if (cli.containers.get(name) !== 'stopped') {
        return makeRun(
          '',
          1,
          `[6/6] Starting container [0s]\n[6/6] Starting container [1s]\nError: container with ID ${name} not found`
        )
      }
      cli.containers.set(name, 'running')
      cli.startedDates.set(name, appleDate(Date.now()))
      return makeRun(name)
    }
    if (args[0] === 'exec') {
      const name = args[args.length - 4]
      const command = args.at(-1) ?? ''
      const state = cli.containers.get(name)
      if (!state) return makeRun('', 1, `Error: get failed: container ${name} not found`)
      if (state !== 'running') return makeRun('', 1, `Error: container ${name} is not running`)
      await sleep(options.execMsFor?.(command) ?? 0)
      if (!cli.containers.has(name)) return makeRun('', 137, 'killed')
      return makeRun(`ran: ${command}\n`)
    }
    if (args[0] === 'delete') {
      const name = args.at(-1) ?? ''
      if (!cli.containers.delete(name)) {
        return makeRun('', 1, `Error: container with ID ${name} not found`)
      }
      cli.startedDates.delete(name)
      cli.labels.delete(name)
      return makeRun(name)
    }
    if (args[0] === 'stop') return makeRun(args.at(-1) ?? '')
    return makeRun('', 1, `unexpected command: ${key}`)
  })
  return cli
}

const isCreate = (args: string[]) => args[0] === 'run' && args.includes('--detach')
const isContainerList = (args: string[]) => args.join(' ') === 'list --format json --all'
const isDeleteOf = (name: string) => (args: string[]) => args[0] === 'delete' && args.at(-1) === name
const isNetworkCreate = (args: string[]) => args[0] === 'network' && args[1] === 'create'

async function withTempWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-sandbox-race-'))
  try {
    await run(await realpath(tempRoot))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

describe('appleContainerSandbox', () => {
  afterEach(() => {
    __setAppleContainerCommandRunnerForTests(null)
    __setAppleContainerPlatformForTests(null)
    __setAppleContainerExistingStartWaitForTests(null)
  })

  it('reports unsupported on non-mac platforms', async () => {
    __setAppleContainerPlatformForTests('linux')
    const status = await getAppleContainerSandboxStatus()

    expect(status.available).toBe(false)
    expect(status.supported).toBe(false)
    expect(status.backend).toBe('apple_container')
    expect(status.reason).toContain('only supported on macOS')
  })

  // BL-62: a status check (Agent Settings or Admin opening) only looks. It used to start Apple's
  // container system and create the internal network, and nothing stopped them until logout.
  it('status reports a running system without creating the internal network', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli({ networkMissing: true })

    const status = await getAppleContainerSandboxStatus()

    expect(status).toMatchObject({
      available: true,
      installed: true,
      systemRunning: true,
      reason: null,
      network: 'batshit-apple-sandbox-internal'
    })
    expect(cli.calls.map((args) => args.join(' '))).toEqual(['--version', 'system status'])
    expect(cli.networks.has(NETWORK)).toBe(false)
  })

  it('status on a stopped system starts nothing and says it is not started yet', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli({ systemStopped: true, networkMissing: true })

    const status = await getAppleContainerSandboxStatus()

    // Not started is not an error: the first sandboxed command starts it.
    expect(status).toMatchObject({
      available: true,
      installed: true,
      supported: true,
      systemRunning: false,
      reason: null,
      version: 'container CLI version 0.12.3'
    })
    expect(cli.calls.map((args) => args.join(' '))).toEqual(['--version', 'system status'])
  })

  it('status reports a missing CLI as not installed', async () => {
    __setAppleContainerPlatformForTests('darwin')
    installFakeRunner((args) =>
      args.join(' ') === '--version'
        ? makeRun('', 127, 'spawn container ENOENT')
        : makeRun('', 1, `unexpected command: ${args.join(' ')}`)
    )

    const status = await getAppleContainerSandboxStatus()

    expect(status).toMatchObject({ available: false, installed: false, systemRunning: false })
    expect(status.reason).toMatch(/ENOENT/)
  })

  it('status reports a system status check that hangs as unavailable', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const { calls } = installFakeRunner((args) => {
      const key = args.join(' ')
      if (key === '--version') return makeRun('container CLI version 0.12.3')
      if (key === 'system status') return { ...makeRun('', null as unknown as number), timedOut: true }
      return makeRun('', 1, `unexpected command: ${key}`)
    })

    const status = await getAppleContainerSandboxStatus()

    expect(status).toMatchObject({ available: false, installed: true, systemRunning: false })
    expect(status.reason).toBeTruthy()
    expect(calls.map((call) => call.args.join(' '))).not.toContain('system start')
  })

  it('the first sandbox commands after a cold start start the system and network once, then run', async () => {
    __setAppleContainerPlatformForTests('darwin')
    await withTempWorkspace(async (workspaceRoot) => {
      const cli = installRealisticContainerCli({ systemStopped: true, networkMissing: true })

      // Two chats' first calls at once: parallel tool calls must share the one start.
      const results = await Promise.all(
        ['session-cold-a', 'session-cold-b'].map((sessionId) =>
          executeAppleContainerSandboxCommand({
            userId: 'Josh',
            sessionId,
            workspaceRoot,
            cwd: workspaceRoot,
            command: `echo ${sessionId}`,
            timeoutMs: 10_000
          })
        )
      )

      for (const result of results) {
        expect(result.ok, result.ok ? '' : result.reason).toBe(true)
      }
      expect(cli.count((args) => args.join(' ') === 'system start')).toBe(1)
      expect(cli.count(isNetworkCreate)).toBe(1)
      expect(cli.count(isCreate)).toBe(2)
      const order = cli.calls.map((args) => args.join(' '))
      const systemStart = order.indexOf('system start')
      const networkCreate = order.findIndex((key) => key.startsWith('network create'))
      const firstCreate = cli.calls.findIndex(isCreate)
      const firstExec = cli.calls.findIndex((args) => args[0] === 'exec')
      expect(systemStart).toBeGreaterThan(-1)
      expect(systemStart).toBeLessThan(networkCreate)
      expect(networkCreate).toBeLessThan(firstCreate)
      expect(firstCreate).toBeLessThan(firstExec)
    })
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

  it('hands a Stop to the command and never to the sandbox start (2026-09-18)', async () => {
    // A start cut in half could leave a sandbox the chat cannot use; the command's own runner
    // skips a command whose Stop landed while its sandbox started.
    __setAppleContainerPlatformForTests('darwin')
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-sandbox-stop-'))
    const workspaceRoot = await realpath(tempRoot)
    const stop = new AbortController()
    const seen: Array<{ args: string[]; abortSignal: AbortSignal | undefined }> = []

    try {
      __setAppleContainerCommandRunnerForTests(async (_command, args, options) => {
        seen.push({ args, abortSignal: options?.abortSignal })
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
        if (key === 'network list --format json') {
          return makeRun(JSON.stringify([{ id: 'batshit-apple-sandbox-internal', state: 'running' }]))
        }
        if (key === 'list --format json --all') return makeRun('[]')
        if (args[0] === 'run' && args.includes('--detach')) return makeRun(args.at(-1) ?? '')
        if (args[0] === 'exec') return { ...makeRun(''), exitCode: null, stopped: true }
        return makeRun('', 1, `unexpected command: ${key}`)
      })

      const result = await executeAppleContainerSandboxCommand({
        userId: 'Josh',
        sessionId: 'session-apple-stop',
        workspaceRoot,
        cwd: workspaceRoot,
        command: 'sleep 20',
        timeoutMs: 10_000,
        abortSignal: stop.signal
      })

      expect(result.ok && result.run.stopped).toBe(true)
      const execs = seen.filter((call) => call.args[0] === 'exec')
      expect(execs).toHaveLength(1)
      expect(execs[0].abortSignal).toBe(stop.signal)
      expect(seen.filter((call) => call.args[0] !== 'exec').map((call) => call.abortSignal)).toEqual(
        seen.filter((call) => call.args[0] !== 'exec').map(() => undefined)
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  // A Stop or timeout ends what the command started inside the sandbox too (2026-09-18).
  // Measured with container CLI 0.12.3: `container exec` passes SIGTERM to the top shell only,
  // so for `bash -lc 'sleep 61 & sleep 62'` both sleeps ran on after the shell died.
  it('tags each command, and ends what carries its tag with one short command in the same sandbox', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-sandbox-end-'))
    const workspaceRoot = await realpath(tempRoot)
    const seen: Array<{
      args: string[]
      timeoutMs?: number
      abortSignal?: AbortSignal
      endInside?: () => Promise<void>
    }> = []

    try {
      __setAppleContainerCommandRunnerForTests(async (_command, args, options) => {
        seen.push({ args, ...options })
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
        if (key === 'network list --format json') {
          return makeRun(JSON.stringify([{ id: 'batshit-apple-sandbox-internal', state: 'running' }]))
        }
        if (key === 'list --format json --all') return makeRun('[]')
        if (args[0] === 'run' && args.includes('--detach')) return makeRun(args.at(-1) ?? '')
        if (args[0] === 'exec' && args.includes('batshit-command-end')) {
          return makeRun('batshit-command-end: 2 ended\n')
        }
        if (args[0] === 'exec') {
          // The runner ends what the command started when a Stop or timeout ends it.
          await options?.endInside?.()
          return { ...makeRun(''), exitCode: null, stopped: true }
        }
        return makeRun('', 1, `unexpected command: ${key}`)
      })

      const result = await executeAppleContainerSandboxCommand({
        userId: 'Josh',
        sessionId: 'session-apple-end',
        workspaceRoot,
        cwd: workspaceRoot,
        command: 'sleep 61 & sleep 62',
        timeoutMs: 10_000,
        env: { A: 'one', BATSHIT_COMMAND_ID: 'forged' },
        abortSignal: new AbortController().signal
      })

      expect(result.ok && result.run.stopped).toBe(true)
      const [exec, end, ...more] = seen.filter((call) => call.args[0] === 'exec')
      expect(more).toEqual([])
      const name = result.ok ? result.sandboxName : ''
      const tagArg = exec.args[exec.args.indexOf(name) - 1]
      // The tag is the last env entry and the only one, so a caller's env cannot replace it.
      expect(exec.args[exec.args.indexOf(name) - 2]).toBe('--env')
      expect(tagArg).toMatch(/^BATSHIT_COMMAND_ID=[A-Za-z0-9-]{16,}$/)
      expect(exec.args.filter((arg) => arg.startsWith('BATSHIT_COMMAND_ID='))).toEqual([tagArg])
      expect(exec.args).toContain('A=one')
      expect(exec.endInside).toBeTypeOf('function')
      expect(end.args).toEqual(['exec', name, ...sandboxCommandEndArgv(tagArg.split('=')[1])])
      // The end command itself is never stopped, and has its own short limit.
      expect(end.abortSignal).toBeUndefined()
      expect(end.endInside).toBeUndefined()
      expect(end.timeoutMs).toBe(SANDBOX_COMMAND_END_TIMEOUT_MS)
      // Only the command gets an end: never a sandbox start, list, or removal.
      expect(seen.filter((call) => call.args[0] !== 'exec').every((call) => !call.endInside)).toBe(true)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('says so when the end fails in a sandbox that still runs, and not when the sandbox is gone', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-sandbox-end-fail-'))
    const workspaceRoot = await realpath(tempRoot)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runOnce = async (sandboxAfterEnd: 'running' | 'gone') => {
      let name = ''
      __setAppleContainerCommandRunnerForTests(async (_command, args, options) => {
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
        if (key === 'network list --format json') {
          return makeRun(JSON.stringify([{ id: 'batshit-apple-sandbox-internal', state: 'running' }]))
        }
        if (key === 'list --format json --all') {
          return makeRun(
            name && sandboxAfterEnd === 'running'
              ? JSON.stringify([{ status: 'running', configuration: { id: name } }])
              : '[]'
          )
        }
        if (args[0] === 'run' && args.includes('--detach')) {
          name = args[args.indexOf('--name') + 1]
          return makeRun(name)
        }
        // The end is cut off with no words, as when its sandbox goes under it.
        if (args[0] === 'exec' && args.includes('batshit-command-end')) return makeRun('', 137, '')
        if (args[0] === 'exec') {
          await options?.endInside?.()
          return { ...makeRun(''), exitCode: null, stopped: true }
        }
        return makeRun('', 1, `unexpected command: ${key}`)
      })
      return await executeAppleContainerSandboxCommand({
        userId: 'Josh',
        sessionId: `session-apple-end-fail-${sandboxAfterEnd}`,
        workspaceRoot,
        cwd: workspaceRoot,
        command: 'sleep 61 & sleep 62',
        timeoutMs: 10_000
      })
    }

    try {
      await runOnce('gone')
      expect(warn).not.toHaveBeenCalled()

      await runOnce('running')
      expect(warn).toHaveBeenCalledWith(
        '[Apple Container] Could not end what a stopped command started:',
        expect.objectContaining({ reason: 'Ending the command exited 137.' })
      )
    } finally {
      warn.mockRestore()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  describe('the command runner, on a Stop or a timeout', () => {
    it('waits for the end inside the sandbox before it answers a Stop', async () => {
      const stop = new AbortController()
      setTimeout(() => stop.abort('user'), 150)
      let ends = 0
      const started = Date.now()

      // `sleep` stands in for `container exec`.
      const run = await __runAppleContainerCommandForTests('sleep', ['5'], {
        timeoutMs: 10_000,
        abortSignal: stop.signal,
        endInside: async () => {
          ends += 1
          await sleep(300)
        }
      })

      expect(run).toMatchObject({ stopped: true, timedOut: false })
      expect(ends).toBe(1)
      expect(Date.now() - started).toBeGreaterThanOrEqual(430)
      expect(Date.now() - started).toBeLessThan(1_500)
    })

    it('ends inside the sandbox on a timeout the same way', async () => {
      let ends = 0
      const run = await __runAppleContainerCommandForTests('sleep', ['5'], {
        timeoutMs: 200,
        endInside: async () => {
          ends += 1
        }
      })

      expect(run).toMatchObject({ timedOut: true })
      expect(ends).toBe(1)
    })

    it('needs no end for a command that finishes by itself', async () => {
      let ends = 0
      // `true`, not `sh -c 'exit 0'`: CodeQL reads a shell run through this launcher in any file as
      // the product running one, and flags every sandbox setting it passes (public PR 114).
      const run = await __runAppleContainerCommandForTests('true', [], {
        timeoutMs: 10_000,
        abortSignal: new AbortController().signal,
        endInside: async () => {
          ends += 1
        }
      })

      expect(run).toMatchObject({ exitCode: 0, timedOut: false })
      expect(run.stopped).toBeUndefined()
      expect(ends).toBe(0)
    })
  })

  // F-P5-1: the API lane runs one step's bash calls in parallel, so a chat's first calls
  // all find its sandbox missing at the same moment.
  describe('parallel first calls', () => {
    it('creates a chat sandbox once and runs every parallel first command in it', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      const sessionId = 'session-parallel-first-calls'
      const commands = ['cat package.json', 'git log --oneline -5', 'ls docs', 'pwd', 'whoami']

      await withTempWorkspace(async (workspaceRoot) => {
        const results = await Promise.all(
          commands.map((command) =>
            executeAppleContainerSandboxCommand({
              userId: 'Josh',
              sessionId,
              workspaceRoot,
              cwd: workspaceRoot,
              command,
              timeoutMs: 10_000
            })
          )
        )
        const sandboxName = buildAppleContainerSandboxName({ userId: 'Josh', workspaceRoot, sessionId })

        expect(results.map((result) => (result.ok ? result.run.stdout : result.reason))).toEqual(
          commands.map((command) => `ran: ${command}\n`)
        )
        expect(results.every((result) => result.ok && result.run.exitCode === 0)).toBe(true)
        expect(cli.count(isCreate)).toBe(1)
        // One shared start, not five queued ones that each check again.
        expect(cli.count(isContainerList)).toBe(1)
        expect(cli.count((args) => args[0] === 'delete')).toBe(0)
        expect([...cli.containers]).toEqual([[sandboxName, 'running']])
      })
    })

    it('shares one internal network create between two chats starting at once', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli({ networkMissing: true })

      await withTempWorkspace(async (workspaceRoot) => {
        const results = await Promise.all(
          ['session-one', 'session-two'].map((sessionId) =>
            executeAppleContainerSandboxCommand({
              userId: 'Josh',
              sessionId,
              workspaceRoot,
              cwd: workspaceRoot,
              command: 'pwd',
              timeoutMs: 10_000
            })
          )
        )

        expect(results.map((result) => result.ok)).toEqual([true, true])
        expect(cli.count(isNetworkCreate)).toBe(1)
        expect(cli.count(isCreate)).toBe(2)
      })
    })

    it('uses the internal network when another process created it first', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli({
        networkMissing: true,
        beforeCreate: (kind, name, state) => {
          if (kind === 'network') state.networks.add(name)
        }
      })

      await withTempWorkspace(async (workspaceRoot) => {
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-network-elsewhere',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'pwd',
          timeoutMs: 10_000
        })

        expect(result.ok).toBe(true)
        expect(cli.count(isNetworkCreate)).toBe(1)
      })
    })

    it('reuses a sandbox another process created between the list and the create', async () => {
      __setAppleContainerPlatformForTests('darwin')
      __setAppleContainerExistingStartWaitForTests({ timeoutMs: 2_000, pollMs: 5 })
      const cli = installRealisticContainerCli({
        beforeCreate: (kind, name, state) => {
          if (kind !== 'container' || state.containers.has(name)) return
          state.containers.set(name, 'stopped')
          setTimeout(() => state.containers.set(name, 'running'), 30)
        }
      })

      await withTempWorkspace(async (workspaceRoot) => {
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-created-elsewhere',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'pwd',
          timeoutMs: 10_000
        })

        expect(result.ok ? result.run.stdout : result.reason).toBe('ran: pwd\n')
        expect(cli.count(isCreate)).toBe(1)
        expect(cli.count((args) => args[0] === 'delete')).toBe(0)
      })
    })

    it('fails visibly when a sandbox that already exists never starts', async () => {
      __setAppleContainerPlatformForTests('darwin')
      __setAppleContainerExistingStartWaitForTests({ timeoutMs: 40, pollMs: 5 })
      const cli = installRealisticContainerCli({
        beforeCreate: (kind, name, state) => {
          if (kind === 'container') state.containers.set(name, 'stopped')
        }
      })

      await withTempWorkspace(async (workspaceRoot) => {
        const sessionId = 'session-never-starts'
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId,
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'pwd',
          timeoutMs: 10_000
        })

        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.sandboxName).toBe(
            buildAppleContainerSandboxName({ userId: 'Josh', workspaceRoot, sessionId })
          )
          expect(result.reason).toContain('already exists but is still stopped after 40 ms')
          expect(result.reason).toContain('container already exists')
        }
        expect(cli.count((args) => args[0] === 'exec')).toBe(0)
      })
    })

    it('does not prune a sandbox another chat is still starting', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const sessionId = 'session-slow-start'
      let slowSandboxName = ''
      const cli = installRealisticContainerCli({
        startMsFor: (name) => (name === slowSandboxName ? 150 : 5)
      })

      await withTempWorkspace(async (workspaceRoot) => {
        slowSandboxName = buildAppleContainerSandboxName({ userId: 'Josh', workspaceRoot, sessionId })
        const chatCall = executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId,
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'git status',
          timeoutMs: 10_000
        })
        // A one-shot call ends and prunes stopped sandboxes while the chat's sandbox,
        // listed as `stopped`, is still starting.
        await sleep(20)
        const oneShot = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'pwd',
          timeoutMs: 10_000
        })
        const chatResult = await chatCall

        expect(oneShot.ok).toBe(true)
        expect(chatResult.ok ? chatResult.run.stdout : chatResult.reason).toBe('ran: git status\n')
        expect(cli.count(isDeleteOf(slowSandboxName))).toBe(0)
        expect([...cli.containers]).toEqual([[slowSandboxName, 'running']])
      })
    })

    it('keeps a shared one-shot sandbox until the last command in it ends', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli({
        execMsFor: (command) => (command === 'slow build' ? 60 : 0)
      })

      await withTempWorkspace(async (workspaceRoot) => {
        const sandboxName = buildAppleContainerSandboxName({ userId: 'Josh', workspaceRoot })
        const [slow, fast] = await Promise.all(
          ['slow build', 'pwd'].map((command) =>
            executeAppleContainerSandboxCommand({
              userId: 'Josh',
              workspaceRoot,
              cwd: workspaceRoot,
              command,
              timeoutMs: 10_000
            })
          )
        )

        expect(fast.ok ? fast.run.stdout : fast.reason).toBe('ran: pwd\n')
        expect(slow.ok ? slow.run.stdout : slow.reason).toBe('ran: slow build\n')
        expect(slow.ok && slow.run.exitCode).toBe(0)
        expect(cli.count(isCreate)).toBe(1)
        expect(cli.count(isDeleteOf(sandboxName))).toBe(1)
        expect(cli.containers.size).toBe(0)
      })
    })

    it('removes the chat sandbox at run end even while an abandoned command still runs', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli({
        execMsFor: (command) => (command === 'sleep 600' ? 80 : 0)
      })

      await withTempWorkspace(async (workspaceRoot) => {
        const sessionId = 'session-stopped-mid-command'
        const sandboxName = buildAppleContainerSandboxName({ userId: 'Josh', workspaceRoot, sessionId })
        const abandoned = executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId,
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'sleep 600',
          timeoutMs: 10_000
        })
        await sleep(40)
        const warnings = await cleanupAppleContainerSandboxesForSession(sessionId)
        const result = await abandoned

        expect(warnings).toEqual([])
        expect(cli.count(isDeleteOf(sandboxName))).toBe(1)
        expect(result.ok && result.run.exitCode).toBe(137)
      })
    })
  })

  // 2026-09-18 (found in passing during fp65g): every chat turn's cleanup, in EVERY Batshit
  // process on the Mac, pruned each stopped Batshit sandbox. Apple lists a sandbox that is still
  // starting as `stopped` with no start time, and one process's gate cannot see another's
  // starts, so a chat turn in one Batshit deleted the sandbox another Batshit was starting
  // (`container with ID … not found`, seen live and reproduced with the real CLI).
  describe('the prune across Batshit processes', () => {
    // A chat sandbox another Batshit process on the same Mac owns.
    const OTHER_SANDBOX = 'batshit-apple-sandbox-josh-s1a2b3c4d-0f1e2d3c4b'
    const CREATED_AT = 'batshit.created-at'

    function otherSandbox(
      cli: RealisticContainerCli,
      state: { startedDate: number | null; labels: Record<string, string> }
    ) {
      cli.containers.set(OTHER_SANDBOX, 'stopped')
      cli.startedDates.set(OTHER_SANDBOX, state.startedDate)
      cli.labels.set(OTHER_SANDBOX, state.labels)
    }

    it.each([
      { label: 'stamped by a current Batshit', labels: () => ({ [CREATED_AT]: String(Date.now()) }) },
      { label: 'from an older Batshit, with no stamp', labels: () => ({}) }
    ])('keeps a sandbox another process is starting ($label)', async ({ labels }) => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      otherSandbox(cli, { startedDate: null, labels: labels() })

      const warnings = await cleanupAppleContainerSandboxesForSession('session-this-process')

      expect(warnings).toEqual([])
      expect(cli.count(isDeleteOf(OTHER_SANDBOX))).toBe(0)
      expect(cli.containers.get(OTHER_SANDBOX)).toBe('stopped')
      // The prune's own list decides; a sandbox still starting costs no second look.
      expect(cli.count(isContainerList)).toBe(2)
    })

    it('never removes a sandbox another process is running', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      otherSandbox(cli, { startedDate: appleDate(Date.now() - 60 * 60_000), labels: {} })
      cli.containers.set(OTHER_SANDBOX, 'running')

      await cleanupAppleContainerSandboxesForSession('session-this-process')

      expect(cli.count(isDeleteOf(OTHER_SANDBOX))).toBe(0)
      expect(cli.containers.get(OTHER_SANDBOX)).toBe('running')
    })

    it('still removes a sandbox that ran and stopped, as a Mac restart leaves them', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      otherSandbox(cli, { startedDate: appleDate(Date.now() - 5 * 60_000), labels: {} })

      const warnings = await cleanupAppleContainerSandboxesForSession('session-this-process')

      expect(warnings).toEqual([])
      expect(cli.count(isDeleteOf(OTHER_SANDBOX))).toBe(1)
      expect(cli.containers.has(OTHER_SANDBOX)).toBe(false)
    })

    // A start never takes ten minutes (the create itself times out after 90 s).
    it.each([
      { ageMs: 601_000, removed: true },
      { ageMs: 599_000, removed: false }
    ])('removes a stamped sandbox that never started only once it is ten minutes old ($ageMs ms old: removed $removed)', async ({ ageMs, removed }) => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      otherSandbox(cli, { startedDate: null, labels: { [CREATED_AT]: String(Date.now() - ageMs) } })

      await cleanupAppleContainerSandboxesForSession('session-this-process')

      expect(cli.count(isDeleteOf(OTHER_SANDBOX))).toBe(removed ? 1 : 0)
    })

    it('checks again before it removes, and keeps a sandbox started anew in between', async () => {
      __setAppleContainerPlatformForTests('darwin')
      // The cleanup lists once for its own session and once to prune, and the prune lists
      // again inside the gate before each removal. Before that third list, another process
      // replaces the dead sandbox with a new one of the same name that is still starting.
      const cli = installRealisticContainerCli({
        beforeList: (state, listNumber) => {
          if (listNumber === 3) otherSandbox(state, { startedDate: null, labels: { [CREATED_AT]: String(Date.now()) } })
        }
      })
      otherSandbox(cli, { startedDate: appleDate(Date.now() - 5 * 60_000), labels: {} })

      await cleanupAppleContainerSandboxesForSession('session-this-process')

      expect(cli.count(isContainerList)).toBe(3)
      expect(cli.count(isDeleteOf(OTHER_SANDBOX))).toBe(0)
    })

    it('stamps each sandbox it creates with the time it asked for it', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()

      await withTempWorkspace(async (workspaceRoot) => {
        const before = Date.now()
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-stamped',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'pwd',
          timeoutMs: 10_000
        })
        const createArgs = cli.calls.find(isCreate) ?? []
        const stamp = Number(labelsFromArgs(createArgs)[CREATED_AT])

        expect(result.ok).toBe(true)
        expect(stamp).toBeGreaterThanOrEqual(before)
        expect(stamp).toBeLessThanOrEqual(Date.now())
      })
    })
  })
})
