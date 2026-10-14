/**
 * SA-120 P10a (DL-120-18) — the server half of judge providers: where a judge's request goes, which key it sends,
 * and the limits the fit check holds it to. The routing rule and every sentence live in `$lib/utils/judgeProviders`.
 *
 * Nothing here asks a judge a question; `runTypesafeJudgment` (the only entry the lanes use) does, after the
 * access rule. Lives under `services/typesafe/` so the DL-120-12 reach pin keeps it out of the risk gate's imports.
 */

import { apiKeyService } from '$lib/services/apiKey.server'
import type { JudgeProvider, TypesafeKeySource, TypesafeKeyStatus } from '$lib/types/typesafe'
import {
  CLOUDFLARE_WORKERS_AI_KEY_SERVICE,
  SYSTEMONE_URL_KEY_SERVICE,
  TYPESAFE_KEY_SERVICE
} from '$lib/types/typesafe'
import {
  CLOUDFLARE_API_BASE_URL,
  judgeKeyService,
  profileJudgeLimits,
  SYSTEMONE_PATH,
  withReportedInputTokens,
  type JudgeLimits
} from '$lib/utils/judgeProviders'
import { logger } from '$lib/utils/logger'
import { readOllamaContextTokens } from './ollamaDecisionModels'
import { TYPESAFE_BASE_URL } from './typesafe.constants'
import type { TypesafeFetch } from './typesafeClient'

export interface JudgeEndpoint {
  baseUrl: string
  path: string
}

/**
 * Where one judge's `POST` goes. Every kind sends the same `{ state, model, questions }` body; Cloudflare also puts
 * the model in the path (`/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}`).
 */
export function buildJudgeEndpoint(provider: JudgeProvider): JudgeEndpoint {
  switch (provider.kind) {
    case 'typesafe':
      return { baseUrl: TYPESAFE_BASE_URL, path: SYSTEMONE_PATH }
    case 'cloudflare':
      return {
        baseUrl: CLOUDFLARE_API_BASE_URL,
        path: `/client/v4/accounts/${encodeURIComponent(provider.accountId ?? '')}/ai/run/@cf/cloudflare/${encodeURIComponent(provider.modelId)}`
      }
    default:
      return { baseUrl: (provider.baseUrl ?? '').replace(/\/+$/, ''), path: SYSTEMONE_PATH }
  }
}

export interface ResolvedJudgeKey {
  apiKey: string
  source: TypesafeKeySource
}

async function readSavedKey(service: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  try {
    const stored = await apiKeyService.retrieve(service, userId)
    return stored && stored.trim() ? stored.trim() : null
  } catch (error) {
    logger.warn('[typesafe] failed to read a saved judge key', {
      service,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

/**
 * The key one judge sends, read per call like every provider key. TypeSafe keeps its env fallback
 * (`resolveTypesafeApiKey`, passed in to keep one reader); Cloudflare and a keyed System One URL read their own
 * service; Ollama and a keyless URL need none (`null` and nothing to deny).
 */
export async function resolveJudgeKey(
  provider: Pick<JudgeProvider, 'kind' | 'sendsKey'>,
  userId: string | null | undefined,
  resolveTypesafeKey: (userId: string | null | undefined) => Promise<ResolvedJudgeKey | null>
): Promise<ResolvedJudgeKey | null> {
  const service = judgeKeyService(provider)
  if (!service) return null
  if (service === TYPESAFE_KEY_SERVICE) return resolveTypesafeKey(userId)
  const saved = await readSavedKey(service, userId)
  return saved ? { apiKey: saved, source: 'user' } : null
}

async function savedKeyExists(service: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false
  try {
    // Presence only: `exists` never decrypts the value (review round 1, N3).
    return await apiKeyService.exists(service, userId)
  } catch (error) {
    logger.warn('[typesafe] failed to check a saved judge key', {
      service,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

/** Presence and source of every judge key, for the Admin card. Never a value, and nothing is decrypted. */
export async function getJudgeKeyStatuses(
  userId: string | null | undefined,
  typesafe: TypesafeKeyStatus
): Promise<Record<string, TypesafeKeyStatus>> {
  const [cloudflare, systemoneUrl] = await Promise.all([
    savedKeyExists(CLOUDFLARE_WORKERS_AI_KEY_SERVICE, userId),
    savedKeyExists(SYSTEMONE_URL_KEY_SERVICE, userId)
  ])
  return {
    [TYPESAFE_KEY_SERVICE]: typesafe,
    [CLOUDFLARE_WORKERS_AI_KEY_SERVICE]: cloudflare ? { present: true, source: 'user' } : { present: false, source: null },
    [SYSTEMONE_URL_KEY_SERVICE]: systemoneUrl ? { present: true, source: 'user' } : { present: false, source: null }
  }
}

export type JudgeLimitsRead = { status: 'ok'; limits: JudgeLimits } | { status: 'deadline' } | { status: 'aborted' }

/**
 * The limits the fit check holds this judge to: Batshit's profile for the kind and model, with Ollama's own
 * reported `num_ctx` believed over the profile's token budget when Ollama reports one. The Ollama read answers to the
 * caller's `deadlineMs` and `signal` (review round 1, M1): when either ends first, the caller makes no call.
 */
export async function resolveJudgeLimits(
  provider: JudgeProvider,
  options: { fetch?: TypesafeFetch; deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<JudgeLimitsRead> {
  const profile = profileJudgeLimits(provider)
  if (provider.kind !== 'ollama' || !provider.baseUrl) return { status: 'ok', limits: profile }
  const read = await readOllamaContextTokens(provider.baseUrl, provider.modelId, {
    fetch: options.fetch,
    deadlineMs: options.deadlineMs,
    signal: options.signal
  })
  if (read.status !== 'read') return read
  return { status: 'ok', limits: withReportedInputTokens(profile, read.contextTokens) }
}
