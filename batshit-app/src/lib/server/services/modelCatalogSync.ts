import { inferModelPurpose } from '$lib/utils/modelPurpose'
import { logger } from '$lib/utils/logger'
import { normalizePositiveInteger, sanitizeCatalogMaxOutputTokens } from '$lib/utils/modelOutputTokens'
import type { ModelPurpose } from '$lib/types/savedModels'
import { storeCatalogSyncReport } from '$lib/server/services/modelCatalogReportStore'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { upstashKvGet, upstashKvSet } from '$lib/server/services/upstashKv'
import type { CatalogSyncTrigger } from '$lib/types/modelCatalogSyncReport'
import {
  FAL_DEVELOPER_OVERRIDE_EXACT,
  FAL_DEVELOPER_OVERRIDE_KEYWORDS,
  FAL_DEVELOPER_OVERRIDE_PREFIX
} from '$lib/data/fal-developer-overrides'

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
    maxTokens: number
    reasoning?: boolean
    cacheControl?: boolean
    longContext?: boolean
    code?: boolean
    fast?: boolean
  }
  category?: 'fast' | 'balanced' | 'powerful' | 'reasoning' | 'code'
  source: CatalogSource
  transport: CatalogTransport
  connectionId: CatalogConnectionId
  modelType?: string | null
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
  'minimax',
  'mimo',
  'qwencloud',
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
  pricing?: {
    input: number | undefined
    output: number | undefined
    cachedInput: number | undefined
  }
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
  zai: [
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
  zai_coding: [
    {
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      tags: ['reasoning', 'code'],
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072
    },
    { id: 'glm-4.5', displayName: 'GLM-4.5' },
    { id: 'glm-4.7', displayName: 'GLM-4.7' },
    { id: 'glm-4.5-air', displayName: 'GLM-4.5-Air' },
    { id: 'glm-4.6', displayName: 'GLM-4.6' },
    { id: 'glm-5', displayName: 'GLM-5' },
    { id: 'glm-5-turbo', displayName: 'GLM-5-Turbo' },
    { id: 'glm-5.1', displayName: 'GLM-5.1' }
  ],
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

function mapPricing(pricing?: Record<string, string | number>) {
  if (!pricing) return undefined
  const toNumber = (value?: string | number) => {
    if (value === undefined || value === null) return undefined
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return undefined
    return Math.round(parsed * 1_000_000 * 1000) / 1000
  }

  const mapped = {
    input: toNumber(pricing.input ?? pricing.prompt ?? pricing.price_1m_input_tokens),
    output: toNumber(pricing.output ?? pricing.completion ?? pricing.price_1m_output_tokens),
    cachedInput: toNumber(pricing.input_cache_read ?? pricing.cached_input ?? pricing.cached_input_price)
  }

  if (!mapped.input && !mapped.output && !mapped.cachedInput) {
    return undefined
  }

  return mapped
}

function asFiniteNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function mapTogetherModels(models: TogetherCatalogModel[]): DirectProviderEntry[] {
  return models
    .filter((model) => model?.type === 'chat')
    .map((model) => {
      const id = safeString(model.id).trim()
      const pricing = {
        input: asFiniteNumber(model.pricing?.input),
        output: asFiniteNumber(model.pricing?.output),
        cachedInput: asFiniteNumber(model.pricing?.cached_input)
      }
      const hasPricing = Object.values(pricing).some((value) => value !== undefined)

      return {
        id,
        effectiveId: id,
        displayName: safeString(model.display_name).trim() || undefined,
        tags: Array.from(new Set(['chat', ...inferTagsFromIdentifier(id)])),
        contextWindow: normalizePositiveInteger(model.context_length),
        pricing: hasPricing ? pricing : undefined,
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
        pricing: mapPricing(model.pricing),
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

function mapOpenAICompatibleCatalogModels(
  provider: 'cerebras' | 'minimax' | 'mimo' | 'qwencloud',
  models: OpenAICompatibleCatalogModel[]
): DirectProviderEntry[] {
  return models
    .map((model) => {
      const id = safeString(model.id).trim()
      const isAsr =
        (provider === 'mimo' || provider === 'qwencloud') && /(?:^|[-_])asr(?:$|[-_])/i.test(id)
      const isTts =
        (provider === 'mimo' || provider === 'qwencloud') && /(?:^|[-_])tts(?:$|[-_])/i.test(id)
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
        developerId: normalizeDeveloperId(model.owned_by, provider),
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

function deriveFeatures(tags: string[], contextWindow?: number | null, pricing?: ReturnType<typeof mapPricing>) {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()))

  return {
    streaming: true,
    tools: normalized.has('tool-use') || normalized.has('tool') || normalized.has('tools'),
    vision:
      normalized.has('vision') ||
      normalized.has('image') ||
      normalized.has('image-input') ||
      normalized.has('multimodal'),
    maxTokens: contextWindow ?? 0,
    reasoning: normalized.has('reasoning'),
    cacheControl: pricing?.cachedInput !== undefined,
    longContext: (contextWindow ?? 0) >= 128_000,
    code: normalized.has('code') || normalized.has('coding'),
    fast: normalized.has('fast') || normalized.has('realtime')
  }
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
  const normalizedProvider = provider.toLowerCase().trim()
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

  const data = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []

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

  return (payload.data ?? []).map((model) => ({ id: model.id })).filter((model) => Boolean(model.id))
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
      const input = model.pricing?.cents_per_input_token
      const output = model.pricing?.cents_per_output_token
      const cachedRate = model.pricing?.rate_per_input_token_cached
      const inputPerMillion = typeof input === 'number' && Number.isFinite(input) ? input * 10_000 : undefined
      const outputPerMillion = typeof output === 'number' && Number.isFinite(output) ? output * 10_000 : undefined
      const cachedInputPerMillion =
        inputPerMillion !== undefined && typeof cachedRate === 'number' && Number.isFinite(cachedRate)
          ? inputPerMillion * cachedRate
          : undefined
      const pricing =
        inputPerMillion !== undefined || outputPerMillion !== undefined || cachedInputPerMillion !== undefined
          ? {
              input: inputPerMillion,
              output: outputPerMillion,
              cachedInput: cachedInputPerMillion
            }
          : undefined

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
  return mapDeepInfraModels(Array.isArray(payload) ? payload : [])
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
  return mapTogetherModels(models)
}

async function fetchFireworksEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('FIREWORKS_API_KEY')
  if (!apiKey) return []

  const collected: FireworksCatalogModel[] = []
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

    collected.push(...(payload.models ?? []))
    pageToken = safeString(payload.nextPageToken).trim() || null
  } while (pageToken)

  return mapFireworksModels(collected)
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
  return mapBasetenModels(models)
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
  return mapOpenAICompatibleCatalogModels('cerebras', models)
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
  return mapOpenAICompatibleCatalogModels('minimax', models)
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
  return mapOpenAICompatibleCatalogModels('mimo', models)
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
  return mapOpenAICompatibleCatalogModels('qwencloud', models)
}

async function fetchMoonshotEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('MOONSHOT_API_KEY')
  if (!apiKey) {
    return []
  }

  const baseUrl = (await getRuntimeEnv('MOONSHOT_API_BASE_URL')) || 'https://api.moonshot.ai/v1'

  try {
    const ids = await fetchOpenAICompatibleModelIds({
      baseUrl,
      apiKey,
      signal: options.signal
    })

    if (ids.length) {
      return ids.map((id) => ({ id }))
    }
  } catch (error) {
    console.warn('[catalog] Moonshot model list fetch failed; falling back to manual list:', normalizeError(error))
  }

  return MANUAL_DIRECT_MODELS.moonshot ?? []
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

    if (ids.length) {
      return mergeDirectProviderEntries(
        ids.map((id) => ({ id })),
        curated
      )
    }
  } catch (error) {
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

  const baseUrl = (await getRuntimeEnv('ZAI_CODING_API_BASE_URL')) || 'https://api.z.ai/api/coding/paas/v4'

  try {
    const ids = await fetchOpenAICompatibleModelIds({
      baseUrl,
      apiKey,
      signal: options.signal
    })

    if (ids.length) {
      return mergeDirectProviderEntries(
        ids.map((id) => ({ id })),
        curated
      )
    }
  } catch (error) {
    console.warn(
      '[catalog] Z.ai Coding Plan model list fetch failed; falling back to manual list:',
      normalizeError(error)
    )
  }

  return curated
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
  let pages = 0

  while (pages < maxPages) {
    const url = new URL(FAL_MODELS_ENDPOINT)
    url.searchParams.set('limit', String(limit))
    if (cursor) url.searchParams.set('cursor', cursor)
    const payload: { models?: any[]; next_cursor?: string | null } = await fetchJson<any>(url.toString(), {
      headers,
      signal: options.signal
    })
    const models = Array.isArray(payload?.models) ? payload.models : []

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

    cursor = safeString(payload?.next_cursor).trim() || null
    if (!cursor) break
    pages += 1
  }

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
  const models = Array.isArray(payload?.models) ? payload.models : []

  for (const model of models) {
    if (model?.is_official !== true) continue
    const owner = safeString(model?.owner).trim()
    const name = safeString(model?.name).trim()
    if (!owner || !name) continue
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

  const payload = await fetchJson<{ models?: CohereCatalogModel[] }>(COHERE_MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: options.signal
  })
  return mapCohereModels(payload.models ?? [])
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

  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []

  return data
    .map((model: any) => ({
      id: safeString(model?.id),
      description: safeString(model?.description) || undefined,
      contextWindow: typeof model?.max_context_length === 'number' ? model.max_context_length : undefined,
      modelType: safeString(model?.TYPE || model?.type || null) || null
    }))
    .filter((model: DirectProviderEntry) => Boolean(model.id))
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

    for (const model of payload.models ?? []) {
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

    pageToken = safeString(payload.nextPageToken) || null
  } while (pageToken)

  return entries
}

type AnthropicModelInfo = {
  id: string
  display_name?: string
  created_at?: string
  type?: string
}

async function fetchAnthropicEntries(options: SourceFetchOptions = {}): Promise<DirectProviderEntry[]> {
  const apiKey = await getRuntimeEnv('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return []
  }

  const entries: DirectProviderEntry[] = []
  let afterId: string | null = null

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

    for (const model of payload.data ?? []) {
      const id = safeString(model?.id)
      if (!id) continue
      entries.push({
        id,
        displayName: safeString(model?.display_name) || undefined,
        modelType: safeString(model?.type) || 'model'
      })
    }

    afterId = payload.has_more ? safeString(payload.last_id) || null : null
  } while (afterId)

  return entries
}

async function fetchGatewayEntries(options: SourceFetchOptions = {}): Promise<CatalogEntry[]> {
  const payload = await fetchJson<{
    data?: GatewayModel[]
    models?: GatewayModel[]
  }>(GATEWAY_ENDPOINT, {
    signal: options.signal
  })
  const rawModels = Array.isArray(payload?.data) ? payload!.data! : (payload?.models ?? [])
  return rawModels.map((raw) => {
    const provider = normalizeProvider(raw.id)
    const name = raw.id.split('/').slice(1).join('/') || raw.name
    const canonicalId = buildCanonicalId(provider, name)
    const tags = (raw.tags ?? []).map((tag) => tag.toLowerCase())
    const contextWindow = raw.context_window ?? raw.max_tokens
    const pricing = mapPricing(raw.pricing)
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
      contextWindow: contextWindow ?? undefined,
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
  })
}

async function fetchOpenRouterEntries(options: SourceFetchOptions = {}): Promise<CatalogEntry[]> {
  const apiKey = await getRuntimeEnv('OPENROUTER_API_KEY')
  const payload = await fetchJson<{ data: OpenRouterModel[] }>(OPENROUTER_ENDPOINT, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: options.signal
  })

  return payload.data.map(mapOpenRouterModelToCatalogEntry)
}

function mapOpenRouterModelToCatalogEntry(raw: OpenRouterModel): CatalogEntry {
  const tags = deriveOpenRouterTags(raw)
  const contextWindow = raw.context_length ?? undefined
  const outputContextWindow = raw.top_provider?.context_length ?? contextWindow
  const pricing = mapPricing(raw.pricing as Record<string, string | number>)
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
  features.maxTokens = model.context_length ?? 0
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

function enrichWithAA(entry: CatalogEntry, aaMap: Map<string, any>) {
  const match = aaMap.get(normalizeName(entry.name))
  if (!match) return entry

  const pricing = match.pricing
    ? {
        input: match.pricing.price_1m_input_tokens ?? match.pricing.price_1m_blended_3_to_1 ?? entry.pricing?.input,
        output: match.pricing.price_1m_output_tokens ?? entry.pricing?.output,
        cachedInput: entry.pricing?.cachedInput
      }
    : entry.pricing
  const contextWindow =
    normalizePositiveInteger(
      match.context_window ?? match.context_window_tokens ?? match.context ?? match.max_context
    ) ?? entry.contextWindow

  return {
    ...entry,
    aaSlug: typeof match.slug === 'string' && match.slug.trim().length ? match.slug.trim() : entry.aaSlug,
    pricing: pricing ?? entry.pricing,
    contextWindow,
    maxOutputTokens: sanitizeCatalogMaxOutputTokens({
      maxOutputTokens: entry.maxOutputTokens,
      contextWindow
    })
  }
}

type CatalogMergeKey = string

function buildIdVariants(entries: CatalogEntry[]) {
  const variants: NonNullable<CatalogEntry['idVariants']> = {}

  for (const entry of entries) {
    if (!entry?.connectionId) continue
    variants[entry.connectionId] = {
      developerId: entry.provider,
      modelId: entry.name,
      effectiveId: entry.id,
      source: entry.source
    }

    for (const [connectionId, variant] of Object.entries(entry.idVariants ?? {})) {
      variants[connectionId] = variant
    }
  }

  return Object.keys(variants).length ? variants : undefined
}

function mergeCatalogEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const groups = new Map<CatalogMergeKey, CatalogEntry[]>()

  for (const entry of entries) {
    const key = entry.aaSlug?.trim() || entry.canonicalId
    if (!key) continue
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(entry)
  }

  const merged: CatalogEntry[] = []

  for (const group of groups.values()) {
    const base =
      group.find((entry) => entry.source === 'vercel') ??
      group.find((entry) => entry.source === 'openrouter') ??
      group.find((entry) => entry.source === 'direct') ??
      group[0]
    if (!base) continue

    const idVariants = buildIdVariants(group) ?? base.idVariants
    const availableConnections = Array.from(
      new Set([...group.map((entry) => entry.connectionId), ...Object.keys(idVariants ?? {})].filter(Boolean))
    )

    const purpose = mergePurpose(group.map((entry) => entry.purpose))

    const mergedEntry: CatalogEntry = {
      ...base,
      pricing: base.pricing ?? group.find((entry) => entry.pricing)?.pricing,
      contextWindow: base.contextWindow ?? group.find((entry) => entry.contextWindow)?.contextWindow,
      maxOutputTokens: base.maxOutputTokens ?? group.find((entry) => entry.maxOutputTokens)?.maxOutputTokens,
      description: base.description ?? group.find((entry) => entry.description)?.description,
      tags: Array.from(new Set(group.flatMap((entry) => entry.tags ?? []))),
      availableConnections,
      purpose,
      idVariants
    }

    merged.push(mergedEntry)
  }

  return merged
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

export function _mergeCatalogEntriesForTest(entries: CatalogEntry[]): CatalogEntry[] {
  return mergeCatalogEntries(entries)
}

export function _findCatalogIdentityIssuesForTest(models: CatalogEntry[]): CatalogIdentityIssue[] {
  return findCatalogIdentityIssues(models)
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
  provider: 'cerebras' | 'minimax' | 'mimo' | 'qwencloud',
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
  warningStreak: number
  warningAlert?: {
    active: boolean
    streak: number
    threshold: number
    message: string
  } | null
}

async function fetchExistingCatalog(): Promise<ExistingCatalogPayload | null> {
  let parsed: ExistingCatalogPayload | null
  try {
    parsed = await upstashKvGet<ExistingCatalogPayload>('catalog:v1', {
      required: false,
      timeoutMs: CATALOG_FETCH_TIMEOUT_MS
    })
  } catch {
    return null
  }
  if (!parsed || !Array.isArray(parsed.models)) return null

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

    results.push({
      id: effectiveId,
      canonicalId,
      provider,
      upstreamProvider: source === 'vercel' ? 'vercel' : source,
      name,
      displayName: safeString(model?.displayName) || name,
      description: safeString(model?.description) || undefined,
      tags,
      contextWindow: typeof model?.contextWindow === 'number' ? model.contextWindow : undefined,
      maxOutputTokens: typeof model?.maxOutputTokens === 'number' ? model.maxOutputTokens : undefined,
      purpose,
      pricing: typeof model?.pricing === 'object' ? model.pricing : undefined,
      features:
        typeof model?.features === 'object'
          ? model.features
          : deriveFeatures(tags, typeof model?.contextWindow === 'number' ? model.contextWindow : undefined, undefined),
      category: model?.category,
      source,
      transport,
      connectionId
    })
  }

  return results
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message
  return safeString(error) || 'unknown error'
}

function shouldUseFallback({ fetchedCount, previousCount }: { fetchedCount: number; previousCount: number }) {
  if (!previousCount) {
    return fetchedCount === 0
  }
  if (fetchedCount === 0) return true
  const dropRatio = fetchedCount / previousCount
  return dropRatio < 0.5
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

export function _shouldUseFallbackForTest(args: { fetchedCount: number; previousCount: number }) {
  return shouldUseFallback(args)
}

export function _buildSourceFallbackWarningForTest(args: {
  useFallback: boolean
  fetchedCount: number
  previousCount: number
}) {
  return buildSourceFallbackWarning(args)
}

function buildModelKey(model: any): string {
  const aaSlug = safeString(model?.aaSlug).trim()
  if (aaSlug) return aaSlug
  const canonical = safeString(model?.canonicalId).trim()
  if (canonical) return canonical
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
  minimax: fetchMiniMaxEntries,
  mimo: fetchMimoEntries,
  qwencloud: fetchQwenCloudEntries,
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
  minimax: ['MINIMAX_API_KEY'],
  mimo: ['MIMO_API_KEY'],
  qwencloud: ['DASHSCOPE_API_KEY'],
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

  const createSourceOptions = (): SourceFetchOptions => ({
    signal: AbortSignal.timeout(CATALOG_SOURCE_TIMEOUT_MS)
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
        ? buildFallbackEntriesFromExisting({
            existing,
            connectionId: asDirectConnectionId(provider),
            source: 'direct',
            transport: 'direct'
          }).length
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
    ...DIRECT_PROVIDER_IDS.map((provider) => DIRECT_SOURCE_FETCHERS[provider](createSourceOptions()))
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
  const useGatewayFallback =
    !gatewayEntriesFresh ||
    shouldUseFallback({
      fetchedCount: gatewayEntriesFresh.length,
      previousCount: previousGatewayCount
    })

  const gatewayEntries = useGatewayFallback ? gatewayFallback : gatewayEntriesFresh
  if (!hasExisting && (!gatewayEntriesFresh || gatewayEntriesFresh.length === 0)) {
    const reason = gatewayError ? ` (${gatewayError})` : ''
    throw new Error(`Gateway model import failed and no existing catalog is available${reason}`)
  }

  sources.push({
    connectionId: 'vercel-gateway',
    ok: Boolean(gatewayEntriesFresh) && !useGatewayFallback,
    usedFallback: useGatewayFallback,
    fetchedCount: gatewayEntriesFresh?.length ?? 0,
    error: gatewayError,
    warning: buildSourceFallbackWarning({
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
  const useOpenRouterFallback =
    !openRouterEntriesFresh ||
    shouldUseFallback({
      fetchedCount: openRouterEntriesFresh.length,
      previousCount: previousOpenRouterCount
    })

  const openRouterEntries = useOpenRouterFallback ? openRouterFallback : openRouterEntriesFresh

  sources.push({
    connectionId: 'openrouter',
    ok: Boolean(openRouterEntriesFresh) && !useOpenRouterFallback,
    usedFallback: useOpenRouterFallback,
    fetchedCount: openRouterEntriesFresh?.length ?? 0,
    error: openRouterError,
    warning: buildSourceFallbackWarning({
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

    const fresh = result.status === 'fulfilled' ? mapDirectProviderEntries(provider, result.value) : null
    const error = result.status === 'rejected' ? normalizeError(result.reason) : undefined
    const fallback = existing
      ? buildFallbackEntriesFromExisting({
          existing,
          connectionId,
          source: 'direct',
          transport: 'direct'
        })
      : []
    const previousCount = previousDirectCounts[provider] ?? 0
    const useFallback =
      !fresh ||
      shouldUseFallback({
        fetchedCount: fresh.length,
        previousCount
      })

    const entries = useFallback ? fallback : fresh
    sources.push({
      connectionId,
      ok: Boolean(fresh) && !useFallback,
      usedFallback: useFallback,
      skipped: !sourceConfigured,
      fetchedCount: fresh?.length ?? 0,
      error,
      warning: !sourceConfigured
        ? `API key not configured; ${previousCount ? 'preserving previous list' : 'skipping import'}`
        : buildSourceFallbackWarning({
            useFallback,
            previousCount,
            fetchedCount: fresh?.length ?? 0
          })
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

  const allEntries = [
    ...gatewayEntries.map((entry) => enrichWithAA(entry, aaMap)),
    ...openRouterEntries.map((entry) => enrichWithAA(entry, aaMap)),
    ...DIRECT_PROVIDER_IDS.flatMap((provider) =>
      directEntriesByProvider[provider].map((entry) => enrichWithAA(entry, aaMap))
    )
  ]

  const merged = mergeCatalogEntries(allEntries).sort((a, b) => a.displayName.localeCompare(b.displayName))
  assertCatalogIdentityIntegrity(merged)

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

  await uploadCatalog(payload)
  const directTotal = DIRECT_PROVIDER_IDS.reduce(
    (total, provider) => total + directEntriesByProvider[provider].length,
    0
  )
  logger.debug(
    `[catalog] Uploaded ${merged.length} models (vercel=${gatewayEntries.length}, openrouter=${openRouterEntries.length}, direct=${directTotal})`
  )
  const diff = buildCatalogSyncDiff({ previous: existing, next: payload })
  const reportBase = {
    status: computeCatalogSyncStatus(sources),
    fetchedAt: payload.fetchedAt,
    previousFetchedAt: safeString(existing?.fetchedAt) || undefined,
    sources,
    diff,
    warningStreak: 0,
    warningAlert: null
  }

  let report: CatalogSyncReport = reportBase

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
        diff: reportBase.diff
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
