import { retainCatalogSourceEntries } from '$lib/server/services/catalogRetention'
import { inferModelPurpose } from '$lib/utils/modelPurpose'
import { logger } from '$lib/utils/logger'
import { normalizePositiveInteger, sanitizeCatalogMaxOutputTokens } from '$lib/utils/modelOutputTokens'
import type { ModelPurpose } from '$lib/types/savedModels'
import { storeCatalogSyncReport } from '$lib/server/services/modelCatalogReportStore'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { upstashKvGet, upstashKvSet } from '$lib/server/services/upstashKv'
import type { CatalogSyncTrigger, CatalogSyncVariantCollision } from '$lib/types/modelCatalogSyncReport'
import {
  FAL_DEVELOPER_OVERRIDE_EXACT,
  FAL_DEVELOPER_OVERRIDE_KEYWORDS,
  FAL_DEVELOPER_OVERRIDE_PREFIX
} from '$lib/data/fal-developer-overrides'
import { RECOVERED_FAL_ENTRIES } from '$lib/data/catalog-recovered-entries'
import {
  QWEN_TOKEN_PLAN_OPENAI_BASE_URL,
  QWEN_TOKEN_PLAN_TEXT_MODELS
} from '$lib/server/constants/qwenTokenPlan'
import {
  ZAI_CODING_PLAN_LEGACY_MODEL_IDS,
  ZAI_CODING_PLAN_MODELS,
  ZAI_CODING_PLAN_OPENAI_BASE_URL
} from '$lib/server/constants/zaiCodingPlan'
import { KIMI_CODE_MODELS, KIMI_CODE_OPENAI_BASE_URL } from '$lib/server/constants/kimiCodePlan'
import {
  MINIMAX_TOKEN_PLAN_OPENAI_BASE_URL,
  MINIMAX_TOKEN_PLAN_TEXT_MODELS
} from '$lib/server/constants/minimaxTokenPlan'
import {
  MIMO_TOKEN_PLAN_MODELS,
  MIMO_TOKEN_PLAN_OPENAI_BASE_URL
} from '$lib/server/constants/mimoTokenPlan'
import { canonicalizeCatalogDeveloperId } from '$lib/utils/catalogDeveloperIdentity'
import {
  buildListedPricing,
  readArtificialAnalysisPrice,
  gatewayZeroPriceContext,
  holdsPositivePrice,
  listedPriceVaries,
  readListedCentsPerTokenPrice,
  readListedPerTokenPrice,
  readListedPrice,
  withoutFalseZeros,
  type ListedPricing,
  type ZeroPriceContext
} from '$lib/utils/catalogPricing'
import type { CatalogConnectionLimits } from '$lib/types/modelCatalog'
import {
  isOpenAICompletionsOnlyModel,
  resolveReviewedCatalogIdentity,
  type CatalogIdentityRule
} from '$lib/server/services/catalogModelIdentity'

const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/models'
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const AA_ENDPOINT = 'https://artificialanalysis.ai/api/v2/data/llms/models'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/models'
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/models'
const GOOGLE_GEMINI_MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const MISTRAL_MODELS_ENDPOINT = 'https://api.mistral.ai/v1/models'
const FAL_MODELS_ENDPOINT = 'https://api.fal.ai/v1/models'
const REPLICATE_OFFICIAL_COLLECTION_ENDPOINT = 'https://api.replicate.com/v1/collections/official'
const DEEPINFRA_MODELS_ENDPOINT = 'https://api.deepinfra.com/models/list'
const FIREWORKS_SERVERLESS_MODELS_ENDPOINT = 'https://api.fireworks.ai/v1/accounts/fireworks/models'
const COHERE_MODELS_ENDPOINT = 'https://api.cohere.ai/v1/models'
// NOTE: Groq uses an OpenAI-compatible endpoint at https://api.groq.com/openai/v1

type CatalogTransport = 'vercel-gateway' | 'openrouter' | 'direct'
type CatalogSource = 'vercel' | 'openrouter' | 'direct'

type CatalogConnectionId = 'vercel-gateway' | 'openrouter' | `direct:${string}`

interface GatewayModel {
  id: string
  name: string
  description?: string
  context_window?: number
  max_tokens?: number
  tags?: string[]
  pricing?: Record<string, string | number>
  type?: string
}

interface OpenRouterModel {
  id: string
  name: string
  description?: string
  context_length?: number
  top_provider?: {
    context_length?: number | null
    max_completion_tokens?: number | null
    is_moderated?: boolean | null
  }
  pricing?: {
    prompt?: string
    completion?: string
    cached_input?: string
    input_cache_read?: string
  }
  supported_parameters?: string[]
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

interface CatalogEntry {
  id: string
  canonicalId: string
  provider: string
  upstreamProvider?: string | null
  name: string
  displayName: string
  description?: string
  tags: string[]
  contextWindow?: number
  maxOutputTokens?: number
  availableConnections?: string[]
  purpose: ModelPurpose
  aaSlug?: string
  idVariants?: Record<
    string /* connectionId */,
    {
      developerId: string
      modelId: string
      effectiveId: string
      source: 'vercel' | 'openrouter' | 'manual' | 'direct'
      /** BL-68 / BL-132: this connection's own limits; see CatalogModelIdVariant. */
      limits?: CatalogConnectionLimits
      /** BL-132: this connection's own price; see CatalogModelIdVariant. */
      pricing?: ListedPricing
    }
  >
  pricing?: {
    input?: number
    output?: number
    cachedInput?: number
  }
  features: {
    streaming: boolean
    tools: boolean
    vision: boolean
    /** BL-68: the known context window; absent when unknown, never 0. */
    maxTokens?: number
    reasoning?: boolean
    cacheControl?: boolean
    /** BL-68: absent when the window is unknown. */
    longContext?: boolean
    code?: boolean
    fast?: boolean
  }
  category?: 'fast' | 'balanced' | 'powerful' | 'reasoning' | 'code'
  source: CatalogSource
  transport: CatalogTransport
  connectionId: CatalogConnectionId
  modelType?: string | null
  /**
   * Working fields, set by `recordOwnNumbers` and never published
   * (`withoutWorkingFields`): the name a reviewed identity rule maps this entry
   * to and the rule (BL-68), and the limits and price this connection's own
   * source listed before Artificial Analysis filled in model-wide numbers
   * (BL-68, BL-132).
   */
  identityName?: string
  identityRule?: CatalogIdentityRule
  ownLimits?: CatalogConnectionLimits
  ownPricing?: ListedPricing | null
}

interface CatalogPayload {
  version: number
  fetchedAt: string
  counts: Record<string, number>
  models: CatalogEntry[]
}

const CATALOG_FETCH_TIMEOUT_MS = 15_000
const CATALOG_SOURCE_TIMEOUT_MS = 30_000

type SourceFetchOptions = {
  signal?: AbortSignal
  onFallbackError?: (error: unknown) => void
  onCompleteLiveList?: () => void
}

const DIRECT_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'groq',
  'xai',
  'deepseek',
  'deepinfra',
  'moonshot',
  'kimi_code',
  'minimax',
  'minimax_token_plan',
  'mimo',
  'mimo_token_plan',
  'qwencloud',
  'qwen_token_plan',
  'zai',
  'zai_coding',
  'togetherai',
  'fireworks',
  'baseten',
  'cerebras',
  'fal',
  'luma',
  'replicate',
  'elevenlabs',
  'deepgram',
  'assemblyai',
  'cohere'
] as const

type DirectProviderId = (typeof DIRECT_PROVIDER_IDS)[number]

type DirectProviderEntry = {
  id: string
  developerId?: string
  modelId?: string
  effectiveId?: string
  displayName?: string
  description?: string
  tags?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  pricing?: ListedPricing
  modelType?: string | null
}

type DeepInfraCatalogModel = {
  model_name?: string
  reported_type?: string
  description?: string | null
  tags?: string[]
  pricing?: {
    cents_per_input_token?: number | null
    cents_per_output_token?: number | null
    rate_per_input_token_cached?: number | null
  } | null
  max_tokens?: number | null
  replaced_by?: string | null
  deprecated?: number | null
  private?: number | null
}

type TogetherCatalogModel = {
  id?: string
  type?: string
  running?: boolean
  display_name?: string
  context_length?: number | null
  pricing?: {
    input?: number | null
    output?: number | null
    cached_input?: number | null
  } | null
}

type FireworksCatalogModel = {
  name?: string
  displayName?: string
  description?: string
  state?: string
  public?: boolean
  contextLength?: number | null
  supportsImageInput?: boolean
  supportsTools?: boolean
  huggingFaceUrl?: string
}

type BasetenCatalogModel = {
  id?: string
  name?: string
  description?: string
  context_length?: number | null
  max_completion_tokens?: number | null
  pricing?: Record<string, string | number>
  supported_features?: string[]
  input_modalities?: string[]
  output_modalities?: string[]
}

type OpenAICompatibleCatalogModel = {
  id?: string
  owned_by?: string
}

type CohereCatalogModel = {
  name?: string
  endpoints?: string[]
  features?: string[] | null
  context_length?: number | null
}

const MANUAL_DIRECT_MODELS: Partial<Record<DirectProviderId, DirectProviderEntry[]>> = {
  moonshot: [
    { id: 'kimi-k2.6', displayName: 'Kimi K2.6' },
    { id: 'kimi-latest', displayName: 'Kimi Latest' }
  ],
  kimi_code: KIMI_CODE_MODELS.map((model) => ({
    ...model,
    tags: [...model.tags]
  })),
  minimax_token_plan: MINIMAX_TOKEN_PLAN_TEXT_MODELS.map((model) => ({
    ...model,
    tags: [...model.tags]
  })),
  mimo_token_plan: MIMO_TOKEN_PLAN_MODELS.map((model) => ({
    ...model,
    tags: [...model.tags]
  })),
  qwen_token_plan: QWEN_TOKEN_PLAN_TEXT_MODELS.map((model) => ({
    id: model.id,
    developerId: model.developerId,
    modelId: model.id,
    effectiveId: model.id,
    displayName: model.displayName,
    tags: [...model.tags],
    modelType: 'chat'
  })),
  zai: [
    ...ZAI_CODING_PLAN_MODELS.map((model) => ({
      id: model.id,
      developerId: model.developerId,
      modelId: model.id,
      effectiveId: model.id,
      displayName: model.displayName,
      tags: [...model.tags],
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      modelType: model.modelType
    })),
    {
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      tags: ['reasoning', 'code'],
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072
    },
    { id: 'glm-4.7', displayName: 'GLM-4.7' },
    { id: 'glm-4.6', displayName: 'GLM-4.6' },
    { id: 'glm-4.6v', displayName: 'GLM-4.6V', tags: ['vision'] },
    { id: 'glm-4.6v-flashx', displayName: 'GLM-4.6V-FlashX', tags: ['vision'] },
    { id: 'glm-4.5', displayName: 'GLM-4.5' },
    { id: 'glm-4.5v', displayName: 'GLM-4.5V', tags: ['vision'] },
    { id: 'glm-4.5-x', displayName: 'GLM-4.5-X' },
    { id: 'glm-4.5-air', displayName: 'GLM-4.5-Air' },
    { id: 'glm-4.5-airx', displayName: 'GLM-4.5-AirX' },
    { id: 'glm-4-32b-0414-128k', displayName: 'GLM-4-32B-0414-128K' },
    { id: 'glm-4.6v-flash', displayName: 'GLM-4.6V-Flash', tags: ['vision'] },
    { id: 'glm-4.5-flash', displayName: 'GLM-4.5-Flash' }
  ],
  zai_coding: ZAI_CODING_PLAN_MODELS.map((model) => ({
    id: model.id,
    developerId: model.developerId,
    modelId: model.id,
    effectiveId: model.id,
    displayName: model.displayName,
    tags: [...model.tags],
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    modelType: model.modelType
  })),
  fal: [
    {
      id: 'fal-ai/flux/dev',
      displayName: 'Flux Dev',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/flux-lora',
      displayName: 'Flux LoRA',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/fast-sdxl',
      displayName: 'Fast SDXL',
      tags: ['image', 'vision', 'image-generation', 'fast'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/flux-pro',
      displayName: 'Flux Pro',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/flux-pro/kontext',
      displayName: 'Flux Pro Kontext',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/flux-pro/v1.1-ultra',
      displayName: 'Flux Pro 1.1 Ultra',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/ideogram/v2',
      displayName: 'Ideogram v2',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/recraft-v3',
      displayName: 'Recraft v3',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/stable-diffusion-3.5-large',
      displayName: 'Stable Diffusion 3.5 Large',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/hyper-sdxl',
      displayName: 'Hyper SDXL',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'fal-ai/minimax/speech-02-hd',
      displayName: 'Minimax Speech 02 HD',
      tags: ['audio', 'tts'],
      modelType: 'audio'
    }
  ],
  luma: [
    {
      id: 'photon-1',
      displayName: 'Photon 1',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    },
    {
      id: 'photon-flash-1',
      displayName: 'Photon Flash 1',
      tags: ['image', 'vision', 'image-generation', 'fast'],
      modelType: 'image'
    },
    {
      id: 'ray-2',
      displayName: 'Ray 2',
      tags: ['video', 'image-to-video'],
      modelType: 'video'
    },
    {
      id: 'ray-flash-2',
      displayName: 'Ray Flash 2',
      tags: ['video', 'image-to-video', 'fast'],
      modelType: 'video'
    },
    {
      id: 'ray-1-6',
      displayName: 'Ray 1.6',
      tags: ['video', 'image-to-video'],
      modelType: 'video'
    }
  ],
  replicate: [
    {
      id: 'black-forest-labs/flux-schnell',
      displayName: 'Flux Schnell',
      tags: ['image', 'vision', 'image-generation', 'fast'],
      modelType: 'image'
    },
    {
      id: 'black-forest-labs/flux-dev',
      displayName: 'Flux Dev',
      tags: ['image', 'vision', 'image-generation'],
      modelType: 'image'
    }
  ],
  xai: [
    {
      id: 'grok-imagine-image-quality',
      displayName: 'Grok Imagine Image Quality',
      tags: ['image', 'vision', 'image-generation', 'image-editing', 'grok', 'imagine', 'quality'],
      modelType: 'image'
    },
    {
      id: 'grok-imagine-image',
      displayName: 'Grok Imagine Image',
      tags: ['image', 'vision', 'image-generation', 'image-editing', 'grok', 'imagine'],
      modelType: 'image'
    }
  ],
  elevenlabs: [
    {
      id: 'eleven_v3',
      displayName: 'Eleven v3',
      tags: ['audio', 'tts'],
      modelType: 'audio'
    },
    {
      id: 'eleven_multilingual_v2',
      displayName: 'Eleven Multilingual v2',
      tags: ['audio', 'tts'],
      modelType: 'audio'
    },
    {
      id: 'eleven_flash_v2_5',
      displayName: 'Eleven Flash v2.5',
      tags: ['audio', 'tts', 'fast'],
      modelType: 'audio'
    },
    {
      id: 'eleven_flash_v2',
      displayName: 'Eleven Flash v2',
      tags: ['audio', 'tts', 'fast'],
      modelType: 'audio'
    },
    {
      id: 'eleven_turbo_v2_5',
      displayName: 'Eleven Turbo v2.5',
      tags: ['audio', 'tts', 'fast'],
      modelType: 'audio'
    },
    {
      id: 'eleven_turbo_v2',
      displayName: 'Eleven Turbo v2',
      tags: ['audio', 'tts', 'fast'],
      modelType: 'audio'
    },
    {
      id: 'scribe_v1',
      displayName: 'Scribe v1',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    },
    {
      id: 'scribe_v1_experimental',
      displayName: 'Scribe v1 Experimental',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    }
  ],
  deepgram: [
    {
      id: 'base',
      displayName: 'Base',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    },
    {
      id: 'enhanced',
      displayName: 'Enhanced',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    },
    {
      id: 'nova',
      displayName: 'Nova',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    },
    {
      id: 'nova-2',
      displayName: 'Nova 2',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    },
    {
      id: 'nova-3',
      displayName: 'Nova 3',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    }
  ],
  assemblyai: [
    {
      id: 'best',
      displayName: 'Best',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    },
    {
      id: 'nano',
      displayName: 'Nano',
      tags: ['audio', 'stt', 'transcription'],
      modelType: 'audio'
    }
  ]
}

function mergePurpose(purposes: ModelPurpose[]): ModelPurpose {
  const set = new Set(purposes)
  if (set.has('chat')) return 'chat'
  if (set.has('visual')) return 'visual'
  if (set.has('audio')) return 'audio'
  return 'utility'
}

const KNOWN_PURPOSES = new Set<ModelPurpose>(['chat', 'visual', 'audio', 'utility'])

function normalizePurpose(raw: unknown, fallback: ModelPurpose): ModelPurpose {
  if (typeof raw === 'string' && KNOWN_PURPOSES.has(raw as ModelPurpose)) {
    return raw as ModelPurpose
  }
  return fallback
}

async function fetchJson<T>(input: string, init?: RequestInit) {
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)

  const response = await fetch(input, {
    ...init,
    signal
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Request failed (${response.status}) for ${input}: ${body}`)
  }
  return (await response.json()) as T
}

function normalizeTag(value: string) {
  return value.trim().toLowerCase()
}

function buildFalTags(category?: string, tags?: unknown): string[] {
  const set = new Set<string>()
  const normalizedCategory = category?.trim().toLowerCase() ?? ''
  if (normalizedCategory) {
    set.add(normalizedCategory)
    for (const part of normalizedCategory.split(/[^a-z0-9]+/)) {
      if (part) set.add(part)
    }
    if (normalizedCategory.includes('image')) set.add('image')
    if (normalizedCategory.includes('video')) set.add('video')
    if (normalizedCategory.includes('speech') || normalizedCategory.includes('audio')) set.add('audio')
    if (normalizedCategory.includes('transcription') || normalizedCategory.includes('speech-to-text')) set.add('stt')
    if (normalizedCategory.includes('text-to-speech')) set.add('tts')
    if (normalizedCategory.includes('embedding') || normalizedCategory.includes('rerank')) set.add('embedding')
  }

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const normalized = normalizeTag(safeString(tag))
      if (normalized) set.add(normalized)
    }
  }

  return Array.from(set)
}

function mapFalCategoryToModelType(category?: string, tags: string[] = []): string | null {
  const normalizedCategory = category?.trim().toLowerCase() ?? ''
  const tagSet = new Set(tags.map((tag) => normalizeTag(tag)))

  if (normalizedCategory.includes('video') || tagSet.has('video')) return 'video'
  if (normalizedCategory.includes('image') || tagSet.has('image')) return 'image'
  if (
    normalizedCategory.includes('speech') ||
    normalizedCategory.includes('audio') ||
    tagSet.has('audio') ||
    tagSet.has('tts') ||
    tagSet.has('stt')
  ) {
    return 'audio'
  }
  if (normalizedCategory.includes('embedding') || tagSet.has('embedding') || tagSet.has('rerank')) {
    return 'embedding'
  }
  return null
}

function inferTagsFromIdentifier(id: string, description?: string | null): string[] {
  const set = new Set<string>()
  const haystack = `${id} ${description ?? ''}`.toLowerCase()

  const addIf = (condition: boolean, tag: string) => {
    if (condition) set.add(tag)
  }

  addIf(
    haystack.includes('image') ||
      haystack.includes('flux') ||
      haystack.includes('sdxl') ||
      haystack.includes('stable-diffusion') ||
      haystack.includes('dall-e') ||
      haystack.includes('imagen'),
    'image'
  )
  addIf(
    haystack.includes('video') ||
      haystack.includes('animation') ||
      haystack.includes('kling') ||
      haystack.includes('sora'),
    'video'
  )
  addIf(
    haystack.includes('audio') ||
      haystack.includes('speech') ||
      haystack.includes('tts') ||
      haystack.includes('whisper') ||
      haystack.includes('transcribe'),
    'audio'
  )
  addIf(haystack.includes('tts') || haystack.includes('text-to-speech'), 'tts')
  addIf(
    haystack.includes('whisper') ||
      haystack.includes('transcribe') ||
      haystack.includes('stt') ||
      haystack.includes('speech-to-text'),
    'stt'
  )
  addIf(haystack.includes('embedding') || haystack.includes('embed'), 'embedding')
  addIf(haystack.includes('rerank') || haystack.includes('ranker') || haystack.includes('rank'), 'rerank')
  addIf(haystack.includes('fast') || haystack.includes('turbo') || haystack.includes('flash'), 'fast')

  return Array.from(set)
}

/**
 * A per-token price list (gateway, OpenRouter, Baseten) in dollars per million
 * tokens. BL-131: a listed 0 is a free model and stays 0; a blank or negative
 * price (OpenRouter's -1 on its routers) is unknown and stays absent.
 */
function mapPricing(pricing?: Record<string, unknown>, context: ZeroPriceContext = {}) {
  if (!pricing) return undefined
  return buildListedPricing(
    withoutFalseZeros(
      {
        input: readListedPerTokenPrice(pricing.input ?? pricing.prompt ?? pricing.price_1m_input_tokens),
        output: readListedPerTokenPrice(pricing.output ?? pricing.completion ?? pricing.price_1m_output_tokens),
        cachedInput: readListedPerTokenPrice(pricing.input_cache_read ?? pricing.cached_input ?? pricing.cached_input_price)
      },
      { ...context, varies: listedPriceVaries(pricing) }
    )
  )
}

/** Review finding 1: OpenRouter's per-request and per-image prices, its output modalities, and its `:free` mark. */
const OPENROUTER_NON_TOKEN_PRICE_KEYS = ['request', 'image', 'image_output', 'audio_output']

function openRouterZeroPriceContext(raw: OpenRouterModel): ZeroPriceContext {
  const pricing = raw.pricing as Record<string, unknown> | undefined
  const outputs = raw.architecture?.output_modalities ?? []
  return {
    pricedOtherwise:
      outputs.some((modality) => modality.toLowerCase() !== 'text') ||
      OPENROUTER_NON_TOKEN_PRICE_KEYS.some((key) => holdsPositivePrice(pricing?.[key])),
    // `:free` rows, and `openrouter/free`, its router over them.
    markedFree: /(:free|\/free)$/i.test(raw.id)
  }
}

/**
 * BL-131: Together lists per-million prices. A null is unknown (it used to read
 * as $0). A row priced 0 in and 0 out has no per-token price at all: on
 * 2026-09-25 all 98 such chat rows were dedicated-endpoint, LoRA, NIM, or base
 * models (every one `running: false`, `hourly: 0`), none of them free, so that
 * pair is unknown too. A single 0 beside a real price is kept as listed.
 */
function mapTogetherPricing(pricing: TogetherCatalogModel['pricing']) {
  const input = readListedPrice(pricing?.input)
  const output = readListedPrice(pricing?.output)
  if (input === 0 && output === 0) return undefined
  return buildListedPricing({ input, output, cachedInput: readListedPrice(pricing?.cached_input) })
}

function mapTogetherModels(models: TogetherCatalogModel[]): DirectProviderEntry[] {
  return models
    .filter((model) => model?.type === 'chat')
    .map((model) => {
      const id = safeString(model.id).trim()

      return {
        id,
        effectiveId: id,
        displayName: safeString(model.display_name).trim() || undefined,
        tags: Array.from(new Set(['chat', ...inferTagsFromIdentifier(id)])),
        contextWindow: normalizePositiveInteger(model.context_length),
        pricing: mapTogetherPricing(model.pricing),
        modelType: 'chat'
      }
    })
    .filter((model) => Boolean(model.id))
}

function parseHuggingFaceModelUrl(value?: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.hostname !== 'huggingface.co') return null
    const [developerId, modelId] = url.pathname.split('/').filter(Boolean)
    if (!developerId || !modelId) return null
    return { developerId, modelId }
  } catch {
    return null
  }
}

function mapFireworksModels(models: FireworksCatalogModel[]): DirectProviderEntry[] {
  const huggingFaceIdentityCounts = new Map<string, number>()
  for (const model of models) {
    const identity = parseHuggingFaceModelUrl(model.huggingFaceUrl)
    if (!identity) continue
    const key = `${identity.developerId.toLowerCase()}/${identity.modelId.toLowerCase()}`
    huggingFaceIdentityCounts.set(key, (huggingFaceIdentityCounts.get(key) ?? 0) + 1)
  }

  return models
    .filter((model) => model.public !== false && model.state !== 'DELETING' && model.state !== 'FAILED')
    .map((model) => {
      const effectiveId = safeString(model.name).trim()
      const fallbackModelId = effectiveId.split('/').pop() || effectiveId
      const huggingFaceIdentity = parseHuggingFaceModelUrl(model.huggingFaceUrl)
      const huggingFaceIdentityKey = huggingFaceIdentity
        ? `${huggingFaceIdentity.developerId.toLowerCase()}/${huggingFaceIdentity.modelId.toLowerCase()}`
        : null
      const huggingFaceIdentityIsUnique = huggingFaceIdentityKey
        ? huggingFaceIdentityCounts.get(huggingFaceIdentityKey) === 1
        : false
      const runtimeSlugMatchesHuggingFace = huggingFaceIdentity
        ? normalizeName(fallbackModelId) === normalizeName(huggingFaceIdentity.modelId)
        : false
      const useHuggingFaceIdentity = Boolean(
        huggingFaceIdentity && (huggingFaceIdentityIsUnique || runtimeSlugMatchesHuggingFace)
      )
      const description = safeString(model.description).trim()
      const identifierTags = inferTagsFromIdentifier(`${effectiveId} ${safeString(model.displayName)}`, description)
      const utilityModel = /(?:^|[-_/])(embedding|embed|reranker|rerank)(?:$|[-_/])/i.test(effectiveId)
      const tags = Array.from(
        new Set([
          ...(utilityModel ? ['embedding'] : ['chat']),
          ...identifierTags,
          ...(model.supportsTools ? ['tools'] : []),
          ...(model.supportsImageInput ? ['vision'] : [])
        ])
      )

      return {
        id: effectiveId,
        developerId: useHuggingFaceIdentity ? huggingFaceIdentity!.developerId : 'fireworks',
        modelId: useHuggingFaceIdentity ? huggingFaceIdentity!.modelId : fallbackModelId,
        effectiveId,
        displayName: safeString(model.displayName).trim() || undefined,
        description: description || undefined,
        tags,
        contextWindow: normalizePositiveInteger(model.contextLength),
        modelType: utilityModel ? 'embedding' : 'chat'
      }
    })
    .filter((model) => Boolean(model.id))
}

function mapBasetenModels(models: BasetenCatalogModel[]): DirectProviderEntry[] {
  return models
    .map((model) => {
      const id = safeString(model.id).trim()
      const description = safeString(model.description).trim()
      const inputModalities = (model.input_modalities ?? []).map(normalizeTag)
      const outputModalities = (model.output_modalities ?? []).map(normalizeTag)
      const tags = Array.from(
        new Set([
          'chat',
          ...inferTagsFromIdentifier(id, description),
          ...(model.supported_features ?? []).map(normalizeTag),
          ...inputModalities,
          ...outputModalities,
          ...(inputModalities.includes('image') ? ['vision'] : [])
        ])
      )

      return {
        id,
        effectiveId: id,
        displayName: safeString(model.name).trim() || undefined,
        description: description || undefined,
        tags,
        contextWindow: normalizePositiveInteger(model.context_length),
        maxOutputTokens: normalizePositiveInteger(model.max_completion_tokens),
        // Baseten marks no free models; a per-request or per-image price still
        // means its 0 token price is not a free model.
        pricing: mapPricing(model.pricing, {
          pricedOtherwise: ['request', 'image'].some((key) => holdsPositivePrice(model.pricing?.[key]))
        }),
        modelType: 'chat'
      }
    })
    .filter((model) => Boolean(model.id))
}

function normalizeDeveloperId(value: unknown, fallback: string) {
  const normalized = safeString(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

/**
 * BL-292: DashScope's `/models` (Qwen Cloud) lists `owned_by: "system"` for
 * every row (172 of 172 in a live read on 2026-09-27), which names no maker, so
 * `kimi-k3` there never joined Moonshot's row. The maker comes from the id, the
 * way a gateway's `developer/model` id names it; this reviewed list covers the
 * ids that do not spell the maker's catalog namespace:
 * - a `namespace/` prefix DashScope uses for a partner (`kimi/kimi-k3`,
 *   `ZHIPU/GLM-5.3`) maps to that maker;
 * - a bare id's family maps to its maker: Qwen (the Qwen Token Plan's and
 *   OpenRouter's `qwen`), DeepSeek, Z.ai's GLM, Moonshot's Kimi, and Alibaba's
 *   own non-Qwen models (Wan and Z-Image from Tongyi Lab, `tongyi-*`,
 *   `text-embedding-v*`, and the Tongyi CCAI `ccai-pro`; the gateway lists Wan
 *   as `alibaba`).
 * An id no rule knows keeps a real `owned_by`, else the connection's own id,
 * never "system". The model id itself stays exactly what DashScope listed.
 */
const QWEN_CLOUD_NAMESPACE_DEVELOPERS: Readonly<Record<string, string>> = Object.freeze({
  kimi: 'moonshotai',
  zhipu: 'zai'
})

const QWEN_CLOUD_FAMILY_DEVELOPERS: ReadonlyArray<{ pattern: RegExp; developerId: string }> = [
  { pattern: /^(?:qwen|qwq|qvq)/i, developerId: 'qwen' },
  { pattern: /^deepseek-/i, developerId: 'deepseek' },
  { pattern: /^glm-/i, developerId: 'zai' },
  { pattern: /^kimi-/i, developerId: 'moonshotai' },
  { pattern: /^(?:wan\d|z-image-|tongyi-|text-embedding-v|ccai-)/i, developerId: 'alibaba' }
]

const OWNED_BY_NAMES_NO_MAKER = new Set(['system'])

function resolveQwenCloudDeveloperId(id: string, ownedBy: unknown): string {
  const slash = id.indexOf('/')
  if (slash > 0) {
    const namespace = normalizeDeveloperId(id.slice(0, slash), 'qwencloud')
    return QWEN_CLOUD_NAMESPACE_DEVELOPERS[namespace] ?? namespace
  }
  const family = QWEN_CLOUD_FAMILY_DEVELOPERS.find((rule) => rule.pattern.test(id))
  if (family) return family.developerId
  const owner = normalizeDeveloperId(ownedBy, 'qwencloud')
  return OWNED_BY_NAMES_NO_MAKER.has(owner) ? 'qwencloud' : owner
}

function mapOpenAICompatibleCatalogModels(
  provider:
    | 'cerebras'
    | 'minimax'
    | 'minimax_token_plan'
    | 'mimo'
    | 'mimo_token_plan'
    | 'qwencloud',
  models: OpenAICompatibleCatalogModel[]
): DirectProviderEntry[] {
  return models
    .map((model) => {
      const id = safeString(model.id).trim()
      const isAudioProvider =
        provider === 'mimo' || provider === 'mimo_token_plan' || provider === 'qwencloud'
      const isAsr = isAudioProvider && /(?:^|[-_])asr(?:$|[-_])/i.test(id)
      const isTts = isAudioProvider && /(?:^|[-_])tts(?:$|[-_])/i.test(id)
      const isAudio = isAsr || isTts
      const tags = Array.from(
        new Set([
          ...(isAudio ? ['audio'] : ['chat']),
          ...(isAsr ? ['stt', 'transcription'] : []),
          ...(isTts ? ['tts'] : []),
          ...inferTagsFromIdentifier(id)
        ])
      )

      return {
        id,
        developerId:
          provider === 'qwencloud'
            ? resolveQwenCloudDeveloperId(id, model.owned_by)
            : normalizeDeveloperId(model.owned_by, provider),
        modelId: id,
        effectiveId: id,
        displayName: id,
        tags,
        modelType: isAudio ? 'audio' : 'chat'
      }
    })
    .filter((model) => Boolean(model.id))
}

function mapCohereModels(models: CohereCatalogModel[]): DirectProviderEntry[] {
  return models
    .map((model) => {
      const id = safeString(model.name).trim()
      const endpoints = (model.endpoints ?? []).map(normalizeTag)
      const features = (model.features ?? []).map(normalizeTag)
      const isChat = endpoints.includes('chat') || endpoints.includes('generate')
      const isAudio =
        endpoints.includes('transcribe') || endpoints.includes('transcription') || endpoints.includes('transcriptions')
      const isEmbedding = endpoints.includes('embed') || endpoints.includes('embed_image')
      const isRerank = endpoints.includes('rerank')
      const modelType = isChat ? 'chat' : isAudio ? 'audio' : isEmbedding ? 'embedding' : isRerank ? 'rerank' : null
      const tags = Array.from(
        new Set([
          ...(isChat ? ['chat'] : []),
          ...(isAudio ? ['audio', 'stt', 'transcription'] : []),
          ...(isEmbedding ? ['embedding'] : []),
          ...(isRerank ? ['rerank'] : []),
          ...features,
          ...inferTagsFromIdentifier(id)
        ])
      )

      return {
        id,
        developerId: 'cohere',
        modelId: id,
        effectiveId: id,
        displayName: id,
        tags,
        contextWindow: normalizePositiveInteger(model.context_length),
        modelType
      }
    })
    .filter((model) => Boolean(model.id) && Boolean(model.modelType))
}

function deriveFeatures(
  tags: string[],
  contextWindow?: number | null,
  pricing?: ReturnType<typeof mapPricing>
): CatalogEntry['features'] {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()))

  const features: CatalogEntry['features'] = {
    streaming: true,
    tools: normalized.has('tool-use') || normalized.has('tool') || normalized.has('tools'),
    vision:
      normalized.has('vision') ||
      normalized.has('image') ||
      normalized.has('image-input') ||
      normalized.has('multimodal'),
    reasoning: normalized.has('reasoning'),
    cacheControl: pricing?.cachedInput !== undefined,
    code: normalized.has('code') || normalized.has('coding'),
    fast: normalized.has('fast') || normalized.has('realtime')
  }
  return withKnownWindow(features, contextWindow)
}

/**
 * BL-68: a window nobody reported is unknown. Publish `maxTokens` and the
 * `longContext` claim built on it only for a known, positive window; otherwise
 * leave both out, never `maxTokens: 0` (blank sends nothing, zero is real).
 */
/** BL-68: drop a stored `maxTokens` that is not a known window, and the claim built on it. */
function withoutUnknownWindow(features: CatalogEntry['features']): CatalogEntry['features'] {
  const maxTokens = features.maxTokens
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) return features
  const { maxTokens: _maxTokens, longContext: _longContext, ...rest } = features
  return rest
}

function withKnownWindow(
  features: CatalogEntry['features'],
  contextWindow: number | null | undefined
): CatalogEntry['features'] {
  const { maxTokens: _maxTokens, longContext: _longContext, ...rest } = features
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return rest
  return { ...rest, maxTokens: contextWindow, longContext: contextWindow >= 128_000 }
}

function categorizeModel(tags: string[], contextWindow?: number | null): CatalogEntry['category'] {
  const normalized = tags.map((tag) => tag.toLowerCase())

  if (normalized.includes('reasoning')) return 'reasoning'
  if (normalized.includes('code') || normalized.includes('coding')) return 'code'
  if ((contextWindow ?? 0) >= 200_000) return 'powerful'
  if (normalized.includes('fast') || normalized.includes('realtime')) return 'fast'
  return 'balanced'
}

function normalizeProvider(id: string) {
  return id.split('/')[0]?.toLowerCase() ?? 'unknown'
}

function buildCanonicalId(provider: string, name: string) {
  const normalizedProvider = canonicalizeCatalogDeveloperId(provider)
  const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '-')
  return `${normalizedProvider}/${normalizedName}`
}

function normalizeOpenRouterDisplayName(displayName: string, providerId: string) {
  const trimmed = displayName?.trim()
  if (!trimmed) return displayName

  // OpenRouter typically prefixes names with "Developer: Model". Strip the leading developer label,
  // but keep any suffixes like "(free)" on the model portion. Some models may legitimately include a
  // colon in their name, so only strip when the prefix matches the model's provider/developer id.
  const match = /^([^:]{2,80}):\s+(.+)$/.exec(trimmed)
  if (!match) return trimmed

  const prefix = match[1]?.trim() ?? ''
  const remainder = match[2]?.trim() ?? ''

  const sanitize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const providerKey = sanitize(providerId)
  const prefixKey = sanitize(prefix)

  const matchesProvider =
    prefixKey === providerKey ||
    (providerKey.length > 5 &&
      providerKey.endsWith('ai') &&
      prefixKey.length >= 5 &&
      `${prefixKey}ai` === providerKey) ||
    (providerKey.length > 5 &&
      providerKey.endsWith('tech') &&
      prefixKey.length >= 3 &&
      `${prefixKey}tech` === providerKey) ||
    (providerKey === 'metallama' && prefixKey === 'meta')

  const matchesKnownAlias =
    (providerKey === 'congnativecomputations' && prefixKey === 'cognitivecomputations') ||
    (providerKey === 'cognitivecomputations' && prefixKey === 'congnativecomputations')

  if (!matchesProvider && !matchesKnownAlias) {
    return trimmed
  }

  return remainder || trimmed
}

function asDirectConnectionId(provider: DirectProviderId): CatalogConnectionId {
  return `direct:${provider}`
}

const OWNER_PREFIX_PROVIDERS = new Set<DirectProviderId>(['fal', 'replicate', 'deepinfra'])

function resolveFalDeveloperSlug(endpointId: string, displayName?: string | null) {
  const normalizedEndpoint = endpointId.trim().toLowerCase()
  if (normalizedEndpoint) {
    const exactOverride = FAL_DEVELOPER_OVERRIDE_EXACT[normalizedEndpoint]
    if (exactOverride) return exactOverride

    for (const entry of FAL_DEVELOPER_OVERRIDE_PREFIX) {
      if (normalizedEndpoint.startsWith(entry.prefix)) {
        return entry.developerId
      }
    }
  }

  const haystack = `${endpointId} ${displayName ?? ''}`.toLowerCase()
  for (const entry of FAL_DEVELOPER_OVERRIDE_KEYWORDS) {
    if (entry.tokens.some((token) => haystack.includes(token))) {
      return entry.developerId
    }
  }

  return null
}

function resolveFalEntryIdentifiers(endpointId: string, displayName?: string | null) {
  const trimmed = endpointId.trim()
  const segments = trimmed.split('/').filter(Boolean)

  const withoutPrefix = segments[0] === 'fal-ai' ? segments.slice(1) : segments
  const ownerSegment = withoutPrefix[0] ?? ''
  const detectedDeveloper = resolveFalDeveloperSlug(trimmed, displayName)
  const developerId = detectedDeveloper || ownerSegment || 'fal'

  let modelId = withoutPrefix.join('/')
  if (developerId && ownerSegment && developerId === ownerSegment) {
    modelId = withoutPrefix.slice(1).join('/') || ownerSegment
  }

  return {
    developerId,
    modelId: modelId || ownerSegment || trimmed,
    effectiveId: trimmed
  }
}

function resolveDirectEntryIdentifiers(provider: DirectProviderId, entry: DirectProviderEntry) {
  const rawId = safeString(entry.id).trim()
  let developerId = safeString(entry.developerId).trim()
  let modelId = safeString(entry.modelId).trim()

  if (provider === 'fal') {
    return resolveFalEntryIdentifiers(rawId, entry.displayName)
  }

  if (provider === 'groq') {
    if ((!developerId || !modelId) && rawId.includes('/')) {
      const [owner, ...rest] = rawId.split('/')
      if (!developerId && owner) developerId = owner
      if (!modelId && rest.length) modelId = rest.join('/').trim()
    }

    if (!developerId) developerId = provider
    if (!modelId) modelId = rawId

    return {
      developerId,
      modelId,
      effectiveId: entry.effectiveId?.trim().length ? entry.effectiveId.trim() : rawId || modelId
    }
  }

  if ((!developerId || !modelId) && rawId.includes('/')) {
    const [owner, ...rest] = rawId.split('/')
    if (!developerId && owner) developerId = owner
    if (!modelId && rest.length) modelId = rest.join('/').trim()
  }

  if (!developerId) developerId = provider
  if (!modelId) modelId = rawId

  const effectiveId = entry.effectiveId?.trim().length
    ? entry.effectiveId.trim()
    : OWNER_PREFIX_PROVIDERS.has(provider)
      ? `${developerId}/${modelId}`
      : modelId

  return { developerId, modelId, effectiveId }
}

function mapDirectProviderEntries(provider: DirectProviderId, entries: DirectProviderEntry[]): CatalogEntry[] {
  const connectionId = asDirectConnectionId(provider)
  return entries
    .filter((entry) => Boolean(entry?.id))
    .map((entry) => {
      const { developerId, modelId, effectiveId } = resolveDirectEntryIdentifiers(provider, entry)
      const name = modelId
      const canonicalId = buildCanonicalId(developerId, modelId)
      const tags = (entry.tags ?? []).map((tag) => tag.toLowerCase())
      const contextWindow = entry.contextWindow ?? undefined
      const pricing = entry.pricing
      const purpose = inferModelPurpose({
        modelType: entry.modelType ?? null,
        id: effectiveId,
        name,
        tags
      })

      return {
        id: effectiveId,
        canonicalId,
        provider: developerId,
        upstreamProvider: provider,
        name,
        displayName: entry.displayName?.trim() || name,
        description: entry.description,
        tags,
        contextWindow,
        maxOutputTokens: sanitizeCatalogMaxOutputTokens({
          maxOutputTokens: entry.maxOutputTokens,
          contextWindow
        }),
        purpose,
        pricing,
        features: deriveFeatures(tags, contextWindow, pricing),
        category: categorizeModel(tags, contextWindow),
        source: 'direct',
        transport: 'direct',
        connectionId,
        modelType: entry.modelType ?? null
      }
    })
}

function mergeDirectProviderEntries(
  liveEntries: DirectProviderEntry[],
  curatedEntries: DirectProviderEntry[]
): DirectProviderEntry[] {
  const seen = new Set<string>()
  const curatedById = new Map(curatedEntries.map((entry) => [entry.id, entry]))
  const merged: DirectProviderEntry[] = []

  for (const liveEntry of liveEntries) {
    const curated = curatedById.get(liveEntry.id)
    merged.push({
      ...(curated ?? {}),
      ...liveEntry,
      displayName: liveEntry.displayName ?? curated?.displayName,
      description: liveEntry.description ?? curated?.description,
      tags: liveEntry.tags ?? curated?.tags,
      contextWindow: liveEntry.contextWindow ?? curated?.contextWindow,
      maxOutputTokens: sanitizeCatalogMaxOutputTokens({
        maxOutputTokens: liveEntry.maxOutputTokens ?? curated?.maxOutputTokens,
        contextWindow: liveEntry.contextWindow ?? curated?.contextWindow
      }),
      pricing: liveEntry.pricing ?? curated?.pricing,
      modelType: liveEntry.modelType ?? curated?.modelType
    })
    seen.add(liveEntry.id)
  }

  for (const curatedEntry of curatedEntries) {
    if (!seen.has(curatedEntry.id)) {
      merged.push(curatedEntry)
    }
  }

  return merged
}

function buildOpenAICompatibleModelsUrl(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/v\d+$/.test(trimmed)) {
    return `${trimmed}/models`
  }
  return `${trimmed}/v1/models`
}

function requireModelList(payload: unknown, source: string, fields: readonly string[]): any[] {
  if (Array.isArray(payload)) {
    if (!fields.includes('array')) throw new Error(`${source} model list has an unexpected array response`)
    return payload
  }
  if (!payload || typeof payload !== 'object') throw new Error(`${source} model list is malformed`)
  if (Object.prototype.hasOwnProperty.call(payload, 'error') &&
    (payload as { error?: unknown }).error != null) {
    throw new Error(`${source} model list returned an error`)
  }
  for (const field of fields) {
    if (field === 'array') continue
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const models = (payload as Record<string, unknown>)[field]
      if (!Array.isArray(models)) throw new Error(`${source} model list ${field} is malformed`)
      return models
    }
  }
  throw new Error(`${source} model list is missing its model array`)
}

function requireModelIds(models: any[], source: string, field: string): void {
  if (models.some((model) => !model || typeof model !== 'object' ||
    typeof model[field] !== 'string' || !model[field].trim())) {
    throw new Error(`${source} model list has a row without ${field}`)
  }
}

function readNextPageToken(payload: unknown, source: string, field: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${source} model list page is malformed`)
  }
  const token = (payload as Record<string, unknown>)[field]
  if (token == null) return null
  if (typeof token !== 'string') throw new Error(`${source} model list ${field} is malformed`)
  return token.trim() || null
}

async function fetchOpenAICompatibleModels({
  baseUrl,
  apiKey,
  signal
}: {
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
}): Promise<any[]> {
  const url = buildOpenAICompatibleModelsUrl(baseUrl)
  const payload = await fetchJson<any>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal
  })

  const data = requireModelList(payload, url, ['data', 'models', 'array'])
  // These compatible endpoints have no shared pagination request protocol.
  // An explicit continuation cannot qualify as a completed source refresh.
  if (!Array.isArray(payload)) {
    for (const field of ['has_more', 'hasMore']) {
      if (Object.prototype.hasOwnProperty.call(payload, field) && payload[field] !== false) {
        throw new Error(`${url} model list pagination is incomplete or malformed (${field})`)
      }
    }
    for (const field of ['next_page_token', 'nextPageToken', 'next_cursor', 'nextCursor', 'next']) {
      if (payload[field] != null && payload[field] !== '') {
        throw new Error(`${url} model list pagination is incomplete or malformed (${field})`)
      }
    }
  }
  requireModelIds(data, url, 'id')
  return data
}

async function fetchOpenAICompatibleModelIds(options: {
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
}): Promise<string[]> {
  const data = await fetchOpenAICompatibleModels(options)

  return data.map((entry: any) => safeString(entry?.id)).filter((id: string) => Boolean(id))
}

async function fetchOpenAIEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('OPENAI_API_KEY')
  if (!apiKey) {
    return []
  }

  const payload = await fetchJson<{ data: Array<{ id: string }> }>(OPENAI_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal: options.signal
  })

  const models = requireModelList(payload, 'OpenAI', ['data'])
  requireModelIds(models, 'OpenAI', 'id')
  options.onCompleteLiveList?.()
  return models.map((model) => ({ id: model.id }))
}

async function fetchGroqEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('GROQ_API_KEY')
  if (!apiKey) {
    return []
  }

  const ids = await fetchOpenAICompatibleModelIds({
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey,
    signal: options.signal
  })

  options.onCompleteLiveList?.()
  return ids.map((id) => ({ id }))
}

async function fetchDeepSeekEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('DEEPSEEK_API_KEY')
  if (!apiKey) {
    return []
  }

  const baseUrl = (await getRuntimeEnv('DEEPSEEK_API_BASE_URL')) || 'https://api.deepseek.com'
  const ids = await fetchOpenAICompatibleModelIds({
    baseUrl,
    apiKey,
    signal: options.signal
  })

  options.onCompleteLiveList?.()
  return ids.map((id) => ({ id }))
}

function mapDeepInfraModels(models: DeepInfraCatalogModel[]): DirectProviderEntry[] {
  return models
    .filter(
      (model) =>
        model?.reported_type === 'text-generation' &&
        model.private !== 1 &&
        model.deprecated == null &&
        !model.replaced_by
    )
    .map((model) => {
      const id = safeString(model.model_name).trim()
      const tags = Array.from(new Set([...(model.tags ?? []), 'chat'])).map((tag) => tag.toLowerCase())
      // BL-295: through the shared price rules (catalogPricing.ts), in cents per token.
      const cachedRate = readListedPrice(model.pricing?.rate_per_input_token_cached)
      const pricing = buildListedPricing({
        input: readListedCentsPerTokenPrice(model.pricing?.cents_per_input_token),
        output: readListedCentsPerTokenPrice(model.pricing?.cents_per_output_token),
        cachedInput:
          cachedRate === undefined
            ? undefined
            : readListedCentsPerTokenPrice(model.pricing?.cents_per_input_token, cachedRate)
      })

      return {
        id,
        displayName: id.split('/').pop() || id,
        description: model.description ?? undefined,
        tags,
        contextWindow: normalizePositiveInteger(model.max_tokens),
        pricing,
        modelType: 'chat'
      }
    })
    .filter((model) => Boolean(model.id))
}

async function fetchDeepInfraEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const payload = await fetchJson<DeepInfraCatalogModel[]>(DEEPINFRA_MODELS_ENDPOINT, {
    signal: options.signal
  })
  const models = requireModelList(payload, 'DeepInfra', ['array']) as DeepInfraCatalogModel[]
  requireModelIds(models, 'DeepInfra', 'model_name')
  const entries = mapDeepInfraModels(models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchTogetherEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('TOGETHER_API_KEY')
  if (!apiKey) return []

  const baseUrl = (await getRuntimeEnv('TOGETHER_API_BASE_URL')) || 'https://api.together.xyz/v1'
  const models = await fetchOpenAICompatibleModels({
    baseUrl,
    apiKey,
    signal: options.signal
  })
  const entries = mapTogetherModels(models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchFireworksEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('FIREWORKS_API_KEY')
  if (!apiKey) return []

  const collected: FireworksCatalogModel[] = []
  const seenPageTokens = new Set<string>()
  let pageToken: string | null = null

  do {
    const url = new URL(FIREWORKS_SERVERLESS_MODELS_ENDPOINT)
    url.searchParams.set('filter', 'supports_serverless=true')
    url.searchParams.set('pageSize', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const payload = await fetchJson<{
      models?: FireworksCatalogModel[]
      nextPageToken?: string | null
    }>(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: options.signal
    })

    const models = requireModelList(payload, 'Fireworks', ['models']) as FireworksCatalogModel[]
    requireModelIds(models, 'Fireworks', 'name')
    collected.push(...models)
    pageToken = readNextPageToken(payload, 'Fireworks', 'nextPageToken')
    if (pageToken && seenPageTokens.has(pageToken)) throw new Error('Fireworks model list repeated a page token')
    if (pageToken) seenPageTokens.add(pageToken)
  } while (pageToken)

  const entries = mapFireworksModels(collected)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchBasetenEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('BASETEN_API_KEY')
  if (!apiKey) return []

  const baseUrl = (await getRuntimeEnv('BASETEN_API_BASE_URL')) || 'https://inference.baseten.co/v1'
  const models = await fetchOpenAICompatibleModels({
    baseUrl,
    apiKey,
    signal: options.signal
  })
  const entries = mapBasetenModels(models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchCerebrasEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('CEREBRAS_API_KEY')
  if (!apiKey) return []

  const baseUrl = (await getRuntimeEnv('CEREBRAS_API_BASE_URL')) || 'https://api.cerebras.ai/v1'
  const models = await fetchOpenAICompatibleModels({
    baseUrl,
    apiKey,
    signal: options.signal
  })
  const entries = mapOpenAICompatibleCatalogModels('cerebras', models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchMiniMaxEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('MINIMAX_API_KEY')
  if (!apiKey) return []

  const baseUrl = (await getRuntimeEnv('MINIMAX_API_BASE_URL')) || 'https://api.minimax.io/v1'
  const models = await fetchOpenAICompatibleModels({
    baseUrl,
    apiKey,
    signal: options.signal
  })
  const entries = mapOpenAICompatibleCatalogModels('minimax', models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchMiniMaxTokenPlanEntries(
  options: SourceFetchOptions = {}
): Promise<DirectProviderEntry[]> {
  const curated = MANUAL_DIRECT_MODELS.minimax_token_plan ?? []
  const apiKey = await getRuntimeEnv('MINIMAX_TOKEN_PLAN_API_KEY')
  if (!apiKey) return curated

  const baseUrl =
    (await getRuntimeEnv('MINIMAX_TOKEN_PLAN_API_BASE_URL')) ||
    MINIMAX_TOKEN_PLAN_OPENAI_BASE_URL

  try {
    const models = await fetchOpenAICompatibleModels({ baseUrl, apiKey, signal: options.signal })
    const live = mapOpenAICompatibleCatalogModels('minimax_token_plan', models)
    options.onCompleteLiveList?.()
    if (live.length) return mergeDirectProviderEntries(live, curated)
  } catch (error) {
    options.onFallbackError?.(error)
    console.warn(
      '[catalog] MiniMax Token Plan model list fetch failed; falling back to the docs-backed list:',
      normalizeError(error)
    )
  }

  return curated
}

async function fetchMimoEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('MIMO_API_KEY')
  if (!apiKey) return []

  const baseUrl = (await getRuntimeEnv('MIMO_API_BASE_URL')) || 'https://api.xiaomimimo.com/v1'
  const models = await fetchOpenAICompatibleModels({
    baseUrl,
    apiKey,
    signal: options.signal
  })
  const entries = mapOpenAICompatibleCatalogModels('mimo', models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchMimoTokenPlanEntries(
  options: SourceFetchOptions = {}
): Promise<DirectProviderEntry[]> {
  const curated = MANUAL_DIRECT_MODELS.mimo_token_plan ?? []
  const apiKey = await getRuntimeEnv('MIMO_TOKEN_PLAN_API_KEY')
  if (!apiKey) return curated

  const baseUrl =
    (await getRuntimeEnv('MIMO_TOKEN_PLAN_API_BASE_URL')) ||
    MIMO_TOKEN_PLAN_OPENAI_BASE_URL

  try {
    const models = await fetchOpenAICompatibleModels({ baseUrl, apiKey, signal: options.signal })
    const live = mapOpenAICompatibleCatalogModels('mimo_token_plan', models)
    options.onCompleteLiveList?.()
    if (live.length) return mergeDirectProviderEntries(live, curated)
  } catch (error) {
    options.onFallbackError?.(error)
    console.warn(
      '[catalog] MiMo Token Plan model list fetch failed; falling back to the docs-backed list:',
      normalizeError(error)
    )
  }

  return curated
}

async function fetchQwenCloudEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('DASHSCOPE_API_KEY')
  if (!apiKey) return []

  const baseUrl =
    (await getRuntimeEnv('DASHSCOPE_API_BASE_URL')) ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  const models = await fetchOpenAICompatibleModels({
    baseUrl,
    apiKey,
    signal: options.signal
  })
  const entries = mapOpenAICompatibleCatalogModels('qwencloud', models)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchQwenTokenPlanEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const curated = MANUAL_DIRECT_MODELS.qwen_token_plan ?? []
  const apiKey = await getRuntimeEnv('QWEN_TOKEN_PLAN_API_KEY')
  if (!apiKey) return curated

  const baseUrl =
    (await getRuntimeEnv('QWEN_TOKEN_PLAN_API_BASE_URL')) ||
    QWEN_TOKEN_PLAN_OPENAI_BASE_URL

  try {
    const models = (await fetchOpenAICompatibleModels({
      baseUrl,
      apiKey,
      signal: options.signal
    })) as OpenAICompatibleCatalogModel[]
    const curatedById = new Map(curated.map((entry) => [entry.id, entry]))
    const live = models.flatMap((model): DirectProviderEntry[] => {
      const id = safeString(model.id).trim()
      if (!id) return []
      const curatedEntry = curatedById.get(id)
      const ownedBy = safeString(model.owned_by).trim()
      return [
        {
          id,
          developerId: ownedBy
            ? normalizeDeveloperId(ownedBy, 'qwen_token_plan')
            : curatedEntry?.developerId,
          modelId: id,
          effectiveId: id
        }
      ]
    })

    options.onCompleteLiveList?.()
    if (live.length) {
      return mergeDirectProviderEntries(live, curated)
    }
  } catch (error) {
    options.onFallbackError?.(error)
    console.warn(
      '[catalog] Qwen Token Plan model list fetch failed; falling back to the docs-backed list:',
      normalizeError(error)
    )
  }

  return curated
}

async function fetchMoonshotEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('MOONSHOT_API_KEY')
  if (!apiKey) {
    return []
  }

  const baseUrl = (await getRuntimeEnv('MOONSHOT_API_BASE_URL')) || 'https://api.moonshot.ai/v1'

  // Let the source status carry HTTP/auth/timeout errors. A manual list here
  // used to disguise a rejected key as a successful short provider response.
  const ids = await fetchOpenAICompatibleModelIds({ baseUrl, apiKey, signal: options.signal })
  options.onCompleteLiveList?.()
  return ids.map((id) => ({ id }))
}

async function fetchKimiCodeEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const curated = MANUAL_DIRECT_MODELS.kimi_code ?? []
  const apiKey = await getRuntimeEnv('KIMI_CODE_API_KEY')
  if (!apiKey) return curated

  const baseUrl = (await getRuntimeEnv('KIMI_CODE_API_BASE_URL')) || KIMI_CODE_OPENAI_BASE_URL

  try {
    const ids = await fetchOpenAICompatibleModelIds({ baseUrl, apiKey, signal: options.signal })
    options.onCompleteLiveList?.()
    if (ids.length) {
      return mergeDirectProviderEntries(
        ids.map((id) => ({
          id,
          developerId: 'moonshotai',
          modelId: id,
          effectiveId: id
        })),
        curated
      )
    }
  } catch (error) {
    options.onFallbackError?.(error)
    console.warn(
      '[catalog] Kimi Code model list fetch failed; falling back to the docs-backed list:',
      normalizeError(error)
    )
  }

  return curated
}

async function fetchZaiEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('ZAI_API_KEY')
  if (!apiKey) {
    return []
  }

  const curated = MANUAL_DIRECT_MODELS.zai ?? []
  const baseUrl = (await getRuntimeEnv('ZAI_API_BASE_URL')) || 'https://api.z.ai/api/paas/v4'

  try {
    const ids = await fetchOpenAICompatibleModelIds({
      baseUrl,
      apiKey,
      signal: options.signal
    })

    options.onCompleteLiveList?.()
    if (ids.length) {
      return mergeDirectProviderEntries(
        ids.map((id) => ({ id })),
        curated
      )
    }
  } catch (error) {
    options.onFallbackError?.(error)
    console.warn('[catalog] Z.ai model list fetch failed; falling back to manual list:', normalizeError(error))
  }

  return curated
}

async function fetchZaiCodingEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('ZAI_CODING_API_KEY')
  const curated = MANUAL_DIRECT_MODELS.zai_coding ?? []
  if (!apiKey) {
    return curated
  }

  const baseUrl = (await getRuntimeEnv('ZAI_CODING_API_BASE_URL')) || ZAI_CODING_PLAN_OPENAI_BASE_URL

  try {
    const ids = await fetchOpenAICompatibleModelIds({
      baseUrl,
      apiKey,
      signal: options.signal
    })

    const currentAndFutureIds = filterZaiCodingPlanModelIds(ids)
    options.onCompleteLiveList?.()
    if (currentAndFutureIds.length) {
      return mergeDirectProviderEntries(
        currentAndFutureIds.map((id) => ({ id, developerId: 'zai', modelId: id, effectiveId: id })),
        curated
      )
    }
  } catch (error) {
    options.onFallbackError?.(error)
    console.warn(
      '[catalog] Z.ai Coding Plan model list fetch failed; falling back to manual list:',
      normalizeError(error)
    )
  }

  return curated
}

const ZAI_CODING_PLAN_LEGACY_MODEL_ID_SET = new Set<string>(ZAI_CODING_PLAN_LEGACY_MODEL_IDS)

function filterZaiCodingPlanModelIds(ids: string[]): string[] {
  return ids.filter((id) => !ZAI_CODING_PLAN_LEGACY_MODEL_ID_SET.has(id.trim().toLowerCase()))
}

function applyDirectSourceCatalogPolicy(
  provider: DirectProviderId,
  entries: CatalogEntry[]
): CatalogEntry[] {
  if (provider === 'openai') {
    // BL-68: completions-only models cannot run on Batshit's OpenAI connection.
    return entries.filter((entry) => !isOpenAICompletionsOnlyModel(entry.name))
  }
  if (provider !== 'zai_coding') return entries
  return entries.filter(
    (entry) => !ZAI_CODING_PLAN_LEGACY_MODEL_ID_SET.has(entry.name.trim().toLowerCase())
  )
}

export function _filterZaiCodingPlanModelIdsForTest(ids: string[]): string[] {
  return filterZaiCodingPlanModelIds(ids)
}

async function fetchFalEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = (await getRuntimeEnv('FAL_API_KEY')) || (await getRuntimeEnv('FAL_KEY'))
  if (!apiKey) {
    return []
  }
  const headers = { Authorization: `Key ${apiKey}` }
  const limit = 200
  const maxPages = 200
  let cursor: string | null = null
  const collected: DirectProviderEntry[] = []
  const seen = new Set<string>()
  const seenCursors = new Set<string>()
  let pages = 0

  while (pages < maxPages) {
    const url = new URL(FAL_MODELS_ENDPOINT)
    url.searchParams.set('limit', String(limit))
    if (cursor) url.searchParams.set('cursor', cursor)
    const payload: { models?: any[]; next_cursor?: string | null } = await fetchJson<any>(url.toString(), {
      headers,
      signal: options.signal
    })
    const models = requireModelList(payload, 'Fal', ['models'])
    requireModelIds(models, 'Fal', 'endpoint_id')

    for (const model of models) {
      const endpointId = safeString(model?.endpoint_id).trim()
      if (!endpointId || seen.has(endpointId)) continue
      seen.add(endpointId)

      const metadata = model?.metadata ?? {}
      const category = safeString(metadata?.category).trim().toLowerCase()
      const tags = buildFalTags(category, metadata?.tags)
      const modelType = mapFalCategoryToModelType(category, tags)
      const identifiers = resolveFalEntryIdentifiers(endpointId)
      collected.push({
        id: endpointId,
        developerId: identifiers.developerId,
        modelId: identifiers.modelId,
        effectiveId: identifiers.effectiveId,
        displayName: safeString(metadata?.display_name).trim() || undefined,
        description: safeString(metadata?.description).trim() || undefined,
        tags,
        modelType
      })
    }

    cursor = readNextPageToken(payload, 'Fal', 'next_cursor')
    if (!cursor) break
    if (seenCursors.has(cursor)) throw new Error('Fal model list repeated a cursor')
    seenCursors.add(cursor)
    pages += 1
  }

  if (cursor) throw new Error(`Fal model list incomplete after ${maxPages} pages`)
  options.onCompleteLiveList?.()

  if (!collected.length) {
    return MANUAL_DIRECT_MODELS.fal ?? []
  }

  return collected
}

async function fetchLumaEntries(_options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('LUMA_API_KEY')
  if (!apiKey) {
    return []
  }
  return MANUAL_DIRECT_MODELS.luma ?? []
}

async function fetchReplicateEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('REPLICATE_API_KEY')
  if (!apiKey) {
    return []
  }
  const headers = { Authorization: `Bearer ${apiKey}` }
  const collected: DirectProviderEntry[] = []
  const seen = new Set<string>()
  const payload: { models?: any[] } = await fetchJson<any>(REPLICATE_OFFICIAL_COLLECTION_ENDPOINT, {
    headers,
    signal: options.signal
  })
  const models = requireModelList(payload, 'Replicate', ['models'])

  for (const model of models) {
    if (!model || typeof model !== 'object' || typeof model.is_official !== 'boolean') {
      throw new Error('Replicate model list has a malformed official model flag')
    }
    if (model?.is_official !== true) continue
    if (typeof model.owner !== 'string' || !model.owner.trim() ||
      typeof model.name !== 'string' || !model.name.trim()) {
      throw new Error('Replicate model list has an official row without owner/name')
    }
    const owner = model.owner.trim()
    const name = model.name.trim()
    const fullId = `${owner}/${name}`
    if (seen.has(fullId)) continue
    seen.add(fullId)

    const description = safeString(model?.description).trim()
    const tags = inferTagsFromIdentifier(fullId, description)
    collected.push({
      id: fullId,
      developerId: owner,
      modelId: name,
      displayName: safeString(model?.display_name).trim() || undefined,
      description: description || undefined,
      tags
    })
  }

  options.onCompleteLiveList?.()
  if (!collected.length) {
    return MANUAL_DIRECT_MODELS.replicate ?? []
  }

  return collected
}

async function fetchXAIEntries(_options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('XAI_API_KEY')
  if (!apiKey) {
    return []
  }
  return MANUAL_DIRECT_MODELS.xai ?? []
}

async function fetchElevenLabsEntries(_options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('ELEVENLABS_API_KEY')
  if (!apiKey) {
    return []
  }
  return MANUAL_DIRECT_MODELS.elevenlabs ?? []
}

async function fetchDeepgramEntries(_options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('DEEPGRAM_API_KEY')
  if (!apiKey) {
    return []
  }
  return MANUAL_DIRECT_MODELS.deepgram ?? []
}

async function fetchAssemblyAiEntries(_options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('ASSEMBLYAI_API_KEY')
  if (!apiKey) {
    return []
  }
  return MANUAL_DIRECT_MODELS.assemblyai ?? []
}

async function fetchCohereEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('COHERE_API_KEY')
  if (!apiKey) return []

  const collected: CohereCatalogModel[] = []
  const seenPageTokens = new Set<string>()
  let pageToken: string | null = null
  do {
    const url = new URL(COHERE_MODELS_ENDPOINT)
    url.searchParams.set('page_size', '1000')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const payload = await fetchJson<{ models?: CohereCatalogModel[]; next_page_token?: string | null }>(
      url.toString(),
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: options.signal }
    )
    const models = requireModelList(payload, 'Cohere', ['models']) as CohereCatalogModel[]
    requireModelIds(models, 'Cohere', 'name')
    collected.push(...models)
    pageToken = readNextPageToken(payload, 'Cohere', 'next_page_token')
    if (pageToken && seenPageTokens.has(pageToken)) throw new Error('Cohere model list repeated a page token')
    if (pageToken) seenPageTokens.add(pageToken)
  } while (pageToken)

  const entries = mapCohereModels(collected)
  options.onCompleteLiveList?.()
  return entries
}

async function fetchMistralEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('MISTRAL_API_KEY')
  if (!apiKey) {
    return []
  }

  const payload = await fetchJson<any>(MISTRAL_MODELS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    signal: options.signal
  })

  const data = requireModelList(payload, 'Mistral', ['data', 'array'])
  requireModelIds(data, 'Mistral', 'id')

  const entries = data
    .map((model: any) => ({
      id: safeString(model?.id),
      description: safeString(model?.description) || undefined,
      contextWindow: typeof model?.max_context_length === 'number' ? model.max_context_length : undefined,
      modelType: safeString(model?.TYPE || model?.type || null) || null
    }))
    .filter((model: DirectProviderEntry) => Boolean(model.id))
  options.onCompleteLiveList?.()
  return entries
}

type GoogleGeminiModel = {
  name?: string
  baseModelId?: string
  displayName?: string
  description?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
}

async function fetchGoogleEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('GOOGLE_GENERATIVE_AI_API_KEY')
  if (!apiKey) {
    return []
  }

  const entries: DirectProviderEntry[] = []
  let pageToken: string | null = null
  const seenPageTokens = new Set<string>()

  do {
    const url = new URL(GOOGLE_GEMINI_MODELS_ENDPOINT)
    url.searchParams.set('pageSize', '1000')
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }

    const payload = await fetchJson<{
      models?: GoogleGeminiModel[]
      nextPageToken?: string
    }>(url.toString(), {
      headers: {
        'x-goog-api-key': apiKey
      },
      signal: options.signal
    })

    const models = requireModelList(payload, 'Google', ['models']) as GoogleGeminiModel[]
    if (models.some((model) => !model || typeof model !== 'object' ||
      ![model.name, model.baseModelId].some((id) => typeof id === 'string' && id.trim()))) {
      throw new Error('Google model list has a row without name/baseModelId')
    }
    for (const model of models) {
      const rawName = safeString(model?.name)
      const id = rawName.startsWith('models/')
        ? rawName.slice('models/'.length)
        : rawName || safeString(model?.baseModelId)

      if (!id) continue

      entries.push({
        id,
        displayName: safeString(model?.displayName) || undefined,
        description: safeString(model?.description) || undefined,
        contextWindow: typeof model?.inputTokenLimit === 'number' ? model.inputTokenLimit : undefined,
        maxOutputTokens: typeof model?.outputTokenLimit === 'number' ? model.outputTokenLimit : undefined
      })
    }

    pageToken = readNextPageToken(payload, 'Google', 'nextPageToken')
    if (pageToken && seenPageTokens.has(pageToken)) throw new Error('Google model list repeated a page token')
    if (pageToken) seenPageTokens.add(pageToken)
  } while (pageToken)

  options.onCompleteLiveList?.()
  return entries
}

type AnthropicModelInfo = {
  id: string
  display_name?: string
  created_at?: string
  type?: string
  /** The context window (Models API, since March 2026). */
  max_input_tokens?: number | null
  /** The output cap. */
  max_tokens?: number | null
  /** A tree of `{ supported: boolean }` leaves, such as `image_input` and `thinking`. */
  capabilities?: Record<string, unknown> | null
}

/**
 * BL-199: Anthropic's own list reports `max_input_tokens` 1,000,000 for Sonnet
 * 4.5, but Anthropic's context-window guide (checked 2026-09-25) says "Other
 * Claude models, including Claude Sonnet 4.5, have a 200k-token context window":
 * its 1M window needs a beta header Batshit's direct connection does not send.
 * This is the only model where the two disagree.
 */
const ANTHROPIC_DIRECT_WINDOW_WITHOUT_BETA: ReadonlyArray<{ idPrefix: string; contextWindow: number }> = [
  { idPrefix: 'claude-sonnet-4-5', contextWindow: 200_000 }
]

function anthropicCapabilitySupported(capabilities: Record<string, unknown> | null | undefined, name: string) {
  const leaf = capabilities?.[name]
  return Boolean(leaf && typeof leaf === 'object' && (leaf as { supported?: unknown }).supported === true)
}

/**
 * BL-199: the direct connection's own limits and capabilities, as Anthropic's
 * `GET /v1/models` lists them, so the per-connection limits of a merged row
 * are Anthropic's real numbers instead of unknown.
 */
function mapAnthropicModels(models: AnthropicModelInfo[]): DirectProviderEntry[] {
  const entries: DirectProviderEntry[] = []
  for (const model of models) {
    const id = safeString(model?.id)
    if (!id) continue
    const listedWindow = normalizePositiveInteger(model?.max_input_tokens)
    const withoutBeta = ANTHROPIC_DIRECT_WINDOW_WITHOUT_BETA.find((rule) => id.startsWith(rule.idPrefix))
    const contextWindow =
      listedWindow !== undefined && withoutBeta ? Math.min(listedWindow, withoutBeta.contextWindow) : listedWindow
    const tags = [
      ...(anthropicCapabilitySupported(model?.capabilities, 'image_input') ? ['vision'] : []),
      ...(anthropicCapabilitySupported(model?.capabilities, 'thinking') ? ['reasoning'] : [])
    ]
    entries.push({
      id,
      displayName: safeString(model?.display_name) || undefined,
      modelType: safeString(model?.type) || 'model',
      tags,
      contextWindow,
      maxOutputTokens: normalizePositiveInteger(model?.max_tokens)
    })
  }
  return entries
}

async function fetchAnthropicEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return []
  }

  const entries: DirectProviderEntry[] = []
  let afterId: string | null = null
  const seenAfterIds = new Set<string>()

  do {
    const url = new URL(ANTHROPIC_ENDPOINT)
    url.searchParams.set('limit', '1000')
    if (afterId) {
      url.searchParams.set('after_id', afterId)
    }

    const payload = await fetchJson<{
      data: AnthropicModelInfo[]
      has_more: boolean
      last_id?: string | null
    }>(url.toString(), {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': (await getRuntimeEnv('ANTHROPIC_VERSION')) || '2023-06-01'
      },
      signal: options.signal
    })

    const models = requireModelList(payload, 'Anthropic', ['data']) as AnthropicModelInfo[]
    requireModelIds(models, 'Anthropic', 'id')
    if (typeof payload.has_more !== 'boolean') throw new Error('Anthropic model list has malformed has_more')
    entries.push(...mapAnthropicModels(models))

    afterId = payload.has_more ? readNextPageToken(payload, 'Anthropic', 'last_id') : null
    if (payload.has_more && !afterId) throw new Error('Anthropic model list is incomplete: has_more without last_id')
    if (afterId && seenAfterIds.has(afterId)) throw new Error('Anthropic model list repeated last_id')
    if (afterId) seenAfterIds.add(afterId)
  } while (afterId)

  options.onCompleteLiveList?.()
  return entries
}

async function fetchGatewayEntries(options: SourceFetchOptions = {}): Promise<CatalogEntry[]> {
  const payload = await fetchJson<{
    data?: GatewayModel[]
    models?: GatewayModel[]
  }>(GATEWAY_ENDPOINT, {
    signal: options.signal
  })
  const rawModels = requireModelList(payload, 'Gateway', ['data', 'models']) as GatewayModel[]
  requireModelIds(rawModels, 'Gateway', 'id')
  return rawModels.map(mapGatewayModelToCatalogEntry)
}

function mapGatewayModelToCatalogEntry(raw: GatewayModel): CatalogEntry {
  const provider = normalizeProvider(raw.id)
  const name = raw.id.split('/').slice(1).join('/') || raw.name
  const canonicalId = buildCanonicalId(provider, name)
  const tags = (raw.tags ?? []).map((tag) => tag.toLowerCase())
  // A window of 0 (the gateway lists one for mistral-embed and minimax-h3) is
  // unknown, never published as 0: blank sends nothing.
  const contextWindow = normalizePositiveInteger(raw.context_window ?? raw.max_tokens)
  const pricing = mapPricing(raw.pricing, gatewayZeroPriceContext(raw))
  const purpose = inferModelPurpose({
    modelType: raw.type ?? null,
    id: raw.id,
    name,
    tags
  })

  return {
    id: raw.id,
    canonicalId,
    provider,
    upstreamProvider: 'vercel',
    name,
    displayName: raw.name,
    description: raw.description,
    tags,
    contextWindow,
    maxOutputTokens: sanitizeCatalogMaxOutputTokens({
      maxOutputTokens: raw.max_tokens,
      contextWindow
    }),
    purpose,
    pricing,
    features: deriveFeatures(tags, contextWindow, pricing),
    category: categorizeModel(tags, contextWindow),
    source: 'vercel' as const,
    transport: 'vercel-gateway' as const,
    connectionId: 'vercel-gateway' as const,
    modelType: raw.type ?? null
  }
}

async function fetchOpenRouterEntries(options: SourceFetchOptions = {}): Promise<CatalogEntry[]> {
  const apiKey = await getRuntimeEnv('OPENROUTER_API_KEY')
  const payload = await fetchJson<{ data: OpenRouterModel[] }>(OPENROUTER_ENDPOINT, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: options.signal
  })

  const models = requireModelList(payload, 'OpenRouter', ['data']) as OpenRouterModel[]
  requireModelIds(models, 'OpenRouter', 'id')
  return models.map(mapOpenRouterModelToCatalogEntry)
}

function mapOpenRouterModelToCatalogEntry(raw: OpenRouterModel): CatalogEntry {
  const tags = deriveOpenRouterTags(raw)
  // A window of 0 is unknown, never published as 0.
  const contextWindow = normalizePositiveInteger(raw.context_length)
  const outputContextWindow = raw.top_provider?.context_length ?? contextWindow
  const pricing = mapPricing(raw.pricing as Record<string, unknown>, openRouterZeroPriceContext(raw))
  const provider = normalizeProvider(raw.id)
  const name = raw.id.split('/').slice(1).join('/') || raw.name
  const canonicalId = buildCanonicalId(provider, name)
  const purpose = inferModelPurpose({
    modelType: null,
    id: raw.id,
    name,
    tags
  })

  return {
    id: raw.id,
    canonicalId,
    provider,
    upstreamProvider: 'openrouter',
    name,
    displayName: normalizeOpenRouterDisplayName(raw.name, provider),
    description: raw.description,
    tags,
    contextWindow,
    maxOutputTokens: sanitizeCatalogMaxOutputTokens({
      maxOutputTokens: raw.top_provider?.max_completion_tokens,
      contextWindow: outputContextWindow,
      unknownContextCeiling: 64_000
    }),
    purpose,
    pricing,
    features: deriveOpenRouterFeatures(raw, tags, pricing),
    category: categorizeModel(tags, contextWindow),
    source: 'openrouter' as const,
    transport: 'openrouter' as const,
    connectionId: 'openrouter' as const
  }
}

function deriveOpenRouterTags(model: OpenRouterModel) {
  const tags = new Set<string>()
  if (model.architecture?.input_modalities?.some((input) => input.toLowerCase() === 'image')) {
    tags.add('vision')
  }
  if (model.supported_parameters?.some((param) => param.includes('tool'))) {
    tags.add('tool-use')
  }
  if (model.supported_parameters?.includes('include_reasoning') || model.supported_parameters?.includes('reasoning')) {
    tags.add('reasoning')
  }
  if ((model.supported_parameters ?? []).some((param) => param.includes('code'))) {
    tags.add('code')
  }
  if ((model.context_length ?? 0) >= 128_000) {
    tags.add('powerful')
  }
  return Array.from(tags)
}

function deriveOpenRouterFeatures(model: OpenRouterModel, tags: string[], pricing?: ReturnType<typeof mapPricing>) {
  const features = deriveFeatures(tags, model.context_length, pricing)
  if (model.supported_parameters?.includes('reasoning') || model.supported_parameters?.includes('include_reasoning')) {
    features.reasoning = true
  }
  if (model.architecture?.input_modalities?.some((input) => input.toLowerCase() === 'image')) {
    features.vision = true
  }
  features.tools = model.supported_parameters?.some((param) => param.includes('tool')) ?? false
  features.streaming = true
  return features
}

async function fetchArtificialAnalysis(options: SourceFetchOptions = {}) {
  const apiKey = await getRuntimeEnv('ARTIFICIAL_ANALYSIS_API_KEY')
  if (!apiKey) {
    logger.debug('[catalog] ARTIFICIAL_ANALYSIS_API_KEY not set - skipping AA enrichment')
    return new Map<string, any>()
  }

  const payload = await fetchJson<{ data: any[] }>(AA_ENDPOINT, {
    headers: {
      'x-api-key': apiKey
    },
    signal: options.signal
  })

  const map = new Map<string, any>()
  for (const entry of payload.data ?? []) {
    const key = normalizeName(entry.slug || entry.name)
    if (key) {
      map.set(key, entry)
    }
  }
  return map
}

function normalizeName(value?: string | null) {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
}

/**
 * Record, before Artificial Analysis fills in model-wide numbers, the limits
 * and price this connection's own source listed (BL-68, BL-132), and what a
 * reviewed identity rule says the entry is (BL-68).
 */
function recordOwnNumbers(entry: CatalogEntry): CatalogEntry {
  const reviewed = resolveReviewedCatalogIdentity(entry)
  return {
    ...entry,
    ...(reviewed ? { identityName: reviewed.name, identityRule: reviewed.rule } : {}),
    ownLimits: {
      contextWindow: normalizePositiveInteger(entry.contextWindow) ?? null,
      maxOutputTokens: normalizePositiveInteger(entry.maxOutputTokens) ?? null
    },
    ownPricing: entry.pricing ? buildListedPricing(entry.pricing) ?? null : null
  }
}

function enrichWithAA(entry: CatalogEntry, aaMap: Map<string, any>) {
  const match = aaMap.get(normalizeName(entry.identityName ?? entry.name))
  if (!match) return entry

  // A price this entry's own source listed wins (decision A, 2026-09-25): it is
  // what that connection charges. Artificial Analysis fills only an entry that
  // lists no price at all, and never partly, so an embedding row's lone input
  // price gains no invented output price. AA lists 0 for a price it does not
  // know (BL-130), so only a positive number of theirs is a price.
  const listsOwnPrice = Boolean(entry.pricing && buildListedPricing(entry.pricing))
  const pricing =
    match.pricing && !listsOwnPrice
      ? buildListedPricing({
          input:
            readArtificialAnalysisPrice(match.pricing.price_1m_input_tokens) ??
            readArtificialAnalysisPrice(match.pricing.price_1m_blended_3_to_1),
          output: readArtificialAnalysisPrice(match.pricing.price_1m_output_tokens)
        })
      : entry.pricing
  const contextWindow =
    normalizePositiveInteger(
      match.context_window ?? match.context_window_tokens ?? match.context ?? match.max_context
    ) ?? entry.contextWindow

  return {
    ...entry,
    aaSlug: typeof match.slug === 'string' && match.slug.trim().length ? match.slug.trim() : entry.aaSlug,
    pricing,
    contextWindow,
    maxOutputTokens: sanitizeCatalogMaxOutputTokens({
      maxOutputTokens: entry.maxOutputTokens,
      contextWindow
    })
  }
}

type CatalogMergeKey = string

function buildCatalogMergeKey(
  entry: Pick<CatalogEntry, 'provider' | 'canonicalId' | 'aaSlug' | 'identityName'>
): CatalogMergeKey {
  const developerId = canonicalizeCatalogDeveloperId(entry.provider)
  const aaSlug = entry.aaSlug?.trim().toLowerCase()
  if (developerId && aaSlug) return `${developerId}::aa:${aaSlug}`
  // BL-68: a reviewed identity (Anthropic's dated snapshot) keys as its alias.
  const canonicalId = entry.identityName ? buildCanonicalId(entry.provider, entry.identityName) : entry.canonicalId
  const [, ...modelParts] = canonicalId.split('/')
  return developerId && modelParts.length
    ? `${developerId}/${modelParts.join('/')}`
    : canonicalId
}

type MergedRowNumbers = Pick<CatalogEntry, 'contextWindow' | 'maxOutputTokens' | 'pricing'>

/**
 * BL-68 / BL-132: the limits a connection keeps on its variant. A connection
 * that joined through a reviewed identity rule always keeps its own (`null` =
 * unknown, never the row's). Any other connection keeps its own when a limit
 * its source listed differs from the row's (a limit it did not list is `null`,
 * never borrowed); one that listed none, or listed the row's, takes the row's.
 */
function ownLimitsForVariant(entry: CatalogEntry, isBase: boolean, row: MergedRowNumbers) {
  const own = entry.ownLimits
  if (!own) return undefined
  if (entry.identityRule) return own
  if (isBase) return undefined
  const differs =
    (own.contextWindow !== null && own.contextWindow !== (normalizePositiveInteger(row.contextWindow) ?? null)) ||
    (own.maxOutputTokens !== null && own.maxOutputTokens !== (normalizePositiveInteger(row.maxOutputTokens) ?? null))
  return differs ? own : undefined
}

/**
 * BL-295 review: each direct connection that is a model maker's own API, and
 * the catalog developer ids of that maker. Vercel AI Gateway charges "the
 * provider's list price with no platform markup on tokens"
 * (https://vercel.com/docs/ai-gateway/pricing), so on a gateway-based row the
 * row's price is what the maker's own API charges. Reviewed by hand, like the
 * developer aliases; a subscription plan counts as its maker's own API.
 */
const MAKERS_OWN_CONNECTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'direct:openai': ['openai'],
  'direct:anthropic': ['anthropic'],
  'direct:google': ['google'],
  'direct:mistral': ['mistral'],
  'direct:xai': ['xai', 'x-ai', 'spacexai'],
  'direct:deepseek': ['deepseek'],
  'direct:moonshot': ['moonshotai'],
  'direct:kimi_code': ['moonshotai'],
  'direct:zai': ['zai'],
  'direct:zai_coding': ['zai'],
  'direct:cohere': ['cohere'],
  'direct:minimax': ['minimax'],
  'direct:minimax_token_plan': ['minimax'],
  'direct:mimo': ['xiaomi'],
  'direct:mimo_token_plan': ['xiaomi'],
  'direct:qwencloud': ['qwen', 'alibaba'],
  'direct:qwen_token_plan': ['qwen', 'alibaba'],
  'direct:fireworks': ['fireworks']
})

/** BL-295 review: the maker's own API on a row whose price is the gateway's list price. */
function takesGatewayListPrice(connectionId: string, rowDeveloper: string, baseConnectionId: string | undefined) {
  if (baseConnectionId !== 'vercel-gateway') return false
  return (MAKERS_OWN_CONNECTIONS[connectionId] ?? []).includes(canonicalizeCatalogDeveloperId(rowDeveloper))
}

function samePricing(left: ListedPricing, right: ListedPricing | undefined, allowUnlisted: boolean) {
  return !(['input', 'output', 'cachedInput'] as const).some((field) => {
    const mine = left[field]
    const rows = right?.[field]
    if (mine === undefined) return !allowUnlisted && rows !== undefined
    if (rows === undefined) return true
    // DeepInfra's cents-per-token arithmetic once listed $3 as 2.9999999999999996.
    return Math.abs(mine - rows) > 1e-9 * Math.max(1, Math.abs(mine), Math.abs(rows))
  })
}

/**
 * The price a connection keeps on its variant (absent: it takes the row's).
 * - BL-132: a connection keeps the price its own source listed when a price it
 *   listed differs from the row's (an open-model host such as DeepInfra or
 *   Together sells the gateway's model at its own price); a price it did not
 *   list is then unknown, never borrowed. One that listed the row's takes it.
 * - BL-295 review, replacing BL-132's "one that listed none takes the row's"
 *   for every connection but the maker's own API on a gateway-based row: a
 *   connection that lists no price never shows another host's. It keeps the
 *   price it had on its own (Artificial Analysis's, which lists no cached
 *   price), or an empty price (Unknown) when AA names none. Qwen Cloud's
 *   qwen3-max had taken OpenRouter's $0.78 over Alibaba's $1.2.
 */
function ownPricingForVariant(entry: CatalogEntry, base: CatalogEntry | undefined, row: MergedRowNumbers) {
  if (entry === base) return undefined
  const takesGatewayPrice = base
    ? takesGatewayListPrice(entry.connectionId, base.provider, base.connectionId)
    : false
  const listed = entry.ownPricing
  if (listed) return samePricing(listed, row.pricing, takesGatewayPrice) ? undefined : listed
  if (takesGatewayPrice) return undefined
  const alone = entry.pricing ? buildListedPricing(entry.pricing) : undefined
  if (!alone) return row.pricing && buildListedPricing(row.pricing) ? {} : undefined
  return samePricing(alone, row.pricing, false) ? undefined : alone
}

function buildIdVariants(entries: CatalogEntry[], base?: CatalogEntry, row?: MergedRowNumbers) {
  const variants: NonNullable<CatalogEntry['idVariants']> = {}

  for (const entry of entries) {
    if (!entry?.connectionId) continue
    const isBase = entry === base
    const limits = ownLimitsForVariant(entry, isBase, row ?? entry)
    const pricing = ownPricingForVariant(entry, base, row ?? entry)
    variants[entry.connectionId] = {
      developerId: entry.provider,
      modelId: entry.name,
      effectiveId: entry.id,
      source: entry.source,
      ...(limits ? { limits } : {}),
      ...(pricing ? { pricing } : {})
    }

    for (const [connectionId, variant] of Object.entries(entry.idVariants ?? {})) {
      variants[connectionId] = variant
    }
  }

  return Object.keys(variants).length ? variants : undefined
}

/** BL-68 (bug-batch find b): what the merge guard did with a same-connection collision. */
type VariantCollision = CatalogSyncVariantCollision

function withoutWorkingFields(entry: CatalogEntry): CatalogEntry {
  const {
    identityName: _identityName,
    identityRule: _identityRule,
    ownLimits: _ownLimits,
    ownPricing: _ownPricing,
    ...published
  } = entry
  return published
}

/**
 * BL-68 (bug-batch find b): a row holds one variant per connection, and a second
 * entry of the same connection in one group used to vanish without a word (the
 * 2026-09-22 registry listed 53 Mistral entries but carried 52 variants).
 *
 * The entry whose variant the row has always published keeps it (the last one,
 * as before), so no saved preset changes model. Each other entry is returned to
 * become a row of its own. A reviewed identity rule must never cause this: it
 * would be a wrong merge, so the sync refuses to publish.
 */
function findSameConnectionLosers(
  key: CatalogMergeKey,
  group: CatalogEntry[],
  collisions: VariantCollision[]
): Map<CatalogEntry, VariantCollision> {
  const byConnection = new Map<string, CatalogEntry[]>()
  for (const entry of group) {
    const connections = new Set(
      [entry.connectionId, ...Object.keys(entry.idVariants ?? {})].filter((value): value is string => Boolean(value))
    )
    for (const connectionId of connections) {
      byConnection.set(connectionId, [...(byConnection.get(connectionId) ?? []), entry])
    }
  }

  const losers = new Map<CatalogEntry, VariantCollision>()
  for (const [connectionId, list] of byConnection) {
    if (list.length < 2) continue
    if (list.some((entry) => entry.identityRule)) {
      throw new Error(
        `Catalog sync refused to publish: the reviewed identity rule put ${list.length} ${connectionId} entries ` +
          `in one row (${list.map((entry) => entry.id).join(', ')}).`
      )
    }
    const kept = list[list.length - 1]
    const collision: VariantCollision = { group: key, connectionId, kept: kept.id, split: [], dropped: [] }
    collisions.push(collision)
    for (const loser of list.slice(0, -1)) {
      if (!losers.has(loser)) losers.set(loser, collision)
    }
  }
  return losers
}

/**
 * BL-295: whether this entry shows a name rather than the bare id it sends. A
 * list that names nothing (MiMo's and DashScope's `/models`) leaves the id as
 * the name, so a merged MiMo audio row showed "mimo-v2.5-asr" beside the plan's
 * "MiMo V2.5 ASR". Only such a row borrows a name: a derived name (DeepInfra's
 * "DeepSeek-R1-0528") stays, so a host's own label ("... NVFP4") never lands
 * on another host's row.
 */
function listsOwnDisplayName(entry: CatalogEntry): boolean {
  const displayName = entry.displayName?.trim()
  return Boolean(displayName) && displayName !== entry.id
}

function buildMergedRow(group: CatalogEntry[], members: CatalogEntry[]): CatalogEntry | null {
  const base =
    group.find((entry) => entry.source === 'vercel') ??
    group.find((entry) => entry.source === 'openrouter') ??
    group.find((entry) => entry.source === 'direct') ??
    group[0]
  if (!base) return null

  const rowNumbers: MergedRowNumbers = {
    // BL-295: the row's price is its base's (with Artificial Analysis's when the
    // base lists none), never another connection's: a member that lists its own
    // price keeps it on its variant, and the base's own price stays unknown.
    pricing: base.pricing,
    // BL-572: the same for limits. A base that lists no window or output cap
    // leaves the row's unknown; a member's own limits stay on its variant
    // (`ownLimitsForVariant`), so they never become the limits of every
    // connection that takes the row's.
    contextWindow: base.contextWindow,
    maxOutputTokens: base.maxOutputTokens
  }
  const idVariants = buildIdVariants(members, base, rowNumbers) ?? base.idVariants
  const availableConnections = Array.from(
    new Set([...members.map((entry) => entry.connectionId), ...Object.keys(idVariants ?? {})].filter(Boolean))
  )

  const purpose = mergePurpose(group.map((entry) => entry.purpose))

  return withoutWorkingFields({
    ...base,
    // The group lists its base first (gateway, OpenRouter, then direct), so a
    // base with a name of its own keeps it.
    displayName: group.find(listsOwnDisplayName)?.displayName ?? base.displayName,
    canonicalId: buildCanonicalId(base.provider, base.name),
    provider: canonicalizeCatalogDeveloperId(base.provider),
    ...rowNumbers,
    description: base.description ?? group.find((entry) => entry.description)?.description,
    tags: Array.from(new Set(group.flatMap((entry) => entry.tags ?? []))),
    availableConnections,
    purpose,
    idVariants
  })
}

function mergeCatalogEntriesWithReport(entries: CatalogEntry[]): {
  models: CatalogEntry[]
  variantCollisions: VariantCollision[]
} {
  const groups = new Map<CatalogMergeKey, CatalogEntry[]>()

  for (const entry of entries) {
    const key = buildCatalogMergeKey(entry)
    if (!key) continue
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(entry)
  }

  const merged: CatalogEntry[] = []
  const variantCollisions: VariantCollision[] = []
  const pendingSplits: Array<{ entry: CatalogEntry; collision: VariantCollision }> = []

  for (const [key, group] of groups) {
    const losers = findSameConnectionLosers(key, group, variantCollisions)
    const row = buildMergedRow(group, losers.size ? group.filter((entry) => !losers.has(entry)) : group)
    if (row) merged.push(row)
    for (const [entry, collision] of losers) pendingSplits.push({ entry, collision })
  }

  // A split entry becomes a row of its own only when no row uses its canonical id:
  // instances merge rows by canonical id (`/api/models`), which would drop it again.
  const usedCanonicalIds = new Set(merged.map((row) => row.canonicalId))
  for (const { entry, collision } of pendingSplits) {
    const row = buildMergedRow([entry], [entry])
    if (!row || usedCanonicalIds.has(row.canonicalId)) {
      collision.dropped.push(entry.id)
      continue
    }
    usedCanonicalIds.add(row.canonicalId)
    merged.push(row)
    collision.split.push(entry.id)
  }

  return { models: merged, variantCollisions }
}

function mergeCatalogEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return mergeCatalogEntriesWithReport(entries).models
}

type CatalogIdentityIssue = {
  catalogId: string
  connectionId: string
  reason: 'missing-variant' | 'incomplete-variant'
}

function findCatalogIdentityIssues(models: CatalogEntry[]): CatalogIdentityIssue[] {
  const issues: CatalogIdentityIssue[] = []

  for (const model of models) {
    const connectionIds = new Set(
      [...(model.availableConnections ?? []), model.connectionId].filter((value): value is string => Boolean(value))
    )

    for (const connectionId of connectionIds) {
      const variant = model.idVariants?.[connectionId]
      if (!variant) {
        issues.push({
          catalogId: model.id,
          connectionId,
          reason: 'missing-variant'
        })
        continue
      }
      if (!variant.developerId?.trim() || !variant.modelId?.trim() || !variant.effectiveId?.trim()) {
        issues.push({
          catalogId: model.id,
          connectionId,
          reason: 'incomplete-variant'
        })
      }
    }
  }

  return issues
}

function assertCatalogIdentityIntegrity(models: CatalogEntry[]) {
  const issues = findCatalogIdentityIssues(models)
  if (!issues.length) return

  const sample = issues
    .slice(0, 8)
    .map((issue) => `${issue.catalogId} @ ${issue.connectionId} (${issue.reason})`)
    .join(', ')
  throw new Error(`Catalog identity integrity failed for ${issues.length} connection variant(s): ${sample}`)
}

/**
 * The pure middle of a sync run: reviewed identities first (so each entry's own
 * limits are recorded before Artificial Analysis fills in model-wide numbers),
 * then Artificial Analysis, then the guarded merge, then the identity check.
 */
function assembleCatalogModels({
  gatewayEntries,
  openRouterEntries,
  directEntriesByProvider,
  aaMap
}: {
  gatewayEntries: CatalogEntry[]
  openRouterEntries: CatalogEntry[]
  directEntriesByProvider: Partial<Record<DirectProviderId, CatalogEntry[]>>
  aaMap: Map<string, any>
}): { models: CatalogEntry[]; variantCollisions: VariantCollision[] } {
  const allEntries = [
    ...gatewayEntries,
    ...openRouterEntries,
    ...DIRECT_PROVIDER_IDS.flatMap((provider) => directEntriesByProvider[provider] ?? [])
  ].map((entry) => enrichWithAA(recordOwnNumbers(entry), aaMap))

  const { models, variantCollisions } = mergeCatalogEntriesWithReport(allEntries)
  models.sort((a, b) => a.displayName.localeCompare(b.displayName))
  assertCatalogIdentityIntegrity(models)
  return { models, variantCollisions }
}

export function _assembleCatalogModelsForTest(args: Parameters<typeof assembleCatalogModels>[0]) {
  return assembleCatalogModels(args)
}

export function _buildFallbackEntriesFromExistingForTest(args: Parameters<typeof buildFallbackEntriesFromExisting>[0]) {
  return buildFallbackEntriesFromExisting(args)
}

export function _mergeCatalogEntriesForTest(entries: CatalogEntry[]): CatalogEntry[] {
  return mergeCatalogEntries(entries)
}

export function _findCatalogIdentityIssuesForTest(models: CatalogEntry[]): CatalogIdentityIssue[] {
  return findCatalogIdentityIssues(models)
}

export function _mapGatewayModelToCatalogEntryForTest(raw: GatewayModel): CatalogEntry {
  return mapGatewayModelToCatalogEntry(raw)
}

export function _mapOpenRouterModelToCatalogEntryForTest(raw: OpenRouterModel): CatalogEntry {
  return mapOpenRouterModelToCatalogEntry(raw)
}

export function _getManualDirectModelsForTest(provider: DirectProviderId): DirectProviderEntry[] {
  return MANUAL_DIRECT_MODELS[provider] ?? []
}

export function _mergeDirectProviderEntriesForTest(
  liveEntries: DirectProviderEntry[],
  curatedEntries: DirectProviderEntry[]
): DirectProviderEntry[] {
  return mergeDirectProviderEntries(liveEntries, curatedEntries)
}

export function _mapDeepInfraModelsForTest(models: DeepInfraCatalogModel[]): DirectProviderEntry[] {
  return mapDeepInfraModels(models)
}

export function _mapAnthropicModelsForTest(models: AnthropicModelInfo[]): DirectProviderEntry[] {
  return mapAnthropicModels(models)
}

export function _mapTogetherModelsForTest(models: TogetherCatalogModel[]): DirectProviderEntry[] {
  return mapTogetherModels(models)
}

export function _mapFireworksModelsForTest(models: FireworksCatalogModel[]): DirectProviderEntry[] {
  return mapFireworksModels(models)
}

export function _mapBasetenModelsForTest(models: BasetenCatalogModel[]): DirectProviderEntry[] {
  return mapBasetenModels(models)
}

export function _mapOpenAICompatibleCatalogModelsForTest(
  provider:
    | 'cerebras'
    | 'minimax'
    | 'minimax_token_plan'
    | 'mimo'
    | 'mimo_token_plan'
    | 'qwencloud',
  models: OpenAICompatibleCatalogModel[]
): DirectProviderEntry[] {
  return mapOpenAICompatibleCatalogModels(provider, models)
}

export function _mapCohereModelsForTest(models: CohereCatalogModel[]): DirectProviderEntry[] {
  return mapCohereModels(models)
}

export function _mapDirectProviderEntriesForTest(
  provider: DirectProviderId,
  entries: DirectProviderEntry[]
): CatalogEntry[] {
  return mapDirectProviderEntries(provider, entries)
}

export function _applyDirectSourceCatalogPolicyForTest(
  provider: DirectProviderId,
  entries: CatalogEntry[]
): CatalogEntry[] {
  return applyDirectSourceCatalogPolicy(provider, entries)
}

export function _buildCatalogSyncDiffForTest({
  previous,
  next
}: {
  previous: ExistingCatalogPayload | null
  next: CatalogPayload
}): CatalogSyncDiff {
  return buildCatalogSyncDiff({ previous, next })
}

async function uploadCatalog(payload: CatalogPayload) {
  await upstashKvSet('catalog:v1', payload, {
    timeoutMs: CATALOG_FETCH_TIMEOUT_MS
  })
}

type CatalogSyncSourceStatus = {
  connectionId: CatalogConnectionId
  ok: boolean
  usedFallback: boolean
  skipped?: boolean
  fetchedCount: number
  /** Missing upstream IDs retained until a reviewed source policy confirms retirement. */
  pendingRemovalIds?: string[]
  confirmedRemovalIds?: string[]
  /** Saved identities removed by the reviewed connection incompatibility policy. */
  policyRemovalIds?: string[]
  error?: string
  warning?: string
}

type RunModelCatalogSyncResult = {
  payload: CatalogPayload
  sources: CatalogSyncSourceStatus[]
  report: CatalogSyncReport
}

type RunModelCatalogSyncOptions = {
  trigger?: CatalogSyncTrigger
  initiatedBy?: string | null
  /**
   * BL-68: build the catalog and return it without writing anything: no upload
   * to Upstash and no stored report. Sources are still fetched live, so this
   * still calls every provider whose key is configured.
   */
  dryRun?: boolean
}

type ExistingCatalogPayload = {
  models?: any[]
  fetchedAt?: string
  version?: number
}

type CatalogSyncDiffItem = {
  key: string
  displayName: string
  provider?: string
  name?: string
}

type CatalogConnectionChange = {
  key: string
  displayName: string
  addedConnections: string[]
  removedConnections: string[]
}

type CatalogSyncDiff = {
  addedModelsTotal: number
  removedModelsTotal: number
  connectionChangesTotal: number
  addedModels: CatalogSyncDiffItem[]
  removedModels: CatalogSyncDiffItem[]
  connectionChanges: CatalogConnectionChange[]
  truncated: boolean
}

type CatalogSyncReport = {
  status: 'ok' | 'degraded'
  fetchedAt: string
  previousFetchedAt?: string
  sources: CatalogSyncSourceStatus[]
  diff: CatalogSyncDiff
  variantCollisions: VariantCollision[]
  warningStreak: number
  warningAlert?: {
    active: boolean
    streak: number
    threshold: number
    message: string
  } | null
}

async function fetchExistingCatalog(): Promise<ExistingCatalogPayload | null> {
  // A missing key permits the first publish. An unreadable or malformed saved
  // catalog does not: source failures would otherwise lose their fallback rows.
  const parsed = await upstashKvGet<ExistingCatalogPayload>('catalog:v1', {
    required: true,
    timeoutMs: CATALOG_FETCH_TIMEOUT_MS
  })
  if (parsed === null) return null
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error('Cannot sync model catalog: existing catalog is malformed')
  }

  const supportedConnections = new Set<string>([
    'vercel-gateway', 'openrouter', ...DIRECT_PROVIDER_IDS.map(asDirectConnectionId)
  ])
  for (const model of parsed.models) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim() ||
      !Array.isArray(model.availableConnections) || !model.availableConnections.length ||
      !model.idVariants || typeof model.idVariants !== 'object') {
      throw new Error('Cannot sync model catalog: existing catalog has an unusable saved identity')
    }
    const connections = new Set([...model.availableConnections, model.connectionId, ...Object.keys(model.idVariants)].filter(Boolean))
    for (const connection of connections) {
      const variant = model.idVariants[connection]
      if (!supportedConnections.has(connection) || !variant ||
        !['developerId', 'modelId', 'effectiveId'].every(key =>
          typeof variant[key] === 'string' && variant[key].trim())) {
        throw new Error('Cannot sync model catalog: existing catalog has an unusable saved identity')
      }
    }
  }
  return parsed as ExistingCatalogPayload
}

function safeString(value: unknown) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function buildFallbackEntriesFromExisting({
  existing,
  connectionId,
  source,
  transport
}: {
  existing: ExistingCatalogPayload
  connectionId: CatalogConnectionId
  source: CatalogSource
  transport: CatalogTransport
}): CatalogEntry[] {
  const models = Array.isArray(existing.models) ? existing.models : []
  if (!models.length) return []

  const results: CatalogEntry[] = []

  for (const model of models) {
    const availableConnections = Array.isArray(model?.availableConnections)
      ? (model.availableConnections as string[])
      : []
    const variants =
      model?.idVariants && typeof model.idVariants === 'object' ? (model.idVariants as Record<string, any>) : null

    const hasConnection =
      safeString(model?.connectionId) === connectionId ||
      availableConnections.includes(connectionId) ||
      Boolean(variants && variants[connectionId])

    if (!hasConnection) continue

    const variant = variants?.[connectionId]
    const provider = safeString(variant?.developerId) || safeString(model?.provider) || 'unknown'
    const name = safeString(variant?.modelId) || safeString(model?.name) || safeString(model?.modelId) || ''
    if (!provider || !name) continue

    const canonicalId = buildCanonicalId(provider, name)
    const tags = Array.isArray(model?.tags) ? (model.tags as string[]).map((tag) => safeString(tag).toLowerCase()) : []
    const inferredPurpose = inferModelPurpose({
      id: safeString(model?.id) || canonicalId,
      name,
      modelType: (model as any)?.modelType ?? null,
      tags
    })
    const purpose = normalizePurpose(model?.purpose, inferredPurpose)
    const effectiveId =
      safeString(variant?.effectiveId) ||
      (connectionId === 'openrouter' || connectionId === 'vercel-gateway' ? `${provider}/${name}` : name)
    // BL-68: a connection that keeps its own limits is rebuilt with them, never
    // with the merged row's numbers, which may belong to another connection.
    const ownLimits = variant?.limits && typeof variant.limits === 'object' ? variant.limits : null
    // BL-572: the row's numbers are its base's own, so only the base is rebuilt
    // with them. Any other connection without limits of its own took the row's
    // by rule; it is rebuilt with none (unknown), so it takes the row's again on
    // the next merge instead of keeping today's as if its own list named them.
    // A row that names no base connection (an older snapshot) rebuilds as before.
    const rowConnection = safeString(model?.connectionId)
    const limitsFromRow = !ownLimits && (!rowConnection || rowConnection === connectionId)
    // A snapshot that still carries a window or output cap of 0 is rebuilt
    // with it unknown, never 0.
    const contextWindow = normalizePositiveInteger(
      ownLimits ? ownLimits.contextWindow : limitsFromRow ? model?.contextWindow : undefined
    )
    const maxOutputTokens = normalizePositiveInteger(
      ownLimits ? ownLimits.maxOutputTokens : limitsFromRow ? model?.maxOutputTokens : undefined
    )

    results.push({
      id: effectiveId,
      canonicalId,
      provider,
      // BL-133: the same value a live fetch writes: `vercel`, `openrouter`, or
      // the direct provider's own id (`anthropic`, `togetherai`), never `direct`.
      upstreamProvider: connectionId.startsWith('direct:') ? connectionId.slice('direct:'.length) : source,
      name,
      displayName: safeString(model?.displayName) || name,
      // BL-133: an empty description stays empty and a missing one stays missing.
      ...(typeof model?.description === 'string' ? { description: model.description } : {}),
      tags,
      contextWindow,
      maxOutputTokens,
      purpose,
      // BL-132 / BL-295 review: each connection is rebuilt with the price it was
      // published with: its variant's own (an empty one is Unknown), else the
      // row's, which was its own price. The maker's own API on a gateway-based
      // row is the exception: it took the row's by rule, so it is rebuilt with
      // none and takes the row's again when the gateway's price moves.
      pricing:
        variant?.pricing && typeof variant.pricing === 'object'
          ? variant.pricing
          : takesGatewayListPrice(connectionId, safeString(model?.provider), safeString(model?.connectionId))
            ? undefined
            : model?.pricing && typeof model.pricing === 'object'
              ? model.pricing
              : undefined,
      features:
        typeof model?.features === 'object' && model.features
          ? limitsFromRow
            ? withoutUnknownWindow(model.features)
            : withKnownWindow(model.features, contextWindow)
          : deriveFeatures(tags, contextWindow, undefined),
      category: model?.category,
      source,
      transport,
      connectionId,
      // BL-133: the published model type survives a fail-safe rebuild (an
      // OpenRouter row, which never has one, still has none).
      ...(model && 'modelType' in model
        ? { modelType: typeof model.modelType === 'string' ? model.modelType : null }
        : {})
    })
  }

  return results
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message
  return safeString(error) || 'unknown error'
}

function buildSourceFallbackWarning({
  useFallback,
  fetchedCount,
  previousCount
}: {
  useFallback: boolean
  fetchedCount: number
  previousCount: number
}) {
  if (!useFallback) return undefined
  if (previousCount > 0 && fetchedCount === 0) {
    return `Source returned 0 models; preserving previous list (prev=${previousCount}, fetched=0)`
  }
  if (previousCount > 0 && fetchedCount < previousCount) {
    return `Suspicious drop detected (prev=${previousCount}, fetched=${fetchedCount}); preserving previous list`
  }
  if (fetchedCount === 0) {
    return 'Source returned 0 models and no previous list is available'
  }
  return undefined
}

export function _buildSourceFallbackWarningForTest(args: {
  useFallback: boolean
  fetchedCount: number
  previousCount: number
}) {
  return buildSourceFallbackWarning(args)
}

function buildModelKey(model: any): string {
  const provider = canonicalizeCatalogDeveloperId(safeString(model?.provider))
  const aaSlug = safeString(model?.aaSlug).trim()
  if (aaSlug && provider) return `${provider}::aa:${aaSlug.toLowerCase()}`
  const canonical = safeString(model?.canonicalId).trim()
  if (canonical) {
    const [developerId, ...modelParts] = canonical.split('/')
    if (developerId && modelParts.length) {
      return `${canonicalizeCatalogDeveloperId(developerId)}/${modelParts.join('/')}`
    }
    return canonical
  }
  if (aaSlug) return aaSlug.toLowerCase()
  return safeString(model?.id).trim()
}

function extractConnectionSet(model: any): Set<string> {
  const connections = new Set<string>()

  const availableConnections = Array.isArray(model?.availableConnections)
    ? (model.availableConnections as unknown[]).map((value) => safeString(value)).filter(Boolean)
    : []

  for (const value of availableConnections) {
    connections.add(value)
  }

  const connectionId = safeString(model?.connectionId)
  if (connectionId) {
    connections.add(connectionId)
  }

  if (model?.idVariants && typeof model.idVariants === 'object') {
    for (const key of Object.keys(model.idVariants)) {
      if (key) connections.add(key)
    }
  }

  return connections
}

function buildCatalogSyncDiff({
  previous,
  next
}: {
  previous: ExistingCatalogPayload | null
  next: CatalogPayload
}): CatalogSyncDiff {
  const previousModels = Array.isArray(previous?.models) ? previous!.models! : []
  const nextModels = next.models

  const previousMap = new Map<string, any>()
  for (const model of previousModels) {
    const key = buildModelKey(model)
    if (!key) continue
    previousMap.set(key, model)
  }

  const nextMap = new Map<string, CatalogEntry>()
  for (const model of nextModels) {
    const key = buildModelKey(model)
    if (!key) continue
    nextMap.set(key, model)
  }

  const added: CatalogSyncDiffItem[] = []
  const removed: CatalogSyncDiffItem[] = []
  const connectionChanges: CatalogConnectionChange[] = []

  for (const [key, model] of nextMap.entries()) {
    if (previousMap.has(key)) continue
    added.push({
      key,
      displayName: safeString(model.displayName) || safeString(model.name) || key,
      provider: model.provider,
      name: model.name
    })
  }

  for (const [key, model] of previousMap.entries()) {
    if (nextMap.has(key)) continue
    removed.push({
      key,
      displayName: safeString(model?.displayName) || safeString(model?.name) || key,
      provider: safeString(model?.provider) || undefined,
      name: safeString(model?.name) || undefined
    })
  }

  for (const [key, nextModel] of nextMap.entries()) {
    const previousModel = previousMap.get(key)
    if (!previousModel) continue

    const prevConnections = extractConnectionSet(previousModel)
    const nextConnections = extractConnectionSet(nextModel)

    const addedConnections = Array.from(nextConnections)
      .filter((conn) => !prevConnections.has(conn))
      .sort()
    const removedConnections = Array.from(prevConnections)
      .filter((conn) => !nextConnections.has(conn))
      .sort()

    if (!addedConnections.length && !removedConnections.length) continue

    connectionChanges.push({
      key,
      displayName: safeString(nextModel.displayName) || safeString(nextModel.name) || key,
      addedConnections,
      removedConnections
    })
  }

  added.sort((a, b) => a.displayName.localeCompare(b.displayName))
  removed.sort((a, b) => a.displayName.localeCompare(b.displayName))
  connectionChanges.sort((a, b) => a.displayName.localeCompare(b.displayName))

  return {
    addedModelsTotal: added.length,
    removedModelsTotal: removed.length,
    connectionChangesTotal: connectionChanges.length,
    addedModels: added,
    removedModels: removed,
    connectionChanges,
    truncated: false
  }
}

function computeCatalogSyncStatus(sources: CatalogSyncSourceStatus[]): 'ok' | 'degraded' {
  const failing = sources.some((source) => Boolean(source.error) || Boolean(source.warning))
  if (failing) return 'degraded'

  const usedFallbackWithoutSkip = sources.some((source) => source.usedFallback && !source.skipped)
  if (usedFallbackWithoutSkip) return 'degraded'

  return 'ok'
}

const DIRECT_SOURCE_FETCHERS: Record<
  DirectProviderId,
  (options?: SourceFetchOptions) => Promise<DirectProviderEntry[]>
> = {
  openai: fetchOpenAIEntries,
  anthropic: fetchAnthropicEntries,
  google: fetchGoogleEntries,
  mistral: fetchMistralEntries,
  groq: fetchGroqEntries,
  xai: fetchXAIEntries,
  deepseek: fetchDeepSeekEntries,
  deepinfra: fetchDeepInfraEntries,
  moonshot: fetchMoonshotEntries,
  kimi_code: fetchKimiCodeEntries,
  minimax: fetchMiniMaxEntries,
  minimax_token_plan: fetchMiniMaxTokenPlanEntries,
  mimo: fetchMimoEntries,
  mimo_token_plan: fetchMimoTokenPlanEntries,
  qwencloud: fetchQwenCloudEntries,
  qwen_token_plan: fetchQwenTokenPlanEntries,
  zai: fetchZaiEntries,
  zai_coding: fetchZaiCodingEntries,
  togetherai: fetchTogetherEntries,
  fireworks: fetchFireworksEntries,
  baseten: fetchBasetenEntries,
  cerebras: fetchCerebrasEntries,
  fal: fetchFalEntries,
  luma: fetchLumaEntries,
  replicate: fetchReplicateEntries,
  elevenlabs: fetchElevenLabsEntries,
  deepgram: fetchDeepgramEntries,
  assemblyai: fetchAssemblyAiEntries,
  cohere: fetchCohereEntries
}

const DIRECT_SOURCE_ENV_VARS: Record<DirectProviderId, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  deepinfra: [],
  moonshot: ['MOONSHOT_API_KEY'],
  kimi_code: [],
  minimax: ['MINIMAX_API_KEY'],
  minimax_token_plan: [],
  mimo: ['MIMO_API_KEY'],
  mimo_token_plan: [],
  qwencloud: ['DASHSCOPE_API_KEY'],
  qwen_token_plan: [],
  zai: ['ZAI_API_KEY'],
  zai_coding: [],
  togetherai: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  fal: ['FAL_API_KEY', 'FAL_KEY'],
  luma: ['LUMA_API_KEY'],
  replicate: ['REPLICATE_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  deepgram: ['DEEPGRAM_API_KEY'],
  assemblyai: ['ASSEMBLYAI_API_KEY'],
  cohere: ['COHERE_API_KEY']
}

async function isDirectSourceConfigured(provider: DirectProviderId) {
  const environmentVariables = DIRECT_SOURCE_ENV_VARS[provider]
  if (!environmentVariables.length) return true

  const configuredValues = await Promise.all(environmentVariables.map((name) => getRuntimeEnv(name)))
  return configuredValues.some(Boolean)
}

export async function runModelCatalogSync(
  options: RunModelCatalogSyncOptions = {}
): Promise<RunModelCatalogSyncResult> {
  logger.debug('[catalog] Building model catalog snapshot...')

  const completedLiveLists = new Set<DirectProviderId>()
  const fallbackErrors = new Map<DirectProviderId, string>()
  const createSourceOptions = (provider?: DirectProviderId): SourceFetchOptions => ({
    signal: AbortSignal.timeout(CATALOG_SOURCE_TIMEOUT_MS),
    onFallbackError: provider ? error => fallbackErrors.set(provider, normalizeError(error)) : undefined,
    onCompleteLiveList: provider ? () => { completedLiveLists.add(provider) } : undefined
  })

  const existing = await fetchExistingCatalog()
  const hasExisting = Boolean(existing?.models?.length)

  const previousGatewayCount = existing
    ? buildFallbackEntriesFromExisting({
        existing,
        connectionId: 'vercel-gateway',
        source: 'vercel',
        transport: 'vercel-gateway'
      }).length
    : 0
  const previousOpenRouterCount = existing
    ? buildFallbackEntriesFromExisting({
        existing,
        connectionId: 'openrouter',
        source: 'openrouter',
        transport: 'openrouter'
      }).length
    : 0

  const previousDirectCounts = Object.fromEntries(
    DIRECT_PROVIDER_IDS.map((provider) => [
      provider,
      existing
        ? applyDirectSourceCatalogPolicy(
            provider,
            buildFallbackEntriesFromExisting({
              existing,
              connectionId: asDirectConnectionId(provider),
              source: 'direct',
              transport: 'direct'
            })
          ).length
        : 0
    ])
  ) as Record<DirectProviderId, number>

  const directSourceConfigured = Object.fromEntries(
    await Promise.all(DIRECT_PROVIDER_IDS.map(async (provider) => [provider, await isDirectSourceConfigured(provider)]))
  ) as Record<DirectProviderId, boolean>

  const [gatewayResult, openRouterResult, aaResult, ...directSourceResults] = await Promise.allSettled([
    fetchGatewayEntries(createSourceOptions()),
    fetchOpenRouterEntries(createSourceOptions()),
    fetchArtificialAnalysis(createSourceOptions()),
    ...DIRECT_PROVIDER_IDS.map((provider) => DIRECT_SOURCE_FETCHERS[provider](createSourceOptions(provider)))
  ])

  const directSourceResultsByProvider = Object.fromEntries(
    DIRECT_PROVIDER_IDS.map((provider, index) => [provider, directSourceResults[index]])
  ) as Record<DirectProviderId, PromiseSettledResult<DirectProviderEntry[]>>

  const sources: CatalogSyncSourceStatus[] = []

  const gatewayEntriesFresh = gatewayResult.status === 'fulfilled' ? gatewayResult.value : null
  const gatewayError = gatewayResult.status === 'rejected' ? normalizeError(gatewayResult.reason) : undefined
  const gatewayFallback = existing
    ? buildFallbackEntriesFromExisting({
        existing,
        connectionId: 'vercel-gateway',
        source: 'vercel',
        transport: 'vercel-gateway'
      })
    : []
  const gatewayReconciled = retainCatalogSourceEntries('vercel-gateway', gatewayEntriesFresh ?? [], gatewayFallback)
  const useGatewayFallback = !gatewayEntriesFresh || gatewayReconciled.pendingRemovalIds.length > 0 ||
    (gatewayEntriesFresh.length === 0 && previousGatewayCount === 0)

  const gatewayEntries = !gatewayEntriesFresh ? gatewayFallback : gatewayReconciled.entries
  if (!hasExisting && (!gatewayEntriesFresh || gatewayEntriesFresh.length === 0)) {
    const reason = gatewayError ? ` (${gatewayError})` : ''
    throw new Error(`Gateway model import failed and no existing catalog is available${reason}`)
  }

  sources.push({
    connectionId: 'vercel-gateway',
    ok: Boolean(gatewayEntriesFresh) && !useGatewayFallback && !gatewayReconciled.pendingRemovalIds.length,
    pendingRemovalIds: gatewayEntriesFresh ? gatewayReconciled.pendingRemovalIds : undefined,
    confirmedRemovalIds: gatewayEntriesFresh ? gatewayReconciled.confirmedRemovalIds : undefined,
    usedFallback: useGatewayFallback,
    fetchedCount: gatewayEntriesFresh?.length ?? 0,
    error: gatewayError,
    warning: (gatewayEntriesFresh && gatewayReconciled.warning) || buildSourceFallbackWarning({
      useFallback: useGatewayFallback,
      previousCount: previousGatewayCount,
      fetchedCount: gatewayEntriesFresh?.length ?? 0
    })
  })

  const openRouterEntriesFresh = openRouterResult.status === 'fulfilled' ? openRouterResult.value : null
  const openRouterError = openRouterResult.status === 'rejected' ? normalizeError(openRouterResult.reason) : undefined
  const openRouterFallback = existing
    ? buildFallbackEntriesFromExisting({
        existing,
        connectionId: 'openrouter',
        source: 'openrouter',
        transport: 'openrouter'
      })
    : []
  const openRouterReconciled = retainCatalogSourceEntries('openrouter', openRouterEntriesFresh ?? [], openRouterFallback)
  const useOpenRouterFallback = !openRouterEntriesFresh || openRouterReconciled.pendingRemovalIds.length > 0 ||
    (openRouterEntriesFresh.length === 0 && previousOpenRouterCount === 0)

  const openRouterEntries = !openRouterEntriesFresh ? openRouterFallback : openRouterReconciled.entries

  sources.push({
    connectionId: 'openrouter',
    ok: Boolean(openRouterEntriesFresh) && !useOpenRouterFallback && !openRouterReconciled.pendingRemovalIds.length,
    pendingRemovalIds: openRouterEntriesFresh ? openRouterReconciled.pendingRemovalIds : undefined,
    confirmedRemovalIds: openRouterEntriesFresh ? openRouterReconciled.confirmedRemovalIds : undefined,
    usedFallback: useOpenRouterFallback,
    fetchedCount: openRouterEntriesFresh?.length ?? 0,
    error: openRouterError,
    warning: (openRouterEntriesFresh && openRouterReconciled.warning) || buildSourceFallbackWarning({
      useFallback: useOpenRouterFallback,
      previousCount: previousOpenRouterCount,
      fetchedCount: openRouterEntriesFresh?.length ?? 0
    })
  })

  function resolveDirectSource({
    provider,
    result
  }: {
    provider: DirectProviderId
    result: PromiseSettledResult<DirectProviderEntry[]>
  }) {
    const connectionId = asDirectConnectionId(provider)
    const sourceConfigured = directSourceConfigured[provider]

    const fresh = result.status === 'fulfilled'
      ? applyDirectSourceCatalogPolicy(provider, mapDirectProviderEntries(provider, result.value))
      : null
    const error = result.status === 'rejected' ? normalizeError(result.reason) : fallbackErrors.get(provider)
    const savedEntries = existing
      ? buildFallbackEntriesFromExisting({ existing, connectionId, source: 'direct', transport: 'direct' })
      : []
    const savedFallback = applyDirectSourceCatalogPolicy(provider, savedEntries)
    const compatibleSavedIds = new Set(savedFallback.map(entry => entry.id))
    const policyRemovalIds = [...new Set(savedEntries.filter(entry => !compatibleSavedIds.has(entry.id)).map(entry => entry.id))]
    // These dated identities were lost before exact-ID retention existed. Keep
    // them as prior coverage so only a complete list plus reviewed retirement
    // can remove them; never count them as freshly fetched Fal models.
    const recoveredFalEntries = provider === 'fal'
      ? mapDirectProviderEntries('fal', RECOVERED_FAL_ENTRIES.map(({ id, displayName, tags, modelType }) => ({
          id, displayName, tags: [...tags], modelType
        })))
      : []
    // A reviewed retirement must not resurrect a recovered-only ID during a
    // later outage. Saved rows still follow the normal no-retirement-on-error
    // contract, and a complete live list still reports the confirmed removal.
    const eligibleRecovery = provider !== 'fal'
      ? []
      : error || !sourceConfigured || !completedLiveLists.has(provider)
        ? retainCatalogSourceEntries(connectionId, [], recoveredFalEntries).entries
        : recoveredFalEntries
    const savedIds = new Set(savedFallback.map(entry => entry.id))
    const fallback = [...savedFallback, ...eligibleRecovery.filter(entry => !savedIds.has(entry.id))]
    const previousCount = previousDirectCounts[provider] ?? 0
    const reconciled = retainCatalogSourceEntries(connectionId, fresh ?? [], fallback, error || !sourceConfigured || !completedLiveLists.has(provider) ? [] : undefined)
    const useFallback = Boolean(error) || !fresh || reconciled.pendingRemovalIds.length > 0 ||
      (fresh.length === 0 && previousCount === 0)

    const entries = !fresh ? fallback : reconciled.entries
    sources.push({
      connectionId,
      ok: Boolean(fresh) && !useFallback && !reconciled.pendingRemovalIds.length,
      pendingRemovalIds: fresh ? reconciled.pendingRemovalIds : undefined,
      confirmedRemovalIds: fresh ? reconciled.confirmedRemovalIds : [],
      policyRemovalIds,
      usedFallback: useFallback,
      skipped: !sourceConfigured,
      fetchedCount: fresh?.length ?? 0,
      error,
      warning: [!sourceConfigured
        ? provider === 'fal' && fallback.length
          ? `API key not configured; preserving ${fallback.length} prior/recovered Fal entries without a live refresh`
          : `API key not configured; ${previousCount ? 'preserving previous list' : 'skipping import'}`
        : (fresh && reconciled.warning) || buildSourceFallbackWarning({
            useFallback,
            previousCount,
            fetchedCount: fresh?.length ?? 0
          }),
        policyRemovalIds.length
          ? `Reviewed connection policy excludes saved IDs: ${policyRemovalIds.join(', ')}`
          : undefined
      ].filter(Boolean).join('; ') || undefined
    })

    return entries
  }

  const directEntriesByProvider = Object.fromEntries(
    DIRECT_PROVIDER_IDS.map((provider) => [
      provider,
      resolveDirectSource({
        provider,
        result: directSourceResultsByProvider[provider]
      })
    ])
  ) as Record<DirectProviderId, CatalogEntry[]>

  const aaMap = aaResult.status === 'fulfilled' ? aaResult.value : new Map<string, any>()

  if (aaResult.status === 'rejected') {
    console.warn(
      '[catalog] AA enrichment fetch failed; continuing without enrichment:',
      normalizeError(aaResult.reason)
    )
  }

  const { models: merged, variantCollisions } = assembleCatalogModels({
    gatewayEntries,
    openRouterEntries,
    directEntriesByProvider,
    aaMap
  })

  const payload: CatalogPayload = {
    version: 2,
    fetchedAt: new Date().toISOString(),
    counts: {
      vercel: gatewayEntries.length,
      openrouter: openRouterEntries.length,
      ...Object.fromEntries(DIRECT_PROVIDER_IDS.map((provider) => [provider, directEntriesByProvider[provider].length]))
    },
    models: merged
  }

  // Source retention is not sufficient if a later policy/merge drops an ID.
  // Verify the complete output before any publication, including dry-run proof.
  const identityKey = (connection: string, id: string) => JSON.stringify([connection, id])
  const outputIdentities = new Set(merged.flatMap(model =>
    Object.entries(model.idVariants ?? {}).map(([connection, variant]) => identityKey(connection, variant.effectiveId))))
  const approvedRemovals = new Set(sources.flatMap(source =>
    [...(source.confirmedRemovalIds ?? []), ...(source.policyRemovalIds ?? [])]
      .map(id => identityKey(source.connectionId, id))))
  for (const model of existing?.models ?? []) {
    for (const [connection, variant] of Object.entries(model.idVariants ?? {})) {
      const key = identityKey(connection, (variant as { effectiveId: string }).effectiveId)
      if (!outputIdentities.has(key) && !approvedRemovals.has(key)) {
        throw new Error('Cannot publish catalog: downstream processing removed an unapproved saved connection')
      }
    }
  }

  if (!options.dryRun) {
    await uploadCatalog(payload)
  }
  const directTotal = DIRECT_PROVIDER_IDS.reduce(
    (total, provider) => total + directEntriesByProvider[provider].length,
    0
  )
  logger.debug(
    `[catalog] ${options.dryRun ? 'Built (dry run, not uploaded)' : 'Uploaded'} ${merged.length} models (vercel=${gatewayEntries.length}, openrouter=${openRouterEntries.length}, direct=${directTotal})`
  )
  const diff = buildCatalogSyncDiff({ previous: existing, next: payload })
  const reportBase = {
    status: computeCatalogSyncStatus(sources),
    fetchedAt: payload.fetchedAt,
    previousFetchedAt: safeString(existing?.fetchedAt) || undefined,
    sources,
    diff,
    variantCollisions,
    warningStreak: 0,
    warningAlert: null
  }

  let report: CatalogSyncReport = reportBase
  if (options.dryRun) {
    return { payload, sources, report }
  }

  try {
    const stored = await storeCatalogSyncReport({
      trigger: options.trigger ?? 'unknown',
      initiatedBy: options.initiatedBy ?? null,
      report: {
        status: reportBase.status,
        fetchedAt: reportBase.fetchedAt,
        previousFetchedAt: reportBase.previousFetchedAt,
        counts: payload.counts,
        models: payload.models.length,
        sources: reportBase.sources,
        diff: reportBase.diff,
        variantCollisions: reportBase.variantCollisions
      }
    })
    report = {
      ...reportBase,
      warningStreak: stored.warningStreak,
      warningAlert: stored.warningAlert ?? null
    }
  } catch (err) {
    console.warn('[catalog] Failed to persist sync report:', normalizeError(err))
  }

  return { payload, sources, report }
}

/**
 * BL-68: rebuild the catalog the current code would publish from a published
 * snapshot, with no network at all: every source is rebuilt from the snapshot
 * exactly as the sync's own fail-safe path does, and Artificial Analysis is
 * replayed from the slugs the snapshot carries. Used by
 * `npm run sync:model-catalog -- --replay <snapshot.json> --out <file>` to show
 * what a code change does to today's catalog before any real sync runs.
 *
 * It cannot recover what a snapshot has already lost (an entry an older merge
 * dropped, or the per-source numbers merged away), so its output is proof of
 * what the rules do to the snapshot, not a substitute for a live run.
 */
export function buildCatalogFromSnapshot(snapshot: ExistingCatalogPayload): {
  payload: CatalogPayload
  variantCollisions: VariantCollision[]
} {
  const gatewayEntries = buildFallbackEntriesFromExisting({
    existing: snapshot,
    connectionId: 'vercel-gateway',
    source: 'vercel',
    transport: 'vercel-gateway'
  })
  const openRouterEntries = buildFallbackEntriesFromExisting({
    existing: snapshot,
    connectionId: 'openrouter',
    source: 'openrouter',
    transport: 'openrouter'
  })
  const directEntriesByProvider = Object.fromEntries(
    DIRECT_PROVIDER_IDS.map((provider) => [
      provider,
      applyDirectSourceCatalogPolicy(
        provider,
        buildFallbackEntriesFromExisting({
          existing: snapshot,
          connectionId: asDirectConnectionId(provider),
          source: 'direct',
          transport: 'direct'
        })
      )
    ])
  ) as Record<DirectProviderId, CatalogEntry[]>

  // Only the slugs: prices and windows already sit in the snapshot's rows.
  const aaMap = new Map<string, any>()
  for (const model of snapshot.models ?? []) {
    const slug = safeString(model?.aaSlug).trim()
    if (slug) aaMap.set(normalizeName(slug), { slug })
  }

  const { models, variantCollisions } = assembleCatalogModels({
    gatewayEntries,
    openRouterEntries,
    directEntriesByProvider,
    aaMap
  })

  return {
    payload: {
      version: 2,
      fetchedAt: safeString(snapshot.fetchedAt) || new Date().toISOString(),
      counts: {
        vercel: gatewayEntries.length,
        openrouter: openRouterEntries.length,
        ...Object.fromEntries(DIRECT_PROVIDER_IDS.map((provider) => [provider, directEntriesByProvider[provider].length]))
      },
      models
    },
    variantCollisions
  }
}
