import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mockGetRuntimeAddonStatus = vi.fn()
const mockControlRuntimeAddon = vi.fn()
const mockInspectLocalLiveKitPortOwner = vi.fn()
const mockFetchLiveKitServerReady = vi.fn()
const mockGetNativeLiveKitInstallStatus = vi.fn()
const mockInstallLiveKitSidecarPackage = vi.fn()
const mockInstallLiveKitServerBinary = vi.fn()
const mockStartLocalVoiceRuntime = vi.fn()
const mockGetUserSettings = vi.fn()
const mockReadLiveKitConfig = vi.fn()
let mockSidecarInstallRoot = ''
const LIVEKIT_CONFIG = {
  serverUrl: 'ws://127.0.0.1:7880',
  dispatchServerUrl: 'ws://127.0.0.1:7880',
  apiKey: 'batshit-local',
  apiSecret: 'secret',
  tokenTtlSec: 600,
  roomPrefix: 'batshit-voice',
  selfHosted: true,
  agentName: 'batshit-livekit-agent',
  autoDispatchAgent: true
}

function nativeInstallStatus(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    installed: true,
    serverInstalled: true,
    sidecarInstalled: true,
    updateAvailable: false,
    serverUpdateAvailable: false,
    sidecarUpdateAvailable: false,
    reason: null,
    version: '1.13.5',
    serverVersion: '1.13.5',
    sidecarVersion: '1.6.3',
    targetSidecarVersion: '1.6.3',
    serverInstallRoot: '/tmp/livekit-server',
    sidecarInstallRoot: '/tmp/livekit-sidecar',
    serverBinaryPath: '/tmp/livekit-server/livekit-server',
    sidecarPackagePath: '/tmp/livekit-sidecar',
    serverManifest: null,
    sidecarManifest: null,
    ...overrides
  }
}

function dockerAddonStatus() {
  return {
    id: 'livekit',
    label: 'LiveKit',
    running: false,
    available: false,
    reason: 'LiveKit server is not reachable.',
    details: {
      browserUrl: 'ws://localhost:7880',
      agentHealthUrl: 'http://livekit-agent:7899/worker',
      server: {
        ready: false,
        statusHint: 'LiveKit server is not reachable.'
      }
    }
  }
}

vi.mock('$lib/server/services/runtimeAddons', () => ({
  getRuntimeAddonStatus: (...args: any[]) => mockGetRuntimeAddonStatus(...args),
  controlRuntimeAddon: (...args: any[]) => mockControlRuntimeAddon(...args)
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: (...args: any[]) => mockGetUserSettings(...args)
  }
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn(async () => null),
    store: vi.fn(async () => undefined)
  }
}))

vi.mock('$lib/server/services/internalRequestAuth', () => ({
  getConfiguredInternalToken: vi.fn(() => 'test-token')
}))

vi.mock('$lib/server/services/liveKitVoiceRuntime', () => ({
  resolveLiveKitVoiceRuntimeConfigForUser: vi.fn(async () => LIVEKIT_CONFIG),
  readLiveKitVoiceRuntimeConfigForUser: (...args: any[]) => mockReadLiveKitConfig(...args)
}))

vi.mock('$lib/server/services/liveKitNativeRuntimeInstaller', () => ({
  LIVEKIT_NATIVE_SERVER_ENGINE_ID: 'livekit-server',
  resolveNativeLiveKitServerInstallRoot: vi.fn(() => '/tmp/livekit-server'),
  fetchLiveKitServerReady: (...args: any[]) => mockFetchLiveKitServerReady(...args),
  getLocalLiveKitPort: vi.fn(() => 7880),
  getNativeLiveKitInstallStatus: (...args: any[]) => mockGetNativeLiveKitInstallStatus(...args),
  inspectLocalLiveKitPortOwner: (...args: any[]) => mockInspectLocalLiveKitPortOwner(...args),
  installNativeLiveKitRuntime: vi.fn(async () => ({
    installed: true,
    credentialsSaved: true,
    serverUrl: 'ws://127.0.0.1:7880',
    apiKey: 'batshit-local',
    status: {
      supported: true,
      installed: true,
      serverInstalled: true,
      sidecarInstalled: true,
      reason: null,
      updateAvailable: false,
      serverUpdateAvailable: false,
      sidecarUpdateAvailable: false,
      version: '1.13.5',
      serverVersion: '1.13.5',
      sidecarVersion: '1.6.3',
      targetSidecarVersion: '1.6.3',
      serverInstallRoot: '/tmp/livekit-server',
      sidecarInstallRoot: '/tmp/livekit-sidecar',
      serverBinaryPath: '/tmp/livekit-server/livekit-server',
      sidecarPackagePath: '/tmp/livekit-sidecar',
      serverManifest: null,
      sidecarManifest: null
    }
  })),
  installLiveKitSidecarPackage: (...args: any[]) => mockInstallLiveKitSidecarPackage(...args),
  installLiveKitServerBinary: (...args: any[]) => mockInstallLiveKitServerBinary(...args),
  liveKitServerHttpUrl: vi.fn(() => 'http://127.0.0.1:7880'),
  resolveNativeLiveKitSidecarInstallRoot: vi.fn(() => mockSidecarInstallRoot),
  startNativeLiveKitServerRuntime: vi.fn(async () => ({
    started: false,
    alreadyRunning: false,
    pid: null,
    logPath: null,
    statusHint: 'Native LiveKit server is not installed yet.'
  }))
}))

vi.mock('$lib/server/services/voiceLocalEngineSetup', () => ({
  startLocalVoiceRuntime: (...args: any[]) => mockStartLocalVoiceRuntime(...args)
}))

import {
  getLiveKitSidecarRuntimeSummary,
  refuseLiveKitDispatchUnlessOwnSidecar,
  resolveLiveKitRuntimeEngineRefs,
  startLiveKitSidecarRuntime,
  stopLiveKitSidecarOnPort,
  syncLiveKitStopPreference
} from '$lib/server/services/liveKitSidecarRuntime'
import { writeLocalRuntimeLaunchRecord } from '$lib/server/services/voiceRuntimeLaunchRecords'
import { env } from '$env/dynamic/private'

describe('liveKitSidecarRuntime', () => {
  const fixtureRoots: string[] = []
  // BL-1311: an answering sidecar is ready only when it is this Batshit's own current launch. A
  // launch here is a real detached listener on a free port with this Batshit's launch record, as
  // startLocalVoiceRuntime leaves one.
  const outerEnv = env as Record<string, string | undefined>
  const originalOuterHealthPort = outerEnv.LIVEKIT_AGENT_HEALTH_PORT
  const originalOuterPath = process.env.PATH
  const ownSidecars: ChildProcess[] = []
  // Cleanup signals only a child of this test that Node has not yet seen exit: until Node reaps it,
  // its pid cannot be anyone else's (BL-1312). One the code under test stopped is left alone.
  const killOwnGroup = (child: ChildProcess | null) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
  // Waits until a process is gone (exited and reaped), rather than for a fixed time.
  const gone = async (pid: number) => {
    for (let tries = 0; tries < 60; tries += 1) {
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  // A port this test holds (BL-1312): never the machine's default 7899, and never merely "free",
  // which another process could take before the test's own sidecar binds it.
  type Reservation = { port: number; server: Server }
  const reservations: Server[] = []
  async function reservePort(): Promise<Reservation> {
    return new Promise((resolve) => {
      const server = createServer().listen(0, '127.0.0.1', () => {
        reservations.push(server)
        resolve({ port: (server.address() as { port: number }).port, server })
      })
    })
  }

  const OWN_SIDECAR = `
    const http = require('http')
    const answer = (q, r) => r.end(JSON.stringify({ agent_name: 'batshit-livekit-agent' }))
    process.on('message', (message, handle) => {
      if (message !== 'listen') return
      http.createServer(answer).listen(handle, () => { process.send('listening'); process.disconnect() })
    })
    if (process.argv[1]) http.createServer(answer).listen(Number(process.argv[1]), '127.0.0.1')
  `

  // This Batshit's own sidecar: a detached process that serves the test's reserved port (handed the
  // listening socket itself), or, for a relaunch on the port its previous launch held, binds it
  // again. Its launch record is written as startLocalVoiceRuntime writes one.
  async function launchOwnSidecarOn(target: Reservation | number): Promise<number> {
    const reserved = typeof target === 'number' ? null : target
    const port = reserved ? reserved.port : (target as number)
    const child = spawn(process.execPath, ['-e', OWN_SIDECAR, reserved ? '' : String(port)], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    ownSidecars.push(child)
    if (reserved) {
      await new Promise((resolve) => child.once('spawn', resolve))
      const listening = new Promise((resolve) => child.once('message', resolve))
      child.send('listen', reserved.server)
      await listening
      // The child holds the socket now; this process lets go of its own copy.
      await new Promise((resolve) => reserved.server.close(resolve))
    } else {
      child.disconnect()
      for (let tries = 0; tries < 50; tries += 1) {
        const up = await new Promise<boolean>((resolve) => {
          const socket = createConnection(port, '127.0.0.1', () => {
            socket.end()
            resolve(true)
          }).on('error', () => resolve(false))
        })
        if (up) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    await writeLocalRuntimeLaunchRecord({
      engineId: 'livekit-sidecar',
      pid: child.pid as number,
      command: process.execPath,
      endpoint: `http://127.0.0.1:${port}`,
      launchedAt: new Date().toISOString()
    })
    return child.pid as number
  }

  // The launcher stand-in: start this Batshit's own sidecar on the health port the test set.
  async function launchesOwnSidecar() {
    const reserved = await reservePort()
    outerEnv.LIVEKIT_AGENT_HEALTH_PORT = String(reserved.port)
    mockStartLocalVoiceRuntime.mockImplementation(async () => ({ pid: await launchOwnSidecarOn(reserved), logPath: '/tmp/livekit-sidecar.log' }))
  }
  let originalContainerized: string | undefined
  let originalRuntimeEnv: string | undefined
  let originalStateRootAll: string | undefined
  let stateRootAll = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    originalContainerized = process.env.BATSHIT_CONTAINERIZED
    originalRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
    mockSidecarInstallRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-sidecar-'))
    fixtureRoots.push(mockSidecarInstallRoot)
    await mkdir(path.join(mockSidecarInstallRoot, 'node_modules', '.bin'), { recursive: true })
    await writeFile(path.join(mockSidecarInstallRoot, 'package.json'), '{}\n')
    await writeFile(path.join(mockSidecarInstallRoot, 'node_modules', '.bin', 'tsx'), '')
    mockGetRuntimeAddonStatus.mockResolvedValue(dockerAddonStatus())
    mockControlRuntimeAddon.mockResolvedValue({
      success: false,
      error: 'Runtime add-on operator is not configured.',
      after: dockerAddonStatus()
    })
    mockInspectLocalLiveKitPortOwner.mockResolvedValue({
      pids: [],
      commands: [],
      dockerOwned: false
    })
    mockFetchLiveKitServerReady.mockResolvedValue(true)
    mockGetNativeLiveKitInstallStatus.mockResolvedValue(nativeInstallStatus())
    mockInstallLiveKitSidecarPackage.mockResolvedValue(undefined)
    mockInstallLiveKitServerBinary.mockResolvedValue(undefined)
    mockStartLocalVoiceRuntime.mockResolvedValue({
      pid: 4242,
      logPath: '/tmp/livekit-sidecar.log'
    })
    mockGetUserSettings.mockResolvedValue(null)
    mockReadLiveKitConfig.mockResolvedValue(LIVEKIT_CONFIG)
    // Listeners come from `lsof`, which lives in /usr/sbin on macOS.
    process.env.PATH = `${originalOuterPath ?? ''}${path.delimiter}/usr/sbin`
    // A health port this test holds, never the machine's default 7899 (BL-1312).
    outerEnv.LIVEKIT_AGENT_HEALTH_PORT = String((await reservePort()).port)
    // Every test's launch records live in a throwaway folder, never the real ~/.batshit: the
    // already-running paths read and write them (BL-1298).
    originalStateRootAll = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    stateRootAll = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-records-all-'))
    fixtureRoots.push(stateRootAll)
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRootAll
  })

  afterEach(async () => {
    if (originalStateRootAll === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    else process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalStateRootAll
    if (typeof originalContainerized === 'string') {
      process.env.BATSHIT_CONTAINERIZED = originalContainerized
    } else {
      delete process.env.BATSHIT_CONTAINERIZED
    }
    if (typeof originalRuntimeEnv === 'string') {
      process.env.BATSHIT_RUNTIME_ENV = originalRuntimeEnv
    } else {
      delete process.env.BATSHIT_RUNTIME_ENV
    }
    vi.unstubAllGlobals()
    if (originalOuterHealthPort === undefined) delete outerEnv.LIVEKIT_AGENT_HEALTH_PORT
    else outerEnv.LIVEKIT_AGENT_HEALTH_PORT = originalOuterHealthPort
    process.env.PATH = originalOuterPath
    for (const server of reservations.splice(0)) server.close()
    for (const child of ownSidecars.splice(0)) killOwnGroup(child)
    await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('reports the Docker LiveKit add-on as waiting in the Docker app container', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('runtime offline')
      })
    )

    await expect(getLiveKitSidecarRuntimeSummary('user-1')).resolves.toMatchObject({
      id: 'livekit',
      installed: true,
      status: 'unreachable',
      healthUrl: 'http://livekit-agent:7899/worker',
      statusHint: expect.stringContaining('LiveKit server is not reachable')
    })
  })

  it('starts Docker LiveKit through the runtime add-on operator instead of the host-style launcher', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('runtime offline')
      })
    )

    await expect(startLiveKitSidecarRuntime('user-1', { forceRestart: true })).resolves.toMatchObject({
      id: 'livekit',
      status: 'error',
      started: false,
      alreadyRunning: false,
      restarted: true,
      statusHint: expect.stringContaining('Runtime add-on operator is not configured')
    })
  })

  it('launches the native sidecar directly with Batshit\'s current Node runtime', async () => {
    await launchesOwnSidecar()
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockRejectedValueOnce(new Error('sidecar offline'))
        .mockResolvedValue({
          ok: true,
          json: async () => ({ agent_name: 'batshit-livekit-agent', active_jobs: 0 })
        })
    )

    const result = await startLiveKitSidecarRuntime('user-1')
    expect(result).toMatchObject({ status: 'ready', started: true, pid: ownSidecars[0].pid })
    expect(mockStartLocalVoiceRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        engineId: 'livekit-sidecar',
        launch: expect.objectContaining({
          command: process.execPath,
          args: ['node_modules/tsx/dist/cli.mjs', 'src/livekit-agent-sidecar.ts', 'start']
        })
      })
    )
  })

  it('refreshes a stale Batshit-managed sidecar before launching it', async () => {
    mockGetNativeLiveKitInstallStatus.mockResolvedValue(
      nativeInstallStatus({ updateAvailable: true, sidecarUpdateAvailable: true })
    )
    await launchesOwnSidecar()
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockRejectedValueOnce(new Error('sidecar offline'))
        .mockResolvedValue({
          ok: true,
          json: async () => ({ agent_name: 'batshit-livekit-agent', active_jobs: 0 })
        })
    )

    await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({ status: 'ready' })
    expect(mockInstallLiveKitSidecarPackage).toHaveBeenCalledOnce()
    expect(mockInstallLiveKitSidecarPackage.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartLocalVoiceRuntime.mock.invocationCallOrder[0]
    )
  })

  it('refreshes a stale managed LiveKit server before auto-start', async () => {
    mockGetNativeLiveKitInstallStatus.mockResolvedValue(
      nativeInstallStatus({ updateAvailable: true, serverUpdateAvailable: true })
    )
    mockFetchLiveKitServerReady.mockResolvedValueOnce(false).mockResolvedValue(true)
    await launchesOwnSidecar()
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockRejectedValueOnce(new Error('sidecar offline'))
        .mockResolvedValue({
          ok: true,
          json: async () => ({ agent_name: 'batshit-livekit-agent', active_jobs: 0 })
        })
    )

    await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({ status: 'ready' })
    expect(mockInstallLiveKitServerBinary).toHaveBeenCalledOnce()
    expect(mockInstallLiveKitServerBinary.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartLocalVoiceRuntime.mock.invocationCallOrder[0]
    )
  })

  // ---- One LiveKit lifecycle across Batshits (BL-1298, BL-1300, BL-1301) -------------------
  describe('LiveKit runtimes another Batshit launched, the tidy, and the saved Stop with Batshit choice', () => {
    // The module reads the health port from SvelteKit's env, a fixed object in tests.
    const testEnv = env as Record<string, string | undefined>
    const originalHealthPort = testEnv.LIVEKIT_AGENT_HEALTH_PORT
    const originalPath = process.env.PATH
    const children: ChildProcess[] = []

    beforeEach(async () => {
      // Listeners come from `lsof`, which lives in /usr/sbin on macOS.
      process.env.PATH = `${originalPath ?? ''}${path.delimiter}/usr/sbin`
      // A sidecar port this test holds, never the machine's default 7899 where a real LiveKit may
      // run (BL-1312); a test that needs a sidecar sets its own.
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String((await reservePort()).port)
    })
    afterEach(() => {
      process.env.PATH = originalPath
      if (originalHealthPort === undefined) delete testEnv.LIVEKIT_AGENT_HEALTH_PORT
      else testEnv.LIVEKIT_AGENT_HEALTH_PORT = originalHealthPort
      for (const child of children.splice(0)) child.kill('SIGKILL')
    })

    // A live process that listens on a port of its own and answers like a sidecar's /worker.
    async function listener(): Promise<{ pid: number; port: number }> {
      const child = spawn(
        process.execPath,
        ['-e', "const s = require('http').createServer((q, r) => r.end(JSON.stringify({ agent_name: 'batshit-livekit-agent' }))).listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port)))"],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      children.push(child)
      const port = await new Promise<number>((resolve) => child.stdout?.once('data', (chunk) => resolve(Number(String(chunk)))))
      return { pid: child.pid as number, port }
    }

    async function recordOf(engineId: string, fields: Record<string, unknown>) {
      const dir = path.join(stateRootAll, engineId)
      await mkdir(dir, { recursive: true })
      const contents = JSON.stringify({ engineId, command: '/opt/x', launchedAt: new Date().toISOString(), ...fields })
      await writeFile(path.join(dir, '.batshit-local-runtime-launch.json'), contents)
      return contents
    }
    const folder = async (engineId: string) => {
      const dir = path.join(stateRootAll, engineId)
      const out: Record<string, string> = {}
      for (const name of await readdir(dir).catch(() => [] as string[])) out[name] = await readFile(path.join(dir, name), 'utf8')
      return out
    }
    const sidecarAnswers = () =>
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ agent_name: 'batshit-livekit-agent' }), { status: 200 })))

    it("records this Batshit's use of another Batshit's running server, beside its launch", async () => {
      const server = await listener()
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      const theirs = await recordOf('livekit-server', { pid: server.pid, endpoint: 'http://127.0.0.1:7880', registry: 'redis-0000000000000000' })
      sidecarAnswers()
      mockGetUserSettings.mockResolvedValue({ voice_settings: { voiceRuntimes: { livekit: { startup: { stopOnShutdown: false } } } } })

      await startLiveKitSidecarRuntime('user-1')
      const records = await folder('livekit-server')
      expect(records[`.batshit-local-runtime-launch.${server.pid}.json`]).toBe(theirs)
      expect(JSON.parse(records['.batshit-local-runtime-launch.json'])).toMatchObject({
        pid: server.pid,
        startedBy: 'livekit-server',
        stopOnShutdown: false
      })
    })

    it('refuses to use a running server whose launch record carries no address, with what to do, and writes nothing', async () => {
      const server = await listener()
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      const theirs = await recordOf('livekit-server', { pid: server.pid, registry: 'redis-0000000000000000' })
      sidecarAnswers()

      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({
        status: 'error',
        statusHint: expect.stringMatching(/did not use the LiveKit server already running on port 7880: .*carries no address.*Update that Batshit and restart LiveKit there/)
      })
      expect(await folder('livekit-server')).toEqual({ '.batshit-local-runtime-launch.json': theirs })
    })

    it("uses an external server (no Batshit record) as before, recording and owning nothing", async () => {
      const server = await listener()
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      sidecarAnswers()

      const result = await startLiveKitSidecarRuntime('user-1')
      expect(result.server).toMatchObject({ status: 'ready' })
      expect(await readdir(stateRootAll)).toEqual([])
    })

    it("never uses another Batshit's sidecar, nor one no record names, and leaves both as they are (BL-1311)", async () => {
      const sidecar = await listener()
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(sidecar.port)

      // No record names it: unknown, whoever runs it.
      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({
        status: 'error',
        statusHint: expect.stringMatching(/no launch record of this Batshit names it/)
      })
      await expect(getLiveKitSidecarRuntimeSummary('user-1')).resolves.toMatchObject({
        status: 'error',
        statusHint: expect.stringMatching(/no launch record of this Batshit names it/)
      })

      // Another Batshit's launch, even one that records its address: refused, its record untouched.
      const theirs = await recordOf('livekit-sidecar', { pid: sidecar.pid, endpoint: `http://127.0.0.1:${sidecar.port}`, registry: 'redis-0000000000000000' })
      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({
        status: 'error',
        statusHint: expect.stringMatching(/Another Batshit's LiveKit agent runs on port \d+ and serves that Batshit/)
      })
      await expect(getLiveKitSidecarRuntimeSummary('user-1')).resolves.toMatchObject({ status: 'error' })
      expect(await folder('livekit-sidecar')).toEqual({ '.batshit-local-runtime-launch.json': theirs })
      expect(() => process.kill(sidecar.pid, 0)).not.toThrow()
    })

    it('uses its own running sidecar; its own launch without an address is refused, and restarted only on Start (BL-1311)', async () => {
      const reserved = await reservePort()
      const port = reserved.port
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(port)
      const pid = await launchOwnSidecarOn(reserved)

      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({ status: 'ready', alreadyRunning: true, pid })
      await expect(getLiveKitSidecarRuntimeSummary('user-1')).resolves.toMatchObject({ status: 'ready' })

      // The same launch, recorded without its address (as before this change): not verified.
      const recordPath = path.join(stateRootAll, 'livekit-sidecar', '.batshit-local-runtime-launch.json')
      const { endpoint: _endpoint, ...withoutAddress } = JSON.parse(await readFile(recordPath, 'utf8'))
      await writeFile(recordPath, JSON.stringify(withoutAddress))
      // Auto-start (no Start pressed) refuses and leaves it running: it launches nothing. A launch
      // here fails at once, so code that would relaunch fails on these assertions rather than
      // waiting out the sidecar's 20 s ready wait for the default fake launch.
      mockStartLocalVoiceRuntime.mockClear()
      mockStartLocalVoiceRuntime.mockRejectedValue(new Error('auto-start must not launch the sidecar'))
      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({
        status: 'error',
        statusHint: expect.stringMatching(/own LiveKit sidecar on port \d+ was started before its launch record carried its address.*Press Start/)
      })
      expect(mockStartLocalVoiceRuntime).not.toHaveBeenCalled()
      expect(() => process.kill(pid, 0)).not.toThrow()

      // Start pressed: it is stopped through the sole-ownership check and launched again, with its address.
      mockStartLocalVoiceRuntime.mockImplementation(async () => ({ pid: await launchOwnSidecarOn(port), logPath: '/tmp/livekit-sidecar.log' }))
      await expect(startLiveKitSidecarRuntime('user-1', { repairOwnLaunch: true })).resolves.toMatchObject({ status: 'ready', started: true })
      expect(await gone(pid)).toBe(true)
      expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({ endpoint: `http://127.0.0.1:${port}` })
    })

    it('admits a session dispatch only to its own running sidecar; the Docker add-on is outside (BL-1311)', async () => {
      // Nothing listens on the health port: not running. (A port released just for this: the
      // admission only reads, it never signals, so a process taking it meanwhile changes nothing.)
      const vacant = await reservePort()
      await new Promise((resolve) => vacant.server.close(resolve))
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(vacant.port)
      await expect(refuseLiveKitDispatchUnlessOwnSidecar()).resolves.toMatch(/The LiveKit agent is not running on port \d+/)

      // A worker no record names answers there: unknown, whoever runs it.
      const other = await listener()
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(other.port)
      await expect(refuseLiveKitDispatchUnlessOwnSidecar()).resolves.toMatch(/no launch record of this Batshit names it[\s\S]*did not send this session to it/)

      // Its own current sidecar launch: admitted.
      const reserved = await reservePort()
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(reserved.port)
      await launchOwnSidecarOn(reserved)
      await expect(refuseLiveKitDispatchUnlessOwnSidecar()).resolves.toBeNull()

      // Docker Batshit: its LiveKit add-on contract, not checked here.
      process.env.BATSHIT_CONTAINERIZED = '1'
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(other.port)
      await expect(refuseLiveKitDispatchUnlessOwnSidecar()).resolves.toBeNull()
    })

    it('a launched sidecar records its address', async () => {
      const port = testEnv.LIVEKIT_AGENT_HEALTH_PORT
      vi.stubGlobal(
        'fetch',
        vi.fn()
          .mockRejectedValueOnce(new Error('sidecar offline'))
          .mockResolvedValue(new Response(JSON.stringify({ agent_name: 'batshit-livekit-agent' }), { status: 200 }))
      )
      await startLiveKitSidecarRuntime('user-1')
      expect(mockStartLocalVoiceRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ engineId: 'livekit-sidecar', endpoint: `http://127.0.0.1:${port}` })
      )
    })

    it('gives the tidy the LiveKit runtimes in use, none when LiveKit is not configured, and throws when its settings cannot be read (BL-1300)', async () => {
      const port = testEnv.LIVEKIT_AGENT_HEALTH_PORT
      const refs = await resolveLiveKitRuntimeEngineRefs('user-1')
      expect(refs.map((ref) => [ref.id, ref.baseUrl])).toEqual([
        ['livekit-sidecar', `http://127.0.0.1:${port}`],
        ['livekit-server', 'http://127.0.0.1:7880']
      ])
      mockReadLiveKitConfig.mockResolvedValueOnce(null)
      expect(await resolveLiveKitRuntimeEngineRefs('user-1')).toEqual([])
      mockReadLiveKitConfig.mockRejectedValueOnce(new Error('redis down'))
      await expect(resolveLiveKitRuntimeEngineRefs('user-1')).rejects.toThrow('redis down')
    })

    it("syncs the saved choice to this Batshit's records only, and never syncs a default after a failed read (BL-1301)", async () => {
      const server = await listener()
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: server.pid, command: '/opt/x', endpoint: 'http://127.0.0.1:7880', stopOnShutdown: true })
      // Another Batshit's sidecar this Batshit could attach to (it records its address): never attached (BL-1311).
      const otherSidecar = await listener()
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(otherSidecar.port)
      const sidecarTheirs = await recordOf('livekit-sidecar', {
        pid: otherSidecar.pid,
        endpoint: `http://127.0.0.1:${otherSidecar.port}`,
        registry: 'redis-0000000000000000',
        stopOnShutdown: true
      })
      mockGetUserSettings.mockResolvedValue({ voice_settings: { voiceRuntimes: { livekit: { startup: { stopOnShutdown: false } } } } })

      await expect(syncLiveKitStopPreference('user-1')).resolves.toEqual({ complete: true, problems: [] })
      expect(JSON.parse((await folder('livekit-server'))['.batshit-local-runtime-launch.json']).stopOnShutdown).toBe(false)
      expect((await folder('livekit-sidecar'))['.batshit-local-runtime-launch.json']).toBe(sidecarTheirs)

      mockGetUserSettings.mockRejectedValueOnce(new Error('redis down'))
      await expect(syncLiveKitStopPreference('user-1')).rejects.toThrow('redis down')
      expect(JSON.parse((await folder('livekit-server'))['.batshit-local-runtime-launch.json']).stopOnShutdown).toBe(false)
    })

    // ---- Review fixes: launches that lose the port, uses that become unrecorded, close saves ----

    it("records the use when this Batshit's launch lost the port to another Batshit's server", async () => {
      const server = await listener()
      mockFetchLiveKitServerReady.mockResolvedValueOnce(false)
      const installer = await import('$lib/server/services/liveKitNativeRuntimeInstaller')
      vi.mocked(installer.startNativeLiveKitServerRuntime).mockResolvedValueOnce({
        started: true,
        alreadyRunning: false,
        pid: 999_999,
        logPath: null,
        statusHint: 'Native LiveKit server is reachable at http://127.0.0.1:7880.'
      })
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      await recordOf('livekit-server', { pid: server.pid, endpoint: 'http://127.0.0.1:7880', registry: 'redis-0000000000000000' })
      // This Batshit's own sidecar, on a port of the test's own: a started server restarts it (never
      // whatever else listens on the default port of the machine running the tests).
      const reserved = await reservePort()
      const port = reserved.port
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(port)
      const before = await launchOwnSidecarOn(reserved)
      mockStartLocalVoiceRuntime.mockImplementation(async () => ({ pid: await launchOwnSidecarOn(port), logPath: '/tmp/livekit-sidecar.log' }))

      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({ status: 'ready', started: true })
      expect(JSON.parse((await folder('livekit-server'))['.batshit-local-runtime-launch.json'])).toMatchObject({
        pid: server.pid,
        startedBy: 'livekit-server'
      })
      expect(await gone(before)).toBe(true)
    })

    it("refuses another Batshit's sidecar that answers after this Batshit's launch (BL-1311)", async () => {
      const sidecar = await listener()
      testEnv.LIVEKIT_AGENT_HEALTH_PORT = String(sidecar.port)
      const legacy = await recordOf('livekit-sidecar', { pid: sidecar.pid, registry: 'redis-0000000000000000' })
      vi.stubGlobal(
        'fetch',
        vi.fn()
          .mockRejectedValueOnce(new Error('sidecar offline'))
          .mockResolvedValue(new Response(JSON.stringify({ agent_name: 'batshit-livekit-agent' }), { status: 200 }))
      )

      await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({
        status: 'error',
        statusHint: expect.stringMatching(/Another Batshit's LiveKit agent runs on port \d+ and serves that Batshit/)
      })
      expect(await folder('livekit-sidecar')).toEqual({ '.batshit-local-runtime-launch.json': legacy })
    })

    it('says in the row when this Batshit uses another Batshit\'s running LiveKit with no record of it, until it records it', async () => {
      const server = await listener()
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      await recordOf('livekit-server', { pid: server.pid, endpoint: 'http://127.0.0.1:7880', registry: 'redis-0000000000000000' })
      sidecarAnswers()

      await expect(getLiveKitSidecarRuntimeSummary('user-1')).resolves.toMatchObject({
        statusHint: expect.stringContaining('uses the running LiveKit server another Batshit started, but has no record of that use')
      })
      await startLiveKitSidecarRuntime('user-1')
      expect((await getLiveKitSidecarRuntimeSummary('user-1')).statusHint).not.toContain('no record of that use')
    })

    it('writes the latest saved choice when a save lands while the sync writes (two saves close together)', async () => {
      const server = await listener()
      mockInspectLocalLiveKitPortOwner.mockResolvedValue({ pids: [server.pid], commands: ['livekit-server'], dockerOwned: false })
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: server.pid, command: '/opt/x', endpoint: 'http://127.0.0.1:7880' })
      const keep = { voice_settings: { voiceRuntimes: { livekit: { startup: { stopOnShutdown: false } } } } }
      const stop = { voice_settings: { voiceRuntimes: { livekit: { startup: { stopOnShutdown: true } } } } }
      // The sync reads "keep"; by the time it has written, "stop" is saved.
      mockGetUserSettings.mockResolvedValueOnce(keep).mockResolvedValue(stop)

      await expect(syncLiveKitStopPreference('user-1')).resolves.toMatchObject({ complete: true })
      expect(JSON.parse((await folder('livekit-server'))['.batshit-local-runtime-launch.json']).stopOnShutdown).not.toBe(false)
    })

    it("shows in the LiveKit row when a running launch record does not hold the saved choice (BL-1301)", async () => {
      const server = await listener()
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: server.pid, command: '/opt/x', stopOnShutdown: true })
      mockGetUserSettings.mockResolvedValue({ voice_settings: { voiceRuntimes: { livekit: { startup: { stopOnShutdown: false } } } } })
      sidecarAnswers()

      await expect(getLiveKitSidecarRuntimeSummary('user-1')).resolves.toMatchObject({
        statusHint: expect.stringContaining('Your saved Stop with Batshit choice has not reached the running LiveKit yet')
      })
      mockGetUserSettings.mockResolvedValue({ voice_settings: { voiceRuntimes: { livekit: { startup: { stopOnShutdown: true } } } } })
      const agreed = await getLiveKitSidecarRuntimeSummary('user-1')
      expect(agreed.statusHint).not.toContain('Stop with Batshit choice')
    })
  })

  // BL-1297: the sidecar's restart used to signal every listener on its health port. Another
  // Batshit's sidecar, or one the user runs, answers there too. A real detached "sidecar" stands
  // in: a launcher that leads its own process group, with the listener as its CHILD (as tsx runs
  // the worker), optionally ignoring SIGTERM so the forced stop is reached.
  describe('stopLiveKitSidecarOnPort stops only this Batshit\'s own sidecar launch (BL-1297)', () => {
    const originalStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    const originalPath = process.env.PATH
    let stateRoot: string
    let launcher: ChildProcess | null = null

    const LAUNCHER = `
      const { spawn } = require('child_process')
      const ignore = process.argv[2] === 'ignore-term'
      if (ignore) process.on('SIGTERM', () => {})
      const child = spawn(process.execPath, [process.argv[3], String(ignore)], { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', (chunk) => process.stdout.write(chunk))
      setInterval(() => {}, 1000)
    `
    const LISTENER = `
      if (process.argv[2] === 'true') process.on('SIGTERM', () => {})
      const server = require('http').createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ agent_name: 'batshit-livekit-agent' }))
      })
      server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + ' ' + process.pid))
    `

    beforeEach(async () => {
      stateRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-sidecar-records-'))
      fixtureRoots.push(stateRoot)
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
      // The listener comes from `lsof`, which lives in /usr/sbin on macOS.
      process.env.PATH = `${originalPath ?? ''}${path.delimiter}/usr/sbin`
    })

    afterEach(() => {
      if (originalStateRoot === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
      else process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalStateRoot
      process.env.PATH = originalPath
      killOwnGroup(launcher)
      launcher = null
    })

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    async function startSidecar(options: { ignoreTerm?: boolean } = {}) {
      const launcherFile = path.join(stateRoot, 'launcher.cjs')
      const listenerFile = path.join(stateRoot, 'listener.cjs')
      await writeFile(launcherFile, LAUNCHER)
      await writeFile(listenerFile, LISTENER)
      launcher = spawn(process.execPath, [launcherFile, options.ignoreTerm ? 'ignore-term' : 'plain', listenerFile], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const [port, listenerPid] = await new Promise<number[]>((resolve) =>
        launcher?.stdout?.once('data', (chunk) => resolve(String(chunk).split(' ').map(Number)))
      )
      return { port, launchPid: launcher.pid as number, listenerPid, launcherFile }
    }

    async function recordLaunch(sidecar: { launchPid: number; launcherFile: string }, registry?: string | null) {
      const record = {
        engineId: 'livekit-sidecar',
        pid: sidecar.launchPid,
        command: process.execPath,
        args: [sidecar.launcherFile],
        launchedAt: new Date().toISOString()
      }
      if (registry === undefined) return writeLocalRuntimeLaunchRecord(record)
      const dir = path.join(stateRoot, 'livekit-sidecar')
      await mkdir(dir, { recursive: true })
      const contents = JSON.stringify({ ...record, ...(registry ? { registry } : {}) })
      await writeFile(path.join(dir, '.batshit-local-runtime-launch.json'), contents)
      return contents
    }

    it('stops its own launch as a process group, its child listener included', async () => {
      const sidecar = await startSidecar()
      expect(sidecar.listenerPid).not.toBe(sidecar.launchPid)
      await recordLaunch(sidecar)

      await expect(stopLiveKitSidecarOnPort(sidecar.port)).resolves.toBe(true)
      expect(await gone(sidecar.launchPid)).toBe(true)
      expect(await gone(sidecar.listenerPid)).toBe(true)
    })

    it("refuses another Batshit's sidecar visibly, keeps it running, and leaves its record's bytes", async () => {
      const sidecar = await startSidecar()
      const contents = await recordLaunch(sidecar, 'redis-0000000000000000')

      await expect(stopLiveKitSidecarOnPort(sidecar.port)).rejects.toThrow(
        /did not restart the LiveKit sidecar on port \d+: another Batshit on this computer, or another engine, also uses it/
      )
      expect(alive(sidecar.launchPid)).toBe(true)
      expect(alive(sidecar.listenerPid)).toBe(true)
      expect(await readFile(path.join(stateRoot, 'livekit-sidecar', '.batshit-local-runtime-launch.json'), 'utf8')).toBe(contents)
    })

    it('refuses a sidecar no record names (one the user runs), and one whose record cannot be read', async () => {
      const sidecar = await startSidecar()
      await expect(stopLiveKitSidecarOnPort(sidecar.port)).rejects.toThrow(/but Batshit did not start that process, so it did not restart it/)
      expect(alive(sidecar.listenerPid)).toBe(true)

      await mkdir(path.join(stateRoot, 'kokoro'), { recursive: true })
      await writeFile(path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.json'), '{ "pid": 12')
      await recordLaunch(sidecar)
      await expect(stopLiveKitSidecarOnPort(sidecar.port)).rejects.toThrow(/cannot tell whether that record names this sidecar/)
      expect(alive(sidecar.launchPid)).toBe(true)
      expect(alive(sidecar.listenerPid)).toBe(true)
    })

    it('forces a launch that ignores SIGTERM only after checking it again', async () => {
      const sidecar = await startSidecar({ ignoreTerm: true })
      await recordLaunch(sidecar)

      await expect(stopLiveKitSidecarOnPort(sidecar.port)).resolves.toBe(true)
      expect(await gone(sidecar.launchPid)).toBe(true)
      expect(await gone(sidecar.listenerPid)).toBe(true)
    }, 20_000)

    it('never forces it when another Batshit recorded a use of it while it was stopping', async () => {
      const sidecar = await startSidecar({ ignoreTerm: true })
      await recordLaunch(sidecar)
      // During the SIGTERM wait, another Batshit's record of the same process appears beside it.
      setTimeout(() => {
        void writeFile(
          path.join(stateRoot, 'livekit-sidecar', `.batshit-local-runtime-launch.${sidecar.launchPid}.json`),
          JSON.stringify({ engineId: 'livekit-sidecar', pid: sidecar.launchPid, command: process.execPath, registry: 'redis-0000000000000000' })
        )
      }, 1_000)

      await expect(stopLiveKitSidecarOnPort(sidecar.port)).rejects.toThrow(/another Batshit on this computer, or another engine, also uses it/)
      expect(alive(sidecar.launchPid)).toBe(true)
      expect(alive(sidecar.listenerPid)).toBe(true)
    }, 20_000)

    it('never forces it when its own record names another launch by then', async () => {
      const sidecar = await startSidecar({ ignoreTerm: true })
      await recordLaunch(sidecar)
      // During the wait the record is rewritten for a later launch of the same pid (a relaunch).
      setTimeout(() => {
        void writeLocalRuntimeLaunchRecord({
          engineId: 'livekit-sidecar',
          pid: sidecar.launchPid,
          command: process.execPath,
          args: [sidecar.launcherFile],
          launchedAt: new Date(Date.now() + 1).toISOString()
        })
      }, 1_000)

      await expect(stopLiveKitSidecarOnPort(sidecar.port)).rejects.toThrow(/changed while it was stopping, so Batshit did not force it to stop/)
      expect(alive(sidecar.launchPid)).toBe(true)
      expect(alive(sidecar.listenerPid)).toBe(true)
    }, 20_000)
  })
})
