import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedModel } from '$lib/types/savedModels'

const userModels = new Set<string>()
const modelStore = new Map<string, SavedModel>()

const redisMock = {
  sMembers: vi.fn(async () => Array.from(userModels)),
  get: vi.fn(async (key: string) => modelStore.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    modelStore.delete(key)
  }),
  sRem: vi.fn(async (_key: string, member: string) => {
    userModels.delete(member)
  })
}

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$lib/server/services/providers', () => ({
  ProviderManager: class {
    listAvailableModels() {
      return []
    }
  }
}))

vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: vi.fn(async () => ({ models: [], fetchedAt: new Date().toISOString() })),
  findVercelCatalogEntry: vi.fn(async () => null),
  findVercelCatalogEntryById: vi.fn(async () => null)
}))

let routeModule: typeof import('./+server')

beforeEach(async () => {
  userModels.clear()
  modelStore.clear()
  vi.clearAllMocks()

  userModels.add('vercel-kept')
  userModels.add('vercel-deprecated')
  userModels.add('manual-model')

  modelStore.set('model:vercel-kept', {
    id: 'vercel-kept',
    modelName: 'Claude Latest',
    modelId: 'claude-sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    pricing: { input: 3, output: 15 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isVercelImport: true,
    vercelSourceId: 'anthropic/claude-sonnet'
  } as SavedModel)

  modelStore.set('model:vercel-deprecated', {
    id: 'vercel-deprecated',
    modelName: 'Old Model',
    modelId: 'old-model',
    provider: 'anthropic',
    contextWindow: 10000,
    pricing: { input: 1, output: 1 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isVercelImport: true,
    vercelSourceId: 'anthropic/old-model'
  } as SavedModel)

  modelStore.set('model:manual-model', {
    id: 'manual-model',
    modelName: 'Custom',
    modelId: 'custom',
    provider: 'custom',
    contextWindow: 0,
    pricing: { input: 0, output: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isVercelImport: false
  } as SavedModel)

  // Lazy import after mocks
  routeModule = await import('./+server')
})

describe('loadUserModelsWithPurge', () => {
  it('removes deprecated Vercel models while keeping manual entries', async () => {
    const vercelIds = new Set(['anthropic/claude-sonnet'])

  const result = await routeModule._loadUserModelsWithPurge('user_123', vercelIds)

    expect(result.models).toHaveLength(2)
    expect(result.models.map((m) => m.id)).toContain('vercel-kept')
    expect(result.models.map((m) => m.id)).toContain('manual-model')
    expect(result.purged).toHaveLength(1)
    expect(result.purged[0].id).toBe('vercel-deprecated')
    expect(redisMock.del).toHaveBeenCalledWith('model:vercel-deprecated')
    expect(redisMock.sRem).toHaveBeenCalledWith('user:user_123:models', 'vercel-deprecated')
  })
})

describe('normaliseSavedModel voice session metadata', () => {
  it('infers LiveKit speech-to-speech metadata for OpenAI realtime presets', async () => {
    const normalized = await routeModule._normaliseSavedModel(
      {
        id: 'openai-realtime',
        modelName: 'OpenAI Realtime',
        modelId: 'gpt-realtime-2',
        provider: 'openai',
        contextWindow: 0,
        pricing: { input: 0, output: 0 },
        settings: {
          voiceSession: {
            runtime: 'livekit',
            mode: 'speech-to-speech',
            providerId: 'openai'
          }
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } as SavedModel,
      { listAvailableModels: () => [] } as any
    )

    expect(normalized.voiceSession).toMatchObject({
      runtime: 'livekit',
      mode: 'speech-to-speech',
      providerId: 'openai',
      defaultModelId: 'gpt-realtime-2',
      supportStatus: 'supported'
    })
    expect(normalized.settings?.voiceSession).toBeUndefined()
  })
})
