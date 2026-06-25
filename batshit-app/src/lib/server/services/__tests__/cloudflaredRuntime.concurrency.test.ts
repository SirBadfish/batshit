import { EventEmitter } from 'node:events'
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
  stopManagedCloudflaredTunnel
} from '../cloudflaredRuntime'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.exitCode !== null || this.killed) return false
    this.killed = true
    this.signalCode = signal
    setImmediate(() => {
      this.emit('exit', null, signal)
      this.emit('close', null, signal)
    })
    return true
  }
}

let nextPid = 41000
let tunnelSpawns: FakeChildProcess[] = []

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

beforeEach(() => {
  delete process.env.BATSHIT_CONTAINERIZED
  delete process.env.BATSHIT_RUNTIME_ENV
  process.env.BATSHIT_CLOUDFLARED_BIN = '/fake/bin/cloudflared'
  process.env.BATSHIT_CLOUDFLARED_DIR = path.join(
    os.tmpdir(),
    'batshit-cloudflared-concurrency-test-missing'
  )
  tunnelSpawns = []
  spawnMock.mockReset()
  installSpawnFake()
})

afterEach(async () => {
  await stopManagedCloudflaredTunnel()
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
})
