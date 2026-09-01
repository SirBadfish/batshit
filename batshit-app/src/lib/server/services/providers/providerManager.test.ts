/**
 * Provider Management System Tests
 * Story 5.3 - Test Design Implementation
 *
 * Tests based on QA requirements:
 * - Provider registration with various configs
 * - Model selection and routing
 * - Fallback logic with loop prevention
 * - API key validation (without exposure)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ProviderManager } from './index'
import { env as testEnv } from '$env/dynamic/private'
import { createDeepInfra } from '@ai-sdk/deepinfra'
import { createXai } from '@ai-sdk/xai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createFireworks } from '@ai-sdk/fireworks'
import { createBaseten } from '@ai-sdk/baseten'
import { createCerebras } from '@ai-sdk/cerebras'
import { createCohere } from '@ai-sdk/cohere'
import { createAlibaba } from '@ai-sdk/alibaba'

// Mock environment variables for testing
vi.mock('$env/dynamic/private', () => ({
  env: {
    ANTHROPIC_API_KEY: 'sk-ant-placeholder',
    OPENAI_API_KEY: 'sk-placeholder',
    GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-key-123456789',
    GROQ_API_KEY: 'gsk_placeholder',
    MISTRAL_API_KEY: 'mistralplaceholder',
    XAI_API_KEY: 'xai-placeholder',
    DEEPSEEK_API_KEY: 'deepseek-placeholder',
    MINIMAX_API_KEY: 'minimax-placeholder',
    MIMO_API_KEY: 'mimo-placeholder',
    DASHSCOPE_API_KEY: 'dashscope-placeholder',
    QWEN_TOKEN_PLAN_API_KEY: 'qwen-token-plan-placeholder',
    ALIBABA_CLOUD_API_KEY: 'alibaba-placeholder',
    STEPFUN_API_KEY: 'stepfun-placeholder',
    OPENROUTER_API_KEY: 'sk-or-placeholder',
    ZAI_CODING_API_KEY: 'zai-coding-placeholder',
    DEEPINFRA_API_KEY: 'placeholder',
    DEEPINFRA_API_BASE_URL: 'https://api.deepinfra.com/v1/openai'
  }
}))

// Mock AI SDK providers
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn((modelId, options) => ({ modelId, provider: 'anthropic' })))
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((options?: { baseURL?: string }) => {
    const provider = options?.baseURL?.includes('openrouter') ? 'openrouter' : 'openai'
    const client = vi.fn((modelId) => ({
      modelId,
      provider,
      mode: 'responses'
    }))
    ;(client as any).chat = vi.fn((modelId) => ({
      modelId,
      provider,
      mode: 'chat'
    }))
    return client
  })
}))

vi.mock('@ai-sdk/google', () => {
  const factory = vi.fn(() => vi.fn((modelId, options) => ({ modelId, provider: 'google' })))
  return {
    createGoogle: factory,
    createGoogleGenerativeAI: factory
  }
})

vi.mock('@ai-sdk/groq', () => ({
  createGroq: vi.fn(() => vi.fn((modelId, options) => ({ modelId, provider: 'groq' })))
}))

vi.mock('@ai-sdk/mistral', () => ({
  createMistral: vi.fn(() => vi.fn((modelId, options) => ({ modelId, provider: 'mistral' })))
}))

vi.mock('@ai-sdk/deepinfra', () => ({
  createDeepInfra: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'deepinfra' })))
}))

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'xai' })))
}))

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'deepseek' })))
}))

vi.mock('@ai-sdk/togetherai', () => ({
  createTogetherAI: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'togetherai' })))
}))

vi.mock('@ai-sdk/fireworks', () => ({
  createFireworks: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'fireworks' })))
}))

vi.mock('@ai-sdk/baseten', () => ({
  createBaseten: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'baseten' })))
}))

vi.mock('@ai-sdk/cerebras', () => ({
  createCerebras: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'cerebras' })))
}))

vi.mock('@ai-sdk/cohere', () => ({
  createCohere: vi.fn(() => vi.fn((modelId) => ({ modelId, provider: 'cohere' })))
}))

vi.mock('@ai-sdk/alibaba', () => ({
  createAlibaba: vi.fn((options?: { baseURL?: string }) =>
    vi.fn((modelId) => ({
      modelId,
      provider: options?.baseURL?.includes('token-plan') ? 'qwen_token_plan' : 'qwencloud'
    }))
  )
}))

;(vi as any).mock(
  '@openrouter/ai-sdk-provider',
  () => ({
    createOpenRouter: vi.fn(() => {
      const client = vi.fn((modelId) => ({ modelId, provider: 'openrouter' }))
      ;(client as any).chat = vi.fn((modelId) => ({
        modelId,
        provider: 'openrouter'
      }))
      return client
    })
  }),
  { virtual: true }
)

describe('ProviderManager - Story 5.3 Tests', () => {
  let providerManager: ProviderManager

  beforeEach(() => {
    // Reset console mocks
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Create new instance for each test
    providerManager = new ProviderManager()
  })

  describe('AC1: Provider registration system', () => {
    it('5.3-UNIT-001: ProviderManager class instantiation', () => {
      expect(providerManager).toBeDefined()
      expect(providerManager).toBeInstanceOf(ProviderManager)
    })

    it('5.3-UNIT-002: Provider registry Map operations', () => {
      const providers = providerManager.getConfiguredProviders()
      expect(Array.isArray(providers)).toBe(true)
      expect(providers.length).toBeGreaterThan(0)
    })

    it('5.3-UNIT-003: Provider interface type validation', () => {
      const anthropicInfo = providerManager.getProviderInfo('anthropic')
      expect(anthropicInfo).toHaveProperty('models')
      expect(anthropicInfo).toHaveProperty('features')
      expect(anthropicInfo).toHaveProperty('displayName')
      expect(anthropicInfo).toHaveProperty('priority')
      expect(anthropicInfo).not.toHaveProperty('client') // Should not expose client function
    })
  })

  describe('AC2: Auto-discovery of configured providers', () => {
    it('5.3-UNIT-004: Environment variable detection', () => {
      const providers = providerManager.getConfiguredProviders()
      // All mocked env vars should result in configured providers
      expect(providers).toContain('anthropic')
      expect(providers).toContain('openai')
      expect(providers).toContain('google')
    })

    it('5.3-UNIT-005: API key validation logic (security)', () => {
      // Verify that console logs don't contain actual API keys
      const consoleLogCalls = (console.log as any).mock.calls
      const consoleWarnCalls = (console.warn as any).mock.calls

      for (const call of [...consoleLogCalls, ...consoleWarnCalls]) {
        const message = call.join(' ')
        expect(message).not.toContain('sk-ant-placeholder')
        expect(message).not.toContain('sk-placeholder')
        expect(message).not.toContain('test-google-key')
      }
    })

    it('5.3-UNIT-006: Provider availability check', () => {
      expect(providerManager.hasProvider('anthropic')).toBe(true)
      expect(providerManager.hasProvider('openai')).toBe(true)
      expect(providerManager.hasProvider('nonexistent')).toBe(false)
    })
  })

  describe('AC3: Model listing API', () => {
    it('5.3-UNIT-007: Model listing logic', () => {
      const models = providerManager.listAvailableModels()
      expect(Array.isArray(models)).toBe(true)
      expect(models.length).toBeGreaterThan(0)

      // Check model structure
      const firstModel = models[0]
      expect(firstModel).toHaveProperty('id')
      expect(firstModel).toHaveProperty('name')
      expect(firstModel).toHaveProperty('provider')
      expect(firstModel).toHaveProperty('features')
      expect(firstModel).toHaveProperty('displayName')
      expect(firstModel).toHaveProperty('category')
    })

    it('5.3-UNIT-008: Model sorting algorithm', () => {
      const models = providerManager.listAvailableModels()

      // Verify models are sorted by provider priority
      const anthropicIndex = models.findIndex((m) => m.provider === 'anthropic')
      const openaiIndex = models.findIndex((m) => m.provider === 'openai')
      const googleIndex = models.findIndex((m) => m.provider === 'google')

      if (anthropicIndex !== -1 && openaiIndex !== -1) {
        expect(anthropicIndex).toBeLessThan(openaiIndex)
      }
      if (openaiIndex !== -1 && googleIndex !== -1) {
        expect(openaiIndex).toBeLessThan(googleIndex)
      }
    })

    it('5.3-UNIT-009: Model metadata structure', () => {
      const models = providerManager.listAvailableModels()
      const claudeModel = models.find((m) => m.name.includes('claude'))

      expect(claudeModel).toBeDefined()
      expect(claudeModel?.features.streaming).toBe(true)
      expect(claudeModel?.features.tools).toBe(true)
      expect(claudeModel?.features.vision).toBe(true)
      expect(claudeModel?.features.maxTokens).toBeGreaterThan(0)
    })

    it('registers only current Z.ai Coding Plan models', () => {
      expect(providerManager.getProviderInfo('zai_coding')?.models).toEqual([
        'glm-5.3',
        'glm-5.3-flash'
      ])
    })
  })

  describe('AC5: Fallback handling', () => {
    it('5.3-UNIT-012: Fallback provider selection', () => {
      // Try to get a non-existent model
      const model = providerManager.getModel('nonexistent-model', {
        allowAutoFallback: true
      })

      // Should return a model from fallback provider (anthropic is priority 1)
      expect(model).toBeDefined()
      expect(model).toHaveProperty('modelId')
      expect(model).toHaveProperty('provider')
    })

    it('5.3-UNIT-013: Fallback chain logic', () => {
      // Test fallback with specific provider request
      const model = providerManager.getModel('invalid-provider/invalid-model', {
        allowAutoFallback: true
      })

      // Should fallback gracefully
      expect(model).toBeDefined()

      // Verify console.warn was called for fallback
      const warnCalls = (console.warn as any).mock.calls
      expect(warnCalls.some((call: any[]) => call[0].includes('Using fallback'))).toBe(true)
    })

    it('5.3-UNIT-015: Infinite loop prevention', () => {
      const originalEnv = { ...testEnv }

      try {
        Object.keys(originalEnv).forEach((key) => {
          delete (testEnv as any)[key]
        })

        const emptyManager = new ProviderManager()

        expect(() => {
          emptyManager.getModel('any-model')
        }).toThrow('No available provider')
      } finally {
        Object.assign(testEnv, originalEnv)
      }
    })
  })

  describe('AC6: Support for 5+ providers', () => {
    it('5.3-UNIT-016: Anthropic provider registration', () => {
      expect(providerManager.hasProvider('anthropic')).toBe(true)
      const info = providerManager.getProviderInfo('anthropic')
      expect(info?.models.length).toBeGreaterThan(0)
    })

    it('5.3-UNIT-017: OpenAI provider registration', () => {
      expect(providerManager.hasProvider('openai')).toBe(true)
      const info = providerManager.getProviderInfo('openai')
      expect(info?.models.length).toBeGreaterThan(0)
    })

    it('5.3-UNIT-018: Google provider registration', () => {
      expect(providerManager.hasProvider('google')).toBe(true)
      const info = providerManager.getProviderInfo('google')
      expect(info?.models.length).toBeGreaterThan(0)
    })

    it('5.3-UNIT-019: Mistral provider registration', () => {
      expect(providerManager.hasProvider('mistral')).toBe(true)
      const info = providerManager.getProviderInfo('mistral')
      expect(info?.models.length).toBeGreaterThan(0)
    })

    it('5.3-UNIT-020: Groq provider registration', () => {
      expect(providerManager.hasProvider('groq')).toBe(true)
      const info = providerManager.getProviderInfo('groq')
      expect(info?.models.length).toBeGreaterThan(0)
    })

    it('preserves Groq owner-prefixed model IDs at the final provider handoff', () => {
      const model = providerManager.getModel('openai/gpt-oss-120b', {
        transport: 'direct',
        service: 'groq'
      })

      expect(model).toMatchObject({
        modelId: 'openai/gpt-oss-120b',
        provider: 'groq'
      })
    })

    it('5.3-UNIT-021: OpenRouter provider registration and routing', () => {
      expect(providerManager.hasProvider('openrouter')).toBe(true)
      const info = providerManager.getProviderInfo('openrouter')
      expect(info?.models.length).toBeGreaterThan(0)

      const model = providerManager.getModel('anthropic/claude-sonnet-4.5', {
        transport: 'openrouter',
        service: 'openrouter'
      })

      expect(model).toMatchObject({
        modelId: 'anthropic/claude-sonnet-4.5',
        provider: 'openrouter'
      })
    })

    it('registers DeepInfra with its dedicated AI SDK provider and preserves namespaced model IDs', () => {
      expect(providerManager.hasProvider('deepinfra')).toBe(true)
      expect(createDeepInfra).toHaveBeenCalledWith({
        apiKey: 'placeholder',
        baseURL: 'https://api.deepinfra.com/v1'
      })

      const model = providerManager.getModel('zai-org/GLM-5.3-Flash', {
        transport: 'direct',
        service: 'deepinfra'
      })
      expect(model).toMatchObject({
        modelId: 'zai-org/GLM-5.3-Flash',
        provider: 'deepinfra'
      })
    })

    it('registers new OpenAI-compatible direct model providers', () => {
      expect(providerManager.hasProvider('minimax')).toBe(true)
      expect(providerManager.hasProvider('mimo')).toBe(true)
      expect(providerManager.hasProvider('qwencloud')).toBe(true)
      expect(providerManager.hasProvider('qwen_token_plan')).toBe(true)
      expect(providerManager.hasProvider('alibaba')).toBe(true)
      expect(providerManager.hasProvider('stepfun')).toBe(true)

      expect(providerManager.getProviderInfo('minimax')?.models).toContain('MiniMax-M3')
      expect(providerManager.getProviderInfo('mimo')?.models).toContain('mimo-v2.5-pro')
      expect(providerManager.getProviderInfo('alibaba')?.models).toContain('qwen3-max')
      expect(providerManager.getProviderInfo('stepfun')?.models).toContain('step-3.7-flash')

      expect(
        providerManager.getModel('qwen-plus', {
          transport: 'direct',
          service: 'qwencloud'
        })
      ).toMatchObject({ modelId: 'qwen-plus', provider: 'qwencloud' })
      expect(createAlibaba).toHaveBeenCalledWith({
        apiKey: 'dashscope-placeholder',
        baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
      })

      expect(
        providerManager.getModel('qwen3.8-max', {
          transport: 'direct',
          service: 'qwen_token_plan'
        })
      ).toMatchObject({ modelId: 'qwen3.8-max', provider: 'qwen_token_plan' })
      expect(createAlibaba).toHaveBeenCalledWith({
        apiKey: 'qwen-token-plan-placeholder',
        baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
      })

      const minimaxModel = providerManager.getModel('MiniMax-M3', {
        transport: 'direct',
        service: 'minimax'
      })
      expect(minimaxModel).toMatchObject({
        modelId: 'MiniMax-M3',
        mode: 'chat'
      })
    })

    it('honors the advanced Qwen Token Plan base URL override', () => {
      const originalBaseUrl = testEnv.QWEN_TOKEN_PLAN_API_BASE_URL
      testEnv.QWEN_TOKEN_PLAN_API_BASE_URL = 'https://token-plan.example.test/compatible-mode/v1'
      vi.mocked(createAlibaba).mockClear()

      try {
        new ProviderManager()

        expect(createAlibaba).toHaveBeenCalledWith({
          apiKey: 'qwen-token-plan-placeholder',
          baseURL: 'https://token-plan.example.test/compatible-mode/v1'
        })
      } finally {
        if (originalBaseUrl === undefined) {
          delete testEnv.QWEN_TOKEN_PLAN_API_BASE_URL
        } else {
          testEnv.QWEN_TOKEN_PLAN_API_BASE_URL = originalBaseUrl
        }
      }
    })

    it('uses dedicated AI SDK providers for supported direct model services', () => {
      const compatibleManager = new ProviderManager({
        apiKeys: {
          togetherai: 'together-placeholder',
          fireworks: 'fireworks-placeholder',
          baseten: 'baseten-placeholder',
          cerebras: 'cerebras-placeholder',
          cohere: 'cohere-placeholder'
        }
      })

      for (const [service, modelId, provider] of [
        ['togetherai', 'zai-org/GLM-5.3'],
        ['fireworks', 'accounts/fireworks/models/kimi-k3-instruct'],
        ['baseten', 'openai/gpt-oss-120b'],
        ['cerebras', 'gpt-oss-120b'],
        ['cohere', 'command-a-plus']
      ].map(([service, modelId]) => [service, modelId, service]) as Array<
        readonly [string, string, string]
      >) {
        expect(
          compatibleManager.getModel(modelId, {
            transport: 'direct',
            service
          })
        ).toMatchObject({ modelId, provider })
      }

      expect(createTogetherAI).toHaveBeenCalledWith({
        apiKey: 'together-placeholder',
        baseURL: undefined
      })
      expect(createFireworks).toHaveBeenCalledWith({
        apiKey: 'fireworks-placeholder',
        baseURL: undefined
      })
      expect(createBaseten).toHaveBeenCalledWith({
        apiKey: 'baseten-placeholder',
        baseURL: undefined
      })
      expect(createCerebras).toHaveBeenCalledWith({
        apiKey: 'cerebras-placeholder',
        baseURL: undefined
      })
      expect(createCohere).toHaveBeenCalledWith({
        apiKey: 'cohere-placeholder',
        baseURL: undefined
      })
    })

    it('uses dedicated AI SDK providers for xAI and DeepSeek', () => {
      expect(createXai).toHaveBeenCalledWith({
        apiKey: 'xai-placeholder',
        baseURL: undefined
      })
      expect(createDeepSeek).toHaveBeenCalledWith({
        apiKey: 'deepseek-placeholder',
        baseURL: undefined
      })

      expect(
        providerManager.getModel('grok-4.3', {
          transport: 'direct',
          service: 'xai'
        })
      ).toMatchObject({ modelId: 'grok-4.3', provider: 'xai' })
      expect(
        providerManager.getModel('deepseek-chat', {
          transport: 'direct',
          service: 'deepseek'
        })
      ).toMatchObject({ modelId: 'deepseek-chat', provider: 'deepseek' })
    })

    it('5.3-INT-014: All 5+ providers active simultaneously', () => {
      const providers = providerManager.getConfiguredProviders()
      expect(providers.length).toBeGreaterThanOrEqual(5)

      // Verify each provider has distinct features
      for (const provider of providers) {
        const info = providerManager.getProviderInfo(provider)
        expect(info).toBeDefined()
        expect(info?.models.length).toBeGreaterThan(0)
        expect(info?.features).toBeDefined()
      }
    })
  })

  describe('Security Tests', () => {
    it('SEC-001: API keys never exposed in logs', () => {
      // Get all console calls
      const allCalls = [
        ...(console.log as any).mock.calls,
        ...(console.warn as any).mock.calls,
        ...(console.error as any).mock.calls
      ]

      // Check that no API keys appear in any logs
      for (const call of allCalls) {
        const message = JSON.stringify(call)
        expect(message).not.toMatch(/sk-[a-zA-Z0-9_-]+/)
        expect(message).not.toMatch(/gsk_[a-zA-Z0-9_-]+/)
        expect(message).not.toContain('API_KEY')
      }
    })

    it('SEC-002: Provider info does not expose sensitive data', () => {
      const providers = providerManager.getConfiguredProviders()

      for (const provider of providers) {
        const info = providerManager.getProviderInfo(provider)

        // Should not have client function (contains API key)
        expect(info).not.toHaveProperty('client')

        // Should only have safe metadata
        expect(info).toHaveProperty('models')
        expect(info).toHaveProperty('features')
        expect(info).toHaveProperty('displayName')
        expect(info).toHaveProperty('priority')
      }
    })
  })

  describe('Performance Tests', () => {
    it('PERF-001: Model listing performance', () => {
      const start = performance.now()
      const models = providerManager.listAvailableModels()
      const duration = performance.now() - start

      // Should complete within 100ms
      expect(duration).toBeLessThan(100)
      expect(models.length).toBeGreaterThan(0)
    })

    it('PERF-002: Provider initialization speed', () => {
      const start = performance.now()
      new ProviderManager()
      const duration = performance.now() - start

      // Should initialize within 50ms
      expect(duration).toBeLessThan(50)
    })
  })

  describe('Edge Cases', () => {
    it('Handles model name variations', () => {
      // Test various model name formats
      const variations = [
        'claude-sonnet-4-5-latest',
        'anthropic/claude-sonnet-4-5-latest',
        'gpt-5',
        'openai/gpt-5',
        'gemini-2.5-pro',
        'google/gemini-2.5-pro'
      ]

      for (const modelName of variations) {
        const model = providerManager.getModel(modelName)
        expect(model).toBeDefined()
        expect(model).toHaveProperty('modelId')
      }
    })

    it('Cache management works correctly', () => {
      // Get same model twice
      const model1 = providerManager.getModel('claude-sonnet-4-5-latest')
      const model2 = providerManager.getModel('claude-sonnet-4-5-latest')

      // Should return same cached instance
      expect(model1).toBe(model2)

      // Clear cache
      providerManager.clearCache()

      // Should get new instance
      const model3 = providerManager.getModel('claude-sonnet-4-5-latest')
      expect(model3).not.toBe(model1)
    })
  })
})
