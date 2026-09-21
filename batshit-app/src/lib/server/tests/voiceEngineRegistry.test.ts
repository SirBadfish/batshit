import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  describe('Stop with Batshit', () => {
    // resolveLocalVoiceRuntimeLaunchRecordPath reads this at call time, so a
    // test that forgets it rewrites launch records under the REAL ~/.batshit.
    let stateRoot: string
    const originalStateRoot = process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
    const originalContainerized = process.env.BATSHIT_CONTAINERIZED

    beforeEach(async () => {
      stateRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-runtime-state-'))
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = stateRoot
      delete process.env.BATSHIT_CONTAINERIZED
    })

    afterEach(async () => {
      if (originalStateRoot === undefined) delete process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT
      else process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = originalStateRoot
      if (originalContainerized === undefined) delete process.env.BATSHIT_CONTAINERIZED
      else process.env.BATSHIT_CONTAINERIZED = originalContainerized
      await rm(stateRoot, { recursive: true, force: true })
    })

    it('never rewrites a launch record outside the configured state root', async () => {
      // Safety net for the hazard above: if the resolver ever stops honoring the
      // env var, this fails here instead of quietly editing Josh's real records.
      const { resolveLocalVoiceRuntimeLaunchRecordPath } = await import(
        '../services/voiceLocalRuntimePaths'
      )
      expect(resolveLocalVoiceRuntimeLaunchRecordPath('whisper-cpp').startsWith(stateRoot)).toBe(
        true
      )
    })

    function useStore() {
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
      mockUpdateUserSettings.mockImplementation(
        async (_userId: string, updates: Record<string, any>) => {
          storedVoiceSettings = updates.voice_settings
          return { id: 'settings_user-1', user_id: 'user-1', voice_settings: storedVoiceSettings }
        }
      )
      return jsonStore
    }

    const LAUNCHABLE = {
      name: 'Whisper.cpp',
      baseUrl: 'http://127.0.0.1:8077',
      localRuntime: {
        installRoot: '/tmp/whisper-cpp',
        installOwnership: 'batshit-managed' as const,
        launch: { command: '/tmp/whisper-cpp/bin/whisper-server', args: ['--port', '8077'] }
      }
    }

    it('offers the toggle only for an engine Batshit can honestly stop', async () => {
      useStore()
      const { listVoiceEngineSummaries, upsertVoiceEngineRecord } = await import(
        '../services/voiceEngineRegistry'
      )

      await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)
      // Connect Existing: no launch recipe, so Batshit never started it.
      await upsertVoiceEngineRecord('user-1', 'connected-tts', {
        name: 'Connected TTS',
        baseUrl: 'http://127.0.0.1:9100',
        localRuntime: { installOwnership: 'user-managed' as const }
      })

      const byId = Object.fromEntries(
        (await listVoiceEngineSummaries('user-1')).map((summary) => [summary.id, summary])
      )
      expect(byId['whisper-cpp'].localRuntime?.canStopOnShutdown).toBe(true)
      expect(byId['whisper-cpp'].localRuntime?.stopOnShutdownUnavailableReason).toBeUndefined()
      expect(byId['connected-tts'].localRuntime?.canStopOnShutdown).toBe(false)
      expect(byId['connected-tts'].localRuntime?.stopOnShutdownUnavailableReason).toBe(
        'no-launch-recipe'
      )
    })

    it('hides the toggle in Docker when no host operator is configured to stop it', async () => {
      useStore()
      const { resetHostOperatorVoiceStopSupportCacheForTests } = await import(
        '../services/voiceHostOperatorRuntime'
      )
      resetHostOperatorVoiceStopSupportCacheForTests()
      const { listVoiceEngineSummaries, upsertVoiceEngineRecord } = await import(
        '../services/voiceEngineRegistry'
      )
      await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)

      process.env.BATSHIT_CONTAINERIZED = '1'
      const summary = (await listVoiceEngineSummaries('user-1'))[0]
      expect(summary.localRuntime?.canStopOnShutdown).toBe(false)
      expect(summary.localRuntime?.stopOnShutdownUnavailableReason).toBe('docker')
    })

    describe('in Docker, with a host operator', () => {
      // A real HTTP server plays the operator's authenticated /health.
      let server: http.Server
      let health: Record<string, unknown>
      let privateEnv: Record<string, string | undefined>

      beforeEach(async () => {
        server = http.createServer((req, res) => {
          const authorized = req.headers.authorization === 'Bearer operator-test-token'
          res.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' })
          res.end(JSON.stringify(authorized ? health : { ok: false, error: 'Unauthorized.' }))
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        privateEnv = (await import('$env/dynamic/private')).env as Record<string, string | undefined>
        privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = 'operator-test-token'
        ;(await import('../services/voiceHostOperatorRuntime')).resetHostOperatorVoiceStopSupportCacheForTests()
        process.env.BATSHIT_CONTAINERIZED = '1'
      })

      afterEach(async () => {
        delete privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_URL
        delete privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN
        ;(await import('../services/voiceHostOperatorRuntime')).resetHostOperatorVoiceStopSupportCacheForTests()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      })

      async function summaryWith(operatorHealth: Record<string, unknown>) {
        health = operatorHealth
        ;(await import('../services/voiceHostOperatorRuntime')).resetHostOperatorVoiceStopSupportCacheForTests()
        useStore()
        const { listVoiceEngineSummaries, upsertVoiceEngineRecord } = await import(
          '../services/voiceEngineRegistry'
        )
        await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)
        return (await listVoiceEngineSummaries('user-1'))[0].localRuntime
      }

      it('offers the toggle once the operator records and can stop what it starts', async () => {
        const runtime = await summaryWith({
          ok: true,
          sandboxRevision: 5,
          hostVoiceControls: ['start', 'stop', 'write-reference-audio']
        })
        expect(runtime?.canStopOnShutdown).toBe(true)
        expect(runtime?.stopOnShutdownUnavailableReason).toBeUndefined()
      })

      it('hides it while the operator is older than revision 5', async () => {
        // Revision 5 is when the operator started recording what it starts; an older one is too
        // old whatever it lists. start-docker replaces it on the next start.
        const runtime = await summaryWith({
          ok: true,
          sandboxRevision: 4,
          hostVoiceControls: ['start', 'stop', 'write-reference-audio']
        })
        expect(runtime?.canStopOnShutdown).toBe(false)
        expect(runtime?.stopOnShutdownUnavailableReason).toBe('docker')
      })

      it('hides it when the operator does not offer the stop (Windows, for now)', async () => {
        const runtime = await summaryWith({
          ok: true,
          sandboxRevision: 5,
          hostVoiceControls: ['start', 'write-reference-audio']
        })
        expect(runtime?.canStopOnShutdown).toBe(false)
      })
    })

    describe('attach records never outlive their engine', () => {
      // chatterbox-turbo's launch started the runtime on 8012 (this test process stands in for
      // it); kokoro uses the same runtime and says keep running.
      async function sharedRuntime() {
        useStore()
        const registry = await import('../services/voiceEngineRegistry')
        const records = await import('../services/voiceRuntimeLaunchRecords')
        await registry.upsertVoiceEngineRecord('user-1', 'chatterbox-turbo', {
          ...LAUNCHABLE,
          name: 'Chatterbox',
          baseUrl: 'http://127.0.0.1:8012'
        })
        await registry.upsertVoiceEngineRecord('user-1', 'kokoro', {
          ...LAUNCHABLE,
          name: 'Kokoro',
          baseUrl: 'http://localhost:8012'
        })
        await records.writeLocalRuntimeLaunchRecord({
          engineId: 'chatterbox-turbo',
          pid: process.pid,
          command: '/tmp/mlx_audio.server',
          endpoint: 'http://127.0.0.1:8012',
          launchedAt: '2026-09-17T01:00:03.000Z'
        })
        expect(
          await records.attachLocalRuntimeLaunchRecord({
            engineId: 'kokoro',
            endpoint: 'http://localhost:8012',
            stopOnShutdown: false
          })
        ).toBe(true)
        return registry
      }
      const kokoroRecordExists = () =>
        stat(path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.json')).then(
          () => true,
          () => false
        )

      it('a plain delete removes the engine\'s attach record at once', async () => {
        const registry = await sharedRuntime()
        await registry.deleteVoiceEngineRecord('user-1', 'kokoro')
        expect(await kokoroRecordExists()).toBe(false)
        // The runtime's own record stays: chatterbox-turbo still started it.
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'chatterbox-turbo', '.batshit-local-runtime-launch.json'), 'utf8')).pid
        ).toBe(process.pid)
      })

      it('moving the engine to another endpoint removes its attach record for the old one', async () => {
        const registry = await sharedRuntime()
        await registry.upsertVoiceEngineRecord('user-1', 'kokoro', { baseUrl: 'http://127.0.0.1:8013' })
        expect(await kokoroRecordExists()).toBe(false)
      })

      it('an unrelated save keeps it', async () => {
        const registry = await sharedRuntime()
        await registry.upsertVoiceEngineRecord('user-1', 'kokoro', { name: 'Kokoro (renamed)' })
        expect(await kokoroRecordExists()).toBe(true)
      })
    })

    describe('"Delete local files too" stops the engine first', () => {
      // A real detached "engine" under a throwaway managed installs root; its launch record is
      // written by the real writer. Stopping is checked on the real process.
      let installsRoot: string
      const originalInstallsRoot = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
      const originalPath = process.env.PATH
      const running = new Set<number>()

      beforeEach(async () => {
        installsRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-installs-'))
        process.env.BATSHIT_MANAGED_INSTALLS_ROOT = installsRoot
      })
      afterEach(async () => {
        process.env.PATH = originalPath
        for (const pid of running) {
          for (const target of [-pid, pid]) {
            try {
              process.kill(target, 'SIGKILL')
            } catch {}
          }
        }
        running.clear()
        if (originalInstallsRoot === undefined) delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
        else process.env.BATSHIT_MANAGED_INSTALLS_ROOT = originalInstallsRoot
        await rm(installsRoot, { recursive: true, force: true })
      })

      const alive = (pid: number) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }

      async function launchedEngine(engineId: string, port: number) {
        const installRoot = path.join(installsRoot, engineId)
        await mkdir(installRoot, { recursive: true })
        const script = path.join(installRoot, 'serve.mjs')
        await writeFile(script, 'setInterval(() => {}, 1000)\n')
        const child = spawn(process.execPath, [script], { cwd: installRoot, detached: true, stdio: 'ignore' })
        child.unref()
        // The engine must really be running first, or "it was stopped" would pass for nothing.
        expect(typeof child.pid).toBe('number')
        running.add(child.pid as number)
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(alive(child.pid as number)).toBe(true)
        const registry = await import('../services/voiceEngineRegistry')
        await registry.upsertVoiceEngineRecord('user-1', engineId, {
          name: engineId,
          baseUrl: `http://127.0.0.1:${port}`,
          localRuntime: {
            installRoot,
            installOwnership: 'batshit-managed' as const,
            launch: { command: process.execPath, args: [script], cwd: installRoot }
          }
        })
        const records = await import('../services/voiceRuntimeLaunchRecords')
        await records.writeLocalRuntimeLaunchRecord({
          engineId,
          pid: child.pid as number,
          command: process.execPath,
          args: [script],
          cwd: installRoot,
          endpoint: `http://127.0.0.1:${port}`,
          launchedAt: new Date().toISOString()
        })
        return { pid: child.pid as number, installRoot }
      }

      const gone = async (pid: number) => {
        for (let tries = 0; tries < 40 && alive(pid); tries += 1) await new Promise((r) => setTimeout(r, 100))
        return !alive(pid)
      }

      it('a runtime only the deleted engine used is stopped, then its files go', async () => {
        useStore()
        const { pid, installRoot } = await launchedEngine('solo-engine', 8201)
        const { deleteVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

        const deleted = await deleteVoiceEngineRecord('user-1', 'solo-engine', { deleteLocalFiles: true })

        expect(await gone(pid)).toBe(true)
        expect(deleted.localFiles).toMatchObject({ deleted: true, errors: [] })
        await expect(stat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(path.join(stateRoot, 'solo-engine'))).rejects.toMatchObject({ code: 'ENOENT' })
      })

      it('a runtime another engine still uses keeps running, and stays recorded', async () => {
        useStore()
        const { pid } = await launchedEngine('starter-engine', 8202)
        const registry = await import('../services/voiceEngineRegistry')
        await registry.upsertVoiceEngineRecord('user-1', 'sharing-engine', {
          ...LAUNCHABLE,
          name: 'Sharing',
          baseUrl: 'http://localhost:8202'
        })
        const records = await import('../services/voiceRuntimeLaunchRecords')
        expect(
          await records.attachLocalRuntimeLaunchRecord({ engineId: 'sharing-engine', endpoint: 'http://localhost:8202', stopOnShutdown: true })
        ).toBe(true)

        const deleted = await registry.deleteVoiceEngineRecord('user-1', 'starter-engine', { deleteLocalFiles: true })

        expect(alive(pid)).toBe(true)
        expect(deleted.localFiles.errors).toEqual([])
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'sharing-engine', '.batshit-local-runtime-launch.json'), 'utf8'))
        ).toMatchObject({ pid, startedBy: 'starter-engine' })
      })

      it('an engine that cannot be checked or stopped keeps its files and record, and says so', async () => {
        useStore()
        const { pid, installRoot } = await launchedEngine('stuck-engine', 8203)
        // `ps` fails: Batshit cannot confirm the pid is still this engine, so it must not kill,
        // and must not throw the record away either.
        const fakeBin = path.join(installsRoot, 'fake-bin')
        await mkdir(fakeBin, { recursive: true })
        await writeFile(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
        process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`
        const { deleteVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

        const deleted = await deleteVoiceEngineRecord('user-1', 'stuck-engine', { deleteLocalFiles: true })

        expect(alive(pid)).toBe(true)
        expect(deleted.localFiles.errors).toEqual([
          expect.objectContaining({ engineId: 'stuck-engine', message: expect.stringMatching(/still running .* could not be stopped/) })
        ])
        expect((await stat(installRoot)).isDirectory()).toBe(true)
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'stuck-engine', '.batshit-local-runtime-launch.json'), 'utf8')).pid
        ).toBe(pid)
      })
    })

    it('the switch on an engine that shares a runtime another engine launched is recorded', async () => {
      useStore()
      const { applyVoiceEnginePublicUpdates, upsertVoiceEngineRecord } = await import(
        '../services/voiceEngineRegistry'
      )
      await upsertVoiceEngineRecord('user-1', 'kokoro', {
        ...LAUNCHABLE,
        name: 'Kokoro',
        baseUrl: 'http://localhost:8012'
      })
      // chatterbox-turbo's launch started the runtime on 8012 (this test process stands in for it).
      await mkdir(path.join(stateRoot, 'chatterbox-turbo'), { recursive: true })
      await writeFile(
        path.join(stateRoot, 'chatterbox-turbo', '.batshit-local-runtime-launch.json'),
        JSON.stringify({
          engineId: 'chatterbox-turbo',
          pid: process.pid,
          command: '/tmp/mlx_audio.server',
          endpoint: 'http://127.0.0.1:8012',
          launchedAt: '2026-09-17T01:00:03.000Z'
        })
      )

      await applyVoiceEnginePublicUpdates('user-1', [
        { id: 'kokoro', localRuntime: { startup: { stopOnShutdown: false } } }
      ])

      const record = JSON.parse(
        await readFile(path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.json'), 'utf8')
      )
      expect(record).toMatchObject({ pid: process.pid, startedBy: 'chatterbox-turbo', stopOnShutdown: false })
    })

    it('saves the choice and rewrites the on-disk launch record the shutdown hooks read', async () => {
      useStore()
      const { applyVoiceEnginePublicUpdates, getVoiceEngineRecord, upsertVoiceEngineRecord } =
        await import('../services/voiceEngineRegistry')
      const { resolveLocalVoiceRuntimeLaunchRecordPath } = await import(
        '../services/voiceLocalRuntimePaths'
      )

      await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)

      // A record from an earlier launch, written before the user chose.
      const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath('whisper-cpp')
      await mkdir(path.dirname(recordPath), { recursive: true })
      await writeFile(
        recordPath,
        JSON.stringify({ engineId: 'whisper-cpp', pid: 4242, stopOnShutdown: true })
      )

      await applyVoiceEnginePublicUpdates('user-1', [
        { id: 'whisper-cpp', localRuntime: { startup: { stopOnShutdown: false } } }
      ])

      expect(
        (await getVoiceEngineRecord('user-1', 'whisper-cpp'))?.localRuntime?.startup?.stopOnShutdown
      ).toBe(false)
      // Saving is not when the engine restarts, so a quit one second later has
      // to read the new choice off disk.
      const written = JSON.parse(await readFile(recordPath, 'utf8'))
      expect(written).toMatchObject({ engineId: 'whisper-cpp', pid: 4242, stopOnShutdown: false })

      await applyVoiceEnginePublicUpdates('user-1', [
        { id: 'whisper-cpp', localRuntime: { startup: { stopOnShutdown: true } } }
      ])
      expect(JSON.parse(await readFile(recordPath, 'utf8')).stopOnShutdown).toBe(true)
    })

    it('saving an unrelated field leaves an untouched engine stopping on shutdown', async () => {
      useStore()
      const { applyVoiceEnginePublicUpdates, getVoiceEngineRecord, upsertVoiceEngineRecord } =
        await import('../services/voiceEngineRegistry')

      await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)
      await applyVoiceEnginePublicUpdates('user-1', [{ id: 'whisper-cpp', enabled: false }])

      const startup = (await getVoiceEngineRecord('user-1', 'whisper-cpp'))?.localRuntime?.startup
      expect(startup?.stopOnShutdown).not.toBe(false)
    })

    it('a missing launch record is a no-op, not a failed save', async () => {
      useStore()
      const { applyVoiceEnginePublicUpdates, upsertVoiceEngineRecord } = await import(
        '../services/voiceEngineRegistry'
      )
      await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)

      // The engine has never been launched by this Batshit: there is nothing to
      // stop, and the preference will travel with its next spawn.
      const updated = await applyVoiceEnginePublicUpdates('user-1', [
        { id: 'whisper-cpp', localRuntime: { startup: { stopOnShutdown: false } } }
      ])
      expect(updated[0].localRuntime?.startup?.stopOnShutdown).toBe(false)
    })
  })
})
