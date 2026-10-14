import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtureHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!fixtureHome.current) throw new Error('voiceLocalEngineSetup.test: disposable home is unavailable')
    return fixtureHome.current
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

const mockInspectByoSpeechRuntimeForRecord = vi.fn()
const mockListByoVoicesForRecord = vi.fn()
const mockSynthesizeByoSpeechForRecord = vi.fn()
const mockTranscribeByoSpeechForRecord = vi.fn()
const mockCheckByoSpeechStatus = vi.fn()
const mockUpsertVoiceEngineRecord = vi.fn()
const mockSetVoiceEngineEnabled = vi.fn()
const mockGetVoiceEngineRecord = vi.fn()
const mockSpawn = vi.fn()
const mockLauncherMessages = vi.fn()
const mockRetrieveApiKey = vi.fn()

// The engine launcher (`voiceRuntimeReparent.ts`) as the app sees it: the process `spawn` starts
// (pid 4241) and the messages it answers on its channel. The engine it starts is pid 4242. On
// Windows the app spawns the engine itself, and this same object stands in for it.
type FakeLauncherScript =
  | 'hand-over'
  | 'exited'
  | 'failed'
  | 'vanishes'
  | 'own-pid'
  | 'unknown-answer'
  | 'stalls'
  | 'silent'
type FakeLauncher = EventEmitter & {
  pid: number
  connected: boolean
  exitCode: number | null
  signalCode: string | null
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function fakeLauncher(script: FakeLauncherScript, { deaf = false } = {}): FakeLauncher {
  const child = new EventEmitter() as FakeLauncher
  child.pid = 4241
  child.connected = true
  // As Node's ChildProcess: null until it has ended, then set before `exit` is emitted.
  child.exitCode = null
  child.signalCode = null
  const later = (then: () => void) => setTimeout(then, 0)
  const answer = (...messages: Array<Record<string, unknown>>) =>
    later(() => {
      for (const message of messages) child.emit('message', message)
    })
  let ended = false
  // As Node reports a child that ends with its channel open: `exit`, then `close`.
  const end = (code: number | null, signal: string | null) =>
    later(() => {
      if (ended) return
      ended = true
      child.connected = false
      child.exitCode = code
      child.signalCode = signal
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    })
  child.unref = vi.fn()
  // Killed, it ends by the signal.
  child.kill = vi.fn(() => {
    end(null, 'SIGKILL')
    return true
  })
  // As in Node: after the app's own disconnect there is an `exit` but never a `close`.
  child.disconnect = vi.fn(() => {
    child.connected = false
  })
  child.send = vi.fn((message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
    mockLauncherMessages(message)
    callback?.(null)
    if (message.type === 'adopted') {
      end(0, null)
      return true
    }
    // The real launcher stops its engine and exits 3 when asked to abort.
    if (message.type === 'abort') {
      if (!deaf) end(3, null)
      return true
    }
    if (message.type !== 'launch') return true
    const ready = { type: 'ready', node: process.versions.node }
    const spawned = { type: 'spawned', pid: 4242 }
    if (script === 'hand-over') answer(ready, spawned, { type: 'started', pid: 4242 })
    if (script === 'exited') {
      answer(ready, spawned, { type: 'exited', code: 1, signal: null })
      end(3, null)
    }
    if (script === 'failed') {
      answer(ready, { type: 'failed', message: 'spawn /missing/engine ENOENT', code: 'ENOENT' })
      end(3, null)
    }
    if (script === 'vanishes') {
      answer(ready, spawned)
      end(null, 'SIGKILL')
    }
    if (script === 'own-pid') answer(ready, spawned, { type: 'started', pid: 4241 })
    if (script === 'unknown-answer') answer(ready, spawned, { type: 'ok', pid: 4242 })
    if (script === 'stalls') answer(ready, spawned)
    return true
  })
  later(() => child.emit('spawn'))
  return child
}

vi.mock('$lib/server/services/voiceService', () => ({
  inspectByoSpeechRuntimeForRecord: (...args: any[]) => mockInspectByoSpeechRuntimeForRecord(...args),
  listByoVoicesForRecord: (...args: any[]) => mockListByoVoicesForRecord(...args),
  synthesizeByoSpeechForRecord: (...args: any[]) => mockSynthesizeByoSpeechForRecord(...args),
  transcribeByoSpeechForRecord: (...args: any[]) => mockTranscribeByoSpeechForRecord(...args),
  checkByoSpeechStatus: (...args: any[]) => mockCheckByoSpeechStatus(...args)
}))

// This factory replaces the WHOLE module, so a new import in
// voiceLocalEngineSetup that is missing here is `undefined` at call time, not a
// pass-through. Keep it in step with what the service actually imports.
vi.mock('$lib/server/services/voiceEngineRegistry', () => ({
  upsertVoiceEngineRecord: (...args: any[]) => mockUpsertVoiceEngineRecord(...args),
  setVoiceEngineEnabled: (...args: any[]) => mockSetVoiceEngineEnabled(...args),
  getVoiceEngineRecord: (...args: any[]) => mockGetVoiceEngineRecord(...args)
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

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (...args: any[]) => mockSpawn(...args),
    default: {
      ...(original as typeof original & { default?: Record<string, unknown> }).default,
      spawn: (...args: any[]) => mockSpawn(...args)
    }
  }
})

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
    tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-local-setup-')))
    fixtureHome.current = tempRoot
    installRoot = path.join(tempRoot, 'engine')
    runtimeStateRoot = path.join(tempRoot, 'runtime-state')
    await mkdir(installRoot, { recursive: true })
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = runtimeStateRoot

    mockSpawn.mockImplementation(() => fakeLauncher('hand-over'))
    mockRetrieveApiKey.mockResolvedValue(null)
    mockGetVoiceEngineRecord.mockResolvedValue(null)
  })

  afterEach(async () => {
    fixtureHome.current = ''
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

  // What the app handed the launcher to start: the engine's command, args, cwd and environment.
  function launchedEngine(): {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string | undefined>
  } {
    const launches = mockLauncherMessages.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'launch')
    expect(launches).toHaveLength(1)
    return launches[0]
  }

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
    expect(mockSpawn.mock.calls[0][0]).toBe(process.execPath)
    const { command: spawnCommand, args: spawnArgs } = launchedEngine()
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
    expect(launchedEngine()).toEqual(
      expect.objectContaining({
        command: path.join(homeInstallRoot, '.venv', 'bin', 'python'),
        args: [path.join(homeInstallRoot, 'main.py')],
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
    const { command: spawnCommand, args: spawnArgs, env: engineEnv } = launchedEngine()
    expect(String(spawnCommand)).toMatch(/\.venv\/bin\/python$/)
    expect(spawnArgs).toHaveLength(1)
    expect(String(spawnArgs[0])).toMatch(/\/engine\/main\.py$/)
    expect(engineEnv).toEqual(
      expect.objectContaining({
        HF_TOKEN: 'hf_secret_token'
      })
    )
    // The key reaches the engine only through the launcher's channel: not on the launcher's
    // argv, and not in its environment, which holds PATH and LC_ALL and nothing else.
    const [launcherCommand, launcherArgs, launcherOptions] = mockSpawn.mock.calls[0]
    expect(launcherCommand).toBe(process.execPath)
    expect(launcherArgs).toEqual(['-e', expect.any(String)])
    expect(JSON.stringify(launcherArgs)).not.toContain('hf_secret_token')
    expect(launcherOptions.env).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C' })
    expect(launcherOptions.stdio[3]).toBe('ipc')
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
      const { env: engineEnv } = launchedEngine()
      expect(engineEnv.REDIS_HOST).toBeUndefined()
      expect(engineEnv.REDIS_PORT).toBeUndefined()
      expect(engineEnv.LIVEKIT_URL).toBe('ws://127.0.0.1:7880')
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
  describe('Stop with Batshit is written into the launch record', () => {
    // The Mac supervisor and the native launcher decide shutdown from this
    // file, never from Redis, so a spawn that forgets the field silently
    // reverts the user's choice to the default.
    async function launchAndReadRecord(engineId: string) {
      mockInspectByoSpeechRuntimeForRecord
        .mockResolvedValueOnce({
          ready: false,
          reachable: false,
          state: 'unreachable',
          statusHint: 'Connection refused'
        })
        .mockResolvedValue({
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
        provider: `byo:${engineId}`,
        model: 'engine-default-model'
      })
      mockUpsertVoiceEngineRecord.mockResolvedValue({
        created: true,
        record: { id: engineId },
        summary: { id: engineId, providerId: `byo:${engineId}`, name: engineId, enabled: false }
      })
      mockCheckByoSpeechStatus.mockResolvedValue({ ready: true, statusHint: 'Health check passed.' })
      mockSetVoiceEngineEnabled.mockResolvedValue({ id: engineId, enabled: true })

      const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')
      const result = await completeLocalVoiceEngineSetup('user-1', {
        engineId,
        installRoot,
        installOwnership: 'user-managed',
        launch: { command: '.venv/bin/python', args: ['main.py'] },
        payload: {
          name: engineId,
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: { modelId: 'engine-default-model', voiceId: 'alloy' },
          supports: { tts: true, stt: false, clone: false }
        },
        readinessTimeoutMs: 10_000,
        pollIntervalMs: 1
      })

      expect(result.launched).toBe(true)
      return JSON.parse(
        await readFile(
          path.join(runtimeStateRoot, engineId, '.batshit-local-runtime-launch.json'),
          'utf8'
        )
      )
    }

    it('records "stop" for an engine with no saved choice yet', async () => {
      mockGetVoiceEngineRecord.mockResolvedValue(null)
      expect(await launchAndReadRecord('fresh-engine')).toMatchObject({
        engineId: 'fresh-engine',
        pid: 4242,
        stopOnShutdown: true
      })
    })

    it('does not silently re-enable stopping for someone who turned it off', async () => {
      // Re-running setup preserves the saved "Start with Batshit" choice. The
      // stop half has to be preserved the same way.
      mockGetVoiceEngineRecord.mockResolvedValue({
        id: 'kept-running-engine',
        localRuntime: { startup: { autoStartOnLaunch: true, stopOnShutdown: false } }
      })
      expect(await launchAndReadRecord('kept-running-engine')).toMatchObject({
        engineId: 'kept-running-engine',
        stopOnShutdown: false
      })
    })

    it('names the Batshit that launched it, so only that Batshit\'s shutdown stops it', async () => {
      const original = process.env.BATSHIT_VOICE_RUNTIME_OWNER
      process.env.BATSHIT_VOICE_RUNTIME_OWNER = 'native:4321:1789700000000'
      try {
        expect(await launchAndReadRecord('owned-engine')).toMatchObject({
          launchedBy: 'native:4321:1789700000000'
        })
      } finally {
        if (original === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_OWNER
        else process.env.BATSHIT_VOICE_RUNTIME_OWNER = original
      }
    })

    it('a Batshit started without a launcher identity writes an unmarked record (today\'s rules)', async () => {
      const original = process.env.BATSHIT_VOICE_RUNTIME_OWNER
      delete process.env.BATSHIT_VOICE_RUNTIME_OWNER
      try {
        expect((await launchAndReadRecord('unmarked-engine')).launchedBy).toBeUndefined()
      } finally {
        if (original !== undefined) process.env.BATSHIT_VOICE_RUNTIME_OWNER = original
      }
    })

    it('records the listener the runtime serves, so an engine sharing it can find it', async () => {
      expect(await launchAndReadRecord('endpoint-engine')).toMatchObject({
        endpoint: 'http://127.0.0.1:4123'
      })
    })

    it('a relaunch keeps the record of an earlier launch that is still running', async () => {
      // This test process stands in for a copy of the engine that is still running.
      const dir = path.join(runtimeStateRoot, 'relaunched-engine')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, '.batshit-local-runtime-launch.json'),
        JSON.stringify({ engineId: 'relaunched-engine', pid: process.pid, command: '/opt/engine/bin/serve' })
      )

      expect((await launchAndReadRecord('relaunched-engine')).pid).toBe(4242)
      const aside = JSON.parse(
        await readFile(path.join(dir, `.batshit-local-runtime-launch.${process.pid}.json`), 'utf8')
      )
      expect(aside).toMatchObject({ pid: process.pid, command: '/opt/engine/bin/serve' })
    })

    it('set up against a runtime another engine launched, it records its own choice beside it', async () => {
      await mkdir(path.join(runtimeStateRoot, 'shared-starter'), { recursive: true })
      await writeFile(
        path.join(runtimeStateRoot, 'shared-starter', '.batshit-local-runtime-launch.json'),
        JSON.stringify({
          engineId: 'shared-starter',
          pid: process.pid,
          command: '/opt/mlx/bin/mlx_audio.server',
          endpoint: 'http://127.0.0.1:4123',
          launchedAt: '2026-09-17T01:00:03.000Z'
        })
      )
      mockInspectByoSpeechRuntimeForRecord.mockResolvedValue({
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
        provider: 'byo:sharing-engine',
        model: 'engine-default-model'
      })
      mockUpsertVoiceEngineRecord.mockResolvedValue({
        created: true,
        record: { id: 'sharing-engine', localRuntime: { startup: { stopOnShutdown: false } } },
        summary: { id: 'sharing-engine', providerId: 'byo:sharing-engine', name: 'sharing-engine', enabled: false }
      })
      mockCheckByoSpeechStatus.mockResolvedValue({ ready: true, statusHint: 'Health check passed.' })
      mockSetVoiceEngineEnabled.mockResolvedValue({ id: 'sharing-engine', enabled: true })

      const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')
      const result = await completeLocalVoiceEngineSetup('user-1', {
        engineId: 'sharing-engine',
        installRoot,
        installOwnership: 'user-managed',
        launch: { command: '.venv/bin/python', args: ['main.py'] },
        payload: {
          name: 'sharing-engine',
          baseUrl: 'http://localhost:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: { modelId: 'engine-default-model', voiceId: 'alloy' },
          supports: { tts: true, stt: false, clone: false }
        },
        readinessTimeoutMs: 10_000,
        pollIntervalMs: 1
      })

      expect(result).toMatchObject({ completed: true, launched: false, alreadyRunning: true })
      expect(mockSpawn).not.toHaveBeenCalled()
      const record = JSON.parse(
        await readFile(
          path.join(runtimeStateRoot, 'sharing-engine', '.batshit-local-runtime-launch.json'),
          'utf8'
        )
      )
      expect(record).toMatchObject({ pid: process.pid, startedBy: 'shared-starter', stopOnShutdown: false })
    })
  })

  // BL-1252: the engine's parent is a short-lived launcher, which owns it until its launch record
  // exists. Each failure window ends with the engine stopped by that launcher, or named in the error.
  describe('the engine launcher hands the engine over only after its record', () => {
    const recordPath = (engineId: string) =>
      path.join(runtimeStateRoot, engineId, '.batshit-local-runtime-launch.json')

    async function startEngine(engineId = 'handover-engine') {
      const { startLocalVoiceRuntime } = await import('../services/voiceLocalEngineSetup')
      return startLocalVoiceRuntime({
        userId: 'user-1',
        engineId,
        installRoot,
        installOwnership: 'user-managed',
        launch: { command: 'node', args: ['engine.js'], logPath: 'logs/runtime.log' }
      })
    }

    const sentTypes = () => mockLauncherMessages.mock.calls.map(([message]) => message.type)

    it('answers the engine pid only after its record exists, and the record names the engine', async () => {
      let recordExistedAtHandOver = false
      mockLauncherMessages.mockImplementation((message) => {
        if (message.type === 'adopted') recordExistedAtHandOver = existsSync(recordPath('handover-engine'))
      })

      const started = await startEngine()

      expect(started.pid).toBe(4242)
      expect(recordExistedAtHandOver).toBe(true)
      expect(sentTypes()).toEqual(['launch', 'adopted'])
      expect(JSON.parse(await readFile(recordPath('handover-engine'), 'utf8'))).toMatchObject({ pid: 4242 })
    })

    it('fails with today\'s words when the engine ends inside its first 200 ms, and records nothing', async () => {
      mockSpawn.mockImplementation(() => fakeLauncher('exited'))

      await expect(startEngine()).rejects.toThrow('Local engine launch exited immediately (code 1).')
      expect(existsSync(recordPath('handover-engine'))).toBe(false)
      expect(sentTypes()).toEqual(['launch'])
    })

    it('keeps the words of an engine that could not start', async () => {
      mockSpawn.mockImplementation(() => fakeLauncher('failed'))

      await expect(startEngine()).rejects.toMatchObject({
        message: 'spawn /missing/engine ENOENT',
        code: 'ENOENT'
      })
      expect(existsSync(recordPath('handover-engine'))).toBe(false)
    })

    it('names the engine when its launcher vanishes before the hand-over, and starts nothing else', async () => {
      mockSpawn.mockImplementation(() => fakeLauncher('vanishes'))

      const failure = await startEngine().catch((error: Error) => error)

      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('ended before it handed over the engine (SIGKILL)')
      expect((failure as Error).message).toContain(
        'Engine process 4242 may still be running, and Batshit has no record of it'
      )
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      expect(existsSync(recordPath('handover-engine'))).toBe(false)
    })

    it.each([
      ['its own pid as the engine\'s', 'own-pid' as const, 'no usable process id'],
      ['an answer it does not know', 'unknown-answer' as const, 'an answer Batshit does not know']
    ])('stops the launch through the launcher when it reports %s', async (_label, script, words) => {
      mockSpawn.mockImplementation(() => fakeLauncher(script))

      await expect(startEngine()).rejects.toThrow(words)
      // `abort` is what makes the launcher stop its engine (it exits 3).
      expect(sentTypes()).toEqual(['launch', 'abort'])
      expect(existsSync(recordPath('handover-engine'))).toBe(false)
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('stops the engine through the launcher when its record cannot be written', async () => {
      const blocked = path.join(tempRoot, 'not-a-folder')
      await writeFile(blocked, 'a file where the state root should be')
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = path.join(blocked, 'state')

      await expect(startEngine()).rejects.toThrow(/ENOTDIR|not a directory/)
      expect(sentTypes()).toEqual(['launch', 'abort'])
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    // P-1e's writer refusal (BL-1267) and Part 1's launcher abort (BL-1252) together, with real
    // processes: the real launcher starts a real fake engine; the canonical record cannot be read, so
    // its write is refused; the launcher stops the engine it still owns; the file keeps its bytes.
    it('a malformed launch record: the launch is refused, its new engine is gone, and the file keeps its bytes', async () => {
      const realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      mockSpawn.mockImplementation((...args: Parameters<typeof realChildProcess.spawn>) => realChildProcess.spawn(...args))
      const pidFile = path.join(tempRoot, 'engine.pid')
      await writeFile(
        path.join(installRoot, 'engine.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`
      )
      const malformed = '{"engineId": "malformed-engine", "pid": 12'
      await mkdir(path.dirname(recordPath('malformed-engine')), { recursive: true })
      await writeFile(recordPath('malformed-engine'), malformed)
      const running = (pid: number) => {
        try {
          const stat = realChildProcess.execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
          return stat.length > 0 && !stat.startsWith('Z')
        } catch {
          return false
        }
      }
      const fixtures = () =>
        realChildProcess
          .execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' })
          .split('\n')
          .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null && !match[2].startsWith('Z') && match[3].includes(installRoot))
          .map((match) => Number(match[1]))

      let survivors: number[] = []
      try {
        const failure = await startEngine('malformed-engine').catch((error: Error) => error)

        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('is not valid JSON. Batshit did not write over it')
        // The launcher confirmed the stop (it exits 3), so nothing is reported as possibly running.
        expect((failure as Error).message).not.toContain('may still be running')
        // The launcher writes the engine's pid to the engine's log as it spawns it, before the engine
        // itself has booted; the engine's own pid file is only a "it ran" check on a fast machine.
        const log = await readFile(path.join(installRoot, 'logs', 'runtime.log'), 'utf8')
        const launched = [...log.matchAll(/engine launcher started process (\d+)/g)].map((match) => Number(match[1]))
        expect(launched).toHaveLength(1)
        const engine = launched[0]
        if (existsSync(pidFile)) expect(Number(await readFile(pidFile, 'utf8'))).toBe(engine)
        const deadline = Date.now() + 3_000
        while (running(engine) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
        expect(running(engine), `engine ${engine} still runs`).toBe(false)
        expect(await readFile(recordPath('malformed-engine'), 'utf8')).toBe(malformed)
      } finally {
        survivors = fixtures()
        for (const pid of survivors) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
      // After the body, so a failure above is never hidden by this one.
      expect(survivors).toEqual([])
    })

    // BL-1275/BL-1286 with real processes: the current record is another Batshit's record of a live
    // runtime P, and P's moved-aside name is already taken. The new launch is refused, its new
    // engine is stopped by the launcher, P keeps running, and every record keeps its bytes.
    it("a launch refused because the moved-aside name is taken stops its own new engine, never the other runtime", async () => {
      const realChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      mockSpawn.mockImplementation((...args: Parameters<typeof realChildProcess.spawn>) => realChildProcess.spawn(...args))
      await writeFile(path.join(installRoot, 'engine.js'), 'setInterval(() => {}, 1000)\n')
      // The other runtime P: a live fake that this test owns, tagged with the install root for the sweep.
      const other = realChildProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', installRoot], { stdio: 'ignore' })
      await new Promise((resolve) => other.once('spawn', resolve))
      const running = (pid: number) => {
        try {
          const stat = realChildProcess.execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
          return stat.length > 0 && !stat.startsWith('Z')
        } catch {
          return false
        }
      }
      const fixtures = () =>
        realChildProcess
          .execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' })
          .split('\n')
          .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null && !match[2].startsWith('Z') && match[3].includes(installRoot))
          .map((match) => Number(match[1]))
      const dir = path.dirname(recordPath('occupied-engine'))
      await mkdir(dir, { recursive: true })
      const current = JSON.stringify({ engineId: 'occupied-engine', pid: other.pid, command: process.execPath, registry: 'redis-1111111111111111', stopOnShutdown: false })
      const aside = JSON.stringify({ engineId: 'occupied-engine', pid: other.pid, command: process.execPath, registry: 'redis-2222222222222222', stopOnShutdown: true })
      await writeFile(recordPath('occupied-engine'), current)
      await writeFile(path.join(dir, `.batshit-local-runtime-launch.${other.pid}.json`), aside)

      let survivors: number[] = []
      try {
        const failure = await startEngine('occupied-engine').catch((error: Error) => error)

        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('already holds a launch record for process')
        expect((failure as Error).message).toContain('both records are kept')
        const log = await readFile(path.join(installRoot, 'logs', 'runtime.log'), 'utf8')
        const launched = [...log.matchAll(/engine launcher started process (\d+)/g)].map((match) => Number(match[1]))
        expect(launched).toHaveLength(1)
        const deadline = Date.now() + 3_000
        while (running(launched[0]) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
        expect(running(launched[0]), `new engine ${launched[0]} still runs`).toBe(false)
        expect(running(other.pid as number)).toBe(true)
        expect(await readFile(recordPath('occupied-engine'), 'utf8')).toBe(current)
        expect(await readFile(path.join(dir, `.batshit-local-runtime-launch.${other.pid}.json`), 'utf8')).toBe(aside)
      } finally {
        other.kill('SIGKILL')
        await new Promise((resolve) => setTimeout(resolve, 100))
        survivors = fixtures()
        for (const pid of survivors) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
      expect(survivors).toEqual([])
    })

    it('blocks setup with the reason when the record step fails, after the launcher stopped the engine', async () => {
      mockGetVoiceEngineRecord.mockRejectedValueOnce(new Error('the engine registry could not be read'))
      mockInspectByoSpeechRuntimeForRecord.mockResolvedValue({
        ready: false,
        reachable: false,
        state: 'unreachable',
        statusHint: 'Connection refused'
      })

      const { completeLocalVoiceEngineSetup } = await import('../services/voiceLocalEngineSetup')
      const result = await completeLocalVoiceEngineSetup('user-1', {
        engineId: 'unrecorded-engine',
        installRoot,
        installOwnership: 'user-managed',
        launch: { command: '.venv/bin/python', args: ['main.py'] },
        payload: {
          name: 'unrecorded-engine',
          baseUrl: 'http://127.0.0.1:4123',
          healthPath: '/health',
          ttsPath: '/tts',
          requestFormat: 'openai-compatible',
          ttsDefaults: { modelId: 'engine-default-model', voiceId: 'alloy' },
          supports: { tts: true, stt: false, clone: false }
        },
        readinessTimeoutMs: 10_000,
        pollIntervalMs: 1
      })

      expect(result).toMatchObject({
        completed: false,
        blocked: true,
        stage: 'launch',
        blocker: 'the engine registry could not be read',
        launched: false
      })
      expect(sentTypes()).toEqual(['launch', 'abort'])
      expect(existsSync(recordPath('unrecorded-engine'))).toBe(false)
    })

    describe('bounds', () => {
      const anyLaunch = { command: 'engine', args: [], cwd: '/', env: {}, stdoutFd: 1, stderrFd: 2 }

      afterEach(() => {
        vi.useRealTimers()
      })

      it('stops the launch when the launcher never starts', async () => {
        vi.useFakeTimers()
        mockSpawn.mockImplementation(() => fakeLauncher('silent'))
        const adopt = vi.fn(async () => undefined)
        const { spawnReparentedRuntime } = await import('../services/voiceRuntimeReparent')

        const outcome = spawnReparentedRuntime(anyLaunch, adopt).catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.advanceTimersByTimeAsync(1)

        expect(((await outcome) as Error).message).toContain('did not start within 5 seconds')
        expect(adopt).not.toHaveBeenCalled()
      })

      it('kills a launcher that ignores the abort, and names the engine that may still run', async () => {
        vi.useFakeTimers()
        const launchers: FakeLauncher[] = []
        mockSpawn.mockImplementation(() => {
          // It reports the engine, never `started`, and ignores `abort`.
          const launcher = fakeLauncher('stalls', { deaf: true })
          launchers.push(launcher)
          return launcher
        })
        const adopt = vi.fn(async () => undefined)
        const { spawnReparentedRuntime } = await import('../services/voiceRuntimeReparent')

        const outcome = spawnReparentedRuntime(anyLaunch, adopt).catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(sentTypes()).toEqual(['launch', 'abort'])
        expect(launchers[0].kill).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2_000)

        expect(launchers[0].kill).toHaveBeenCalledWith('SIGKILL')
        const error = (await outcome) as Error
        expect(error.message).toContain('did not report the engine within 10 seconds')
        expect(error.message).toContain('Engine process 4242 may still be running, and Batshit has no record of it')
        expect(adopt).not.toHaveBeenCalled()
      })
    })

    it('refuses inside Electron before spawning anything', async () => {
      Object.defineProperty(process.versions, 'electron', { value: '33.0.0', configurable: true, enumerable: true })
      try {
        const { spawnReparentedRuntime } = await import('../services/voiceRuntimeReparent')
        await expect(
          spawnReparentedRuntime(
            { command: 'engine', args: [], cwd: '/', env: {}, stdoutFd: 1, stderrFd: 2 },
            async () => undefined
          )
        ).rejects.toThrow('cannot start local engines from inside Electron')
        expect(mockSpawn).not.toHaveBeenCalled()
      } finally {
        delete (process.versions as Record<string, string | undefined>).electron
      }
    })

    it('keeps the direct detached spawn on Windows, with the record written after it', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      try {
        const started = await startEngine('windows-engine')

        // There, the fake stands in for the engine itself.
        expect(started.pid).toBe(4241)
        const [command, args, options] = mockSpawn.mock.calls[0]
        expect(command).toBe('node')
        expect(args).toEqual([path.join(installRoot, 'engine.js')])
        expect(options).toMatchObject({ detached: true })
        expect(mockLauncherMessages).not.toHaveBeenCalled()
        expect(JSON.parse(await readFile(recordPath('windows-engine'), 'utf8'))).toMatchObject({ pid: 4241 })
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    // BL-1274: on Windows the app is the runtime's parent, so a launch whose record is refused
    // stops its own child through the child's handle, and keeps the refusal as its error.
    it('on Windows, a refused record stops the child it started, and the file keeps its bytes', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const children: FakeLauncher[] = []
      mockSpawn.mockImplementation(() => {
        const child = fakeLauncher('hand-over')
        children.push(child)
        return child
      })
      const malformed = '{"engineId": "windows-refused", "pid": 12'
      await mkdir(path.dirname(recordPath('windows-refused')), { recursive: true })
      await writeFile(recordPath('windows-refused'), malformed)
      try {
        const failure = await startEngine('windows-refused').catch((error: Error) => error)

        expect((failure as Error).message).toContain('is not valid JSON. Batshit did not write over it')
        expect((failure as Error).message).not.toContain('could not confirm')
        expect(children).toHaveLength(1)
        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL')
        expect(children[0].signalCode).toBe('SIGKILL')
        expect(await readFile(recordPath('windows-refused'), 'utf8')).toBe(malformed)
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }
    })

    describe('the Windows cleanup acts only on a child its handle says still runs (BL-1274)', () => {
      function handle(state: { exitCode?: number | null; signalCode?: string | null; kill?: () => boolean }) {
        const child = new EventEmitter() as EventEmitter & {
          pid: number
          exitCode: number | null
          signalCode: string | null
          kill: ReturnType<typeof vi.fn>
        }
        child.pid = 4241
        child.exitCode = state.exitCode ?? null
        child.signalCode = state.signalCode ?? null
        child.kill = vi.fn(state.kill ?? (() => true))
        return child
      }

      it.each([
        ['has already exited', { exitCode: 0 }],
        ['was already ended by a signal', { signalCode: 'SIGTERM' }]
      ])('never signals a child that %s, and keeps the record error', async (_label, state) => {
        const { stopUnrecordedChild } = await import('../services/voiceLocalEngineSetup')
        const child = handle(state)
        const refusal = new Error('the record was refused')

        const error = await stopUnrecordedChild(child as never, refusal)

        expect(child.kill).not.toHaveBeenCalled()
        expect(error).toBe(refusal)
      })

      it.each([
        ['the kill is not delivered', () => false],
        ['the kill throws', () => {
          throw new Error('kill EPERM')
        }],
        ['the child does not end after the kill', () => true]
      ])('says it could not confirm the stop, naming the process, when %s', async (_label, kill) => {
        const { stopUnrecordedChild } = await import('../services/voiceLocalEngineSetup')
        const child = handle({ kill })
        const refusal = new Error('the record was refused.')

        const error = await stopUnrecordedChild(child as never, refusal, 20)

        expect(child.kill).toHaveBeenCalledWith('SIGKILL')
        expect(error.message).toBe(
          'the record was refused. Batshit could not confirm that it stopped the engine process it started (process 4241): it may still be running with no launch record. Restarting the computer stops it.'
        )
        expect(error.cause).toBe(refusal)
      })
    })
  })
})
