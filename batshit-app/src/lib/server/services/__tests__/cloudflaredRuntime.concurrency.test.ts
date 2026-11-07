import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

// CJS interop resolves named imports through `default`, so the mock factory
// must provide it too.
vi.mock('node:child_process', () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock
}))

import {
  ensureManagedCloudflaredTunnel,
  getCloudflaredRuntimeStatus,
  stopManagedCloudflaredTunnel,
  uninstallCloudflaredRuntime
} from '../cloudflaredRuntime'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  exitOnSignal: NodeJS.Signals | null = 'SIGTERM'
  signals: NodeJS.Signals[] = []

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    this.signals.push(signal)
    if (this.exitOnSignal === signal) setImmediate(() => this.observeExit(signal))
    return true
  }

  observeExit(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.signalCode = signal
    this.emit('exit', null, signal)
    this.emit('close', null, signal)
  }
}

let nextPid = 41000
let tunnelSpawns: FakeChildProcess[] = []
let fixtureRoot: string

function installSpawnFake() {
  spawnMock.mockImplementation((command: string, args: string[] = []) => {
    if (args.includes('--version')) {
      const probe = new FakeChildProcess(nextPid++)
      setImmediate(() => {
        probe.stdout.emit('data', 'cloudflared version 2026.3.0 (built fake)\n')
        probe.exitCode = 0
        probe.emit('close', 0, null)
      })
      return probe
    }
    if (args[0] === 'tunnel') {
      const child = new FakeChildProcess(nextPid++)
      tunnelSpawns.push(child)
      setImmediate(() => {
        child.stdout.emit(
          'data',
          `2026-06-10T00:00:00Z INF |  https://fake-${child.pid}.trycloudflare.com  |\n`
        )
      })
      return child
    }
    throw new Error(`Unexpected spawn in cloudflared concurrency test: ${command} ${args.join(' ')}`)
  })
}

const originalContainerized = process.env.BATSHIT_CONTAINERIZED
const originalRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
const originalCloudflaredBin = process.env.BATSHIT_CLOUDFLARED_BIN
const originalCloudflaredDir = process.env.BATSHIT_CLOUDFLARED_DIR

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(async () => {
  delete process.env.BATSHIT_CONTAINERIZED
  delete process.env.BATSHIT_RUNTIME_ENV
  process.env.BATSHIT_CLOUDFLARED_BIN = '/fake/bin/cloudflared'
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-cloudflared-concurrency-'))
  process.env.BATSHIT_CLOUDFLARED_DIR = path.join(fixtureRoot, 'cloudflared')
  tunnelSpawns = []
  spawnMock.mockReset()
  installSpawnFake()
})

afterEach(async () => {
  // An assertion on the original bug must not leave a held fake child or timer
  // behind. These are fixture events only; this suite never starts a process.
  for (const child of tunnelSpawns) child.observeExit()
  vi.useRealTimers()
  await stopManagedCloudflaredTunnel()
  await fs.rm(fixtureRoot, { recursive: true, force: true })
  restoreEnv('BATSHIT_CONTAINERIZED', originalContainerized)
  restoreEnv('BATSHIT_RUNTIME_ENV', originalRuntimeEnv)
  restoreEnv('BATSHIT_CLOUDFLARED_BIN', originalCloudflaredBin)
  restoreEnv('BATSHIT_CLOUDFLARED_DIR', originalCloudflaredDir)
})

describe('cloudflaredRuntime managed tunnel concurrency', () => {
  it('spawns exactly one tunnel process for concurrent ensure calls', async () => {
    const targetUrl = 'http://localhost:5600'

    const [first, second] = await Promise.all([
      ensureManagedCloudflaredTunnel({ targetUrl }),
      ensureManagedCloudflaredTunnel({ targetUrl })
    ])

    expect(first.started).toBe(true)
    expect(second.started).toBe(true)
    expect(first.status.publicUrl).toMatch(/trycloudflare\.com$/)
    expect(second.status.publicUrl).toBe(first.status.publicUrl)
    expect(second.status.pid).toBe(first.status.pid)
    expect(tunnelSpawns).toHaveLength(1)
    expect(first.status.pid).toBe(tunnelSpawns[0].pid)

    const third = await ensureManagedCloudflaredTunnel({ targetUrl })
    expect(third.started).toBe(true)
    expect(third.status.pid).toBe(first.status.pid)
    expect(tunnelSpawns).toHaveLength(1)
  })

  it('stop waits for an in-flight start so the spawned tunnel never outlives the stop', async () => {
    const targetUrl = 'http://localhost:5600'

    const ensurePromise = ensureManagedCloudflaredTunnel({ targetUrl })
    const stopPromise = stopManagedCloudflaredTunnel()

    const [ensured, stopped] = await Promise.all([ensurePromise, stopPromise])

    expect(ensured.started).toBe(true)
    expect(stopped.stopped).toBe(true)
    expect(stopped.status.running).toBe(false)
    expect(tunnelSpawns).toHaveLength(1)
    expect(tunnelSpawns[0].killed).toBe(true)
  })

  it('retains a signalled child after timeout and refuses replacement and uninstall until exit is observed', async () => {
    const targetUrl = 'http://localhost:5600'
    const ensured = await ensureManagedCloudflaredTunnel({ targetUrl })
    const child = tunnelSpawns[0]
    child.exitOnSignal = null
    const installDir = process.env.BATSHIT_CLOUDFLARED_DIR!
    await fs.mkdir(installDir)
    await fs.writeFile(path.join(installDir, 'keep.txt'), 'owned prior installation')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const firstStop = stopManagedCloudflaredTunnel()
    const joinedStop = stopManagedCloudflaredTunnel()
    await vi.advanceTimersByTimeAsync(35_001)
    const [first, joined] = await Promise.all([firstStop, joinedStop])

    expect(first.stopped).toBe(false)
    expect(joined).toEqual(first)
    expect(child.killed).toBe(true) // Signal acceptance is not observed exit.
    expect(child.signalCode).toBeNull()
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(first.status).toMatchObject({ running: true, pid: ensured.status.pid, targetUrl })
    expect(first.reason).toMatch(/exit.*not.*confirmed|not.*confirm.*exit/i)
    expect((await ensureManagedCloudflaredTunnel({ targetUrl })).started).toBe(false)
    expect((await ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5601' })).started).toBe(false)
    expect(tunnelSpawns).toHaveLength(1)

    // A repeated stop sees killed=true too; it must still await actual exit.
    const uninstallPromise = uninstallCloudflaredRuntime()
    await vi.waitFor(() => expect(child.signals).toHaveLength(3))
    await vi.advanceTimersByTimeAsync(35_001)
    const removed = await uninstallPromise
    expect(removed).toMatchObject({ uninstalled: false, removedManagedInstall: false })
    expect(removed.status.tunnel).toMatchObject({ running: true, pid: child.pid })
    expect(await fs.readFile(path.join(installDir, 'keep.txt'), 'utf8')).toBe('owned prior installation')

    child.observeExit('SIGKILL')
    vi.useRealTimers()
    const replacement = await ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5601' })
    expect(replacement.started).toBe(true)
    expect(replacement.status.pid).not.toBe(child.pid)
    expect(tunnelSpawns).toHaveLength(2)
    child.emit('exit', null, 'SIGKILL')
    child.emit('close', null, 'SIGKILL')
    expect((await getCloudflaredRuntimeStatus()).tunnel.pid).toBe(replacement.status.pid)
  })

  it('escalates only the owned child and reports stopped only after its SIGKILL exit', async () => {
    await ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5600' })
    const child = tunnelSpawns[0]
    child.exitOnSignal = 'SIGKILL'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

    const stopPromise = stopManagedCloudflaredTunnel()
    await vi.advanceTimersByTimeAsync(30_001)
    // setImmediate is deliberately real: kill acceptance and the later exit
    // event are separate, just as they are for Node's ChildProcess.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const result = await stopPromise
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.signalCode).toBe('SIGKILL')
    expect(result).toMatchObject({ stopped: true, status: { running: false, pid: null } })
  })

  it('refuses retargeting when the predecessor cannot be confirmed stopped', async () => {
    const first = await ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5600' })
    tunnelSpawns[0].exitOnSignal = null
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const retarget = ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5601' })
    await vi.advanceTimersByTimeAsync(35_001)
    const result = await retarget
    expect(result).toMatchObject({
      started: false,
      status: { running: true, pid: first.status.pid, targetUrl: 'http://localhost:5600' }
    })
    expect(tunnelSpawns).toHaveLength(1)
  })

  it('refuses starts before and after an availability await while removal owns the runtime', async () => {
    const ordinarySpawn = spawnMock.getMockImplementation()!
    let heldProbe: FakeChildProcess | undefined
    let holdProbe = true
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (holdProbe && args.includes('--version')) {
        holdProbe = false
        heldProbe = new FakeChildProcess(nextPid++)
        return heldProbe
      }
      return ordinarySpawn(command, args)
    })
    const startBeforeRemoval = ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5600' })
    await vi.waitFor(() => expect(heldProbe).toBeDefined())

    const installDir = process.env.BATSHIT_CLOUDFLARED_DIR!
    await fs.mkdir(installDir)
    const remove = fs.rm
    let releaseRemoval!: () => void
    let removalEntered = false
    const removalHeld = new Promise<void>((resolve) => { releaseRemoval = resolve })
    const removeSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === installDir) {
        removalEntered = true
        await removalHeld
      }
      return await remove(target, options)
    })
    const uninstall = uninstallCloudflaredRuntime()
    try {
      // Removal awaits the prior in-flight start before touching its files.
      // Its lock is already held, so releasing the version read must refuse.
      await vi.waitFor(() => expect(heldProbe).toBeDefined())
      heldProbe!.stdout.emit('data', 'cloudflared version 2026.3.0\n')
      heldProbe!.exitCode = 0
      heldProbe!.emit('close', 0, null)
      expect((await startBeforeRemoval).started).toBe(false)
      await vi.waitFor(() => expect(removalEntered).toBe(true))
      expect((await ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5601' })).started).toBe(false)
      expect(tunnelSpawns).toHaveLength(0)
    } finally {
      releaseRemoval()
      await uninstall
      removeSpy.mockRestore()
    }
  })

  it('releases failed-spawn custody on close even when no exit event arrives', async () => {
    const started = ensureManagedCloudflaredTunnel({ targetUrl: 'http://localhost:5600' })
    await vi.waitFor(() => expect(tunnelSpawns).toHaveLength(1))
    const child = tunnelSpawns[0]
    child.emit('error', new Error('fixture spawn refused'))
    child.emit('close', -2, null)
    expect(await started).toMatchObject({
      started: false,
      status: { running: false, pid: null },
      reason: 'fixture spawn refused'
    })
    expect(child.signals).toHaveLength(0)
  })
})
