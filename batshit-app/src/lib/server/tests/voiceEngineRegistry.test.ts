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
const mockResolveLiveKitRuntimeEngineRefs = vi.fn(async (_userId: string): Promise<unknown[]> => [])
const mockRedisExecute = vi.fn(async (operation: any) =>
  operation({
    json: {
      get: mockRedisJsonGet,
      set: mockRedisJsonSet
    }
  })
)

// The registry's launch-record tidy also takes LiveKit's runtimes in use (BL-1300).
vi.mock('$lib/server/services/liveKitSidecarRuntime', () => ({
  resolveLiveKitRuntimeEngineRefs: (userId: string) => mockResolveLiveKitRuntimeEngineRefs(userId)
}))

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
  // "Delete local files too" reads the Docker host operator's records (BL-1292): never the real
  // folder under ~/.batshit. A test that needs one points this at its own.
  const originalOperatorRoot = process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR
  afterEach(() => {
    if (originalOperatorRoot === undefined) delete process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR
    else process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR = originalOperatorRoot
  })

  beforeEach(() => {
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR = path.join(os.tmpdir(), `batshit-test-no-operator-${process.pid}`)
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

  describe('"Delete local files too" for files Batshit cannot delete (BL-176)', () => {
    const saved = {
      installs: process.env.BATSHIT_MANAGED_INSTALLS_ROOT,
      state: process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT,
      containerized: process.env.BATSHIT_CONTAINERIZED
    }
    let tempRoot: string

    beforeEach(async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-voice-engine-foreign-root-'))
      process.env.BATSHIT_MANAGED_INSTALLS_ROOT = path.join(tempRoot, 'managed-installs')
      process.env.BATSHIT_VOICE_RUNTIME_STATE_ROOT = path.join(tempRoot, 'runtime')
      const jsonStore = new Map<string, any>()
      mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
      mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
        jsonStore.set(key, value)
        return 'OK'
      })
      mockGetUserSettings.mockResolvedValue({
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: { schemaVersion: 2 }
      })
    })

    afterEach(async () => {
      for (const [key, value] of [
        ['BATSHIT_MANAGED_INSTALLS_ROOT', saved.installs],
        ['BATSHIT_VOICE_RUNTIME_STATE_ROOT', saved.state],
        ['BATSHIT_CONTAINERIZED', saved.containerized]
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(tempRoot, { recursive: true, force: true })
    })

    async function deleteEngineInstalledAt(installRoot: string) {
      await mkdir(path.join(installRoot, 'models'), { recursive: true })
      const { deleteVoiceEngineRecord, upsertVoiceEngineRecord } = await import('../services/voiceEngineRegistry')
      await upsertVoiceEngineRecord('user-1', 'kokoro-host', {
        name: 'Kokoro Host',
        baseUrl: 'http://localhost:9998',
        localRuntime: {
          installRoot,
          installOwnership: 'batshit-managed',
          launch: { command: path.join(installRoot, 'server.py'), cwd: installRoot }
        }
      })
      return deleteVoiceEngineRecord('user-1', 'kokoro-host', { deleteLocalFiles: true })
    }

    it('in Docker, says the files are on the computer that runs Docker, where they are, and what to do', async () => {
      process.env.BATSHIT_CONTAINERIZED = '1'
      // Installed by the host operator: a host path the container cannot reach.
      const hostInstallRoot = path.join(tempRoot, 'host-home', '.batshit', 'installs', 'kokoro-host')
      const deleted = await deleteEngineInstalledAt(hostInstallRoot)

      expect(deleted.localFiles.deleted).toBe(false)
      expect(deleted.localFiles.errors).toEqual([])
      expect(deleted.localFiles.skipped).toHaveLength(1)
      const reason = deleted.localFiles.skipped[0].reason
      expect(reason).toContain('"Kokoro Host"')
      expect(reason).toContain('the computer that runs Docker')
      expect(reason).toContain(hostInstallRoot)
      expect(reason).toMatch(/Delete that folder yourself/)
      expect(reason).not.toMatch(/does not match/)
      // Nothing was deleted.
      expect((await stat(hostInstallRoot)).isDirectory()).toBe(true)
    })

    it('outside Docker, names the saved folder and the managed one, and what to do', async () => {
      delete process.env.BATSHIT_CONTAINERIZED
      const elsewhere = path.join(tempRoot, 'somewhere-else', 'kokoro-host')
      const deleted = await deleteEngineInstalledAt(elsewhere)

      expect(deleted.localFiles.deleted).toBe(false)
      const reason = deleted.localFiles.skipped[0].reason
      expect(reason).toContain('"Kokoro Host"')
      expect(reason).toContain(elsewhere)
      expect(reason).toContain(path.join(tempRoot, 'managed-installs', 'kokoro-host'))
      expect(reason).toMatch(/Delete that folder yourself/)
      expect(reason).not.toContain('Docker')
      expect((await stat(elsewhere)).isDirectory()).toBe(true)
    })

    // BL-1289: the install and state folders are shared by every Batshit on the computer that keeps
    // the default ones. Deleting this Batshit's engine never stops another Batshit's launch of the
    // same engine id and never removes its records or its files.
    it("never stops another Batshit's launch of the same engine, nor removes its records or the shared files", async () => {
      delete process.env.BATSHIT_CONTAINERIZED
      const installRoot = path.join(tempRoot, 'managed-installs', 'kokoro-host')
      const theirs = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', tempRoot], { detached: true, stdio: 'ignore' })
      await new Promise((resolve) => theirs.once('spawn', resolve))
      try {
        const stateDir = path.join(tempRoot, 'runtime', 'kokoro-host')
        await mkdir(stateDir, { recursive: true })
        const recordPath = path.join(stateDir, '.batshit-local-runtime-launch.json')
        const record = JSON.stringify({
          engineId: 'kokoro-host',
          pid: theirs.pid,
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)', tempRoot],
          launchedAt: new Date().toISOString(),
          registry: 'redis-0000000000000000',
          stopOnShutdown: false
        })
        await writeFile(recordPath, record)

        const deleted = await deleteEngineInstalledAt(installRoot)

        expect(deleted.localFiles.deleted).toBe(false)
        expect(deleted.localFiles.skipped).toEqual([])
        // An error, so the Engine Manager always shows it.
        expect(deleted.localFiles.errors).toHaveLength(1)
        expect(deleted.localFiles.errors[0].message).toContain('another Batshit on this computer (Batshit in Docker included), or another engine, may still use them')
        expect(deleted.localFiles.errors[0].message).toContain(installRoot)
        expect(deleted.localFiles.errors[0].message).toContain(recordPath)
        // Their process runs, their record keeps its bytes, and the shared install folder stays.
        expect(() => process.kill(theirs.pid as number, 0)).not.toThrow()
        expect(await readFile(recordPath, 'utf8')).toBe(record)
        expect((await stat(installRoot)).isDirectory()).toBe(true)
      } finally {
        try {
          process.kill(-(theirs.pid as number), 'SIGKILL')
        } catch {}
      }
    })

    // An attach record lives in the folder of the engine that attaches. A runtime another engine
    // still uses runs from these files, so they stay, whichever Batshit that engine is in (this
    // Batshit's own case, with a real attach, is "a runtime another engine still uses" below).
    it("keeps the files of a runtime an engine of another Batshit still uses through its attach record", async () => {
      delete process.env.BATSHIT_CONTAINERIZED
      const installRoot = path.join(tempRoot, 'managed-installs', 'kokoro-host')
      const { writeLocalRuntimeLaunchRecord } = await import('../services/voiceRuntimeLaunchRecords')
      const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', tempRoot], { detached: true, stdio: 'ignore' })
      await new Promise((resolve) => runtime.once('spawn', resolve))
      try {
        const launch = { engineId: 'kokoro-host', pid: runtime.pid as number, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', tempRoot], launchedAt: new Date().toISOString() }
        await writeLocalRuntimeLaunchRecord(launch)
        const ownPath = path.join(tempRoot, 'runtime', 'kokoro-host', '.batshit-local-runtime-launch.json')
        const own = await readFile(ownPath, 'utf8')
        const attachPath = path.join(tempRoot, 'runtime', 'whisper', '.batshit-local-runtime-launch.json')
        await mkdir(path.dirname(attachPath), { recursive: true })
        const attach = JSON.stringify({ ...launch, engineId: 'whisper', startedBy: 'kokoro-host', registry: 'redis-0000000000000000', stopOnShutdown: false })
        await writeFile(attachPath, attach)

        const deleted = await deleteEngineInstalledAt(installRoot)

        expect(deleted.localFiles.deleted).toBe(false)
        expect(deleted.localFiles.errors).toHaveLength(1)
        expect(deleted.localFiles.errors[0].message).toContain(attachPath)
        expect(() => process.kill(runtime.pid as number, 0)).not.toThrow()
        expect(await readFile(ownPath, 'utf8')).toBe(own)
        expect(await readFile(attachPath, 'utf8')).toBe(attach)
        expect((await stat(path.join(installRoot, 'models'))).isDirectory()).toBe(true)
      } finally {
        try {
          process.kill(-(runtime.pid as number), 'SIGKILL')
        } catch {}
      }
    })

    it('keeps the files while the Docker host operator runs that engine, and says so (BL-1292)', async () => {
      delete process.env.BATSHIT_CONTAINERIZED
      const installRoot = path.join(tempRoot, 'managed-installs', 'kokoro-host')
      process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_STATE_DIR = path.join(tempRoot, 'operator')
      const operatorPath = path.join(tempRoot, 'operator', 'kokoro-host', '.batshit-local-runtime-launch.json')
      await mkdir(path.dirname(operatorPath), { recursive: true })
      const operatorRecord = JSON.stringify({ engineId: 'kokoro-host', pid: process.pid, command: path.join(installRoot, 'server.py'), launchedBy: 'batshit-docker' })
      await writeFile(operatorPath, operatorRecord)

      const deleted = await deleteEngineInstalledAt(installRoot)

      expect(deleted.localFiles.deleted).toBe(false)
      expect(deleted.localFiles.errors).toHaveLength(1)
      expect(deleted.localFiles.errors[0].message).toContain('Batshit in Docker included')
      expect(deleted.localFiles.errors[0].message).toContain(operatorPath)
      expect(await readFile(operatorPath, 'utf8')).toBe(operatorRecord)
      expect((await stat(path.join(installRoot, 'models'))).isDirectory()).toBe(true)
    })

    it('with only its own records there, removes the install and state folders as before', async () => {
      delete process.env.BATSHIT_CONTAINERIZED
      const installRoot = path.join(tempRoot, 'managed-installs', 'kokoro-host')
      const { writeLocalRuntimeLaunchRecord } = await import('../services/voiceRuntimeLaunchRecords')
      // A launch of this Batshit whose process is gone.
      const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      await new Promise((resolve) => gone.once('exit', resolve))
      await writeLocalRuntimeLaunchRecord({ engineId: 'kokoro-host', pid: gone.pid as number, command: '/bin/x' })
      const stateDir = path.join(tempRoot, 'runtime', 'kokoro-host')

      const deleted = await deleteEngineInstalledAt(installRoot)

      expect(deleted.localFiles.skipped).toEqual([])
      expect(deleted.localFiles.deletedInstallRoots).toEqual([installRoot])
      expect(deleted.localFiles.deletedStateRoots).toEqual([path.resolve(stateDir)])
      await expect(stat(installRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(stateDir)).rejects.toMatchObject({ code: 'ENOENT' })
    })
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

    // BL-1300: LiveKit is not a voice engine. The tidy after every engine save released LiveKit's
    // "keep running", because it read LiveKit as deleted.
    it("keeps LiveKit's keep-running through an engine save while LiveKit is in use, and skips the tidy when its settings cannot be read", async () => {
      useStore()
      const { writeLocalRuntimeLaunchRecord } = await import('../services/voiceRuntimeLaunchRecords')
      await writeLocalRuntimeLaunchRecord({ engineId: 'livekit-server', pid: process.pid, command: '/x/livekit-server', endpoint: 'http://127.0.0.1:7880', stopOnShutdown: false })
      const choice = async () =>
        JSON.parse(await readFile(path.join(stateRoot, 'livekit-server', '.batshit-local-runtime-launch.json'), 'utf8')).stopOnShutdown
      const registry = await import('../services/voiceEngineRegistry')

      mockResolveLiveKitRuntimeEngineRefs.mockResolvedValueOnce([
        { id: 'livekit-server', baseUrl: 'http://127.0.0.1:7880', localRuntime: { launch: { command: '/x/livekit-server' } } }
      ])
      await registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)
      expect(mockResolveLiveKitRuntimeEngineRefs).toHaveBeenCalledWith('user-1')
      expect(await choice()).toBe(false)

      mockResolveLiveKitRuntimeEngineRefs.mockRejectedValueOnce(new Error('redis down'))
      await registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', { ...LAUNCHABLE, name: 'Whisper' })
      expect(await choice()).toBe(false)

      // Not configured: LiveKit's launch follows the tidy as any deleted engine's does.
      await registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', { ...LAUNCHABLE, name: 'Whisper.cpp' })
      expect(await choice()).toBeUndefined()
    })

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

    it('projects the Windows guest policy only for stoppable engines and never saves over an OFF choice', async () => {
      const runtimeContext = await import('../services/runtimeContext')
      const context = runtimeContext.resolveRuntimeContext({
        BATSHIT_RUNTIME_OWNER: 'pinokio',
        BATSHIT_PINOKIO_HOST: 'windows-wsl',
        BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned'
      }, 'linux')
      const capability = vi.spyOn(runtimeContext, 'resolveRuntimeContext').mockReturnValue(context)
      try {
        useStore()
        const registry = await import('../services/voiceEngineRegistry')
        await registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', {
          ...LAUNCHABLE,
          localRuntime: { ...LAUNCHABLE.localRuntime, startup: { stopOnShutdown: false } }
        })
        await registry.upsertVoiceEngineRecord('user-1', 'connected-tts', {
          name: 'Connected TTS', baseUrl: 'http://127.0.0.1:9100',
          localRuntime: { installOwnership: 'user-managed' }
        })
        const byId = Object.fromEntries((await registry.listVoiceEngineSummaries('user-1')).map((summary) => [summary.id, summary]))
        expect(byId['whisper-cpp'].localRuntime).toMatchObject({
          canStopOnShutdown: true, shutdownStopPolicy: 'all-owned', startup: { stopOnShutdown: false }
        })
        expect(byId['connected-tts'].localRuntime).toMatchObject({ canStopOnShutdown: false })
        expect(byId['connected-tts'].localRuntime?.shutdownStopPolicy).toBeUndefined()
        expect((await registry.getVoiceEngineRecordByProviderId('user-1', 'byo:whisper-cpp'))?.localRuntime?.startup?.stopOnShutdown).toBe(false)
        expect((await registry.getVoiceEngineRecordByProviderId('user-1', 'byo:whisper-cpp'))?.localRuntime).not.toHaveProperty('shutdownStopPolicy')
      } finally {
        capability.mockRestore()
      }
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

      it('while its saved record cannot be read, no save tidies it away or releases its keep-running choice', async () => {
        const registry = await sharedRuntime()
        // A newer Batshit wrote kokoro's record with a field this one does not know. Its engine
        // may still use the shared runtime, so the tidy cannot know its record is stale.
        const stored = await mockRedisJsonGet('voice_engine_registry:user-1')
        stored.records.find((record: { id: string }) => record.id === 'kokoro').futureOption = true

        await registry.upsertVoiceEngineRecord('user-1', 'chatterbox-turbo', { name: 'Chatterbox (renamed)' })

        expect(await kokoroRecordExists()).toBe(true)
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'kokoro', '.batshit-local-runtime-launch.json'), 'utf8'))
            .stopOnShutdown
        ).toBe(false)
        expect(
          (await mockRedisJsonGet('voice_engine_registry:user-1')).records.map((record: { id: string }) => record.id).sort()
        ).toEqual(['chatterbox-turbo', 'kokoro'])
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

      it('a runtime another engine still uses keeps running, stays recorded, and keeps the files it runs from (BL-1289)', async () => {
        useStore()
        const { pid, installRoot } = await launchedEngine('starter-engine', 8202)
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
        expect(deleted.localFiles.deleted).toBe(false)
        expect(deleted.localFiles.errors).toEqual([
          expect.objectContaining({
            engineId: 'starter-engine',
            message: expect.stringContaining(path.join(stateRoot, 'sharing-engine', '.batshit-local-runtime-launch.json'))
          })
        ])
        expect((await stat(installRoot)).isDirectory()).toBe(true)
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'sharing-engine', '.batshit-local-runtime-launch.json'), 'utf8'))
        ).toMatchObject({ pid, startedBy: 'starter-engine' })
        // The starter's own record stays, so its shutdown choice still counts.
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'starter-engine', '.batshit-local-runtime-launch.json'), 'utf8')).pid
        ).toBe(pid)
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

      it('a launch record that cannot be read keeps the engine, its files and every record, and says what to do (BL-1268)', async () => {
        useStore()
        const { pid, installRoot } = await launchedEngine('garbled-engine', 8204)
        // An earlier launch's record, moved aside and now malformed: it may name a copy still
        // running from these files, so nothing is stopped and nothing is deleted.
        const aside = path.join(stateRoot, 'garbled-engine', '.batshit-local-runtime-launch.4242.json')
        await writeFile(aside, '{ "pid": 4242, "stopOnShutdown": fal')
        const { deleteVoiceEngineRecord } = await import('../services/voiceEngineRegistry')

        const deleted = await deleteVoiceEngineRecord('user-1', 'garbled-engine', { deleteLocalFiles: true })

        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(alive(pid)).toBe(true)
        expect(deleted.localFiles.deleted).toBe(false)
        expect(deleted.localFiles.errors).toHaveLength(1)
        const { message } = deleted.localFiles.errors[0]
        expect(message).toMatch(/^Batshit kept the local files of "garbled-engine": the launch record .*\.4242\.json is not valid JSON, and it may name an engine still running from them\. Once that engine has stopped \(restarting the computer stops it\), repair or remove that file or folder, then delete /)
        expect(message).toContain(`delete ${installRoot} and ${path.join(stateRoot, 'garbled-engine')} yourself.`)
        expect(message).not.toMatch(/is still running and could not be stopped/)
        expect((await stat(installRoot)).isDirectory()).toBe(true)
        expect(await readFile(aside, 'utf8')).toBe('{ "pid": 4242, "stopOnShutdown": fal')
        expect(
          JSON.parse(await readFile(path.join(stateRoot, 'garbled-engine', '.batshit-local-runtime-launch.json'), 'utf8')).pid
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

      // A record from an earlier launch by this Batshit (its registry), written before the user chose.
      const { resolveVoiceRuntimeRegistryIdentity } = await import('../services/voiceRuntimeLaunchRecords')
      const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath('whisper-cpp')
      await mkdir(path.dirname(recordPath), { recursive: true })
      await writeFile(
        recordPath,
        JSON.stringify({ engineId: 'whisper-cpp', pid: 4242, stopOnShutdown: true, registry: await resolveVoiceRuntimeRegistryIdentity() })
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

    // BL-1286: the choice updater runs after ANY update of an engine with a launch recipe, so an
    // unrelated save here must never write this Batshit's choice into another Batshit's record.
    it("an unrelated update leaves another Batshit's keep-running record of the same engine unchanged", async () => {
      useStore()
      const { applyVoiceEnginePublicUpdates, upsertVoiceEngineRecord } = await import(
        '../services/voiceEngineRegistry'
      )
      const { resolveLocalVoiceRuntimeLaunchRecordPath } = await import(
        '../services/voiceLocalRuntimePaths'
      )
      await upsertVoiceEngineRecord('user-1', 'whisper-cpp', LAUNCHABLE)

      // Another Batshit (another registry) launched its whisper-cpp, which runs, and keeps it running.
      const recordPath = resolveLocalVoiceRuntimeLaunchRecordPath('whisper-cpp')
      await mkdir(path.dirname(recordPath), { recursive: true })
      const theirs = JSON.stringify({
        engineId: 'whisper-cpp',
        pid: process.pid,
        stopOnShutdown: false,
        registry: 'redis-0000000000000000'
      })
      await writeFile(recordPath, theirs)

      await applyVoiceEnginePublicUpdates('user-1', [{ id: 'whisper-cpp', enabled: false }])

      expect(await readFile(recordPath, 'utf8')).toBe(theirs)
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

  // A registry Batshit cannot fully read must never be written over. Before, a Redis error, or one
  // record the strict schema refused (a field from a newer Batshit, say), read as an EMPTY
  // registry, and the next save of any engine wrote that empty list back: every other engine was
  // gone, and the launch-record tidy that follows every save then released their launch records.
  describe('a registry Batshit cannot fully read is never written over', () => {
    const KEY = 'voice_engine_registry:user-1'
    const engineRecord = (id: string, name: string, port: number) => ({
      id,
      name,
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}`,
      requestFormat: 'openai-compatible',
      ttsPath: '/v1/audio/speech'
    })
    // Written by a newer Batshit: a field this one does not know, which the strict schema refuses.
    const FROM_NEWER = {
      id: 'dots-tts-mf',
      name: 'Dots TTS',
      enabled: true,
      baseUrl: 'http://127.0.0.1:8122',
      requestFormat: 'openai-compatible',
      futureOption: { lanes: ['a', 'b'] }
    }

    function seed(records: unknown[], envelope: Record<string, unknown> = {}) {
      const jsonStore = new Map<string, any>()
      jsonStore.set(KEY, { version: 1, records, ...envelope })
      mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
      // Stored as JSON, as RedisJSON would: nothing the writer holds on to changes it later.
      mockRedisJsonSet.mockImplementation(async (key: string, _path: string, value: any) => {
        jsonStore.set(key, JSON.parse(JSON.stringify(value)))
        return 'OK'
      })
      mockGetUserSettings.mockResolvedValue({ id: 'settings_user-1', user_id: 'user-1', voice_settings: {} })
      mockUpdateUserSettings.mockResolvedValue({ id: 'settings_user-1', user_id: 'user-1' })
      return jsonStore
    }
    const savedIds = (jsonStore: Map<string, any>) =>
      (jsonStore.get(KEY).records as Array<{ id: string }>).map((record) => record.id).sort()
    const savedRecord = (jsonStore: Map<string, any>, id: string) =>
      (jsonStore.get(KEY).records as Array<{ id: string }>).find((record) => record.id === id)

    it('a Redis error throws, and nothing is written', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010)])
      const registry = await import('../services/voiceEngineRegistry')

      mockRedisJsonGet.mockRejectedValueOnce(new Error('connection lost'))
      await expect(
        registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', engineRecord('whisper-cpp', 'Whisper', 8077))
      ).rejects.toThrow(/connection lost/)
      expect(mockRedisJsonSet).not.toHaveBeenCalled()
      expect(savedIds(jsonStore)).toEqual(['kokoro'])

      // A read for display throws too: an empty list would say there are no engines.
      mockRedisJsonGet.mockRejectedValueOnce(new Error('connection lost'))
      await expect(registry.listVoiceEngineSummaries('user-1')).rejects.toThrow(/connection lost/)
    })

    it('one unreadable record among good ones survives saving another engine, untouched', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER, engineRecord('whisper-cpp', 'Whisper', 8077)])
      const registry = await import('../services/voiceEngineRegistry')

      await registry.upsertVoiceEngineRecord('user-1', 'qwen3-tts', engineRecord('qwen3-tts', 'Qwen', 8012))

      expect(savedIds(jsonStore)).toEqual(['dots-tts-mf', 'kokoro', 'qwen3-tts', 'whisper-cpp'])
      expect(savedRecord(jsonStore, 'dots-tts-mf')).toEqual(FROM_NEWER)
    })

    it('every other writer keeps it too: the Engine Manager save and deleting another engine', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER, engineRecord('whisper-cpp', 'Whisper', 8077)])
      const registry = await import('../services/voiceEngineRegistry')

      await registry.applyVoiceEnginePublicUpdates('user-1', [{ id: 'kokoro', enabled: false }])
      expect(savedIds(jsonStore)).toEqual(['dots-tts-mf', 'kokoro', 'whisper-cpp'])
      expect(savedRecord(jsonStore, 'kokoro')).toMatchObject({ enabled: false })

      await registry.deleteVoiceEngineRecord('user-1', 'whisper-cpp')
      expect(savedIds(jsonStore)).toEqual(['dots-tts-mf', 'kokoro'])
      expect(savedRecord(jsonStore, 'dots-tts-mf')).toEqual(FROM_NEWER)
    })

    it('the engine it cannot read is never edited, deleted, or reported as missing', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER])
      const registry = await import('../services/voiceEngineRegistry')

      await expect(registry.upsertVoiceEngineRecord('user-1', 'dots-tts-mf', { enabled: false })).rejects.toThrow(
        /can.t be read/
      )
      await expect(registry.deleteVoiceEngineRecord('user-1', 'dots-tts-mf')).rejects.toThrow(/can.t be read/)
      // Not `null` ("not registered"), which would send a caller off to set it up again.
      await expect(registry.getVoiceEngineRecord('user-1', 'dots-tts-mf')).rejects.toThrow(/can.t be read/)
      expect(mockRedisJsonSet).not.toHaveBeenCalled()
      expect(savedRecord(jsonStore, 'dots-tts-mf')).toEqual(FROM_NEWER)
    })

    it('the Engine Manager lists the good engines, names the one it cannot read, and the log says so once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Its own id: the log remembers a problem it has told for the life of the process.
      seed([engineRecord('kokoro', 'Kokoro', 8010), { ...FROM_NEWER, id: 'dots-tts-once' }])
      const registry = await import('../services/voiceEngineRegistry')

      const view = await registry.listVoiceEngineManagerView('user-1')
      await registry.listVoiceEngineManagerView('user-1')

      expect(view.engines.map((engine) => engine.id)).toEqual(['kokoro'])
      expect(view.unreadableEngines).toEqual([
        {
          scope: 'record',
          id: 'dots-tts-once',
          reason: expect.stringContaining('futureOption'),
          name: 'Dots TTS',
          supportsTts: true,
          supportsStt: false
        }
      ])
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('dots-tts-once'))).toHaveLength(1)
      warn.mockRestore()
    })

    it('a registry in another format is never written over, and reads as no engines plus a notice', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010)], { version: 2 })
      const registry = await import('../services/voiceEngineRegistry')

      await expect(
        registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', engineRecord('whisper-cpp', 'Whisper', 8077))
      ).rejects.toThrow(/does not parse/)
      expect(mockRedisJsonSet).not.toHaveBeenCalled()
      expect(jsonStore.get(KEY)).toEqual({ version: 2, records: [engineRecord('kokoro', 'Kokoro', 8010)] })

      const view = await registry.listVoiceEngineManagerView('user-1')
      expect(view.engines).toEqual([])
      expect(view.unreadableEngines).toEqual([{ scope: 'list', id: null, reason: expect.stringContaining('version') }])
    })

    it('a legacy engine whose id an unreadable record holds alone stays in the settings; the rest move, and nothing is dropped', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER])
      let storedVoiceSettings: Record<string, any> = {
        schemaVersion: 2,
        byoProviders: [
          { id: 'dots-tts-mf', name: 'Dots (legacy)', baseUrl: 'http://localhost:7777', ttsPath: '/tts' },
          { id: 'legacy-two', name: 'Legacy Two', baseUrl: 'http://localhost:7778', ttsPath: '/tts' }
        ]
      }
      mockGetUserSettings.mockImplementation(async () => ({
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }))
      mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
        storedVoiceSettings = updates.voice_settings
        return { id: 'settings_user-1', user_id: 'user-1', voice_settings: storedVoiceSettings }
      })
      const registry = await import('../services/voiceEngineRegistry')

      await registry.listVoiceEngineSummaries('user-1')

      expect(savedIds(jsonStore)).toEqual(['dots-tts-mf', 'kokoro', 'legacy-two'])
      expect(savedRecord(jsonStore, 'dots-tts-mf')).toEqual(FROM_NEWER)
      // Only the one it could not merge. The one that moved is gone from the settings, so
      // deleting it later cannot bring it back from there.
      expect(storedVoiceSettings.byoProviders?.map((provider: { id: string }) => provider.id)).toEqual(['dots-tts-mf'])
    })

    it('a chat send whose chosen voice engine cannot be read still goes through; using the engine is refused plainly', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER])
      const registry = await import('../services/voiceEngineRegistry')
      const { resolveVoiceConfigForMetadata } = await import('../services/voiceService')
      const userSettings = {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: { schemaVersion: 2, tts: { providerId: 'byo:dots-tts-mf', voiceId: 'alice' } }
      } as any

      // Every send runs this, voice on or off (send-routed, and the managed CLI voice block).
      await expect(resolveVoiceConfigForMetadata({ userSettings, agent: null, metadata: {} })).resolves.toMatchObject({
        provider: 'byo:dots-tts-mf',
        voiceId: 'alice'
      })
      // Speaking with it is what fails, with the typed error.
      await expect(registry.getVoiceEngineRecordByProviderId('user-1', 'byo:dots-tts-mf')).rejects.toBeInstanceOf(
        registry.VoiceEngineRecordUnreadableError
      )

      // The whole list unreadable: the same.
      jsonStore.set(KEY, { version: 2, records: [FROM_NEWER] })
      await expect(resolveVoiceConfigForMetadata({ userSettings, agent: null, metadata: {} })).resolves.toMatchObject({
        provider: 'byo:dots-tts-mf'
      })

      // A failed Redis read is not an engine it cannot read: it still throws.
      mockRedisJsonGet.mockRejectedValueOnce(new Error('connection lost'))
      await expect(resolveVoiceConfigForMetadata({ userSettings, agent: null, metadata: {} })).rejects.toThrow(
        /connection lost/
      )
      expect(mockRedisJsonSet).not.toHaveBeenCalled()
    })

    it('the voice guidance says an engine it cannot read cannot be used, and does not throw', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER])
      const registry = await import('../services/voiceEngineRegistry')

      expect(await registry.getVoiceEngineGuidanceForProviderId('user-1', 'byo:dots-tts-mf')).toEqual([
        expect.stringMatching(/byo:dots-tts-mf.*saved settings cannot be read/)
      ])
      expect((await registry.getVoiceEngineGuidanceForProviderId('user-1', 'byo:kokoro'))[0]).toBe(
        'Voice engine: Kokoro (byo:kokoro)'
      )

      jsonStore.set(KEY, { version: 2, records: [engineRecord('kokoro', 'Kokoro', 8010)] })
      expect(await registry.getVoiceEngineGuidanceForProviderId('user-1', 'byo:kokoro')).toEqual([
        expect.stringMatching(/saved settings cannot be read/)
      ])
    })

    it('run time learns whether every saved record was read', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010)])
      const registry = await import('../services/voiceEngineRegistry')

      expect(await registry.listVoiceEngineRecordsForRuntime('user-1')).toMatchObject({ complete: true })

      jsonStore.set(KEY, { version: 1, records: [engineRecord('kokoro', 'Kokoro', 8010), FROM_NEWER] })
      const oneUnreadable = await registry.listVoiceEngineRecordsForRuntime('user-1')
      expect(oneUnreadable.complete).toBe(false)
      expect(oneUnreadable.records.map((record) => record.id)).toEqual(['kokoro'])

      jsonStore.set(KEY, { version: 2, records: [engineRecord('kokoro', 'Kokoro', 8010)] })
      expect(await registry.listVoiceEngineRecordsForRuntime('user-1')).toEqual({ records: [], complete: false })
    })

    it.each([
      ['fields this Batshit does not know', { version: 1, records: [], futureIndex: { a: 1 } }, /does not know: futureIndex/],
      ['records that are not a list', { version: 1, records: { kokoro: {} } }, /not a list/],
      ['no format version', { records: [] }, /format version null/],
      ['a value that is not an object', ['kokoro'], /not a list of engines/]
    ])('a saved list with %s is never written over', async (_label, stored, why) => {
      const jsonStore = seed([])
      jsonStore.set(KEY, stored)
      const registry = await import('../services/voiceEngineRegistry')

      await expect(
        registry.upsertVoiceEngineRecord('user-1', 'whisper-cpp', engineRecord('whisper-cpp', 'Whisper', 8077))
      ).rejects.toThrow(why)
      await expect(registry.applyVoiceEnginePublicUpdates('user-1', [])).rejects.toThrow(why)
      await expect(registry.deleteVoiceEngineRecord('user-1', 'whisper-cpp')).rejects.toThrow(why)
      expect(mockRedisJsonSet).not.toHaveBeenCalled()
      expect(jsonStore.get(KEY)).toEqual(stored)

      const view = await registry.listVoiceEngineManagerView('user-1')
      expect(view.engines).toEqual([])
      expect(view.unreadableEngines).toEqual([{ scope: 'list', id: null, reason: expect.stringMatching(why) }])
    })

    it('a saved list it cannot read as a whole runs no legacy migration', async () => {
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010)], { version: 2 })
      mockGetUserSettings.mockResolvedValue({
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: {
          schemaVersion: 2,
          byoProviders: [{ id: 'legacy-two', name: 'Legacy Two', baseUrl: 'http://localhost:7778', ttsPath: '/tts' }]
        }
      })
      const registry = await import('../services/voiceEngineRegistry')

      await registry.listVoiceEngineManagerView('user-1')

      expect(mockRedisJsonSet).not.toHaveBeenCalled()
      expect(mockUpdateUserSettings).not.toHaveBeenCalled()
      expect(jsonStore.get(KEY)).toEqual({ version: 2, records: [engineRecord('kokoro', 'Kokoro', 8010)] })
    })

    it('a record with no usable id is one record it cannot read, not the whole list, and is kept', async () => {
      const NO_ID = { name: 'Nameless', baseUrl: 'http://127.0.0.1:8130', requestFormat: 'openai-compatible' }
      const HIDDEN_LANE = { ...FROM_NEWER, id: 'qwen3-tts-clone', suite: { id: 'qwen3-tts', role: 'clone', hidden: true } }
      const jsonStore = seed([engineRecord('kokoro', 'Kokoro', 8010), NO_ID, HIDDEN_LANE])
      const registry = await import('../services/voiceEngineRegistry')

      const view = await registry.listVoiceEngineManagerView('user-1')
      expect(view.engines.map((engine) => engine.id)).toEqual(['kokoro'])
      expect(view.unreadableEngines).toEqual([
        expect.objectContaining({ scope: 'record', id: null, name: 'Nameless', reason: expect.stringContaining('id') }),
        expect.objectContaining({ scope: 'record', id: 'qwen3-tts-clone', hidden: true })
      ])

      await registry.upsertVoiceEngineRecord('user-1', 'qwen3-tts', engineRecord('qwen3-tts', 'Qwen', 8012))
      const saved = jsonStore.get(KEY).records as unknown[]
      expect(saved).toHaveLength(4)
      expect(saved).toContainEqual(NO_ID)
      expect(saved).toContainEqual(HIDDEN_LANE)
    })
  })
})
