/**
 * SA-102 P5 (DL-102-09, DL-102-14) — ONE stored key per local AI program.
 *
 * Two things were true before this file existed:
 *
 *   1. There was no field anywhere to hold a local program's API key for CHAT.
 *      `registerLocalProvider` hardcoded the literal string `local-ai` and hoped.
 *      That is not theory: Josh's oMLX answered `/v1/models` with
 *      "401 API key required" until he turned the check off, and LM Studio 0.4
 *      tokens, `vllm --api-key` and `sglang --api-key` are the same gap.
 *   2. The memory system's `local-ai` embedder lane DID accept a key — as
 *      `localAi.apiKey` inside `batshit:memory_config`, a second place for the
 *      same secret and the only one of the two not guaranteed to be encrypted.
 *
 * Both now read the same encrypted record. Local keys live in the ordinary
 * `apiKeyService` store, under the program's own id, so they are AES-256-GCM
 * encrypted through the same path as every other Batshit credential, appear in
 * the API Keys panel beside every other key, and never need a second code path.
 */

import { apiKeyService } from '$lib/services/apiKey.server'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'
import { listLocalAiServers } from '$lib/server/services/localAiServers'
import type { LocalAiServerId } from '$lib/types/localAi'
import { logger } from '$lib/utils/logger'

export function isLocalProgramKeyService(service: string | null | undefined): boolean {
  const normalized = service?.trim().toLowerCase()
  return Boolean(normalized && LOCAL_AI_SERVER_IDS.has(normalized as LocalAiServerId))
}

/** The stored key for one program, or null when the user has not set one. */
export async function readLocalProgramApiKey(
  programId: string | null | undefined,
  userId: string | null | undefined
): Promise<string | null> {
  if (!userId || !isLocalProgramKeyService(programId)) return null
  try {
    const key = await apiKeyService.retrieve(programId!.trim().toLowerCase(), userId)
    return key && key.trim().length > 0 ? key.trim() : null
  } catch (error) {
    logger.debug('[local-key] read failed', { programId, error })
    return null
  }
}

function normalizeBaseUrlForMatch(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * Which local program serves this base URL.
 *
 * The memory config stores a raw URL rather than a program id, so the key it
 * should use has to be resolved by matching the URL against the configured
 * programs. Matching is on the ORIGIN, because the memory config's URL usually
 * carries the OpenAI path (`http://localhost:1234/v1`) and the program record
 * stores the origin and the path separately.
 */
export async function resolveLocalProgramIdForBaseUrl(
  baseUrl: string | null | undefined,
  userId: string | null | undefined
): Promise<LocalAiServerId | null> {
  const target = normalizeBaseUrlForMatch(baseUrl)
  if (!target || !userId) return null

  let servers: Awaited<ReturnType<typeof listLocalAiServers>>
  try {
    servers = await listLocalAiServers(userId)
  } catch (error) {
    logger.debug('[local-key] could not list programs', { error })
    return null
  }

  for (const server of servers) {
    const origin = normalizeBaseUrlForMatch(server.baseUrl)
    if (!origin) continue
    if (target === origin || target.startsWith(`${origin}/`)) {
      return server.id
    }
  }
  return null
}

/**
 * The key the memory embedder's `local-ai` lane should use, and a one-time
 * migration of any key still sitting in `batshit:memory_config`.
 *
 * Returns the key to use plus whether the caller should now strip the plaintext
 * copy out of the memory config. The caller owns the write so this stays a pure
 * resolver on the read path.
 */
export async function resolveMemoryLocalAiApiKey(args: {
  baseUrl: string | null | undefined
  configuredApiKey: string | null | undefined
  userId: string | null | undefined
}): Promise<{ apiKey: string | null; migratedFromMemoryConfig: boolean }> {
  const configured = args.configuredApiKey?.trim() ?? ''
  const programId = await resolveLocalProgramIdForBaseUrl(args.baseUrl, args.userId)

  const stored = await readLocalProgramApiKey(programId, args.userId)
  if (stored) {
    // The shared store wins. A leftover copy in the memory config is redundant.
    return { apiKey: stored, migratedFromMemoryConfig: configured.length > 0 }
  }

  if (!configured.length) {
    return { apiKey: null, migratedFromMemoryConfig: false }
  }

  // One-time migration: an existing memory-config key moves into the encrypted
  // store so there is exactly one secret from here on.
  if (programId && args.userId) {
    try {
      await apiKeyService.store(programId, configured, args.userId)
      logger.debug('[local-key] migrated memory-config key into the shared store', {
        programId
      })
      return { apiKey: configured, migratedFromMemoryConfig: true }
    } catch (error) {
      logger.debug('[local-key] migration failed; using the configured key as-is', {
        programId,
        error
      })
    }
  }

  // No program matched that URL — the memory lane may point at something that
  // is not a configured Batshit program. Keep working, do not lose the key.
  return { apiKey: configured, migratedFromMemoryConfig: false }
}
