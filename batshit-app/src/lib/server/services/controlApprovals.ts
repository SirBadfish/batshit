/**
 * SA-116 P1 (DL-116-01 … DL-116-04, DL-116-09, DL-116-10, DL-116-14) — the click is the
 * approval.
 *
 * ## The hole this closes
 *
 * Before this file, every `confirm` and `restricted` Fabric control ran the moment the
 * MODEL passed `allowRisky: true`. Nothing checked that a human had clicked or typed
 * anything, and the broker's own failure text told the model to retry with the flag once
 * "the user approved". SA-113 F-SEC-1 closed the woken half of that (a DM body and a
 * wake-up webhook body are first-class user turns, and the webhook route is reachable from
 * outside the machine whenever a tunnel runs). This closes the rest: a risky control now
 * **pauses** and waits for a real Approve click, in every chat lane.
 *
 * ## One gate, two callers
 *
 * `decideRiskGate` is THE risk decision, and it is deliberately the only one. Two entry
 * points reach it — `useControl` (`fabricRegistry.ts`, every Fabric control on every actor
 * and every lane) and `executeCliTool` (`cliToolRegistry.ts`, the second, independent gate
 * user-authored CLI tools have always had). Restating the order at either call site is how
 * the two files drifted in the first place: the same hole existed twice, in two files, with
 * two different spellings.
 *
 * The order, and why each step is where it is:
 *
 *   1. **A Portable Skill Token's scope IS the consent** (DL-116-09). The person who minted
 *      the token chose its families and there is no chat to click in, so this lane keeps its
 *      forced approval — audited as `portable-skill-scope`, never as a click.
 *   2. **A group chat refuses** (DL-116-10). The group runner never reads or writes
 *      `toolApprovals` and the client's resume POST is single-agent, so a card raised in a
 *      group turn would be written and then abandoned as the next speaker starts. An
 *      honest refusal beats a card nobody can answer.
 *   3. **A server-owned approval record runs the control, once.** Matched on
 *      `(userId, agentId, sessionId, controlId, inputHash)` — never on the model's word.
 *      Consumed at the moment of the match, before the handler runs, so two concurrent
 *      calls cannot both spend one click.
 *   4. **A woken turn skips the window entirely** (SA-113 F-SEC-1, kept). An approval the
 *      user gave in chat at 9:00 must not unlock a woken turn at 9:03, and an unreadable
 *      session answers "woken" — the safe direction.
 *   5. **A click-seeded scoped window** runs it. Today that is only
 *      `sys.voice.engine.complete_local_setup` per `engineId`, so a failed setup retried
 *      within five minutes does not ask twice. It is seeded ONLY by `decideApproval` — the
 *      blanket per-control window and the chat-text sniffer that used to seed it are gone.
 *   6. **Otherwise: pause.** A pending record is created and the caller returns
 *      `CONTROL_RISK_REQUIRES_APPROVAL` carrying the block the card is built from.
 *
 * ## Why the consume is serialized in-process rather than in Lua
 *
 * The same answer `dmStore.ts` gives for its claim (AMD-113-04): MULTI without WATCH is a
 * batch, not a compare-and-set, and a Lua script cannot run under the in-memory Redis fake
 * the default test lane uses — which would leave the single most important rule in this
 * file untested. Every Batshit request runs in ONE SvelteKit process, so a per-approval
 * async mutex is exactly as strong here, the same posture `wakeRunRegistry`,
 * `workerTurnBudget`, and the in-process rate limiter already take. If Batshit ever runs
 * more than one app process, this is one of the places that must move to a Redis primitive.
 */

import { createHash, randomBytes } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { getActiveStream } from '$lib/server/services/streamAbortRegistry'
import { resolveWokenTurnState } from '$lib/server/services/dm/wokenTurn'

/* ------------------------------------------------------------------ *
 * Keys (DL-116-02)
 * ------------------------------------------------------------------ */

/**
 * Two families, and every place each one must be registered — the `dmKeys.ts` /
 * `scheduleKeys.ts` checklist, answered for this store:
 *
 *   1. `redis.deleteSession` — an approval is SESSION-scoped, unlike a DM or a schedule,
 *      so `deleteSession` owes it a sweep (`sweepSessionApprovals`) and `deleteAgent` owes
 *      it nothing. The Session Key Cleanup rule is enumerate-don't-assume: the 24-hour
 *      EXPIRE is not an excuse, because a key that expires "soon" still outlives its
 *      session until it does.
 *   2. the backup — **excluded on purpose**. An approval is transient consent for one call
 *      in one chat; restoring a fortnight-old "approved" record into a fresh instance would
 *      be a click nobody made. Registered in `isDefinitelyRuntimeOnlyKey`
 *      (`backupRestoreService.ts`) beside `tool_approval:`, so the exclusion is a fact a
 *      test can read rather than an accident of which patterns happen to be collected.
 *   3. this file.
 */
export const CONTROL_APPROVAL_KEY_PREFIX = 'control_approval:'
export const CONTROL_APPROVALS_INDEX_PREFIX = 'control_approvals:'

/** The scoped window kept by DL-116-04, seeded only by `decideApproval`. */
const CONTROL_RISK_WINDOW_KEY_PREFIX = 'control_risk_approval:'

/**
 * An approval id is `apr_` plus base64url, and NOTHING else may be turned into a key.
 *
 * The id is attacker-adjacent text: it arrives in a request body, and the managed CLI
 * resume names it back to the server. Without this guard, every one of those strings became
 * a Redis key — so the rule is that a malformed id answers "no such approval" WITHOUT
 * touching Redis at all, which the tests assert directly by watching for a key read.
 *
 * What that buys, plainly: no control character, wildcard, or unbounded string ever reaches
 * a key name or a log line built from one; a typo is a clean `null` instead of a Redis error
 * escaping as a 500; and an id is recognisable on sight in a log or a `KEYS` dump.
 *
 * It is NOT protecting against the two key spaces colliding. That was worth checking rather
 * than assuming, and they cannot: for `control_approval:{X}` to equal
 * `control_approvals:{Y}` you would need `:{X}` to equal `s:{Y}`, and those differ in their
 * first character. (`schedule:` / `schedules:` and `wake_hook:` / `wake_hooks:` are the same
 * shape and are equally safe, and their headers say so; the guards there are still worth
 * having for the reasons above.)
 */
const APPROVAL_ID_PATTERN = /^apr_[A-Za-z0-9_-]{1,64}$/

const APPROVAL_ID_BYTES = 12

export function isWellFormedApprovalId(approvalId: unknown): approvalId is string {
  return typeof approvalId === 'string' && APPROVAL_ID_PATTERN.test(approvalId)
}

/** The record itself (RedisJSON). */
export function controlApprovalKey(approvalId: string): string {
  return `${CONTROL_APPROVAL_KEY_PREFIX}${approvalId}`
}

/** ZSET of this session's approval ids, scored by `requestedAt`, so the sweep can find them. */
export function controlApprovalsIndexKey(sessionId: string): string {
  return `${CONTROL_APPROVALS_INDEX_PREFIX}${sessionId}`
}

function scopedRiskWindowKey(options: {
  userId: string
  controlId: string
  agentId?: string | null
  scopeKey: string
}): string {
  const agentScope = trimmed(options.agentId) || 'no-agent'
  return `${CONTROL_RISK_WINDOW_KEY_PREFIX}${options.userId}:${agentScope}:${options.controlId}:${encodeURIComponent(options.scopeKey)}`
}

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * Structurally identical to `fabricRegistry.ts`'s `ControlRiskLevel`, spelled out here
 * rather than imported so this module has no edge back into the file that imports it.
 */
export type ControlApprovalRiskLevel = 'safe' | 'confirm' | 'restricted'

/**
 * Which surface raised the card. A presentation and diagnostics label — which card style,
 * which resume shape — and never a security input: nothing in `decideRiskGate` branches on
 * it. It is derived from what the server can observe, never declared by the caller.
 */
export type ControlApprovalLane = 'api' | 'cli' | 'service'

export type ControlApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'consumed'

export interface ControlApprovalRecord {
  id: string
  userId: string
  agentId: string | null
  sessionId: string | null
  messageId: string | null
  controlId: string
  controlTitle: string
  riskLevel: ControlApprovalRiskLevel
  /** sha256 of the canonical JSON of the input — see `hashControlInput`. */
  inputHash: string
  /** Keys plus short string values, capped — what the card shows behind its disclosure. */
  inputSummary: Record<string, any>
  lane: ControlApprovalLane
  status: ControlApprovalStatus
  /**
   * The scoped window this approval seeds when it is approved, or `null`. Stored on the
   * record so `decideApproval` can seed it without re-resolving the scope (the resolver
   * lives beside the control definitions, in `fabricRegistry.ts`).
   */
  scopeKey: string | null
  /**
   * SA-116 F-P1-4 — the AI SDK's own approval id for this pause, and the call it belongs
   * to. `null` on lanes that have neither (a managed CLI refusal, a service-lane call).
   *
   * The SDK mints ids like `aitxt-…`, which `APPROVAL_ID_PATTERN` rightly rejects — an
   * approval record id is ours, generated here, and nothing a model or a browser sends can
   * become one. So the API lane keeps BOTH: the record's own `apr_…` id, and the SDK id the
   * card entry and the resume response are keyed on. The mapping is server state.
   *
   * The click is resolved from that mapping by re-reading the PERSISTED assistant message,
   * never from an `apr_` id posted back in `metadata`: the browser is told the SDK id, and
   * an id the browser can choose must never be able to name which consent record gets spent.
   */
  sdkApprovalId: string | null
  toolCallId: string | null
  requestedAt: string
  decidedAt?: string | null
  consumedAt?: string | null
}

/**
 * What a caller presents to spend an approval.
 *
 * Set ONLY by send-routed's resume paths — never read from model input. `kind` says which
 * resume it came from: `sdk` is the AI SDK re-executing the very call the user approved
 * (the API lane), `resume` is the follow-up turn a managed CLI agent gets (DL-116-08).
 */
export interface ControlApprovalGrant {
  kind: 'sdk' | 'resume'
  approvalId: string
  toolCallId?: string
}

/** The block the card is built from. Returned inside the pause error's `details`. */
export interface ControlApprovalRequest {
  approvalId: string
  controlId: string
  controlTitle: string
  riskLevel: ControlApprovalRiskLevel
  /**
   * SA-116 F-P2-4 — the exact payload the record's `inputHash` covers, and the bytes that
   * will run on Approve. The card shows THIS under "Exact input".
   *
   * It rides the request rather than the record on purpose: the record stays small (its
   * `inputSummary` is the 2 KB audit view), while the card entry the pause persists carries
   * the real thing, exactly as the API lane's `control.input` already does. Absent only
   * when the input is not a plain object, which the card handles by falling back to the
   * summary and saying so.
   */
  input?: Record<string, any>
  inputSummary: Record<string, any>
  lane: ControlApprovalLane
  requestedAt: string
  toolCallId?: string
}

/** What the audit entry records about how a risky control came to run (DL-116-12). */
export interface ControlApprovalAudit {
  approvalId: string | null
  kind: 'sdk' | 'resume' | 'scoped-window' | 'portable-skill-scope'
  decidedAt: string | null
}

export type RiskGateDecision =
  | { kind: 'run'; approval: ControlApprovalAudit | null }
  | { kind: 'refuse-group'; message: string }
  | { kind: 'pause'; request: ControlApprovalRequest; wokenDmId: string | null }

/** The one wording for a risky control asked for inside a group chat (DL-116-10). */
export const GROUP_RISK_REFUSAL_MESSAGE =
  'Risky controls are not available in group chats. Ask the user in a direct chat with this agent.'

/* ------------------------------------------------------------------ *
 * Where a card may be pinned (DL-116-07)
 * ------------------------------------------------------------------ */

/**
 * Turn a caller's claimed `sessionId` / `messageId` into the pair a card may be pinned to.
 *
 * Both arrive as request-body text on the managed CLI lane — the mode4 helper forwards
 * `BATSHIT_SESSION_ID` and `BATSHIT_MESSAGE_ID` — so neither may be trusted on its word:
 *
 *  - a session this user does not own is DROPPED, so a caller cannot speak for somebody
 *    else's chat and, with no session, the woken-turn gate falls back to the server-owned
 *    wake registry rather than to a chat a stranger is sitting in;
 *  - a message id is only kept when it really is a message inside that owned session (one
 *    `EXISTS`), so a caller cannot pin its card onto any message it likes.
 *
 * Two routes need exactly this — `/api/controls/use` for Fabric and artifact refs, and
 * `/api/cli-tools/execute` for `cli:` refs — and DL-116-14's whole point is that the same
 * hole must not exist twice in two files with two spellings.
 */
export async function resolveApprovalCardTarget(options: {
  userId: string
  sessionId?: unknown
  messageId?: unknown
}): Promise<{ sessionId?: string; messageId?: string }> {
  const claimedSessionId = trimmed(options.sessionId)
  if (!claimedSessionId) return {}

  let sessionId: string | undefined
  try {
    const session = await redis.getSession(claimedSessionId)
    if (session && session.user_id === options.userId) sessionId = claimedSessionId
  } catch (error) {
    console.warn('[ControlApprovals] Could not read the session for an approval card:', error)
    return {}
  }
  if (!sessionId) return {}

  const claimedMessageId = trimmed(options.messageId)
  if (!claimedMessageId) return { sessionId }

  // The message may not EXIST yet, and on the managed CLI lane it usually does not.
  //
  // The helper calls this from inside the very turn the card belongs to, and an assistant
  // message is written when its turn finishes — so `EXISTS message:{session}:{id}` is 0 for
  // exactly the id the card must land on. (Measured on BSMS: the record came back
  // `lane: 'service'` with no message id, and the route logged its own "no card can render"
  // warning, while the helper's env showed the right id arriving.)
  //
  // `getActiveStream` is the server's own note of which assistant message this session's
  // running turn is writing — set by `handleBatshitAgentStream` from the id it generated,
  // never from request text. Matching it is therefore as strong as a persisted message and
  // no more forgeable: the session is already proven to be this user's.
  try {
    const activeStream = getActiveStream(sessionId)
    if (activeStream?.messageId && activeStream.messageId === claimedMessageId) {
      return { sessionId, messageId: claimedMessageId }
    }
  } catch (error) {
    console.warn('[ControlApprovals] Could not read the active turn for an approval card:', error)
  }

  try {
    const exists = await redis.execute(async (client) =>
      client.exists(`message:${sessionId}:${claimedMessageId}`)
    )
    if (exists === 1) return { sessionId, messageId: claimedMessageId }
  } catch (error) {
    console.warn('[ControlApprovals] Could not verify the message for an approval card:', error)
  }

  return { sessionId }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nowIso(): string {
  return new Date().toISOString()
}

function generateApprovalId(): string {
  return `apr_${randomBytes(APPROVAL_ID_BYTES).toString('base64url')}`
}

/**
 * Stable JSON: object keys sorted, recursively, arrays left in order.
 *
 * The hash answers "is this the same call the user approved?", and `{b, a}` and `{a, b}`
 * ARE the same call — a model that re-emits its own arguments in a different order has not
 * asked for anything new. `JSON.stringify` alone preserves insertion order, so hashing it
 * directly would re-card an identical retry and look, from the outside, exactly like the
 * payload-mismatch protection working.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
  return `{${entries.join(',')}}`
}

/** sha256 of the canonical JSON of a control's input (DL-116-02). */
export function hashControlInput(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input ?? {})).digest('hex')
}

const INPUT_SUMMARY_MAX_BYTES = 2048
const INPUT_SUMMARY_VALUE_MAX_CHARS = 240

/**
 * Keys plus short values, capped at 2 KB (DL-116-02).
 *
 * The card shows this, so it has to be readable AND bounded: a control's input can carry a
 * whole HTML document (`sys.artifact.update`) or a base64 blob, and a record that big would
 * be persisted on the message, re-read on every card render, and shipped in a 403 body.
 * Long values are truncated with their real length, never dropped silently.
 */
export function summarizeControlInput(input: unknown): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const summary: Record<string, any> = {}
  let bytes = 0
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) continue
    let rendered: any
    if (typeof value === 'string') {
      rendered =
        value.length > INPUT_SUMMARY_VALUE_MAX_CHARS
          ? `${value.slice(0, INPUT_SUMMARY_VALUE_MAX_CHARS)}… (${value.length} characters)`
          : value
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      rendered = value
    } else if (Array.isArray(value)) {
      rendered = `[${value.length} item${value.length === 1 ? '' : 's'}]`
    } else {
      rendered = `{${Object.keys(value as Record<string, unknown>).sort().join(', ')}}`
    }
    const entryBytes = key.length + JSON.stringify(rendered ?? null).length + 4
    if (bytes + entryBytes > INPUT_SUMMARY_MAX_BYTES) {
      summary['…'] = 'more fields not shown'
      break
    }
    summary[key] = rendered
    bytes += entryBytes
  }
  return summary
}

/* ------------------------------------------------------------------ *
 * The record store (DL-116-02)
 * ------------------------------------------------------------------ */

export const CONTROL_APPROVAL_TTL_SECONDS = 60 * 60 * 24

export async function getControlApproval(
  approvalId: unknown
): Promise<ControlApprovalRecord | null> {
  const normalized = trimmed(approvalId)
  // A malformed id is "no such approval", never a key read: see `APPROVAL_ID_PATTERN`.
  if (!isWellFormedApprovalId(normalized)) return null
  const record = (await redis.json.get(controlApprovalKey(normalized))) as
    | ControlApprovalRecord
    | null
  return record && typeof record === 'object' ? record : null
}

/**
 * Create the pending record a card is built from.
 *
 * `approvalId` may be supplied so ONE id can be created once and referred to by both the
 * lane that raised it and the lane that persists the entry (AMD-116-01: the SDK re-asks the
 * per-tool policy on the approval resume, so anything that wrote from the policy would
 * write twice for one call). Creating with an id that already exists returns the existing
 * record untouched, which is what makes "once per approval id" a property of this function
 * rather than a rule every caller has to remember.
 */
export async function createPendingApproval(options: {
  approvalId?: string
  userId: string
  agentId?: string | null
  sessionId?: string | null
  messageId?: string | null
  controlId: string
  controlTitle: string
  riskLevel: ControlApprovalRiskLevel
  lane: ControlApprovalLane
  input: unknown
  scopeKey?: string | null
  sdkApprovalId?: string | null
  toolCallId?: string | null
  now?: Date
}): Promise<ControlApprovalRecord> {
  const supplied = trimmed(options.approvalId)
  if (!supplied) return await writePendingApproval(options, generateApprovalId())
  if (!isWellFormedApprovalId(supplied)) {
    throw new Error(`[ControlApprovals] Refusing to create a record for a malformed id.`)
  }
  /**
   * SA-116 F-P1-4 — the supplied-id create runs under the per-approval lock.
   *
   * P2's API lane reaches this path TWICE for one call: the stream loop records the
   * approval request, and the finish path persists `metadata.toolApprovals` from either
   * `extractToolApprovalRequests` or the streamed map. Read-then-create without the lock is
   * a compare-and-set with a gap in the middle — two concurrent creates would both see no
   * record and both write, and the second root write would reset the first one's clock and
   * its `pending` status even if a click had already landed between them.
   */
  return await withApprovalLock(supplied, async () => {
    const existing = await getControlApproval(supplied)
    if (existing) return existing
    return await writePendingApproval(options, supplied)
  })
}

async function writePendingApproval(
  options: {
    userId: string
    agentId?: string | null
    sessionId?: string | null
    messageId?: string | null
    controlId: string
    controlTitle: string
    riskLevel: ControlApprovalRiskLevel
    lane: ControlApprovalLane
    input: unknown
    scopeKey?: string | null
    sdkApprovalId?: string | null
    toolCallId?: string | null
    now?: Date
  },
  id: string
): Promise<ControlApprovalRecord> {
  const requestedAt = (options.now ?? new Date()).toISOString()
  const record: ControlApprovalRecord = {
    id,
    userId: options.userId,
    agentId: trimmed(options.agentId) || null,
    sessionId: trimmed(options.sessionId) || null,
    messageId: trimmed(options.messageId) || null,
    controlId: options.controlId,
    controlTitle: options.controlTitle,
    riskLevel: options.riskLevel,
    inputHash: hashControlInput(options.input),
    inputSummary: summarizeControlInput(options.input),
    lane: options.lane,
    status: 'pending',
    scopeKey: trimmed(options.scopeKey) || null,
    sdkApprovalId: trimmed(options.sdkApprovalId) || null,
    toolCallId: trimmed(options.toolCallId) || null,
    requestedAt,
    decidedAt: null,
    consumedAt: null
  }

  const key = controlApprovalKey(record.id)
  await redis.json.set(key, '$', record as never)
  await redis.expire(key, CONTROL_APPROVAL_TTL_SECONDS)
  if (record.sessionId) {
    const indexKey = controlApprovalsIndexKey(record.sessionId)
    await redis.execute(async (client) =>
      client.zAdd(indexKey, [{ score: Date.parse(requestedAt), value: record.id }])
    )
    await redis.expire(indexKey, CONTROL_APPROVAL_TTL_SECONDS)
  }
  return record
}

/**
 * Build the block the card is built from, without touching Redis.
 *
 * Separate from the record so a caller that already holds one can hand the same shape to
 * its 403 body and to send-routed's `streamedApprovalRequests` without re-reading.
 */
export function toApprovalRequest(
  record: ControlApprovalRecord,
  toolCallId?: string | null,
  input?: unknown
): ControlApprovalRequest {
  return {
    approvalId: record.id,
    controlId: record.controlId,
    controlTitle: record.controlTitle,
    riskLevel: record.riskLevel,
    // F-P2-4: only a plain object, because that is what the card iterates and what the
    // hash was taken over. Anything else leaves the field absent and the card shows the
    // summary labelled as one, rather than a value dressed up as exact.
    ...(input && typeof input === 'object' && !Array.isArray(input)
      ? { input: input as Record<string, any> }
      : {}),
    inputSummary: record.inputSummary,
    lane: record.lane,
    requestedAt: record.requestedAt,
    ...(trimmed(toolCallId) || record.toolCallId
      ? { toolCallId: trimmed(toolCallId) || (record.toolCallId as string) }
      : {})
  }
}

/* ------------------------------------------------------------------ *
 * Path-scoped writes — everything after create
 * ------------------------------------------------------------------ */

/**
 * Is this the RedisJSON reply that means "the record this path belongs to is gone"?
 *
 * Copied from `scheduleStore.ts` (SA-115 F-P1-4b), including its Redis 8 note: the quoted
 * path fragment is deliberately NOT matched, because ReJSON's missing-path text changed
 * from `ERR Path '.x' does not exist` to `ERR Path does not exist` between versions.
 */
function isMissingRecordError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return (
    /new objects must be created at the root/i.test(text) ||
    /could not perform this operation on a key that doesn'?t exist/i.test(text) ||
    /path .*does not exist/i.test(text)
  )
}

/**
 * Write named fields onto an EXISTING approval, never the whole record.
 *
 * `JSON.SET key $ record` CREATES a missing key, so a root write racing the 24-hour expiry
 * or a `deleteSession` sweep would resurrect a consent record with its clock reset — the
 * exact shape of SA-115 F-P3-2 and SA-113's wake-hook rotate bug. A path write cannot
 * create the root, so a swept approval is a no-op instead of a zombie that can still unlock
 * a risky control.
 */
async function patchApprovalFields(
  approvalId: string,
  fields: Record<string, unknown>
): Promise<boolean> {
  if (!isWellFormedApprovalId(approvalId)) return false
  const key = controlApprovalKey(approvalId)
  try {
    for (const [field, value] of Object.entries(fields)) {
      await redis.json.set(key, `$.${field}`, value as never)
    }
    return true
  } catch (error) {
    if (isMissingRecordError(error)) return false
    // Anything else is a real failure and must say so. Fail loudly, never silently drift.
    console.error(`[ControlApprovals] Could not write to approval ${approvalId}:`, error)
    throw error
  }
}

const approvalLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize every read-then-write on ONE approval id (see the module header).
 *
 * Not re-entrant, and it does not need to be: nothing inside a locked operation calls
 * another locked operation. `withInboxLock`'s header in `dmStore.ts` is the warning to
 * re-read before adding anything that does.
 */
async function withApprovalLock<T>(approvalId: string, operation: () => Promise<T>): Promise<T> {
  const previous = approvalLocks.get(approvalId) ?? Promise.resolve()
  const run = previous.then(() => operation())
  // The stored tail never rejects, so one failed consume cannot poison the queue behind it.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  approvalLocks.set(approvalId, tail)
  try {
    return await run
  } finally {
    if (approvalLocks.get(approvalId) === tail) approvalLocks.delete(approvalId)
  }
}

/**
 * The Approve or Deny click. The ONLY thing that turns a pending record into an approved
 * one, and the only thing that seeds a scoped window (DL-116-04).
 *
 * `userId` is checked against the record: the click arrives on a cookie-authenticated
 * route, and one user's session must never be able to decide another's approval.
 */
export async function decideApproval(options: {
  userId: string
  approvalId: unknown
  approved: boolean
  now?: Date
}): Promise<ControlApprovalRecord | null> {
  const approvalId = trimmed(options.approvalId)
  if (!isWellFormedApprovalId(approvalId)) return null

  return await withApprovalLock(approvalId, async () => {
    const record = await getControlApproval(approvalId)
    if (!record || record.userId !== options.userId) return null
    // A decided or spent approval keeps its answer. Re-deciding would let a second click
    // (or a replayed POST) turn a denial into an approval.
    if (record.status !== 'pending') return record

    const decidedAt = (options.now ?? new Date()).toISOString()
    const status: ControlApprovalStatus = options.approved ? 'approved' : 'denied'
    const written = await patchApprovalFields(approvalId, { status, decidedAt })
    if (!written) return null

    if (options.approved && record.scopeKey) {
      // The one window DL-116-04 keeps: an approved voice-engine setup lets a retry for
      // that same engine within five minutes skip the card. Seeded here and nowhere else.
      await recordScopedRiskWindow({
        userId: record.userId,
        controlId: record.controlId,
        agentId: record.agentId,
        scopeKey: record.scopeKey
      })
    }

    return { ...record, status, decidedAt }
  })
}

/** Mark a pending approval expired — send-routed's stale sweep, and nothing else. */
export async function markApprovalExpired(approvalId: unknown): Promise<boolean> {
  const id = trimmed(approvalId)
  if (!isWellFormedApprovalId(id)) return false
  return await withApprovalLock(id, async () => {
    const record = await getControlApproval(id)
    if (!record || record.status !== 'pending') return false
    return await patchApprovalFields(id, { status: 'expired', decidedAt: nowIso() })
  })
}

/**
 * The ONE read of `control_approvals:{sessionId}` — oldest first, as the ZSET stores it.
 *
 * `findApprovedMatch`, `listSessionApprovals` and `sweepSessionApprovals` had three copies
 * of this line. They are kept together because the index's ordering and the fact that it is
 * scored by `requestedAt` are facts three callers reason about, and a fourth caller
 * spelling it a fourth way is how the self-heal below would get missed.
 *
 * **Newest-first is still JS `.reverse()`** and not the server's `{ REV: true }` (PR #106
 * review F-18 suggested the option). The Vitest Redis fake's `zRange` takes
 * `(key, start, stop)` with no options argument, and `redisPrimitiveConformance.test.ts`
 * does not cover the option either — so passing it would work against real Redis and be
 * silently ignored by the fake, which is the exact shape of bug the conformance suite
 * exists to catch. Teaching the fake a new primitive is its own change.
 */
async function readApprovalIndexIds(sessionId: string): Promise<string[]> {
  const ids = await redis.execute(async (client) =>
    client.zRange(controlApprovalsIndexKey(sessionId), 0, -1)
  )
  return Array.isArray(ids) ? (ids as string[]) : []
}

/**
 * Drop one id from a session's index. Self-heal only — never a way to revoke an approval.
 */
async function forgetApprovalIndexMember(sessionId: string, approvalId: string): Promise<void> {
  await redis.execute(async (client) =>
    client.zRem(controlApprovalsIndexKey(sessionId), approvalId)
  )
}

/**
 * Find the approved record that unlocks THIS call, if one exists.
 *
 * Matched on every field that makes a call the same call, so "the user approved deleting
 * memory X" can never unlock "delete memory Y", and a retry with different input bytes
 * finds nothing and earns a new card (DL-116-08).
 *
 * **It prunes as it goes** (PR #106 review F-18). Records carry a 24-hour TTL; their ids
 * were never removed from the index, and the index's own TTL is refreshed by every write —
 * so in a busy session dead ids accumulated and this function, which runs on EVERY non-safe
 * control call, paid one `JSON.GET` per historical id, nearly all of them null. An id whose
 * record is gone is removed from the index the first time it is met, which is what
 * `listSchedules` and `listAgentRunCredentialIds` already do.
 *
 * The prune is deliberately NOT `zRemRangeByScore(0, now − 24 h)`: the score is
 * `Date.parse(requestedAt)`, but a DECISION rewrites the record and refreshes its TTL, so a
 * record approved late in its window outlives its score by up to another 24 hours. Pruning
 * by score could drop a LIVE approval from the index, and the retry that should have spent
 * it would raise a second card at the user instead.
 */
export async function findApprovedMatch(criteria: {
  userId: string
  agentId?: string | null
  sessionId?: string | null
  controlId: string
  inputHash: string
}): Promise<ControlApprovalRecord | null> {
  const sessionId = trimmed(criteria.sessionId)
  if (!sessionId) return null
  const ids = await readApprovalIndexIds(sessionId)
  // Newest first: an agent that re-asked for the same call twice should spend the click the
  // user most recently made.
  for (const id of [...ids].reverse()) {
    const record = await getControlApproval(id)
    if (!record) {
      await forgetApprovalIndexMember(sessionId, id)
      continue
    }
    if (matchesApproval(record, criteria)) return record
  }
  return null
}

function matchesApproval(
  record: ControlApprovalRecord,
  criteria: {
    userId: string
    agentId?: string | null
    sessionId?: string | null
    controlId: string
    inputHash: string
  }
): boolean {
  return (
    record.status === 'approved' &&
    record.userId === criteria.userId &&
    (record.agentId ?? null) === (trimmed(criteria.agentId) || null) &&
    (record.sessionId ?? null) === (trimmed(criteria.sessionId) || null) &&
    record.controlId === criteria.controlId &&
    record.inputHash === criteria.inputHash
  )
}

/**
 * Spend an approval. Returns the record only if THIS call was the one that spent it.
 *
 * The status flips before the control runs, on purpose: a consume-after-success would let
 * two concurrent calls both match the same approved record and both run. The cost is that a
 * control which fails needs a second click, which is the safe direction for a gate whose
 * whole job is "exactly the call the user agreed to, exactly once".
 */
export async function consumeApproval(approvalId: string): Promise<ControlApprovalRecord | null> {
  if (!isWellFormedApprovalId(approvalId)) return null
  return await withApprovalLock(approvalId, async () => {
    const record = await getControlApproval(approvalId)
    if (!record || record.status !== 'approved') return null
    const consumedAt = nowIso()
    const written = await patchApprovalFields(approvalId, { status: 'consumed', consumedAt })
    if (!written) return null
    return { ...record, status: 'consumed' as const, consumedAt }
  })
}

/**
 * Every approval raised in one chat, newest first, for the Execution Viewer (DL-116-12).
 *
 * Summary only — id, control, risk, status, timings. Never `inputSummary`: the card already
 * showed the input at the moment it mattered, and a read-only history panel does not need
 * to re-serve a payload that can carry a URL, a path, or a prompt.
 *
 * `userId` is checked per record rather than trusted from the session, because the index is
 * keyed on the session alone.
 */
export interface SessionApprovalSummary {
  approvalId: string
  controlId: string
  controlTitle: string
  riskLevel: ControlApprovalRiskLevel
  status: ControlApprovalStatus
  lane: ControlApprovalLane
  messageId: string | null
  requestedAt: string
  decidedAt: string | null
  consumedAt: string | null
}

export async function listSessionApprovals(
  sessionId: string,
  userId: string
): Promise<SessionApprovalSummary[]> {
  const id = trimmed(sessionId)
  if (!id) return []
  const ids = await readApprovalIndexIds(id)
  const summaries: SessionApprovalSummary[] = []
  for (const approvalId of ids) {
    const record = await getControlApproval(approvalId)
    if (!record || record.userId !== userId) continue
    summaries.push({
      approvalId: record.id,
      controlId: record.controlId,
      controlTitle: record.controlTitle,
      riskLevel: record.riskLevel,
      status: record.status,
      lane: record.lane,
      messageId: record.messageId ?? null,
      requestedAt: record.requestedAt,
      decidedAt: record.decidedAt ?? null,
      consumedAt: record.consumedAt ?? null
    })
  }
  return summaries.reverse()
}

/**
 * Delete every approval raised in a session, plus its index (DL-116-15).
 *
 * Called from `redis.deleteSession`. The records carry a 24-hour EXPIRE, which is NOT a
 * reason to skip this: AMD-111-02 found `n8n:sse-callback:` unenumerated on exactly that
 * reasoning, and a consent record that expires "soon" still outlives its chat until it does.
 */
export async function sweepSessionApprovals(sessionId: string): Promise<number> {
  const id = trimmed(sessionId)
  if (!id) return 0
  const ids = await readApprovalIndexIds(id)
  let deleted = 0
  for (const approvalId of ids) {
    if (!isWellFormedApprovalId(approvalId)) continue
    await redis.del(controlApprovalKey(approvalId))
    deleted += 1
  }
  await redis.del(controlApprovalsIndexKey(id))
  return deleted
}

/* ------------------------------------------------------------------ *
 * The scoped window (DL-116-04) — the one cache that survives
 * ------------------------------------------------------------------ */

const SCOPED_RISK_WINDOW_TTL_SECONDS = 60 * 5

export async function hasScopedRiskWindow(options: {
  userId: string
  controlId: string
  agentId?: string | null
  scopeKey: string
}): Promise<boolean> {
  try {
    return await redis.execute(async (client) => {
      const marker = await client.get(scopedRiskWindowKey(options))
      return typeof marker === 'string' && marker.trim().length > 0
    })
  } catch (error) {
    // A window that cannot be read is a window that is not there: the caller pauses and
    // asks. Failing open here would be the whole hole again, one Redis blip wide.
    console.warn('[ControlApprovals] Could not read the scoped risk window:', error)
    return false
  }
}

async function recordScopedRiskWindow(options: {
  userId: string
  controlId: string
  agentId?: string | null
  scopeKey: string
}): Promise<void> {
  try {
    await redis.execute(async (client) => {
      await client.set(scopedRiskWindowKey(options), nowIso(), {
        EX: SCOPED_RISK_WINDOW_TTL_SECONDS
      })
    })
  } catch (error) {
    console.warn('[ControlApprovals] Could not seed the scoped risk window:', error)
  }
}

/* ------------------------------------------------------------------ *
 * The gate (DL-116-03)
 * ------------------------------------------------------------------ */

/**
 * Is this chat a group chat? `null` means the session could not be read.
 *
 * An unreadable session deliberately does NOT become a group refusal. Both answers stop the
 * control, so neither is "less safe" — but "Risky controls are not available in group chats"
 * would be a sentence the server cannot stand behind, told to a user sitting in a direct
 * chat during a Redis blip, with no way to recover. The pause is the honest refusal: its
 * wording is true either way and a click fixes it. An outage stops the control anyway,
 * because the woken check below reads the same Redis and fails closed to "woken", which
 * skips the window and pauses.
 */
async function readSessionIsGroup(sessionId: string): Promise<boolean | null> {
  try {
    const session = (await redis.getSession(sessionId)) as Record<string, any> | null
    const metadata = (session?.metadata ?? {}) as Record<string, any>
    return Boolean(metadata.group_chat?.group_id)
  } catch (error) {
    console.warn('[ControlApprovals] Could not read the session to tell a group from a direct chat:', error)
    return null
  }
}

/**
 * THE risk decision. See the module header for the order and why each step is where it is.
 *
 * Called only for a control whose `riskLevel !== 'safe'`. A safe control never reaches here
 * and never pauses.
 */
export async function decideRiskGate(options: {
  userId: string
  agentId?: string | null
  sessionId?: string | null
  messageId?: string | null
  controlId: string
  controlTitle: string
  riskLevel: ControlApprovalRiskLevel
  lane: ControlApprovalLane
  input: unknown
  scopeKey?: string | null
  grant?: ControlApprovalGrant | null
  /** True only for a Portable Skill Token call — the token's family scope IS the consent. */
  portableSkillScope?: boolean
  toolCallId?: string | null
  now?: Date
}): Promise<RiskGateDecision> {
  // (0) SA-113 F-SEC-1, read FIRST (PR #106 review, F-2). A woken turn is driven by a DM
  // body or a webhook payload — untrusted text — so nothing below may exempt it from the
  // card, not even a Portable Skill Token. `resolveWokenTurnState` owns the fail-closed rule
  // (an unreadable session answers "woken"); it is read once, here, for steps (1) and (5).
  const wokenTurn = await resolveWokenTurnState(options.sessionId, {
    userId: options.userId,
    agentId: options.agentId
  })

  // (1) DL-116-09 — the token's scope is the consent; there is no chat to click in. A woken
  // turn holding the token gets NO such exemption (F-2): it falls through to the pause like
  // every other woken turn, which is what `main` refused outright before SA-116.
  if (options.portableSkillScope === true && !wokenTurn.woken) {
    return {
      kind: 'run',
      approval: {
        approvalId: null,
        kind: 'portable-skill-scope',
        decidedAt: (options.now ?? new Date()).toISOString()
      }
    }
  }

  const sessionId = trimmed(options.sessionId)

  // (2) DL-116-10 — a card raised in a group turn would be abandoned by the next speaker.
  if (sessionId && (await readSessionIsGroup(sessionId)) === true) {
    return { kind: 'refuse-group', message: GROUP_RISK_REFUSAL_MESSAGE }
  }

  const inputHash = hashControlInput(options.input ?? {})
  const criteria = {
    userId: options.userId,
    agentId: options.agentId,
    sessionId: options.sessionId,
    controlId: options.controlId,
    inputHash
  }

  // (3) A server-owned approval a human clicked. The explicit grant is send-routed's SDK
  // resume naming the exact record; the implicit lookup is the managed CLI agent's retry
  // after its resume turn, which knows the ref and the input but not the id (DL-116-08).
  let matched: ControlApprovalRecord | null = null
  const grantId = trimmed(options.grant?.approvalId)
  if (grantId) {
    const record = await getControlApproval(grantId)
    if (record && matchesApproval(record, criteria)) matched = record
  }
  if (!matched) matched = await findApprovedMatch(criteria)

  if (matched) {
    const spent = await consumeApproval(matched.id)
    if (spent) {
      return {
        kind: 'run',
        approval: {
          approvalId: spent.id,
          kind: options.grant?.kind ?? 'resume',
          decidedAt: spent.decidedAt ?? null
        }
      }
    }
    // Somebody else spent it between the match and the consume. Falling through to the
    // pause is correct: the click was real but it is gone, so ask for another one rather
    // than running a call nobody has an unspent approval for.
  }

  // (4) SA-113 F-SEC-1, kept — a woken turn never rides a window. The read happened at (0).

  // (5) The one window DL-116-04 keeps, seeded only by a click.
  const scopeKey = trimmed(options.scopeKey)
  if (!wokenTurn.woken && scopeKey) {
    const covered = await hasScopedRiskWindow({
      userId: options.userId,
      controlId: options.controlId,
      agentId: options.agentId,
      scopeKey
    })
    if (covered) return { kind: 'run', approval: { approvalId: null, kind: 'scoped-window', decidedAt: null } }
  }

  // (6) Pause. Nothing is cancelled: the record waits 24 hours for a click.
  const record = await createPendingApproval({
    userId: options.userId,
    agentId: options.agentId,
    sessionId: options.sessionId,
    messageId: options.messageId,
    controlId: options.controlId,
    controlTitle: options.controlTitle,
    riskLevel: options.riskLevel,
    lane: options.lane,
    input: options.input ?? {},
    scopeKey: scopeKey || null,
    toolCallId: options.toolCallId ?? null,
    now: options.now
  })

  const wokenDmId = wokenTurn.woken ? wokenTurn.dmId : null
  if (wokenDmId) {
    // F-SEC-1b, kept: tell the user their woken chat is parked on them. Nothing here can
    // fail the pause — a missing stamp is a quieter badge, not a weaker gate. Dynamic
    // import so this leaf module keeps no edge into the DM store.
    try {
      const { stampDmNeedsUser } = await import('$lib/server/services/dm/dmStore')
      await stampDmNeedsUser(
        wokenDmId,
        `This chat is waiting for you to approve ${record.controlTitle}.`
      )
    } catch (error) {
      console.warn('[ControlApprovals] Could not stamp the DM as needing the user:', error)
    }
  }

  return {
    kind: 'pause',
    request: toApprovalRequest(record, options.toolCallId, options.input ?? {}),
    wokenDmId
  }
}
