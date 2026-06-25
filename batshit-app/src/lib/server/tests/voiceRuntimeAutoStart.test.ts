import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockListVoiceEngineRecords = vi.fn()
const mockUpsertVoiceEngineRecord = vi.fn()
const mockInspectByoSpeechRuntimeForRecord = vi.fn()
const mockStartLocalVoiceRuntime = vi.fn()
const mockStartHostVoiceRuntimeViaOperator = vi.fn()
const mockAutoStartLiveKitSidecarRuntime = vi.fn()

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  listVoiceEngineRecords: (...args: any[]) => mockListVoiceEngineRecords(...args),
  upsertVoiceEngineRecord: (...args: any[]) => mockUpsertVoiceEngineRecord(...args)
}))

vi.mock('$lib/server/services/voiceService', () => ({
  inspectByoSpeechRuntimeForRecord: (...args: any[]) => mockInspectByoSpeechRuntimeForRecord(...args)
}))

vi.mock('$lib/server/services/voiceLocalEngineSetup', () => ({
  resolveManagedInstallsRoot: () =>
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT || path.join(os.homedir(), '.batshit', 'installs'),
  resolveLocalVoiceRuntimeLogPath: (engineId: string) =>
    path.join(
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT || path.join(os.homedir(), '.batshit', 'runtime', 'voice-engines'),
      engineId,
      'logs',
      'local-engine-runtime.log'
    ),
  startLocalVoiceRuntime: (...args: any[]) => mockStartLocalVoiceRuntime(...args)
}))

vi.mock('$lib/server/services/voiceHostOperatorRuntime', () => ({
  startHostVoiceRuntimeViaOperator: (...args: any[]) => mockStartHostVoiceRuntimeViaOperator(...args)
}))

vi.mock('$lib/server/services/liveKitSidecarRuntime', () => ({
  autoStartLiveKitSidecarRuntime: (...args: any[]) => mockAutoStartLiveKitSidecarRuntime(...args)
}))

describe('voiceRuntimeAutoStart', () => {
  let tempRoot: string
  let runtimeStateRoot: string
  let originalManagedInstallsRoot: string | undefined
  let originalVoiceRuntimeStateRoot: string | undefined
  let originalContainerized: string | undefined
  let originalRuntimeEnv: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mockAutoStartLiveKitSidecarRuntime.mockResolvedValue(null)
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-runtime-auto-start-'))
    runtimeStateRoot = path.join(tempRoot, 'runtime-state')
    originalManagedInstallsRoot = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    originalVoiceRuntimeStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    originalContainerized = process.env.BATSHIT_CONTAINERIZED
    originalRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = tempRoot
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = runtimeStateRoot
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    if (typeof originalManagedInstallsRoot === 'string') {
      process.env.BATSHIT_MANAGED_INSTALLS_ROOT = originalManagedInstallsRoot
    } else {
      delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    }
    if (typeof originalVoiceRuntimeStateRoot === 'string') {
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalVoiceRuntimeStateRoot
    } else {
      delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    }
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
  })

  it('starts stored local runtimes when auto-start is enabled and the engine is offline', async () => {
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'kokoro',
        name: 'Kokoro TTS (MLX)',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8010',
        ttsPath: '/v1/audio/speech',
        healthPath: '/v1/models',
        requestFormat: 'openai-compatible',
        localRuntime: {
          installRoot: '/Users/example/.batshit/installs/kokoro',
          installOwnership: 'batshit-managed',
          launch: {
            command: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
            args: ['--host', '127.0.0.1', '--port', '8010'],
            logPath: '/Users/example/.batshit/runtime/voice-engines/kokoro/logs/local-engine-runtime.log'
          },
          startup: {
            autoStartOnLaunch: true
          }
        }
      }
    ])

    mockInspectByoSpeechRuntimeForRecord
      .mockResolvedValueOnce({
        ready: false,
        reachable: false,
        state: 'unreachable',
        statusHint: 'Connection refused'
      })
      .mockResolvedValueOnce({
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      })

    mockStartLocalVoiceRuntime.mockResolvedValue({
      installRoot: '/Users/example/.batshit/installs/kokoro',
      installOwnership: 'batshit-managed',
      launchCwd: '/Users/example/.batshit/installs/kokoro',
      logPath: '/Users/example/.batshit/runtime/voice-engines/kokoro/logs/local-engine-runtime.log',
      launchCommand: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
      launchArgs: ['--host', '127.0.0.1', '--port', '8010'],
      launchEnv: {},
      pid: 4242
    })

    const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')

    const report = await ensureVoiceRuntimesAutoStarted('user-1')

    expect(mockStartLocalVoiceRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        engineId: 'kokoro',
        installRoot: '/Users/example/.batshit/installs/kokoro'
      })
    )
    expect(report.skippedBecauseRecent).toBe(false)
    expect(report.results).toEqual([
      expect.objectContaining({
        engineId: 'kokoro',
        providerId: 'byo:kokoro',
        status: 'started',
        pid: 4242
      })
    ])
  })

  it('backfills legacy MLX runtime metadata when only the startup toggle is stored', async () => {
    const installRoot = path.join(tempRoot, 'chatterbox-turbo')

    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'chatterbox-turbo',
        name: 'Chatterbox Turbo (MLX)',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8012',
        ttsPath: '/v1/audio/speech',
        healthPath: '/v1/models',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16'
        },
        localRuntime: {
          startup: {
            autoStartOnLaunch: true
          }
        }
      }
    ])

    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: false,
      record: {
        id: 'chatterbox-turbo',
        name: 'Chatterbox Turbo (MLX)',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8012',
        ttsPath: '/v1/audio/speech',
        healthPath: '/v1/models',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16'
        },
        localRuntime: {
          installRoot,
          installOwnership: 'batshit-managed',
          launch: {
            command: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
            args: ['--host', '127.0.0.1', '--port', '8012'],
            logPath: path.join(runtimeStateRoot, 'chatterbox-turbo', 'logs', 'local-engine-runtime.log')
          },
          startup: {
            autoStartOnLaunch: true
          }
        }
      },
      summary: {
        id: 'chatterbox-turbo',
        providerId: 'byo:chatterbox-turbo',
        name: 'Chatterbox Turbo (MLX)',
        enabled: true,
        localRuntime: {
          installOwnership: 'batshit-managed',
          startup: {
            autoStartOnLaunch: true
          }
        }
      }
    })

    mockInspectByoSpeechRuntimeForRecord
      .mockResolvedValueOnce({
        ready: false,
        reachable: false,
        state: 'unreachable',
        statusHint: 'Connection refused'
      })
      .mockResolvedValueOnce({
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      })

    mockStartLocalVoiceRuntime.mockResolvedValue({
      installRoot,
      installOwnership: 'batshit-managed',
      launchCwd: installRoot,
      logPath: path.join(runtimeStateRoot, 'chatterbox-turbo', 'logs', 'local-engine-runtime.log'),
      launchCommand: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
      launchArgs: ['--host', '127.0.0.1', '--port', '8012'],
      launchEnv: {},
      pid: 5252
    })

    const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')

    const report = await ensureVoiceRuntimesAutoStarted('user-1')

    expect(mockUpsertVoiceEngineRecord).toHaveBeenCalledWith(
      'user-1',
      'chatterbox-turbo',
      expect.objectContaining({
        localRuntime: expect.objectContaining({
          installRoot,
          installOwnership: 'batshit-managed',
          launch: expect.objectContaining({
            command: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
            args: ['--host', '127.0.0.1', '--port', '8012']
          }),
          startup: {
            autoStartOnLaunch: true
          }
        })
      })
    )
    expect(report.results).toEqual([
      expect.objectContaining({
        engineId: 'chatterbox-turbo',
        status: 'started',
        pid: 5252
      })
    ])
  })

  it('auto-starts saved host-native voice runtimes through the host operator in Docker', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'kokoro',
        name: 'Kokoro TTS (MLX)',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8010',
        ttsPath: '/v1/audio/speech',
        healthPath: '/v1/models',
        requestFormat: 'openai-compatible',
        localRuntime: {
          installRoot: '/Users/example/.batshit/installs/kokoro',
          installOwnership: 'batshit-managed',
          launch: {
            command: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
            args: ['--host', '127.0.0.1', '--port', '8010']
          },
          startup: {
            autoStartOnLaunch: true
          }
        }
      }
    ])
    mockInspectByoSpeechRuntimeForRecord
      .mockResolvedValueOnce({
        ready: false,
        reachable: false,
        state: 'unreachable',
        statusHint: 'connect ECONNREFUSED'
      })
      .mockResolvedValueOnce({
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      })
    mockStartHostVoiceRuntimeViaOperator.mockResolvedValue({
      success: true,
      engineId: 'kokoro',
      pid: 6161,
      logPath: '/Users/example/.batshit/runtime/voice-engines/kokoro/logs/local-engine-runtime.log'
    })

    const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')

    const report = await ensureVoiceRuntimesAutoStarted('user-1')

    expect(mockStartLocalVoiceRuntime).not.toHaveBeenCalled()
    expect(mockStartHostVoiceRuntimeViaOperator).toHaveBeenCalledWith(
      expect.objectContaining({
        engineId: 'kokoro',
        installRoot: '/Users/example/.batshit/installs/kokoro',
        launch: expect.objectContaining({
          command: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server'
        })
      })
    )
    expect(report.results).toEqual([
      expect.objectContaining({
        engineId: 'kokoro',
        providerId: 'byo:kokoro',
        status: 'started',
        pid: 6161
      })
    ])
  })

  it('includes LiveKit voice runtime auto-start results when the runtime toggle is enabled', async () => {
    mockListVoiceEngineRecords.mockResolvedValue([])
    mockAutoStartLiveKitSidecarRuntime.mockResolvedValue({
      id: 'livekit',
      status: 'ready',
      statusHint: 'Sidecar worker is ready as batshit-livekit-agent.',
      started: true,
      alreadyRunning: false,
      pid: 6262
    })

    const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')

    const report = await ensureVoiceRuntimesAutoStarted('user-1')

    expect(mockAutoStartLiveKitSidecarRuntime).toHaveBeenCalledWith('user-1')
    expect(report.results).toEqual([
      expect.objectContaining({
        kind: 'voice-session-runtime',
        runtimeId: 'livekit',
        status: 'started',
        pid: 6262
      })
    ])
  })
})
