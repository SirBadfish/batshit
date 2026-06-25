import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'
import { cacheCompatibilityMatrixSnapshot } from '$lib/server/services/compatibilityMatrix'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { upstashKvGet, upstashKvSet } from '$lib/server/services/upstashKv'

const PUBLISHED_KEY = 'compatibility-matrix:v1'
const PUBLIC_MATRIX_FALLBACK = 'https://api.batshit.ai/registry/compatibility-matrix.json'

function buildRegistryUrlCandidates(...candidates: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>()

  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) continue
    deduped.add(value)
  }

  return Array.from(deduped)
}

function normalizeSnapshot(payload: unknown): CompatibilityMatrixSnapshot | null {
  if (!payload || typeof payload !== 'object') return null
  const snapshot = payload as Partial<CompatibilityMatrixSnapshot>
  if (!Array.isArray(snapshot.entries)) return null

  return {
    version: typeof snapshot.version === 'number' ? snapshot.version : 1,
    fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : new Date().toISOString(),
    entries: snapshot.entries
  }
}

async function fetchPublishedMatrixFromUrl(
  url: string
): Promise<CompatibilityMatrixSnapshot | null> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch compatibility matrix from ${url} (${response.status})`)
  }

  const payload = await response.json().catch(() => null)
  return normalizeSnapshot(payload)
}

async function fetchPublishedMatrixFromUpstash(): Promise<CompatibilityMatrixSnapshot | null> {
  const parsed = await upstashKvGet<unknown>(PUBLISHED_KEY, { required: false })
  if (!parsed) return null
  return normalizeSnapshot(parsed)
}

export async function publishCompatibilityMatrix(
  snapshot: CompatibilityMatrixSnapshot
): Promise<CompatibilityMatrixSnapshot> {
  const published: CompatibilityMatrixSnapshot = {
    version: snapshot.version ?? 1,
    fetchedAt: new Date().toISOString(),
    entries: Array.isArray(snapshot.entries) ? snapshot.entries : []
  }

  await upstashKvSet(PUBLISHED_KEY, published)
  await cacheCompatibilityMatrixSnapshot(published)
  return published
}

export async function loadPublishedCompatibilityMatrix(): Promise<CompatibilityMatrixSnapshot> {
  const [
    explicitCompatibilityUrl,
    explicitMatrixUrl,
    explicitFallbackUrl,
    kvUrl,
    kvReadOnlyToken,
    kvWriteToken
  ] = await Promise.all([
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
    ...(hasUpstash ? [() => fetchPublishedMatrixFromUpstash()] : []),
    ...registryUrls.map((url) => () => fetchPublishedMatrixFromUrl(url))
  ]

  for (const loader of loaders) {
    try {
      const snapshot = await loader()
      if (snapshot) {
        return snapshot
      }
    } catch (error) {
      console.warn('[compatibilityMatrixAdmin] Failed to load published matrix snapshot:', error)
    }
  }

  throw new Error('Unable to load published compatibility matrix snapshot')
}
