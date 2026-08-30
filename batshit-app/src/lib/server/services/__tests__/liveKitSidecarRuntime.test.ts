import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
let mockSidecarInstallRoot = ''

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
    getUserSettings: vi.fn(async () => null)
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
  resolveLiveKitVoiceRuntimeConfigForUser: vi.fn(async () => ({
    serverUrl: 'ws://127.0.0.1:7880',
    dispatchServerUrl: 'ws://127.0.0.1:7880',
    apiKey: 'batshit-local',
    apiSecret: 'secret',
    tokenTtlSec: 600,
    roomPrefix: 'batshit-voice',
    selfHosted: true,
    agentName: 'batshit-livekit-agent',
    autoDispatchAgent: true
  }))
}))

vi.mock('$lib/server/services/liveKitNativeRuntimeInstaller', () => ({
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
  startLiveKitSidecarRuntime
} from '$lib/server/services/liveKitSidecarRuntime'

describe('liveKitSidecarRuntime', () => {
  let originalContainerized: string | undefined
  let originalRuntimeEnv: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    originalContainerized = process.env.BATSHIT_CONTAINERIZED
    originalRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
    mockSidecarInstallRoot = await mkdtemp(path.join(tmpdir(), 'batshit-livekit-sidecar-'))
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
  })

  afterEach(() => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockRejectedValueOnce(new Error('sidecar offline'))
        .mockResolvedValue({
          ok: true,
          json: async () => ({ agent_name: 'batshit-livekit-agent', active_jobs: 0 })
        })
    )

    await expect(startLiveKitSidecarRuntime('user-1')).resolves.toMatchObject({
      status: 'ready',
      started: true,
      pid: 4242
    })
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
})
