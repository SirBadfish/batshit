import { describe, expect, it } from 'vitest'
import {
  _buildSourceFallbackWarningForTest,
  _buildCatalogSyncDiffForTest,
  _getManualDirectModelsForTest,
  _mapOpenRouterModelToCatalogEntryForTest,
  _mergeDirectProviderEntriesForTest,
  _mergeCatalogEntriesForTest,
  _shouldUseFallbackForTest
} from './modelCatalogSync'

describe('modelCatalogSync merge', () => {
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
        features: { streaming: true, tools: true, vision: true, maxTokens: 200000 },
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
        features: { streaming: true, tools: true, vision: true, maxTokens: 200000 },
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
        features: { streaming: true, tools: true, vision: true, maxTokens: 200000, reasoning: true },
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
        features: { streaming: true, tools: false, vision: false, maxTokens: 0 },
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
      features: { streaming: true, tools: true, vision: false, maxTokens: 128000 },
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
    const merged = _mergeDirectProviderEntriesForTest(
      [
        { id: 'glm-4.7' },
        { id: 'glm-5.1' }
      ],
      curated
    )

    expect(merged.some((model) => model.id === 'glm-5.2')).toBe(true)
    expect(merged.find((model) => model.id === 'glm-4.7')?.displayName).toBe('GLM-4.7')
  })
})
