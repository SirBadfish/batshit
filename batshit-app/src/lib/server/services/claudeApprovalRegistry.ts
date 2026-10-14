/**
 * BL-496 — the in-process record of Claude approval cards.
 *
 * A managed Claude run asks for an approval through the permission helper
 * (`scripts/claude-permission-mcp.cjs`). The helper publishes the card on the chat's Redis
 * channel and then BLOCKS inside the running turn until the answer comes or its wait ends.
 * So a Claude approval lives exactly as long as its run, and the run lives in this process:
 * the card is kept here, beside the run, the way the steer inbox and the wake run registry
 * keep theirs. No Redis key is added, so there is no delete sweep and no backup rule. A
 * restart ends every run, and every card with it, which is honest rather than a leak.
 *
 * What reads it:
 *   - `/api/sse` puts a card into the chat's replay, so a tab that opens or reloads during
 *     the wait gets it (A2), and adds the run's final summary to the reply's `end` (A1);
 *   - `hasPendingToolApproval` answers `waiting_approval` during the wait, watched or not (A3);
 *   - the answer route claims a live card before it writes the answer, and refuses a card
 *     that is not waiting (A7);
 *   - the woken-turn stamp remembers whether THIS card set the DM's "needs you" mark, so only
 *     that mark is taken back when the card ends (A4).
 *
 * Leaf on purpose, like `wakeRunRegistry.ts`: it imports nothing, so `/api/sse`, the answer
 * route, the bridge and the DM readers can all depend on it without importing each other.
 */

export type ClaudeApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/**
 * Why a card ended without an answer. `unanswered`: the helper's wait ran out (A6).
 * `run_ended`: the run itself ended (a Stop, a failure) while the card waited.
 * `wait_failed`: the helper could not read the answer (a Redis failure in its wait).
 */
export type ClaudeApprovalExpiryReason = 'unanswered' | 'run_ended' | 'wait_failed'

export interface ClaudeApprovalCardInput {
  sessionId: string
  messageId: string
  approvalId: string
  /** The tool Claude asked to run (`Bash`, `Edit`, ...), not the helper's own name. */
  toolName: string
  input: unknown
  toolUseId?: string | null
  requestedAt: string
  expiresAt: string
}

export interface ClaudeApprovalRecord extends ClaudeApprovalCardInput {
  status: ClaudeApprovalStatus
  expiryReason?: ClaudeApprovalExpiryReason
  decidedAt?: string
  /** An answer route holds this card: a second answer is refused, a failed write lets go. */
  claimed: boolean
  /** The "needs you" mark THIS card put on its woken turn's DM, if it put one. */
  wakeMark: ClaudeApprovalWakeMark | null
  /** When the run that raised the card ended; the record is kept a while for the save. */
  runEndedAt: number | null
}

export interface ClaudeApprovalWakeMark {
  dmId: string
  at: string
  /** The woken run's user, to read the chat's risky-control pauses when the card ends. */
  userId: string
}

export type ClaudeApprovalClaim =
  | { ok: true; record: ClaudeApprovalRecord }
  | { ok: false; reason: 'not_found' | 'answered' | 'ended' }

/**
 * How long a card's record stays after its run ended, so the reply's end and its save can
 * still read the final summary. The `/api/sse` end cleanup forgets it sooner; this bound is
 * for a run whose end nobody processed.
 */
export const CLAUDE_APPROVAL_RETAIN_AFTER_RUN_MS = 10 * 60 * 1000

const records = new Map<string, ClaudeApprovalRecord>()

function keyOf(sessionId: string, approvalId: string) {
  return `${sessionId}::${approvalId}`
}

function pruneEndedRuns(now: number) {
  for (const [key, record] of records) {
    if (record.runEndedAt !== null && now - record.runEndedAt > CLAUDE_APPROVAL_RETAIN_AFTER_RUN_MS) {
      records.delete(key)
    }
  }
}

function copy(record: ClaudeApprovalRecord): ClaudeApprovalRecord {
  return { ...record, wakeMark: record.wakeMark ? { ...record.wakeMark } : null }
}

/**
 * Record a card the helper published. Returns the record and whether it is new; a repeat of
 * the same card (a second delivery of the event) changes nothing.
 */
export function recordClaudeApprovalCard(
  input: ClaudeApprovalCardInput,
  now = Date.now()
): { record: ClaudeApprovalRecord; created: boolean } {
  pruneEndedRuns(now)
  const key = keyOf(input.sessionId, input.approvalId)
  const existing = records.get(key)
  if (existing) return { record: copy(existing), created: false }
  const record: ClaudeApprovalRecord = {
    ...input,
    toolUseId: input.toolUseId ?? null,
    status: 'pending',
    claimed: false,
    wakeMark: null,
    runEndedAt: null
  }
  records.set(key, record)
  return { record: copy(record), created: true }
}

/** Remember the "needs you" mark this card put on its woken DM (A4). */
export function setClaudeApprovalWakeMark(
  sessionId: string,
  approvalId: string,
  mark: ClaudeApprovalWakeMark
): void {
  const record = records.get(keyOf(sessionId, approvalId))
  if (record) record.wakeMark = { ...mark }
}

/**
 * The helper's `tool-result` for a card: answered, denied, or expired. Returns the record as
 * it now is, or null for a card this process never saw.
 */
export function settleClaudeApproval(
  sessionId: string,
  approvalId: string,
  outcome: { status: Exclude<ClaudeApprovalStatus, 'pending'>; expiryReason?: ClaudeApprovalExpiryReason },
  decidedAt = new Date().toISOString()
): ClaudeApprovalRecord | null {
  const record = records.get(keyOf(sessionId, approvalId))
  if (!record) return null
  if (record.status === 'pending') {
    record.status = outcome.status
    record.decidedAt = decidedAt
    if (outcome.status === 'expired') record.expiryReason = outcome.expiryReason ?? 'unanswered'
  }
  return copy(record)
}

/** Is a Claude card of this chat waiting for the user right now (A3)? */
export function hasWaitingClaudeApproval(sessionId: string, now = Date.now()): boolean {
  for (const record of records.values()) {
    if (record.sessionId !== sessionId || record.status !== 'pending') continue
    if (record.runEndedAt !== null) continue
    if (now >= Date.parse(record.expiresAt)) continue
    return true
  }
  return false
}

/**
 * The answer route's claim on a card, in one synchronous step (A7): only a card this run is
 * waiting on, before its time is up, and only once. A write that then fails lets go with
 * `releaseClaudeApprovalClaim`, so the user can answer again.
 */
export function claimClaudeApproval(
  sessionId: string,
  approvalId: string,
  now = Date.now()
): ClaudeApprovalClaim {
  const record = records.get(keyOf(sessionId, approvalId))
  if (!record) return { ok: false, reason: 'not_found' }
  if (record.status !== 'pending' || record.claimed) return { ok: false, reason: 'answered' }
  if (record.runEndedAt !== null || now >= Date.parse(record.expiresAt)) {
    return { ok: false, reason: 'ended' }
  }
  record.claimed = true
  return { ok: true, record: copy(record) }
}

export function releaseClaudeApprovalClaim(sessionId: string, approvalId: string): void {
  const record = records.get(keyOf(sessionId, approvalId))
  if (record && record.status === 'pending') record.claimed = false
}

/** The cards of one reply, oldest first. */
export function listClaudeApprovals(sessionId: string, messageId: string): ClaudeApprovalRecord[] {
  return [...records.values()]
    .filter((record) => record.sessionId === sessionId && record.messageId === messageId)
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .map(copy)
}

/** The cards of a chat, for the replay a joining tab gets. */
export function listClaudeApprovalsForSession(sessionId: string): ClaudeApprovalRecord[] {
  return [...records.values()]
    .filter((record) => record.sessionId === sessionId)
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .map(copy)
}

/**
 * The run that raised these cards ended. A card still waiting ends with it (`run_ended`): its
 * helper is gone and nothing can answer it. Records stay, for the reply's end and its save.
 * Returns the records whose own wake mark must now be taken back.
 */
export function endClaudeApprovalRun(
  sessionId: string,
  messageId: string,
  now = Date.now()
): ClaudeApprovalRecord[] {
  const ended: ClaudeApprovalRecord[] = []
  for (const record of records.values()) {
    if (record.sessionId !== sessionId || record.messageId !== messageId) continue
    if (record.runEndedAt !== null) continue
    record.runEndedAt = now
    if (record.status === 'pending') {
      record.status = 'expired'
      record.expiryReason = 'run_ended'
      record.decidedAt = new Date(now).toISOString()
    }
    ended.push(copy(record))
  }
  return ended
}

/** The reply's end was built and saved: forget its cards. */
export function forgetClaudeApprovals(sessionId: string, messageId: string): void {
  for (const [key, record] of records) {
    if (record.sessionId === sessionId && record.messageId === messageId) records.delete(key)
  }
}

/** Test-only reset so one suite's cards cannot leak into the next. */
export function __resetClaudeApprovalRegistryForTests(): void {
  records.clear()
}
