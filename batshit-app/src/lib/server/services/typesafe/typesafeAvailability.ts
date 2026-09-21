/**
 * SA-120 Jev Juice — THE rule for "may this feature call TypeSafe?" (DL-120-01/11).
 *
 *   master switch ON  AND  feature switch ON  AND  a key is present
 *
 * Checked in that order, so with the master switch OFF the answer is `master_off`
 * even when a key exists — OFF means zero outbound calls from any feature. Every
 * packet goes through `runTypesafeJudgment`, which applies this rule before the
 * client is ever touched; the test that pins DL-120-11 asserts the injected fetch
 * is never called.
 *
 * The key resolves like every other provider key (model-registry §3): the user's
 * encrypted `api_keys:{userId}:typesafe` record first, then the `TYPESAFE_API_KEY`
 * env fallback.
 */

import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import type { TypesafeConfig, TypesafeKeySource, TypesafeKeyStatus, TypesafeCallRecord } from '$lib/types/typesafe'
import { TYPESAFE_KEY_SERVICE } from '$lib/types/typesafe'
import type { TypesafeFeatureId } from '$lib/utils/jevJuice'
import { logger } from '$lib/utils/logger'
import { TYPESAFE_API_KEY_ENV } from './typesafe.constants'
import {
  getTypesafeClient,
  type JevQuestions,
  type JevResponse,
  type TypesafeCallOutcome,
  type TypesafeClient
} from './typesafeClient'
import { getTypesafeConfig } from './typesafeConfig'
import { createTypesafeCallRecord } from './typesafeEvidence'

export interface ResolvedTypesafeKey {
  apiKey: string
  source: TypesafeKeySource
}

export async function resolveTypesafeApiKey(
  userId: string | null | undefined
): Promise<ResolvedTypesafeKey | null> {
  if (userId) {
    try {
      const stored = await apiKeyService.retrieve(TYPESAFE_KEY_SERVICE, userId)
      if (stored && stored.trim()) return { apiKey: stored.trim(), source: 'user' }
    } catch (error) {
      logger.warn('[typesafe] failed to read the saved key; trying the env fallback', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const envKey = ((env as Record<string, string | undefined>)[TYPESAFE_API_KEY_ENV] ?? '').trim()
  if (envKey) return { apiKey: envKey, source: 'env' }
  return null
}

/** Presence and source only; never the value. For Settings surfaces. */
export async function getTypesafeKeyStatus(userId: string | null | undefined): Promise<TypesafeKeyStatus> {
  const resolved = await resolveTypesafeApiKey(userId)
  return resolved ? { present: true, source: resolved.source } : { present: false, source: null }
}

export type TypesafeDeniedReason = 'master_off' | 'feature_off' | 'no_key'

export type TypesafeAccess =
  | {
      allowed: true
      apiKey: string
      keySource: TypesafeKeySource
      config: TypesafeConfig
      model: string
    }
  | {
      allowed: false
      reason: TypesafeDeniedReason
      config: TypesafeConfig
    }

export interface TypesafeAccessInput {
  userId: string | null | undefined
  featureId: TypesafeFeatureId
  /** The feature's own switch, resolved by the feature from its owning record (agent or user settings). */
  featureEnabled: boolean
}

export async function resolveTypesafeAccess(input: TypesafeAccessInput): Promise<TypesafeAccess> {
  const config = await getTypesafeConfig()
  if (!config.enabled) return { allowed: false, reason: 'master_off', config }
  if (!input.featureEnabled) return { allowed: false, reason: 'feature_off', config }
  const key = await resolveTypesafeApiKey(input.userId)
  if (!key) return { allowed: false, reason: 'no_key', config }
  return { allowed: true, apiKey: key.apiKey, keySource: key.source, config, model: config.modelId }
}

export interface TypesafeJudgmentInput<Q extends JevQuestions> extends TypesafeAccessInput {
  state: unknown
  questions: Q
  /**
   * Total budget for the call in ms (DL-120-05): a lane with its own limit (a tool lane's
   * 2,000 ms, the key test's 10 s), or an in-chat caller that already spent part of the
   * user's wait limit (P4's pre-filter). Optional on an `in_chat` lane; see `lane`.
   */
  deadlineMs?: number
  /**
   * `'in_chat'` marks a call the send path waits on (SA-120 P8, DL-120-16): its budget is the
   * user's In-Chat Wait Limit (`config.inChatWaitMs`, LS-059), read from the same record as
   * the access rule, so no lane can pin the old constant. A `deadlineMs` given as well may
   * only shorten it: an in-chat call never waits longer than the user allowed.
   */
  lane?: 'in_chat'
  signal?: AbortSignal
  /** Test seam; production uses the shared keep-alive client. */
  client?: TypesafeClient
}

/** THE rule for a judgment's total budget: the user's in-chat limit caps an `in_chat` lane; other lanes bring their own. */
export function resolveTypesafeDeadlineMs(
  input: Pick<TypesafeJudgmentInput<JevQuestions>, 'deadlineMs' | 'lane'>,
  config: Pick<TypesafeConfig, 'inChatWaitMs'>
): number | undefined {
  if (input.lane !== 'in_chat') return input.deadlineMs
  return input.deadlineMs === undefined ? config.inChatWaitMs : Math.min(input.deadlineMs, config.inChatWaitMs)
}

export interface TypesafeJudgmentResult<Q extends JevQuestions> {
  access: TypesafeAccess
  /** `null` when access was denied: no call was made. */
  outcome: TypesafeCallOutcome<Q> | null
  /** The typed answers when the call succeeded, else `null`. */
  response: JevResponse<Q> | null
  /** The Execution Viewer row (DL-120-07). Features set `record.decision` after deciding. */
  record: TypesafeCallRecord
}

/**
 * The single entry every feature uses: access rule → one client call → an EV record.
 * It never throws into a send path; every failure is an outcome with a reason.
 */
export async function runTypesafeJudgment<Q extends JevQuestions>(
  input: TypesafeJudgmentInput<Q>
): Promise<TypesafeJudgmentResult<Q>> {
  const questionCount = Object.keys(input.questions).length
  const access = await resolveTypesafeAccess(input)
  if (!access.allowed) {
    return {
      access,
      outcome: null,
      response: null,
      record: createTypesafeCallRecord({
        featureId: input.featureId,
        requestedModel: access.config.modelId,
        questionCount,
        outcome: null,
        deniedReason: access.reason
      })
    }
  }

  const client = input.client ?? getTypesafeClient()
  const outcome = await client.systemOne<Q>({
    apiKey: access.apiKey,
    model: access.model,
    state: input.state,
    questions: input.questions,
    attemptTimeoutMs: access.config.attemptTimeoutMs,
    deadlineMs: resolveTypesafeDeadlineMs(input, access.config),
    signal: input.signal
  })

  return {
    access,
    outcome,
    response: outcome.status === 'ok' ? outcome.response : null,
    record: createTypesafeCallRecord({
      featureId: input.featureId,
      requestedModel: access.model,
      questionCount,
      outcome
    })
  }
}
