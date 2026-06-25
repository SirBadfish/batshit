import { describe, expect, it } from 'vitest'
import { resolveCatalogIds, resolveModelIds } from './modelIdResolver'

describe('modelIdResolver', () => {
  describe('resolveModelIds', () => {
    it('returns direct provider ids without prefixing model', () => {
      const resolved = resolveModelIds({
        developerId: 'openai',
        modelId: 'gpt-5.2',
        connection: { type: 'direct', service: 'openai' }
      })

      expect(resolved).toEqual({
        providerId: 'openai',
        developerId: 'openai',
        modelId: 'gpt-5.2',
        effectiveModelId: 'gpt-5.2'
      })
    })

    it('prefixes developer/model for openrouter', () => {
      const resolved = resolveModelIds({
        developerId: 'openai',
        modelId: 'gpt-5.2',
        connection: { type: 'openrouter', service: 'openrouter' }
      })

      expect(resolved).toEqual({
        providerId: 'openrouter',
        developerId: 'openai',
        modelId: 'gpt-5.2',
        effectiveModelId: 'openai/gpt-5.2'
      })
    })

    it('prefixes developer/model for vercel gateway', () => {
      const resolved = resolveModelIds({
        developerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        connection: { type: 'vercel-gateway', service: 'vercel' }
      })

      expect(resolved).toEqual({
        providerId: 'vercel-gateway',
        developerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        effectiveModelId: 'anthropic/claude-sonnet-4-5'
      })
    })

    it('normalizes developer/model modelId inputs', () => {
      const resolved = resolveModelIds({
        developerId: null,
        modelId: 'openai/gpt-5.2',
        connection: { type: 'openrouter', service: 'openrouter' }
      })

      expect(resolved).toEqual({
        providerId: 'openrouter',
        developerId: 'openai',
        modelId: 'gpt-5.2',
        effectiveModelId: 'openai/gpt-5.2'
      })
    })

    it('preserves owner-prefixed OpenRouter model ids from OpenRouter-labeled presets', () => {
      const resolved = resolveModelIds({
        developerId: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4.5',
        connection: { type: 'openrouter', service: 'openrouter' }
      })

      expect(resolved).toEqual({
        providerId: 'openrouter',
        developerId: 'anthropic',
        modelId: 'claude-sonnet-4.5',
        effectiveModelId: 'anthropic/claude-sonnet-4.5'
      })
    })

    it('prefixes owner/model for direct replicate models', () => {
      const resolved = resolveModelIds({
        developerId: 'black-forest-labs',
        modelId: 'flux-schnell',
        connection: { type: 'direct', service: 'replicate' }
      })

      expect(resolved).toEqual({
        providerId: 'replicate',
        developerId: 'black-forest-labs',
        modelId: 'flux-schnell',
        effectiveModelId: 'black-forest-labs/flux-schnell'
      })
    })

    it('prefixes fal-ai for direct fal models', () => {
      const resolved = resolveModelIds({
        developerId: 'hunyuan-image',
        modelId: 'v3/text-to-image',
        connection: { type: 'direct', service: 'fal' }
      })

      expect(resolved).toEqual({
        providerId: 'fal',
        developerId: 'hunyuan-image',
        modelId: 'v3/text-to-image',
        effectiveModelId: 'fal-ai/hunyuan-image/v3/text-to-image'
      })
    })

    it('normalizes fal-ai prefixed model ids', () => {
      const resolved = resolveModelIds({
        developerId: 'fal',
        modelId: 'fal-ai/hunyuan-image/v3/text-to-image',
        connection: { type: 'direct', service: 'fal' }
      })

      expect(resolved).toEqual({
        providerId: 'fal',
        developerId: 'hunyuan-image',
        modelId: 'v3/text-to-image',
        effectiveModelId: 'fal-ai/hunyuan-image/v3/text-to-image'
      })
    })

    it('rewrites replicate presets that stored provider as replicate', () => {
      const resolved = resolveModelIds({
        developerId: 'replicate',
        modelId: 'black-forest-labs/flux-schnell',
        connection: { type: 'direct', service: 'replicate' }
      })

      expect(resolved).toEqual({
        providerId: 'replicate',
        developerId: 'black-forest-labs',
        modelId: 'flux-schnell',
        effectiveModelId: 'black-forest-labs/flux-schnell'
      })
    })

    it('prefixes owner/model for direct multi-tenant providers', () => {
      const resolved = resolveModelIds({
        developerId: 'togetherai',
        modelId: 'meta-llama/llama-3.2-11b-instruct',
        connection: { type: 'direct', service: 'togetherai' }
      })

      expect(resolved).toEqual({
        providerId: 'togetherai',
        developerId: 'meta-llama',
        modelId: 'llama-3.2-11b-instruct',
        effectiveModelId: 'meta-llama/llama-3.2-11b-instruct'
      })
    })

    it('prefixes owner/model for direct groq models', () => {
      const resolved = resolveModelIds({
        developerId: 'openai',
        modelId: 'gpt-oss-120b',
        connection: { type: 'direct', service: 'groq' }
      })

      expect(resolved).toEqual({
        providerId: 'groq',
        developerId: 'openai',
        modelId: 'gpt-oss-120b',
        effectiveModelId: 'openai/gpt-oss-120b'
      })
    })

    it('keeps bare ids for groq-owned direct models', () => {
      const resolved = resolveModelIds({
        developerId: 'groq',
        modelId: 'whisper-large-v3',
        connection: { type: 'direct', service: 'groq' }
      })

      expect(resolved).toEqual({
        providerId: 'groq',
        developerId: 'groq',
        modelId: 'whisper-large-v3',
        effectiveModelId: 'whisper-large-v3'
      })
    })

    it('prefixes developer/model for custom providers when enabled', () => {
      const resolved = resolveModelIds({
        developerId: 'zai',
        modelId: 'glm-4.5',
        connection: { type: 'direct', service: 'custom_zai', useDeveloperPrefix: true }
      })

      expect(resolved).toEqual({
        providerId: 'custom_zai',
        developerId: 'zai',
        modelId: 'glm-4.5',
        effectiveModelId: 'zai/glm-4.5'
      })
    })

    it('preserves developer/model in modelId for custom providers when prefixing is disabled', () => {
      const resolved = resolveModelIds({
        developerId: 'zai',
        modelId: 'zai/glm-4.5',
        connection: { type: 'direct', service: 'custom_zai', useDeveloperPrefix: false }
      })

      expect(resolved).toEqual({
        providerId: 'custom_zai',
        developerId: 'zai',
        modelId: 'zai/glm-4.5',
        effectiveModelId: 'zai/glm-4.5'
      })
    })

    it('preserves developer prefix for local direct models with slashes', () => {
      const resolved = resolveModelIds({
        developerId: 'dmr',
        modelId: 'ai/qwen3-vl:latest',
        connection: { type: 'direct', service: 'dmr' }
      })

      expect(resolved).toEqual({
        providerId: 'dmr',
        developerId: 'ai',
        modelId: 'qwen3-vl:latest',
        effectiveModelId: 'ai/qwen3-vl:latest'
      })
    })
  })

  describe('resolveCatalogIds', () => {
    it('uses the selected connection variant when present', () => {
      const resolved = resolveCatalogIds({
        connectionId: 'openrouter',
        developerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        idVariants: {
          openrouter: {
            developerId: 'anthropic',
            modelId: 'claude-3-5-sonnet',
            effectiveId: 'anthropic/claude-3-5-sonnet',
            source: 'openrouter'
          }
        }
      })

      expect(resolved).toEqual({
        developerId: 'anthropic',
        modelId: 'claude-3-5-sonnet',
        effectiveModelId: 'anthropic/claude-3-5-sonnet',
        source: 'openrouter'
      })
    })

    it('ignores incompatible direct variants and falls back to base ids', () => {
      const resolved = resolveCatalogIds({
        connectionId: 'direct:anthropic',
        connection: {
          id: 'direct:anthropic',
          transport: 'direct',
          service: 'anthropic',
          providers: ['anthropic']
        },
        developerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        idVariants: {
          'direct:anthropic': {
            developerId: 'openai',
            modelId: 'gpt-5.2',
            effectiveId: 'gpt-5.2',
            source: 'direct'
          }
        }
      })

      expect(resolved).toEqual({
        developerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
        effectiveModelId: 'claude-sonnet-4-5'
      })
    })

    it('keeps multi-tenant direct variants for owner-prefixed providers', () => {
      const resolved = resolveCatalogIds({
        connectionId: 'direct:deepinfra',
        connection: {
          id: 'direct:deepinfra',
          transport: 'direct',
          service: 'deepinfra',
          providers: ['deepinfra']
        },
        developerId: 'deepinfra',
        modelId: 'meta-llama/llama-3.3-70b-instruct',
        idVariants: {
          'direct:deepinfra': {
            developerId: 'meta-llama',
            modelId: 'llama-3.3-70b-instruct',
            effectiveId: 'meta-llama/llama-3.3-70b-instruct',
            source: 'direct'
          }
        }
      })

      expect(resolved).toEqual({
        developerId: 'meta-llama',
        modelId: 'llama-3.3-70b-instruct',
        effectiveModelId: 'meta-llama/llama-3.3-70b-instruct',
        source: 'direct'
      })
    })

    it('keeps multi-tenant direct variants for groq owner-prefixed ids', () => {
      const resolved = resolveCatalogIds({
        connectionId: 'direct:groq',
        connection: {
          id: 'direct:groq',
          transport: 'direct',
          service: 'groq',
          providers: ['groq']
        },
        developerId: 'groq',
        modelId: 'openai/gpt-oss-120b',
        idVariants: {
          'direct:groq': {
            developerId: 'openai',
            modelId: 'gpt-oss-120b',
            effectiveId: 'openai/gpt-oss-120b',
            source: 'direct'
          }
        }
      })

      expect(resolved).toEqual({
        developerId: 'openai',
        modelId: 'gpt-oss-120b',
        effectiveModelId: 'openai/gpt-oss-120b',
        source: 'direct'
      })
    })

    it('keeps bare groq-owned catalog ids when no variant is present', () => {
      const resolved = resolveCatalogIds({
        connectionId: 'direct:groq',
        developerId: 'groq',
        modelId: 'whisper-large-v3'
      })

      expect(resolved).toEqual({
        developerId: 'groq',
        modelId: 'whisper-large-v3',
        effectiveModelId: 'whisper-large-v3'
      })
    })

    it('prefixes fal-ai for direct fal catalog selections when no variant is present', () => {
      const resolved = resolveCatalogIds({
        connectionId: 'direct:fal',
        developerId: 'hunyuan-image',
        modelId: 'v3/text-to-image'
      })

      expect(resolved).toEqual({
        developerId: 'hunyuan-image',
        modelId: 'v3/text-to-image',
        effectiveModelId: 'fal-ai/hunyuan-image/v3/text-to-image'
      })
    })
  })
})
