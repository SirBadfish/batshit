import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  __runAppleContainerCommandForTests,
  __setAppleContainerCommandRunnerForTests,
  __setAppleContainerExistingStartWaitForTests,
  __setAppleContainerBatshitHomeMountRootForTests,
  __setAppleContainerPlatformForTests,
  buildAppleContainerSandboxName,
  cleanupAppleContainerSandboxesForSession,
  executeAppleContainerSandboxCommand,
  getAppleContainerSandboxStatus,
  recoverAppleContainerSandbox
} from '../appleContainerSandbox'
import { SANDBOX_COMMAND_END_TIMEOUT_MS, sandboxCommandEndArgv } from '../commandEnd'
import { createCommandModelCapture, getCommandModelCapture, MAX_COMMAND_MODEL_CAPTURE_CHARS } from '../commandModelCapture'

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
    // A fresh Apple Container install: no default Linux kernel (BL-129).
    noKernel?: boolean
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
    // Batshit never lets `system start` ask for a kernel on stdin (BL-129): a start without
    // `--disable-kernel-install` is an unexpected command here.
    if (key === 'system start --disable-kernel-install') {
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
      if (options.noKernel) {
        return makeRun(
          '',
          1,
          '[0/6] [0s]\n[3/6] Fetching kernel [0s]\nError: notFound: "default kernel not found at /Users/x/Library/Application Support/com.apple.container/kernels/default.kernel-arm64"'
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

// BL-62 part 2: a `system start` this module makes writes a record so quitting Batshit can stop the
// system again. Every test here gets its own record folder: none may write into the real ~/.batshit.
const RECORD_ENV_KEYS = ['BATSHIT_APPLE_CONTAINER_STATE_DIR', 'BATSHIT_VOICE_RUNTIME_OWNER', 'PATH'] as const
let recordDir = ''
let mountDir = ''
const savedRecordEnv: Record<string, string | undefined> = {}

describe('appleContainerSandbox', () => {
  beforeEach(async () => {
    for (const key of RECORD_ENV_KEYS) savedRecordEnv[key] = process.env[key]
    recordDir = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-container-record-'))
    mountDir = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-container-mount-'))
    __setAppleContainerBatshitHomeMountRootForTests(path.join(await realpath(mountDir), '.batshit'))
    process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = recordDir
    process.env.BATSHIT_VOICE_RUNTIME_OWNER = 'mac-app:/tmp/batshit-test-data'
  })

  afterEach(async () => {
    __setAppleContainerCommandRunnerForTests(null)
    __setAppleContainerPlatformForTests(null)
    __setAppleContainerExistingStartWaitForTests(null)
    __setAppleContainerBatshitHomeMountRootForTests(null)
    for (const key of RECORD_ENV_KEYS) {
      if (savedRecordEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedRecordEnv[key]
    }
    await rm(recordDir, { recursive: true, force: true })
    await rm(mountDir, { recursive: true, force: true })
  })

  it('uses a new sandbox identity after changing the managed-home mount policy', () => {
    const workspaceRoot = '/Users/example/project'
    const oldHash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 10)
    const name = buildAppleContainerSandboxName({ workspaceRoot })
    expect(name).toContain('-m4-')
    expect(name.endsWith(oldHash)).toBe(false)
    // BL-1277: an m3 container may have been made for a folder that is protected now.
    expect(name).not.toContain('-m3-')
  })

  it('reports unsupported on non-mac platforms', async () => {
    __setAppleContainerPlatformForTests('linux')
    const status = await getAppleContainerSandboxStatus()

    expect(status.available).toBe(false)
    expect(status.supported).toBe(false)
    // It cannot be installed off macOS (it read `installed: true`).
    expect(status.installed).toBe(false)
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
      // What the real runner answers when `container` is not on PATH.
      args.join(' ') === '--version'
        ? { ...makeRun('', 1, 'spawn container ENOENT'), notFound: true }
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
    // BL-146: it read "Apple Container system status timed out. timed out.". These are the words
    // Runtime Doctor uses for the same answer (`classifyAppleContainerStatus`).
    expect(status.reason).toBe('`container system status` did not answer in time.')
    expect(calls.map((call) => call.args[1])).not.toContain('start')
  })

  // BL-146, the same class: every other call that timed out read "<what failed>. timed out.".
  it('a call that does not answer is named once, in a whole sentence', async () => {
    __setAppleContainerPlatformForTests('darwin')
    installFakeRunner((args) => {
      const key = args.join(' ')
      if (key === '--version') return makeRun('container CLI version 0.12.3')
      if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
      if (key === 'list --format json --all') return { ...makeRun('', null as unknown as number), timedOut: true }
      return makeRun('', 1, `unexpected command: ${key}`)
    })

    const warnings = await cleanupAppleContainerSandboxesForSession('session-list-hangs')

    expect(warnings).toEqual(['Failed to list Apple containers. The `container` command did not answer in time.'])
  })

  // BL-151: every chat turn runs this cleanup, whichever sandbox the agent uses, so where Apple
  // Container cannot exist it warned on every turn: "only supported on macOS" on Docker and Linux,
  // "spawn container ENOENT" on a Mac without it.
  describe('run-end cleanup where Apple Container is not installed (BL-151)', () => {
    it('is a quiet no-op off macOS, and runs nothing', async () => {
      __setAppleContainerPlatformForTests('linux')
      const { calls } = installFakeRunner(() => makeRun('', 1, 'nothing may run off macOS'))

      expect(await cleanupAppleContainerSandboxesForSession('session-linux')).toEqual([])
      expect(calls).toEqual([])
    })

    it('is a quiet no-op on a Mac with no `container` CLI (the real runner, an empty PATH)', async () => {
      __setAppleContainerPlatformForTests('darwin')
      process.env.PATH = path.join(recordDir, 'no-container-here')

      expect(await cleanupAppleContainerSandboxesForSession('session-no-cli')).toEqual([])
      // Status still says what is missing.
      const status = await getAppleContainerSandboxStatus()
      expect(status).toMatchObject({ available: false, installed: false })
      expect(status.reason).toMatch(/ENOENT/)
    })

    it('still warns when the CLI is there but broken', async () => {
      __setAppleContainerPlatformForTests('darwin')
      installFakeRunner((args) =>
        args.join(' ') === '--version'
          ? makeRun('', 134, 'dyld[123]: Library not loaded: @rpath/ContainerClient.framework')
          : makeRun('', 1, `unexpected command: ${args.join(' ')}`)
      )

      const warnings = await cleanupAppleContainerSandboxesForSession('session-broken-cli')

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/Library not loaded/)
    })
  })

  describe('the Apple Container system a sandboxed command started (BL-62 part 2)', () => {
    const RECORD = '.batshit-apple-container-system.json'
    const readRecord = async () => JSON.parse(await readFile(path.join(recordDir, RECORD), 'utf8'))

    it('records the one cold start two first calls share: which Batshit, when, and the container on PATH', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const bin = path.join(recordDir, 'bin')
      await mkdir(bin)
      await writeFile(path.join(bin, 'container'), '#!/bin/sh\nexit 0\n')
      await chmod(path.join(bin, 'container'), 0o755)
      process.env.PATH = `${path.join(recordDir, 'nothing-here')}${path.delimiter}${bin}`
      await withTempWorkspace(async (workspaceRoot) => {
        const cli = installRealisticContainerCli({ systemStopped: true })
        const before = Date.now()
        const results = await Promise.all(
          ['session-rec-a', 'session-rec-b'].map((sessionId) =>
            executeAppleContainerSandboxCommand({
              userId: 'Josh',
              sessionId,
              workspaceRoot,
              cwd: workspaceRoot,
              command: 'true',
              timeoutMs: 10_000
            })
          )
        )
        const after = Date.now()

        for (const result of results) expect(result.ok, result.ok ? '' : result.reason).toBe(true)
        expect(cli.count((args) => args.join(' ') === 'system start --disable-kernel-install')).toBe(1)
        expect(await readdir(recordDir)).toEqual(expect.arrayContaining([RECORD]))
        const record = await readRecord()
        expect(record).toEqual({
          launchedBy: 'mac-app:/tmp/batshit-test-data',
          callStartedAt: expect.any(String),
          callEndedAt: expect.any(String),
          containerPath: path.join(bin, 'container')
        })
        const [started, ended] = [Date.parse(record.callStartedAt), Date.parse(record.callEndedAt)]
        expect(started).toBeGreaterThanOrEqual(before)
        // The fake `system start` takes 20 ms; the window is that call's, not the whole command's.
        expect(ended - started).toBeGreaterThanOrEqual(15)
        expect(ended).toBeLessThanOrEqual(after)
      })
    })

    it('records nothing when the system already runs: that start was someone else\'s', async () => {
      __setAppleContainerPlatformForTests('darwin')
      await withTempWorkspace(async (workspaceRoot) => {
        const cli = installRealisticContainerCli()
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-rec-warm',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })
        expect(result.ok).toBe(true)
        expect(cli.count((args) => args.join(' ') === 'system start --disable-kernel-install')).toBe(0)
        expect(await readdir(recordDir)).toEqual([])
      })
    })

    it('records nothing for a status check, a run-end cleanup, or a start that failed', async () => {
      __setAppleContainerPlatformForTests('darwin')
      installRealisticContainerCli({ systemStopped: true })
      await getAppleContainerSandboxStatus()
      await cleanupAppleContainerSandboxesForSession('session-rec-cleanup')
      expect(await readdir(recordDir)).toEqual([])

      await withTempWorkspace(async (workspaceRoot) => {
        installFakeRunner((args) => {
          const key = args.join(' ')
          if (key === '--version') return makeRun('container CLI version 0.12.3')
          if (key === 'system status') return makeRun('', 1, 'apiserver is not running and not registered with launchd')
          if (key === 'system start --disable-kernel-install') return makeRun('', 1, 'Error: failed to get a response from apiserver')
          return makeRun('', 1, `unexpected command: ${key}`)
        })
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-rec-failed',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })
        expect(result.ok).toBe(false)
        expect(await readdir(recordDir)).toEqual([])
      })
    })

    it('a record that cannot be written leaves the sandbox running, and says so', async () => {
      __setAppleContainerPlatformForTests('darwin')
      // The record folder sits under a regular file, so it cannot be made.
      await writeFile(path.join(recordDir, 'not-a-folder'), '')
      process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = path.join(recordDir, 'not-a-folder', 'state')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await withTempWorkspace(async (workspaceRoot) => {
          installRealisticContainerCli({ systemStopped: true })
          const result = await executeAppleContainerSandboxCommand({
            userId: 'Josh',
            sessionId: 'session-rec-unwritable',
            workspaceRoot,
            cwd: workspaceRoot,
            command: 'true',
            timeoutMs: 10_000
          })
          expect(result.ok, result.ok ? '' : result.reason).toBe(true)
        })
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Could not record the Apple Container system this call started'),
          expect.anything()
        )
      } finally {
        warn.mockRestore()
      }
    })
  })

  // BL-129: with no default Linux kernel, Apple's `system start` asks on stdin whether to install one;
  // Batshit gives it no input, so 0.12.3 failed "failed to read user input" after registering the
  // apiserver, the start still read as running, and every sandbox create then failed with Apple's
  // "default kernel not found". Batshit now never lets it ask (`--disable-kernel-install`, in every
  // release since 0.1.0) and names the one command that installs the kernel.
  describe('a Mac with no Linux kernel for Apple Container (BL-129)', () => {
    const KERNEL_STEP = /Apple Container has no Linux kernel yet[\s\S]*`container system kernel set --recommended`[\s\S]*about 600 MB[\s\S]*https:\/\/docs\.batshit\.ai\/installation\/install-mac-app\/#apple-container-has-no-linux-kernel-yet/

    it('starts the system without letting it ask for a kernel, and names the command when a create finds none', async () => {
      __setAppleContainerPlatformForTests('darwin')
      await withTempWorkspace(async (workspaceRoot) => {
        const cli = installRealisticContainerCli({ systemStopped: true, noKernel: true })
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-no-kernel',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })

        expect(cli.calls.filter((args) => args[0] === 'system' && args[1] === 'start')).toEqual([
          ['system', 'start', '--disable-kernel-install']
        ])
        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.reason).toMatch(KERNEL_STEP)
        // The start was this Batshit's, so quitting stops it again.
        expect(await readdir(recordDir)).toEqual(['.batshit-apple-container-system.json'])
      })
    })

    it('a start that still asked for a kernel is not a success, whatever the status says after', async () => {
      __setAppleContainerPlatformForTests('darwin')
      await withTempWorkspace(async (workspaceRoot) => {
        let running = false
        const { calls } = installFakeRunner((args) => {
          const key = args.join(' ')
          if (key === '--version') return makeRun('container CLI version 0.12.3')
          if (key === 'system status') {
            return running ? makeRun('FIELD VALUE\nstatus running\n') : makeRun('', 1, 'apiserver is not running and not registered with launchd')
          }
          if (key === 'system start --disable-kernel-install') {
            // 0.12.3 registers and pings the apiserver before it asks.
            running = true
            return makeRun(
              'Verifying apiserver is running...\nNo default kernel configured.\nInstall the recommended default kernel from [https://github.com/kata-containers/kata-containers/releases/download/3.28.0/kata-static-3.28.0-arm64.tar.zst]? [Y/n]: ',
              1,
              'Error: internalError: "failed to read user input"'
            )
          }
          return makeRun('', 1, `unexpected command: ${key}`)
        })
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-kernel-prompt',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })

        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.reason).toMatch(KERNEL_STEP)
        expect(calls.some((call) => call.args[0] === 'network' || call.args[0] === 'run')).toBe(false)
        // The running registration is still this Batshit's call's, so its quit stops it.
        expect(await readdir(recordDir)).toEqual(['.batshit-apple-container-system.json'])
      })
    })

    it('any other create failure keeps Apple\'s own words', async () => {
      __setAppleContainerPlatformForTests('darwin')
      await withTempWorkspace(async (workspaceRoot) => {
        installFakeRunner((args) => {
          const key = args.join(' ')
          if (key === '--version') return makeRun('container CLI version 0.12.3')
          if (key === 'system status') return makeRun('FIELD VALUE\nstatus running\n')
          if (key === 'network list --format json') return makeRun(JSON.stringify([{ id: NETWORK, state: 'running' }]))
          if (key === 'list --format json --all') return makeRun('[]')
          if (args[0] === 'run') return makeRun('', 1, 'Error: notFound: "image bash:5.2 not found"')
          return makeRun('', 1, `unexpected command: ${key}`)
        })
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-other-create-failure',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })

        expect(result.ok ? '' : result.reason).toBe('Error: notFound: "image bash:5.2 not found"')
      })
    })
  })

  // BL-149: a quit in the middle of a run never gets that run's cleanup, and the prune removes only
  // dead sandboxes, so the sandbox ran on (and kept Apple's container system up) until the chat's
  // next turn. Every sandbox now carries the Batshit that made it, and that Batshit's quit removes
  // its own (`batshit-mac/scripts/apple-container-system-stop.mjs`, which this label twins).
  describe('the owner label every sandbox carries (BL-149)', () => {
    type QuitTwin = {
      APPLE_CONTAINER_OWNER_LABEL: string
      appleContainerSandboxesOwnedBy: (stdout: string, owner: string | null) => string[]
    }
    const quitTwin = () =>
      createRequire(import.meta.url)(
        path.resolve(process.cwd(), '../batshit-mac/scripts/apple-container-system-stop.mjs')
      ) as QuitTwin
    const listedAs = (name: string, labels: Record<string, string>) =>
      JSON.stringify([{ status: 'running', startedDate: 1, configuration: { id: name, labels } }])

    it('labels a chat sandbox with its Batshit, in the form that Batshit\'s quit finds', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      await withTempWorkspace(async (workspaceRoot) => {
        const result = await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-owned',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })
        expect(result.ok, result.ok ? '' : result.reason).toBe(true)
        const name = result.ok ? result.sandboxName : ''
        const labels = labelsFromArgs(cli.calls.find(isCreate) ?? [])
        const twin = quitTwin()

        expect(twin.APPLE_CONTAINER_OWNER_LABEL).toBe('batshit.owner')
        expect(labels['batshit.owner']).toMatch(/^[0-9a-f]{16}$/)
        expect(twin.appleContainerSandboxesOwnedBy(listedAs(name, labels), 'mac-app:/tmp/batshit-test-data')).toEqual([name])
        expect(twin.appleContainerSandboxesOwnedBy(listedAs(name, labels), 'native:4242:1758459739000')).toEqual([])
      })
    })

    it('labels the sandbox Admin\'s Start (recover) leaves running', async () => {
      __setAppleContainerPlatformForTests('darwin')
      const cli = installRealisticContainerCli()
      await withTempWorkspace(async (workspaceRoot) => {
        const recovered = await recoverAppleContainerSandbox({ userId: 'Josh', workspaceRoot, cwd: workspaceRoot })
        const labels = labelsFromArgs(cli.calls.find(isCreate) ?? [])

        expect(quitTwin().appleContainerSandboxesOwnedBy(listedAs(recovered.sandboxName, labels), 'mac-app:/tmp/batshit-test-data')).toEqual([
          recovered.sandboxName
        ])
      })
    })

    // Apple's CLI splits a label on `=` and rejects a third part (0.12.3 `Parser.labels`), so an
    // owner written as it is would fail every create for a data folder whose path holds `=`.
    it('writes an owner whose words Apple would reject as a plain digest', async () => {
      __setAppleContainerPlatformForTests('darwin')
      process.env.BATSHIT_VOICE_RUNTIME_OWNER = 'mac-app:/Users/a=b/Library/Application Support/Batshit'
      const cli = installRealisticContainerCli()
      await withTempWorkspace(async (workspaceRoot) => {
        await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-owned-odd',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })
        const create = cli.calls.find(isCreate) ?? []
        const ownerArg = create.find((arg) => arg.startsWith('batshit.owner='))

        expect(ownerArg).toMatch(/^batshit\.owner=[0-9a-f]{16}$/)
      })
    })

    it('a Batshit with no identity labels no owner: nothing would claim the sandbox at a quit', async () => {
      __setAppleContainerPlatformForTests('darwin')
      delete process.env.BATSHIT_VOICE_RUNTIME_OWNER
      const cli = installRealisticContainerCli()
      await withTempWorkspace(async (workspaceRoot) => {
        await executeAppleContainerSandboxCommand({
          userId: 'Josh',
          sessionId: 'session-unowned',
          workspaceRoot,
          cwd: workspaceRoot,
          command: 'true',
          timeoutMs: 10_000
        })
        const labels = labelsFromArgs(cli.calls.find(isCreate) ?? [])

        expect(Object.keys(labels)).toEqual(['batshit.created-at'])
      })
    })
  })

  // BL-83 review: only Apple's own stopped answer (exit 1, "... not registered with launchd") is a
  // stopped system that the first sandboxed command may start. An XPC or launchd error, or a
  // registered apiserver that does not answer ("apiserver is not running"), is not answering: it is
  // reported with its words and no automatic start is tried.
  it('status reports a failing status check with its own words, and starts nothing', async () => {
    __setAppleContainerPlatformForTests('darwin')
    for (const [stdout, stderr, words] of [
      ['', 'Error: XPC connection error: Connection invalid', /XPC connection error/],
      ['apiserver is not running', '', /apiserver is not running/]
    ] as const) {
      const { calls } = installFakeRunner((args) => {
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun(stdout, 1, stderr)
        return makeRun('', 1, `unexpected command: ${key}`)
      })

      const status = await getAppleContainerSandboxStatus()

      expect(status).toMatchObject({ available: false, installed: true, supported: true, systemRunning: false })
      expect(status.reason).toMatch(words)
      expect(calls.map((call) => call.args[1])).not.toContain('start')
    }
  })

  it('a sandboxed command does not start a system whose status check failed', async () => {
    __setAppleContainerPlatformForTests('darwin')
    await withTempWorkspace(async (workspaceRoot) => {
      const { calls } = installFakeRunner((args) => {
        const key = args.join(' ')
        if (key === '--version') return makeRun('container CLI version 0.12.3')
        if (key === 'system status') return makeRun('', 1, 'Error: XPC connection error: Connection invalid')
        return makeRun('', 1, `unexpected command: ${key}`)
      })

      const result = await executeAppleContainerSandboxCommand({
        userId: 'Josh',
        sessionId: 'session-xpc-error',
        workspaceRoot,
        cwd: workspaceRoot,
        command: 'true',
        timeoutMs: 10_000
      })

      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.reason).toMatch(/XPC connection error/)
      expect(calls.map((call) => call.args[1])).not.toContain('start')
      expect(await readdir(recordDir)).toEqual([])
    })
  })

  // Review (regression from BL-62 part b): a stopped system is the normal state after launch now, and
  // every chat turn's run-end cleanup ran into it and logged a warning. A stopped system holds no
  // running sandbox, so there is nothing to clean and nothing to say. One that does not answer still
  // warns.
  it('run-end cleanup on a stopped system is quiet and starts nothing; on a system that does not answer it warns', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli({ systemStopped: true })
    expect(await cleanupAppleContainerSandboxesForSession('session-cleanup-stopped')).toEqual([])
    expect(cli.calls.map((args) => args.join(' '))).toEqual(['--version', 'system status'])

    installFakeRunner((args) => {
      const key = args.join(' ')
      if (key === '--version') return makeRun('container CLI version 0.12.3')
      if (key === 'system status') return makeRun('', 1, 'Error: XPC connection error: Connection invalid')
      return makeRun('', 1, `unexpected command: ${key}`)
    })
    const warnings = await cleanupAppleContainerSandboxesForSession('session-cleanup-broken')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/XPC connection error/)
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
      expect(cli.count((args) => args.join(' ') === 'system start --disable-kernel-install')).toBe(1)
      expect(cli.count(isNetworkCreate)).toBe(1)
      expect(cli.count(isCreate)).toBe(2)
      const order = cli.calls.map((args) => args.join(' '))
      const systemStart = order.indexOf('system start --disable-kernel-install')
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
      const volumes = createCall?.args.flatMap((value, index, args) => value === '--volume' ? [args[index + 1]] : [])
      expect(volumes).toContain(`${path.join(await realpath(mountDir), '.batshit', 'installs')}:${path.join(await realpath(mountDir), '.batshit', 'installs')}`)
      expect(volumes).not.toContain(`${path.join(await realpath(mountDir), '.batshit')}:${path.join(await realpath(mountDir), '.batshit')}`)
      for (const protectedName of ['agents', 'runtime', 'pinokio', 'pinokio.admission']) {
        expect(volumes?.some((volume) => volume?.includes(`/${protectedName}:`))).toBe(false)
      }
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

  it.each(['agents', 'runtime', 'pinokio', 'pinokio.admission'])('refuses an alias workspace that reaches protected %s before creating a sandbox', async (protectedName) => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli()
    const agents = path.join(await realpath(mountDir), '.batshit', protectedName)
    await mkdir(agents, { recursive: true })
    const alias = path.join(mountDir, 'agent-home-alias')
    await symlink(agents, alias)
    const result = await executeAppleContainerSandboxCommand({
      workspaceRoot: alias,
      cwd: alias,
      command: 'true',
      timeoutMs: 1000
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/managed agent homes/) })
    expect(cli.count(isCreate)).toBe(0)
  })

  it.each(['agents', 'runtime', 'pinokio', 'pinokio.admission'])('keeps the original host protected after first-run HOME isolation (%s)', async (name) => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli()
    const original = path.join(await realpath(mountDir), 'original-host', '.batshit')
    const protectedRoot = path.join(original, name)
    vi.stubEnv('BATSHIT_SANDBOX_PROTECTED_HOME_DIR', original)
    try {
      await mkdir(protectedRoot, { recursive: true })
      const alias = `${protectedRoot}-alias`
      await symlink(protectedRoot, alias)
      for (const workspaceRoot of [protectedRoot, alias, original]) {
        const result = await executeAppleContainerSandboxCommand({ workspaceRoot, cwd: workspaceRoot, command: 'true', timeoutMs: 1000 })
        expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/managed agent homes/) })
      }
      expect(cli.count(isCreate)).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses a separate agents root nested inside an automatic writable tools mount', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli()
    const parent = path.join(await realpath(mountDir), '.batshit', 'tools')
    vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', parent)
    try {
      await mkdir(path.join(parent, 'agents'), { recursive: true })
      await withTempWorkspace(async (workspaceRoot) => {
        const result = await executeAppleContainerSandboxCommand({ workspaceRoot, cwd: workspaceRoot, command: 'true', timeoutMs: 1000 })
        expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/managed agent homes/) })
        expect(cli.count(isCreate)).toBe(0)
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses a link planted in an allowed mount source', async () => {
    __setAppleContainerPlatformForTests('darwin')
    const cli = installRealisticContainerCli()
    const home = path.join(await realpath(mountDir), '.batshit')
    const agents = path.join(home, 'agents')
    await mkdir(agents, { recursive: true })
    await symlink(agents, path.join(home, 'installs'))
    await withTempWorkspace(async (workspaceRoot) => {
      const result = await executeAppleContainerSandboxCommand({
        workspaceRoot,
        cwd: workspaceRoot,
        command: 'true',
        timeoutMs: 1000
      })
      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/mount is a link/) })
      expect(cli.count(isCreate)).toBe(0)
    })
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
      captureModelOutput?: boolean
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
      expect(exec.captureModelOutput).toBe(true)
      expect(end.args).toEqual(['exec', name, ...sandboxCommandEndArgv(tagArg.split('=')[1])])
      // The end command itself is never stopped, and has its own short limit.
      expect(end.abortSignal).toBeUndefined()
      expect(end.endInside).toBeUndefined()
      expect(end.timeoutMs).toBe(SANDBOX_COMMAND_END_TIMEOUT_MS)
      expect(end.captureModelOutput).toBeUndefined()
      // Only the command gets an end: never a sandbox start, list, or removal.
      expect(seen.filter((call) => call.args[0] !== 'exec').every((call) => !call.endInside)).toBe(true)
      expect(seen.filter((call) => call.args[0] !== 'exec').every((call) => !call.captureModelOutput)).toBe(true)
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
    async function withInheritedPipeProbe(
      keepParentAlive: boolean,
      use: (args: string[], pidFile: string) => Promise<void>
    ) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-pipe-probe-'))
      const pidFile = path.join(tempRoot, 'descendant.pid')
      const script = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync, writeSync } = require('node:fs')",
        "const held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2], detached: true })",
        'held.unref()',
        `writeFileSync(${JSON.stringify(pidFile)}, String(held.pid))`,
        "writeSync(1, 'ready\\n')",
        keepParentAlive ? 'setInterval(() => {}, 1000)' : 'process.exit(0)'
      ].join(';')
      try {
        await use(['-e', script], pidFile)
      } finally {
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
        }
        await rm(tempRoot, { recursive: true, force: true })
      }
    }

    it.skipIf(process.platform === 'win32')('releases inherited pipes after CLI exit without misclassifying a timeout', async () => {
      await withInheritedPipeProbe(false, async (args) => {
        const started = Date.now()
        const run = await __runAppleContainerCommandForTests(process.execPath, args, {
          timeoutMs: 10_000,
          captureModelOutput: true
        })

        expect(Date.now() - started).toBeLessThan(5_000)
        expect(run).toMatchObject({ exitCode: 0, timedOut: false, truncated: true })
        expect(run.stdout).toBe('ready\n')
        expect(run.stderr).toContain('[Command output capture incomplete: pipes did not close; any later output was not kept.]')
        expect(getCommandModelCapture(run)?.text).toContain('outputIncomplete=true')
      })
    })

    it.skipIf(process.platform === 'win32')('bounds inherited pipes on Stop and waits for inside cleanup', async () => {
      await withInheritedPipeProbe(true, async (args, pidFile) => {
        const stop = new AbortController()
        let ends = 0
        const runPromise = __runAppleContainerCommandForTests(process.execPath, args, {
          timeoutMs: 10_000,
          captureModelOutput: true,
          abortSignal: stop.signal,
          endInside: async () => { ends += 1; await sleep(100) }
        })
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await readFile(pidFile, 'utf8').catch(() => '')) break
          await sleep(20)
        }
        stop.abort()
        const run = await runPromise

        expect(run).toMatchObject({ stopped: true, timedOut: false, truncated: true })
        expect(run.stderr).toContain('[Command output capture incomplete: pipes did not close; any later output was not kept.]')
        expect(getCommandModelCapture(run)?.text).toContain('outputIncomplete=true')
        expect(ends).toBe(1)
      })
    })

    it.skipIf(process.platform === 'win32')('bounds inherited pipes on timeout', async () => {
      await withInheritedPipeProbe(true, async (args) => {
        const run = await __runAppleContainerCommandForTests(process.execPath, args, {
          timeoutMs: 750,
          captureModelOutput: true,
          endInside: async () => {}
        })

        expect(run).toMatchObject({ timedOut: true, truncated: true })
        expect(run.stderr).toContain('[Command output capture incomplete: pipes did not close; any later output was not kept.]')
        expect(getCommandModelCapture(run)?.text).toContain('outputIncomplete=true')
      })
    })

    it('keeps a bounded visible stream and an exact-count private model prefix for large child output', async () => {
      const chars = MAX_COMMAND_MODEL_CAPTURE_CHARS + 200_000
      const probe = `process.stdout.write('A'.repeat(${chars})); process.stderr.write('ERR')`
      const run = await __runAppleContainerCommandForTests(process.execPath, ['-e', probe], {
        timeoutMs: 10_000,
        maxOutputChars: 1_000,
        captureModelOutput: true
      })
      const capture = getCommandModelCapture(run)
      const empty = createCommandModelCapture().finish({ exitCode: 0 })

      expect(run.exitCode).toBe(0)
      expect(run.truncated).toBe(true)
      expect(run.stdout.length).toBeLessThanOrEqual(1_000)
      expect(run.stdout).toContain('[Output cut here by Batshit:')
      expect(run.stderr).toBe('ERR')
      expect(capture).not.toBeNull()
      expect(capture!.text.length).toBeLessThanOrEqual(MAX_COMMAND_MODEL_CAPTURE_CHARS)
      expect(capture!.text).toContain('status: exitCode=0')
      expect(capture!.originalTextChars).toBe(empty.originalTextChars + chars + 3)
      expect(JSON.stringify(run)).not.toContain('originalTextChars')
    })

    it('decodes UTF-8 split across child chunks in visible and private streams', async () => {
      const probe = [
        'process.stdout.write(Buffer.from([0x61, 0xf0, 0x9f]))',
        'setTimeout(() => process.stdout.write(Buffer.from([0x99, 0x82, 0x62])), 20)'
      ].join(';')
      const run = await __runAppleContainerCommandForTests(process.execPath, ['-e', probe], {
        timeoutMs: 10_000,
        captureModelOutput: true
      })
      expect(run.stdout).toBe('a🙂b')
      expect(getCommandModelCapture(run)?.text.endsWith('stderr:\n\nstdout:\na🙂b')).toBe(true)
      expect(getCommandModelCapture(run)?.originalTextChars).toBe(
        createCommandModelCapture().finish({ exitCode: 0 }).originalTextChars + 'a🙂b'.length
      )
    })

    it('does not retain private output for status and cleanup probes', async () => {
      const run = await __runAppleContainerCommandForTests(process.execPath, ['-e', "process.stdout.write('status')"], {
        timeoutMs: 10_000
      })
      expect(run.stdout).toBe('status')
      expect(getCommandModelCapture(run)).toBeNull()
    })

    it('does not pass host operator authority to an agent-controlled command', async () => {
      const names = [
        'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN',
        'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN',
        'BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY',
        'BATSHIT_HOST_VOICE_RECIPE_KEY_FILE'
      ]
      const inheritedName = names[3]
      const previous = process.env[inheritedName]
      process.env[inheritedName] = '/tmp/dummy-recipe-key'
      try {
        const probe = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((name) => Object.hasOwn(process.env, name))))`
        const run = await __runAppleContainerCommandForTests(process.execPath, ['-e', probe], {
          timeoutMs: 10_000,
          env: Object.fromEntries(names.map((name) => [name, 'dummy-secret']))
        })
        expect(run.exitCode).toBe(0)
        expect(run.stdout).toBe('[false,false,false,false]')
      } finally {
        if (previous === undefined) delete process.env[inheritedName]
        else process.env[inheritedName] = previous
      }
    })

    it('waits for the end inside the sandbox before it answers a Stop', async () => {
      const stop = new AbortController()
      setTimeout(() => stop.abort('user'), 150)
      let ends = 0
      const started = Date.now()

      // `sleep` stands in for `container exec`.
      const run = await __runAppleContainerCommandForTests('sleep', ['5'], {
        timeoutMs: 10_000,
        captureModelOutput: true,
        abortSignal: stop.signal,
        endInside: async () => {
          ends += 1
          await sleep(300)
        }
      })

      expect(run).toMatchObject({ stopped: true, timedOut: false })
      expect(getCommandModelCapture(run)?.text).toContain('stopped=true')
      expect(ends).toBe(1)
      expect(Date.now() - started).toBeGreaterThanOrEqual(430)
      expect(Date.now() - started).toBeLessThan(1_500)
    })

    it('ends inside the sandbox on a timeout the same way', async () => {
      let ends = 0
      const run = await __runAppleContainerCommandForTests('sleep', ['5'], {
        timeoutMs: 200,
        captureModelOutput: true,
        endInside: async () => {
          ends += 1
        }
      })

      expect(run).toMatchObject({ timedOut: true })
      expect(getCommandModelCapture(run)?.text).toContain('timedOut=true')
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
