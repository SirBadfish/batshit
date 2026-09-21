/**
 * SA-120 Jev Juice — the one server-side TypeSafe System One client (DL-120-08).
 *
 * Plain `fetch` plus a long-lived keep-alive dispatcher, chosen over the vendor SDK
 * (AMD-120-01): the SDK's debug logger prints request bodies unredacted, it has no
 * total deadline, and it is days old with one breaking rename already behind it.
 * Measured 2026-09-16 on Josh's Mac: Node's default dispatcher drops an idle
 * connection after 4 s, so a call after a 12 s pause cost 350-656 ms; the 60 s
 * keep-alive agent answered the same call in 166-203 ms.
 *
 * Contract:
 * - one HTTP attempt per `attemptTimeoutMs`; one retry on 429/529 honouring
 *   Retry-After (capped), never on anything else;
 * - an optional total `deadlineMs` that wins over everything (DL-120-05);
 * - typed request and response; a 2xx that does not parse is `malformed`;
 * - never logs a request or response body, and never logs the key;
 * - usage is reported when the vendor sends it and is `null` otherwise — unknown,
 *   never zero (DL-120-07).
 *
 * Callers do not use this directly; `runTypesafeJudgment` in
 * `typesafeAvailability.ts` applies the master/feature/key rule first.
 */

import type { TypesafeErrorReason, TypesafeUnavailableReason, TypesafeUsage } from '$lib/types/typesafe'
import { logger } from '$lib/utils/logger'
import {
  TYPESAFE_BASE_URL,
  TYPESAFE_DEFAULT_RETRY_WAIT_MS,
  TYPESAFE_ERROR_DETAIL_MAX_CHARS,
  TYPESAFE_KEEP_ALIVE_MAX_MS,
  TYPESAFE_KEEP_ALIVE_MS,
  TYPESAFE_MAX_RETRY_WAIT_MS,
  TYPESAFE_RETRY_STATUSES,
  TYPESAFE_SYSTEM_ONE_PATH
} from './typesafe.constants'

// ---------------------------------------------------------------------------
// Question and answer shapes (the v1 contract; see the skill's api-and-sdk.md)
// ---------------------------------------------------------------------------

export interface JevNoulQuestion {
  type: 'noul'
  instructions: unknown
  criteria?: { true?: unknown; false?: unknown }
}

export interface JevChoiceQuestion {
  type: 'choice'
  instructions: unknown
  /** Option id → description (or null). Add `other`/`none` when the list may not cover the input. */
  criteria: Record<string, unknown>
}

export interface JevScoreQuestion {
  type: 'score'
  instructions: unknown
  /** Ordered level descriptions, low to high, 2-10 entries. */
  criteria: unknown[]
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion
export type JevQuestions = Record<string, JevQuestion>

export interface JevNoulAnswer {
  type: 'noul'
  noul: number
}

export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface JevScoreAnswer {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

/** Maps each question id to the answer type its question produces. */
export type JevAnswersFor<Q extends JevQuestions> = {
  [K in keyof Q]: Q[K] extends JevNoulQuestion
    ? JevNoulAnswer
    : Q[K] extends JevChoiceQuestion
      ? JevChoiceAnswer
      : Q[K] extends JevScoreQuestion
        ? JevScoreAnswer
        : JevAnswer
}

export interface JevResponse<Q extends JevQuestions = JevQuestions> {
  model: string
  answers: JevAnswersFor<Q>
  usage: TypesafeUsage | null
}

// ---------------------------------------------------------------------------
// Client contract
// ---------------------------------------------------------------------------

export interface TypesafeSystemOneRequest<Q extends JevQuestions = JevQuestions> {
  apiKey: string
  model: string
  state: unknown
  questions: Q
  /** Ceiling for one HTTP attempt. */
  attemptTimeoutMs: number
  /** Total budget for the call including the one retry. Omit for no deadline. */
  deadlineMs?: number
  signal?: AbortSignal
}

export type TypesafeCallOutcome<Q extends JevQuestions = JevQuestions> =
  | {
      status: 'ok'
      response: JevResponse<Q>
      latencyMs: number
      attempts: number
      deadlineHit: false
      httpStatus: number
      requestChars: number
    }
  | {
      status: 'unavailable'
      reason: TypesafeUnavailableReason
      latencyMs: number
      attempts: number
      deadlineHit: boolean
      httpStatus?: number
      detail?: string
      requestChars: number
    }
  | {
      status: 'error'
      reason: TypesafeErrorReason
      latencyMs: number
      attempts: number
      deadlineHit: false
      httpStatus?: number
      detail?: string
      requestChars: number
    }

export type TypesafeFetchInit = RequestInit & { dispatcher?: unknown }
export type TypesafeFetch = (input: string, init: TypesafeFetchInit) => Promise<Response>

export interface TypesafeClientOptions {
  /** Test seam. Production uses the global fetch with the keep-alive dispatcher. */
  fetch?: TypesafeFetch
  baseUrl?: string
  /** Test seam: `null` skips the dispatcher entirely; omit for the shared keep-alive agent. */
  dispatcher?: unknown | null
  /** Test seam for the retry wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface TypesafeClient {
  systemOne<Q extends JevQuestions>(request: TypesafeSystemOneRequest<Q>): Promise<TypesafeCallOutcome<Q>>
}

// ---------------------------------------------------------------------------
// Keep-alive dispatcher (one per process, created on first use)
// ---------------------------------------------------------------------------

let keepAliveDispatcher: Promise<unknown> | null = null

async function getKeepAliveDispatcher(): Promise<unknown> {
  if (!keepAliveDispatcher) {
    keepAliveDispatcher = import('undici').then(
      ({ Agent }) =>
        new Agent({
          keepAliveTimeout: TYPESAFE_KEEP_ALIVE_MS,
          keepAliveMaxTimeout: TYPESAFE_KEEP_ALIVE_MAX_MS
        })
    )
  }
  return keepAliveDispatcher
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function parseRetryAfterMs(headers: Headers): number | null {
  const ms = headers.get('retry-after-ms')
  if (ms && /^\d+$/.test(ms.trim())) return Number.parseInt(ms.trim(), 10)
  const raw = headers.get('retry-after')
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - Date.now())
}

function boundDetail(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > TYPESAFE_ERROR_DETAIL_MAX_CHARS
    ? `${oneLine.slice(0, TYPESAFE_ERROR_DETAIL_MAX_CHARS)}…`
    : oneLine
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseAnswer(value: unknown): JevAnswer | null {
  if (!isRecord(value)) return null
  if (value.type === 'noul' && isFiniteNumber(value.noul)) {
    return { type: 'noul', noul: value.noul }
  }
  if (
    value.type === 'choice' &&
    typeof value.choice === 'string' &&
    isRecord(value.probabilities) &&
    isFiniteNumber(value.confidence)
  ) {
    return {
      type: 'choice',
      choice: value.choice,
      probabilities: value.probabilities as Record<string, number>,
      confidence: value.confidence
    }
  }
  if (
    value.type === 'score' &&
    isFiniteNumber(value.score) &&
    isRecord(value.probabilities) &&
    isFiniteNumber(value.confidence)
  ) {
    return {
      type: 'score',
      score: value.score,
      legend: isRecord(value.legend) ? (value.legend as Record<string, string>) : {},
      probabilities: value.probabilities as Record<string, number>,
      confidence: value.confidence
    }
  }
  return null
}

/** Exported for the eval harness and tests: turns a raw vendor body into a typed response or null. */
export function parseSystemOneResponse<Q extends JevQuestions>(
  raw: unknown,
  questions: Q
): JevResponse<Q> | null {
  if (!isRecord(raw) || !isRecord(raw.answers)) return null
  const answers: Record<string, JevAnswer> = {}
  for (const id of Object.keys(questions)) {
    const parsed = parseAnswer(raw.answers[id])
    if (!parsed || parsed.type !== questions[id].type) return null
    answers[id] = parsed
  }
  const usageRaw = isRecord(raw.usage) ? raw.usage : null
  const usage: TypesafeUsage | null =
    usageRaw && isFiniteNumber(usageRaw.input_tokens) && isFiniteNumber(usageRaw.output_tokens)
      ? { inputTokens: usageRaw.input_tokens, outputTokens: usageRaw.output_tokens }
      : null
  return {
    model: typeof raw.model === 'string' ? raw.model : '',
    answers: answers as JevAnswersFor<Q>,
    usage
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export function createTypesafeClient(options: TypesafeClientOptions = {}): TypesafeClient {
  const fetchImpl: TypesafeFetch = options.fetch ?? ((input, init) => fetch(input, init as RequestInit))
  const baseUrl = (options.baseUrl ?? TYPESAFE_BASE_URL).replace(/\/+$/, '')
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => performance.now())
  const url = `${baseUrl}${TYPESAFE_SYSTEM_ONE_PATH}`

  async function resolveDispatcher(): Promise<unknown> {
    if (options.dispatcher === null) return undefined
    if (options.dispatcher !== undefined) return options.dispatcher
    return getKeepAliveDispatcher()
  }

  async function systemOne<Q extends JevQuestions>(
    request: TypesafeSystemOneRequest<Q>
  ): Promise<TypesafeCallOutcome<Q>> {
    const started = now()
    const deadlineAt = request.deadlineMs !== undefined ? started + request.deadlineMs : null
    const body = JSON.stringify({
      state: request.state,
      model: request.model,
      questions: request.questions
    })
    const headers = {
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
    const latency = () => Math.round(now() - started)

    const unavailable = (
      reason: TypesafeUnavailableReason,
      attempts: number,
      deadlineHit: boolean,
      extra: { httpStatus?: number; detail?: string } = {}
    ): TypesafeCallOutcome<Q> => {
      const outcome: TypesafeCallOutcome<Q> = {
        status: 'unavailable',
        reason,
        latencyMs: latency(),
        attempts,
        deadlineHit,
        requestChars: body.length,
        ...extra
      }
      logger.debug('[typesafe] call unavailable', {
        reason,
        attempts,
        deadlineHit,
        httpStatus: extra.httpStatus ?? null,
        latencyMs: outcome.latencyMs
      })
      return outcome
    }

    const failure = (
      reason: TypesafeErrorReason,
      attempts: number,
      extra: { httpStatus?: number; detail?: string } = {}
    ): TypesafeCallOutcome<Q> => {
      const outcome: TypesafeCallOutcome<Q> = {
        status: 'error',
        reason,
        latencyMs: latency(),
        attempts,
        deadlineHit: false,
        requestChars: body.length,
        ...extra
      }
      logger.debug('[typesafe] call failed', {
        reason,
        attempts,
        httpStatus: extra.httpStatus ?? null,
        latencyMs: outcome.latencyMs
      })
      return outcome
    }

    let dispatcher: unknown
    try {
      dispatcher = await resolveDispatcher()
    } catch (error) {
      return failure('server_error', 0, {
        detail: `keep-alive dispatcher unavailable: ${error instanceof Error ? error.name : 'unknown'}`
      })
    }

    let attempts = 0
    while (true) {
      attempts += 1
      if (request.signal?.aborted) return unavailable('aborted', attempts - 1, false)

      const remaining = deadlineAt === null ? Number.POSITIVE_INFINITY : deadlineAt - now()
      if (remaining <= 0) return unavailable('deadline', attempts - 1, true)

      const clippedByDeadline = remaining < request.attemptTimeoutMs
      const attemptTimeoutMs = clippedByDeadline ? Math.max(1, Math.floor(remaining)) : request.attemptTimeoutMs
      const attemptSignal = AbortSignal.timeout(attemptTimeoutMs)
      const signal = request.signal ? AbortSignal.any([attemptSignal, request.signal]) : attemptSignal

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal,
          ...(dispatcher ? { dispatcher } : {})
        })
      } catch (error) {
        if (request.signal?.aborted) return unavailable('aborted', attempts, false)
        if (attemptSignal.aborted) {
          return clippedByDeadline
            ? unavailable('deadline', attempts, true)
            : unavailable('timeout', attempts, false)
        }
        return unavailable('network', attempts, false, {
          detail: error instanceof Error ? error.name : 'fetch failed'
        })
      }

      if (response.ok) {
        let raw: unknown
        try {
          raw = await response.json()
        } catch {
          return failure('malformed', attempts, { httpStatus: response.status, detail: 'response was not JSON' })
        }
        const parsed = parseSystemOneResponse(raw, request.questions)
        if (!parsed) {
          return failure('malformed', attempts, {
            httpStatus: response.status,
            detail: 'response did not match the System One answer shape'
          })
        }
        return {
          status: 'ok',
          response: parsed,
          latencyMs: latency(),
          attempts,
          deadlineHit: false,
          httpStatus: response.status,
          requestChars: body.length
        }
      }

      const status = response.status
      // Drain the body so the keep-alive connection can be reused; never keep it.
      const text = await response.text().catch(() => '')

      if (TYPESAFE_RETRY_STATUSES.has(status)) {
        if (attempts >= 2) return unavailable('rate_limited', attempts, false, { httpStatus: status })
        const wait = Math.min(
          parseRetryAfterMs(response.headers) ?? TYPESAFE_DEFAULT_RETRY_WAIT_MS,
          TYPESAFE_MAX_RETRY_WAIT_MS
        )
        const remainingNow = deadlineAt === null ? Number.POSITIVE_INFINITY : deadlineAt - now()
        if (wait >= remainingNow) return unavailable('rate_limited', attempts, true, { httpStatus: status })
        await sleep(wait)
        continue
      }

      if (status === 401 || status === 403) return failure('unauthorized', attempts, { httpStatus: status })
      if (status === 400 || status === 422) {
        return failure('bad_request', attempts, { httpStatus: status, detail: boundDetail(text) })
      }
      return failure('server_error', attempts, { httpStatus: status })
    }
  }

  return { systemOne }
}

let sharedClient: TypesafeClient | null = null

/** The one long-lived client for product code (DL-120-08). Tests build their own with `createTypesafeClient`. */
export function getTypesafeClient(): TypesafeClient {
  if (!sharedClient) sharedClient = createTypesafeClient()
  return sharedClient
}
