/**
 * SA-120 P10a (DL-120-18) — judge providers: the decision runtimes Judge Juice can ask besides TypeSafe.
 *
 * Josh's rule (2026-10-12): Batshit integrates only runtimes that ALREADY expose a Jev-compatible
 * `POST /v1/systemone` (TypeSafe, Ollama 0.35+, Cloudflare Workers AI, and any later runtime as a
 * `systemone_url`). No loader, no adapter, no runtime-specific special case beyond the four kinds.
 * TypeSafe stays the shipped default and every switch stays OFF.
 *
 * Browser-safe: the Admin card validates its drafts and writes its sentences with the same functions the
 * server uses to validate, read, and route. The server-only half (keys, URLs, clients, the Ollama reads)
 * lives under `$lib/server/services/typesafe/`.
 */

import type {
  JudgeLaneId,
  JudgePrivacyClass,
  JudgeProvider,
  JudgeProviderKind,
  JudgeProviderRecord,
  JudgeProviderRef,
  TypesafeCallRecord,
  TypesafeConfig
} from '$lib/types/typesafe'
import {
  CLOUDFLARE_WORKERS_AI_KEY_SERVICE,
  SYSTEMONE_URL_KEY_SERVICE,
  TYPESAFE_KEY_SERVICE
} from '$lib/types/typesafe'

/** The one built-in judge. Its model is the record's own `modelId` (LS-048); it cannot be removed. */
export const BUILTIN_TYPESAFE_PROVIDER_ID = 'typesafe'
/**
 * What a stored default or feature choice reads as when it is present but damaged (not a judge id: a number, an
 * empty string, a hand edit, a bad restore). It names no judge, so the access rule denies with `no_provider`; it is
 * never read as TypeSafe, because that would quietly send text a user chose to keep local to a cloud judge (review
 * round 1, M2). Only an ABSENT field means the shipped default. Not a valid judge id (ids start with a letter or digit).
 */
export const UNREADABLE_JUDGE_CHOICE = '__unreadable__'
export const TYPESAFE_PROVIDER_LABEL = 'TypeSafe'

/** Every Jev-compatible runtime answers here, under its base URL. */
export const SYSTEMONE_PATH = '/v1/systemone'
export const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com'
/** Cloudflare's two decision models on Workers AI (blog 2026-10-01; Clef-omni takes audio and video, out of scope). */
export const CLOUDFLARE_JUDGE_MODELS = ['clef', 'clef-flash'] as const
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
/** The capability Ollama's `/api/tags` and `/api/show` report for a model that answers `/v1/systemone`. */
export const OLLAMA_DECISION_CAPABILITY = 'decision'

export const MAX_JUDGE_PROVIDERS = 16
export const JUDGE_PROVIDER_LABEL_MAX_CHARS = 60
const JUDGE_URL_MAX_CHARS = 500
const JUDGE_MODEL_MAX_CHARS = 200
const JUDGE_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i
/** An Ollama model name: `clef-flash`, `clef-flash:latest`, `nimble:9b`, `hf.co/org/model:Q4_K_M`. */
const OLLAMA_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/
const PRINTABLE_PATTERN = /^[^\u0000-\u001f\u007f]+$/

/** The ten Judge Juice lanes a judge can be chosen for, in the order the Admin card lists them. */
export const JUDGE_LANE_IDS: readonly JudgeLaneId[] = Object.freeze([
  'skill_tool_hints',
  'judge_ask',
  'group_speaker',
  'memory_rerank',
  'memory_recall',
  'smart_zip',
  'reply_check',
  'style_coach',
  'untrusted_text',
  'quick_actions'
])

export function isJudgeLaneId(value: unknown): value is JudgeLaneId {
  return typeof value === 'string' && (JUDGE_LANE_IDS as readonly string[]).includes(value)
}

export const JUDGE_KIND_LABELS: Readonly<Record<JudgeProviderKind, string>> = Object.freeze({
  typesafe: 'TypeSafe',
  ollama: 'Ollama',
  cloudflare: 'Cloudflare Workers AI',
  systemone_url: 'System One URL'
})

/** The kinds a user can add (TypeSafe is built in). */
export const ADDABLE_JUDGE_KINDS = ['ollama', 'cloudflare', 'systemone_url'] as const

/**
 * Starting addresses for a `systemone_url` judge (URL only, the user edits them). Not special cases: each is the
 * generic kind with a filled-in address. oMLX 0.7.0 lists no System One route yet; it is here for when it does.
 */
export const SYSTEMONE_URL_PRESETS: ReadonlyArray<{ label: string; baseUrl: string; sendsKey: boolean }> = Object.freeze([
  { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234', sendsKey: false },
  { label: 'oMLX', baseUrl: 'http://127.0.0.1:8000', sendsKey: false },
  { label: 'llama-server', baseUrl: 'http://127.0.0.1:8080', sendsKey: false },
  { label: 'Ollaya', baseUrl: 'http://127.0.0.1:11435', sendsKey: false },
  { label: 'Liquid AI', baseUrl: 'https://api.liquid.ai/decisions', sendsKey: true }
])

// ---------------------------------------------------------------------------
// Which judge a lane asks
// ---------------------------------------------------------------------------

type ConfigForJudges = Pick<TypesafeConfig, 'modelId'> &
  Partial<Pick<TypesafeConfig, 'providers' | 'defaultProviderId' | 'laneProviders'>>

export function builtinTypesafeProvider(config: Pick<TypesafeConfig, 'modelId'>): JudgeProvider {
  return {
    id: BUILTIN_TYPESAFE_PROVIDER_ID,
    kind: 'typesafe',
    label: TYPESAFE_PROVIDER_LABEL,
    modelId: config.modelId
  }
}

/** The built-in TypeSafe judge first, then every added one. */
export function listJudgeProviders(config: ConfigForJudges): JudgeProvider[] {
  const added = Array.isArray(config.providers) ? config.providers : []
  return [builtinTypesafeProvider(config), ...added.map((record) => ({ ...record }))]
}

/**
 * THE routing rule: a feature's own choice, else the default. A choice that names a judge that is not in the list
 * (deleted, or dropped on read because it was invalid) resolves to `null`, and the access rule then denies with
 * `no_provider`. It NEVER falls back to another judge: a user who picked a judge on this computer must never have
 * their text sent to a cloud judge instead.
 */
export function resolveJudgeProviderForLane(
  config: ConfigForJudges,
  featureId: string
): { providerId: string; provider: JudgeProvider | null } {
  const laneChoice = isJudgeLaneId(featureId) ? config.laneProviders?.[featureId] : undefined
  const providerId =
    typeof laneChoice === 'string' && laneChoice
      ? laneChoice
      : typeof config.defaultProviderId === 'string' && config.defaultProviderId
        ? config.defaultProviderId
        : BUILTIN_TYPESAFE_PROVIDER_ID
  const provider = listJudgeProviders(config).find((entry) => entry.id === providerId) ?? null
  return { providerId, provider }
}

/** A judge whose record lacks what its kind needs to be called (no URL, no account) cannot be asked. */
export function isJudgeProviderUsable(provider: JudgeProvider): boolean {
  if (!provider.modelId) return false
  switch (provider.kind) {
    case 'typesafe':
      return true
    case 'ollama':
    case 'systemone_url':
      return Boolean(provider.baseUrl)
    case 'cloudflare':
      return Boolean(provider.accountId)
    default:
      return false
  }
}

/** The key service a judge sends a key from, or `null` when it sends none (Ollama, a keyless URL). */
export function judgeKeyService(provider: Pick<JudgeProvider, 'kind' | 'sendsKey'>): string | null {
  switch (provider.kind) {
    case 'typesafe':
      return TYPESAFE_KEY_SERVICE
    case 'cloudflare':
      return CLOUDFLARE_WORKERS_AI_KEY_SERVICE
    case 'systemone_url':
      return provider.sendsKey === true ? SYSTEMONE_URL_KEY_SERVICE : null
    default:
      return null
  }
}

export function judgeProviderRef(provider: Pick<JudgeProvider, 'id' | 'kind' | 'label'>): JudgeProviderRef {
  return { id: provider.id, kind: provider.kind, label: provider.label }
}

// ---------------------------------------------------------------------------
// Names and sentences (DL-120-18: name the model that judged; the family stays Judge Juice)
// ---------------------------------------------------------------------------

/**
 * SA-120 P10b review round 1 (M1): a model name the judge REPORTED (copied from its response) reaches the agent's DCM
 * lines and the badges, so it is shown only when it is plain: one short token of letters, digits, and `. _ : / @ -`.
 * Anything else (a newline, spaces, an over-long string, markup) reads as the judge's kind label, never as the text.
 */
const SAFE_REPORTED_MODEL_NAME = /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,63}$/

const KNOWN_MODEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  clef: 'Clef',
  'clef-flash': 'Clef Flash',
  'clef-omni': 'Clef Omni',
  nimble: 'Nimble'
})

/**
 * THE helper that names the judge in a user-facing sentence: "Flagged by Clef Flash". TypeSafe's model is always
 * "Jev" (AMD-120-06 became "say the model's name"; Jev is that name). A known decision family gets its proper name;
 * any other model keeps its own id (without Ollama's `:latest`).
 */
export function judgeModelName(judge: { kind?: JudgeProviderKind | null; modelId?: string | null } | null | undefined): string {
  if (!judge || !judge.kind || judge.kind === 'typesafe') return 'Jev'
  const raw = typeof judge.modelId === 'string' ? judge.modelId.trim() : ''
  if (!raw || !SAFE_REPORTED_MODEL_NAME.test(raw)) return JUDGE_KIND_LABELS[judge.kind] ?? 'the judge'
  const withoutLatest = raw.replace(/:latest$/i, '')
  const family = withoutLatest.split('/').pop()?.split(':')[0]?.toLowerCase() ?? ''
  return KNOWN_MODEL_NAMES[family] ?? withoutLatest
}

/**
 * SA-120 P10b: what a sentence calls the judge when Batshit holds no record of which one judged (a stored mark, a
 * chip, a tooltip built from metadata that keeps no judge). Never a guess: "the judge" is right for every judge.
 */
export const UNKNOWN_JUDGE_NAME = 'the judge'

/** "the judge" opens a sentence as "The judge"; a model's own name (Jev, Clef Flash, a model id) is left exactly as it is. */
export function judgeNameAtSentenceStart(name: string): string {
  return name === UNKNOWN_JUDGE_NAME ? 'The judge' : name
}

/**
 * SA-120 P10b: the judge's name for one stored call record, for a sentence built AFTER the judgment. A row from
 * before P10a has no `provider` and was always TypeSafe (Jev). A `no_provider` denial names no judge (its chosen id
 * found none, review round 1 S5), and neither does a missing record: both read as "the judge", never Jev.
 */
export function judgeNameOfCallRecord(
  record: Pick<TypesafeCallRecord, 'provider' | 'model' | 'reason' | 'chosenProviderId'> | null | undefined
): string {
  if (!record || typeof record !== 'object') return UNKNOWN_JUDGE_NAME
  if (record.reason === 'no_provider' || record.chosenProviderId) return UNKNOWN_JUDGE_NAME
  return judgeModelName({ kind: record.provider?.kind ?? 'typesafe', modelId: record.model })
}

/** Who SERVES the judge, for sentences about reaching it: "Ollama did not answer in time." */
export function judgeServiceName(judge: Pick<JudgeProviderRef, 'kind' | 'label'> | null | undefined): string {
  if (!judge || judge.kind === 'typesafe') return TYPESAFE_PROVIDER_LABEL
  if (judge.kind === 'ollama') return 'Ollama'
  if (judge.kind === 'cloudflare') return 'Cloudflare'
  return judge.label?.trim() || JUDGE_KIND_LABELS.systemone_url
}

function hostOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

function ipv4Octets(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
  const octets = host.split('.').map((part) => Number.parseInt(part, 10))
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null
}

/**
 * Where a request to this host goes. `local`: this computer (a loopback address, exactly `localhost`, or Docker's
 * `host.docker.internal`, which is the computer running Batshit's container). `lan`: a private-range address
 * (10/8, 172.16/12, 192.168/16, 169.254/16, IPv6 unique-local and link-local) or an mDNS `.local` name.
 * `cloud`: everything else, including a bare name Batshit cannot place: the sentence then says the text leaves
 * this computer, which is the safe thing to say when Batshit does not know.
 */
export function classifyJudgeHost(baseUrl: string | undefined): JudgePrivacyClass {
  const host = hostOf(baseUrl)
  if (!host) return 'cloud'
  if (host === 'localhost' || host === 'host.docker.internal') return 'local'
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'local'
  const v4 = ipv4Octets(host)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return 'local'
    if (a === 10) return 'lan'
    if (a === 172 && b >= 16 && b <= 31) return 'lan'
    if (a === 192 && b === 168) return 'lan'
    if (a === 169 && b === 254) return 'lan'
    return 'cloud'
  }
  if (host.includes(':')) {
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'lan'
    if (/^fe[89ab][0-9a-f]:/.test(host)) return 'lan'
    return 'cloud'
  }
  if (host.endsWith('.local')) return 'lan'
  return 'cloud'
}

export function judgePrivacyClass(provider: Pick<JudgeProvider, 'kind' | 'baseUrl'>): JudgePrivacyClass {
  if (provider.kind === 'typesafe' || provider.kind === 'cloudflare') return 'cloud'
  return classifyJudgeHost(provider.baseUrl)
}

/** The "where your text goes" sentence for one judge (the Admin card writes it under each judge). */
export function judgePrivacySentence(provider: Pick<JudgeProvider, 'kind' | 'baseUrl'>): string {
  if (provider.kind === 'typesafe') return "Your text leaves this computer and goes to TypeSafe's servers."
  if (provider.kind === 'cloudflare') return "Your text leaves this computer and goes to Cloudflare's servers (Workers AI)."
  const host = hostOf(provider.baseUrl) ?? 'this address'
  switch (judgePrivacyClass(provider)) {
    case 'local':
      return 'Your text stays on this computer.'
    case 'lan':
      return `Your text leaves this computer but stays on your local network (${host}).`
    default:
      return `Your text leaves this computer and goes to ${host}.`
  }
}

/** "on this computer", "on your local network", or `null` for a cloud judge: for "Judged on this computer by Nimble". */
export function judgeWhereText(provider: Pick<JudgeProvider, 'kind' | 'baseUrl'>): string | null {
  const privacy = judgePrivacyClass(provider)
  if (privacy === 'local') return 'on this computer'
  if (privacy === 'lan') return 'on your local network'
  return null
}

// ---------------------------------------------------------------------------
// Limits and the pre-send fit check (never truncate, never split a Choice)
// ---------------------------------------------------------------------------

export interface JudgeLimits {
  maxQuestions: number
  maxChoiceOptions: number
  /** The judge's input budget in tokens (state plus questions). */
  maxInputTokens: number
  /**
   * How many request characters Batshit counts as one token for this judge. TypeSafe keeps Batshit's existing
   * four (the judgment tool's 120,000-character guard is "about 30k tokens"); Jev refuses an oversized request
   * loudly. The Clef and Nimble judges count three, because a runtime may cut a long state silently (Cloudflare
   * says it does): SA-120 P1 measured 7.9k real tokens at about 24k characters, so three is the honest guard.
   */
  charsPerToken: number
  /**
   * Tokens the runtime adds around the request (its template, each question's wrapper), counted on top of the
   * characters. Measured once on Ollama (see `JUDGE_PROMPT_OVERHEAD_TOKENS`); 0 for TypeSafe, whose overhead is
   * unmeasured and whose budget is the vendor's own character figure.
   */
  overheadTokens: number
  overheadPerQuestionTokens: number
  /** Where `maxInputTokens` came from, for the Execution Viewer and the card. */
  tokensSource: 'profile' | 'reported'
}

const TYPESAFE_LIMITS: JudgeLimits = Object.freeze({
  maxQuestions: 64,
  // The vendor's maximum; the lanes keep their own 240 cap (Jev is reliable to about 240), and the judgment tool
  // already accepts up to 255, so the profile must not refuse what Batshit sends Jev today.
  maxChoiceOptions: 255,
  // TypeSafe documents Jev's request budget as about 32k tokens, "roughly 150,000 characters" (the skill's
  // api-and-sdk.md §5). Batshit holds Jev to that character figure: 150,000 at four characters a token, with no
  // overhead added (Jev's is unmeasured, and Jev refuses an oversized request loudly instead of cutting it). P10c
  // measures Jev's real budget (review round 1, S4).
  maxInputTokens: 37_500,
  charsPerToken: 4,
  overheadTokens: 0,
  overheadPerQuestionTokens: 0,
  tokensSource: 'profile'
})

/**
 * The prompt a runtime builds around the request (its template, each question's wrapper) costs tokens the request
 * characters do not show. One measured point (SA-120 P10a, Ollama 0.40.3 + clef-flash on Josh's Mac, 2026-10-12): a
 * one-question, 279-character request counted 154 real input tokens against 93 by characters alone. So the estimate
 * for every judge but TypeSafe adds a fixed allowance per request and per question; P10c measures it properly.
 */
export const JUDGE_PROMPT_OVERHEAD_TOKENS = 128
export const JUDGE_PROMPT_OVERHEAD_PER_QUESTION_TOKENS = 16
const RUNTIME_OVERHEAD = Object.freeze({
  overheadTokens: JUDGE_PROMPT_OVERHEAD_TOKENS,
  overheadPerQuestionTokens: JUDGE_PROMPT_OVERHEAD_PER_QUESTION_TOKENS
})

/** Ollama: 2-26 Choice options (its two docs pages disagree, 26 vs 255; the smaller until P10c measures). */
const OLLAMA_CHOICE_OPTIONS = 26
/**
 * Ollama's prompt budget per model when the runtime reports no `num_ctx`. Nimble's model card: an 8,192-token
 * complete prompt. Clef Flash: Ollama 0.40.3 on Josh's Mac ships it with `PARAMETER num_ctx 16384` (measured
 * 2026-10-12 through `/api/show`). Anything else: the smallest known budget.
 */
const OLLAMA_FALLBACK_INPUT_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  nimble: 8_192,
  'clef-flash': 16_384
})
const SMALLEST_KNOWN_INPUT_TOKENS = 8_192
/** Cloudflare Workers AI context per model (2026-10-09 update: Clef Flash cut to 24K). Long state is cut SILENTLY. */
const CLOUDFLARE_INPUT_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  clef: 65_536,
  'clef-flash': 24_576
})

function modelFamily(modelId: string): string {
  return modelId.trim().replace(/:latest$/i, '').split('/').pop()?.split(':')[0]?.toLowerCase() ?? ''
}

/** The limits Batshit knows for a kind and model, before anything the runtime reports. */
export function profileJudgeLimits(provider: Pick<JudgeProvider, 'kind' | 'modelId'>): JudgeLimits {
  switch (provider.kind) {
    case 'typesafe':
      return { ...TYPESAFE_LIMITS }
    case 'ollama':
      return {
        maxQuestions: 64,
        maxChoiceOptions: OLLAMA_CHOICE_OPTIONS,
        maxInputTokens: OLLAMA_FALLBACK_INPUT_TOKENS[modelFamily(provider.modelId)] ?? SMALLEST_KNOWN_INPUT_TOKENS,
        charsPerToken: 3,
        ...RUNTIME_OVERHEAD,
        tokensSource: 'profile'
      }
    case 'cloudflare':
      return {
        maxQuestions: 64,
        // Cloudflare does not publish a Choice cap; the same Clef models take 26 through Ollama, so 26 until measured.
        maxChoiceOptions: OLLAMA_CHOICE_OPTIONS,
        maxInputTokens: CLOUDFLARE_INPUT_TOKENS[modelFamily(provider.modelId)] ?? CLOUDFLARE_INPUT_TOKENS['clef-flash'],
        charsPerToken: 3,
        ...RUNTIME_OVERHEAD,
        tokensSource: 'profile'
      }
    default:
      // A System One URL: Batshit does not know the runtime, so the smallest numbers any known judge has.
      return {
        maxQuestions: 64,
        maxChoiceOptions: OLLAMA_CHOICE_OPTIONS,
        maxInputTokens: SMALLEST_KNOWN_INPUT_TOKENS,
        charsPerToken: 3,
        ...RUNTIME_OVERHEAD,
        tokensSource: 'profile'
      }
  }
}

/** A runtime that reports its context (Ollama's `num_ctx`) is believed over the profile, raised or lowered. */
export function withReportedInputTokens(limits: JudgeLimits, reported: number | null | undefined): JudgeLimits {
  if (typeof reported !== 'number' || !Number.isInteger(reported) || reported <= 0) return limits
  return { ...limits, maxInputTokens: reported, tokensSource: 'reported' }
}

export function estimateJudgeInputTokens(
  requestChars: number,
  limits: Pick<JudgeLimits, 'charsPerToken' | 'overheadTokens' | 'overheadPerQuestionTokens'>,
  questionCount = 0
): number {
  return (
    Math.ceil(Math.max(0, requestChars) / Math.max(1, limits.charsPerToken)) +
    limits.overheadTokens +
    limits.overheadPerQuestionTokens * Math.max(0, questionCount)
  )
}

export type JudgeFitResult =
  | { fits: true; estimatedTokens: number }
  | { fits: false; estimatedTokens: number; detail: string }

/**
 * THE pre-send fit check. A request that does not fit is never sent, never cut, and a Choice is never split
 * across requests (a Choice split in two is a different question): the caller reports `provider_limit` and the
 * lane omits its result with its normal note.
 */
export function checkJudgeRequestFit(
  limits: JudgeLimits,
  questions: Record<string, { type?: unknown; criteria?: unknown }>,
  requestChars: number
): JudgeFitResult {
  const questionCount = Object.keys(questions).length
  const estimatedTokens = estimateJudgeInputTokens(requestChars, limits, questionCount)
  if (questionCount > limits.maxQuestions) {
    return { fits: false, estimatedTokens, detail: `${questionCount} questions; this judge takes at most ${limits.maxQuestions}` }
  }
  let largestChoice = 0
  for (const question of Object.values(questions)) {
    if (question?.type !== 'choice' || !question.criteria || typeof question.criteria !== 'object') continue
    largestChoice = Math.max(largestChoice, Object.keys(question.criteria as Record<string, unknown>).length)
  }
  if (largestChoice > limits.maxChoiceOptions) {
    return {
      fits: false,
      estimatedTokens,
      detail: `a Choice with ${largestChoice} options; this judge takes at most ${limits.maxChoiceOptions}`
    }
  }
  if (estimatedTokens > limits.maxInputTokens) {
    return {
      fits: false,
      estimatedTokens,
      detail: `about ${estimatedTokens.toLocaleString('en-US')} input tokens; this judge takes at most ${limits.maxInputTokens.toLocaleString('en-US')}`
    }
  }
  return { fits: true, estimatedTokens }
}

// ---------------------------------------------------------------------------
// Validation: tolerant read, strict write (one set of rules for the card and the server)
// ---------------------------------------------------------------------------

/** A judge address: http or https, no user name or password, no query or fragment; trailing slashes dropped. */
export function normalizeJudgeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > JUDGE_URL_MAX_CHARS) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  if (!parsed.hostname) return null
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}

function judgeModelError(kind: JudgeProviderKind, modelId: unknown): string | null {
  if (typeof modelId !== 'string' || !modelId.trim()) return 'a model is required'
  const model = modelId.trim()
  if (model.length > JUDGE_MODEL_MAX_CHARS || !PRINTABLE_PATTERN.test(model)) return 'the model name is not valid'
  if (kind === 'ollama' && !OLLAMA_MODEL_PATTERN.test(model)) return 'the model must be an Ollama model name such as clef-flash'
  if (kind === 'cloudflare' && !(CLOUDFLARE_JUDGE_MODELS as readonly string[]).includes(model)) {
    return `the model must be ${CLOUDFLARE_JUDGE_MODELS.join(' or ')}`
  }
  return null
}

export type JudgeProviderValidation = { ok: true; value: JudgeProviderRecord } | { ok: false; error: string }

/** Strict: one added judge, exactly as the write side accepts it. The error names the judge by its label. */
export function validateJudgeProviderRecord(input: unknown): JudgeProviderValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Each judge must be an object.' }
  const raw = input as Record<string, unknown>
  const name = typeof raw.label === 'string' && raw.label.trim() ? `"${raw.label.trim()}"` : 'A judge'
  if (typeof raw.id !== 'string' || !JUDGE_PROVIDER_ID_PATTERN.test(raw.id) || raw.id === BUILTIN_TYPESAFE_PROVIDER_ID) {
    return { ok: false, error: `${name} has an id Batshit cannot use.` }
  }
  if (raw.kind !== 'ollama' && raw.kind !== 'cloudflare' && raw.kind !== 'systemone_url') {
    return { ok: false, error: `${name} must be Ollama, Cloudflare Workers AI, or a System One URL.` }
  }
  const kind = raw.kind
  if (typeof raw.label !== 'string' || !raw.label.trim()) return { ok: false, error: 'Every judge needs a name.' }
  const label = raw.label.trim()
  if (label.length > JUDGE_PROVIDER_LABEL_MAX_CHARS || !PRINTABLE_PATTERN.test(label)) {
    return { ok: false, error: `${name}: a name is at most ${JUDGE_PROVIDER_LABEL_MAX_CHARS} characters on one line.` }
  }
  const record: JudgeProviderRecord = { id: raw.id, kind, label, modelId: '' }
  if (kind === 'ollama' || kind === 'systemone_url') {
    const baseUrl = normalizeJudgeBaseUrl(raw.baseUrl)
    if (!baseUrl) return { ok: false, error: `${name}: the address must be an http or https URL without a user name, query, or #.` }
    record.baseUrl = baseUrl
  } else if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== '') {
    return { ok: false, error: `${name}: a Cloudflare judge takes an account id, not an address.` }
  }
  if (kind === 'cloudflare') {
    if (typeof raw.accountId !== 'string' || !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(raw.accountId.trim())) {
      return { ok: false, error: `${name}: the Cloudflare account id is 32 letters and digits (0-9, a-f).` }
    }
    record.accountId = raw.accountId.trim().toLowerCase()
  } else if (raw.accountId !== undefined && raw.accountId !== null && raw.accountId !== '') {
    return { ok: false, error: `${name}: only a Cloudflare judge takes an account id.` }
  }
  const modelError = judgeModelError(kind, raw.modelId)
  if (modelError) return { ok: false, error: `${name}: ${modelError}.` }
  record.modelId = (raw.modelId as string).trim()
  if (raw.sendsKey !== undefined && raw.sendsKey !== null) {
    if (typeof raw.sendsKey !== 'boolean') return { ok: false, error: `${name}: "Send Key" must be true or false.` }
    if (raw.sendsKey && kind !== 'systemone_url') return { ok: false, error: `${name}: only a System One URL judge has a "Send Key" choice.` }
    // A key over plain http travels readable; only a judge on this computer may receive it that way (round 1, S2).
    if (raw.sendsKey && record.baseUrl?.startsWith('http:') && classifyJudgeHost(record.baseUrl) !== 'local') {
      return { ok: false, error: `${name}: "Send Key" needs an https address unless the judge is on this computer.` }
    }
    if (kind === 'systemone_url') record.sendsKey = raw.sendsKey
  }
  return { ok: true, value: record }
}

/** The one judge in a list allowed to send the System One URL key (round 1, S2: one judge at a time). */
function secondKeySender(records: JudgeProviderRecord[]): { first: JudgeProviderRecord; second: JudgeProviderRecord } | null {
  const senders = records.filter((record) => record.sendsKey === true)
  return senders.length > 1 ? { first: senders[0], second: senders[1] } : null
}

export type JudgeProvidersValidation = { ok: true; value: JudgeProviderRecord[] } | { ok: false; error: string }

export function validateJudgeProvidersInput(input: unknown): JudgeProvidersValidation {
  if (!Array.isArray(input)) return { ok: false, error: '`providers` must be a list.' }
  if (input.length > MAX_JUDGE_PROVIDERS) return { ok: false, error: `At most ${MAX_JUDGE_PROVIDERS} judges can be added.` }
  const seen = new Set<string>()
  const value: JudgeProviderRecord[] = []
  for (const entry of input) {
    const checked = validateJudgeProviderRecord(entry)
    if (!checked.ok) return checked
    if (seen.has(checked.value.id)) return { ok: false, error: `Two judges share the id ${checked.value.id}.` }
    seen.add(checked.value.id)
    value.push(checked.value)
  }
  const twoSenders = secondKeySender(value)
  if (twoSenders) {
    return {
      ok: false,
      error: `"${twoSenders.first.label}" already sends the System One URL key. One judge at a time can send this key; turn Send Key off on "${twoSenders.second.label}".`
    }
  }
  return { ok: true, value }
}

export type JudgeLaneProvidersValidation =
  | { ok: true; value: Partial<Record<JudgeLaneId, string>> }
  | { ok: false; error: string }

/** A feature's own judge: a known feature id and a judge id; `null` or `''` means "use the default". */
export function validateJudgeLaneProvidersInput(input: unknown): JudgeLaneProvidersValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '`laneProviders` must be an object.' }
  const value: Partial<Record<JudgeLaneId, string>> = {}
  for (const [lane, providerId] of Object.entries(input as Record<string, unknown>)) {
    if (!isJudgeLaneId(lane)) return { ok: false, error: `${lane} is not a Judge Juice feature.` }
    if (providerId === null || providerId === '') continue
    if (!isJudgeChoiceValue(providerId)) {
      return { ok: false, error: `The judge chosen for ${lane} is not a judge id.` }
    }
    value[lane] = providerId
  }
  return { ok: true, value }
}

export function isJudgeProviderIdShape(value: unknown): value is string {
  return typeof value === 'string' && (value === BUILTIN_TYPESAFE_PROVIDER_ID || JUDGE_PROVIDER_ID_PATTERN.test(value))
}

/**
 * A value a stored or sent choice may hold: a judge id, or the damaged-choice marker the read side produced. The
 * marker is accepted on write only so the card can send back a draft that still holds it; it names no judge, so a
 * save that CREATES one is still refused as a new dangling choice (`newDanglingJudgeChoices`).
 */
export function isJudgeChoiceValue(value: unknown): value is string {
  return isJudgeProviderIdShape(value) || value === UNREADABLE_JUDGE_CHOICE
}

/**
 * Every choice that names a judge the list does not hold. The write side refuses a record with any (a save never
 * stores a dangling choice); the read side keeps them, and the access rule denies with `no_provider`.
 */
export function findDanglingJudgeChoices(config: ConfigForJudges): string[] {
  const ids = new Set(listJudgeProviders(config).map((provider) => provider.id))
  const dangling: string[] = []
  if (typeof config.defaultProviderId === 'string' && !ids.has(config.defaultProviderId)) dangling.push('default')
  for (const [lane, providerId] of Object.entries(config.laneProviders ?? {})) {
    if (typeof providerId === 'string' && providerId && !ids.has(providerId)) dangling.push(lane)
  }
  return dangling
}

/**
 * Every choice the `after` record holds that names no judge and that `before` did not already hold. The write side
 * refuses only these (review round 1, S3): a save may carry a broken choice that was already stored (so a damaged
 * record can still be switched off), but no save may create one.
 */
export function newDanglingJudgeChoices(before: ConfigForJudges, after: ConfigForJudges): string[] {
  const already = new Set(findDanglingJudgeChoices(before).map((where) => `${where}=${where === 'default' ? before.defaultProviderId : before.laneProviders?.[where as JudgeLaneId]}`))
  return findDanglingJudgeChoices(after).filter(
    (where) => !already.has(`${where}=${where === 'default' ? after.defaultProviderId : after.laneProviders?.[where as JudgeLaneId]}`)
  )
}

/**
 * Tolerant read: invalid entries are dropped, and so is a second judge that would send the System One URL key (any
 * choice that named a dropped judge then denies with `no_provider`).
 */
export function normalizeStoredJudgeProviders(raw: unknown): JudgeProviderRecord[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: JudgeProviderRecord[] = []
  let keySender = false
  for (const entry of raw) {
    if (out.length >= MAX_JUDGE_PROVIDERS) break
    const checked = validateJudgeProviderRecord(entry)
    if (!checked.ok || seen.has(checked.value.id)) continue
    if (checked.value.sendsKey === true) {
      if (keySender) continue
      keySender = true
    }
    seen.add(checked.value.id)
    out.push(checked.value)
  }
  return out
}

/** Tolerant read of the stored default: absent means TypeSafe; present but not a judge id names no judge (M2). */
export function normalizeStoredJudgeDefault(stored: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(stored, 'defaultProviderId') || stored.defaultProviderId === undefined) {
    return BUILTIN_TYPESAFE_PROVIDER_ID
  }
  return isJudgeChoiceValue(stored.defaultProviderId) ? stored.defaultProviderId : UNREADABLE_JUDGE_CHOICE
}

/**
 * Tolerant read of the per-feature choices: unknown lanes are dropped (they steer nothing); a lane whose stored value
 * is not a judge id KEEPS a choice that names no judge (it denies, never falls back to the default, M2); an id that
 * names no judge is kept as it is. A field that is present but not an object leaves every lane's choice unknown, so
 * every lane denies until a save names judges again.
 */
export function normalizeStoredJudgeLaneProviders(raw: unknown): Partial<Record<JudgeLaneId, string>> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.fromEntries(JUDGE_LANE_IDS.map((lane) => [lane, UNREADABLE_JUDGE_CHOICE])) as Partial<Record<JudgeLaneId, string>>
  }
  const out: Partial<Record<JudgeLaneId, string>> = {}
  for (const [lane, providerId] of Object.entries(raw as Record<string, unknown>)) {
    if (!isJudgeLaneId(lane)) continue
    out[lane] = isJudgeChoiceValue(providerId) ? providerId : UNREADABLE_JUDGE_CHOICE
  }
  return out
}

/** A new judge id the list does not hold yet. */
export function newJudgeProviderId(kind: Exclude<JudgeProviderKind, 'typesafe'>, existing: Iterable<string>, random: () => number = Math.random): string {
  const taken = new Set(existing)
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `${kind.replace('_', '-')}-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`
    if (!taken.has(id)) return id
  }
  return `${kind.replace('_', '-')}-${Date.now().toString(16)}`
}
