/**
 * SA-120 Jev Juice — the constants every TypeSafe lane shares (DL-120-03/05/08).
 *
 * Feature modules (`<feature>.jev.ts`) hold their own questions, criteria, and
 * thresholds; this file holds only the transport and instance-wide values.
 */

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai'
export const TYPESAFE_SYSTEM_ONE_PATH = '/v1/systemone'

/** Redis key for the instance-level config record (Settings → Admin → Jev Juice). Backup group: `settings`. */
export const TYPESAFE_CONFIG_KEY = 'batshit:typesafe_config'

/** Env fallback for the key, read only when no user key is saved (same rule as every provider key). */
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY'

/**
 * The pinned model id (DL-120-08). `jev-latest` resolved to this on 2026-09-16 and
 * every measured probe in the evidence file ran against it. Bump deliberately, with
 * the eval harness, never by pointing product code at the moving alias.
 */
export const TYPESAFE_PINNED_MODEL_ID = 'jev-1.13.0'
export const TYPESAFE_PINNED_MODEL_ID_PATTERN = /^jev-\d+\.\d+(?:\.\d+)?$/

/** One HTTP attempt may take this long before Batshit gives up on it. */
export const TYPESAFE_DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000
export const TYPESAFE_ATTEMPT_TIMEOUT_MIN_MS = 500
export const TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS = 30_000

/**
 * The In-Chat Wait Limit (DL-120-05, AMD-120-02, DL-120-16): the total budget for a Jev call
 * the send path waits on (the compile lanes: P1 hints, P3 group speaker, P4 recall by meaning,
 * P5 smart zip). A miss omits the section and the send proceeds. It is a user setting on the
 * Jev Juice card (`batshit:typesafe_config.inChatWaitMs`, LS-059) read per call through
 * `runTypesafeJudgment` with `lane: 'in_chat'`; this is only its default and its bounds.
 *
 * Why 750 by default. Measured in-app 2026-09-16: a one-question call is 158-176 ms warm and
 * 443 ms cold; the P1 hint request (4 questions, about 60 Choice options, 7.9k input tokens)
 * answered in 522 ms. The story's first 400 ms guess missed every P1 call, so the default is
 * 750 ms: cold calls and hint-sized requests fit, and the worst case a send waits on Jev
 * stays under a second. A user who would rather never skip Jev sets it higher (Josh: about
 * five seconds); there is no "off", because a long wait IS "let Jev finish" (DL-120-16).
 *
 * Why these bounds. Under 200 ms nothing can answer (P4 makes no call at all with less than
 * `minCallBudgetMs` 200 left), so a lower value would be an "off" in disguise; the ceiling is
 * the per-attempt ceiling, since one attempt can never take longer than that anyway.
 */
export const TYPESAFE_DEFAULT_IN_CHAT_WAIT_MS = 750
export const TYPESAFE_IN_CHAT_WAIT_MIN_MS = 200
export const TYPESAFE_IN_CHAT_WAIT_MAX_MS = TYPESAFE_ATTEMPT_TIMEOUT_MAX_MS

/**
 * Keep-alive for the one long-lived client (DL-120-08). Measured on Josh's Mac,
 * 2026-09-16: Node's default dispatcher drops an idle connection after 4 s and
 * every later call pays a fresh TLS handshake (about 360 ms vs about 160 ms warm).
 * Ten minutes covers a normal pause between two chat sends; if the vendor closes the
 * socket sooner, undici simply reconnects (one cold call, not an error).
 */
export const TYPESAFE_KEEP_ALIVE_MS = 600_000
export const TYPESAFE_KEEP_ALIVE_MAX_MS = 600_000

/** Retried once (DL-120-08): rate limited and overloaded. Everything else is reported, not retried. */
export const TYPESAFE_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 529])
/** When the vendor sends no Retry-After, wait this long before the one retry. */
export const TYPESAFE_DEFAULT_RETRY_WAIT_MS = 500
/** Never wait longer than this for a retry, whatever Retry-After says; a lane deadline can shorten it further. */
export const TYPESAFE_MAX_RETRY_WAIT_MS = 2_000

/** A 4xx detail string is kept this short and never contains a request or response body. */
export const TYPESAFE_ERROR_DETAIL_MAX_CHARS = 200
