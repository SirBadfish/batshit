import { describe, expect, it } from 'vitest'
import {
  _applyDirectSourceCatalogPolicyForTest,
  _assembleCatalogModelsForTest,
  _buildFallbackEntriesFromExistingForTest,
  _buildSourceFallbackWarningForTest,
  _buildCatalogSyncDiffForTest,
  _filterZaiCodingPlanModelIdsForTest,
  _getManualDirectModelsForTest,
  _mapAnthropicModelsForTest,
  _findCatalogIdentityIssuesForTest,
  _mapBasetenModelsForTest,
  _mapCohereModelsForTest,
  _mapDeepInfraModelsForTest,
  _mapDirectProviderEntriesForTest,
  _mapFireworksModelsForTest,
  _mapGatewayModelToCatalogEntryForTest,
  _mapOpenAICompatibleCatalogModelsForTest,
  _mapOpenRouterModelToCatalogEntryForTest,
  _mapTogetherModelsForTest,
  _mergeDirectProviderEntriesForTest,
  _mergeCatalogEntriesForTest,
  buildCatalogFromSnapshot
} from './modelCatalogSync'
import { resolveCatalogConnectionLimits } from '$lib/utils/catalogConnectionLimits'

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

  it('merges reviewed Z.ai developer aliases while preserving exact connection variants', () => {
    const merged = _mergeCatalogEntriesForTest([
      {
        id: 'z-ai/glm-5.3',
        canonicalId: 'z-ai/glm-5.3',
        provider: 'z-ai',
        name: 'glm-5.3',
        displayName: 'GLM-5.3',
        tags: ['reasoning'],
        purpose: 'chat',
        features: { streaming: true, tools: true, vision: false, maxTokens: 1_000_000 },
        source: 'openrouter',
        transport: 'openrouter',
        connectionId: 'openrouter'
      },
      {
        id: 'zai-org/GLM-5.3',
        canonicalId: 'zai-org/glm-5.3',
        provider: 'zai-org',
        upstreamProvider: 'deepinfra',
        name: 'glm-5.3',
        displayName: 'GLM-5.3',
        tags: ['reasoning'],
        purpose: 'chat',
        features: { streaming: true, tools: true, vision: false, maxTokens: 1_000_000 },
        source: 'direct',
        transport: 'direct',
        connectionId: 'direct:deepinfra'
      }
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      canonicalId: 'zai/glm-5.3',
      provider: 'zai'
    })
    expect(merged[0]?.idVariants?.openrouter).toMatchObject({
      developerId: 'z-ai',
      effectiveId: 'z-ai/glm-5.3'
    })
    expect(merged[0]?.idVariants?.['direct:deepinfra']).toMatchObject({
      developerId: 'zai-org',
      effectiveId: 'zai-org/GLM-5.3'
    })
  })

  it('does not merge different developers solely because Artificial Analysis uses the same slug', () => {
    const base = {
      name: 'shared-model',
      displayName: 'Shared Model',
      tags: [],
      purpose: 'chat' as const,
      aaSlug: 'shared-model',
      features: { streaming: true, tools: false, vision: false, maxTokens: 8_192 },
      source: 'direct' as const,
      transport: 'direct' as const
    }
    const merged = _mergeCatalogEntriesForTest([
      {
        ...base,
        id: 'alpha/shared-model',
        canonicalId: 'alpha/shared-model',
        provider: 'alpha',
        connectionId: 'direct:alpha'
      },
      {
        ...base,
        id: 'beta/shared-model',
        canonicalId: 'beta/shared-model',
        provider: 'beta',
        connectionId: 'direct:beta'
      }
    ])

    expect(merged).toHaveLength(2)
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
    expect(
      _buildSourceFallbackWarningForTest({
        useFallback: true,
        previousCount: 405,
        fetchedCount: 0
      })
    ).toBe('Source returned 0 models; preserving previous list (prev=405, fetched=0)')
  })

  it('treats sharp provider drops as degraded preservation events', () => {
    expect(
      _buildSourceFallbackWarningForTest({
        useFallback: true,
        previousCount: 405,
        fetchedCount: 180
      })
    ).toBe('Suspicious drop detected (prev=405, fetched=180); preserving previous list')
  })

  it('keeps only current models in the Z.ai Coding Plan fallback list', () => {
    const models = _getManualDirectModelsForTest('zai_coding')
    const glm53 = models.find((model) => model.id === 'glm-5.3')

    expect(models.map((model) => model.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
    expect(glm53).toMatchObject({
      developerId: 'zai',
      displayName: 'GLM-5.3',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072
    })
  })

  it('publishes current Kimi Code membership models on the separate subscription connection', () => {
    const curated = _getManualDirectModelsForTest('kimi_code')
    const directEntries = _mapDirectProviderEntriesForTest('kimi_code', curated)

    expect(curated.map((model) => model.id)).toEqual([
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed'
    ])
    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'k3',
          provider: 'moonshotai',
          contextWindow: 1_048_576,
          connectionId: 'direct:kimi_code'
        }),
        expect.objectContaining({
          id: 'kimi-for-coding-highspeed',
          provider: 'moonshotai',
          connectionId: 'direct:kimi_code'
        })
      ])
    )
  })

  it('publishes current MiniMax Token Plan text models separately from pay-as-you-go', () => {
    const curated = _getManualDirectModelsForTest('minimax_token_plan')
    const directEntries = _mapDirectProviderEntriesForTest('minimax_token_plan', curated)

    expect(curated.map((model) => model.id)).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed'
    ])
    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'MiniMax-M3',
          provider: 'minimax',
          connectionId: 'direct:minimax_token_plan'
        })
      ])
    )
  })

  it('publishes the full MiMo Token Plan chat and audio model set with correct purposes', () => {
    const curated = _getManualDirectModelsForTest('mimo_token_plan')
    const directEntries = _mapDirectProviderEntriesForTest('mimo_token_plan', curated)

    expect(curated.map((model) => model.id)).toEqual([
      'mimo-v2.5-pro',
      'mimo-v2.5',
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.5-tts-voiceclone'
    ])
    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'mimo-v2.5-pro',
          purpose: 'chat',
          connectionId: 'direct:mimo_token_plan'
        }),
        expect.objectContaining({
          id: 'mimo-v2.5-asr',
          purpose: 'audio',
          connectionId: 'direct:mimo_token_plan'
        }),
        expect.objectContaining({
          id: 'mimo-v2.5-tts-voiceclone',
          purpose: 'audio',
          connectionId: 'direct:mimo_token_plan'
        })
      ])
    )
  })

  it('merges curated Z.ai coding-plan entries into lagging live discovery results', () => {
    const curated = _getManualDirectModelsForTest('zai_coding')
    const merged = _mergeDirectProviderEntriesForTest([{ id: 'glm-5.3' }], curated)

    expect(merged.some((model) => model.id === 'glm-5.3-flash')).toBe(true)
    expect(merged.find((model) => model.id === 'glm-5.3')?.displayName).toBe('GLM-5.3')
  })

  it('filters known Coding Plan compatibility aliases but preserves unknown future models', () => {
    expect(
      _filterZaiCodingPlanModelIdsForTest([
        'glm-4.7',
        'glm-5.2',
        'glm-5.3',
        'glm-5.3-flash',
        'glm-6-preview'
      ])
    ).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-6-preview'])
  })

  it('removes legacy Coding Plan rows before outage-fallback counts preserve them', () => {
    const entries = _mapDirectProviderEntriesForTest('zai_coding', [
      { id: 'glm-4.7' },
      { id: 'glm-5.2' },
      { id: 'glm-5.3' },
      { id: 'glm-5.3-flash' },
      { id: 'glm-6-preview' }
    ])

    expect(
      _applyDirectSourceCatalogPolicyForTest('zai_coding', entries).map((entry) => entry.name)
    ).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-6-preview'])
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

  it('preserves exact Qwen Cloud model IDs and classifies advertised audio endpoints', () => {
    const directEntries = _mapOpenAICompatibleCatalogModelsForTest('qwencloud', [
      { id: 'qwen-plus', owned_by: 'qwen' },
      { id: 'qwen-image-3.0', owned_by: 'qwen' },
      { id: 'qwen-audio-3.0-asr-flash', owned_by: 'qwen' }
    ])

    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'qwen-plus', effectiveId: 'qwen-plus' }),
        expect.objectContaining({ id: 'qwen-image-3.0', effectiveId: 'qwen-image-3.0' }),
        expect.objectContaining({
          id: 'qwen-audio-3.0-asr-flash',
          modelType: 'audio',
          tags: expect.arrayContaining(['stt'])
        })
      ])
    )
  })

  it('publishes the current Qwen Token Plan text-model set with provider-authoritative developers', () => {
    const curated = _getManualDirectModelsForTest('qwen_token_plan')
    const directEntries = _mapDirectProviderEntriesForTest('qwen_token_plan', curated)

    expect(curated.map((model) => model.id)).toEqual([
      'qwen3.8-max',
      'qwen3.8-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-flash',
      'deepseek-v4-pro',
      'deepseek-v4-pro-0813',
      'deepseek-v4-flash-0731',
      'deepseek-v4.1-flash',
      'glm-5.3',
      'glm-5.2'
    ])
    expect(directEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'qwen3.8-max',
          provider: 'qwen',
          connectionId: 'direct:qwen_token_plan'
        }),
        expect.objectContaining({
          id: 'deepseek-v4-pro',
          provider: 'deepseek',
          connectionId: 'direct:qwen_token_plan'
        }),
        expect.objectContaining({
          id: 'glm-5.3',
          provider: 'zai',
          connectionId: 'direct:qwen_token_plan'
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

/**
 * BL-68: the hosted registry kept Anthropic's dated 4.5 direct rows apart from
 * the priced gateway rows, listed legacy completions-only OpenAI models as chat,
 * published `maxTokens: 0` for an unknown window, and silently dropped a second
 * entry of one connection in a merge (bug-batch find b).
 */
describe('BL-68 reviewed identity, connection limits, and merge guard', () => {
  function gatewayEntry(provider: string, name: string, extra: Record<string, unknown> = {}): any {
    return {
      id: `${provider}/${name}`,
      canonicalId: `${provider}/${name}`,
      provider,
      upstreamProvider: 'vercel',
      name,
      displayName: name,
      tags: [],
      purpose: 'chat',
      features: { streaming: true, tools: true, vision: true },
      category: 'balanced',
      source: 'vercel',
      transport: 'vercel-gateway',
      connectionId: 'vercel-gateway',
      ...extra
    }
  }

  function directEntry(provider: string, name: string, extra: Record<string, unknown> = {}): any {
    return {
      id: name,
      canonicalId: `${provider}/${name}`,
      provider,
      upstreamProvider: provider,
      name,
      displayName: name,
      tags: [],
      purpose: 'chat',
      features: { streaming: true, tools: false, vision: false },
      category: 'balanced',
      source: 'direct',
      transport: 'direct',
      connectionId: `direct:${provider}`,
      ...extra
    }
  }

  const sonnetGateway = () =>
    gatewayEntry('anthropic', 'claude-sonnet-4.5', {
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: { input: 3, output: 15, cachedInput: 0.3 }
    })

  function assemble(args: {
    gateway?: any[]
    openRouter?: any[]
    direct?: Record<string, any[]>
    aa?: Record<string, any>
  }) {
    return _assembleCatalogModelsForTest({
      gatewayEntries: args.gateway ?? [],
      openRouterEntries: args.openRouter ?? [],
      directEntriesByProvider: args.direct ?? {},
      aaMap: new Map(Object.entries(args.aa ?? {}))
    })
  }

  it('merges a dated Anthropic snapshot into the gateway alias row', () => {
    const { models } = assemble({
      gateway: [sonnetGateway()],
      direct: { anthropic: [directEntry('anthropic', 'claude-sonnet-4-5-20250929')] }
    })

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'anthropic/claude-sonnet-4.5',
      pricing: { input: 3, output: 15, cachedInput: 0.3 },
      contextWindow: 1_000_000
    })
    expect(models[0].availableConnections).toEqual(expect.arrayContaining(['vercel-gateway', 'direct:anthropic']))
    // The direct preset still sends the dated id Anthropic's API listed.
    expect(models[0].idVariants?.['direct:anthropic']).toMatchObject({
      developerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      effectiveId: 'claude-sonnet-4-5-20250929',
      source: 'direct'
    })
  })

  it('keeps the direct connection\'s own limits instead of the gateway\'s 1,000,000', () => {
    const { models } = assemble({
      gateway: [sonnetGateway()],
      direct: { anthropic: [directEntry('anthropic', 'claude-sonnet-4-5-20250929')] }
    })

    expect(models[0].idVariants?.['direct:anthropic']?.limits).toEqual({ contextWindow: null, maxOutputTokens: null })
    expect(models[0].idVariants?.['vercel-gateway']?.limits).toBeUndefined()
  })

  it('does not let Artificial Analysis stand in for the direct connection\'s limits', () => {
    const { models } = assemble({
      gateway: [gatewayEntry('anthropic', 'claude-opus-4.5', { contextWindow: 200_000 })],
      direct: { anthropic: [directEntry('anthropic', 'claude-opus-4-5-20251101')] },
      aa: { claudeopus45: { slug: 'claude-opus-4-5', context_window: 1_000_000 } }
    })

    expect(models).toHaveLength(1)
    expect(models[0].aaSlug).toBe('claude-opus-4-5')
    expect(models[0].idVariants?.['direct:anthropic']?.limits).toEqual({ contextWindow: null, maxOutputTokens: null })
  })

  it('merges Opus 4.5 into its gateway row whether or not Artificial Analysis answers', () => {
    const withAa = assemble({
      gateway: [gatewayEntry('anthropic', 'claude-opus-4.5', { contextWindow: 200_000 })],
      direct: { anthropic: [directEntry('anthropic', 'claude-opus-4-5-20251101')] },
      aa: { claudeopus45: { slug: 'claude-opus-4-5' } }
    })
    const withoutAa = assemble({
      gateway: [gatewayEntry('anthropic', 'claude-opus-4.5', { contextWindow: 200_000 })],
      direct: { anthropic: [directEntry('anthropic', 'claude-opus-4-5-20251101')] }
    })

    expect(withAa.models.map((model) => model.id)).toEqual(['anthropic/claude-opus-4.5'])
    expect(withoutAa.models.map((model) => model.id)).toEqual(['anthropic/claude-opus-4.5'])
  })

  it('leaves the rows that already merge by Artificial Analysis exactly as they were', () => {
    const { models } = assemble({
      gateway: [gatewayEntry('anthropic', 'claude-opus-4.6', { contextWindow: 1_000_000 })],
      direct: { anthropic: [directEntry('anthropic', 'claude-opus-4-6')] },
      aa: { claudeopus46: { slug: 'claude-opus-4-6' } }
    })

    expect(models).toHaveLength(1)
    expect(models[0].idVariants?.['direct:anthropic']).toEqual({
      developerId: 'anthropic',
      modelId: 'claude-opus-4-6',
      effectiveId: 'claude-opus-4-6',
      source: 'direct'
    })
  })

  it('keeps a dated snapshot with no gateway twin as its own row, and publishes no working fields', () => {
    const { models } = assemble({
      direct: { anthropic: [directEntry('anthropic', 'claude-3-5-haiku-20241022')] }
    })

    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('claude-3-5-haiku-20241022')
    for (const model of models) {
      expect(model).not.toHaveProperty('identityName')
      expect(model).not.toHaveProperty('identityRule')
      expect(model).not.toHaveProperty('ownLimits')
    }
  })

  it('splits a second entry of one connection into its own row instead of dropping it', () => {
    const { models, variantCollisions } = assemble({
      gateway: [gatewayEntry('mistral', 'mistral-large')],
      direct: {
        mistral: [
          directEntry('mistral', 'mistral-large-latest'),
          directEntry('mistral', 'mistral-large-2411')
        ]
      },
      aa: {
        mistrallarge: { slug: 'mistral-large' },
        mistrallargelatest: { slug: 'mistral-large' },
        mistrallarge2411: { slug: 'mistral-large' }
      }
    })

    const merged = models.find((model) => model.id === 'mistral/mistral-large')
    // The variant that won before keeps winning, so no preset changes model.
    expect(merged?.idVariants?.['direct:mistral']?.effectiveId).toBe('mistral-large-2411')
    expect(models.find((model) => model.id === 'mistral-large-latest')).toBeTruthy()
    expect(variantCollisions).toEqual([
      expect.objectContaining({
        connectionId: 'direct:mistral',
        kept: 'mistral-large-2411',
        split: ['mistral-large-latest'],
        dropped: []
      })
    ])
  })

  it('reports, and does not publish, a split entry whose id another row already uses', () => {
    const { models, variantCollisions } = assemble({
      gateway: [gatewayEntry('mistral', 'mistral-small')],
      direct: {
        mistral: [directEntry('mistral', 'mistral-small'), directEntry('mistral', 'mistral-small-latest')]
      },
      aa: {
        mistralsmall: { slug: 'mistral-small' },
        mistralsmalllatest: { slug: 'mistral-small' }
      }
    })

    expect(models.filter((model) => model.canonicalId === 'mistral/mistral-small')).toHaveLength(1)
    expect(variantCollisions).toEqual([
      expect.objectContaining({ kept: 'mistral-small-latest', split: [], dropped: ['mistral-small'] })
    ])
  })

  it('fails the sync when the reviewed rule would put two entries of one connection in one row', () => {
    expect(() =>
      assemble({
        gateway: [gatewayEntry('anthropic', 'claude-haiku-4.5')],
        direct: {
          anthropic: [
            directEntry('anthropic', 'claude-haiku-4-5-20251001'),
            directEntry('anthropic', 'claude-haiku-4-5-20260101')
          ]
        }
      })
    ).toThrow(/reviewed identity rule/i)
  })

  it('drops the OpenAI models that only run on the legacy completions endpoint', () => {
    const entries = ['babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct', 'gpt-3.5-turbo-instruct-0914', 'gpt-4o'].map(
      (name) => directEntry('openai', name)
    )

    expect(_applyDirectSourceCatalogPolicyForTest('openai', entries).map((entry) => entry.name)).toEqual(['gpt-4o'])
  })

  it('publishes no window and no long-context claim when the window is unknown', () => {
    const [unknown, known, small] = [
      ..._mapDirectProviderEntriesForTest('openai', [{ id: 'mystery-model' }]),
      ..._mapDirectProviderEntriesForTest('openai', [{ id: 'long-model', contextWindow: 200_000 }]),
      ..._mapDirectProviderEntriesForTest('openai', [{ id: 'short-model', contextWindow: 64_000 }])
    ]

    expect(unknown.features).not.toHaveProperty('maxTokens')
    expect(unknown.features).not.toHaveProperty('longContext')
    expect(known.features).toMatchObject({ maxTokens: 200_000, longContext: true })
    expect(small.features).toMatchObject({ maxTokens: 64_000, longContext: false })
  })

  it('rebuilds a fallback entry with its connection\'s own limits, not the row\'s', () => {
    const existing = {
      models: [
        {
          ...sonnetGateway(),
          features: { streaming: true, tools: true, vision: true, maxTokens: 1_000_000, longContext: true },
          availableConnections: ['vercel-gateway', 'direct:anthropic'],
          idVariants: {
            'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-sonnet-4.5', effectiveId: 'anthropic/claude-sonnet-4.5', source: 'vercel' },
            'direct:anthropic': {
              developerId: 'anthropic',
              modelId: 'claude-sonnet-4-5-20250929',
              effectiveId: 'claude-sonnet-4-5-20250929',
              source: 'direct',
              limits: { contextWindow: null, maxOutputTokens: null }
            }
          }
        }
      ]
    }

    const [entry] = _buildFallbackEntriesFromExistingForTest({
      existing,
      connectionId: 'direct:anthropic',
      source: 'direct',
      transport: 'direct'
    })

    expect(entry.name).toBe('claude-sonnet-4-5-20250929')
    expect(entry.contextWindow).toBeUndefined()
    expect(entry.maxOutputTokens).toBeUndefined()
  })

  it('drops a stored unknown window from rebuilt features', () => {
    const [entry] = _buildFallbackEntriesFromExistingForTest({
      existing: {
        models: [
          directEntry('openai', 'mystery-model', {
            features: { streaming: true, tools: false, vision: false, maxTokens: 0, longContext: false },
            idVariants: { 'direct:openai': { developerId: 'openai', modelId: 'mystery-model', effectiveId: 'mystery-model', source: 'direct' } }
          })
        ]
      },
      connectionId: 'direct:openai',
      source: 'direct',
      transport: 'direct'
    })

    expect(entry.features).not.toHaveProperty('maxTokens')
    expect(entry.features).not.toHaveProperty('longContext')
  })
})

describe('BL-130 and BL-131 catalog prices: blank is unknown, zero is real', () => {
  const openRouter = (id: string, pricing: Record<string, string>) =>
    _mapOpenRouterModelToCatalogEntryForTest({ id, name: id, context_length: 131_072, pricing })

  it('keeps a free OpenRouter price as a real $0', () => {
    expect(openRouter('google/gemma-4-31b-it:free', { prompt: '0', completion: '0' }).pricing).toEqual({
      input: 0,
      output: 0
    })
  })

  it('treats OpenRouter\'s -1 (the price depends on the routed model) as unknown, never -1,000,000', () => {
    const entry = openRouter('openrouter/auto', { prompt: '-1', completion: '-1' })
    expect(entry.pricing).toBeUndefined()
  })

  it('treats a blank listed price as unknown, not $0', () => {
    expect(openRouter('acme/blank', { prompt: '', completion: '' }).pricing).toBeUndefined()
    expect(openRouter('acme/half', { prompt: '0.000001', completion: '' }).pricing).toEqual({ input: 1 })
  })

  it('never rounds a tiny real price down to a false $0', () => {
    expect(openRouter('openai/whisper-1', { prompt: '0.0000000001' }).pricing).toEqual({ input: 0.0001 })
  })

  it('reads a 0 the source marks as varying by provider as unknown', () => {
    const entry = _mapOpenRouterModelToCatalogEntryForTest({
      id: 'inclusionai/ling-3.0-flash-fin',
      name: 'Ling',
      pricing: { prompt: '0', completion: '0', varies_by_provider: true } as any
    })
    expect(entry.pricing).toBeUndefined()
  })

  it('still converts a per-token price to per million (the control)', () => {
    expect(openRouter('acme/paid', { prompt: '0.0000025', completion: '0.00001' }).pricing).toEqual({
      input: 2.5,
      output: 10
    })
  })

  it('keeps a Baseten free component at $0 and its paid ones', () => {
    const [entry] = _mapBasetenModelsForTest([
      { id: 'acme/free-model', pricing: { prompt: '0', completion: '0' } },
      { id: 'acme/paid-model', pricing: { prompt: '0.0000001', completion: '0.0000005', input_cache_read: '0.0000001' } }
    ])
    expect(entry.pricing).toEqual({ input: 0, output: 0 })
  })

  it('reads a Together null price as unknown, not $0', () => {
    const [entry] = _mapTogetherModelsForTest([
      { id: 'acme/null-priced', type: 'chat', pricing: { input: null, output: null, cached_input: null } }
    ])
    expect(entry.pricing).toBeUndefined()
  })

  it('reads a Together row with no per-token price (0 in and 0 out: a dedicated endpoint) as unknown', () => {
    const [dedicated, partly, paid] = _mapTogetherModelsForTest([
      { id: 'nim/meta/llama-3.3-70b-instruct', type: 'chat', pricing: { input: 0, output: 0 } },
      { id: 'together/Tev1-4B-experimental', type: 'chat', pricing: { input: 0.042, output: 0 } },
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', type: 'chat', pricing: { input: 0.3, output: 1.2, cached_input: 0.006 } }
    ])
    expect(dedicated.pricing).toBeUndefined()
    expect(partly.pricing).toEqual({ input: 0.042, output: 0 })
    expect(paid.pricing).toEqual({ input: 0.3, output: 1.2, cachedInput: 0.006 })
  })

  function gatewayRow(name: string, pricing?: Record<string, number>): any {
    return {
      id: `openai/${name}`,
      canonicalId: `openai/${name}`,
      provider: 'openai',
      upstreamProvider: 'vercel',
      name,
      displayName: name,
      tags: [],
      purpose: 'chat',
      pricing,
      features: { streaming: true, tools: true, vision: false },
      category: 'balanced',
      source: 'vercel',
      transport: 'vercel-gateway',
      connectionId: 'vercel-gateway'
    }
  }

  const aaNoData = { price_1m_blended_3_to_1: 0, price_1m_input_tokens: 0, price_1m_output_tokens: 0 }

  function assembleOne(row: any, aa: Record<string, any>) {
    return _assembleCatalogModelsForTest({
      gatewayEntries: [row],
      openRouterEntries: [],
      directEntriesByProvider: {},
      aaMap: new Map(Object.entries(aa))
    }).models[0]
  }

  it('never lets an Artificial Analysis 0 (no data) replace a row\'s own price', () => {
    const model = assembleOne(gatewayRow('gpt-5.5-pro', { input: 30, output: 180 }), {
      gpt55pro: { slug: 'gpt-5-5-pro', pricing: aaNoData }
    })
    expect(model.aaSlug).toBe('gpt-5-5-pro')
    expect(model.pricing).toEqual({ input: 30, output: 180 })
  })

  it('never turns an unpriced row into $0 from an Artificial Analysis 0', () => {
    const model = assembleOne(gatewayRow('mystery'), { mystery: { slug: 'mystery', pricing: aaNoData } })
    expect(model.pricing).toBeUndefined()
  })

  it('keeps the row\'s cached-input price next to an Artificial Analysis 0', () => {
    const model = assembleOne(gatewayRow('cached', { input: 0.6, output: 2.2, cachedInput: 0.11 }), {
      cached: { slug: 'cached', pricing: aaNoData }
    })
    expect(model.pricing).toEqual({ input: 0.6, output: 2.2, cachedInput: 0.11 })
  })

  it('keeps a row\'s own listed price over a different Artificial Analysis price (decision A)', () => {
    // The gateway's deepseek-v4-flash on 2026-09-25: $0.13 / $0.26; AA listed $0.44 / $1.32.
    const model = assembleOne(gatewayRow('deepseek-v4-flash', { input: 0.13, output: 0.26, cachedInput: 0.028 }), {
      deepseekv4flash: { slug: 'deepseek-v4-flash', pricing: { price_1m_blended_3_to_1: 0.66, price_1m_input_tokens: 0.44, price_1m_output_tokens: 1.32 } }
    })
    expect(model.pricing).toEqual({ input: 0.13, output: 0.26, cachedInput: 0.028 })
  })

  it('keeps a listed free price over a paid Artificial Analysis price', () => {
    const model = assembleOne(gatewayRow('ling-3.0-flash-fin-free', { input: 0, output: 0 }), {
      ling30flashfinfree: { slug: 'ling', pricing: { price_1m_input_tokens: 0.075, price_1m_output_tokens: 0.22 } }
    })
    expect(model.pricing).toEqual({ input: 0, output: 0 })
  })

  it('does not mix an Artificial Analysis price into a row that lists part of its own', () => {
    // An embedding row lists only an input price; it has no output price to fill.
    const model = assembleOne(gatewayRow('embed-model', { input: 0.02 }), {
      embedmodel: { slug: 'embed-model', pricing: { price_1m_input_tokens: 0.05, price_1m_output_tokens: 0.2 } }
    })
    expect(model.pricing).toEqual({ input: 0.02 })
  })

  it('still fills an unpriced row from a real Artificial Analysis price (the control)', () => {
    const model = assembleOne(gatewayRow('filled'), {
      filled: { slug: 'filled', pricing: { price_1m_blended_3_to_1: 8, price_1m_input_tokens: 4, price_1m_output_tokens: 20 } }
    })
    expect(model.pricing).toEqual({ input: 4, output: 20 })
  })
})

describe('BL-133 the fail-safe rebuild keeps what the snapshot published', () => {
  const variant = (developerId: string, modelId: string, effectiveId: string, source: string) => ({
    developerId,
    modelId,
    effectiveId,
    source
  })

  const snapshot = {
    models: [
      {
        id: 'openai/gpt-5.5',
        canonicalId: 'openai/gpt-5.5',
        provider: 'openai',
        upstreamProvider: 'vercel',
        name: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: '',
        tags: ['tool-use'],
        purpose: 'chat',
        contextWindow: 400_000,
        features: { streaming: true, tools: true, vision: true, maxTokens: 400_000, longContext: true },
        category: 'powerful',
        source: 'vercel',
        transport: 'vercel-gateway',
        connectionId: 'vercel-gateway',
        modelType: 'language',
        availableConnections: ['vercel-gateway', 'openrouter', 'direct:openai'],
        idVariants: {
          'vercel-gateway': variant('openai', 'gpt-5.5', 'openai/gpt-5.5', 'vercel'),
          openrouter: variant('openai', 'gpt-5.5', 'openai/gpt-5.5', 'openrouter'),
          'direct:openai': variant('openai', 'gpt-5.5', 'gpt-5.5', 'direct')
        }
      },
      {
        id: 'acme/no-description',
        canonicalId: 'acme/no-description',
        provider: 'acme',
        upstreamProvider: 'vercel',
        name: 'no-description',
        displayName: 'No Description',
        tags: [],
        purpose: 'visual',
        features: { streaming: true, tools: false, vision: false },
        source: 'vercel',
        transport: 'vercel-gateway',
        connectionId: 'vercel-gateway',
        modelType: 'image',
        availableConnections: ['vercel-gateway'],
        idVariants: { 'vercel-gateway': variant('acme', 'no-description', 'acme/no-description', 'vercel') }
      }
    ]
  }

  const rebuild = (connectionId: any, source: any, transport: any) =>
    _buildFallbackEntriesFromExistingForTest({ existing: snapshot, connectionId, source, transport })

  it('keeps the model type', () => {
    const [gateway, image] = rebuild('vercel-gateway', 'vercel', 'vercel-gateway')
    expect(gateway.modelType).toBe('language')
    expect(image.modelType).toBe('image')
    expect(image.purpose).toBe('visual')
  })

  it('names the upstream provider the way a live fetch does', () => {
    expect(rebuild('vercel-gateway', 'vercel', 'vercel-gateway')[0].upstreamProvider).toBe('vercel')
    expect(rebuild('openrouter', 'openrouter', 'openrouter')[0].upstreamProvider).toBe('openrouter')
    expect(rebuild('direct:openai', 'direct', 'direct')[0].upstreamProvider).toBe('openai')
  })

  it('keeps an empty description empty and a missing one missing', () => {
    const [gateway, image] = rebuild('vercel-gateway', 'vercel', 'vercel-gateway')
    expect(gateway.description).toBe('')
    expect(image).not.toHaveProperty('description')
  })

  it('rebuilds a snapshot into the same published rows (a replay changes nothing it does not have to)', () => {
    const payload = buildCatalogFromSnapshot(snapshot as any).payload
    const byId = new Map(payload.models.map((model: any) => [model.id, model]))
    for (const original of snapshot.models) {
      const rebuilt: any = byId.get(original.id)
      expect(rebuilt?.modelType).toBe(original.modelType)
      expect(rebuilt?.upstreamProvider).toBe(original.upstreamProvider)
      expect(rebuilt?.description).toBe((original as any).description)
    }
  })
})

describe('BL-132 each connection in a merged row keeps the limits and price its own source listed', () => {
  function entry(connection: string, provider: string, name: string, extra: Record<string, unknown> = {}): any {
    const gateway = connection === 'vercel-gateway'
    return {
      id: gateway ? `${provider}/${name}` : name,
      canonicalId: `${provider}/${name}`,
      provider,
      upstreamProvider: gateway ? 'vercel' : connection.replace('direct:', ''),
      name,
      displayName: name,
      tags: [],
      purpose: 'chat',
      features: { streaming: true, tools: true, vision: false },
      category: 'balanced',
      source: gateway ? 'vercel' : 'direct',
      transport: gateway ? 'vercel-gateway' : 'direct',
      connectionId: connection,
      ...extra
    }
  }

  // Z.ai's reviewed developer alias joins DeepInfra's zai-org row to the gateway's zai row.
  const gatewayGlm = () =>
    entry('vercel-gateway', 'zai', 'glm-5.3', {
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
      pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 }
    })
  const deepInfraGlm = (extra: Record<string, unknown> = {}) =>
    entry('direct:deepinfra', 'zai-org', 'GLM-5.3', {
      id: 'zai-org/GLM-5.3',
      contextWindow: 131_072,
      pricing: { input: 0.45, output: 1.9 },
      ...extra
    })
  const aa = { glm53: { slug: 'glm-5-3' } }

  function assemble(gateway: any[], direct: Record<string, any[]>, aaMap: Record<string, any> = aa) {
    return _assembleCatalogModelsForTest({
      gatewayEntries: gateway,
      openRouterEntries: [],
      directEntriesByProvider: direct,
      aaMap: new Map(Object.entries(aaMap))
    }).models
  }

  it('gives an open-model host its own window and price; the row and the gateway keep the gateway\'s', () => {
    const models = assemble([gatewayGlm()], { deepinfra: [deepInfraGlm()] })
    expect(models).toHaveLength(1)
    const [row] = models
    expect(row).toMatchObject({
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
      pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 }
    })
    expect(row.idVariants?.['direct:deepinfra']).toMatchObject({
      effectiveId: 'zai-org/GLM-5.3',
      limits: { contextWindow: 131_072, maxOutputTokens: null },
      pricing: { input: 0.45, output: 1.9 }
    })
    expect(row.idVariants?.['vercel-gateway']).not.toHaveProperty('limits')
    expect(row.idVariants?.['vercel-gateway']).not.toHaveProperty('pricing')
  })

  it('records the host\'s own price when Artificial Analysis lists yet another one', () => {
    const [row] = assemble([gatewayGlm()], { deepinfra: [deepInfraGlm()] }, {
      glm53: { slug: 'glm-5-3', pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 3.2 } }
    })
    // Decision A: each listed price is its own; AA's fills only a row that lists none.
    expect(row.pricing).toEqual({ input: 0.6, output: 2.2, cachedInput: 0.11 })
    expect(row.idVariants?.['direct:deepinfra']?.pricing).toEqual({ input: 0.45, output: 1.9 })
  })

  it('adds nothing for a connection whose listed numbers match the row or that lists none', () => {
    const [row] = assemble([gatewayGlm()], {
      deepinfra: [deepInfraGlm({ contextWindow: 262_144, pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 } })],
      zai: [entry('direct:zai', 'zai', 'glm-5.3')]
    })
    expect(row.idVariants?.['direct:deepinfra']).not.toHaveProperty('limits')
    expect(row.idVariants?.['direct:deepinfra']).not.toHaveProperty('pricing')
    expect(row.idVariants?.['direct:zai']).not.toHaveProperty('limits')
    expect(row.idVariants?.['direct:zai']).not.toHaveProperty('pricing')
  })

  it('gives a direct Anthropic connection merged by the slug its own reported limits', () => {
    const [row] = assemble(
      [entry('vercel-gateway', 'anthropic', 'claude-opus-4.1', { contextWindow: 1_000_000, maxOutputTokens: 32_000, pricing: { input: 15, output: 75 } })],
      { anthropic: [entry('direct:anthropic', 'anthropic', 'claude-opus-4-1', { contextWindow: 200_000, maxOutputTokens: 32_000 })] },
      { claudeopus41: { slug: 'claude-opus-4-1' } }
    )
    expect(row.idVariants?.['direct:anthropic']?.limits).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 })
    // Anthropic's direct list carries no price; the list price is the row's.
    expect(row.idVariants?.['direct:anthropic']).not.toHaveProperty('pricing')
  })

  it('publishes no working fields', () => {
    for (const model of assemble([gatewayGlm()], { deepinfra: [deepInfraGlm()] })) {
      expect(model).not.toHaveProperty('ownLimits')
      expect(model).not.toHaveProperty('ownPricing')
    }
  })

  it('rebuilds a fallback entry with its connection\'s own price and window, and a replay publishes them again', () => {
    const [row] = assemble([gatewayGlm()], { deepinfra: [deepInfraGlm()] })
    const [rebuilt] = _buildFallbackEntriesFromExistingForTest({
      existing: { models: [row] },
      connectionId: 'direct:deepinfra',
      source: 'direct',
      transport: 'direct'
    })
    expect(rebuilt.pricing).toEqual({ input: 0.45, output: 1.9 })
    expect(rebuilt.contextWindow).toBe(131_072)

    const replayed = buildCatalogFromSnapshot({ models: [row] } as any).payload.models[0] as any
    expect(replayed.idVariants['direct:deepinfra']).toMatchObject({
      limits: { contextWindow: 131_072, maxOutputTokens: null },
      pricing: { input: 0.45, output: 1.9 }
    })
    expect(replayed.pricing).toEqual(row.pricing)
  })
})

describe('BL-132 (superseded 2026-09-27): matching input/output but no cache price keeps the connection\'s own, not the row\'s', () => {
  it('tolerates float noise in input/output but still keeps its own price when it lists no cache price', () => {
    // This used to add no per-connection price at all (borrowing the row's,
    // cached price included). That was the exact bug this session fixes: a
    // non-maker connection that lists no cached price of its own must never
    // show another host's (real case: Together's zai-org/GLM-4.6, BL-295 review).
    const gateway: any = {
      id: 'zai/glm-5.3', canonicalId: 'zai/glm-5.3', provider: 'zai', upstreamProvider: 'vercel', name: 'glm-5.3',
      displayName: 'GLM 5.3', tags: [], purpose: 'chat', features: { streaming: true, tools: true, vision: false },
      source: 'vercel', transport: 'vercel-gateway', connectionId: 'vercel-gateway',
      pricing: { input: 3, output: 15, cachedInput: 0.3 }
    }
    const deepinfra: any = {
      ...gateway, id: 'zai-org/GLM-5.3', canonicalId: 'zai-org/glm-5.3', provider: 'zai-org', upstreamProvider: 'deepinfra',
      name: 'GLM-5.3', source: 'direct', transport: 'direct', connectionId: 'direct:deepinfra',
      // DeepInfra's cents-per-token arithmetic: $3 arrives as 2.9999999999999996.
      pricing: { input: 0.0003 * 10_000, output: 15 }
    }
    const [row] = _assembleCatalogModelsForTest({
      gatewayEntries: [gateway],
      openRouterEntries: [],
      directEntriesByProvider: { deepinfra: [deepinfra] },
      aaMap: new Map([['glm53', { slug: 'glm-5-3' }]])
    }).models
    // DeepInfra keeps its own input/output (float noise and all) and has no
    // cachedInput: it never borrows the gateway's 0.3.
    expect(row.idVariants?.['direct:deepinfra']?.pricing).toEqual({ input: 0.0003 * 10_000, output: 15 })
  })
})

describe('BL-199 direct Anthropic limits come from Anthropic\'s own model list', () => {
  const caps = (vision: boolean, thinking: boolean) => ({
    image_input: { supported: vision },
    thinking: { supported: thinking, types: { enabled: { supported: thinking } } },
    pdf_input: { supported: true }
  })
  // The shape GET https://api.anthropic.com/v1/models returned on 2026-09-25.
  const listed = [
    { type: 'model', id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: caps(true, true) },
    { type: 'model', id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200_000, max_tokens: 64_000, capabilities: caps(true, true) },
    { type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000, max_tokens: 64_000, capabilities: caps(true, true) },
    { type: 'model', id: 'claude-legacy', display_name: 'Legacy' }
  ]

  it('reads the window, the output cap, and the capabilities into the direct entry', () => {
    const [sonnet46, opus45, , legacy] = _mapAnthropicModelsForTest(listed)
    expect(sonnet46).toMatchObject({ id: 'claude-sonnet-4-6', contextWindow: 1_000_000, maxOutputTokens: 128_000 })
    expect(sonnet46.tags).toEqual(expect.arrayContaining(['vision', 'reasoning']))
    expect(opus45).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000 })
    // A model the list gives no numbers for stays unknown.
    expect(legacy.contextWindow).toBeUndefined()
    expect(legacy.maxOutputTokens).toBeUndefined()
    expect(legacy.tags).toEqual([])
  })

  it('keeps Sonnet 4.5 at 200,000: the list reports the 1,000,000 that needs a header Batshit does not send', () => {
    const sonnet45 = _mapAnthropicModelsForTest(listed)[2]
    expect(sonnet45).toMatchObject({ id: 'claude-sonnet-4-5-20250929', contextWindow: 200_000, maxOutputTokens: 64_000 })
  })

  it('lands Anthropic\'s own limits on the direct variant of the merged gateway rows', () => {
    const direct = _mapDirectProviderEntriesForTest('anthropic', _mapAnthropicModelsForTest(listed))
    const gateway = (name: string, contextWindow: number, maxOutputTokens: number): any => ({
      id: `anthropic/${name}`, canonicalId: `anthropic/${name}`, provider: 'anthropic', upstreamProvider: 'vercel', name,
      displayName: name, tags: [], purpose: 'chat', features: { streaming: true, tools: true, vision: true },
      source: 'vercel', transport: 'vercel-gateway', connectionId: 'vercel-gateway', contextWindow, maxOutputTokens,
      pricing: { input: 3, output: 15 }
    })
    const { models } = _assembleCatalogModelsForTest({
      gatewayEntries: [gateway('claude-sonnet-4.5', 1_000_000, 64_000), gateway('claude-opus-4.5', 200_000, 64_000), gateway('claude-sonnet-4.6', 1_000_000, 128_000)],
      openRouterEntries: [],
      directEntriesByProvider: { anthropic: direct },
      aaMap: new Map([['claudesonnet46', { slug: 'claude-sonnet-4-6' }]])
    })
    const row = (id: string) => models.find((model) => model.id === id)
    // Joined by the reviewed dated-snapshot rule: always its own limits.
    expect(row('anthropic/claude-sonnet-4.5')?.idVariants?.['direct:anthropic']?.limits).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 64_000
    })
    expect(row('anthropic/claude-opus-4.5')?.idVariants?.['direct:anthropic']?.limits).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 64_000
    })
    // Joined by the slug and listing the row's own numbers: nothing to add.
    expect(row('anthropic/claude-sonnet-4.6')?.idVariants?.['direct:anthropic']).not.toHaveProperty('limits')
  })
})

describe('BL-241 the MiMo Token Plan joins the MiMo rows instead of publishing each id twice', () => {
  it('merges the plan\'s fallback list into the rows Xiaomi\'s own feed publishes', () => {
    // Xiaomi's /models (2026-09-25) owns every MiMo model as `xiaomi`.
    const mimo = _mapDirectProviderEntriesForTest(
      'mimo',
      _mapOpenAICompatibleCatalogModelsForTest('mimo', [
        { id: 'mimo-v2.5', owned_by: 'xiaomi' },
        { id: 'mimo-v2.5-asr', owned_by: 'xiaomi' },
        { id: 'mimo-v2.5-pro', owned_by: 'xiaomi' },
        { id: 'mimo-v2.5-tts', owned_by: 'xiaomi' },
        { id: 'mimo-v2.5-tts-voiceclone', owned_by: 'xiaomi' },
        { id: 'mimo-v2.5-tts-voicedesign', owned_by: 'xiaomi' }
      ])
    )
    const plan = _mapDirectProviderEntriesForTest('mimo_token_plan', _getManualDirectModelsForTest('mimo_token_plan'))

    const { models } = _assembleCatalogModelsForTest({
      gatewayEntries: [],
      openRouterEntries: [],
      directEntriesByProvider: { mimo, mimo_token_plan: plan },
      aaMap: new Map()
    })

    const ids = models.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(models).toHaveLength(6)
    for (const model of models) {
      expect(model.availableConnections).toEqual(expect.arrayContaining(['direct:mimo', 'direct:mimo_token_plan']))
      // Each connection still sends the id its own API listed.
      expect(model.idVariants?.['direct:mimo_token_plan']?.effectiveId).toBe(model.idVariants?.['direct:mimo']?.effectiveId)
    }
    // The plan's audio models keep their audio purpose.
    expect(models.find((model) => model.name === 'mimo-v2.5-asr')?.purpose).toBe('audio')
  })
})

describe('A window of 0 is unknown, never published as 0 (new find in the 2026-09-25 bug batch)', () => {
  it('drops the gateway\'s 0 window (mistral-embed, minimax-h3)', () => {
    const entry = _mapGatewayModelToCatalogEntryForTest({ id: 'mistral/mistral-embed', name: 'Mistral Embed', context_window: 0, max_tokens: 0 })
    expect(entry.contextWindow).toBeUndefined()
    expect(entry.maxOutputTokens).toBeUndefined()
    expect(entry.features).not.toHaveProperty('maxTokens')
  })

  it('still reads a real gateway window (the control)', () => {
    const entry = _mapGatewayModelToCatalogEntryForTest({ id: 'acme/long', name: 'Long', context_window: 200_000, max_tokens: 32_000 })
    expect(entry.contextWindow).toBe(200_000)
    expect(entry.maxOutputTokens).toBe(32_000)
  })

  it('drops an OpenRouter 0 window', () => {
    const entry = _mapOpenRouterModelToCatalogEntryForTest({ id: 'acme/zero', name: 'Zero', context_length: 0 })
    expect(entry.contextWindow).toBeUndefined()
  })

  it('drops a 0 window a published snapshot still carries when the rebuild reads it', () => {
    const [entry] = _buildFallbackEntriesFromExistingForTest({
      existing: {
        models: [
          {
            id: 'mistral/mistral-embed', canonicalId: 'mistral/mistral-embed', provider: 'mistral', name: 'mistral-embed',
            displayName: 'Mistral Embed', tags: [], purpose: 'utility', contextWindow: 0, maxOutputTokens: 0,
            features: { streaming: true, tools: false, vision: false }, source: 'vercel', transport: 'vercel-gateway',
            connectionId: 'vercel-gateway', availableConnections: ['vercel-gateway'],
            idVariants: { 'vercel-gateway': { developerId: 'mistral', modelId: 'mistral-embed', effectiveId: 'mistral/mistral-embed', source: 'vercel' } }
          }
        ]
      },
      connectionId: 'vercel-gateway',
      source: 'vercel',
      transport: 'vercel-gateway'
    })
    expect(entry.contextWindow).toBeUndefined()
    expect(entry.maxOutputTokens).toBeUndefined()
  })
})

describe('A 0 is a free price only when the source means free (review finding 1, 2026-09-25)', () => {
  const openRouter = (raw: Record<string, unknown>) => _mapOpenRouterModelToCatalogEntryForTest(raw as any)
  const gateway = (raw: Record<string, unknown>) => _mapGatewayModelToCatalogEntryForTest(raw as any)
  const text = { input_modalities: ['text'], output_modalities: ['text'] }

  it('keeps OpenRouter\'s marked free rows at $0', () => {
    expect(openRouter({ id: 'google/gemma-4-31b-it:free', name: 'Gemma', pricing: { prompt: '0', completion: '0' }, architecture: text }).pricing)
      .toEqual({ input: 0, output: 0 })
    // Its free router is free by name.
    expect(openRouter({ id: 'openrouter/free', name: 'Free Router', pricing: { prompt: '0', completion: '0' }, architecture: text }).pricing)
      .toEqual({ input: 0, output: 0 })
  })

  it('reads Lyria\'s 0/0 as unknown: it sells songs ($0.08 each), and its output is audio', () => {
    const lyria = openRouter({
      id: 'google/lyria-3-pro-preview',
      name: 'Lyria 3 Pro',
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] }
    })
    expect(lyria.pricing).toBeUndefined()
  })

  it('reads an OpenRouter 0/0 without its free marker as unknown', () => {
    expect(openRouter({ id: 'stealth/space-bunny-alpha', name: 'Space Bunny', pricing: { prompt: '0', completion: '0' }, architecture: text }).pricing)
      .toBeUndefined()
  })

  it('reads a 0 token price beside a per-request price as unknown', () => {
    expect(openRouter({ id: 'acme/per-request', name: 'Per Request', pricing: { prompt: '0', completion: '0.000002', request: '0.01' }, architecture: text }).pricing)
      .toEqual({ output: 2 })
  })

  it('reads a 0 token price on a model that makes audio as unknown', () => {
    expect(openRouter({
      id: 'acme/speaks',
      name: 'Speaks',
      pricing: { prompt: '0', completion: '0.000004' },
      architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] }
    }).pricing).toEqual({ output: 4 })
  })

  it('reads grok-stt\'s 0 input as unknown: it is priced per second of audio', () => {
    const stt = gateway({
      id: 'spacexai/grok-stt',
      name: 'Grok STT',
      type: 'transcription',
      pricing: { input: '0', transcription_duration_cost_per_second: '0.000028' }
    })
    expect(stt.pricing).toBeUndefined()
  })

  it('keeps the gateway\'s -free rows at $0 and reads its unmarked 0/0 as unknown', () => {
    expect(gateway({ id: 'inclusionai/ling-3.0-flash-sante-free', name: 'Sante Free', type: 'language', pricing: { input: '0', output: '0' } }).pricing)
      .toEqual({ input: 0, output: 0 })
    expect(gateway({ id: 'inclusionai/ling-3.0-flash-sante', name: 'Sante', type: 'language', pricing: { input: '0', output: '0' } }).pricing)
      .toBeUndefined()
  })

  it('reads a 0 on a gateway image or video model as unknown, and a 0 beside a per-character price', () => {
    expect(gateway({ id: 'acme/video-model', name: 'Video', type: 'video', pricing: { input: '0' } }).pricing).toBeUndefined()
    expect(gateway({ id: 'acme/voice', name: 'Voice', type: 'language', pricing: { input: '0', output: '0.000001', speech_input_character_cost: '0.00001' } }).pricing)
      .toEqual({ output: 1 })
  })

  it('keeps a marked free model at $0 even when it makes audio', () => {
    expect(openRouter({
      id: 'acme/song-model:free',
      name: 'Songs',
      pricing: { prompt: '0', completion: '0' },
      architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] }
    }).pricing).toEqual({ input: 0, output: 0 })
  })

  it('keeps a real 0 beside a real price (the control): Jev lists no output price', () => {
    expect(gateway({ id: 'typesafe-ai/jev', name: 'Jev', type: 'evaluation', pricing: { input: '0.000000042', output: '0' } }).pricing)
      .toEqual({ input: 0.042, output: 0 })
  })
})

/** Shared fixture for the 2026-09-27 batch: one catalog entry as a source adapter makes it. */
function batchEntry(connection: string, provider: string, name: string, extra: Record<string, unknown> = {}): any {
  const gateway = connection === 'vercel-gateway'
  return {
    id: gateway ? `${provider}/${name}` : name,
    canonicalId: `${provider}/${name}`,
    provider,
    upstreamProvider: gateway ? 'vercel' : connection.replace('direct:', ''),
    name,
    displayName: name,
    tags: [],
    purpose: 'chat',
    features: { streaming: true, tools: true, vision: false },
    category: 'balanced',
    source: gateway ? 'vercel' : 'direct',
    transport: gateway ? 'vercel-gateway' : 'direct',
    connectionId: connection,
    ...extra
  }
}

function assembleBatch(gateway: any[], direct: Record<string, any[]>, aa: Record<string, any> = {}) {
  return _assembleCatalogModelsForTest({
    gatewayEntries: gateway,
    openRouterEntries: [],
    directEntriesByProvider: direct,
    aaMap: new Map(Object.entries(aa))
  })
}

describe('BL-292 Qwen Cloud rows name the model maker, not DashScope\'s "system"', () => {
  // DashScope's /models (live read 2026-09-27) lists owned_by "system" for all 172 rows.
  const dashscope = (ids: string[]) =>
    _mapDirectProviderEntriesForTest(
      'qwencloud',
      _mapOpenAICompatibleCatalogModelsForTest(
        'qwencloud',
        ids.map((id) => ({ id, owned_by: 'system' }))
      )
    )

  it('names each maker from the model id, and each variant still sends the exact id DashScope listed', () => {
    const rows = dashscope([
      'qwen3.8-max',
      'qwq-plus',
      'qvq-max',
      'deepseek-v4-pro',
      'glm-5.3',
      'kimi-k3',
      'kimi/kimi-k3',
      'ZHIPU/GLM-5.3',
      'wan2.7-image',
      'z-image-turbo',
      'text-embedding-v4',
      'tongyi-tingwu-slp',
      'ccai-pro'
    ])
    const makers = Object.fromEntries(rows.map((row: any) => [row.id, row.provider]))
    expect(makers).toEqual({
      'qwen3.8-max': 'qwen',
      'qwq-plus': 'qwen',
      'qvq-max': 'qwen',
      'deepseek-v4-pro': 'deepseek',
      'glm-5.3': 'zai',
      'kimi-k3': 'moonshotai',
      'kimi/kimi-k3': 'moonshotai',
      'ZHIPU/GLM-5.3': 'zai',
      'wan2.7-image': 'alibaba',
      'z-image-turbo': 'alibaba',
      'text-embedding-v4': 'alibaba',
      'tongyi-tingwu-slp': 'alibaba',
      'ccai-pro': 'alibaba'
    })
    for (const row of rows) {
      // DashScope has no developer namespace: its model id is the whole id.
      expect(row.name).toBe(row.id)
    }
  })

  it('never publishes "system": an id no rule knows keeps the connection as its developer', () => {
    const [row] = dashscope(['acme-future-model'])
    expect(row.provider).toBe('qwencloud')
    // A real owner a future list names still counts (the control).
    const [owned] = _mapOpenAICompatibleCatalogModelsForTest('qwencloud', [{ id: 'acme-future-model', owned_by: 'Acme' }])
    expect(owned.developerId).toBe('acme')
  })

  it('merges Qwen Cloud\'s kimi-k3 into the maker\'s row, and keeps kimi/kimi-k3 as a row of its own', () => {
    const { models, variantCollisions } = assembleBatch(
      [batchEntry('vercel-gateway', 'moonshotai', 'kimi-k3', { pricing: { input: 3, output: 15 } })],
      { qwencloud: dashscope(['kimi-k3', 'kimi/kimi-k3']) }
    )
    expect(variantCollisions).toEqual([])
    const row = models.find((model) => model.id === 'moonshotai/kimi-k3')
    expect(row?.idVariants?.['direct:qwencloud']).toMatchObject({ developerId: 'moonshotai', modelId: 'kimi-k3', effectiveId: 'kimi-k3' })
    expect(models.some((model) => model.canonicalId.startsWith('system/'))).toBe(false)
    const namespaced = models.find((model) => model.id === 'kimi/kimi-k3')
    expect(namespaced).toMatchObject({ provider: 'moonshotai', availableConnections: ['direct:qwencloud'] })
  })
})

describe('BL-293 Moonshot\'s direct rows join the moonshotai rows', () => {
  it('merges Moonshot\'s own kimi-k3 into the gateway\'s moonshotai row', () => {
    // Moonshot's /models (live read 2026-09-27) owns every model as "moonshot".
    const moonshot = _mapDirectProviderEntriesForTest('moonshot', [{ id: 'kimi-k3' }, { id: 'kimi-k2.6' }])
    const { models } = assembleBatch(
      [
        batchEntry('vercel-gateway', 'moonshotai', 'kimi-k3', { pricing: { input: 3, output: 15 } }),
        batchEntry('vercel-gateway', 'moonshotai', 'kimi-k2.6', { pricing: { input: 0.95, output: 4 } })
      ],
      { moonshot }
    )
    expect(models).toHaveLength(2)
    const row = models.find((model) => model.id === 'moonshotai/kimi-k3')
    expect(row?.provider).toBe('moonshotai')
    // The direct variant still names Moonshot's own namespace and sends its own id.
    expect(row?.idVariants?.['direct:moonshot']).toMatchObject({ developerId: 'moonshot', modelId: 'kimi-k3', effectiveId: 'kimi-k3' })
  })
})

describe('BL-295 catalog leftovers', () => {
  it('names a merged row from a member that has a name when its base lists only the bare id (MiMo audio)', () => {
    const mimo = _mapDirectProviderEntriesForTest(
      'mimo',
      _mapOpenAICompatibleCatalogModelsForTest('mimo', [{ id: 'mimo-v2.5-asr', owned_by: 'xiaomi' }])
    )
    const plan = _mapDirectProviderEntriesForTest('mimo_token_plan', _getManualDirectModelsForTest('mimo_token_plan'))
    const { models } = assembleBatch([], { mimo, mimo_token_plan: plan })
    const asr = models.find((model) => model.name === 'mimo-v2.5-asr')
    expect(asr?.displayName).toBe('MiMo V2.5 ASR')
    // The base still sends its own id.
    expect(asr?.id).toBe('mimo-v2.5-asr')
  })

  it('skips a member whose name is blank or only the id it sends', () => {
    // Group order: Qwen Cloud (the base, named by its id), the Token Plan (blank), Z.ai.
    const { models } = assembleBatch([], {
      qwencloud: [batchEntry('direct:qwencloud', 'zai', 'glm-5.3')],
      qwen_token_plan: [batchEntry('direct:qwen_token_plan', 'zai', 'glm-5.3', { displayName: ' ' })],
      zai: [batchEntry('direct:zai', 'zai', 'glm-5.3', { displayName: 'GLM-5.3' })]
    })
    expect(models).toHaveLength(1)
    expect(models[0].displayName).toBe('GLM-5.3')
    expect(models[0].id).toBe('glm-5.3')
  })

  it('keeps a base\'s own name, even one that is its model segment (the control)', () => {
    const named = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3', { displayName: 'GLM 5.3' })],
      { qwen_token_plan: [batchEntry('direct:qwen_token_plan', 'zai', 'glm-5.3', { displayName: 'GLM-5.3 (Token Plan)' })] }
    )
    expect(named.models[0].displayName).toBe('GLM 5.3')
    // The gateway names o3-mini "o3-mini"; OpenRouter's "o3 Mini" does not replace it.
    const segment = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3')],
      { qwen_token_plan: [batchEntry('direct:qwen_token_plan', 'zai', 'glm-5.3', { displayName: 'GLM-5.3 (Token Plan)' })] }
    )
    expect(segment.models[0].displayName).toBe('glm-5.3')
  })

  it('never lends a member connection\'s price to a base that lists none', () => {
    // Artificial Analysis knows the model (the merge) but lists no price for it.
    const { models } = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3')],
      { deepinfra: [batchEntry('direct:deepinfra', 'zai-org', 'GLM-5.3', { id: 'zai-org/GLM-5.3', pricing: { input: 0.45, output: 1.9 } })] },
      { glm53: { slug: 'glm-5-3' } }
    )
    expect(models).toHaveLength(1)
    const [row] = models
    // Unknown on the row and on the gateway, never DeepInfra's price.
    expect(row.pricing).toBeUndefined()
    expect(row.idVariants?.['vercel-gateway']).not.toHaveProperty('pricing')
    expect(row.idVariants?.['direct:deepinfra']?.pricing).toEqual({ input: 0.45, output: 1.9 })
  })

  it('still fills a base that lists no price from a real Artificial Analysis price (the control)', () => {
    const { models } = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3')],
      { deepinfra: [batchEntry('direct:deepinfra', 'zai-org', 'GLM-5.3', { id: 'zai-org/GLM-5.3', pricing: { input: 0.45, output: 1.9 } })] },
      { glm53: { slug: 'glm-5-3', pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 3.2 } } }
    )
    expect(models[0].pricing).toEqual({ input: 1, output: 3.2 })
    expect(models[0].idVariants?.['direct:deepinfra']?.pricing).toEqual({ input: 0.45, output: 1.9 })
  })

  it('rebuilds a fallen-back connection that took the row\'s price with no price of its own', () => {
    const [row] = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3', { pricing: { input: 0.6, output: 2.2 } })],
      { zai: [batchEntry('direct:zai', 'zai', 'glm-5.3')] }
    ).models
    const rebuild = (connectionId: any, source: any, transport: any) =>
      _buildFallbackEntriesFromExistingForTest({ existing: { models: [row] }, connectionId, source, transport })[0]

    // Z.ai's own list names no price, so the snapshot's row price is not Z.ai's.
    expect(rebuild('direct:zai', 'direct', 'direct').pricing).toBeUndefined()
    // The base's price is the row's (the control).
    expect(rebuild('vercel-gateway', 'vercel', 'vercel-gateway').pricing).toEqual({ input: 0.6, output: 2.2 })

    // When the gateway's price moves, the fallen-back Z.ai entry follows the row, as it did when published.
    const [next] = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3', { pricing: { input: 0.5, output: 2 } })],
      { zai: [rebuild('direct:zai', 'direct', 'direct')] }
    ).models
    expect(next.idVariants?.['direct:zai']).not.toHaveProperty('pricing')
  })

  it('reads DeepInfra\'s cents per token through the shared price rules: exact dollars, no negative', () => {
    const [glm, negative, tiny] = _mapDeepInfraModelsForTest([
      {
        model_name: 'zai-org/GLM-5.3',
        reported_type: 'text-generation',
        pricing: { cents_per_input_token: 0.0003, cents_per_output_token: 0.0006, rate_per_input_token_cached: 0.2 },
        deprecated: null,
        private: 0
      },
      {
        model_name: 'acme/Negative',
        reported_type: 'text-generation',
        pricing: { cents_per_input_token: -1, cents_per_output_token: 0.0006 },
        deprecated: null,
        private: 0
      },
      {
        model_name: 'acme/Tiny',
        reported_type: 'text-generation',
        pricing: { cents_per_input_token: 0.000000001, cents_per_output_token: 0.000002 },
        deprecated: null,
        private: 0
      }
    ])
    // Live list 2026-09-27: 0.0003 cents a token arithmetic gives 2.9999999999999996.
    expect(glm.pricing).toEqual({ input: 3, output: 6, cachedInput: 0.6 })
    expect(negative.pricing).toEqual({ output: 6 })
    // A real price below a tenth of a cent keeps its own digits, never $0.
    expect(tiny.pricing).toEqual({ input: 0.00001, output: 0.02 })
  })

  it('keeps DeepInfra\'s real sub-cent cached prices (review: 0.0075 was shown as 0.008)', () => {
    // Live list 2026-09-27: granite-4.2-3b caches at a quarter of $0.03; MiMo-V2.6-Flash
    // at DeepInfra's rate 0.01928571 of $0.14 (0.0026999994 before rounding).
    const [granite, mimo] = _mapDeepInfraModelsForTest([
      {
        model_name: 'ibm-granite/granite-4.2-3b',
        reported_type: 'text-generation',
        pricing: { cents_per_input_token: 0.000003, cents_per_output_token: 0.000012, rate_per_input_token_cached: 0.25 },
        deprecated: null,
        private: 0
      },
      {
        model_name: 'XiaomiMiMo/MiMo-V2.6-Flash',
        reported_type: 'text-generation',
        pricing: { cents_per_input_token: 0.000014, cents_per_output_token: 0.000028, rate_per_input_token_cached: 0.01928571 },
        deprecated: null,
        private: 0
      }
    ])
    expect(granite.pricing).toEqual({ input: 0.03, output: 0.12, cachedInput: 0.0075 })
    expect(mimo.pricing).toEqual({ input: 0.14, output: 0.28, cachedInput: 0.0027 })
  })

  it('drops the placeholder token price the gateway lists beside a per-second transcription price', () => {
    const gateway = (raw: Record<string, unknown>) => _mapGatewayModelToCatalogEntryForTest(raw as any)
    // The gateway's list (2026-09-25): whisper-1 costs $0.0001 a second and lists 0.0000000001 a token.
    expect(gateway({
      id: 'openai/whisper-1',
      name: 'Whisper',
      type: 'transcription',
      pricing: { input: '0.0000000001', transcription_duration_cost_per_second: '0.0001' }
    }).pricing).toBeUndefined()
    // A transcription model the gateway prices per token keeps its prices (the control).
    expect(gateway({
      id: 'openai/gpt-4o-transcribe',
      name: 'GPT-4o Transcribe',
      type: 'transcription',
      pricing: { input: '0.0000025', output: '0.00001', audio_input_token_cost: '0.0000025' }
    }).pricing).toEqual({ input: 2.5, output: 10 })
  })
})

describe('BL-295 review: a connection that lists no price never shows another host\'s', () => {
  const openRouter = (provider: string, name: string, pricing: any) =>
    batchEntry('openrouter', provider, name, {
      id: `${provider}/${name}`,
      source: 'openrouter',
      transport: 'openrouter',
      upstreamProvider: 'openrouter',
      pricing
    })
  const aa = (slug: string, input?: number, output?: number) =>
    input === undefined ? { slug } : { slug, pricing: { price_1m_input_tokens: input, price_1m_output_tokens: output } }
  const assembleAll = (gateway: any[], openRouterEntries: any[], direct: Record<string, any[]>, aaEntries: Record<string, any>) =>
    _assembleCatalogModelsForTest({
      gatewayEntries: gateway,
      openRouterEntries,
      directEntriesByProvider: direct,
      aaMap: new Map(Object.entries(aaEntries))
    }).models
  const variantPrice = (models: any[], id: string, connection: string) =>
    models.find((model) => model.id === id)?.idVariants?.[connection]?.pricing

  it('keeps Qwen Cloud\'s own price (Artificial Analysis\'s) on an OpenRouter-based row, or Unknown', () => {
    // Measured 2026-09-27: OpenRouter $0.78/$3.9 for qwen3-max; AA gives Alibaba's $1.2/$6.
    const models = assembleAll(
      [],
      [openRouter('qwen', 'qwen3-max', { input: 0.78, output: 3.9 }), openRouter('qwen', 'qwen-plus', { input: 0.26, output: 0.78 })],
      { qwencloud: [batchEntry('direct:qwencloud', 'qwen', 'qwen3-max'), batchEntry('direct:qwencloud', 'qwen', 'qwen-plus')] },
      { qwen3max: aa('qwen3-max', 1.2, 6), qwenplus: aa('qwen-plus') }
    )
    expect(models.find((model) => model.id === 'qwen/qwen3-max')?.pricing).toEqual({ input: 0.78, output: 3.9 })
    expect(variantPrice(models, 'qwen/qwen3-max', 'direct:qwencloud')).toEqual({ input: 1.2, output: 6 })
    expect(variantPrice(models, 'qwen/qwen-plus', 'direct:qwencloud')).toEqual({})
  })

  it('gives a host that is not the maker its own price on a gateway row; the maker\'s own API takes the gateway\'s', () => {
    // deepseek-v4-pro: the gateway $0.66/$1.98 (DeepSeek's list price), AA $1.32/$3.96.
    const models = assembleAll(
      [batchEntry('vercel-gateway', 'deepseek', 'deepseek-v4-pro', { pricing: { input: 0.66, output: 1.98, cachedInput: 0.022 } })],
      [],
      {
        deepseek: [batchEntry('direct:deepseek', 'deepseek', 'deepseek-v4-pro')],
        qwencloud: [batchEntry('direct:qwencloud', 'deepseek', 'deepseek-v4-pro')]
      },
      { deepseekv4pro: aa('deepseek-v4-pro', 1.32, 3.96) }
    )
    expect(variantPrice(models, 'deepseek/deepseek-v4-pro', 'direct:qwencloud')).toEqual({ input: 1.32, output: 3.96 })
    expect(models[0].idVariants?.['direct:deepseek']).not.toHaveProperty('pricing')
  })

  it('never lends the gateway\'s cached price to a host whose own price matches the rest', () => {
    const models = assembleAll(
      [batchEntry('vercel-gateway', 'moonshotai', 'kimi-k3', { pricing: { input: 3, output: 15, cachedInput: 0.3 } })],
      [],
      { qwencloud: [batchEntry('direct:qwencloud', 'moonshotai', 'kimi-k3')] },
      { kimik3: aa('kimi-k3', 3, 15) }
    )
    expect(variantPrice(models, 'moonshotai/kimi-k3', 'direct:qwencloud')).toEqual({ input: 3, output: 15 })
  })

  it('never lends the gateway\'s cached price to a non-maker host that lists no cached price of its own', () => {
    // Measured 2026-09-27: Together lists zai-org/GLM-4.6 at $0.6/$2.2 with no
    // cached price; the gateway row carries the maker's own $0.11 cached price.
    const models = assembleAll(
      [batchEntry('vercel-gateway', 'zai', 'glm-4.6', { pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 } })],
      [],
      { togetherai: [batchEntry('direct:togetherai', 'zai-org', 'glm-4.6', { pricing: { input: 0.6, output: 2.2 } })] },
      {}
    )
    expect(variantPrice(models, 'zai/glm-4.6', 'direct:togetherai')).toEqual({ input: 0.6, output: 2.2 })
    // The fail-safe rebuild path stores Together's own price, not the borrowed one.
    const row = models.find((model) => model.id === 'zai/glm-4.6') as any
    const rebuild = (snapshot: any, connectionId: any) =>
      _buildFallbackEntriesFromExistingForTest({ existing: { models: [snapshot] }, connectionId, source: 'direct', transport: 'direct' })[0]
    expect(rebuild(row, 'direct:togetherai').pricing).toEqual({ input: 0.6, output: 2.2 })
  })

  it('treats the maker\'s own API as a host like any other off a gateway row', () => {
    // Qwen Cloud is Alibaba's own API, but OpenRouter's price is not Alibaba's.
    const models = assembleAll(
      [],
      [openRouter('qwen', 'qwen3-max', { input: 0.78, output: 3.9 })],
      { qwencloud: [batchEntry('direct:qwencloud', 'qwen', 'qwen3-max')] },
      { qwen3max: aa('qwen3-max') }
    )
    expect(variantPrice(models, 'qwen/qwen3-max', 'direct:qwencloud')).toEqual({})
  })

  it('rebuilds each connection with the price it was published with', () => {
    const glm = (pricing: any) => batchEntry('vercel-gateway', 'zai', 'glm-5.3', { pricing })
    const [row] = assembleAll(
      [glm({ input: 0.6, output: 2.2 })],
      [],
      {
        // The maker's own API, a host AA prices like the row, and a host AA names no price for.
        zai: [batchEntry('direct:zai', 'zai', 'glm-5.3')],
        togetherai: [batchEntry('direct:togetherai', 'zai-org', 'glm-5.3')],
        qwencloud: [batchEntry('direct:qwencloud', 'zai', 'glm-5.3')]
      },
      { glm53: aa('glm-5-3', 0.6, 2.2) }
    )
    const [unknownRow] = assembleAll([glm({ input: 0.6, output: 2.2 })], [], { qwencloud: [batchEntry('direct:qwencloud', 'zai', 'glm-5.3')] }, { glm53: aa('glm-5-3') })
    expect(row.idVariants?.['direct:zai']).not.toHaveProperty('pricing')
    expect(row.idVariants?.['direct:togetherai']).not.toHaveProperty('pricing')
    expect(unknownRow.idVariants?.['direct:qwencloud']?.pricing).toEqual({})

    const rebuild = (snapshot: any, connectionId: any) =>
      _buildFallbackEntriesFromExistingForTest({ existing: { models: [snapshot] }, connectionId, source: 'direct', transport: 'direct' })[0]
    // The gateway's price moves; nothing else is fetched live.
    const [next] = assembleAll(
      [glm({ input: 0.5, output: 2 })],
      [],
      { zai: [rebuild(row, 'direct:zai')], togetherai: [rebuild(row, 'direct:togetherai')] },
      { glm53: aa('glm-5-3') }
    )
    // The maker's own API follows the gateway; the host keeps the price it had.
    expect(next.idVariants?.['direct:zai']).not.toHaveProperty('pricing')
    expect(next.idVariants?.['direct:togetherai']?.pricing).toEqual({ input: 0.6, output: 2.2 })
    // Unknown stays Unknown, and a replay publishes the same prices.
    expect(rebuild(unknownRow, 'direct:qwencloud').pricing).toEqual({})
    const replayed: any = buildCatalogFromSnapshot({ models: [row] } as any).payload.models[0]
    expect(replayed.idVariants['direct:zai']).not.toHaveProperty('pricing')
    expect(replayed.idVariants['direct:togetherai']).not.toHaveProperty('pricing')
    expect(replayed.pricing).toEqual({ input: 0.6, output: 2.2 })
  })
})

describe('BL-572 a merged row never gives every connection one member\'s limits', () => {
  // Artificial Analysis's slug joins DeepInfra's zai-org row to the gateway's zai row; it lists no limits.
  const aa = { glm53: { slug: 'glm-5-3' } }
  const rebuild = (snapshot: any, connectionId: any, source: any = 'direct', transport: any = 'direct') =>
    _buildFallbackEntriesFromExistingForTest({ existing: { models: [snapshot] }, connectionId, source, transport })[0]

  it('leaves the row\'s limits unknown when its base lists none; a member keeps its own on its variant', () => {
    // The gateway lists no window or output cap (an image-era row); DeepInfra lists 131,072.
    const { models } = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3')],
      {
        deepinfra: [batchEntry('direct:deepinfra', 'zai-org', 'GLM-5.3', { id: 'zai-org/GLM-5.3', contextWindow: 131_072 })],
        zai: [batchEntry('direct:zai', 'zai', 'glm-5.3')]
      },
      aa
    )
    expect(models).toHaveLength(1)
    const [row] = models
    expect(row.contextWindow).toBeUndefined()
    expect(row.maxOutputTokens).toBeUndefined()
    expect(row.idVariants?.['direct:deepinfra']?.limits).toEqual({ contextWindow: 131_072, maxOutputTokens: null })
    // The gateway and Z.ai listed none: what a preset for them reads is unknown, never DeepInfra's.
    for (const connection of ['vercel-gateway', 'direct:zai']) {
      expect(resolveCatalogConnectionLimits(row, connection)).toEqual({
        contextWindow: undefined,
        maxOutputTokens: undefined,
        perConnection: false
      })
    }
    expect(resolveCatalogConnectionLimits(row, 'direct:deepinfra')).toMatchObject({ contextWindow: 131_072, perConnection: true })
  })

  it('never borrows a member\'s output cap for a base that lists only a window', () => {
    const { models } = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3', { contextWindow: 262_144 })],
      { deepinfra: [batchEntry('direct:deepinfra', 'zai-org', 'GLM-5.3', { id: 'zai-org/GLM-5.3', contextWindow: 262_144, maxOutputTokens: 16_384 })] },
      aa
    )
    const [row] = models
    expect(row.contextWindow).toBe(262_144)
    expect(row.maxOutputTokens).toBeUndefined()
    expect(row.idVariants?.['direct:deepinfra']?.limits).toEqual({ contextWindow: 262_144, maxOutputTokens: 16_384 })
  })

  it('still gives the row its base\'s own limits (the control)', () => {
    const { models } = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3', { contextWindow: 262_144, maxOutputTokens: 65_536 })],
      { zai: [batchEntry('direct:zai', 'zai', 'glm-5.3')] }
    )
    expect(models[0]).toMatchObject({ contextWindow: 262_144, maxOutputTokens: 65_536 })
    expect(models[0].idVariants?.['direct:zai']).not.toHaveProperty('limits')
  })

  it('rebuilds a connection that took the row\'s limits with none, so it follows the row instead of keeping today\'s', () => {
    const gateway = (contextWindow: number, maxOutputTokens: number) =>
      batchEntry('vercel-gateway', 'zai', 'glm-5.3', {
        contextWindow,
        maxOutputTokens,
        features: { streaming: true, tools: true, vision: false, maxTokens: contextWindow, longContext: true }
      })
    const [row] = assembleBatch([gateway(262_144, 65_536)], { zai: [batchEntry('direct:zai', 'zai', 'glm-5.3')] }).models

    // Z.ai's own list names no limits, so the row's are not Z.ai's own.
    const zai = rebuild(row, 'direct:zai')
    expect(zai.contextWindow).toBeUndefined()
    expect(zai.maxOutputTokens).toBeUndefined()
    expect(zai.features).not.toHaveProperty('maxTokens')
    // The base's own limits are the row's (the control).
    const base = rebuild(row, 'vercel-gateway', 'vercel', 'vercel-gateway')
    expect(base).toMatchObject({ contextWindow: 262_144, maxOutputTokens: 65_536 })
    expect(base.features).toMatchObject({ maxTokens: 262_144, longContext: true })

    // The gateway's limits move while Z.ai's source is down: Z.ai follows the
    // row, as it did when published, and keeps no stale limits of "its own".
    const [next] = assembleBatch([gateway(300_000, 80_000)], { zai: [zai] }).models
    expect(next).toMatchObject({ contextWindow: 300_000, maxOutputTokens: 80_000 })
    expect(next.idVariants?.['direct:zai']).not.toHaveProperty('limits')

    // A replay publishes the same row and variants.
    const replayed: any = buildCatalogFromSnapshot({ models: [row] } as any).payload.models[0]
    expect(replayed).toMatchObject({ contextWindow: 262_144, maxOutputTokens: 65_536 })
    expect(replayed.idVariants['direct:zai']).not.toHaveProperty('limits')
  })

  it('rebuilds a row that names no base connection with its numbers, as before (an older snapshot)', () => {
    const [row] = assembleBatch(
      [batchEntry('vercel-gateway', 'zai', 'glm-5.3', { contextWindow: 262_144, maxOutputTokens: 65_536 })],
      { zai: [batchEntry('direct:zai', 'zai', 'glm-5.3')] }
    ).models
    const { connectionId: _connectionId, ...older } = row as any
    expect(rebuild(older, 'direct:zai')).toMatchObject({ contextWindow: 262_144, maxOutputTokens: 65_536 })
  })
})
