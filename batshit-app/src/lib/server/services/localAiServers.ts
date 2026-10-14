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
import { managedProfileHelper } from './localAiManagedProfiles'
import type { KoboldManagedProfileReference } from '$lib/types/localAi'

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
    source: record ? 'stored' : 'default',
    managedProfile: record?.managedProfile
  }
}

async function loadRecord(userId: string, id: LocalAiServerId): Promise<LocalAiServerRecord | null> {
  return await redis.execute(async (client) => {
    return (await client.json.get(providerKey(userId, id))) as LocalAiServerRecord | null
  })
}

/**
 * Every Local AI server, each with its saved record or, when none was ever saved, its default.
 *
 * A record that does not exist is a default (`source: 'default'`). A record whose READ FAILED is
 * neither: it may be saved, so listing it as a default would show a made-up address as if it were the
 * saved one, and a settings screen that then saved would write it over the real one (BL-977).
 * The whole list fails instead, with the failure as its `cause`.
 */
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
      throw new Error('Could not read the saved Local AI servers.', { cause: error })
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
      if (!existing) await client.json.set(providerKey(userId, update.id), '$', record as unknown as RedisJSON)
      else {
        // Ordinary connection saves own these fields, never the managed grant reference.
        for (const [field, value] of Object.entries(record)) {
          await client.json.set(providerKey(userId, update.id), `$.${field}`, value as RedisJSON)
        }
      }
      await client.sAdd(providerSetKey(userId), update.id)
    })
  }

  return listLocalAiServers(userId)
}

/** Low-level record removal. Public deletion composes restart custody in localAiServerDeletion.ts. */
export async function deleteLocalAiServerRecord(userId: string, id: LocalAiServerId): Promise<void> {
  if (!LOCAL_AI_SERVER_IDS.has(id)) {
    throw new Error('Unknown local AI server')
  }
  const existing = await loadRecord(userId, id)
  if (id === 'koboldcpp' && process.env.BATSHIT_RUNTIME_OWNER === 'mac-app' && process.env.BATSHIT_CONTAINERIZED !== '1') {
    // Durable revoke must complete before the reference disappears. Files remain
    // because pending native reads/recovery cannot be proven absent by deletion.
    await managedProfileHelper('revoke-owner', { userId, requireState: Boolean(existing?.managedProfile) })
  }
  await redis.execute(async (client) => {
    await client.del(providerKey(userId, id))
    await client.sRem(providerSetKey(userId), id)
  })
}

export async function saveKoboldManagedProfileReference(userId: string, reference: KoboldManagedProfileReference): Promise<void> {
  const existing = await loadRecord(userId, 'koboldcpp')
  if (!existing) throw new Error('Save the KoboldCpp connection before enabling local context editing.')
  await redis.execute(async client => {
    await client.json.set(providerKey(userId, 'koboldcpp'), '$.managedProfile', reference as unknown as RedisJSON)
  })
}
