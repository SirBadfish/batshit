import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRedisJsonGet = vi.fn()
const mockRedisJsonSet = vi.fn()
const mockGetUserSettings = vi.fn()
const mockUpdateUserSettings = vi.fn()
const mockGetAgents = vi.fn()
const mockUpdateAgent = vi.fn()
const mockGetVoiceProfiles = vi.fn()
const mockGetVoiceProfile = vi.fn()
const mockCreateVoiceProfile = vi.fn()
const mockDeleteVoiceProfile = vi.fn()
const mockRedisExecute = vi.fn(async (operation: any) =>
  operation({
    json: {
      get: mockRedisJsonGet,
      set: mockRedisJsonSet
    }
  })
)

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: (...args: any[]) => mockGetUserSettings(...args),
    updateUserSettings: (...args: any[]) => mockUpdateUserSettings(...args),
    getAgents: (...args: any[]) => mockGetAgents(...args),
    updateAgent: (...args: any[]) => mockUpdateAgent(...args),
    getVoiceProfiles: (...args: any[]) => mockGetVoiceProfiles(...args),
    getVoiceProfile: (...args: any[]) => mockGetVoiceProfile(...args),
    createVoiceProfile: (...args: any[]) => mockCreateVoiceProfile(...args),
    deleteVoiceProfile: (...args: any[]) => mockDeleteVoiceProfile(...args),
    execute: (...args: any[]) => mockRedisExecute(...args)
  }
}))

describe('voiceEngineRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAgents.mockResolvedValue([])
    mockUpdateAgent.mockResolvedValue(undefined)
    mockGetVoiceProfiles.mockResolvedValue([])
    mockGetVoiceProfile.mockResolvedValue(null)
    mockCreateVoiceProfile.mockImplementation(async (profile: any) => profile)
    mockDeleteVoiceProfile.mockResolvedValue(undefined)
  })

  it('migrates legacy byoProviders out of voice settings into the server registry', async () => {
    let storedVoiceSettings: Record<string, any> | undefined = {
      schemaVersion: 2,
      tts: {
        providerId: 'byo:legacy-voice'
      },
      byoProviders: [
        {
          id: 'legacy-voice',
          name: 'Legacy Voice',
          baseUrl: 'http://localhost:7777',
          ttsPath: '/tts',
          authToken: 'super-secret'
        }
      ]
    }
    const jsonStore = new Map<string, any>()

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const { listVoiceEngineSummaries } = await import('../services/voiceEngineRegistry')
    const summaries = await listVoiceEngineSummaries('user-1')

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'legacy-voice',
      providerId: 'byo:legacy-voice',
      name: 'Legacy Voice',
      hasAuthToken: true
    })
    expect(mockUpdateUserSettings).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        voice_settings: expect.not.objectContaining({
          byoProviders: expect.anything()
        })
      })
    )
    expect(jsonStore.get('voice_engine_registry:user-1')).toMatchObject({
      version: 1,
      records: [
        expect.objectContaining({
          id: 'legacy-voice',
          authToken: 'super-secret'
        })
      ]
    })
  })

  it('applies public updates without dropping hidden engine wiring', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const {
      applyVoiceEnginePublicUpdates,
      getVoiceEngineRecordByProviderId,
      upsertVoiceEngineRecord
    } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'openvoice-local', {
      name: 'OpenVoice Local',
      baseUrl: 'http://localhost:8080',
      authToken: 'secret-token',
      expression: {
        strategy: 'instructions'
      },
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default',
        common: {
          instructions: 'Warm and clear'
        }
      }
    })

    const updated = await applyVoiceEnginePublicUpdates('user-1', [
      {
        id: 'openvoice-local',
        enabled: false,
        iconRef: { kind: 'brand', slug: 'openai-mono' },
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16',
          voiceId: 'default',
          common: {
            instructions: 'Warm and clear',
            language: 'en'
          }
        }
      }
    ])

    expect(updated[0]).toMatchObject({
      id: 'openvoice-local',
      enabled: false,
      iconRef: { kind: 'brand', slug: 'openai-mono' },
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default',
        common: {
          instructions: 'Warm and clear',
          language: 'en'
        }
      }
    })

    const record = await getVoiceEngineRecordByProviderId('user-1', 'byo:openvoice-local')
    expect(record).toMatchObject({
      id: 'openvoice-local',
      baseUrl: 'http://localhost:8080',
      authToken: 'secret-token',
      iconRef: { kind: 'brand', slug: 'openai-mono' },
      enabled: false
    })
  })

  it('lets cleared public TTS defaults stay cleared across reloads', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const {
      applyVoiceEnginePublicUpdates,
      getVoiceEngineRecordByProviderId,
      upsertVoiceEngineRecord
    } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'chatterbox-turbo', {
      name: 'Chatterbox Turbo',
      baseUrl: 'http://localhost:7777',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default',
        common: {
          speed: 0.25
        }
      }
    })

    const updated = await applyVoiceEnginePublicUpdates('user-1', [
      {
        id: 'chatterbox-turbo',
        ttsDefaults: {
          modelId: 'mlx-community/chatterbox-turbo-fp16',
          voiceId: 'default'
        }
      }
    ])

    expect(updated[0]).toMatchObject({
      id: 'chatterbox-turbo',
      ttsDefaults: {
        modelId: 'mlx-community/chatterbox-turbo-fp16',
        voiceId: 'default'
      }
    })
    expect(updated[0]?.ttsDefaults?.common).toBeUndefined()

    const record = await getVoiceEngineRecordByProviderId('user-1', 'byo:chatterbox-turbo')
    expect(record?.ttsDefaults?.common).toBeUndefined()
  })

  it('preserves stored local runtime wiring while letting public updates toggle startup behavior', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const {
      applyVoiceEnginePublicUpdates,
      getVoiceEngineRecordByProviderId,
      upsertVoiceEngineRecord
    } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'mlx-local', {
      name: 'MLX Local',
      baseUrl: 'http://127.0.0.1:8012',
      requestFormat: 'openai-compatible',
      localRuntime: {
        installRoot: '/Users/example/.batshit/installs/mlx-local',
        installOwnership: 'batshit-managed',
        launch: {
          command: '/Users/example/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
          args: ['--host', '127.0.0.1', '--port', '8012'],
          logPath: '/Users/example/.batshit/installs/mlx-local/logs/local-engine-runtime.log'
        },
        startup: {
          autoStartOnLaunch: false
        }
      }
    })

    const updated = await applyVoiceEnginePublicUpdates('user-1', [
      {
        id: 'mlx-local',
        localRuntime: {
          startup: {
            autoStartOnLaunch: true
          }
        }
      }
    ])

    expect(updated[0]).toMatchObject({
      id: 'mlx-local',
      localRuntime: {
        installOwnership: 'batshit-managed',
        startup: {
          autoStartOnLaunch: true
        }
      }
    })

    const record = await getVoiceEngineRecordByProviderId('user-1', 'byo:mlx-local')
    expect(record).toMatchObject({
      id: 'mlx-local',
      localRuntime: {
        installRoot: '/Users/example/.batshit/installs/mlx-local',
        installOwnership: 'batshit-managed',
        launch: {
          command: '/Users/example/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
          args: ['--host', '127.0.0.1', '--port', '8012']
        },
        startup: {
          autoStartOnLaunch: true
        }
      }
    })
  })

  it('stores approved saved API key refs without exposing raw auth tokens in summaries', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const { getVoiceEngineRecordByProviderId, upsertVoiceEngineRecord } = await import(
      '../services/voiceEngineRegistry'
    )

    const upserted = await upsertVoiceEngineRecord('user-1', 'custom-cloud-voice', {
      name: 'Custom Cloud Voice',
      baseUrl: 'https://api.example.com',
      authMode: 'header',
      authHeader: 'xi-api-key',
      authSavedKeyRef: 'openrouter'
    })

    expect(upserted.summary).toMatchObject({
      id: 'custom-cloud-voice',
      providerId: 'byo:custom-cloud-voice',
      hasAuthToken: true
    })
    expect(upserted.summary).not.toHaveProperty('authSavedKeyRef')

    const record = await getVoiceEngineRecordByProviderId('user-1', 'byo:custom-cloud-voice')
    expect(record).toMatchObject({
      id: 'custom-cloud-voice',
      authMode: 'header',
      authHeader: 'xi-api-key',
      authSavedKeyRef: 'openrouter'
    })
    expect(record?.authToken).toBeUndefined()
  })

  it('normalizes saved API key alias fields into authSavedKeyRef', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const { getVoiceEngineRecordByProviderId, upsertVoiceEngineRecord } = await import(
      '../services/voiceEngineRegistry'
    )

    await upsertVoiceEngineRecord('user-1', 'custom-cloud-voice', {
      name: 'Custom Cloud Voice',
      baseUrl: 'https://api.example.com',
      authMode: 'header',
      authHeader: 'xi-api-key',
      authTokenFromApiKey: 'openrouter'
    })

    const record = await getVoiceEngineRecordByProviderId('user-1', 'byo:custom-cloud-voice')
    expect(record).toMatchObject({
      id: 'custom-cloud-voice',
      authSavedKeyRef: 'openrouter'
    })
  })

  it('rejects BYO engine ids that collide with built-in providers', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const { upsertVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

    await expect(
      upsertVoiceEngineRecord('user-1', 'elevenlabs', {
        name: 'ElevenLabs',
        baseUrl: 'https://api.elevenlabs.io'
      })
    ).rejects.toThrow(/built-in provider/i)

    await expect(
      upsertVoiceEngineRecord('user-1', 'fish', {
        name: 'Fish Audio',
        baseUrl: 'https://api.fish.audio'
      })
    ).rejects.toThrow(/built-in provider/i)
  })

  it('deletes an engine and clears user defaults that still point at it', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined = {
      schemaVersion: 2,
      tts: {
        providerId: 'byo:cleanup-test'
      },
      ttsEnginePrompts: {
        'byo:cleanup-test': {
          prompt: 'Use [laughs] sparingly.'
        },
        openai: {
          prompt: 'Keep OpenAI prompt.'
        }
      },
      ttsEngineSettings: {
        'byo:cleanup-test': {
          common: {
            speed: 1.1
          },
          providerOptions: {
            format: 'wav'
          }
        },
        openai: {
          common: {
            speed: 0.95
          }
        }
      },
      sttEngineSettings: {
        'byo:cleanup-test': {
          language: 'en',
          providerOptions: {
            chunk_ms: 500
          }
        },
        deepgram: {
          language: 'en-US'
        }
      }
    }

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const {
      deleteVoiceEngineRecord,
      getVoiceEngineRecordByProviderId,
      upsertVoiceEngineRecord
    } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'cleanup-test', {
      name: 'Cleanup Test',
      baseUrl: 'http://localhost:9999'
    })

    const deleted = await deleteVoiceEngineRecord('user-1', 'cleanup-test')

    expect(deleted).toMatchObject({
      deletedEngineId: 'cleanup-test',
      deletedProviderId: 'byo:cleanup-test',
      clearedUserDefaults: true
    })
    expect(storedVoiceSettings?.tts).toEqual({
      providerId: 'browser'
    })
    expect(storedVoiceSettings?.ttsEnginePrompts).toEqual({
      openai: {
        prompt: 'Keep OpenAI prompt.'
      }
    })
    expect(storedVoiceSettings?.ttsEngineSettings).toEqual({
      openai: {
        common: {
          speed: 0.95
        }
      }
    })
    expect(storedVoiceSettings?.sttEngineSettings).toEqual({
      deepgram: {
        language: 'en-US'
      }
    })
    expect(await getVoiceEngineRecordByProviderId('user-1', 'byo:cleanup-test')).toBeNull()
  })

  it('clears deleted BYO engines from global realtime STT and all agent voice lanes', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined = {
      schemaVersion: 2,
      tts: {
        providerId: 'byo:cleanup-test'
      },
      stt: {
        providerId: 'byo:cleanup-test'
      },
      realtimeStt: {
        providerId: 'byo:cleanup-test'
      }
    }

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })
    mockGetAgents.mockResolvedValue([
      {
        id: 'agent-tts',
        voice_profile: {
          schemaVersion: 2,
          tts: { providerId: 'byo:cleanup-test' },
          stt: { providerId: 'browser' }
        }
      },
      {
        id: 'agent-stt',
        voice_profile: {
          schemaVersion: 2,
          tts: { providerId: 'openai', voiceId: 'alloy' },
          stt: { providerId: 'byo:cleanup-test' },
          realtimeStt: { providerId: 'byo:cleanup-test' }
        }
      }
    ])

    const { deleteVoiceEngineRecord, upsertVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'cleanup-test', {
      name: 'Cleanup Test',
      baseUrl: 'http://localhost:9999'
    })

    const deleted = await deleteVoiceEngineRecord('user-1', 'cleanup-test')

    expect(deleted.clearedAgentIds).toEqual(['agent-tts', 'agent-stt'])
    expect(storedVoiceSettings?.tts).toEqual({ providerId: 'browser' })
    expect(storedVoiceSettings?.stt).toEqual({ providerId: 'browser' })
    expect(storedVoiceSettings?.realtimeStt).toEqual({ providerId: 'browser' })
    expect(mockUpdateAgent).toHaveBeenCalledWith('agent-tts', {
      voice_profile: {
        schemaVersion: 2,
        stt: { providerId: 'browser' }
      }
    })
    expect(mockUpdateAgent).toHaveBeenCalledWith('agent-stt', {
      voice_profile: {
        schemaVersion: 2,
        tts: { providerId: 'openai', voiceId: 'alloy' }
      }
    })
  })

  it('deletes saved voice clone profiles that belong to a deleted BYO engine', async () => {
    const jsonStore = new Map<string, any>()

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockResolvedValue({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: {
        schemaVersion: 2
      }
    })
    mockGetVoiceProfiles.mockResolvedValue([
      {
        id: 'clone-cleanup-test',
        user_id: 'user-1',
        name: 'Cleanup Clone',
        provider: 'byo:cleanup-test',
        voiceId: 'clone-cleanup-test',
        isClone: true,
        created_at: '2026-06-16T00:00:00.000Z',
        updated_at: '2026-06-16T00:00:00.000Z'
      },
      {
        id: 'clone-other',
        user_id: 'user-1',
        name: 'Other Clone',
        provider: 'byo:other-engine',
        voiceId: 'clone-other',
        isClone: true,
        created_at: '2026-06-16T00:00:00.000Z',
        updated_at: '2026-06-16T00:00:00.000Z'
      }
    ])

    const { deleteVoiceEngineRecord, upsertVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'cleanup-test', {
      name: 'Cleanup Test',
      baseUrl: 'http://localhost:9999'
    })

    const deleted = await deleteVoiceEngineRecord('user-1', 'cleanup-test')

    expect(deleted.deletedVoiceProfileIds).toEqual(['clone-cleanup-test'])
    expect(mockDeleteVoiceProfile).toHaveBeenCalledWith('clone-cleanup-test', 'user-1')
    expect(mockDeleteVoiceProfile).not.toHaveBeenCalledWith('clone-other', 'user-1')
  })

  it('deletes Batshit-managed local engine files only when requested', async () => {
    const previousManagedRoot = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
    const previousStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-engine-delete-'))
    const installsRoot = path.join(tempRoot, 'installs')
    const runtimeRoot = path.join(tempRoot, 'runtime')
    const installRoot = path.join(installsRoot, 'cleanup-test')
    const stateRoot = path.join(runtimeRoot, 'cleanup-test')
    const jsonStore = new Map<string, any>()

    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = installsRoot
    process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = runtimeRoot

    try {
      await mkdir(path.join(installRoot, 'logs'), { recursive: true })
      await mkdir(path.join(stateRoot, 'logs'), { recursive: true })

      mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
      mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
        jsonStore.set(key, value)
        return 'OK'
      })
      mockGetUserSettings.mockResolvedValue({
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: {
          schemaVersion: 2
        }
      })

      const { deleteVoiceEngineRecord, upsertVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

      await upsertVoiceEngineRecord('user-1', 'cleanup-test', {
        name: 'Cleanup Test',
        baseUrl: 'http://localhost:9999',
        localRuntime: {
          installRoot,
          installOwnership: 'batshit-managed',
          launch: {
            command: path.join(installRoot, 'server.py'),
            cwd: installRoot
          },
          startup: {
            autoStartOnLaunch: true
          }
        }
      })

      const deleted = await deleteVoiceEngineRecord('user-1', 'cleanup-test', {
        deleteLocalFiles: true
      })

      expect(deleted.localFiles).toMatchObject({
        requested: true,
        deleted: true,
        skipped: [],
        errors: []
      })
      expect(deleted.localFiles.deletedInstallRoots).toEqual([installRoot])
      expect(deleted.localFiles.deletedStateRoots).toEqual([stateRoot])
      await expect(stat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (previousManagedRoot === undefined) {
        delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
      } else {
        process.env.BATSHIT_MANAGED_INSTALLS_ROOT = previousManagedRoot
      }
      if (previousStateRoot === undefined) {
        delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
      } else {
        process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = previousStateRoot
      }
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('hides hidden suite members from public summaries while aggregating suite capabilities', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const { listVoiceEngineSummaries, upsertVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'qwen3-tts', {
      name: 'Qwen3 TTS Suite',
      baseUrl: 'http://127.0.0.1:8013',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16',
        voiceId: 'Ryan'
      },
      voiceSurface: {
        kind: 'static_catalog',
        voices: ['Ryan', 'Aiden', 'Serena', 'Vivian']
      },
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    })
    await upsertVoiceEngineRecord('user-1', 'qwen3-tts-base', {
      name: 'Qwen3 TTS Base',
      baseUrl: 'http://127.0.0.1:8013',
      supports: {
        tts: true,
        clone: true
      },
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16'
      },
      suite: {
        id: 'qwen3-tts',
        role: 'clone',
        hidden: true
      }
    })
    await upsertVoiceEngineRecord('user-1', 'qwen3-tts-voice-design', {
      name: 'Qwen3 TTS VoiceDesign',
      baseUrl: 'http://127.0.0.1:8013',
      requestFormat: 'openai-compatible',
      ttsDefaults: {
        modelId: 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16'
      },
      suite: {
        id: 'qwen3-tts',
        role: 'voice_design',
        hidden: true
      }
    })

    const summaries = await listVoiceEngineSummaries('user-1')

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'qwen3-tts',
      supportsClone: true,
      voiceSurface: {
        kind: 'hybrid',
        requiresDiscussion: false,
        voices: ['Ryan', 'Aiden', 'Serena', 'Vivian']
      }
    })
  })

  it('deletes hidden suite members when removing the visible suite record', async () => {
    const jsonStore = new Map<string, any>()
    let storedVoiceSettings: Record<string, any> | undefined = {
      schemaVersion: 2,
      tts: {
        providerId: 'byo:qwen3-tts'
      }
    }

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
      jsonStore.set(key, value)
      return 'OK'
    })
    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    const {
      deleteVoiceEngineRecord,
      getVoiceEngineRecordByProviderId,
      upsertVoiceEngineRecord
    } = await import('../services/voiceEngineRegistry')

    await upsertVoiceEngineRecord('user-1', 'qwen3-tts', {
      name: 'Qwen3 TTS Suite',
      baseUrl: 'http://127.0.0.1:8013',
      suite: {
        id: 'qwen3-tts',
        role: 'primary'
      }
    })
    await upsertVoiceEngineRecord('user-1', 'qwen3-tts-base', {
      name: 'Qwen3 TTS Base',
      baseUrl: 'http://127.0.0.1:8013',
      suite: {
        id: 'qwen3-tts',
        role: 'clone',
        hidden: true
      }
    })

    await deleteVoiceEngineRecord('user-1', 'qwen3-tts')

    expect(await getVoiceEngineRecordByProviderId('user-1', 'byo:qwen3-tts')).toBeNull()
    expect(await getVoiceEngineRecordByProviderId('user-1', 'byo:qwen3-tts-base')).toBeNull()
    expect(storedVoiceSettings?.tts).toEqual({
      providerId: 'browser'
    })
  })
})
