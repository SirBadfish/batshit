import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockInspectByoSpeechRuntimeForRecord = vi.fn()
const mockListByoVoicesForRecord = vi.fn()
const mockSynthesizeByoSpeechForRecord = vi.fn()
const mockTranscribeByoSpeechForRecord = vi.fn()
const mockCheckByoSpeechStatus = vi.fn()
const mockUpsertVoiceEngineRecord = vi.fn()
const mockSetVoiceEngineEnabled = vi.fn()
const mockSpawn = vi.fn()
const mockRetrieveApiKey = vi.fn()

vi.mock('$lib/server/services/voiceService', () => ({
  inspectByoSpeechRuntimeForRecord: (...args: any[]) => mockInspectByoSpeechRuntimeForRecord(...args),
  listByoVoicesForRecord: (...args: any[]) => mockListByoVoicesForRecord(...args),
  synthesizeByoSpeechForRecord: (...args: any[]) => mockSynthesizeByoSpeechForRecord(...args),
  transcribeByoSpeechForRecord: (...args: any[]) => mockTranscribeByoSpeechForRecord(...args),
  checkByoSpeechStatus: (...args: any[]) => mockCheckByoSpeechStatus(...args)
}))

vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  upsertVoiceEngineRecord: (...args: any[]) => mockUpsertVoiceEngineRecord(...args),
  setVoiceEngineEnabled: (...args: any[]) => mockSetVoiceEngineEnabled(...args)
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: (...args: any[]) => mockRetrieveApiKey(...args)
  },
  isUserFacingApiKeyService: (service: string) => !new Set([
    'batshit_token',
    'n8n_internal_key',
    'n8n_api_key',
    'n8n_api_url',
    'batshit_artifact_complete_url',
    'n8n_instance_mcp_token',
    'ai_gateway'
  ]).has(service.trim().toLowerCase()),
  normalizeApiKeyServiceName: (service: string) => service.trim().toLowerCase()
}))

vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  default: {
    spawn: (...args: any[]) => mockSpawn(...args)
  }
}))

describe('voiceLocalEngineSetup', () => {
  let tempRoot: string
  let installRoot: string
  let runtimeStateRoot: string
  let homeScopedTempRoot: string | null
  let originalManagedInstallsRootEnv: string | undefined
  let originalVoiceRuntimeStateRootEnv: string | undefined
  let originalContainerizedEnv: string | undefined
  let originalRuntimeEnv: string | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    homeScopedTempRoot = null
    originalManagedInstallsRootEnv = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    originalVoiceRuntimeStateRootEnv = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    originalContainerizedEnv = process.env.BATSHIT_CONTAINERIZED
    originalRuntimeEnv = process.env.BATSHIT_RUNTIME_ENV
    delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-local-setup-'))
    installRoot = path.join(tempRoot, 'engine')
    runtimeStateRoot = path.join(tempRoot, 'runtime-state')
    await mkdir(installRoot, { recursive: true })
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = runtimeStateRoot

    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        unref: ReturnType<typeof vi.fn>
      }
      child.pid = 4242
      child.unref = vi.fn()
      setTimeout(() => child.emit('spawn'), 0)
      return child
    })
    mockRetrieveApiKey.mockResolvedValue(null)
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    if (homeScopedTempRoot) {
      await rm(homeScopedTempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    if (typeof originalManagedInstallsRootEnv === 'string') {
      process.env.BATSHIT_MANAGED_INSTALLS_ROOT = originalManagedInstallsRootEnv
    } else {
      delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    }
    if (typeof originalVoiceRuntimeStateRootEnv === 'string') {
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalVoiceRuntimeStateRootEnv
    } else {
      delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    }
    if (typeof originalContainerizedEnv === 'string') {
      process.env.BATSHIT_CONTAINERIZED = originalContainerizedEnv
    } else {
      delete process.env.BATSHIT_CONTAINERIZED
    }
    if (typeof originalRuntimeEnv === 'string') {
      process.env.BATSHIT_RUNTIME_ENV = originalRuntimeEnv
    } else {
      delete process.env.BATSHIT_RUNTIME_ENV
    }
  })

  async function createManagedInstallRoot(engineId = 'chatterbox-local'): Promise<string> {
    const managedRoot = path.join(tempRoot, 'managed-installs')
    const managedInstallRoot = path.join(managedRoot, engineId)
    await mkdir(path.join(managedInstallRoot, 'logs'), { recursive: true })
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = managedRoot
    return await realpath(managedInstallRoot)
  }

  function mockSuccessfulReadyTtsEngine(engineId = 'chatterbox-local'): void {
    mockInspectByoSpeechRuntimeForRecord.mockResolvedValueOnce({
      ready: true,
      reachable: true,
      state: 'ready',
      statusHint: 'Health check passed.'
    })
    mockListByoVoicesForRecord.mockResolvedValue([
      {
        id: 'alloy',
        name: 'Alloy',
        provider: `byo:${engineId}`
      }
    ])
    mockSynthesizeByoSpeechForRecord.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
      voiceId: 'alloy',
      provider: `byo:${engineId}`,
      model: 'mlx-community/chatterbox-turbo-fp16'
    })
    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: true,
      record: { id: engineId },
      summary: {
        id: engineId,
        providerId: `byo:${engineId}`,
        name: 'Chatterbox Local',
        enabled: false
      }
    })
    mockCheckByoSpeechStatus.mockResolvedValue({
      ready: true,
      statusHint: 'Health check passed.'
    })
    mockSetVoiceEngineEnabled.mockResolvedValue({
      id: engineId,
      providerId: `byo:${engineId}`,
      name: 'Chatterbox Local',
      enabled: true
    })
  }

  it('launches a local runtime, waits through initializing, then registers and enables it', async () => {
    mockInspectByoSpeechRuntimeForRecord
      .mockResolvedValueOnce({
        ready: false,
        reachable: false,
        state: 'unreachable',
        statusHint: 'Connection refused'
      })
      .mockResolvedValueOnce({
        ready: false,
        reachable: true,
        state: 'initializing',
        statusHint: 'Loading model weights...'
      })
      .mockResolvedValueOnce({
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      })
    mockListByoVoicesForRecord.mockResolvedValue([
      {
        id: 'alloy',
        name: 'Alloy',
        provider: 'byo:chatterbox-local'
      }
    ])
    mockSynthesizeByoSpeechForRecord.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
      voiceId: 'alloy',
      provider: 'byo:chatterbox-local',
      model: 'engine-default-model'
    })
    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: true,
      record: { id: 'chatterbox-local' },
      summary: {
        id: 'chatterbox-local',
        providerId: 'byo:chatterbox-local',
        name: 'Chatterbox Local',
        enabled: false
      }
    })
    mockCheckByoSpeechStatus.mockResolvedValue({
      ready: true,
      statusHint: 'Health check passed.'
    })
    mockSetVoiceEngineEnabled.mockResolvedValue({
      id: 'chatterbox-local',
      providerId: 'byo:chatterbox-local',
      name: 'Chatterbox Local',
      enabled: true
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py']
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'engine-default-model'
        },
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: true,
      blocked: false,
      stage: 'complete',
      launched: true,
      alreadyRunning: false,
      pid: 4242,
      registered: true,
      enabled: true,
      smoke: {
        text: 'This is a Batshit local engine smoke test.',
        voiceId: 'alloy',
        mediaType: 'audio/wav',
        audioBytes: 4
      }
    })
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [spawnCommand, spawnArgs] = mockSpawn.mock.calls[0]
    expect(spawnCommand).toMatch(/\.venv\/bin\/python$/)
    expect(spawnArgs).toHaveLength(1)
    expect(String(spawnArgs[0])).toMatch(/\/engine\/main\.py$/)
    expect(mockSynthesizeByoSpeechForRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'This is a Batshit local engine smoke test.',
        voiceId: 'alloy'
      })
    )
    expect(mockUpsertVoiceEngineRecord).toHaveBeenCalledWith(
      'user-1',
      'chatterbox-local',
      expect.objectContaining({
        enabled: false,
        localRuntime: expect.objectContaining({
          installRoot: expect.stringMatching(/\/engine$/),
          installOwnership: 'user-managed',
          launch: expect.objectContaining({
            command: expect.stringMatching(/\.venv\/bin\/python$/),
            args: [expect.stringMatching(/\/engine\/main\.py$/)],
            cwd: expect.stringMatching(/\/engine$/),
            logPath: expect.stringMatching(/\/runtime-state\/chatterbox-local\/logs\/local-engine-runtime\.log$/)
          })
        }),
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      })
    )
    expect(mockSetVoiceEngineEnabled).toHaveBeenCalledWith('user-1', 'chatterbox-local', true)

    const savedState = JSON.parse(
      await readFile(path.join(runtimeStateRoot, 'chatterbox-local', '.batshit-local-engine-setup.json'), 'utf8')
    )
    expect(savedState).toMatchObject({
      completed: true,
      stage: 'complete',
      engineId: 'chatterbox-local'
    })
  })

  it('returns a blocker when health flips from initializing to error before smoke', async () => {
    const logPath = path.join(installRoot, 'logs', 'runtime.log')
    await mkdir(path.dirname(logPath), { recursive: true })
    await writeFile(logPath, 'model load error: unsupported backend\n', 'utf8')

    mockInspectByoSpeechRuntimeForRecord
      .mockResolvedValueOnce({
        ready: false,
        reachable: false,
        state: 'unreachable',
        statusHint: 'Connection refused'
      })
      .mockResolvedValueOnce({
        ready: false,
        reachable: true,
        state: 'initializing',
        statusHint: 'Loading model weights...'
      })
      .mockResolvedValueOnce({
        ready: false,
        reachable: true,
        state: 'error',
        statusHint: 'CUDA device deserialization failed on macOS.'
      })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py'],
        logPath: 'logs/runtime.log'
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: false,
      blocked: true,
      stage: 'health',
      launched: true,
      registered: false,
      enabled: false,
      blocker: 'CUDA device deserialization failed on macOS.'
    })
    expect(result.logExcerpt).toContain('unsupported backend')
    expect(mockSynthesizeByoSpeechForRecord).not.toHaveBeenCalled()
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
    expect(mockSetVoiceEngineEnabled).not.toHaveBeenCalled()
  })

  it('expands tilde-prefixed paths for the install root and launch config', async () => {
    homeScopedTempRoot = await mkdtemp(path.join(os.homedir(), 'batshit-voice-local-setup-home-'))
    const homeInstallRoot = path.join(homeScopedTempRoot, 'engine')
    const venvBinRoot = path.join(homeInstallRoot, '.venv', 'bin')
    await mkdir(path.join(homeInstallRoot, 'logs'), { recursive: true })
    await mkdir(venvBinRoot, { recursive: true })

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
    mockListByoVoicesForRecord.mockResolvedValue([])
    mockSynthesizeByoSpeechForRecord.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
      voiceId: 'alloy',
      provider: 'byo:chatterbox-local',
      model: 'engine-default-model'
    })
    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: true,
      record: { id: 'chatterbox-local' },
      summary: {
        id: 'chatterbox-local',
        providerId: 'byo:chatterbox-local',
        name: 'Chatterbox Local',
        enabled: false
      }
    })
    mockCheckByoSpeechStatus.mockResolvedValue({
      ready: true,
      statusHint: 'Health check passed.'
    })
    mockSetVoiceEngineEnabled.mockResolvedValue({
      id: 'chatterbox-local',
      providerId: 'byo:chatterbox-local',
      name: 'Chatterbox Local',
      enabled: true
    })

    const relativeHomeRoot = path.relative(os.homedir(), homeInstallRoot)
    const tildeInstallRoot = relativeHomeRoot ? `~/${relativeHomeRoot}` : '~'

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot: tildeInstallRoot,
      installOwnership: 'user-managed',
      launch: {
        command: `${tildeInstallRoot}/.venv/bin/python`,
        cwd: tildeInstallRoot,
        logPath: `${tildeInstallRoot}/logs/runtime.log`,
        args: ['main.py']
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'engine-default-model'
        },
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: true,
      installRoot: homeInstallRoot,
      launchCwd: homeInstallRoot,
      logPath: path.join(homeInstallRoot, 'logs', 'runtime.log')
    })
    expect(mockSpawn).toHaveBeenCalledWith(
      path.join(homeInstallRoot, '.venv', 'bin', 'python'),
      [path.join(homeInstallRoot, 'main.py')],
      expect.objectContaining({
        cwd: homeInstallRoot
      })
    )
  })

  it('resolves approved saved API keys into launch env without exposing raw secrets to the model', async () => {
    mockRetrieveApiKey.mockResolvedValue('hf_secret_token')
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
    mockListByoVoicesForRecord.mockResolvedValue([])
    mockSynthesizeByoSpeechForRecord.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
      voiceId: 'alloy',
      provider: 'byo:chatterbox-local',
      model: 'engine-default-model'
    })
    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: true,
      record: { id: 'chatterbox-local' },
      summary: {
        id: 'chatterbox-local',
        providerId: 'byo:chatterbox-local',
        name: 'Chatterbox Local',
        enabled: false
      }
    })
    mockCheckByoSpeechStatus.mockResolvedValue({
      ready: true,
      statusHint: 'Health check passed.'
    })
    mockSetVoiceEngineEnabled.mockResolvedValue({
      id: 'chatterbox-local',
      providerId: 'byo:chatterbox-local',
      name: 'Chatterbox Local',
      enabled: true
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py'],
        envFromApiKeys: {
          HF_TOKEN: 'huggingface'
        }
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'engine-default-model'
        },
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(mockRetrieveApiKey).toHaveBeenCalledWith('huggingface', 'user-1')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [spawnCommand, spawnArgs, spawnOptions] = mockSpawn.mock.calls[0]
    expect(String(spawnCommand)).toMatch(/\.venv\/bin\/python$/)
    expect(spawnArgs).toHaveLength(1)
    expect(String(spawnArgs[0])).toMatch(/\/engine\/main\.py$/)
    expect(spawnOptions).toEqual(
      expect.objectContaining({
        env: expect.objectContaining({
          HF_TOKEN: 'hf_secret_token'
        })
      })
    )
  })

  it('removes requested inherited environment variables before launching a runtime', async () => {
    const originalRedisHost = process.env.REDIS_HOST
    const originalRedisPort = process.env.REDIS_PORT
    process.env.REDIS_HOST = '127.0.0.1'
    process.env.REDIS_PORT = '6379'

    try {
      const { startLocalVoiceRuntime } = await import('../services/voiceLocalEngineSetup')

      await startLocalVoiceRuntime({
        userId: 'user-1',
        engineId: 'livekit-server',
        installRoot,
        installOwnership: 'user-managed',
        launch: {
          command: 'node',
          env: {
            LIVEKIT_URL: 'ws://127.0.0.1:7880'
          },
          unsetEnv: ['REDIS_HOST', 'REDIS_PORT']
        }
      })

      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const [, , spawnOptions] = mockSpawn.mock.calls[0]
      expect(spawnOptions.env.REDIS_HOST).toBeUndefined()
      expect(spawnOptions.env.REDIS_PORT).toBeUndefined()
      expect(spawnOptions.env.LIVEKIT_URL).toBe('ws://127.0.0.1:7880')
    } finally {
      if (typeof originalRedisHost === 'string') {
        process.env.REDIS_HOST = originalRedisHost
      } else {
        delete process.env.REDIS_HOST
      }
      if (typeof originalRedisPort === 'string') {
        process.env.REDIS_PORT = originalRedisPort
      } else {
        delete process.env.REDIS_PORT
      }
    }
  })

  it('accepts the runtime-managed install root override for batshit-managed installs', async () => {
    const managedRoot = path.join(tempRoot, 'managed-installs')
    const managedInstallRoot = path.join(managedRoot, 'chatterbox-local')
    await mkdir(path.join(managedInstallRoot, 'logs'), { recursive: true })
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = managedRoot
    const canonicalManagedInstallRoot = await realpath(managedInstallRoot)

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
    mockListByoVoicesForRecord.mockResolvedValue([])
    mockSynthesizeByoSpeechForRecord.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
      voiceId: 'alloy',
      provider: 'byo:chatterbox-local',
      model: 'engine-default-model'
    })
    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: true,
      record: { id: 'chatterbox-local' },
      summary: {
        id: 'chatterbox-local',
        providerId: 'byo:chatterbox-local',
        name: 'Chatterbox Local',
        enabled: false
      }
    })
    mockCheckByoSpeechStatus.mockResolvedValue({
      ready: true,
      statusHint: 'Health check passed.'
    })
    mockSetVoiceEngineEnabled.mockResolvedValue({
      id: 'chatterbox-local',
      providerId: 'byo:chatterbox-local',
      name: 'Chatterbox Local',
      enabled: true
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot: managedInstallRoot,
      installOwnership: 'batshit-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py'],
        logPath: 'logs/runtime.log'
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'engine-default-model'
        },
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: true,
      installRoot: canonicalManagedInstallRoot,
      launchCwd: canonicalManagedInstallRoot,
      logPath: path.join(canonicalManagedInstallRoot, 'logs', 'runtime.log')
    })
  })

  it('rejects batshit-managed Hugging Face installs that do not declare a managed cache root', async () => {
    const managedInstallRoot = await createManagedInstallRoot()
    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await expect(
      completeLocalVoiceEngineSetup('user-1', {
        engineId: 'chatterbox-local',
        installRoot: managedInstallRoot,
        installOwnership: 'batshit-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py']
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: {
            modelId: 'mlx-community/chatterbox-turbo-fp16'
          },
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      })
    ).rejects.toThrow('Batshit-managed Hugging Face voice installs must set launch.env.HF_HOME')

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockInspectByoSpeechRuntimeForRecord).not.toHaveBeenCalled()
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
  })

  it('rejects batshit-managed Hugging Face cache paths outside the install root without explicit approval', async () => {
    const managedInstallRoot = await createManagedInstallRoot()
    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await expect(
      completeLocalVoiceEngineSetup('user-1', {
        engineId: 'chatterbox-local',
        installRoot: managedInstallRoot,
        installOwnership: 'batshit-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py'],
          env: {
            HF_HOME: path.join(tempRoot, 'shared-hf')
          }
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: {
            modelId: 'mlx-community/chatterbox-turbo-fp16'
          },
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      })
    ).rejects.toThrow('launch.env.HF_HOME points outside this Batshit-managed engine install root')

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockInspectByoSpeechRuntimeForRecord).not.toHaveBeenCalled()
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
  })

  it('stores batshit-managed Hugging Face cache env when it stays inside the install root', async () => {
    const managedInstallRoot = await createManagedInstallRoot()
    const hfHome = path.join(managedInstallRoot, 'hf-home')
    mockSuccessfulReadyTtsEngine()

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot: managedInstallRoot,
      installOwnership: 'batshit-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py'],
        env: {
          HF_HOME: hfHome
        }
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16'
        },
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: true,
      blocked: false,
      launched: false,
      alreadyRunning: true
    })
    expect(mockUpsertVoiceEngineRecord).toHaveBeenCalledWith(
      'user-1',
      'chatterbox-local',
      expect.objectContaining({
        localRuntime: expect.objectContaining({
          installRoot: managedInstallRoot,
          installOwnership: 'batshit-managed',
          launch: expect.objectContaining({
            env: {
              HF_HOME: hfHome
            }
          })
        })
      })
    )
  })

  it('allows an explicitly approved shared Hugging Face cache for batshit-managed installs', async () => {
    const managedInstallRoot = await createManagedInstallRoot()
    const sharedHfHome = path.join(tempRoot, 'shared-hf')
    mockSuccessfulReadyTtsEngine()

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot: managedInstallRoot,
      installOwnership: 'batshit-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py'],
        env: {
          HF_HOME: sharedHfHome,
          BATSHIT_ALLOW_SHARED_HF_CACHE: 'true'
        }
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16'
        },
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: true,
      blocked: false
    })
    expect(mockUpsertVoiceEngineRecord).toHaveBeenCalledWith(
      'user-1',
      'chatterbox-local',
      expect.objectContaining({
        localRuntime: expect.objectContaining({
          launch: expect.objectContaining({
            env: {
              HF_HOME: sharedHfHome,
              BATSHIT_ALLOW_SHARED_HF_CACHE: 'true'
            }
          })
        })
      })
    )
  })

  it('fails before launch when a requested saved API key is missing', async () => {
    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await expect(
      completeLocalVoiceEngineSetup('user-1', {
        engineId: 'chatterbox-local',
        installRoot,
        installOwnership: 'user-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py'],
          envFromApiKeys: {
            HF_TOKEN: 'huggingface'
          }
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: {
            modelId: 'engine-default-model'
          },
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      })
    ).rejects.toThrow("Saved API key 'huggingface' is not configured in Settings -> API Keys.")

    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('blocks host-style local voice runtime launches inside the Docker app container', async () => {
    process.env.BATSHIT_CONTAINERIZED = '1'
    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await expect(
      completeLocalVoiceEngineSetup('user-1', {
        engineId: 'chatterbox-local',
        installRoot,
        installOwnership: 'user-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py']
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: {
            modelId: 'engine-default-model'
          },
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      })
    ).rejects.toThrow(
      'Dockerized Batshit cannot launch host-style local voice runtimes from inside the core app container.'
    )

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockInspectByoSpeechRuntimeForRecord).not.toHaveBeenCalled()
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
  })

  it('rejects shell-interpreter launch commands for helper-managed setup', async () => {
    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await expect(
      completeLocalVoiceEngineSetup('user-1', {
        engineId: 'chatterbox-local',
        installRoot,
        installOwnership: 'user-managed',
        launch: {
          command: 'bash',
          args: ['-lc', 'python main.py']
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: {
            modelId: 'engine-default-model'
          },
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      })
    ).rejects.toThrow(
      'launch.command must be the engine runtime or a launcher script, not a shell interpreter.'
    )

    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('rejects launch arguments that point outside the verified install root', async () => {
    const outsideScript = path.join(tempRoot, 'outside-main.py')
    await writeFile(outsideScript, 'print("outside")\n', 'utf8')

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    await expect(
      completeLocalVoiceEngineSetup('user-1', {
        engineId: 'chatterbox-local',
        installRoot,
        installOwnership: 'user-managed',
        launch: {
          command: '/opt/homebrew/opt/python@3.11/bin/python3.11',
          args: [outsideScript]
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: {
            modelId: 'engine-default-model'
          },
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      })
    ).rejects.toThrow('launch.args[0] must stay inside the verified install root.')

    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('blocks registration when an openai-compatible TTS payload forgets its saved default model', async () => {
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
    mockListByoVoicesForRecord.mockResolvedValue([])
    mockSynthesizeByoSpeechForRecord.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'audio/wav',
      voiceId: 'alloy',
      provider: 'byo:chatterbox-local',
      model: 'mlx-community/chatterbox-turbo-fp16'
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'chatterbox-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['main.py']
      },
      smoke: {
        model: 'mlx-community/chatterbox-turbo-fp16'
      },
      payload: {
        name: 'Chatterbox Local',
        baseUrl: 'http://127.0.0.1:4123',
        healthPath: '/health',
        ttsPath: '/tts',
        requestFormat: 'openai-compatible',
        supports: {
          tts: true,
          stt: false,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: false,
      blocked: true,
      stage: 'register'
    })
    expect(result.blocker).toContain('payload.ttsDefaults.modelId')
    expect(result.blocker).toContain('mlx-community/chatterbox-turbo-fp16')
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
    expect(mockSetVoiceEngineEnabled).not.toHaveBeenCalled()
  })

  it('launches, smokes, registers, and enables an STT-only local engine', async () => {
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
    mockTranscribeByoSpeechForRecord.mockResolvedValue({
      text: 'hello Batshit voice input',
      language: 'en'
    })
    mockUpsertVoiceEngineRecord.mockResolvedValue({
      created: true,
      record: { id: 'whisper-local' },
      summary: {
        id: 'whisper-local',
        providerId: 'byo:whisper-local',
        name: 'Whisper Local',
        enabled: false
      }
    })
    mockCheckByoSpeechStatus.mockResolvedValue({
      ready: true,
      statusHint: 'Health check passed.'
    })
    mockSetVoiceEngineEnabled.mockResolvedValue({
      id: 'whisper-local',
      providerId: 'byo:whisper-local',
      name: 'Whisper Local',
      enabled: true
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const audioBase64 = Buffer.from('fake-audio').toString('base64')
    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'whisper-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['server.py']
      },
      smoke: {
        mode: 'stt',
        audioBase64,
        audioContentType: 'audio/wav',
        expectedText: 'hello batshit',
        language: 'en',
        model: 'whisper-large-v3'
      },
      payload: {
        name: 'Whisper Local',
        baseUrl: 'http://127.0.0.1:4124',
        healthPath: '/health',
        sttPath: '/v1/audio/transcriptions',
        requestFormat: 'openai-compatible',
        sttDefaults: {
          modelId: 'whisper-large-v3'
        },
        supports: {
          tts: false,
          stt: true,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: true,
      blocked: false,
      stage: 'complete',
      launched: true,
      registered: true,
      enabled: true,
      smoke: {
        mode: 'stt',
        transcript: 'hello Batshit voice input',
        expectedText: 'hello batshit',
        matchedExpectedText: true,
        model: 'whisper-large-v3',
        contentType: 'audio/wav',
        language: 'en',
        audioBytes: 10
      }
    })
    expect(mockListByoVoicesForRecord).not.toHaveBeenCalled()
    expect(mockSynthesizeByoSpeechForRecord).not.toHaveBeenCalled()
    expect(mockTranscribeByoSpeechForRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          supportsTts: false,
          supportsStt: true,
          sttPath: '/v1/audio/transcriptions'
        }),
        audio: expect.any(Uint8Array),
        providerId: 'byo:whisper-local',
        model: 'whisper-large-v3',
        language: 'en',
        contentType: 'audio/wav',
        userId: 'user-1'
      })
    )
    expect(mockUpsertVoiceEngineRecord).toHaveBeenCalledWith(
      'user-1',
      'whisper-local',
      expect.objectContaining({
        enabled: false,
        supports: {
          tts: false,
          stt: true,
          clone: false
        },
        localRuntime: expect.objectContaining({
          installRoot: expect.stringMatching(/\/engine$/)
        })
      })
    )
  })

  it('blocks STT-only setup when no real smoke audio is provided', async () => {
    mockInspectByoSpeechRuntimeForRecord.mockResolvedValue({
      ready: true,
      reachable: true,
      state: 'ready',
      statusHint: 'Health check passed.'
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'whisper-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['server.py']
      },
      smoke: {
        mode: 'stt',
        expectedText: 'hello batshit'
      },
      payload: {
        name: 'Whisper Local',
        baseUrl: 'http://127.0.0.1:4124',
        healthPath: '/health',
        sttPath: '/stt',
        requestFormat: 'batshit-byo',
        supports: {
          tts: false,
          stt: true,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: false,
      blocked: true,
      stage: 'smoke'
    })
    expect(result.blocker).toContain('smoke.audioBase64')
    expect(mockTranscribeByoSpeechForRecord).not.toHaveBeenCalled()
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
  })

  it('blocks registration when an openai-compatible STT payload forgets its saved default model', async () => {
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
    mockTranscribeByoSpeechForRecord.mockResolvedValue({
      text: 'hello Batshit voice input',
      language: 'en'
    })

    const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')

    const result = await completeLocalVoiceEngineSetup('user-1', {
      engineId: 'whisper-local',
      installRoot,
      installOwnership: 'user-managed',
      launch: {
        command: '.venv/bin/python',
        args: ['server.py']
      },
      smoke: {
        mode: 'stt',
        audioBase64: Buffer.from('fake-audio').toString('base64'),
        expectedText: 'hello batshit',
        model: 'whisper-large-v3'
      },
      payload: {
        name: 'Whisper Local',
        baseUrl: 'http://127.0.0.1:4124',
        healthPath: '/health',
        sttPath: '/v1/audio/transcriptions',
        requestFormat: 'openai-compatible',
        supports: {
          tts: false,
          stt: true,
          clone: false
        }
      },
      readinessTimeoutMs: 10_000,
      pollIntervalMs: 1
    })

    expect(result).toMatchObject({
      completed: false,
      blocked: true,
      stage: 'register'
    })
    expect(result.blocker).toContain('payload.sttDefaults.modelId')
    expect(result.blocker).toContain('whisper-large-v3')
    expect(mockUpsertVoiceEngineRecord).not.toHaveBeenCalled()
    expect(mockSetVoiceEngineEnabled).not.toHaveBeenCalled()
  })
})
