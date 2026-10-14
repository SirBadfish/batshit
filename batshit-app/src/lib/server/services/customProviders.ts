import type { RedisJSON } from '@redis/json'
import { apiKeyEncryption } from '$lib/services/encryption.server'
import { containsSuspiciousInput, normalizeHttpBaseUrl } from '$lib/utils/inputSanitization'
import { sanitizeId, suggestAlternatives } from '$lib/utils/idSanitizer'
import { redis } from '$lib/server/redis'
import type {
  CustomProviderHeaders,
  CustomProviderRuntime,
  CustomProviderSummary,
  CustomProviderUpsertInput
} from '$lib/types/customProviders'

const CUSTOM_PROVIDER_ID_PREFIX = 'custom_'

interface StoredCustomProvider {
  id: string
  label: string
  baseUrl: string
  headers?: CustomProviderHeaders
  apiKeyEncrypted: string
  apiKeyIv: string
  apiKeyAuthTag: string
  createdAt: string
  updatedAt: string
}

function providerKey(userId: string, id: string) {
  return `custom_provider:${userId}:${id}`
}

function providerSetKey(userId: string) {
  return `user:${userId}:custom_providers`
}

function normalizeBaseUrl(value: string): string {
  return normalizeHttpBaseUrl(value)
}

function normalizeLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Provider name is required')
  }
  if (containsSuspiciousInput(trimmed)) {
    throw new Error('Provider name contains invalid characters')
  }
  return trimmed
}

function normalizeHeaders(headers?: CustomProviderHeaders | null): CustomProviderHeaders | undefined {
  if (!headers) return undefined
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.trim(), String(value ?? '').trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)

  if (!entries.length) return undefined

  const normalized: CustomProviderHeaders = {}
  for (const [key, value] of entries) {
    if (containsSuspiciousInput(key) || containsSuspiciousInput(value)) {
      throw new Error('Header values contain invalid characters')
    }
    normalized[key] = value
  }

  return Object.keys(normalized).length ? normalized : undefined
}

/**
 * BL-587: the saved key of a provider an edit keeps, or a plain refusal that
 * names what to do. A normal backup leaves the key out, so a restored record's
 * three key fields are `null`.
 */
function readSavedApiKey(record: StoredCustomProvider): string {
  const fields = [record.apiKeyEncrypted, record.apiKeyIv, record.apiKeyAuthTag] as unknown[]
  if (fields.some((field) => typeof field !== 'string' || field.length === 0)) {
    throw new Error(
      `Custom provider "${record.label}" has no saved API key (a backup that leaves secrets out does not carry it). Enter its API key to save it.`
    )
  }
  let apiKey: string
  try {
    apiKey = apiKeyEncryption.decrypt(record.apiKeyEncrypted, record.apiKeyIv, record.apiKeyAuthTag)
  } catch {
    throw new Error(
      `The saved API key of custom provider "${record.label}" cannot be read. Enter its API key again to save it.`
    )
  }
  if (!apiKey) {
    throw new Error(`Custom provider "${record.label}" has no saved API key. Enter its API key to save it.`)
  }
  return apiKey
}

/**
 * Packet 5 finding 1: the saved key when it can be used, else `null`. One rule
 * for the summary's `apiKeyUsable` and for the run. The log names the provider
 * id only, never the key or the decrypt error.
 */
function readUsableApiKey(record: StoredCustomProvider): string | null {
  try {
    return readSavedApiKey(record)
  } catch {
    console.warn(`[Custom Providers] The saved API key of ${record.id} is missing or cannot be read`)
    return null
  }
}

async function loadCustomProvider(userId: string, id: string): Promise<StoredCustomProvider | null> {
  return await redis.execute(async (client) => {
    return (await client.json.get(providerKey(userId, id))) as StoredCustomProvider | null
  })
}

async function ensureUniqueProviderId(userId: string, label: string): Promise<string> {
  const baseSlug = sanitizeId(label)
  const baseId = `${CUSTOM_PROVIDER_ID_PREFIX}${baseSlug || 'provider'}`
  const existing = new Set(await redis.sMembers(providerSetKey(userId)))

  if (!existing.has(baseId)) {
    return baseId
  }

  const suggestions = suggestAlternatives(baseId, 5)
  for (const candidate of suggestions) {
    if (!existing.has(candidate)) {
      return candidate
    }
  }

  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `${baseId}_${randomSuffix}`
}

export async function listCustomProviders(userId: string): Promise<CustomProviderSummary[]> {
  const ids = await redis.sMembers(providerSetKey(userId))
  if (!ids.length) return []

  const records = await Promise.all(ids.map((id) => loadCustomProvider(userId, id)))
  const summaries = records
    .filter((record): record is StoredCustomProvider => Boolean(record))
    .map((record) => {
      // Packet 5 finding 1: the same rule as the run (`listCustomProvidersForRuntime`),
      // so the connection is Ready exactly when the provider is registered.
      const apiKey = readUsableApiKey(record)
      return {
        id: record.id,
        label: record.label,
        baseUrl: record.baseUrl,
        headers: record.headers,
        maskedKey: apiKey === null ? '****' : apiKeyEncryption.mask(apiKey),
        apiKeyUsable: apiKey !== null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }
    })

  return summaries.sort((a, b) => a.label.localeCompare(b.label))
}

export async function listCustomProvidersForRuntime(userId: string): Promise<CustomProviderRuntime[]> {
  const ids = await redis.sMembers(providerSetKey(userId))
  if (!ids.length) return []

  const records = await Promise.all(ids.map((id) => loadCustomProvider(userId, id)))
  const providers: CustomProviderRuntime[] = []

  for (const record of records) {
    if (!record) continue
    const apiKey = readUsableApiKey(record)
    if (apiKey === null) continue
    providers.push({
      id: record.id,
      label: record.label,
      baseUrl: record.baseUrl,
      apiKey,
      headers: record.headers
    })
  }

  return providers
}

export async function upsertCustomProvider(
  userId: string,
  input: CustomProviderUpsertInput
): Promise<CustomProviderSummary> {
  const label = normalizeLabel(input.label)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const headers = normalizeHeaders(input.headers ?? undefined)
  const now = new Date().toISOString()

  if (input.id) {
    const existing = await loadCustomProvider(userId, input.id)
    if (!existing) {
      throw new Error('Custom provider not found')
    }

    let encrypted = existing.apiKeyEncrypted
    let iv = existing.apiKeyIv
    let authTag = existing.apiKeyAuthTag
    let apiKey: string

    if (input.apiKey && input.apiKey.trim().length) {
      if (containsSuspiciousInput(input.apiKey)) {
        throw new Error('API key contains invalid characters')
      }
      apiKey = input.apiKey.trim()
      const encryptedData = apiKeyEncryption.encrypt(apiKey)
      encrypted = encryptedData.encrypted
      iv = encryptedData.iv
      authTag = encryptedData.authTag
    } else {
      // BL-587: an edit that keeps the saved key reads it BEFORE anything is
      // written. A provider restored from a normal backup has no key (the backup
      // nulls the three key fields), so the edit used to write the record and
      // then answer 400 while decrypting them.
      apiKey = readSavedApiKey(existing)
    }

    const updated: StoredCustomProvider = {
      ...existing,
      label,
      baseUrl,
      headers,
      apiKeyEncrypted: encrypted,
      apiKeyIv: iv,
      apiKeyAuthTag: authTag,
      updatedAt: now
    }

    await redis.execute(async (client) => {
      await client.json.set(providerKey(userId, existing.id), '$', updated as unknown as RedisJSON)
    })

    return {
      id: updated.id,
      label: updated.label,
      baseUrl: updated.baseUrl,
      headers: updated.headers,
      maskedKey: apiKeyEncryption.mask(apiKey),
      apiKeyUsable: true,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    }
  }

  if (!input.apiKey || !input.apiKey.trim().length) {
    throw new Error('API key is required')
  }

  if (containsSuspiciousInput(input.apiKey)) {
    throw new Error('API key contains invalid characters')
  }

  const id = await ensureUniqueProviderId(userId, label)
  const encryptedData = apiKeyEncryption.encrypt(input.apiKey.trim())

  const record: StoredCustomProvider = {
    id,
    label,
    baseUrl,
    headers,
    apiKeyEncrypted: encryptedData.encrypted,
    apiKeyIv: encryptedData.iv,
    apiKeyAuthTag: encryptedData.authTag,
    createdAt: now,
    updatedAt: now
  }

  await redis.execute(async (client) => {
    await client.json.set(providerKey(userId, id), '$', record as unknown as RedisJSON)
  })
  await redis.sAdd(providerSetKey(userId), id)

  return {
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    headers: record.headers,
    maskedKey: apiKeyEncryption.mask(input.apiKey.trim()),
    apiKeyUsable: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

export async function deleteCustomProvider(userId: string, id: string): Promise<void> {
  await redis.execute(async (client) => {
    await client.del(providerKey(userId, id))
  })
  await redis.sRem(providerSetKey(userId), id)
}
