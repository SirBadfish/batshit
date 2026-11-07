import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import type { ProviderFeatures } from '$lib/server/services/providers'
import type { ModelPurpose } from '$lib/types/savedModels'
import type { CatalogModelIdVariant } from '$lib/types/modelCatalog'
import { inferModelPurpose, reviewedModelPurpose } from '$lib/utils/modelPurpose'
import { normalizePositiveInteger, sanitizeCatalogMaxOutputTokens } from '$lib/utils/modelOutputTokens'
import {
  buildListedPricing,
  gatewayZeroPriceContext,
  listedPriceVaries,
  readListedPerTokenPrice,
  withoutFalseZeros,
  type ZeroPriceContext
} from '$lib/utils/catalogPricing'
import { upstashKvGet } from '$lib/server/services/upstashKv'
import { assertCatalogReasoningConservation, retainCatalogReasoningRows } from '$lib/utils/catalogReasoningEvidence'

const GATEWAY_FALLBACK_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/models'
const PUBLIC_REGISTRY_FALLBACK = 'https://api.batshit.ai/registry/catalog.json'
const LEGACY_REGISTRY_FALLBACK = 'https://registry.batshit.ai/registry/catalog.json'
const CACHE_KEY = 'vercel:model_catalog:v1'
const CACHE_FRESH_SECONDS = 60 * 60 // freshness, never expiry of last-good facts

/** Same-key raw CAS; STRING caches keep their type, with no delete/recreate conversion. */
export const CATALOG_CACHE_COMPARE_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'ReJSON-RL' or kind == 'JSON' then kind = 'json' end
if kind ~= ARGV[1] then return 'CHANGED' end
local current = ''
if kind == 'json' then current = redis.call('JSON.GET', KEYS[1], '$')
elseif kind == 'string' then current = redis.call('GET', KEYS[1]) end
if current ~= ARGV[2] then return 'CHANGED' end
if ARGV[3] == 'SET' then
  local written
  if kind == 'string' then written = redis.call('SET', KEYS[1], ARGV[4])
  else written = redis.call('JSON.SET', KEYS[1], '$', ARGV[4]) end
  if type(written) ~= 'table' or written.ok ~= 'OK' then return 'UNWRITTEN' end
end
redis.call('PERSIST', KEYS[1])
return 'OK'
`

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

interface CatalogCacheSnapshot {
  kind: 'none' | 'json' | 'string'
  raw: string
  payload: CatalogCachePayload | null
}

class CatalogLoadUnavailableError extends Error {}

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

/**
 * The cached catalog's `fetchedAt`, read without the payload (one small path read): a caller that
 * keeps something built from the catalog can tell whether the cache changed. null when no catalog
 * is cached or it carries no stamp. Never the network.
 */
export async function readCachedVercelModelCatalogStamp(): Promise<string | null> {
  const answer = await redis.execute(async client => {
    const kind = await client.type(CACHE_KEY)
    if (kind === 'none') return null
    if (kind === 'string') {
      const raw = await client.get(CACHE_KEY)
      if (raw === null) throw new Error('The legacy catalog cache disappeared while reading its stamp.')
      return [admitCatalogCache(JSON.parse(raw)).fetchedAt]
    }
    if (!['ReJSON-RL', 'json', 'JSON'].includes(kind)) throw new Error('The catalog cache has an unsupported storage type.')
    return client.json.get(CACHE_KEY, { path: '$.fetchedAt' })
  })
  const stamp = Array.isArray(answer) ? answer[0] : null
  return typeof stamp === 'string' && stamp.length > 0 ? stamp : null
}

/**
 * The cached catalog as stored, whatever its age, or null when none is cached (review of BL-517).
 * Never the network: a send checks a gateway preset against this and must not wait on the
 * registry, Upstash, or the gateway's own list, which `fetchVercelModelCatalog` tries one after
 * another with no time limit once the hour-old cache is stale.
 */
export async function readCachedVercelModelCatalog(): Promise<CatalogCachePayload | null> {
  const cached = (await redis.get(CACHE_KEY)) as CatalogCachePayload | null
  // Preserve the send reader's best-effort behavior, including admitted legacy STRING caches.
  try {
    const value = typeof cached === 'string' ? admitCatalogCache(JSON.parse(cached)) : cached
    return value?.models?.length ? correctReviewedMetadata(value) : null
  } catch { return null }
}

export async function fetchVercelModelCatalog(forceRefresh = false): Promise<CatalogCachePayload> {
  const snapshot = await readCatalogCacheForRefresh()
  const cached = snapshot.payload
  if (!forceRefresh) {
    if (cached?.models?.length) {
      const fetchedAt = cached.fetchedAt ? new Date(cached.fetchedAt).getTime() : 0
      const ageMs = Date.now() - fetchedAt
      const stale = !fetchedAt || ageMs > CACHE_FRESH_SECONDS * 1000
      if (!stale) {
        return cached
      }
      // Try to refresh; if it fails, fall back to cached
      try {
        const refreshed = await loadCatalogAndCache(snapshot)
        if (refreshed?.models?.length) return refreshed
      } catch (err) {
        if (!(err instanceof CatalogLoadUnavailableError)) throw err
        console.warn(
          `[modelCatalog] Refresh failed, falling back to cached copy: ${formatLoaderError(err)}`
        )
        return cached
      }
    }
  }

  return await loadCatalogAndCache(snapshot)
}

/** A failed prior read must never masquerade as an empty cache before replacement. */
export async function readCatalogCacheSnapshot(): Promise<CatalogCacheSnapshot> {
  return redis.execute(async client => {
    const type = await client.type(CACHE_KEY)
    if (type === 'none') return { kind: 'none', raw: '', payload: null }
    let raw: unknown
    let kind: CatalogCacheSnapshot['kind']
    if (type === 'ReJSON-RL' || type === 'json' || type === 'JSON') {
      kind = 'json'
      raw = await client.sendCommand(['JSON.GET', CACHE_KEY, '$'])
    } else if (type === 'string') {
      kind = 'string'
      raw = await client.get(CACHE_KEY)
    } else throw new Error('The prior model catalog cache has an unsupported storage type; refresh was refused.')
    if (typeof raw !== 'string') throw new Error('The prior model catalog cache raw read failed; refresh was refused.')
    // Parse actual raw text, never an already-decoded RedisJSON object or facade get.
    const decoded = JSON.parse(raw)
    if (kind === 'json' && (!Array.isArray(decoded) || decoded.length !== 1)) throw new Error('The prior model catalog cache root is malformed.')
    return { kind, raw, payload: admitCatalogCache(kind === 'json' ? decoded[0] : decoded) }
  })
}

function admitCatalogCache(value: unknown): CatalogCachePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as CatalogCachePayload).models)) {
    throw new Error('The prior model catalog cache is malformed; refresh was refused.')
  }
  const payload = value as CatalogCachePayload
  assertCatalogReasoningConservation(payload.models, payload.models)
  return correctReviewedMetadata(payload)
}

/** Read projection only; the original raw snapshot remains the CAS authority. */
function correctReviewedMetadata(payload: CatalogCachePayload): CatalogCachePayload {
  return { ...payload, models: payload.models.map(entry => {
    const connectionId = entry.connectionId ?? inferConnectionId(entry.transport ?? inferTransport(entry.source), normalize(entry.provider))
    const purpose = reviewedModelPurpose({ connectionId,
      id: entry.idVariants?.[connectionId]?.effectiveId ?? entry.id, modelType: entry.modelType })
    const corrected = purpose && purpose !== entry.purpose ? { ...entry, purpose } : entry
    // The plan uses subscription Credits. A gateway/AA USD price cannot price
    // this connection, including on a retained snapshot made before this rule.
    const planVariant = corrected.idVariants?.['direct:mimo_token_plan']
    if (!planVariant && connectionId !== 'direct:mimo_token_plan') return corrected
    return { ...corrected,
      ...(connectionId === 'direct:mimo_token_plan' ? { pricing: {} } : {}),
      ...(planVariant ? { idVariants: { ...corrected.idVariants,
        'direct:mimo_token_plan': { ...planVariant, pricing: {} } } } : {}) }
  }) }
}

async function compareCatalogCache(snapshot: CatalogCacheSnapshot, value?: CatalogCachePayload): Promise<boolean> {
  const answer = await redis.execute(client => client.eval(CATALOG_CACHE_COMPARE_SCRIPT, { keys: [CACHE_KEY],
    arguments: [snapshot.kind, snapshot.raw, value ? 'SET' : 'PERSIST', value ? JSON.stringify(value) : ''] }))
  if (answer === 'OK') return true
  if (answer === 'CHANGED') return false
  throw new Error('The model catalog cache write was not confirmed; the refresh was refused.')
}

async function readCatalogCacheForRefresh(): Promise<CatalogCacheSnapshot> {
  const snapshot = await readCatalogCacheSnapshot()
  // Remove a surviving old TTL before network requests can fail. Never extend user data keys.
  if (snapshot.payload && !await compareCatalogCache(snapshot)) {
    throw new Error('The model catalog cache changed while being admitted; refresh was refused.')
  }
  return snapshot
}

async function loadCatalogAndCache(previous: CatalogCacheSnapshot): Promise<CatalogCachePayload> {
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
    let result: CatalogCachePayload | null
    try {
      result = await loader.run()
      if (result?.models?.length) {
        if (loader.name === 'vercel-gateway') {
          console.warn('[modelCatalog] Shared catalog unavailable; using Gateway discovery and retaining cached provider identities when available.')
        }
        result.models = retainCatalogReasoningRows(previous.payload?.models ?? [], result.models, {
          retainMissing: loader.name === 'vercel-gateway', authoritative: loader.name !== 'vercel-gateway'
        })
        result = correctReviewedMetadata(result)
      } else continue
    } catch (error) {
      failures.push(`${loader.name}: ${formatLoaderError(error)}`)
      continue
    }
    // Publication errors must not become another loader/fallback attempt.
    if (await compareCatalogCache(previous, result)) return result
    const winner = await readCatalogCacheForRefresh()
    if (!winner.payload?.models.length) throw new Error('The winning model catalog cache is missing; the losing refresh was not written.')
    return winner.payload
  }

  if (failures.length) {
    console.warn(`[modelCatalog] All loaders failed: ${failures.join(' | ')}`)
  }

  throw new CatalogLoadUnavailableError('Unable to load model catalog from registry, Upstash, or Vercel gateway fallback')
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

/**
 * A catalog row by its id or canonical id. BL-68: with a `connectionId`, also a
 * row whose variant for exactly that connection has this id, which is how a
 * preset saved on a row that later merged into another (Anthropic's dated
 * `claude-haiku-4-5-20251001`, now a variant of `anthropic/claude-haiku-4.5`)
 * still finds its model. Never another connection's variant.
 */
export async function findVercelCatalogEntryById(id?: string | null, connectionId?: string | null) {
  if (!id) return null
  const catalog = await fetchVercelModelCatalog()
  const normalized = normalize(id)
  return (
    catalog.models.find((entry) => normalize(entry.id) === normalized) ??
    catalog.models.find((entry) => normalize(entry.canonicalId) === normalized) ??
    (connectionId
      ? catalog.models.find((entry) => normalize(entry.idVariants?.[connectionId]?.effectiveId) === normalized)
      : undefined) ??
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
  const pricing = mapPricing(raw.pricing, gatewayZeroPriceContext(raw))
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
    reviewedModelPurpose({ connectionId, id: idVariants[connectionId]?.effectiveId ?? entry.id, modelType: entry.modelType }) ??
    normalizePurpose(entry.purpose) ??
    inferModelPurpose({ connectionId, modelType: entry.modelType, id: entry.id || canonicalId, name, tags: entry.tags })
  const displayName = entry.source === 'openrouter' ? normalizeOpenRouterDisplayName(rawDisplayName, provider) : rawDisplayName
  // A window of 0 is unknown, never kept as 0: the gateway fallback lists some
  // (mistral-embed), and a registry published before the sync fix still does.
  const contextWindow = normalizePositiveInteger(entry.contextWindow)
  const maxOutputTokens = normalizeCatalogMaxOutputTokens({ ...entry, contextWindow })

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
    contextWindow,
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

/**
 * Gateway pricing is per token; the UI reads dollars per million tokens.
 * BL-131: a listed 0 is a free model and stays 0; a blank or negative price is
 * unknown and stays absent (`catalogPricing.ts` owns the rule for the sync too).
 */
function mapPricing(pricing?: Record<string, unknown>, context: ZeroPriceContext = {}): VercelModelPricing | undefined {
  if (!pricing) return undefined
  return buildListedPricing(
    withoutFalseZeros(
      {
        input: readListedPerTokenPrice(pricing.input ?? pricing.price_1m_input_tokens ?? pricing.price_1m_blended_3_to_1),
        output: readListedPerTokenPrice(pricing.output ?? pricing.price_1m_output_tokens),
        cachedInput: readListedPerTokenPrice(pricing.input_cache_read ?? pricing.cached_input ?? pricing.cached_input_price)
      },
      { ...context, varies: listedPriceVaries(pricing) }
    )
  )
}

function deriveFeatures(tags: string[], contextWindow?: number | null, pricing?: VercelModelPricing): ProviderFeatures {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()))
  // BL-68: a window nobody reported is unknown, so neither it nor the
  // long-context claim built on it is published (never `maxTokens: 0`).
  const knownWindow =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null

  return {
    streaming: true,
    tools: normalized.has('tool-use') || normalized.has('tool') || normalized.has('tools'),
    vision:
      normalized.has('vision') ||
      normalized.has('image') ||
      normalized.has('image-input') ||
      normalized.has('multimodal'),
    ...(knownWindow !== null ? { maxTokens: knownWindow, longContext: knownWindow >= 128_000 } : {}),
    reasoning: normalized.has('reasoning'),
    cacheControl: pricing?.cachedInput !== undefined,
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
