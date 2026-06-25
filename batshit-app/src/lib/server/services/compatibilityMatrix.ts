import { redis } from '$lib/server/redis'
import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'
import { COMPATIBILITY_MATRIX_SEED } from '$lib/data/compatibility-matrix.seed'
import { COMPATIBILITY_MATRIX_DEFAULT_ENTRIES } from '$lib/data/compatibility-matrix.defaults'
import { buildMatrixScope, resolveMatrixFor } from '$lib/utils/compatibilityMatrix'
import { loadN8nCompatibilitySnapshot } from '$lib/server/services/n8nParameterCompatibility'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { upstashKvGet } from '$lib/server/services/upstashKv'

const PUBLIC_MATRIX_FALLBACK = 'https://api.batshit.ai/registry/compatibility-matrix.json'
const CACHE_KEY = 'compatibility:matrix:v1'
const CACHE_TTL_SECONDS = 60 * 60 // 1 hour

function buildRegistryUrlCandidates(...candidates: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>()

  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) continue
    deduped.add(value)
  }

  return Array.from(deduped)
}

export async function cacheCompatibilityMatrixSnapshot(
  snapshot: CompatibilityMatrixSnapshot
): Promise<void> {
  await redis.set(CACHE_KEY, snapshot)
  await redis.expire(CACHE_KEY, CACHE_TTL_SECONDS)
}

async function fetchMatrixFromUrl(url?: string | null): Promise<CompatibilityMatrixSnapshot | null> {
  if (!url) return null

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch compatibility matrix from ${url} (${response.status})`)
  }

  const payload = await response.json()
  if (!payload || !Array.isArray(payload?.entries)) {
    return null
  }

  return {
    version: payload.version ?? 1,
    fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
    entries: payload.entries
  }
}

async function fetchMatrixFromUpstash(): Promise<CompatibilityMatrixSnapshot | null> {
  const parsed = await upstashKvGet<any>('compatibility-matrix:v1', { required: false })
  if (!parsed) return null
  if (!Array.isArray(parsed?.entries)) {
    return null
  }

  return {
    version: parsed.version ?? 1,
    fetchedAt: parsed.fetchedAt ?? new Date().toISOString(),
    entries: parsed.entries
  }
}

export async function fetchCompatibilityMatrix(forceRefresh = false): Promise<CompatibilityMatrixSnapshot> {
  if (!forceRefresh) {
    const cached = (await redis.get(CACHE_KEY)) as CompatibilityMatrixSnapshot | null
    if (cached?.entries?.length !== undefined) {
      const fetchedAt = cached.fetchedAt ? new Date(cached.fetchedAt).getTime() : 0
      const ageMs = Date.now() - fetchedAt
      const stale = !fetchedAt || ageMs > CACHE_TTL_SECONDS * 1000
      if (!stale) {
        return cached
      }
      try {
        const refreshed = await loadMatrixAndCache()
        if (refreshed?.entries) return refreshed
      } catch (err) {
        console.warn('[compatibilityMatrix] Refresh failed, falling back to cached copy:', err)
        return cached
      }
    }
  }

  return await loadMatrixAndCache()
}

async function mergeLocalN8nMatrix(
  snapshot: CompatibilityMatrixSnapshot
): Promise<CompatibilityMatrixSnapshot> {
  const local = await loadN8nCompatibilitySnapshot()
  if (!local?.entries?.length) return snapshot

  const filtered = snapshot.entries.filter((entry) => entry.scope.connection !== 'n8n')
  return {
    ...snapshot,
    entries: [...filtered, ...local.entries]
  }
}

function mergeDefaultEntries(
  snapshot: CompatibilityMatrixSnapshot
): CompatibilityMatrixSnapshot {
  if (!COMPATIBILITY_MATRIX_DEFAULT_ENTRIES.length) return snapshot

  const existingKeys = new Set(
    snapshot.entries.map((entry) => {
      const scope = entry.scope
      return `${scope.connection}:${scope.provider ?? ''}:${scope.model ?? ''}`
    })
  )

  const additions = COMPATIBILITY_MATRIX_DEFAULT_ENTRIES.filter((entry) => {
    const scope = entry.scope
    const key = `${scope.connection}:${scope.provider ?? ''}:${scope.model ?? ''}`
    return !existingKeys.has(key)
  })

  if (!additions.length) return snapshot

  return {
    ...snapshot,
    entries: [...snapshot.entries, ...additions]
  }
}

async function loadMatrixAndCache(): Promise<CompatibilityMatrixSnapshot> {
  const [
    explicitCompatibilityUrl,
    explicitMatrixUrl,
    explicitFallbackUrl,
    kvUrl,
    kvReadOnlyToken,
    kvWriteToken
  ] =
    await Promise.all([
      getRuntimeEnv('BATSHIT_COMPATIBILITY_MATRIX_URL'),
      getRuntimeEnv('BATSHIT_MATRIX_URL'),
      getRuntimeEnv('COMPATIBILITY_MATRIX_URL'),
      getRuntimeEnv('KV_REST_API_URL'),
      getRuntimeEnv('KV_REST_API_READ_ONLY_TOKEN'),
      getRuntimeEnv('KV_REST_API_TOKEN')
    ])

  const registryUrls = buildRegistryUrlCandidates(
    explicitCompatibilityUrl,
    explicitMatrixUrl,
    explicitFallbackUrl,
    PUBLIC_MATRIX_FALLBACK
  )

  const hasUpstash = Boolean(kvUrl) && Boolean(kvReadOnlyToken || kvWriteToken)

  const loaders = [
    // Server-side reads prefer the primary Upstash snapshot when available so
    // same-run publishes are visible immediately instead of waiting on the
    // cacheable public registry URL to catch up.
    ...(hasUpstash ? [() => fetchMatrixFromUpstash()] : []),
    ...registryUrls.map((url) => () => fetchMatrixFromUrl(url)),
    () => COMPATIBILITY_MATRIX_SEED
  ]

  for (const loader of loaders) {
    try {
      const result = await loader()
      if (result && result.entries) {
        const withDefaults = mergeDefaultEntries(result)
        const merged = await mergeLocalN8nMatrix(withDefaults)
        await cacheCompatibilityMatrixSnapshot(merged)
        return merged
      }
    } catch (error) {
      console.warn('[compatibilityMatrix] Loader failed, trying next option:', error)
    }
  }

  throw new Error('Unable to load Compatibility Matrix from registry, Upstash, or local seed')
}

export { buildMatrixScope, resolveMatrixFor }
