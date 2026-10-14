/**
 * SA-120 Judge Juice — THE rule for "may this feature call TypeSafe?" (DL-120-01/11).
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
 *
 * SA-120 P10a (DL-120-18): the rule now asks WHICH judge as well, after the two
 * switches and before the key:
 *
 *   master ON  AND  feature ON  AND  the feature's judge exists and is set up  AND  (its key, if its kind has one)
 *
 * so OFF still means zero calls to any judge, a missing or half-set-up judge is
 * `no_provider` (never a quiet fallback to another judge), and only TypeSafe,
 * Cloudflare, and a keyed System One URL can be `no_key`. Then, before any call,
 * the fit check: a request over the judge's limits is `provider_limit` and is
 * never sent, cut, or split.
 */

import { env } from '$env/dynamic/private'
import { apiKeyService } from '$lib/services/apiKey.server'
import type {
  JudgeProvider,
  TypesafeConfig,
  TypesafeKeySource,
  TypesafeKeyStatus,
  TypesafeCallRecord
} from '$lib/types/typesafe'
import { TYPESAFE_KEY_SERVICE } from '$lib/types/typesafe'
import type { TypesafeFeatureId } from '$lib/utils/jevJuice'
import {
  checkJudgeRequestFit,
  isJudgeProviderUsable,
  judgeKeyService,
  judgeProviderRef,
  resolveJudgeProviderForLane
} from '$lib/utils/judgeProviders'
import { logger } from '$lib/utils/logger'
import { buildJudgeEndpoint, resolveJudgeKey, resolveJudgeLimits } from './judgeProviderEndpoint'
import { TYPESAFE_API_KEY_ENV } from './typesafe.constants'
import {
  createTypesafeClient,
  getTypesafeClient,
  type JevQuestions,
  type JevResponse,
  type TypesafeCallOutcome,
  type TypesafeClient,
  type TypesafeFetch
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

export type TypesafeDeniedReason = 'master_off' | 'feature_off' | 'no_provider' | 'no_key'

export type TypesafeAccess =
  | {
      allowed: true
      /** `null` for a judge that sends no key (Ollama, a keyless System One URL). */
      apiKey: string | null
      keySource: TypesafeKeySource | null
      config: TypesafeConfig
      model: string
      /** SA-120 P10a: the judge this feature asks. */
      provider: JudgeProvider
    }
  | {
      allowed: false
      reason: TypesafeDeniedReason
      config: TypesafeConfig
      /** The judge the feature would have asked, when one was found (for the record); `null` on `no_provider`. */
      provider: JudgeProvider | null
      /** The judge id the feature's choice (or the default) names, found or not (round 1, S5: the record keeps it). */
      providerId: string
    }

export interface TypesafeAccessInput {
  userId: string | null | undefined
  featureId: TypesafeFeatureId
  /** The feature's own switch, resolved by the feature from its owning record (agent or user settings). */
  featureEnabled: boolean
}

export async function resolveTypesafeAccess(input: TypesafeAccessInput): Promise<TypesafeAccess> {
  const config = await getTypesafeConfig()
  // Which judge is pure routing over the record just read (no key read, no network), so even a denial can say
  // which judge it would have been.
  const { provider, providerId } = resolveJudgeProviderForLane(config, input.featureId)
  if (!config.enabled) return { allowed: false, reason: 'master_off', config, provider, providerId }
  if (!input.featureEnabled) return { allowed: false, reason: 'feature_off', config, provider, providerId }
  if (!provider || !isJudgeProviderUsable(provider)) {
    return { allowed: false, reason: 'no_provider', config, provider: null, providerId }
  }
  const key = await resolveJudgeKey(provider, input.userId, resolveTypesafeApiKey)
  if (judgeKeyService(provider) && !key) return { allowed: false, reason: 'no_key', config, provider, providerId }
  return {
    allowed: true,
    apiKey: key?.apiKey ?? null,
    keySource: key?.source ?? null,
    config,
    model: provider.modelId,
    provider
  }
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
  /**
   * Test seam (SA-120 P10a): a fake fetch. The entry point then builds a client for the judge's real endpoint with
   * it, so a test sees the exact URL, headers, and body each kind sends, and Ollama's context read goes through it.
   */
  fetch?: TypesafeFetch
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
        requestedModel: access.provider?.modelId ?? null,
        provider: access.provider ? judgeProviderRef(access.provider) : undefined,
        chosenProviderId: access.provider ? undefined : access.providerId,
        questionCount,
        outcome: null,
        deniedReason: access.reason
      })
    }
  }

  const provider = access.provider
  const endpoint = buildJudgeEndpoint(provider)
  // The fit check measures the body exactly as the client will send it (same keys, same order).
  const requestChars = JSON.stringify({ state: input.state, model: access.model, questions: input.questions }).length

  // Review round 1, M1: the limits read (Ollama's `/api/show`) runs inside the call's own budget. Its time counts
  // against the same deadline the judge call gets, and Stop (the lane's signal) ends it at once.
  const deadlineMs = resolveTypesafeDeadlineMs(input, access.config)
  const startedAt = performance.now()
  const limitsRead = await resolveJudgeLimits(provider, { fetch: input.fetch, deadlineMs, signal: input.signal })
  // Only an Ollama judge reads anything here; every other judge spends nothing, so its latency stays exactly the call's.
  const spentMs = provider.kind === 'ollama' ? Math.round(performance.now() - startedAt) : 0
  const remainingMs = deadlineMs === undefined ? undefined : deadlineMs - spentMs

  let outcome: TypesafeCallOutcome<Q>
  const stoppedBeforeCall =
    limitsRead.status === 'aborted' || input.signal?.aborted
      ? ('aborted' as const)
      : limitsRead.status === 'deadline' || (remainingMs !== undefined && remainingMs <= 0)
        ? ('deadline' as const)
        : null
  const fit = limitsRead.status === 'ok' ? checkJudgeRequestFit(limitsRead.limits, input.questions, requestChars) : null
  if (stoppedBeforeCall) {
    // No time (or no wish) left for the judge: the usual unavailable outcome, and no call.
    outcome = {
      status: 'unavailable',
      reason: stoppedBeforeCall,
      latencyMs: spentMs,
      attempts: 0,
      deadlineHit: stoppedBeforeCall === 'deadline',
      // Only an Ollama judge reads anything first; for any other judge (or a read that never started) say so plainly.
      detail:
        provider.kind === 'ollama' && limitsRead.status !== 'ok' && spentMs > 0
          ? `the judge's limits were still being read from ${provider.label} when the ${stoppedBeforeCall === 'deadline' ? 'deadline passed' : 'call was cancelled'}`
          : stoppedBeforeCall === 'deadline'
            ? 'the deadline had passed before the call'
            : 'the call was cancelled before it started',
      requestChars
    }
  } else if (fit && !fit.fits) {
    // Never sent, never cut, never split: the lane omits its result with its normal note (SA-120 P10a).
    outcome = {
      status: 'unavailable',
      reason: 'provider_limit',
      latencyMs: 0,
      attempts: 0,
      deadlineHit: false,
      detail: fit.detail,
      requestChars
    }
  } else {
    const client =
      input.client ??
      (input.fetch
        ? createTypesafeClient({ baseUrl: endpoint.baseUrl, path: endpoint.path, fetch: input.fetch, dispatcher: null })
        : getTypesafeClient(endpoint))
    outcome = await client.systemOne<Q>({
      apiKey: access.apiKey,
      model: access.model,
      state: input.state,
      questions: input.questions,
      attemptTimeoutMs: access.config.attemptTimeoutMs,
      deadlineMs: remainingMs,
      signal: input.signal
    })
    if (spentMs > 0) outcome = { ...outcome, latencyMs: outcome.latencyMs + spentMs }
  }

  return {
    access,
    outcome,
    response: outcome.status === 'ok' ? outcome.response : null,
    record: createTypesafeCallRecord({
      featureId: input.featureId,
      requestedModel: access.model,
      provider: judgeProviderRef(provider),
      questionCount,
      outcome
    })
  }
}
