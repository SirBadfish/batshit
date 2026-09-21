import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockListVoiceEngineRecords = vi.fn()
const mockUpsertVoiceEngineRecord = vi.fn()
const mockInspectByoSpeechRuntimeForRecord = vi.fn()
const mockStartLocalVoiceRuntime = vi.fn()
const mockStartHostVoiceRuntimeViaOperator = vi.fn()
const mockRegisterHostVoiceRuntimeShutdown = vi.fn()
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
  startHostVoiceRuntimeViaOperator: (...args: any[]) => mockStartHostVoiceRuntimeViaOperator(...args),
  registerHostVoiceRuntimeShutdown: (...args: any[]) => mockRegisterHostVoiceRuntimeShutdown(...args)
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
            autoStartOnLaunch: true,
            // A backfilled legacy recipe carries the default stop choice, so
            // the launch record it produces is not missing the field.
            stopOnShutdown: true
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
        }),
        // The operator records the listener it serves and the choice (absent means stop).
        endpoint: 'http://127.0.0.1:8010',
        stopOnShutdown: true
      })
    )
    // The operator started it, so the operator stops it when this container shuts down; the
    // shutdown reads the user's engines then, so a toggle made since boot is honored.
    expect(mockRegisterHostVoiceRuntimeShutdown).toHaveBeenCalledTimes(1)
    const listEngines = mockRegisterHostVoiceRuntimeShutdown.mock.calls[0][0]
    mockListVoiceEngineRecords.mockClear()
    await listEngines()
    expect(mockListVoiceEngineRecords).toHaveBeenCalledWith('user-1')
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

  it('hands each engine its own Stop with Batshit choice at launch', async () => {
    // startLocalVoiceRuntime writes this into the launch record, which is the
    // ONLY thing the Mac supervisor and the native launcher read at shutdown.
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'stays-up',
        name: 'Stays Up',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8090',
        localRuntime: {
          installRoot: '/tmp/stays-up',
          installOwnership: 'batshit-managed',
          launch: { command: '/tmp/stays-up/bin/engine' },
          startup: { autoStartOnLaunch: true, stopOnShutdown: false }
        }
      },
      {
        id: 'never-chose',
        name: 'Never Chose',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8091',
        localRuntime: {
          installRoot: '/tmp/never-chose',
          installOwnership: 'batshit-managed',
          launch: { command: '/tmp/never-chose/bin/engine' },
          startup: { autoStartOnLaunch: true }
        }
      }
    ])
    // Per engine: the pre-launch check says unreachable, the readiness poll
    // right after the launch says ready, so neither engine sits in the 45 s
    // readiness loop.
    let inspectCalls = 0
    mockInspectByoSpeechRuntimeForRecord.mockImplementation(async () => {
      inspectCalls += 1
      return inspectCalls % 2 === 1
        ? { ready: false, reachable: false, state: 'unreachable', statusHint: 'connect ECONNREFUSED' }
        : { ready: true, reachable: true, state: 'ready', statusHint: 'Health check passed.' }
    })
    mockStartLocalVoiceRuntime.mockResolvedValue({ pid: 7171 })

    const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')
    await ensureVoiceRuntimesAutoStarted('user-1')

    const byEngineId = Object.fromEntries(
      mockStartLocalVoiceRuntime.mock.calls.map(([options]: any[]) => [
        options.engineId,
        options.stopOnShutdown
      ])
    )
    expect(byEngineId['stays-up']).toBe(false)
    expect(byEngineId['never-chose']).toBe(true)
  })

  it('hands the launch the listener it serves, for engines that share it', async () => {
    mockListVoiceEngineRecords.mockResolvedValue([
      {
        id: 'chatterbox-turbo',
        name: 'Chatterbox Turbo',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8012',
        localRuntime: {
          installRoot: '/tmp/chatterbox-turbo',
          installOwnership: 'batshit-managed',
          launch: { command: '/tmp/mlx_audio.server', args: ['--port', '8012'] },
          startup: { autoStartOnLaunch: true }
        }
      }
    ])
    mockInspectByoSpeechRuntimeForRecord
      .mockResolvedValueOnce({ ready: false, reachable: false, state: 'unreachable' })
      .mockResolvedValueOnce({ ready: true, reachable: true, state: 'ready' })
    mockStartLocalVoiceRuntime.mockResolvedValue({ pid: 7272 })

    const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')
    await ensureVoiceRuntimesAutoStarted('user-1')

    expect(mockStartLocalVoiceRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ engineId: 'chatterbox-turbo', endpoint: 'http://127.0.0.1:8012' })
    )
  })

  describe('an engine that uses a runtime it did not start', () => {
    // Real launch records under the throwaway runtimeStateRoot; this test process stands in for
    // the running runtime, because the record has to name a live process.
    async function writeStarterRecord(endpoint: string) {
      await mkdir(path.join(runtimeStateRoot, 'chatterbox-turbo'), { recursive: true })
      await writeFile(
        path.join(runtimeStateRoot, 'chatterbox-turbo', '.batshit-local-runtime-launch.json'),
        JSON.stringify({
          engineId: 'chatterbox-turbo',
          pid: process.pid,
          command: '/Users/example/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
          args: ['--port', '8012'],
          endpoint,
          launchedAt: '2026-09-17T01:00:03.000Z'
        })
      )
    }

    function kokoroOn(port: number, startup: Record<string, boolean>) {
      return {
        id: 'kokoro',
        name: 'Kokoro',
        enabled: true,
        baseUrl: `http://localhost:${port}`,
        localRuntime: {
          installRoot: '/tmp/kokoro',
          installOwnership: 'batshit-managed',
          launch: { command: '/tmp/mlx_audio.server', args: ['--port', String(port)] },
          startup
        }
      }
    }

    it('records its own Stop with Batshit choice beside the launch that started it', async () => {
      await writeStarterRecord('http://127.0.0.1:8012')
      // "Start with Batshit" is off for kokoro, and the runtime is up: it still records.
      mockListVoiceEngineRecords.mockResolvedValue([kokoroOn(8012, { stopOnShutdown: false })])

      const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')
      await ensureVoiceRuntimesAutoStarted('user-1')

      expect(mockStartLocalVoiceRuntime).not.toHaveBeenCalled()
      const record = JSON.parse(
        await readFile(path.join(runtimeStateRoot, 'kokoro', '.batshit-local-runtime-launch.json'), 'utf8')
      )
      expect(record).toMatchObject({
        engineId: 'kokoro',
        pid: process.pid,
        startedBy: 'chatterbox-turbo',
        stopOnShutdown: false,
        launchedAt: '2026-09-17T01:00:03.000Z'
      })
    })

    it('drops this registry\'s attach records for engines no longer in it', async () => {
      await writeStarterRecord('http://127.0.0.1:8012')
      const { attachLocalRuntimeLaunchRecord } = await import('../services/voiceRuntimeLaunchRecords')
      // Recorded while it existed; deleted since (say, by a Batshit that crashed before tidying).
      await attachLocalRuntimeLaunchRecord({ engineId: 'deleted-engine', endpoint: 'http://127.0.0.1:8012', stopOnShutdown: false })
      mockListVoiceEngineRecords.mockResolvedValue([kokoroOn(8012, { stopOnShutdown: true })])

      const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')
      await ensureVoiceRuntimesAutoStarted('user-1')

      expect(await readdir(path.join(runtimeStateRoot, 'deleted-engine')).catch(() => [])).toEqual([])
      expect(
        JSON.parse(await readFile(path.join(runtimeStateRoot, 'kokoro', '.batshit-local-runtime-launch.json'), 'utf8'))
      ).toMatchObject({ startedBy: 'chatterbox-turbo', stopOnShutdown: true })
    })

    it('records nothing for a runtime no Batshit launch serves', async () => {
      // Something answers on 8013, but no launch record names it: Batshit did not start it.
      await writeStarterRecord('http://127.0.0.1:8012')
      mockListVoiceEngineRecords.mockResolvedValue([kokoroOn(8013, { autoStartOnLaunch: true })])
      mockInspectByoSpeechRuntimeForRecord.mockResolvedValue({ ready: true, reachable: true, state: 'ready' })

      const { ensureVoiceRuntimesAutoStarted } = await import('../services/voiceRuntimeAutoStart')
      const report = await ensureVoiceRuntimesAutoStarted('user-1')

      expect(report.results).toEqual([expect.objectContaining({ engineId: 'kokoro', status: 'already-running' })])
      expect((await readdir(runtimeStateRoot)).sort()).toEqual(['chatterbox-turbo'])
    })
  })
})
