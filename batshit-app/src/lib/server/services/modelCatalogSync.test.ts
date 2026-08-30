import { describe, expect, it } from 'vitest'
import {
  _buildSourceFallbackWarningForTest,
  _buildCatalogSyncDiffForTest,
  _getManualDirectModelsForTest,
  _findCatalogIdentityIssuesForTest,
  _mapBasetenModelsForTest,
  _mapCohereModelsForTest,
  _mapDeepInfraModelsForTest,
  _mapDirectProviderEntriesForTest,
  _mapFireworksModelsForTest,
  _mapOpenAICompatibleCatalogModelsForTest,
  _mapOpenRouterModelToCatalogEntryForTest,
  _mapTogetherModelsForTest,
  _mergeDirectProviderEntriesForTest,
  _mergeCatalogEntriesForTest,
  _shouldUseFallbackForTest
} from './modelCatalogSync'

describe('modelCatalogSync merge', () => {
  it('requires an exact identity variant for every advertised catalog connection', () => {
    const issues = _findCatalogIdentityIssuesForTest([
      {
        id: 'zai/glm-5.3-flash',
        canonicalId: 'zai/glm-5.3-flash',
        provider: 'zai',
        upstreamProvider: 'vercel',
        name: 'glm-5.3-flash',
        displayName: 'GLM 5.3 Flash',
        tags: [],
        purpose: 'chat',
        features: {
          streaming: true,
          tools: true,
          vision: false,
          maxTokens: 128000
        },
        category: 'balanced',
        source: 'vercel',
        transport: 'vercel-gateway',
        connectionId: 'vercel-gateway',
        availableConnections: ['vercel-gateway', 'direct:deepinfra'],
        idVariants: {
          'vercel-gateway': {
            developerId: 'zai',
            modelId: 'glm-5.3-flash',
            effectiveId: 'zai/glm-5.3-flash',
            source: 'vercel'
          }
        }
      }
    ])

    expect(issues).toEqual([
      {
        catalogId: 'zai/glm-5.3-flash',
        connectionId: 'direct:deepinfra',
        reason: 'missing-variant'
      }
    ])
  })

  it('merges gateway + openrouter entries by AA slug and attaches idVariants', () => {
    const merged = _mergeCatalogEntriesForTest([
      {
        id: 'anthropic/claude-sonnet-4-5',
        canonicalId: 'anthropic/claude-sonnet-4-5',
        provider: 'anthropic',
        upstreamProvider: 'vercel',
        name: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        tags: ['tool-use'],
        contextWindow: 200000,
        maxOutputTokens: 8192,
        purpose: 'chat',
        aaSlug: 'claude-sonnet-4-5',
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 200000
        },
        category: 'balanced',
        source: 'vercel',
        transport: 'vercel-gateway',
        connectionId: 'vercel-gateway'
      },
      {
        id: 'anthropic/claude-sonnet-4.5',
        canonicalId: 'anthropic/claude-sonnet-4.5',
        provider: 'anthropic',
        upstreamProvider: 'openrouter',
        name: 'claude-sonnet-4.5',
        displayName: 'Claude Sonnet 4.5 (OR)',
        tags: ['tool-use'],
        contextWindow: 200000,
        maxOutputTokens: 8192,
        purpose: 'chat',
        aaSlug: 'claude-sonnet-4-5',
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 200000
        },
        category: 'balanced',
        source: 'openrouter',
        transport: 'openrouter',
        connectionId: 'openrouter'
      }
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.connectionId).toBe('vercel-gateway')
    expect(merged[0]?.provider).toBe('anthropic')
    expect(merged[0]?.name).toBe('claude-sonnet-4-5')
    expect(merged[0]?.idVariants?.['vercel-gateway']?.effectiveId).toBe('anthropic/claude-sonnet-4-5')
    expect(merged[0]?.idVariants?.openrouter?.effectiveId).toBe('anthropic/claude-sonnet-4.5')
    expect(merged[0]?.availableConnections).toEqual(expect.arrayContaining(['vercel-gateway', 'openrouter']))
  })

  it('attaches direct provider variants when present', () => {
    const merged = _mergeCatalogEntriesForTest([
      {
        id: 'openai/gpt-5.2',
        canonicalId: 'openai/gpt-5.2',
        provider: 'openai',
        upstreamProvider: 'vercel',
        name: 'gpt-5.2',
        displayName: 'GPT-5.2',
        tags: ['reasoning'],
        contextWindow: 200000,
        maxOutputTokens: 8192,
        purpose: 'chat',
        aaSlug: 'gpt-5.2',
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 200000,
          reasoning: true
        },
        category: 'reasoning',
        source: 'vercel',
        transport: 'vercel-gateway',
        connectionId: 'vercel-gateway'
      },
      {
        id: 'gpt-5.2',
        canonicalId: 'openai/gpt-5.2',
        provider: 'openai',
        upstreamProvider: 'openai',
        name: 'gpt-5.2',
        displayName: 'gpt-5.2',
        tags: [],
        purpose: 'chat',
        aaSlug: 'gpt-5.2',
        features: {
          streaming: true,
          tools: false,
          vision: false,
          maxTokens: 0
        },
        category: 'balanced',
        source: 'direct',
        transport: 'direct',
        connectionId: 'direct:openai'
      }
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.idVariants?.['direct:openai']?.effectiveId).toBe('gpt-5.2')
    expect(merged[0]?.availableConnections).toEqual(expect.arrayContaining(['vercel-gateway', 'direct:openai']))
  })

  it('keeps full diff lists without truncation', () => {
    const nextModels = Array.from({ length: 75 }).map((_, index) => ({
      id: `openai/model-${index}`,
      canonicalId: `openai/model-${index}`,
      provider: 'openai',
      upstreamProvider: 'vercel',
      name: `model-${index}`,
      displayName: `Model ${index}`,
      tags: [],
      contextWindow: 128000,
      maxOutputTokens: 4096,
      purpose: 'chat' as const,
      features: {
        streaming: true,
        tools: true,
        vision: false,
        maxTokens: 128000
      },
      category: 'balanced' as const,
      source: 'vercel' as const,
      transport: 'vercel-gateway' as const,
      connectionId: 'vercel-gateway' as const
    }))

    const diff = _buildCatalogSyncDiffForTest({
      previous: { models: [] },
      next: {
        version: 1,
        fetchedAt: '2026-02-15T00:00:00.000Z',
        counts: { vercel: 75 },
        models: nextModels
      }
    })

    expect(diff.addedModelsTotal).toBe(75)
    expect(diff.addedModels).toHaveLength(75)
    expect(diff.truncated).toBe(false)
  })

  it('does not treat OpenRouter context length as max output tokens', () => {
    const entry = _mapOpenRouterModelToCatalogEntryForTest({
      id: 'moonshotai/kimi-k2.6',
      name: 'MoonshotAI: Kimi K2.6',
      context_length: 262000,
      supported_parameters: ['tools'],
      pricing: {
        prompt: '0.0000002',
        completion: '0.000002'
      }
    })

    expect(entry.contextWindow).toBe(262000)
    expect(entry.maxOutputTokens).toBeUndefined()
    expect(entry.features.maxTokens).toBe(262000)
  })

  it('uses OpenRouter top provider max completion tokens when they are safe', () => {
    const entry = _mapOpenRouterModelToCatalogEntryForTest({
      id: 'z-ai/glm-5.2',
      name: 'Z.ai: GLM 5.2',
      context_length: 1_048_576,
      top_provider: {
        context_length: 1_048_576,
        max_completion_tokens: 32_768
      },
      supported_parameters: ['tools'],
      pricing: {
        prompt: '0.000001',
        completion: '0.000004'
      }
    })

    expect(entry.contextWindow).toBe(1_048_576)
    expect(entry.maxOutputTokens).toBe(32_768)
  })

  it('drops OpenRouter top provider max completion tokens when they equal provider context', () => {
    const entry = _mapOpenRouterModelToCatalogEntryForTest({
      id: 'moonshotai/kimi-k2.7-code',
      name: 'MoonshotAI: Kimi K2.7 Code',
      context_length: 262_144,
      top_provider: {
        context_length: 262_144,
        max_completion_tokens: 262_144
      },
      supported_parameters: ['tools'],
      pricing: {
        prompt: '0.0000002',
        completion: '0.000002'
      }
    })

    expect(entry.contextWindow).toBe(262_144)
    expect(entry.maxOutputTokens).toBeUndefined()
  })

  it('preserves prior source entries when a provider suddenly returns zero models', () => {
    expect(_shouldUseFallbackForTest({ previousCount: 405, fetchedCount: 0 })).toBe(true)
    expect(
      _buildSourceFallbackWarningForTest({
        useFallback: true,
        previousCount: 405,
        fetchedCount: 0
      })
    ).toBe('Source returned 0 models; preserving previous list (prev=405, fetched=0)')
  })

  it('treats sharp provider drops as degraded preservation events', () => {
    expect(_shouldUseFallbackForTest({ previousCount: 405, fetchedCount: 180 })).toBe(true)
    expect(
      _buildSourceFallbackWarningForTest({
        useFallback: true,
        previousCount: 405,
        fetchedCount: 180
      })
    ).toBe('Suspicious drop detected (prev=405, fetched=180); preserving previous list')
  })

  it('keeps GLM-5.2 in the Z.ai coding-plan fallback list', () => {
    const models = _getManualDirectModelsForTest('zai_coding')
    const glm52 = models.find((model) => model.id === 'glm-5.2')

    expect(glm52).toMatchObject({
      displayName: 'GLM-5.2',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072
    })
  })

  it('merges curated Z.ai coding-plan entries into lagging live discovery results', () => {
    const curated = _getManualDirectModelsForTest('zai_coding')
    const merged = _mergeDirectProviderEntriesForTest([{ id: 'glm-4.7' }, { id: 'glm-5.1' }], curated)

    expect(merged.some((model) => model.id === 'glm-5.2')).toBe(true)
    expect(merged.find((model) => model.id === 'glm-4.7')?.displayName).toBe('GLM-4.7')
  })

  it('imports active DeepInfra chat models with exact namespaced IDs and normalized metadata', () => {
    const directEntries = _mapDeepInfraModelsForTest([
      {
        model_name: 'zai-org/GLM-5.3-Flash',
        reported_type: 'text-generation',
        description: 'A long-context multimodal coding model.',
        tags: ['openai', 'tools', 'multimodal', 'reasoning'],
        pricing: {
          cents_per_input_token: 0.000015,
          cents_per_output_token: 0.00005,
          rate_per_input_token_cached: 0.2
        },
        max_tokens: 1_048_576,
        replaced_by: null,
        deprecated: null,
        private: 0
      },
      {
        model_name: 'old-owner/Old-Model',
        reported_type: 'text-generation',
        deprecated: 1,
        private: 0
      },
      {
        model_name: 'sentence-transformers/embed-model',
        reported_type: 'embeddings',
        deprecated: null,
        private: 0
      }
    ])

    expect(directEntries).toHaveLength(1)
    expect(directEntries[0]).toMatchObject({
      id: 'zai-org/GLM-5.3-Flash',
      displayName: 'GLM-5.3-Flash',
      contextWindow: 1_048_576,
      modelType: 'chat',
      pricing: {
        input: 0.15,
        output: 0.5,
        cachedInput: 0.03
      }
    })

    const [catalogEntry] = _mapDirectProviderEntriesForTest('deepinfra', directEntries)
    expect(catalogEntry).toMatchObject({
      id: 'zai-org/GLM-5.3-Flash',
      provider: 'zai-org',
      upstreamProvider: 'deepinfra',
      connectionId: 'direct:deepinfra',
      purpose: 'chat',
      pricing: {
        input: 0.15,
        output: 0.5,
        cachedInput: 0.03
      },
      features: {
        tools: true,
        vision: true,
        reasoning: true,
        cacheControl: true,
        longContext: true
      }
    })
  })

  it('keeps Together developer-prefixed runtime IDs while filtering non-chat models', () => {
    const directEntries = _mapTogetherModelsForTest([
      {
        id: 'zai-org/GLM-5.3',
        type: 'chat',
        running: false,
        display_name: 'GLM 5.3',
        context_length: 131_072,
        pricing: { input: 0.5, output: 1.5 }
      },
      { id: 'black-forest-labs/FLUX.1-schnell', type: 'image', running: true }
    ])

    expect(directEntries).toHaveLength(1)
    expect(directEntries[0]).toMatchObject({
      id: 'zai-org/GLM-5.3',
      effectiveId: 'zai-org/GLM-5.3',
      contextWindow: 131_072,
      pricing: { input: 0.5, output: 1.5 },
      modelType: 'chat'
    })

    const [catalogEntry] = _mapDirectProviderEntriesForTest('togetherai', directEntries)
    expect(catalogEntry).toMatchObject({
      id: 'zai-org/GLM-5.3',
      provider: 'zai-org',
      name: 'GLM-5.3',
      connectionId: 'direct:togetherai'
    })
  })

  it('preserves Fireworks runtime IDs and records the developer identity from Hugging Face', () => {
    const directEntries = _mapFireworksModelsForTest([
      {
        name: 'accounts/fireworks/models/kimi-k3',
        displayName: 'Kimi K3',
        public: true,
        state: 'READY',
        contextLength: 262_144,
        supportsTools: true,
        huggingFaceUrl: 'https://huggingface.co/moonshotai/Kimi-K3'
      },
      {
        name: 'accounts/fireworks/models/kimi-k3-max',
        displayName: 'Kimi K3 Max',
        public: true,
        state: 'READY',
        huggingFaceUrl: 'https://huggingface.co/moonshotai/Kimi-K3'
      }
    ])

    expect(directEntries[0]).toMatchObject({
      id: 'accounts/fireworks/models/kimi-k3',
      developerId: 'moonshotai',
      modelId: 'Kimi-K3',
      effectiveId: 'accounts/fireworks/models/kimi-k3',
      tags: expect.arrayContaining(['chat', 'tools']),
      modelType: 'chat'
    })
    expect(directEntries[1]).toMatchObject({
      id: 'accounts/fireworks/models/kimi-k3-max',
      developerId: 'fireworks',
      modelId: 'kimi-k3-max',
      effectiveId: 'accounts/fireworks/models/kimi-k3-max'
    })
  })

  it('maps Baseten metadata without changing its exact model identifier', () => {
    const directEntries = _mapBasetenModelsForTest([
      {
        id: 'openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        context_length: 131_072,
        max_completion_tokens: 65_536,
        supported_features: ['tools'],
        input_modalities: ['text'],
        output_modalities: ['text'],
        pricing: { input: 0.0000001, output: 0.0000002 }
      }
    ])

    expect(directEntries[0]).toMatchObject({
      id: 'openai/gpt-oss-120b',
      effectiveId: 'openai/gpt-oss-120b',
      contextWindow: 131_072,
      maxOutputTokens: 65_536,
      tags: expect.arrayContaining(['chat', 'tools'])
    })
  })

  it('classifies MiMo audio endpoints separately from chat models', () => {
    const directEntries = _mapOpenAICompatibleCatalogModelsForTest('mimo', [
      { id: 'mimo-v2.5-pro', owned_by: 'xiaomi' },
      { id: 'mimo-v2.5-asr', owned_by: 'xiaomi' },
      { id: 'mimo-v2.5-tts-voiceclone', owned_by: 'xiaomi' }
    ])

    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mimo-v2.5-pro', modelType: 'chat' }),
        expect.objectContaining({
          id: 'mimo-v2.5-asr',
          modelType: 'audio',
          tags: expect.arrayContaining(['stt'])
        }),
        expect.objectContaining({
          id: 'mimo-v2.5-tts-voiceclone',
          modelType: 'audio',
          tags: expect.arrayContaining(['tts'])
        })
      ])
    )
  })

  it('classifies Cohere chat, embedding, rerank, and transcription models from advertised endpoints', () => {
    const directEntries = _mapCohereModelsForTest([
      {
        name: 'command-a-plus',
        endpoints: ['chat'],
        features: ['tools'],
        context_length: 256_000
      },
      { name: 'embed-v4.0', endpoints: ['embed'], features: null },
      { name: 'rerank-v3.5', endpoints: ['rerank'], features: null },
      { name: 'transcribe-v2', endpoints: ['transcribe'], features: null }
    ])

    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'command-a-plus',
          modelType: 'chat',
          contextWindow: 256_000
        }),
        expect.objectContaining({ id: 'embed-v4.0', modelType: 'embedding' }),
        expect.objectContaining({ id: 'rerank-v3.5', modelType: 'rerank' }),
        expect.objectContaining({ id: 'transcribe-v2', modelType: 'audio' })
      ])
    )
  })
})
