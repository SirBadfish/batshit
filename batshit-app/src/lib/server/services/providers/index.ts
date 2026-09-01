/**
 * Provider Management System
 * Story 5.3: Comprehensive provider management for Vercel AI SDK
 * 
 * CRITICAL SECURITY: API keys must NEVER appear in logs or responses
 * CRITICAL REDIS: NO JSON.stringify before json.set, NO JSON.parse after json.get
 * 
 * This system provides:
 * - Dynamic provider registration based on environment variables
 * - Model selection with fallback chains
 * - Provider capability tracking
 * - Secure API key validation
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { logger } from '$lib/utils/logger'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogle } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createDeepInfra } from '@ai-sdk/deepinfra'
import { createXai } from '@ai-sdk/xai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createFireworks } from '@ai-sdk/fireworks'
import { createBaseten } from '@ai-sdk/baseten'
import { createCerebras } from '@ai-sdk/cerebras'
import { createCohere } from '@ai-sdk/cohere'
import { createAlibaba } from '@ai-sdk/alibaba'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { env } from '$env/dynamic/private'
import { createGateway, type LanguageModel } from 'ai'
import { apiKeyService } from '$lib/services/apiKey.server'
import { listCustomProvidersForRuntime } from '$lib/server/services/customProviders'
import type { CustomProviderRuntime } from '$lib/types/customProviders'
import type { LocalAiServerId, LocalAiServerSummary } from '$lib/types/localAi'
import {
  listLocalAiServers,
  resolveLocalAiRuntimeBaseUrl
} from '$lib/server/services/localAiServers'
import {
  QWEN_TOKEN_PLAN_OPENAI_BASE_URL,
  QWEN_TOKEN_PLAN_TEXT_MODELS
} from '$lib/server/constants/qwenTokenPlan'

/**
 * Provider configuration interface
 */
export interface AIProvider {
  client: (modelId: string) => LanguageModel
  models: string[]
  features: ProviderFeatures
  displayName: string
  priority: number // For fallback ordering
}

/**
 * Provider capability tracking
 */
export interface ProviderFeatures {
  streaming: boolean
  tools: boolean
  vision: boolean
  maxTokens: number
  cacheControl?: boolean
  reasoning?: boolean // For o1 models
  longContext?: boolean // For models with >128k context
  code?: boolean // For specialized code models
  fast?: boolean // For low-latency providers like Groq
}

/**
 * Model metadata for UI display
 */
export interface ModelInfo {
  id: string // Full model identifier (provider/model)
  name: string // Model name
  provider: string // Provider name
  features: ProviderFeatures
  displayName: string // User-friendly name
  category?: 'fast' | 'balanced' | 'powerful' | 'reasoning' | 'code'
}

export type ModelTransportOption = 'vercel-gateway' | 'direct' | 'openrouter'

export interface GetModelOptions {
  transport?: ModelTransportOption
  service?: string | null
  allowAutoFallback?: boolean
  fallbackModel?: {
    modelName: string
    transport?: ModelTransportOption
    service?: string | null
  }
}

export type KnownProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'groq'
  | 'xai'
  | 'deepseek'
  | 'moonshot'
  | 'minimax'
  | 'mimo'
  | 'qwencloud'
  | 'qwen_token_plan'
  | 'alibaba'
  | 'stepfun'
  | 'zai'
  | 'zai_coding'
  | 'openrouter'
  | 'fal'
  | 'luma'
  | 'replicate'
  | 'elevenlabs'
  | 'deepgram'
  | 'assemblyai'
  | 'cohere'
  | 'huggingface'
  | 'deepinfra'
  | 'togetherai'
  | 'fireworks'
  | 'baseten'
  | 'cerebras'
export type CustomProviderId = `custom_${string}`
export type ProviderId = KnownProviderId | CustomProviderId | LocalAiServerId

type ProviderApiKeys = Partial<Record<KnownProviderId, string>>

interface ProviderManagerOptions {
  apiKeys?: ProviderApiKeys
  gateway?: {
    apiKey?: string | null
    baseURL?: string | null
  }
  customProviders?: CustomProviderRuntime[]
  localProviders?: LocalAiServerSummary[]
}

type ProviderAvailability = {
  hasKey: boolean
  source: 'user' | 'env' | null
}

type GatewayAvailability = {
  hasKey: boolean
  source: 'user' | 'env' | null
}

export interface ProviderAccessResolution {
  apiKeys: ProviderApiKeys
  availability: Record<KnownProviderId, ProviderAvailability>
  gateway: {
    apiKey?: string | null
    baseURL?: string | null
    availability: GatewayAvailability
  }
}

function normalizeDeepInfraBaseURL(baseURL?: string | null) {
  const normalized = (baseURL || 'https://api.deepinfra.com/v1').trim().replace(/\/+$/, '')
  return normalized.endsWith('/openai')
    ? normalized.slice(0, -'/openai'.length)
    : normalized
}

/**
 * Provider Manager - Central management for all AI providers
 * Implements Story 5.3 requirements with security and pattern compliance
 */
export class ProviderManager {
  private providers = new Map<string, AIProvider>()
  private modelCache = new Map<string, LanguageModel>()
  private fallbackChain: string[] = []
  private gatewayClient: ((modelId: string) => LanguageModel) | null = null
  private apiKeys: ProviderApiKeys
  private gatewayConfig: { apiKey: string | null; baseURL: string | null }
  private customProviders: CustomProviderRuntime[]
  private localProviders: LocalAiServerSummary[]

  constructor(options: ProviderManagerOptions = {}) {
    logger.debug('[ProviderManager] Initializing provider management system')
    this.apiKeys = options.apiKeys ?? {}
    this.gatewayConfig = {
      apiKey: options.gateway?.apiKey ?? null,
      baseURL: options.gateway?.baseURL ?? null
    }
    this.customProviders = options.customProviders ?? []
    this.localProviders = options.localProviders ?? []
    this.registerProviders()
    this.setupFallbackChain()
    this.setupGatewayClient()
  }

  static async createForUser(userId?: string | null) {
    const resolved = await resolveProviderAccess(userId)
    let customProviders: CustomProviderRuntime[] = []
    let localProviders: LocalAiServerSummary[] = []
    if (userId) {
      try {
        customProviders = await listCustomProvidersForRuntime(userId)
      } catch (error) {
        console.warn('[ProviderManager] Failed to load custom providers:', error)
      }
      try {
        localProviders = await listLocalAiServers(userId)
        localProviders = localProviders.filter((provider) => provider.enabled !== false)
      } catch (error) {
        console.warn('[ProviderManager] Failed to load local AI servers:', error)
      }
    }
    return new ProviderManager({
      apiKeys: resolved.apiKeys,
      gateway: {
        apiKey: resolved.gateway.apiKey ?? null,
        baseURL: resolved.gateway.baseURL ?? null
      },
      customProviders,
      localProviders
    })
  }

  /**
   * Register all available providers based on environment variables
   * SECURITY: Never log API keys, only validation status
   */
  private registerProviders() {
    let registeredCount = 0
    const registerOpenAICompatibleProvider = ({
      id,
      label,
      apiKey,
      baseURL,
      priority,
      apiMode = 'responses',
      models = [],
      allowNoKey = false
    }: {
      id: ProviderId
      label: string
      apiKey?: string | null
      baseURL?: string | null
      priority: number
      apiMode?: 'responses' | 'chat'
      models?: string[]
      allowNoKey?: boolean
    }) => {
      const resolvedKey = apiKey ?? (allowNoKey ? 'local-ai' : null)
      if (!resolvedKey) return
      if (!allowNoKey && !this.validateApiKey(resolvedKey, label)) return

      const client = createOpenAI({
        apiKey: resolvedKey,
        baseURL: baseURL ?? undefined
      })

      const clientFactory =
        apiMode === 'chat'
          ? (modelId: string) => client.chat(modelId)
          : (modelId: string) => client(modelId)

      this.providers.set(id, {
        client: clientFactory,
        models,
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000
        },
        displayName: label,
        priority
      })
      logger.debug(`[ProviderManager] ${label} ${allowNoKey ? 'configured' : 'API key validated'}`)
      registeredCount++
    }

    const registerCustomProvider = (provider: CustomProviderRuntime, priority: number) => {
      const apiKey = provider.apiKey
      if (!apiKey) return
      if (!this.validateApiKey(apiKey, 'Custom')) return

      const client = createOpenAI({
        apiKey,
        baseURL: provider.baseUrl ?? undefined,
        headers: provider.headers ?? undefined,
        name: provider.id
      })

      this.providers.set(provider.id, {
        client: (modelId: string) => client.chat(modelId),
        models: [],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000
        },
        displayName: provider.label,
        priority
      })
      logger.debug(`[ProviderManager] Custom provider ${provider.label} registered`)
      registeredCount++
    }

    const registerLocalProvider = (provider: LocalAiServerSummary, priority: number) => {
      const baseUrl = resolveLocalAiRuntimeBaseUrl(provider.baseUrl)?.replace(/\/+$/, '')
      const openaiPath = provider.openaiPath?.replace(/\/+$/, '')
      const openaiBaseUrl = baseUrl && openaiPath ? `${baseUrl}${openaiPath}` : baseUrl

      registerOpenAICompatibleProvider({
        id: provider.id,
        label: provider.label,
        apiKey: null,
        baseURL: openaiBaseUrl ?? undefined,
        priority,
        apiMode: 'chat',
        models: [],
        allowNoKey: true
      })
    }

    // Anthropic Provider (Priority 1)
    const anthropicKey = this.apiKeys.anthropic ?? env.ANTHROPIC_API_KEY
    if (anthropicKey && this.validateApiKey(anthropicKey, 'Anthropic')) {
      const anthropic = createAnthropic({
        apiKey: anthropicKey
      })
      this.providers.set('anthropic', {
        client: (modelId: string) => anthropic(modelId),
        models: [
          'claude-sonnet-4-5-latest',
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
          'claude-3-opus-20240229'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 200000,
          cacheControl: true,
          longContext: true
        },
        displayName: 'Anthropic',
        priority: 1
      })
      logger.debug('[ProviderManager] Anthropic API key validated')
      registeredCount++
    }

    // OpenAI Provider (Priority 2)
    const openaiKey = this.apiKeys.openai ?? env.OPENAI_API_KEY
    if (openaiKey && this.validateApiKey(openaiKey, 'OpenAI')) {
      // Create custom OpenAI instance with API key
      const openai = createOpenAI({
        apiKey: openaiKey
      })

      this.providers.set('openai', {
        client: (modelId: string) => openai(modelId),
        models: [
          'gpt-4.1',  // batshit's default GPT-4 model
          'gpt-5',
          'gpt-4o',
          'gpt-4o-mini',
          'o1-preview',
          'o1-mini'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000,
          reasoning: true
        },
        displayName: 'OpenAI',
        priority: 2
      })
      logger.debug('[ProviderManager] OpenAI API key validated')
      registeredCount++
    }

    // Google Provider (Priority 3)
    const googleKey = this.apiKeys.google ?? env.GOOGLE_GENERATIVE_AI_API_KEY
    if (googleKey && this.validateApiKey(googleKey, 'Google')) {
      const google = createGoogle({
        apiKey: googleKey
      })
      this.providers.set('google', {
        client: (modelId: string) => google(modelId),
        models: [
          'gemini-2.5-pro',
          'gemini-1.5-flash',
          'gemini-2.0-flash-exp'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 1000000,
          longContext: true
        },
        displayName: 'Google',
        priority: 3
      })
      logger.debug('[ProviderManager] Google API key validated')
      registeredCount++
    }

    // Mistral Provider (Priority 4)
    const mistralKey = this.apiKeys.mistral ?? env.MISTRAL_API_KEY
    if (mistralKey && this.validateApiKey(mistralKey, 'Mistral')) {
      const mistral = createMistral({
        apiKey: mistralKey
      })
      this.providers.set('mistral', {
        client: (modelId: string) => mistral(modelId),
        models: [
          'mistral-large-latest',
          'mistral-medium',
          'codestral-latest'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: false,
          maxTokens: 128000,
          code: true
        },
        displayName: 'Mistral',
        priority: 4
      })
      logger.debug('[ProviderManager] Mistral API key validated')
      registeredCount++
    }

    // Groq Provider (Priority 5)
    const groqKey = this.apiKeys.groq ?? env.GROQ_API_KEY
    if (groqKey && this.validateApiKey(groqKey, 'Groq')) {
      const groq = createGroq({
        apiKey: groqKey
      })
      this.providers.set('groq', {
        client: (modelId: string) => groq(modelId),
        models: [
          'llama-3.1-70b',
          'mixtral-8x7b-32768'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: false,
          maxTokens: 32768,
          fast: true
        },
        displayName: 'Groq',
        priority: 5
      })
      logger.debug('[ProviderManager] Groq API key validated')
      registeredCount++
    }

    // DeepSeek Provider (Priority 6)
    const deepseekKey = this.apiKeys.deepseek ?? env.DEEPSEEK_API_KEY
    if (deepseekKey && this.validateApiKey(deepseekKey, 'DeepSeek')) {
      const deepseek = createDeepSeek({
        apiKey: deepseekKey,
        baseURL: env.DEEPSEEK_API_BASE_URL || undefined
      })
      this.providers.set('deepseek', {
        client: (modelId: string) => deepseek(modelId),
        models: [
          'deepseek-chat',
          'deepseek-coder',
          'deepseek-reasoner',
          'deepseek-r1'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: false,
          maxTokens: 128000,
          reasoning: true,
          code: true
        },
        displayName: 'DeepSeek',
        priority: 6
      })
      logger.debug('[ProviderManager] DeepSeek API key validated')
      registeredCount++
    }

    const xaiKey = this.apiKeys.xai ?? env.XAI_API_KEY
    if (xaiKey && this.validateApiKey(xaiKey, 'xAI')) {
      const xai = createXai({
        apiKey: xaiKey,
        baseURL: env.XAI_API_BASE_URL || undefined
      })
      this.providers.set('xai', {
        client: (modelId: string) => xai(modelId),
        models: [
          'grok-4.3',
          'grok-4.20-non-reasoning',
          'grok-4.20-reasoning'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000,
          reasoning: true
        },
        displayName: 'xAI',
        priority: 7
      })
      logger.debug('[ProviderManager] xAI API key validated')
      registeredCount++
    }

    registerOpenAICompatibleProvider({
      id: 'zai',
      label: 'Z.ai',
      apiKey: this.apiKeys.zai ?? env.ZAI_API_KEY,
      baseURL: env.ZAI_API_BASE_URL || 'https://api.z.ai/api/paas/v4',
      priority: 8,
      apiMode: 'chat'
    })

    registerOpenAICompatibleProvider({
      id: 'zai_coding',
      label: 'Z.ai Coding Plan',
      apiKey: this.apiKeys.zai_coding ?? env.ZAI_CODING_API_KEY,
      baseURL: env.ZAI_CODING_API_BASE_URL || 'https://api.z.ai/api/coding/paas/v4',
      priority: 9,
      apiMode: 'chat',
      models: [
        'glm-5.2',
        'glm-5.1',
        'glm-5',
        'glm-5-turbo',
        'glm-4.7',
        'glm-4.6',
        'glm-4.5',
        'glm-4.5-air'
      ]
    })

    registerOpenAICompatibleProvider({
      id: 'moonshot',
      label: 'Moonshot AI',
      apiKey: this.apiKeys.moonshot ?? env.MOONSHOT_API_KEY,
      baseURL: env.MOONSHOT_API_BASE_URL || 'https://api.moonshot.ai/v1',
      priority: 10,
      apiMode: 'chat',
      models: ['kimi-k2.6', 'kimi-latest']
    })

    registerOpenAICompatibleProvider({
      id: 'minimax',
      label: 'MiniMax',
      apiKey: this.apiKeys.minimax ?? env.MINIMAX_API_KEY,
      baseURL: env.MINIMAX_API_BASE_URL || 'https://api.minimax.io/v1',
      priority: 11,
      apiMode: 'chat',
      models: [
        'MiniMax-M3',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed'
      ]
    })

    registerOpenAICompatibleProvider({
      id: 'mimo',
      label: 'MiMo',
      apiKey: this.apiKeys.mimo ?? env.MIMO_API_KEY,
      baseURL: env.MIMO_API_BASE_URL || 'https://api.xiaomimimo.com/v1',
      priority: 12,
      apiMode: 'chat',
      models: ['mimo-v2.5-pro', 'mimo-v2.5']
    })

    registerOpenAICompatibleProvider({
      id: 'alibaba',
      label: 'Alibaba Cloud Model Studio',
      apiKey: this.apiKeys.alibaba ?? env.ALIBABA_CLOUD_API_KEY,
      baseURL:
        env.ALIBABA_CLOUD_API_BASE_URL ??
        env.DASHSCOPE_API_BASE_URL ??
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      priority: 13,
      apiMode: 'chat',
      models: ['qwen3-max', 'qwen-plus', 'qwen-flash', 'qwen3-coder-plus', 'qwq-plus']
    })

    const qwenCloudKey = this.apiKeys.qwencloud ?? env.DASHSCOPE_API_KEY
    if (qwenCloudKey && this.validateApiKey(qwenCloudKey, 'Qwen Cloud')) {
      const qwenCloud = createAlibaba({
        apiKey: qwenCloudKey,
        baseURL:
          env.DASHSCOPE_API_BASE_URL ||
          'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
      })
      this.providers.set('qwencloud', {
        client: (modelId: string) => qwenCloud(modelId),
        models: ['qwen-plus'],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 1_000_000,
          reasoning: true,
          longContext: true,
          code: true
        },
        displayName: 'Qwen Cloud',
        priority: 13
      })
      logger.debug('[ProviderManager] Qwen Cloud API key validated')
      registeredCount++
    }

    const qwenTokenPlanKey = this.apiKeys.qwen_token_plan ?? env.QWEN_TOKEN_PLAN_API_KEY
    if (qwenTokenPlanKey && this.validateApiKey(qwenTokenPlanKey, 'Qwen Token Plan')) {
      const qwenTokenPlan = createAlibaba({
        apiKey: qwenTokenPlanKey,
        baseURL: env.QWEN_TOKEN_PLAN_API_BASE_URL || QWEN_TOKEN_PLAN_OPENAI_BASE_URL
      })
      this.providers.set('qwen_token_plan', {
        client: (modelId: string) => qwenTokenPlan(modelId),
        models: QWEN_TOKEN_PLAN_TEXT_MODELS.map((model) => model.id),
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 1_000_000,
          cacheControl: true,
          reasoning: true,
          longContext: true,
          code: true
        },
        displayName: 'Qwen Token Plan',
        priority: 14
      })
      logger.debug('[ProviderManager] Qwen Token Plan API key validated')
      registeredCount++
    }

    registerOpenAICompatibleProvider({
      id: 'stepfun',
      label: 'StepFun',
      apiKey: this.apiKeys.stepfun ?? env.STEPFUN_API_KEY ?? env.STEP_API_KEY,
      baseURL: env.STEPFUN_API_BASE_URL || 'https://api.stepfun.ai/v1',
      priority: 14,
      apiMode: 'chat',
      models: ['step-3.7-flash']
    })

    const openRouterKey = this.apiKeys.openrouter ?? env.OPENROUTER_API_KEY
    if (openRouterKey && this.validateApiKey(openRouterKey, 'OpenRouter')) {
      const openrouter = createOpenRouter({
        apiKey: openRouterKey,
        baseURL: env.OPENROUTER_API_BASE_URL || undefined,
        appName: env.OPENROUTER_APP_NAME || 'Batshit',
        appUrl: env.OPENROUTER_APP_URL || env.PUBLIC_BASE_URL || env.ORIGIN || undefined
      })
      this.providers.set('openrouter', {
        client: (modelId: string) => openrouter.chat(modelId),
        models: [
          'anthropic/claude-sonnet-4.5',
          'openai/gpt-5',
          'google/gemini-2.5-pro',
          'qwen/qwen3-coder'
        ],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000
        },
        displayName: 'OpenRouter',
        priority: 15
      })
      logger.debug('[ProviderManager] OpenRouter API key validated')
      registeredCount++
    }

    const deepInfraKey = this.apiKeys.deepinfra ?? env.DEEPINFRA_API_KEY
    if (deepInfraKey && this.validateApiKey(deepInfraKey, 'DeepInfra')) {
      const deepInfra = createDeepInfra({
        apiKey: deepInfraKey,
        baseURL: normalizeDeepInfraBaseURL(env.DEEPINFRA_API_BASE_URL)
      })
      this.providers.set('deepinfra', {
        client: (modelId: string) => deepInfra(modelId),
        models: ['zai-org/GLM-5.3-Flash'],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 1_048_576,
          cacheControl: true,
          reasoning: true,
          longContext: true,
          code: true
        },
        displayName: 'DeepInfra',
        priority: 16
      })
      logger.debug('[ProviderManager] DeepInfra API key validated')
      registeredCount++
    }

    const togetherKey = this.apiKeys.togetherai ?? env.TOGETHER_API_KEY
    if (togetherKey && this.validateApiKey(togetherKey, 'Together.ai')) {
      const together = createTogetherAI({
        apiKey: togetherKey,
        baseURL: env.TOGETHER_API_BASE_URL || undefined
      })
      this.providers.set('togetherai', {
        client: (modelId: string) => together(modelId),
        models: [],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000
        },
        displayName: 'Together.ai',
        priority: 17
      })
      logger.debug('[ProviderManager] Together.ai API key validated')
      registeredCount++
    }

    const fireworksKey = this.apiKeys.fireworks ?? env.FIREWORKS_API_KEY
    if (fireworksKey && this.validateApiKey(fireworksKey, 'Fireworks AI')) {
      const fireworks = createFireworks({
        apiKey: fireworksKey,
        baseURL: env.FIREWORKS_API_BASE_URL || undefined
      })
      this.providers.set('fireworks', {
        client: (modelId: string) => fireworks(modelId),
        models: [],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000
        },
        displayName: 'Fireworks AI',
        priority: 18
      })
      logger.debug('[ProviderManager] Fireworks AI API key validated')
      registeredCount++
    }

    const basetenKey = this.apiKeys.baseten ?? env.BASETEN_API_KEY
    if (basetenKey && this.validateApiKey(basetenKey, 'Baseten')) {
      const baseten = createBaseten({
        apiKey: basetenKey,
        baseURL: env.BASETEN_API_BASE_URL || undefined
      })
      this.providers.set('baseten', {
        client: (modelId: string) => baseten(modelId),
        models: [],
        features: {
          streaming: true,
          tools: true,
          vision: true,
          maxTokens: 128000
        },
        displayName: 'Baseten',
        priority: 19
      })
      logger.debug('[ProviderManager] Baseten API key validated')
      registeredCount++
    }

    const cerebrasKey = this.apiKeys.cerebras ?? env.CEREBRAS_API_KEY
    if (cerebrasKey && this.validateApiKey(cerebrasKey, 'Cerebras')) {
      const cerebras = createCerebras({
        apiKey: cerebrasKey,
        baseURL: env.CEREBRAS_API_BASE_URL || undefined
      })
      this.providers.set('cerebras', {
        client: (modelId: string) => cerebras(modelId),
        models: [],
        features: {
          streaming: true,
          tools: true,
          vision: false,
          maxTokens: 128000,
          reasoning: true,
          fast: true
        },
        displayName: 'Cerebras',
        priority: 20
      })
      logger.debug('[ProviderManager] Cerebras API key validated')
      registeredCount++
    }

    const cohereKey = this.apiKeys.cohere ?? env.COHERE_API_KEY
    if (cohereKey && this.validateApiKey(cohereKey, 'Cohere')) {
      const cohere = createCohere({
        apiKey: cohereKey,
        baseURL: env.COHERE_API_BASE_URL || undefined
      })
      this.providers.set('cohere', {
        client: (modelId: string) => cohere(modelId),
        models: [],
        features: {
          streaming: true,
          tools: true,
          vision: false,
          maxTokens: 128000,
          reasoning: true
        },
        displayName: 'Cohere',
        priority: 21
      })
      logger.debug('[ProviderManager] Cohere API key validated')
      registeredCount++
    }

    if (this.customProviders.length) {
      const customPriorityBase = 50
      this.customProviders.forEach((provider, index) => {
        registerCustomProvider(provider, customPriorityBase + index)
      })
    }

    if (this.localProviders.length) {
      const localPriorityBase = 70
      this.localProviders.forEach((provider, index) => {
        registerLocalProvider(provider, localPriorityBase + index)
      })
    }

    logger.debug(`[ProviderManager] Registered ${registeredCount} providers`)
    
    if (registeredCount === 0) {
      console.error('[ProviderManager] WARNING: No providers configured! Add API keys to environment.')
    }
  }

  /**
   * Setup fallback chain based on provider priority
   */
  private setupFallbackChain() {
    // Sort providers by priority
    const sortedProviders = Array.from(this.providers.entries())
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([name]) => name)
    
    this.fallbackChain = sortedProviders
    logger.debug('[ProviderManager] Fallback chain:', this.fallbackChain.join(' → '))
  }

  private setupGatewayClient() {
    const gatewayKey = this.gatewayConfig.apiKey ?? env.AI_GATEWAY_API_KEY ?? undefined
    if (!gatewayKey) {
      this.gatewayClient = null
      return
    }

    try {
      this.gatewayClient = createGateway({
        apiKey: gatewayKey,
        baseURL: this.gatewayConfig.baseURL ?? env.AI_GATEWAY_BASE_URL ?? undefined
      })
      logger.debug('[ProviderManager] AI Gateway client configured for model routing')
    } catch (error) {
      console.warn('[ProviderManager] Failed to configure AI Gateway client:', error)
      this.gatewayClient = null
    }
  }

  /**
   * Validate API key format without exposing it
   * SECURITY: Never log the actual key
   */
  private validateApiKey(key: string, provider: string): boolean {
    try {
      // Basic validation - check format and length
      if (!key || key.length < 10) {
        console.warn(`[ProviderManager] Invalid ${provider} API key format`)
        return false
      }
      
      // Provider-specific validation patterns
      const patterns: Record<string, RegExp> = {
        'Anthropic': /^sk-ant-/,
        'OpenAI': /^sk-/,
        'Google': /^[A-Za-z0-9_-]+$/,
        'Mistral': /^[A-Za-z0-9]+$/,
        'Groq': /^gsk_/,
        'OpenRouter': /^sk-or-/
      }
      
      if (patterns[provider] && !patterns[provider].test(key)) {
        console.warn(`[ProviderManager] ${provider} API key format validation failed`)
        return false
      }
      
      // Success - log without exposing key
      return true
    } catch (error) {
      console.error(`[ProviderManager] Error validating ${provider} API key`)
      return false
    }
  }

  /**
   * Get a model instance with fallback support
   * Implements smart fallback chain with loop prevention
   */
  getModel(modelName: string, options?: GetModelOptions): LanguageModel {
    const cacheKey = this.buildCacheKey(modelName, options)

    if (this.modelCache.has(cacheKey)) {
      return this.modelCache.get(cacheKey)!
    }

    try {
      const modelInstance = this.buildModel(modelName, options)
      this.modelCache.set(cacheKey, modelInstance)
      return modelInstance
    } catch (error) {
      const fallback = options?.fallbackModel
      if (fallback?.modelName) {
        const isSameModel =
          fallback.modelName === modelName &&
          (fallback.transport ?? options?.transport) === (options?.transport ?? (this.gatewayClient ? 'vercel-gateway' : 'direct')) &&
          (fallback.service ?? null) === (options?.service ?? null)
        if (!isSameModel) {
          return this.getModel(fallback.modelName, {
            transport: fallback.transport,
            service: fallback.service ?? null
          })
        }
      }

      if (options?.allowAutoFallback) {
        console.error(`[ProviderManager] Error getting model ${modelName}, using auto-fallback:`, error)
        return this.getFallbackModel(modelName)
      }

      throw error
    }
  }

  private buildModel(modelName: string, options?: GetModelOptions): LanguageModel {
    const transport = options?.transport ?? (this.gatewayClient ? 'vercel-gateway' : 'direct')

    if (transport === 'vercel-gateway') {
      if (!this.gatewayClient) {
        throw new Error('AI Gateway client not configured')
      }
      return this.gatewayClient(modelName)
    }

    if (this.providers.size === 0) {
      throw new Error('No available provider')
    }

    const parsed = this.parseModelName(modelName)
    const providerFromName = parsed?.[0]
    const parsedModel = parsed?.[1] ?? modelName
    const providerKey = options?.service ?? (transport === 'openrouter' ? 'openrouter' : providerFromName)

    if (!providerKey) {
      throw new Error(`Unable to resolve provider for model ${modelName}`)
    }

    if (!this.providers.has(providerKey)) {
      throw new Error(`Provider ${providerKey} not configured`)
    }

    const providerConfig = this.providers.get(providerKey)!
    const passthroughProviders = new Set([
      'openrouter',
      'deepinfra',
      'togetherai',
      'fireworks',
      'baseten',
      'cerebras',
      'qwencloud',
      'qwen_token_plan',
      'groq',
      'cohere',
      'fal',
      'replicate',
      'ollama',
      'dmr',
      'lmstudio',
      'llama-cpp',
      'vllm'
    ])
    const isCustomProvider = providerKey.startsWith('custom_')
    const resolvedModelName =
      providerKey === 'openrouter' || passthroughProviders.has(providerKey) || isCustomProvider
        ? modelName
        : parsedModel
    return providerConfig.client(resolvedModelName)
  }

  private buildCacheKey(modelName: string, options?: GetModelOptions) {
    const transport = options?.transport ?? (this.gatewayClient ? 'vercel-gateway' : 'direct')
    const service = options?.service ?? ''
    return `${transport}:${service}:${modelName}`
  }

  /**
   * Get a fallback model when primary is unavailable
   * Implements loop prevention with max attempts
   */
  private getFallbackModel(originalModel: string, attemptedProviders: Set<string> = new Set()): LanguageModel {
    const maxAttempts = this.fallbackChain.length
    
    if (attemptedProviders.size >= maxAttempts) {
      throw new Error(`No available provider for model ${originalModel} after trying all fallbacks`)
    }
    
    for (const fallbackProvider of this.fallbackChain) {
      if (attemptedProviders.has(fallbackProvider)) {
        continue // Skip already attempted providers (loop prevention)
      }
      
      attemptedProviders.add(fallbackProvider)
      
      const provider = this.providers.get(fallbackProvider)
      if (!provider || provider.models.length === 0) {
        continue
      }
      
      // Use default model from fallback provider
      const defaultModel = this.getDefaultModel(fallbackProvider)
      const modelInstance = provider.client(defaultModel)
      
      console.warn(`[ProviderManager] Using fallback: ${fallbackProvider}/${defaultModel} for ${originalModel}`)
      
      // Cache with original name for consistency
        const fallbackCacheKey = this.buildCacheKey(originalModel, {
          transport: 'direct',
          service: fallbackProvider
        })
        this.modelCache.set(fallbackCacheKey, modelInstance)
      
      return modelInstance
    }
    
    throw new Error(`Provider ${originalModel} not configured and no fallback available`)
  }

  /**
   * Parse model name to extract provider and model
   * Handles both 'provider/model' and 'model' formats
   */
  private parseModelName(modelName: string): [string, string] | null {
    // Handle explicit provider/model format
    if (modelName.includes('/')) {
      const parts = modelName.split('/')
      return [parts[0], parts.slice(1).join('/')]
    }

    // Map Batshit model names to actual provider model names
    const modelMapping: Record<string, [string, string]> = {
      // No mapping needed - gpt-4.1 is the actual model ID
      // 'gpt-5': ['openai', 'gpt-5'],  // When GPT-5 is released
    }

    if (modelMapping[modelName]) {
      return modelMapping[modelName]
    }

    // Infer provider from model name
    const normalizedModelName = modelName.toLowerCase()
    if (normalizedModelName.includes('claude')) return ['anthropic', modelName]
    if (normalizedModelName.includes('gpt') || normalizedModelName.includes('o1')) return ['openai', modelName]
    if (normalizedModelName.includes('gemini')) return ['google', modelName]
    if (normalizedModelName.includes('mistral') || normalizedModelName.includes('codestral')) return ['mistral', modelName]
    if (normalizedModelName.includes('llama') || normalizedModelName.includes('mixtral')) return ['groq', modelName]
    if (normalizedModelName.includes('deepseek')) return ['deepseek', modelName]
    if (normalizedModelName.includes('kimi')) return ['moonshot', modelName]
    if (normalizedModelName.includes('minimax')) return ['minimax', modelName]
    if (normalizedModelName.includes('mimo')) return ['mimo', modelName]
    if (normalizedModelName.startsWith('step-')) return ['stepfun', modelName]
    if (normalizedModelName.includes('qwen')) return ['openrouter', modelName]
    
    return null
  }

  /**
   * Get default model for a provider
   */
  private getDefaultModel(provider: string): string {
    const defaults: Record<string, string> = {
      anthropic: 'claude-3-5-sonnet-20241022',
      openai: 'gpt-4.1',  // Use gpt-4.1 as default
      google: 'gemini-2.5-pro',
      mistral: 'mistral-large-latest',
      groq: 'llama-3.1-70b',
      xai: 'grok-4.3',
      moonshot: 'kimi-k2.6',
      minimax: 'MiniMax-M3',
      mimo: 'mimo-v2.5-pro',
      qwen_token_plan: 'qwen3.8-max',
      alibaba: 'qwen3-max',
      stepfun: 'step-3.7-flash',
      openrouter: 'anthropic/claude-3.5-sonnet',
      deepseek: 'deepseek-chat',
      zai: 'glm-4.7',
      zai_coding: 'glm-4.7'
    }
    
    const providerConfig = this.providers.get(provider)
    return defaults[provider] || providerConfig?.models[0] || ''
  }

  /**
   * List all available models for UI population
   * Returns sorted list with metadata
   */
  listAvailableModels(): ModelInfo[] {
    const models: ModelInfo[] = []
    
    for (const [providerName, config] of this.providers.entries()) {
      for (const model of config.models) {
        models.push({
          id: `${providerName}/${model}`,
          name: model,
          provider: providerName,
          features: config.features,
          displayName: this.getDisplayName(providerName, model),
          category: this.categorizeModel(model, config.features)
        })
      }
    }
    
    // Sort by provider priority then model capability
    models.sort((a, b) => {
      const aProvider = this.providers.get(a.provider)
      const bProvider = this.providers.get(b.provider)
      
      if (aProvider && bProvider && aProvider.priority !== bProvider.priority) {
        return aProvider.priority - bProvider.priority
      }
      
      return a.name.localeCompare(b.name)
    })
    
    return models
  }

  /**
   * Get user-friendly display name for models
   */
  private getDisplayName(provider: string, model: string): string {
    const displayNames: Record<string, string> = {
      // Anthropic
      'claude-sonnet-4-5-latest': 'Claude Sonnet 4 Latest',
      'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
      'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
      'claude-3-opus-20240229': 'Claude 3 Opus',
      
      // OpenAI
      'gpt-4.1': 'GPT-4.1',
      'gpt-5': 'GPT-5',
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'o1-preview': 'O1 Preview (Reasoning)',
      'o1-mini': 'O1 Mini (Reasoning)',
      
      // Google
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-1.5-flash': 'Gemini 1.5 Flash',
      'gemini-2.0-flash-exp': 'Gemini 2.0 Flash (Experimental)',
      
      // Mistral
      'mistral-large-latest': 'Mistral Large',
      'mistral-medium': 'Mistral Medium',
      'codestral-latest': 'Codestral (Code)',
      
      // Groq
      'llama-3.1-70b': 'Llama 3.1 70B',
      'mixtral-8x7b-32768': 'Mixtral 8x7B',

      // xAI
      'grok-4.3': 'Grok 4.3',
      'grok-4.20-non-reasoning': 'Grok 4.20',
      'grok-4.20-reasoning': 'Grok 4.20 Reasoning',

      // Moonshot / Kimi
      'kimi-k2.6': 'Kimi K2.6',
      'kimi-latest': 'Kimi Latest',
      
      // OpenRouter
      'anthropic/claude-3.5-sonnet': 'Claude 3.5 Sonnet (OpenRouter)',
      'openai/gpt-4o': 'GPT-4o (OpenRouter)',
      'google/gemini-2.0-flash-thinking-exp-1219': 'Gemini 2.0 Flash Thinking',
      'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
      'qwen/qwq-32b-preview': 'Qwen QwQ 32B',
      'deepseek/deepseek-r1': 'DeepSeek R1'
      ,
      'deepseek-chat': 'DeepSeek Chat',
      'deepseek-coder': 'DeepSeek Coder',
      'deepseek-reasoner': 'DeepSeek Reasoner',
      'deepseek-r1': 'DeepSeek R1',
      'glm-4.5': 'GLM-4.5',
      'glm-4.7': 'GLM-4.7',
      'glm-4.5-air': 'GLM-4.5 Air',
      'glm-4.6': 'GLM-4.6',
      'glm-5': 'GLM-5',
      'glm-5-turbo': 'GLM-5 Turbo',
      'glm-5.1': 'GLM-5.1',
      'glm-5.2': 'GLM-5.2'
    }
    
    return displayNames[model] || model
  }

  /**
   * Categorize models for UI organization
   */
  private categorizeModel(model: string, features: ProviderFeatures): ModelInfo['category'] {
    if (features.reasoning || model.includes('o1') || model.includes('reasoner') || model.includes('r1')) return 'reasoning'
    if (features.code || model.includes('codestral') || model.includes('coder')) return 'code'
    if (features.fast || model.includes('flash') || model.includes('haiku')) return 'fast'
    if (model.includes('opus') || model.includes('gpt-5')) return 'powerful'
    return 'balanced'
  }

  /**
   * Check if a provider is available
   */
  hasProvider(provider: string): boolean {
    return this.providers.has(provider)
  }

  /**
   * Get provider configuration
   * SECURITY: Never expose API keys
   */
  getProviderInfo(provider: string): Omit<AIProvider, 'client'> | null {
    const config = this.providers.get(provider)
    if (!config) return null
    
    // Return config without the client function (which contains API key)
    return {
      models: config.models,
      features: config.features,
      displayName: config.displayName,
      priority: config.priority
    }
  }

  /**
   * Get all configured providers
   * SECURITY: Returns only safe metadata
   */
  getConfiguredProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Clear model cache - useful for testing or memory management
   */
  clearCache() {
    this.modelCache.clear()
    logger.debug('[ProviderManager] Model cache cleared')
  }
}

const PROVIDER_KEY_CONFIG = [
  { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', envVar: 'OPENAI_API_KEY' },
  { id: 'google', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  { id: 'mistral', envVar: 'MISTRAL_API_KEY' },
  { id: 'groq', envVar: 'GROQ_API_KEY' },
  { id: 'xai', envVar: 'XAI_API_KEY' },
  { id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' },
  { id: 'moonshot', envVar: 'MOONSHOT_API_KEY' },
  { id: 'minimax', envVar: 'MINIMAX_API_KEY' },
  { id: 'mimo', envVar: 'MIMO_API_KEY' },
  { id: 'qwencloud', envVar: 'DASHSCOPE_API_KEY' },
  { id: 'qwen_token_plan', envVar: 'QWEN_TOKEN_PLAN_API_KEY' },
  { id: 'alibaba', envVar: 'ALIBABA_CLOUD_API_KEY' },
  { id: 'stepfun', envVar: 'STEPFUN_API_KEY' },
  { id: 'zai', envVar: 'ZAI_API_KEY' },
  { id: 'zai_coding', envVar: 'ZAI_CODING_API_KEY' },
  { id: 'openrouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'fal', envVar: 'FAL_API_KEY' },
  { id: 'luma', envVar: 'LUMA_API_KEY' },
  { id: 'replicate', envVar: 'REPLICATE_API_KEY' },
  { id: 'elevenlabs', envVar: 'ELEVENLABS_API_KEY' },
  { id: 'deepgram', envVar: 'DEEPGRAM_API_KEY' },
  { id: 'assemblyai', envVar: 'ASSEMBLYAI_API_KEY' },
  { id: 'cohere', envVar: 'COHERE_API_KEY' },
  { id: 'huggingface', envVar: 'HUGGING_FACE_API_KEY' },
  { id: 'deepinfra', envVar: 'DEEPINFRA_API_KEY' },
  { id: 'togetherai', envVar: 'TOGETHER_API_KEY' },
  { id: 'fireworks', envVar: 'FIREWORKS_API_KEY' },
  { id: 'baseten', envVar: 'BASETEN_API_KEY' },
  { id: 'cerebras', envVar: 'CEREBRAS_API_KEY' }
] as const satisfies Array<{ id: KnownProviderId; envVar: string }>

export async function resolveProviderAccess(userId?: string | null): Promise<ProviderAccessResolution> {
  const apiKeys: ProviderApiKeys = {}
  const availability = PROVIDER_KEY_CONFIG.reduce<Record<KnownProviderId, ProviderAvailability>>(
    (acc, config) => {
    acc[config.id] = { hasKey: false, source: null }
    return acc
  }, {} as Record<KnownProviderId, ProviderAvailability>)

  const envMap = env as Record<string, string | undefined>

  let userKeyEntries: Array<[KnownProviderId, string | null]> = []
  if (userId) {
    userKeyEntries = await Promise.all(
      PROVIDER_KEY_CONFIG.map(async (config) => {
        try {
          const value = await apiKeyService.retrieve(config.id, userId)
          return [config.id, value]
        } catch (error) {
          console.warn(`[ProviderManager] Failed to read ${config.id} key for user ${userId}:`, error)
          return [config.id, null]
        }
      })
    )
  }
  const userKeys = Object.fromEntries(userKeyEntries) as Partial<Record<KnownProviderId, string | null>>

  for (const config of PROVIDER_KEY_CONFIG) {
    const userKey = userKeys[config.id]
    if (userKey) {
      apiKeys[config.id] = userKey
      availability[config.id] = { hasKey: true, source: 'user' }
      continue
    }

    let envKey = envMap[config.envVar] ?? undefined
    if (!envKey && config.id === 'fal') {
      envKey = envMap.FAL_KEY ?? undefined
    }
    if (!envKey && config.id === 'stepfun') {
      envKey = envMap.STEP_API_KEY ?? undefined
    }
    if (!envKey && config.id === 'huggingface') {
      envKey = envMap.HUGGINGFACE_API_KEY ?? envMap.HF_TOKEN ?? undefined
    }
    if (envKey) {
      apiKeys[config.id] = envKey
      availability[config.id] = { hasKey: true, source: 'env' }
    }
  }

  let gatewayKey: string | null = null
  let gatewaySource: 'user' | 'env' | null = null

  if (userId) {
    try {
      const storedGatewayKey = await apiKeyService.retrieve('ai_gateway', userId)
      if (storedGatewayKey) {
        gatewayKey = storedGatewayKey
        gatewaySource = 'user'
      }
    } catch (error) {
      console.warn(`[ProviderManager] Failed to read ai_gateway key for user ${userId}:`, error)
    }
  }

  if (!gatewayKey && env.AI_GATEWAY_API_KEY) {
    gatewayKey = env.AI_GATEWAY_API_KEY
    gatewaySource = 'env'
  }

  return {
    apiKeys,
    availability,
    gateway: {
      apiKey: gatewayKey,
      baseURL: env.AI_GATEWAY_BASE_URL ?? null,
      availability: {
        hasKey: Boolean(gatewayKey),
        source: gatewaySource
      }
    }
  }
}
