import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'

export interface N8NCredentialStatusResult {
  available: boolean
  statuses: Record<string, boolean>
  error?: string
  requestedTypes: string[]
  detectedTypes: string[]
}

type N8NStatusOptions = {
  userId?: string | null
}

const CACHE_TTL_MS = 60 * 1000
const credentialCache = new Map<
  string,
  { expiresAt: number; data: Record<string, boolean>; detectedTypes: string[] }
>()

const normalizeTypes = (types: string[]) =>
  Array.from(
    new Set(
      types
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  ).sort()

const normalizeTypeName = (value?: string | null) =>
  value?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''

async function resolveN8NApiKey(options?: N8NStatusOptions) {
  if (env.N8N_API_KEY) {
    return env.N8N_API_KEY
  }
  if (options?.userId) {
    const stored = await apiKeyService.retrieve('n8n_api_key', options.userId)
    if (stored) return stored
  }
  return null
}

async function resolveN8NApiUrl(options?: N8NStatusOptions) {
  if (env.N8N_API_URL) {
    return env.N8N_API_URL
  }
  if (options?.userId) {
    const stored = await apiKeyService.retrieve('n8n_api_url', options.userId)
    if (stored) return stored
  }
  return null
}

export async function getN8NCredentialStatuses(
  types: string[],
  options?: N8NStatusOptions
): Promise<N8NCredentialStatusResult> {
  const requestedTypes = normalizeTypes(types)
  const emptyStatuses = Object.fromEntries(requestedTypes.map((type) => [type, false]))

  if (!requestedTypes.length) {
    return {
      available: true,
      statuses: {},
      requestedTypes,
      detectedTypes: []
    }
  }

  const apiKey = await resolveN8NApiKey(options)

  if (!apiKey) {
    return {
      available: false,
      statuses: emptyStatuses,
      requestedTypes,
      detectedTypes: [],
      error: 'N8N_API_KEY is not configured'
    }
  }

  const cacheKey = `${options?.userId ?? 'global'}|${requestedTypes.join('|')}`
  const cached = credentialCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return {
      available: true,
      statuses: { ...cached.data },
      requestedTypes,
      detectedTypes: [...cached.detectedTypes]
    }
  }

  const rawBaseUrl = (await resolveN8NApiUrl(options)) || env.N8N_API_URL || 'http://localhost:5678'
  const baseUrl = rawBaseUrl.replace(/\/+$/, '')
  const endpoint = `${baseUrl}/api/v1/credentials`

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'X-N8N-API-KEY': apiKey,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) {
      let errorMessage = `n8n API responded with status ${response.status}`
      if (response.status === 403) {
        errorMessage =
          'n8n API key is missing permission to list credentials. Enable the credential:list scope (requires n8n Pro/Enterprise).'
      } else if (response.status === 404) {
        errorMessage =
          'n8n API endpoint not found. Confirm that N8N_API_URL points to your instance (e.g. https://host/app) and that /api/v1/ is accessible.'
      }
      return {
        available: false,
        statuses: emptyStatuses,
        requestedTypes,
        detectedTypes: [],
        error: errorMessage
      }
    }

    const payload = await response.json()
    const list = Array.isArray(payload) ? payload : payload?.data ?? []

    const canonicalEntries = requestedTypes.map((type) => ({
      canonical: type,
      normalized: normalizeTypeName(type)
    }))

    const resolveCanonical = (normalizedType: string) => {
      for (const entry of canonicalEntries) {
        if (
          normalizedType === entry.normalized ||
          normalizedType.endsWith(entry.normalized) ||
          entry.normalized.endsWith(normalizedType)
        ) {
          return entry.canonical
        }
      }
      return undefined
    }

    const resolvedStatuses: Record<string, boolean> = { ...emptyStatuses }
    const detectedTypes: string[] = []

    for (const credential of list) {
      const rawType =
        (credential?.type as string | undefined) ??
        (credential?.credentialType as string | undefined) ??
        (credential?.name as string | undefined)
      if (!rawType) continue
      detectedTypes.push(rawType)
      const normalized = normalizeTypeName(rawType)
      const canonical = resolveCanonical(normalized)
      if (!canonical) continue
      resolvedStatuses[canonical] = true
    }

    credentialCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      data: resolvedStatuses,
      detectedTypes
    })

    return {
      available: true,
      statuses: resolvedStatuses,
      requestedTypes,
      detectedTypes
    }
  } catch (error: any) {
    return {
      available: false,
      statuses: emptyStatuses,
      requestedTypes,
      detectedTypes: [],
      error: error?.message || 'Failed to reach n8n API'
    }
  }
}
