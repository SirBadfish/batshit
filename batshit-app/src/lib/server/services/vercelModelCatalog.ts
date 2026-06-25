import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import type { ProviderFeatures } from '$lib/server/services/providers'
import type { ModelPurpose } from '$lib/types/savedModels'
import type { CatalogModelIdVariant } from '$lib/types/modelCatalog'
import { inferModelPurpose } from '$lib/utils/modelPurpose'
import { sanitizeCatalogMaxOutputTokens } from '$lib/utils/modelOutputTokens'
import { upstashKvGet } from '$lib/server/services/upstashKv'

const GATEWAY_FALLBACK_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/models'
const PUBLIC_REGISTRY_FALLBACK = 'https://api.batshit.ai/registry/catalog.json'
const LEGACY_REGISTRY_FALLBACK = 'https://registry.batshit.ai/registry/catalog.json'
const CACHE_KEY = 'vercel:model_catalog:v1'
const CACHE_TTL_SECONDS = 60 * 60 // 1 hour

export type CatalogSource = 'vercel' | 'legacy' | 'openrouter' | 'n8n-only'
export type CatalogTransport = 'vercel-gateway' | 'openrouter' | 'local'

export interface VercelModelPricing {
  input?: number
  output?: number
  cachedInput?: number
}

export interface VercelCatalogEntry {
  id: string
  canonicalId?: string
  provider: string
  upstreamProvider?: string | null
  name: string
  displayName: string
  description?: string
  tags: string[]
  contextWindow?: number
  maxOutputTokens?: number
  pricing?: VercelModelPricing
  features: ProviderFeatures
  category?: 'fast' | 'balanced' | 'powerful' | 'reasoning' | 'code'
  purpose?: ModelPurpose
  idVariants?: Record<string, CatalogModelIdVariant>
  source: CatalogSource
  transport?: CatalogTransport
  connectionId?: string | null
  availableConnections?: string[]
  modelType?: string | null
}

interface RawGatewayModel {
  id: string
  name: string
  owned_by?: string
  description?: string
  context_window?: number
  max_tokens?: number
  tags?: string[]
  pricing?: Record<string, string | number>
  type?: string
}

interface CatalogCachePayload {
  models: VercelCatalogEntry[]
  fetchedAt: string
  version?: number
  counts?: Record<string, number>
}

async function fetchCatalogFromUrl(url?: string | null): Promise<CatalogCachePayload | null> {
  if (!url) return null

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch catalog from ${url} (${response.status})`)
  }

  const payload = await response.json()
  if (Array.isArray(payload?.models)) {
    const normalized = (payload.models as VercelCatalogEntry[]).map(finalizeCatalogEntry)
    return {
      models: normalized,
      fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
      version: payload.version,
      counts: payload.counts
    }
  }

  // Some endpoints may still return the old gateway format
  const rawModels: RawGatewayModel[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : []

  if (!rawModels.length) {
    return null
  }

  const models = rawModels.map(transformGatewayModel).filter(Boolean) as VercelCatalogEntry[]
  return {
    models: models.map(finalizeCatalogEntry),
    fetchedAt: new Date().toISOString()
  }
}

async function fetchCatalogFromUpstash(): Promise<CatalogCachePayload | null> {
  const parsed = await upstashKvGet<any>('catalog:v1', {
    allowWriteTokenFallback: false,
    required: false
  })
  if (!parsed) return null
  if (!Array.isArray(parsed?.models)) {
    return null
  }

  return {
    models: parsed.models,
    fetchedAt: parsed.fetchedAt ?? new Date().toISOString(),
    version: parsed.version,
    counts: parsed.counts
  }
}

async function fetchGatewayFallback(): Promise<CatalogCachePayload | null> {
  const response = await fetch(GATEWAY_FALLBACK_ENDPOINT)
  if (!response.ok) {
    const errorText = await safeText(response)
    throw new Error(`Failed to fetch Vercel gateway catalog (${response.status}): ${errorText}`)
  }

  const payload = await response.json()
  const rawModels: RawGatewayModel[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : []

  const models = rawModels.map(transformGatewayModel).filter(Boolean) as VercelCatalogEntry[]
  if (!models.length) {
    return null
  }

  return {
    models: models.map(finalizeCatalogEntry),
    fetchedAt: new Date().toISOString()
  }
}

export async function fetchVercelModelCatalog(forceRefresh = false): Promise<CatalogCachePayload> {
  if (!forceRefresh) {
    const cached = (await redis.get(CACHE_KEY)) as CatalogCachePayload | null
    if (cached?.models?.length) {
      const fetchedAt = cached.fetchedAt ? new Date(cached.fetchedAt).getTime() : 0
      const ageMs = Date.now() - fetchedAt
      const stale = !fetchedAt || ageMs > CACHE_TTL_SECONDS * 1000
      if (!stale) {
        return cached
      }
      // Try to refresh; if it fails, fall back to cached
      try {
        const refreshed = await loadCatalogAndCache()
        if (refreshed?.models?.length) return refreshed
      } catch (err) {
        console.warn(
          `[modelCatalog] Refresh failed, falling back to cached copy: ${formatLoaderError(err)}`
        )
        return cached
      }
    }
  }

  return await loadCatalogAndCache()
}

async function loadCatalogAndCache(): Promise<CatalogCachePayload> {
  const registryUrls = buildRegistryUrlCandidates()
  const loaders = [
    ...registryUrls.map((url) => ({
      name: `registry (${url})`,
      run: () => fetchCatalogFromUrl(url)
    })),
    {
      name: 'upstash',
      run: () => fetchCatalogFromUpstash()
    },
    {
      name: 'vercel-gateway',
      run: () => fetchGatewayFallback()
    }
  ]

  const failures: string[] = []
  for (const loader of loaders) {
    try {
      const result = await loader.run()
      if (result?.models?.length) {
        await redis.set(CACHE_KEY, result)
        await redis.expire(CACHE_KEY, CACHE_TTL_SECONDS)
        return result
      }
    } catch (error) {
      failures.push(`${loader.name}: ${formatLoaderError(error)}`)
    }
  }

  if (failures.length) {
    console.warn(`[modelCatalog] All loaders failed: ${failures.join(' | ')}`)
  }

  throw new Error('Unable to load model catalog from registry, Upstash, or Vercel gateway fallback')
}

function buildRegistryUrlCandidates(): string[] {
  const candidates = [
    env.BATSHIT_MODEL_CATALOG_URL,
    env.VERCEL_MODEL_CATALOG_URL,
    PUBLIC_REGISTRY_FALLBACK,
    LEGACY_REGISTRY_FALLBACK
  ]

  const deduped = new Set<string>()
  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) continue
    deduped.add(value)
  }
  return Array.from(deduped)
}

function formatLoaderError(error: unknown): string {
  if (error instanceof Error) {
    const causeMessage = formatErrorCause(error)
    return causeMessage ? `${error.message} (${causeMessage})` : error.message
  }
  return String(error)
}

function formatErrorCause(error: Error): string | null {
  if (!('cause' in error)) return null
  const cause = (error as Error & { cause?: unknown }).cause
  if (!cause || typeof cause !== 'object') return null

  const code = getObjectString(cause, 'code')
  const syscall = getObjectString(cause, 'syscall')
  const hostname = getObjectString(cause, 'hostname')
  const errno = getObjectString(cause, 'errno')

  const parts = [code, syscall, hostname, errno].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

function getObjectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const raw = record[key]
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return String(raw)
  return null
}

export async function findVercelCatalogEntryById(id?: string | null) {
  if (!id) return null
  const catalog = await fetchVercelModelCatalog()
  const normalized = normalize(id)
  return (
    catalog.models.find((entry) => normalize(entry.id) === normalized) ??
    catalog.models.find((entry) => normalize(entry.canonicalId) === normalized) ??
    null
  )
}

export async function findVercelCatalogEntry(provider?: string | null, modelName?: string | null) {
  const catalog = await fetchVercelModelCatalog()
  const normalizedProvider = normalize(provider)
  const normalizedModel = normalize(modelName)

  return (
    catalog.models.find((entry) => normalize(entry.provider) === normalizedProvider && normalize(entry.name) === normalizedModel) ??
    catalog.models.find((entry) => normalize(entry.id) === normalize(`${provider}/${modelName}`))
  )
}

function transformGatewayModel(raw: RawGatewayModel | null | undefined): VercelCatalogEntry | null {
  if (!raw?.id || !raw.name) return null
  const provider = raw.id.split('/')[0]?.toLowerCase() ?? 'unknown'
  const name = raw.id.split('/').slice(1).join('/') || raw.name
  const tags = (raw.tags ?? []).map((tag) => tag.toLowerCase())
  const contextWindow = raw.context_window ?? raw.max_tokens
  const pricing = mapPricing(raw.pricing)
  const category = categorizeModel(tags, contextWindow)

  return {
    id: raw.id,
    provider,
    name,
    displayName: raw.name,
    description: raw.description,
    tags,
    contextWindow: contextWindow ?? undefined,
    maxOutputTokens: sanitizeCatalogMaxOutputTokens({
      maxOutputTokens: raw.max_tokens,
      contextWindow
    }),
    pricing,
    features: deriveFeatures(tags, contextWindow, pricing),
    category,
    source: 'vercel',
    transport: 'vercel-gateway',
    modelType: raw.type ?? null
  }
}

function finalizeCatalogEntry(entry: VercelCatalogEntry): VercelCatalogEntry {
  const provider = normalize(entry.provider)
  const name =
    entry.name ||
    entry.id?.split('/').slice(1).join('/') ||
    entry.displayName ||
    entry.id ||
    ''
  const rawDisplayName = entry.displayName || name || entry.id || ''
  const canonicalId = entry.canonicalId || buildCanonicalId(provider, name)
  const transport = entry.transport ?? inferTransport(entry.source)
  const connectionId = entry.connectionId ?? inferConnectionId(transport, provider)
  const upstreamProvider = entry.upstreamProvider ?? inferUpstreamProvider(entry.source)
  const existingVariants = entry.idVariants ?? {}
  const idVariants: Record<string, CatalogModelIdVariant> = { ...existingVariants }
  if (connectionId && !idVariants[connectionId]) {
    idVariants[connectionId] = {
      developerId: provider,
      modelId: name,
      effectiveId: entry.id || canonicalId,
      source: inferVariantSource(entry.source)
    }
  }

  const availableConnections = Array.from(
    new Set(
      [
        ...(entry.availableConnections ?? []),
        ...Object.keys(idVariants),
        connectionId
      ].filter((value): value is string => Boolean(value))
    )
  )

  const purpose: ModelPurpose =
    normalizePurpose(entry.purpose) ??
    inferModelPurpose({ modelType: entry.modelType, id: entry.id || canonicalId, name, tags: entry.tags })
  const displayName = entry.source === 'openrouter' ? normalizeOpenRouterDisplayName(rawDisplayName, provider) : rawDisplayName
  const maxOutputTokens = normalizeCatalogMaxOutputTokens(entry)

  return {
    ...entry,
    id: entry.id || canonicalId,
    canonicalId,
    provider,
    name,
    displayName,
    transport,
    connectionId,
    upstreamProvider,
    maxOutputTokens,
    availableConnections,
    idVariants: Object.keys(idVariants).length ? idVariants : undefined,
    purpose
  }
}

function normalizeCatalogMaxOutputTokens(entry: VercelCatalogEntry) {
  return sanitizeCatalogMaxOutputTokens({
    maxOutputTokens: entry.maxOutputTokens,
    contextWindow: entry.contextWindow,
    unknownContextCeiling: entry.source === 'openrouter' ? 64_000 : null
  })
}

function inferVariantSource(source?: CatalogSource | null): CatalogModelIdVariant['source'] {
  if (source === 'openrouter') return 'openrouter'
  if (source === 'vercel') return 'vercel'
  return 'manual'
}

function mapPricing(pricing?: Record<string, string | number>): VercelModelPricing | undefined {
  if (!pricing) return undefined
  const toNumber = (value?: string | number) => {
    if (value === undefined || value === null) return undefined
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return undefined
    // Gateway pricing is per token. Convert to per million tokens to match UI expectations.
    const perMillion = parsed * 1_000_000
    return Math.round(perMillion * 1000) / 1000
  }

  const mapped: VercelModelPricing = {
    input: toNumber(pricing.input ?? pricing.price_1m_input_tokens ?? pricing.price_1m_blended_3_to_1),
    output: toNumber(pricing.output ?? pricing.price_1m_output_tokens),
    cachedInput: toNumber(pricing.input_cache_read ?? pricing.cached_input ?? pricing.cached_input_price)
  }

  if (!mapped.input && !mapped.output && !mapped.cachedInput) {
    return undefined
  }

  return mapped
}

function deriveFeatures(tags: string[], contextWindow?: number | null, pricing?: VercelModelPricing): ProviderFeatures {
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

function categorizeModel(tags: string[], contextWindow?: number | null): VercelCatalogEntry['category'] {
  const normalized = tags.map((tag) => tag.toLowerCase())

  if (normalized.includes('reasoning')) return 'reasoning'
  if (normalized.includes('code') || normalized.includes('coding')) return 'code'
  if ((contextWindow ?? 0) >= 200_000) return 'powerful'
  if (normalized.includes('fast') || normalized.includes('realtime')) return 'fast'
  return 'balanced'
}

async function safeText(response: Response) {
  try {
    return await response.text()
  } catch {
    return 'unknown error'
  }
}

function normalize(value?: string | null) {
  return value?.toLowerCase().trim() ?? ''
}

function normalizePurpose(value?: unknown): ModelPurpose | null {
  if (value === 'chat' || value === 'visual' || value === 'audio' || value === 'utility') {
    return value
  }
  if (value === 'vision') {
    return 'visual'
  }
  return null
}

function buildCanonicalId(provider: string, name: string) {
  const normalizedProvider = provider?.length ? provider : 'unknown'
  const normalizedName = name.toLowerCase().trim().replace(/\s+/g, '-')
  return `${normalizedProvider}/${normalizedName || 'model'}`
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
    (providerKey.length > 5 && providerKey.endsWith('ai') && prefixKey.length >= 5 && `${prefixKey}ai` === providerKey) ||
    (providerKey.length > 5 && providerKey.endsWith('tech') && prefixKey.length >= 3 && `${prefixKey}tech` === providerKey) ||
    (providerKey === 'metallama' && prefixKey === 'meta')

  const matchesKnownAlias =
    (providerKey === 'congnativecomputations' && prefixKey === 'cognitivecomputations') ||
    (providerKey === 'cognitivecomputations' && prefixKey === 'congnativecomputations')

  if (!matchesProvider && !matchesKnownAlias) {
    return trimmed
  }

  return remainder || trimmed
}

function inferTransport(source?: CatalogSource | null): CatalogTransport {
  if (source === 'openrouter') return 'openrouter'
  if (source === 'legacy' || source === 'n8n-only') return 'local'
  return 'vercel-gateway'
}

function inferConnectionId(transport: CatalogTransport, provider: string) {
  if (transport === 'openrouter') return 'openrouter'
  if (transport === 'vercel-gateway') return 'vercel-gateway'
  return `direct:${provider}`
}

function inferUpstreamProvider(source?: CatalogSource | null) {
  if (!source) return null
  if (source === 'vercel') return 'vercel'
  if (source === 'openrouter') return 'openrouter'
  if (source === 'legacy') return 'local'
  if (source === 'n8n-only') return 'n8n'
  return source
}
