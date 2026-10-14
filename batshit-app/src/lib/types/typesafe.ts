/**
 * SA-120 Judge Juice — shared types for the TypeSafe System One (Jev) integration.
 *
 * Jev is a non-generative cloud judgment model: code sends a `state` plus typed
 * questions and gets calibrated probabilities back. It never writes text and is
 * never an agent. Everything here is opt-in, keyed, and visible (DL-120-01/02).
 *
 * Browser-safe: no server imports. The server-only client, config, and
 * availability rule live under `$lib/server/services/typesafe/`.
 */

/** The API-key service id under which the TypeSafe key is stored (`api_keys:{userId}:typesafe`). */
export const TYPESAFE_KEY_SERVICE = 'typesafe' as const
/** SA-120 P10a (DL-120-18): the Cloudflare API token a `cloudflare` judge sends (`api_keys:{userId}:cloudflare_workers_ai`). */
export const CLOUDFLARE_WORKERS_AI_KEY_SERVICE = 'cloudflare_workers_ai' as const
/** SA-120 P10a: the one key a `systemone_url` judge sends when its record says `sendsKey` (Liquid AI, for one). */
export const SYSTEMONE_URL_KEY_SERVICE = 'systemone_url' as const

export type TypesafeCallStatus = 'ok' | 'unavailable' | 'error'

/** Why a call made no answer available. Never a silent fallback: each one is shown somewhere (DL-120-02). */
export type TypesafeUnavailableReason =
  | 'master_off'
  | 'feature_off'
  | 'no_key'
  | 'deadline'
  | 'timeout'
  | 'rate_limited'
  | 'network'
  | 'aborted'
  /** SA-120 P10a: the judge chosen for this feature is missing or not set up (no URL, no account, a deleted judge). */
  | 'no_provider'
  /**
   * SA-120 P10a: the request does not fit the chosen judge's limits (questions, Choice options, or the input-token
   * estimate), so Batshit sent nothing; or the judge itself said its input was cut (a 422 `STATE_TRUNCATED`).
   * Batshit never truncates a request and never splits a Choice across requests.
   */
  | 'provider_limit'

/**
 * The vendor answered, but not with an answer Batshit can use — or (`local_error`, SA-120
 * P4b) Batshit itself failed while preparing the request, before anything was sent.
 */
export type TypesafeErrorReason = 'unauthorized' | 'bad_request' | 'server_error' | 'malformed' | 'local_error'

export type TypesafeCallReason = TypesafeUnavailableReason | TypesafeErrorReason

export interface TypesafeUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * One Execution Viewer row per Jev call (DL-120-07). Lives in
 * `ExecutionSnapshot.executionMetadata.typesafeCalls[]`.
 * `usage: null` means the vendor did not report usage — unknown, never zero.
 */
export interface TypesafeCallRecord {
  feature: string
  /** The model id the vendor reported, or the requested id when no answer came back. */
  model: string | null
  /**
   * SA-120 P10a (DL-120-18): the judge provider this call went to (or would have gone to). Absent on rows written
   * before P10a, which were all TypeSafe, and on a denial that never found a provider (`no_provider`).
   */
  provider?: JudgeProviderRef
  /**
   * SA-120 P10a review round 1 (S5): on a `no_provider` denial, the judge id the feature's choice (or the default)
   * named although no usable judge has it (a deleted judge, or the damaged-choice marker). The row then reads
   * "No judge", never Jev.
   */
  chosenProviderId?: string
  latencyMs: number
  usage: TypesafeUsage | null
  deadlineHit: boolean
  status: TypesafeCallStatus
  reason?: TypesafeCallReason
  /** Bounded, body-free vendor detail (a 422 names the bad field). Never request or response bodies. */
  detail?: string
  questionCount: number
  /** Size of the JSON request body in characters (state plus questions), for deadline forensics. */
  requestChars?: number
  /** One line, written by the feature: what Batshit did with the answers. */
  decision?: string
  at: string
}

/**
 * The inline note beside the memory chips at the bottom of an assistant bubble
 * (Josh's decision 1, 2026-09-16): a compile-lane miss omits its section, the send
 * proceeds, and this small chip says so. Never a pop-up.
 */
export interface JevJuiceNote {
  feature: string
  status: 'unavailable' | 'error' | 'not_applied'
  reason: TypesafeCallReason | 'receipt_not_saved'
  at: string
  /** SA-120 P10a: the judge the call went to, so the chip's tooltip names it. Absent on notes written before P10a (TypeSafe). */
  provider?: JudgeProviderRef
}

/**
 * SA-120 P1 (B6): a capability the request looked like it needed but the agent does
 * not have. Rendered as a chip on the assistant message with a link to the agent's
 * settings; the agent got the same fact as a DCM line. The chip names the gap and
 * never widens access.
 */
export interface JevJuiceGap {
  /** Catalog id, e.g. `native:web_search`, `gateway:<id>`, `cli:<toolId>`, `skill:<id>`. */
  id: string
  kind: 'native' | 'gateway' | 'cli' | 'skill'
  /** Human label, e.g. "Web Search" or `MCP source "GitHub"`. */
  label: string
  agentId: string
  agentName: string
  probability: number
  at: string
}

/**
 * SA-120 P5: zip state Batshit itself changed for a send, as stored with `source: 'inferred'`.
 * The tab that receives the finished reply re-reads zip state from Redis when this is present.
 */
export interface JevJuiceZipChanges {
  /** Zipped tool results opened for this message (a temporary unzip). */
  opened: Array<{ zipId: string; probability: number }>
}

/**
 * SA-120 P6: the two after-reply lanes. `reply_check` compares what a finished reply SAYS with
 * what the turn really did; `style_coach` holds up a mirror to repeated wording. Each has its
 * own per-agent switch.
 */
export type JevJuicePostTurnLane = 'reply_check' | 'style_coach'

export type JevJuicePostTurnFindingId =
  /** The reply says it did something that needs a tool, and no tool call accounts for it. */
  | 'claimed_action'
  /** The reply promises to remember, and nothing was saved this turn. */
  | 'promised_memory'
  /** A tool call failed and the reply does not say so. */
  | 'silent_failure'
  /** The request had several parts and the reply is silent about one. */
  | 'unaddressed_part'
  /** Counted: the same opening words as earlier replies. */
  | 'repeated_opener'
  /** Counted: the same closing words as earlier replies. */
  | 'repeated_closer'
  /** Counted: the same stock phrase in several recent replies. */
  | 'repeated_phrase'
  /** Judged: this reply and an earlier one both open by praising the user. */
  | 'praise_openers'
  /** Judged: the same verbal habit as the recent replies. */
  | 'same_move'

/**
 * One thing the after-reply check noticed. `inferred` means a Jev judgment, and `probability`
 * is that judgment (DL-120-04: inferred effects carry provenance). `counted` means Batshit
 * counted the repeat on this machine (`count` of `window`), and its `probability` is Jev's
 * judgment that the repeated words are a habit of speech rather than subject matter.
 */
export interface JevJuicePostTurnFinding {
  id: JevJuicePostTurnFindingId
  lane: JevJuicePostTurnLane
  source: 'counted' | 'inferred'
  probability?: number
  /** A local fact that makes the line concrete: the failed tool's label, or the repeated words. */
  detail?: string
  /** For counted findings: how many of the last `window` replies share it (this reply included). */
  count?: number
  window?: number
}

/**
 * SA-120 P6: what Batshit noticed about one finished reply. Stored per message under
 * `jev_post_turn_item:{sessionId}:{messageId}` by `postTurnCheckState.ts` (its only writer),
 * NEVER in the message's own metadata: the check runs after the session stream has emitted
 * `end`, and the browser saves its own copy of the message after that (SSE contract, F-P5-10).
 * A clean check stores nothing. `notes` holds a lane that could not run (DL-120-02).
 */
export interface JevJuicePostTurnRecord {
  messageId: string
  sessionId: string
  agentId: string | null
  at: string
  findings: JevJuicePostTurnFinding[]
  notes: JevJuiceNote[]
  /** False until a compile has told the agent; the accepted-send boundary flips it. */
  toldAgent: boolean
}

/**
 * SA-120 P7: text that reaches an agent from somewhere other than the user. `agent_dm` is
 * another agent's DM (a `result` included), `webhook` is a wake-up webhook's message, and
 * `skill` is the SKILL.md of a skill being imported.
 */
export type UntrustedTextSource = 'agent_dm' | 'webhook' | 'skill'

export type UntrustedTextFindingId =
  /** It tries to take control: countermands instructions, or claims system, admin, or user authority. */
  | 'override'
  /** It tells the assistant how to behave toward its own user or its own configuration. */
  | 'aimed_at_assistant'
  /** The user would object if they saw it and knew what it asked. */
  | 'against_user'

export interface UntrustedTextFinding {
  id: UntrustedTextFindingId
  /** Jev's judgment, two decimals. Every stored finding is at or over its floor. */
  probability: number
}

/**
 * SA-120 P7: what the incoming-text screen said about ONE text. ADVISORY ONLY: nothing reads
 * this to allow, block, approve, or deny anything (DL-120-12), and `no_flag` is never shown as
 * "safe" and never told to an agent, because a missing flag proves nothing.
 *
 * Stored on the DM record itself (`dm:{id}.screen`), so it shares that record's deletion,
 * backup, and retention; a skill import carries it in the import response and stores nothing.
 */
export interface UntrustedTextScreen {
  version: 1
  source: UntrustedTextSource
  /** `skipped` means Judge Juice could not run (DL-120-02: said on screen, never hidden). */
  status: 'flagged' | 'no_flag' | 'skipped'
  at: string
  /** `flagged` only: the questions at or over their floor, surest first. */
  findings: UntrustedTextFinding[]
  /** `flagged` only: `serious` when the harm Score says following it would do real damage. */
  severity?: 'serious' | 'caution'
  /** The harm Score, 0 (none) to 2 (serious), whenever Jev answered. */
  harm?: number
  /** `skipped` only. */
  reason?: TypesafeCallReason
  /** True when the text was longer than what Jev was shown. */
  clipped?: boolean
  /**
   * The call's own evidence row (DL-120-07). A webhook arrives with no turn running, so this is
   * the row's only home until the chat it wakes replays it into that turn's Execution Viewer.
   */
  record: TypesafeCallRecord
}

/** `message.metadata.jevJuice` on an assistant message. */
export interface JevJuiceMessageMetadata {
  notes: JevJuiceNote[]
  gaps?: JevJuiceGap[]
  zips?: JevJuiceZipChanges
}

/**
 * SA-120 P10a (DL-120-18): the decision runtimes Judge Juice can ask. Only runtimes that already expose a
 * Jev-compatible `POST /v1/systemone` join (Josh's "no hoops" rule); no loader or adapter is written for any other.
 */
export type JudgeProviderKind = 'typesafe' | 'ollama' | 'cloudflare' | 'systemone_url'

/** Where a judge's request goes, for the "where your text goes" sentence. */
export type JudgePrivacyClass = 'local' | 'lan' | 'cloud'

/**
 * One ADDED judge, stored in `batshit:typesafe_config.providers`. TypeSafe is not stored here: it is the one
 * built-in judge (id `typesafe`), and its model is the record's own `modelId` (LS-048). No key is ever stored on
 * this record: a key-bearing kind reads its key from `apiKeyService` per call.
 */
export interface JudgeProviderRecord {
  /** Stable id the default and the per-feature choices point at. Never `typesafe`. */
  id: string
  kind: Exclude<JudgeProviderKind, 'typesafe'>
  /** The user's name for it, shown in every list and in the Execution Viewer. */
  label: string
  /** `ollama` and `systemone_url`: the server's address; Batshit adds `/v1/systemone`. */
  baseUrl?: string
  /** `cloudflare`: the Cloudflare account id in the Workers AI path. */
  accountId?: string
  /** `ollama`: a tag that reports the `decision` capability; `cloudflare`: `clef` or `clef-flash`; `systemone_url`: as the server names it. */
  modelId: string
  /** `systemone_url` only: send the saved System One URL key as a bearer token (a hosted service such as Liquid AI). */
  sendsKey?: boolean
}

/** A judge as the access rule sees it: the built-in TypeSafe judge or one added record. */
export interface JudgeProvider {
  id: string
  kind: JudgeProviderKind
  label: string
  modelId: string
  baseUrl?: string
  accountId?: string
  sendsKey?: boolean
}

/** What an Execution Viewer row and a note keep about the judge. */
export interface JudgeProviderRef {
  id: string
  kind: JudgeProviderKind
  label: string
}

/**
 * The feature ids a judge can be chosen for, one per lane (the `TYPESAFE_FEATURES` ids minus the connection test).
 * Kept here, not derived from the registry, so the browser card and the server validator share one list.
 */
export type JudgeLaneId =
  | 'skill_tool_hints'
  | 'judge_ask'
  | 'group_speaker'
  | 'memory_rerank'
  | 'memory_recall'
  | 'smart_zip'
  | 'reply_check'
  | 'style_coach'
  | 'untrusted_text'
  | 'quick_actions'

/** Instance-level configuration stored at `batshit:typesafe_config` (the Settings → Admin → Judge Juice card). */
export interface TypesafeConfig {
  /** The master switch. OFF means no feature calls TypeSafe, whatever its own switch says (DL-120-01/11). */
  enabled: boolean
  /** A pinned model id such as `jev-1.13.0`. `jev-latest` is refused in product config (DL-120-08). */
  modelId: string
  /** Transport ceiling for one HTTP attempt. Lanes may set a shorter total deadline per call (DL-120-05). */
  attemptTimeoutMs: number
  /**
   * SA-120 P8: the **In-Chat Wait Limit** (LS-059, DL-120-16), default 750 ms. The total budget for a
   * Jev call the send path waits on (a `lane: 'in_chat'` judgment: hints, group speaker, recall by
   * meaning, smart zip). A miss skips that feature for the send and the message still goes out. A
   * higher value means "wait for Jev"; there is no off. Tool and after-reply lanes have their own budgets.
   */
  inChatWaitMs: number
  /**
   * SA-120 P7: the feature switch **Screen Incoming Text** (on the Judge Juice card) (LS-057), default OFF. It
   * lives here because the lane spans agent DMs, wake-up webhooks, and skill imports, and no
   * other record owns all three. THE reader is `resolveJevIncomingTextScreenEnabled`.
   */
  screenIncomingText: boolean
  /**
   * SA-120 P10a (DL-120-18): the judges the user ADDED (Ollama, Cloudflare Workers AI, any System One URL). Empty
   * on every record written before P10a, which therefore reads exactly as before: TypeSafe only.
   */
  providers: JudgeProviderRecord[]
  /** The judge every feature uses unless it has its own choice. `typesafe` by default (the shipped default). */
  defaultProviderId: string
  /** A feature's own judge, by feature id. Absent means the default. */
  laneProviders: Partial<Record<JudgeLaneId, string>>
  updatedAt: string | null
}

export type TypesafeKeySource = 'user' | 'env'

export interface TypesafeKeyStatus {
  present: boolean
  source: TypesafeKeySource | null
}
