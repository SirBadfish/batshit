import { randomUUID } from 'node:crypto'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import type { ModelCapabilities, ModelEnrichmentSnapshot } from '$lib/types/savedModels'
import { sanitizeCatalogMaxOutputTokens } from '$lib/utils/modelOutputTokens'

const DEFAULT_API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models'
const CATALOG_CACHE_KEY = 'aa_cache:catalog'
const MODEL_CACHE_PREFIX = 'aa_cache:model:'
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

export interface ArtificialAnalysisRawModel {
  id?: string
  slug?: string
  name?: string
  model?: string
  modelId?: string
  provider?: string
  vendor?: string
  host?: string
  family?: string
  context_window?: number
  context?: number
  max_context?: number
  contextTokens?: number
  context_window_tokens?: number
  max_output_tokens?: number | string
  maxOutputTokens?: number | string
  output_token_limit?: number | string
  outputTokenLimit?: number | string
  max_completion_tokens?: number | string
  input_cost_per_million?: number | string
  output_cost_per_million?: number | string
  cached_input_cost_per_million?: number | string
  input_price?: number | string
  output_price?: number | string
  cached_input_price?: number | string
  pricing?: {
    input?: number | string
    output?: number | string
    cached_input?: number | string
  }
  capabilities?: Record<string, unknown> | string[]
  modalities?: string[]
  tags?: string[]
}

export interface CatalogCache {
  items: ArtificialAnalysisRawModel[]
  fetchedAt: string
}

export interface EnrichmentRequest {
  provider?: string
  modelId?: string
  modelName?: string
  vercelModelId?: string
  forceRefresh?: boolean
}

export interface EnrichmentResult extends ModelEnrichmentSnapshot {
  identifier: string
  provider?: string
  modelName?: string
}

/**
 * Fetch the Artificial Analysis catalog (cached in Redis for 7 days).
 */
async function loadCatalog(forceRefresh = false): Promise<CatalogCache> {
  if (!forceRefresh) {
    const cached = (await redis.get(CATALOG_CACHE_KEY)) as CatalogCache | null
    if (cached?.items?.length) {
      return cached
    }
  }

  const apiKey = env.ARTIFICIAL_ANALYSIS_API_KEY
  if (!apiKey) {
    throw new Error('ARTIFICIAL_ANALYSIS_API_KEY is not set')
  }

  const apiUrl = env.ARTIFICIAL_ANALYSIS_API_URL || DEFAULT_API_URL
  const response = await fetch(apiUrl, {
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(`Artificial Analysis API request failed (${response.status})`)
  }

  const payload = await response.json()
  const models: ArtificialAnalysisRawModel[] =
    payload?.models ||
    payload?.data?.models ||
    payload?.data ||
    payload?.items ||
    []

  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Artificial Analysis API returned an empty model list')
  }

  const catalog: CatalogCache = {
    items: models,
    fetchedAt: new Date().toISOString()
  }

  await redis.set(CATALOG_CACHE_KEY, catalog)
  await redis.expire(CATALOG_CACHE_KEY, CACHE_TTL_SECONDS)

  return catalog
}

function normaliseKey(value: string | undefined | null) {
  if (!value) return null
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function buildCandidateKeys(request: EnrichmentRequest): string[] {
  const keys = new Set<string>()

  if (request.vercelModelId) {
    const normalized = normaliseKey(request.vercelModelId)
    if (normalized) keys.add(normalized)
  }

  if (request.provider && request.modelId) {
    const normalized = normaliseKey(`${request.provider}/${request.modelId}`)
    if (normalized) keys.add(normalized)
  }

  if (request.modelId) {
    const normalized = normaliseKey(request.modelId)
    if (normalized) keys.add(normalized)
  }

  if (request.modelName) {
    const normalized = normaliseKey(request.modelName)
    if (normalized) keys.add(normalized)
  }

  return Array.from(keys).filter(Boolean)
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function deriveCapabilities(raw: ArtificialAnalysisRawModel): ModelCapabilities | undefined {
  const capabilities: ModelCapabilities = {}
  const buckets = new Set<string>()

  const add = (entry: unknown) => {
    if (!entry) return
    buckets.add(String(entry).toLowerCase())
  }

  if (Array.isArray(raw.capabilities)) raw.capabilities.forEach(add)
  if (Array.isArray(raw.modalities)) raw.modalities.forEach(add)
  if (Array.isArray(raw.tags)) raw.tags.forEach(add)
  if (raw.capabilities && !Array.isArray(raw.capabilities) && typeof raw.capabilities === 'object') {
    for (const [key, value] of Object.entries(raw.capabilities)) {
      if (value === true) add(key)
    }
  }

  if (buckets.has('streaming')) capabilities.streaming = true
  if (buckets.has('vision') || buckets.has('image')) capabilities.vision = true
  if (buckets.has('json') || buckets.has('json-mode')) capabilities.jsonMode = true
  if (buckets.has('tools') || buckets.has('tool')) capabilities.tools = true
  if (buckets.has('reasoning')) capabilities.reasoning = true
  if (buckets.has('cache')) capabilities.cacheControl = true
  if (buckets.has('long-context') || buckets.has('long')) capabilities.longContext = true
  if (buckets.has('code')) capabilities.code = true
  if (buckets.has('fast')) capabilities.fast = true
  if (buckets.has('audio')) capabilities.audio = true
  if (buckets.has('image')) capabilities.image = true

  return Object.keys(capabilities).length > 0 ? capabilities : undefined
}

function identifierFromRecord(record: ArtificialAnalysisRawModel) {
  return (
    normaliseKey(record.slug) ||
    normaliseKey(record.id) ||
    normaliseKey(record.model) ||
    normaliseKey(record.name) ||
    normaliseKey(`${record.provider}/${record.model}`)
  )
}

function mapRecord(record: ArtificialAnalysisRawModel): EnrichmentResult {
  const pricingInput =
    toNumber(record.input_cost_per_million) ??
    toNumber(record.pricing?.input) ??
    toNumber(record.input_price)
  const pricingOutput =
    toNumber(record.output_cost_per_million) ??
    toNumber(record.pricing?.output) ??
    toNumber(record.output_price)
  const pricingCached =
    toNumber(record.cached_input_cost_per_million) ??
    toNumber(record.pricing?.cached_input) ??
    toNumber(record.cached_input_price)

  const contextWindow =
    toNumber(record.context_window) ??
    toNumber(record.context_window_tokens) ??
    toNumber(record.context) ??
    toNumber(record.max_context) ??
    toNumber(record.contextTokens)
  const maxOutputTokens = sanitizeCatalogMaxOutputTokens({
    maxOutputTokens:
      toNumber(record.max_output_tokens) ??
      toNumber(record.maxOutputTokens) ??
      toNumber(record.output_token_limit) ??
      toNumber(record.outputTokenLimit) ??
      toNumber(record.max_completion_tokens),
    contextWindow,
    unknownContextCeiling: 64_000
  })

  return {
    identifier: identifierFromRecord(record) || randomUUID(),
    provider:
      record.provider?.toLowerCase() || record.vendor?.toLowerCase() || record.host?.toLowerCase(),
    modelName: record.name || record.model || record.slug || record.id,
    contextWindow: contextWindow,
    maxOutputTokens,
    pricing: {
      input: pricingInput,
      output: pricingOutput,
      cachedInput: pricingCached
    },
    capabilities: deriveCapabilities(record),
    source: 'artificial-analysis',
    fetchedAt: new Date().toISOString()
  }
}

async function cacheResult(keys: string[], result: EnrichmentResult) {
  await Promise.all(
    keys.map(async (key) => {
      const cacheKey = `${MODEL_CACHE_PREFIX}${key}`
      await redis.set(cacheKey, result)
      await redis.expire(cacheKey, CACHE_TTL_SECONDS)
    })
  )
}

async function lookupCachedResult(keys: string[], forceRefresh?: boolean): Promise<EnrichmentResult | null> {
  if (forceRefresh) return null

  for (const key of keys) {
    const cached = (await redis.get(`${MODEL_CACHE_PREFIX}${key}`)) as EnrichmentResult | null
    if (cached) {
      return cached
    }
  }

  return null
}

function findMatchingRecord(models: ArtificialAnalysisRawModel[], keys: string[]): ArtificialAnalysisRawModel | null {
  if (models.length === 0) return null
  if (keys.length === 0) return null

  const trackers = keys.map((key) => key.replace(/-/g, ''))

  for (const record of models) {
    const allCandidates = [
      normaliseKey(record.slug),
      normaliseKey(record.id),
      normaliseKey(record.name),
      normaliseKey(record.model),
      normaliseKey(record.modelId),
      normaliseKey(`${record.provider}/${record.model}`),
      normaliseKey(`${record.provider}/${record.slug}`)
    ].filter(Boolean)

    if (allCandidates.length === 0) continue

    const condensed = new Set(allCandidates.map((value) => value!.replace(/-/g, '')))
    if (trackers.some((candidate) => condensed.has(candidate))) {
      return record
    }
  }

  return null
}

export async function getArtificialAnalysisEnrichment(
  request: EnrichmentRequest
): Promise<EnrichmentResult | null> {
  const keys = buildCandidateKeys(request)
  if (keys.length === 0) {
    throw new Error('No identifiers provided for enrichment request')
  }

  const cached = await lookupCachedResult(keys, request.forceRefresh)
  if (cached) {
    return cached
  }

  const catalog = await loadCatalog(request.forceRefresh)
  const record = findMatchingRecord(catalog.items, keys)
  if (!record) {
    return null
  }

  const result = mapRecord(record)
  await cacheResult(keys, result)
  return result
}

export async function clearArtificialAnalysisCache() {
  await redis.del(CATALOG_CACHE_KEY)
}
