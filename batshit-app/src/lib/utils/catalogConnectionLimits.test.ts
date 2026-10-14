import { describe, expect, it } from 'vitest'
import { resolveCatalogConnectionLimits, resolveCatalogConnectionPricing } from './catalogConnectionLimits'

/** The merged row BL-68 publishes for Sonnet 4.5: gateway numbers, direct's own limits. */
const sonnet45 = {
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  idVariants: {
    'vercel-gateway': { developerId: 'anthropic', modelId: 'claude-sonnet-4.5', effectiveId: 'anthropic/claude-sonnet-4.5', source: 'vercel' as const },
    'direct:anthropic': {
      developerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      effectiveId: 'claude-sonnet-4-5-20250929',
      source: 'direct' as const,
      limits: { contextWindow: null, maxOutputTokens: null }
    }
  }
}

describe('BL-68 resolveCatalogConnectionLimits', () => {
  it('uses the connection\'s own limits when its variant carries them, unknown included', () => {
    expect(resolveCatalogConnectionLimits(sonnet45, 'direct:anthropic')).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
      perConnection: true
    })
  })

  it('never borrows the row\'s larger window for such a connection', () => {
    const limits = resolveCatalogConnectionLimits(
      {
        ...sonnet45,
        idVariants: {
          ...sonnet45.idVariants,
          'direct:anthropic': { ...sonnet45.idVariants['direct:anthropic'], limits: { contextWindow: 200_000, maxOutputTokens: 64_000 } }
        }
      },
      'direct:anthropic'
    )
    expect(limits).toEqual({ contextWindow: 200_000, maxOutputTokens: 64_000, perConnection: true })
  })

  it('uses the row\'s numbers for a connection without its own', () => {
    expect(resolveCatalogConnectionLimits(sonnet45, 'vercel-gateway')).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      perConnection: false
    })
    expect(resolveCatalogConnectionLimits(sonnet45, null).contextWindow).toBe(1_000_000)
  })

  it('treats a row window of 0 or less as unknown (BL-67)', () => {
    expect(resolveCatalogConnectionLimits({ contextWindow: 0, maxOutputTokens: -1 }, 'openrouter')).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
      perConnection: false
    })
  })
})

/** A merged GLM 5.3 row: the gateway's price, DeepInfra's own on its variant (BL-132). */
const glm53 = {
  pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 },
  idVariants: {
    'vercel-gateway': { developerId: 'zai', modelId: 'glm-5.3', effectiveId: 'zai/glm-5.3', source: 'vercel' as const },
    'direct:deepinfra': {
      developerId: 'zai-org',
      modelId: 'GLM-5.3',
      effectiveId: 'zai-org/GLM-5.3',
      source: 'direct' as const,
      pricing: { input: 0.45, output: 1.9 }
    }
  }
}

describe('BL-132 resolveCatalogConnectionPricing', () => {
  it('uses the connection\'s own price when its variant carries one, and never fills a gap from the row', () => {
    expect(resolveCatalogConnectionPricing(glm53, 'direct:deepinfra')).toEqual({
      pricing: { input: 0.45, output: 1.9 },
      perConnection: true
    })
  })

  it('uses the row\'s price for a connection without its own', () => {
    expect(resolveCatalogConnectionPricing(glm53, 'vercel-gateway')).toEqual({
      pricing: { input: 0.6, output: 2.2, cachedInput: 0.11 },
      perConnection: false
    })
    expect(resolveCatalogConnectionPricing(glm53, null).pricing).toEqual(glm53.pricing)
    expect(resolveCatalogConnectionPricing({}, 'openrouter')).toEqual({ pricing: undefined, perConnection: false })
  })
})
