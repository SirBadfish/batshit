import type { RedisJSON } from '@redis/json'
import { env } from '$env/dynamic/private'
import { LOCAL_AI_SERVER_DEFINITIONS, LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import { redis } from '$lib/server/redis'
import { containsSuspiciousInput, normalizeHttpBaseUrl } from '$lib/utils/inputSanitization'
import type {
  LocalAiServerRecord,
  LocalAiServerSummary,
  LocalAiServerUpdate,
  LocalAiServerId,
  LocalAiImageTransport
} from '$lib/types/localAi'
import { rewriteLoopbackUrlToDockerHostForRuntime } from '$lib/server/services/runtimeUrlRewrites'

const LOCAL_AI_SET_PREFIX = 'user'

function providerKey(userId: string, id: string) {
  return `local_provider:${userId}:${id}`
}

function providerSetKey(userId: string) {
  return `${LOCAL_AI_SET_PREFIX}:${userId}:local_providers`
}

function normalizeBaseUrl(value: string): string {
  return normalizeHttpBaseUrl(value)
}

function normalizeOpenAiPath(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (!trimmed.startsWith('/')) {
    throw new Error('OpenAI path must start with /')
  }
  if (containsSuspiciousInput(trimmed)) {
    throw new Error('OpenAI path contains invalid characters')
  }
  return trimmed.replace(/\/+$/, '')
}

function normalizeImageBaseUrl(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return normalizeHttpBaseUrl(trimmed, {
    label: 'Image base URL',
    fallback
  })
}

function normalizeImageTransport(value: unknown, fallback: LocalAiImageTransport): LocalAiImageTransport {
  if (value === 'auto') return value
  if (value === 'url') return value
  return fallback
}

export function resolveLocalAiRuntimeBaseUrl(
  baseUrl: string | undefined | null,
  runtimeEnv: Partial<Record<string, string | undefined>> = env
): string | undefined {
  return rewriteLoopbackUrlToDockerHostForRuntime(baseUrl, runtimeEnv)
}

function buildSummary(
  definition: (typeof LOCAL_AI_SERVER_DEFINITIONS)[number],
  record?: LocalAiServerRecord | null
): LocalAiServerSummary {
  const enabled =
    typeof record?.enabled === 'boolean'
      ? record.enabled
      : record
        ? true
        : definition.enabledByDefault
  return {
    ...definition,
    baseUrl: record?.baseUrl ?? definition.defaultBaseUrl,
    openaiPath: record?.openaiPath ?? definition.openaiPath,
    enabled,
    imageTransport: normalizeImageTransport(
      record?.imageTransport,
      definition.defaultImageTransport
    ),
    imageBaseUrl:
      record?.imageBaseUrl ?? definition.defaultImageBaseUrl,
    createdAt: record?.createdAt,
    updatedAt: record?.updatedAt,
    source: record ? 'stored' : 'default'
  }
}

async function loadRecord(userId: string, id: LocalAiServerId): Promise<LocalAiServerRecord | null> {
  return await redis.execute(async (client) => {
    return (await client.json.get(providerKey(userId, id))) as LocalAiServerRecord | null
  })
}

export async function listLocalAiServers(userId: string): Promise<LocalAiServerSummary[]> {
  const recordsById = new Map<LocalAiServerId, LocalAiServerRecord>()

  for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
    try {
      const record = await loadRecord(userId, definition.id)
      if (record) {
        recordsById.set(definition.id, record)
      }
    } catch (error) {
      console.warn(`[Local AI] Failed to load ${definition.id}:`, error)
    }
  }

  return LOCAL_AI_SERVER_DEFINITIONS.map((definition) => buildSummary(definition, recordsById.get(definition.id)))
}

export async function saveLocalAiServers(
  userId: string,
  updates: LocalAiServerUpdate[]
): Promise<LocalAiServerSummary[]> {
  if (!Array.isArray(updates) || updates.length === 0) {
    return listLocalAiServers(userId)
  }

  const now = new Date().toISOString()

  for (const update of updates) {
    if (!LOCAL_AI_SERVER_IDS.has(update.id)) {
      throw new Error(`Unknown local AI server: ${update.id}`)
    }
    const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === update.id)
    if (!definition) continue

    const baseUrl = normalizeBaseUrl(update.baseUrl)
    const openaiPath = normalizeOpenAiPath(update.openaiPath ?? definition.openaiPath, definition.openaiPath)

    const existing = await loadRecord(userId, update.id)

    const imageTransport = normalizeImageTransport(
      update.imageTransport ?? existing?.imageTransport ?? definition.defaultImageTransport,
      definition.defaultImageTransport
    )
    const imageBaseUrl = normalizeImageBaseUrl(
      update.imageBaseUrl ?? existing?.imageBaseUrl ?? definition.defaultImageBaseUrl,
      definition.defaultImageBaseUrl
    )
    const enabled =
      typeof update.enabled === 'boolean'
        ? update.enabled
        : typeof existing?.enabled === 'boolean'
          ? existing.enabled
          : existing
            ? true
            : definition.enabledByDefault

    const record: LocalAiServerRecord = {
      id: update.id,
      baseUrl,
      openaiPath,
      enabled,
      imageTransport,
      imageBaseUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    await redis.execute(async (client) => {
      await client.json.set(providerKey(userId, update.id), '$', record as unknown as RedisJSON)
      await client.sAdd(providerSetKey(userId), update.id)
    })
  }

  return listLocalAiServers(userId)
}

export async function deleteLocalAiServer(userId: string, id: LocalAiServerId): Promise<void> {
  if (!LOCAL_AI_SERVER_IDS.has(id)) {
    throw new Error('Unknown local AI server')
  }
  await redis.execute(async (client) => {
    await client.del(providerKey(userId, id))
    await client.sRem(providerSetKey(userId), id)
  })
}
