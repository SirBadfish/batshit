import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedModel } from '$lib/types/savedModels'

const userModels = new Set<string>()
const modelStore = new Map<string, SavedModel>()
const catalogEntries = new Map<string, any>()

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
  findVercelCatalogEntryById: vi.fn(async (id?: string | null) =>
    id ? catalogEntries.get(id) ?? null : null
  )
}))

let routeModule: typeof import('./+server')

beforeEach(async () => {
  userModels.clear()
  modelStore.clear()
  catalogEntries.clear()
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

describe('normaliseSavedModel provider-authoritative identity', () => {
  const manager = { listAvailableModels: () => [] } as any

  it('uses DeepInfra exact developer, model, and request IDs from the selected catalog variant', async () => {
    catalogEntries.set('zai/glm-5.3-flash', {
      id: 'zai/glm-5.3-flash',
      provider: 'zai',
      name: 'glm-5.3-flash',
      displayName: 'GLM 5.3 Flash',
      source: 'vercel',
      idVariants: {
        'direct:deepinfra': {
          developerId: 'zai-org',
          modelId: 'GLM-5.3-Flash',
          effectiveId: 'zai-org/GLM-5.3-Flash',
          source: 'direct'
        }
      }
    })

    const normalized = await routeModule._normaliseSavedModel(
      {
        id: '',
        modelName: 'GLM 5.3 Flash - DeepInfra',
        modelId: 'glm-5.3-flash',
        provider: 'zai',
        catalogModelId: 'zai/glm-5.3-flash',
        contextWindow: 128000,
        pricing: { input: 0, output: 0 },
        connection: { id: 'direct:deepinfra', type: 'direct', service: 'deepinfra' },
        createdAt: '',
        updatedAt: ''
      },
      manager
    )

    expect(normalized).toMatchObject({
      provider: 'zai-org',
      modelId: 'GLM-5.3-Flash',
      effectiveModelId: 'zai-org/GLM-5.3-Flash',
      catalogModelId: 'zai/glm-5.3-flash',
      isVercelImport: false,
      vercelSourceId: undefined
    })
  })

  it('preserves case-sensitive developer IDs from direct-provider catalog variants', async () => {
    catalogEntries.set('alibaba/qwen3-235b', {
      id: 'alibaba/qwen3-235b',
      provider: 'alibaba',
      name: 'qwen3-235b',
      displayName: 'Qwen3 235B',
      source: 'vercel',
      idVariants: {
        'direct:deepinfra': {
          developerId: 'Qwen',
          modelId: 'Qwen3-235B-A22B',
          effectiveId: 'Qwen/Qwen3-235B-A22B',
          source: 'direct'
        }
      }
    })

    const normalized = await routeModule._normaliseSavedModel(
      {
        id: '',
        modelName: 'Qwen3 - DeepInfra',
        modelId: 'qwen3-235b',
        provider: 'alibaba',
        catalogModelId: 'alibaba/qwen3-235b',
        contextWindow: 128000,
        pricing: { input: 0, output: 0 },
        connection: { id: 'direct:deepinfra', type: 'direct', service: 'deepinfra' },
        createdAt: '',
        updatedAt: ''
      },
      manager
    )

    expect(normalized.provider).toBe('Qwen')
    expect(normalized.effectiveModelId).toBe('Qwen/Qwen3-235B-A22B')
  })

  it('uses OpenRouter exact developer namespaces instead of translating a gateway namespace', async () => {
    catalogEntries.set('zai/glm-5.3-flash', {
      id: 'zai/glm-5.3-flash',
      provider: 'zai',
      name: 'glm-5.3-flash',
      displayName: 'GLM 5.3 Flash',
      source: 'vercel',
      idVariants: {
        openrouter: {
          developerId: 'z-ai',
          modelId: 'glm-5.3-flash',
          effectiveId: 'z-ai/glm-5.3-flash',
          source: 'openrouter'
        }
      }
    })

    const normalized = await routeModule._normaliseSavedModel(
      {
        id: '',
        modelName: 'GLM 5.3 Flash - OpenRouter',
        modelId: 'glm-5.3-flash',
        provider: 'zai',
        catalogModelId: 'zai/glm-5.3-flash',
        contextWindow: 128000,
        pricing: { input: 0, output: 0 },
        connection: { id: 'openrouter', type: 'openrouter', service: 'openrouter' },
        createdAt: '',
        updatedAt: ''
      },
      manager
    )

    expect(normalized).toMatchObject({
      provider: 'z-ai',
      modelId: 'glm-5.3-flash',
      effectiveModelId: 'z-ai/glm-5.3-flash'
    })
  })

  it('fails loudly when a catalog-backed connection has no exact variant', async () => {
    catalogEntries.set('zai/glm-5.3-flash', {
      id: 'zai/glm-5.3-flash',
      provider: 'zai',
      name: 'glm-5.3-flash',
      displayName: 'GLM 5.3 Flash',
      source: 'vercel',
      idVariants: {
        'vercel-gateway': {
          developerId: 'zai',
          modelId: 'glm-5.3-flash',
          effectiveId: 'zai/glm-5.3-flash',
          source: 'vercel'
        }
      }
    })

    await expect(
      routeModule._normaliseSavedModel(
        {
          id: '',
          modelName: 'Broken DeepInfra preset',
          modelId: 'glm-5.3-flash',
          provider: 'zai',
          catalogModelId: 'zai/glm-5.3-flash',
          contextWindow: 128000,
          pricing: { input: 0, output: 0 },
          connection: { id: 'direct:deepinfra', type: 'direct', service: 'deepinfra' },
          createdAt: '',
          updatedAt: ''
        },
        manager
      )
    ).rejects.toThrow('does not have an exact provider identifier for direct:deepinfra')
  })
})

describe('saved model purpose', () => {
  const manager = { listAvailableModels: () => [] } as any

  it('uses the catalog purpose instead of reclassifying an OCR-capable chat model', async () => {
    catalogEntries.set('anthropic/claude-sonnet-5', {
      id: 'anthropic/claude-sonnet-5',
      provider: 'anthropic',
      name: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      modelType: 'language',
      purpose: 'chat',
      tags: ['vision', 'ocr', 'chat'],
      idVariants: {
        'direct:anthropic': {
          developerId: 'anthropic',
          modelId: 'claude-sonnet-5',
          effectiveId: 'claude-sonnet-5',
          source: 'direct'
        }
      }
    })

    const normalized = await routeModule._normaliseSavedModel(
      {
        id: 'claude-sonnet-5',
        modelName: 'Claude Sonnet 5',
        modelId: 'claude-sonnet-5',
        provider: 'anthropic',
        catalogModelId: 'anthropic/claude-sonnet-5',
        purpose: 'utility',
        contextWindow: 1_000_000,
        pricing: { input: 2, output: 10 },
        connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' },
        createdAt: '',
        updatedAt: ''
      },
      manager
    )

    expect(normalized.purpose).toBe('chat')
    expect(normalized.purposeOverride).toBeUndefined()
  })

  it('preserves a user category override during save and load repair', async () => {
    const normalized = await routeModule._normaliseSavedModel(
      {
        id: 'manual-embedding-endpoint',
        modelName: 'Custom Embedding Endpoint',
        modelId: 'custom-model',
        provider: 'custom_provider',
        purpose: 'chat',
        purposeOverride: 'utility',
        contextWindow: 0,
        pricing: { input: 0, output: 0 },
        connection: { id: 'direct:custom_provider', type: 'direct', service: 'custom_provider' },
        createdAt: '',
        updatedAt: ''
      },
      manager
    )

    expect(normalized.purpose).toBe('utility')
    expect(normalized.purposeOverride).toBe('utility')

    const changed = routeModule._repairSavedModelPurpose(normalized, {
      id: 'custom_provider/custom-model',
      provider: 'custom_provider',
      name: 'custom-model',
      displayName: 'Custom Model',
      purpose: 'chat'
    } as any)
    expect(changed).toBe(false)
    expect(normalized.purpose).toBe('utility')
  })
})
