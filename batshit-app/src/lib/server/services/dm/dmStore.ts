/**
 * SA-113 P2 (DL-113-02) — the Agent DM data layer.
 *
 * The team mailbox Josh already works with (`.agents/tools/lib/team-mailbox-store.mjs`)
 * is the spec this mirrors, with its two real gaps closed:
 *
 *   - **it has no expiry at all** — no TTL, no reaper, no retention, so `done` grows
 *     forever. Here every DM carries an `expiresAt`, a lazy reaper marks overdue open
 *     items `expired`, and closed items get a 30-day Redis TTL.
 *   - **"one assignment at a time" is README prose, not code** — that store lets an agent
 *     claim ten. Here it is enforced on the claim.
 *
 * And its one real bug is not repeated: a crashed agent's claim is stuck in `working`
 * forever there, because only the claiming session may close it. Here the OWNER is the
 * recipient agent, so any later session of that agent can finish an abandoned claim.
 *
 * ## Why the claim is serialized in-process rather than in Lua
 *
 * DL-113-02 asked for "atomic (Lua or MULTI)". MULTI without WATCH is a batch, not a
 * compare-and-set, and a Lua script cannot run under the in-memory Redis fake the default
 * test lane uses, which would leave the single most important rule in this file untested.
 * Every Batshit request runs in ONE SvelteKit process, so a per-agent async mutex is
 * exactly as strong here as a Lua script would be — the same posture `streamAbortRegistry`
 * (the session-turn lock), `workerTurnBudget`, and the in-process API rate limiter already
 * take, and the same posture `AGENTS.md` records for single-instance self-hosting.
 * Recorded as AMD-113-04. If Batshit ever runs more than one app process, this is one of
 * the places that must move to a Redis-level primitive.
 */

import { redis } from '$lib/server/redis'
import { randomBytes } from 'node:crypto'
import { publishUserEvent } from '$lib/server/ssePublisher'
import {
  DM_BODY_MAX_CHARS,
  DM_DUPLICATE_WINDOW_MS,
  DM_EXPIRY_DAYS_ASSIGNMENT,
  DM_EXPIRY_DAYS_INFO,
  DM_RESULT_MAX_CHARS,
  DM_RETENTION_DAYS,
  DM_SUBJECT_MAX_CHARS,
  MAX_DM_EXPIRES_IN_HOURS,
  MAX_OPEN_DMS_PER_INBOX,
  MIN_DM_EXPIRES_IN_HOURS
} from '$lib/utils/dmControl'
import {
  DM_KINDS,
  DM_PRIORITIES,
  isOpenDmStatus,
  type DmKind,
  type DmPriority,
  type DmRecord,
  type DmSender,
  type DmStatus
} from '$lib/types/dm'
import {
  dmInboxKey,
  dmInboxScore,
  dmKey,
  dmSentKey,
  dmUserIndexKey
} from './dmKeys'

const DAY_MS = 24 * 60 * 60 * 1000

/** Every refusal in this file is a readable sentence, never a bare code. */
export class DmStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'DmStoreError'
  }
}

/* ------------------------------------------------------------------ *
 * Per-agent serialization (see the header note)
 * ------------------------------------------------------------------ */

const inboxLocks = new Map<string, Promise<unknown>>()

/**
 * Run `operation` with no other inbox operation for the same agent interleaved.
 *
 * The chain is per agent, so two agents never wait on each other, and a thrown operation
 * does not poison the queue for the next caller.
 *
 * **It is NOT re-entrant.** Taking the same agent's lock inside an operation that already
 * holds it deadlocks: the inner call queues behind a tail that only settles when the outer
 * one returns. That is why `reapExpired` (reached from `listInbox`, which `createDm` and
 * `claimDm` call while holding the lock) writes without taking it, and why anything new
 * that writes a whole record must first check where it is called from.
 */
async function withInboxLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = inboxLocks.get(agentId) ?? Promise.resolve()
  const run = previous.then(() => operation())
  // The stored tail never rejects, so one failed claim cannot poison the queue behind it.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  inboxLocks.set(agentId, tail)
  try {
    return await run
  } finally {
    // Only the last caller in the chain clears the map; if somebody queued behind us the
    // map already holds THEIR tail and deleting it would let a third caller jump the line.
    if (inboxLocks.get(agentId) === tail) inboxLocks.delete(agentId)
  }
}

/* ------------------------------------------------------------------ *
 * Live updates (DL-113-06)
 * ------------------------------------------------------------------ */

/**
 * Tell the open tabs that this agent's inbox changed, so the P4 header badge is live
 * rather than refreshed on page load.
 *
 * Called only from the operations that actually change the open set — creating, claiming,
 * closing, acknowledging, and a reap that really expired something. Publishing from every
 * read would fire on each compile, which is several times a minute for nothing.
 *
 * Never throws: `publishUserEvent` already logs rather than rejecting, and a badge that
 * missed one update must not be able to fail the DM write it was reporting.
 */
async function announceInboxChanged(agentId: string, userId: string): Promise<void> {
  try {
    const open = await listInbox(agentId)
    await publishUserEvent(userId, {
      type: 'dm_inbox_changed',
      agentId,
      openCount: open.length,
      newCount: open.filter((record) => record.status === 'new').length,
      // F-SEC-1b: how many of those are stopped waiting on the user. The envelope turns
      // warning-coloured on this, which is the whole point of the stamp.
      needsUserCount: open.filter((record) => Boolean(record.delivery?.needsUser)).length
    })
  } catch (error) {
    console.warn('[Agent DMs] Could not announce an inbox change:', error)
  }
}

/* ------------------------------------------------------------------ *
 * Ids and timestamps
 * ------------------------------------------------------------------ */

export function createDmId(nowTs = Date.now()): string {
  return `dm_${nowTs}_${randomBytes(3).toString('hex')}`
}

function defaultExpiryMs(kind: DmKind): number {
  return kind === 'info' ? DM_EXPIRY_DAYS_INFO * DAY_MS : DM_EXPIRY_DAYS_ASSIGNMENT * DAY_MS
}

/**
 * A sender may shorten or lengthen the expiry within a documented range. An out-of-range
 * value fails loudly rather than being clamped: a silently changed deadline is worse than
 * a refused send.
 */
export function resolveExpiresAt(kind: DmKind, expiresInHours: unknown, nowTs: number): string {
  if (expiresInHours === undefined || expiresInHours === null) {
    return new Date(nowTs + defaultExpiryMs(kind)).toISOString()
  }
  const parsed = typeof expiresInHours === 'number' ? expiresInHours : Number(expiresInHours)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new DmStoreError(
      `expires_in_hours must be a whole number of hours between ${MIN_DM_EXPIRES_IN_HOURS} and ${MAX_DM_EXPIRES_IN_HOURS}.`,
      'invalid_expiry'
    )
  }
  if (parsed < MIN_DM_EXPIRES_IN_HOURS || parsed > MAX_DM_EXPIRES_IN_HOURS) {
    throw new DmStoreError(
      `expires_in_hours must be between ${MIN_DM_EXPIRES_IN_HOURS} and ${MAX_DM_EXPIRES_IN_HOURS}.`,
      'invalid_expiry'
    )
  }
  return new Date(nowTs + parsed * 60 * 60 * 1000).toISOString()
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getDm(dmId: string): Promise<DmRecord | null> {
  if (!dmId?.trim()) return null
  return (await redis.json.get(dmKey(dmId))) as DmRecord | null
}

async function readIndexIds(key: string): Promise<string[]> {
  return redis.execute(async (client) => {
    const ids = await client.zRange(key, 0, -1)
    return Array.isArray(ids) ? (ids as string[]) : []
  })
}

async function fetchDms(ids: string[]): Promise<DmRecord[]> {
  const records = await Promise.all(ids.map((id) => getDm(id)))
  return records.filter((record): record is DmRecord => Boolean(record))
}

/**
 * Read one agent's inbox, running the lazy reaper first (DL-113-02: there is no
 * background job — expiry happens on every read, which is enough for a store that is only
 * interesting when somebody looks at it).
 *
 * Returns records in the index's order: urgent first, then oldest.
 */
export async function listInbox(
  agentId: string,
  options?: { includeClosed?: boolean }
): Promise<DmRecord[]> {
  const ids = await readIndexIds(dmInboxKey(agentId))
  const records = await fetchDms(ids)
  await pruneMissingIndexEntries(dmInboxKey(agentId), ids, records)
  const reaped = await reapExpired(records)
  return options?.includeClosed ? reaped : reaped.filter((record) => isOpenDmStatus(record.status))
}

export async function listSent(agentId: string): Promise<DmRecord[]> {
  const ids = await readIndexIds(dmSentKey(agentId))
  const records = await fetchDms(ids)
  await pruneMissingIndexEntries(dmSentKey(agentId), ids, records)
  return records
}

/** Every DM on the instance, newest first — the all-agents view of the P4 drawer. */
export async function listAllDms(userId: string): Promise<DmRecord[]> {
  const ids = await readIndexIds(dmUserIndexKey(userId))
  const records = await fetchDms(ids)
  await pruneMissingIndexEntries(dmUserIndexKey(userId), ids, records)
  // Two DMs written in the same millisecond have no "newer", so the id breaks the tie.
  // Without it the drawer could reorder the same two rows between refreshes, which reads
  // as a bug even though nothing changed.
  return records.sort((a, b) =>
    b.createdTs === a.createdTs ? (a.id < b.id ? 1 : -1) : b.createdTs - a.createdTs
  )
}

/**
 * Retention drops the record but leaves its id in the three indexes, so a read that finds
 * a dangling id cleans it up. Lazy, like the reaper, and for the same reason.
 */
async function pruneMissingIndexEntries(
  key: string,
  ids: string[],
  found: DmRecord[]
): Promise<void> {
  if (ids.length === found.length) return
  const present = new Set(found.map((record) => record.id))
  const missing = ids.filter((id) => !present.has(id))
  if (missing.length === 0) return
  await redis.execute(async (client) => client.zRem(key, missing))
}

/* ------------------------------------------------------------------ *
 * Expiry (the lazy reaper)
 * ------------------------------------------------------------------ */

/**
 * Mark overdue open items `expired`. An expired unclaimed ASSIGNMENT is worth telling
 * somebody about, so the ids that need an "expired unclaimed" result are returned rather
 * than silently swallowed; `dmTools` turns them into `wait`-mode result DMs so nobody is
 * left guessing whether their assignment was ever picked up.
 */
export async function reapExpired(records: DmRecord[], now = Date.now()): Promise<DmRecord[]> {
  const out: DmRecord[] = []
  let expiredAny: DmRecord | null = null
  for (const record of records) {
    if (!isOpenDmStatus(record.status)) {
      out.push(record)
      continue
    }
    const expiresTs = Date.parse(record.expiresAt)
    if (!Number.isFinite(expiresTs) || expiresTs > now) {
      out.push(record)
      continue
    }
    const expired: DmRecord = {
      ...record,
      status: 'expired',
      completedAt: new Date(now).toISOString()
    }
    await writeDm(expired)
    await applyRetention(expired.id)
    expiredAny = expired
    out.push(expired)
  }
  if (expiredAny) void announceInboxChanged(expiredAny.to, expiredAny.userId)
  return out
}

/** Items that expired unclaimed and owe their sender a "nobody picked this up" result. */
export function selectExpiredAssignmentsNeedingResult(records: DmRecord[]): DmRecord[] {
  return records.filter(
    (record) =>
      record.status === 'expired' &&
      record.kind === 'assignment' &&
      !record.claimedBy &&
      !record.resultDmId &&
      Boolean(record.reportBackTo)
  )
}

async function applyRetention(dmId: string): Promise<void> {
  await redis.expire(dmKey(dmId), DM_RETENTION_DAYS * 24 * 60 * 60)
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function writeDm(record: DmRecord): Promise<void> {
  await redis.json.set(dmKey(record.id), '$', record as never)
}

export interface CreateDmInput {
  userId: string
  from: DmSender
  to: string
  kind: DmKind
  subject: string
  body: string
  priority?: DmPriority
  requestedOutcome?: string | null
  scope?: string | null
  reportBackTo?: string | null
  relatedDmId?: string | null
  deliver: 'wait' | 'wake'
  resultDelivery?: 'wait' | 'wake'
  expiresInHours?: number | null
  senderSessionId?: string | null
  senderMessageId?: string | null
  callbackUrl?: string | null
  /** Shared across a broadcast so every copy of one note carries one message id. */
  messageId?: string
}

function requireText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    throw new DmStoreError(`A DM needs a ${field}.`, 'invalid_input')
  }
  if (text.length > max) {
    throw new DmStoreError(
      `${field} is ${text.length} characters and the limit is ${max}.`,
      'invalid_input'
    )
  }
  return text
}

/**
 * Write one DM and index it three ways. Validation, the caps, and the two loop guards all
 * live here, so a webhook (P3) and `sys.dm.send` cannot disagree about what is allowed.
 */
export async function createDm(input: CreateDmInput): Promise<DmRecord> {
  if (!DM_KINDS.includes(input.kind)) {
    throw new DmStoreError(`"${input.kind}" is not a DM kind (info, assignment, result).`, 'invalid_input')
  }
  const priority: DmPriority = DM_PRIORITIES.includes(input.priority as DmPriority)
    ? (input.priority as DmPriority)
    : 'normal'
  const to = typeof input.to === 'string' ? input.to.trim() : ''
  if (!to) throw new DmStoreError('A DM needs a recipient.', 'invalid_input')

  // Loop guard 1: an agent cannot DM itself.
  if (input.from.kind === 'agent' && input.from.agentId === to) {
    throw new DmStoreError(
      'An agent cannot send itself a DM.',
      'self_send',
      'Use your own notes or memory for something you want to keep for yourself.'
    )
  }

  const subject = requireText(input.subject, 'subject', DM_SUBJECT_MAX_CHARS)
  const body = requireText(input.body, 'body', DM_BODY_MAX_CHARS)

  if (input.kind === 'assignment') {
    if (!input.requestedOutcome?.trim()) {
      throw new DmStoreError(
        'An assignment needs a requested outcome — what "done" looks like.',
        'invalid_input'
      )
    }
    if (!input.scope?.trim()) {
      throw new DmStoreError(
        'An assignment needs a scope — what is in and out of bounds.',
        'invalid_input'
      )
    }
    // A webhook assignment (P3) is the ONE exception: its sender is a program, which has no
    // inbox to be reported back to. Its report-back is the one-shot `callbackUrl` instead,
    // and `reportBack` skips an item with no `reportBackTo` by construction. Requiring the
    // field here would force it to point at the recipient itself, which the self-send guard
    // would then refuse at close time — a failure two turns after the mistake.
    if (input.from.kind !== 'webhook' && !input.reportBackTo?.trim()) {
      throw new DmStoreError(
        'An assignment needs report_back_to — the agent that gets the result.',
        'invalid_input'
      )
    }
  }
  if (input.kind === 'result' && !input.relatedDmId?.trim()) {
    throw new DmStoreError(
      'A result needs related_dm_id — the assignment it answers.',
      'invalid_input'
    )
  }

  const nowTs = Date.now()
  const expiresAt = resolveExpiresAt(input.kind, input.expiresInHours, nowTs)

  return withInboxLock(to, async () => {
    const existing = await listInbox(to)

    if (existing.length >= MAX_OPEN_DMS_PER_INBOX) {
      throw new DmStoreError(
        `That agent's inbox is full (${existing.length} open items, limit ${MAX_OPEN_DMS_PER_INBOX}).`,
        'inbox_full',
        'Ask it to close some items, or wait for them to expire.'
      )
    }

    // Loop guard 2: the same DM twice inside ten minutes is a loop, not a reminder.
    const duplicate = existing.find(
      (record) =>
        record.kind === input.kind &&
        record.subject === subject &&
        record.body === body &&
        sameSender(record.from, input.from) &&
        nowTs - record.createdTs < DM_DUPLICATE_WINDOW_MS
    )
    if (duplicate) {
      throw new DmStoreError(
        `That exact DM was already sent ${Math.round((nowTs - duplicate.createdTs) / 1000)}s ago (${duplicate.id}).`,
        'duplicate',
        'Read the existing item instead of sending it again.'
      )
    }

    const id = createDmId(nowTs)
    const record: DmRecord = {
      id,
      messageId: input.messageId ?? id,
      userId: input.userId,
      kind: input.kind,
      priority,
      from: input.from,
      to,
      subject,
      body,
      ...(input.requestedOutcome?.trim()
        ? { requestedOutcome: input.requestedOutcome.trim() }
        : {}),
      ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}),
      ...(input.reportBackTo?.trim() ? { reportBackTo: input.reportBackTo.trim() } : {}),
      ...(input.relatedDmId?.trim() ? { relatedDmId: input.relatedDmId.trim() } : {}),
      deliver: input.deliver,
      ...(input.kind === 'assignment'
        ? { resultDelivery: input.resultDelivery ?? 'wait' }
        : {}),
      status: 'new',
      createdAt: new Date(nowTs).toISOString(),
      createdTs: nowTs,
      expiresAt,
      // The wake attempt has not happened yet; `sys.dm.send` stamps the outcome.
      delivery: { requested: input.deliver, actual: 'wait' },
      senderSessionId: input.senderSessionId ?? null,
      senderMessageId: input.senderMessageId ?? null,
      ...(input.callbackUrl?.trim() ? { callbackUrl: input.callbackUrl.trim() } : {})
    }

    await writeDm(record)
    const score = dmInboxScore(priority, nowTs)
    await redis.execute(async (client) => {
      await client.zAdd(dmInboxKey(to), { score, value: id })
      if (record.from.kind === 'agent') {
        await client.zAdd(dmSentKey(record.from.agentId), { score, value: id })
      }
      await client.zAdd(dmUserIndexKey(input.userId), { score: nowTs, value: id })
    })
    await announceInboxChanged(to, input.userId)
    return record
  })
}

function sameSender(a: DmSender, b: DmSender): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId
  if (a.kind === 'webhook' && b.kind === 'webhook') return a.hookId === b.hookId
  return false
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Claim one DM for a session. `new` only, and — the rule the team mailbox only describes
 * in prose — an `assignment` claim is refused while this agent already holds one in
 * `working`. Serialized per agent, so two claims in the same tick cannot both win.
 */
export async function claimDm(input: {
  dmId: string
  agentId: string
  sessionId: string | null
}): Promise<DmRecord> {
  return withInboxLock(input.agentId, async () => {
    const record = await requireOwnedDm(input.dmId, input.agentId)

    if (record.status !== 'new') {
      throw new DmStoreError(
        `That DM is already ${record.status}, so it cannot be claimed.`,
        'not_claimable',
        record.status === 'working'
          ? 'Close it with sys.dm.done or sys.dm.blocked when you are finished.'
          : undefined
      )
    }

    if (record.kind === 'assignment') {
      const openItems = await listInbox(input.agentId)
      const held = openItems.find(
        (item) => item.kind === 'assignment' && item.status === 'working' && item.id !== record.id
      )
      if (held) {
        throw new DmStoreError(
          `You already have an assignment in progress (${held.id}: "${held.subject}"). Batshit runs one assignment at a time.`,
          'assignment_in_progress',
          'Close the one you are on with sys.dm.done or sys.dm.blocked first.'
        )
      }
    }

    const claimed: DmRecord = {
      ...record,
      status: 'working',
      claimedBy: { agentId: input.agentId, sessionId: input.sessionId ?? null },
      claimedAt: new Date().toISOString()
    }
    await writeDm(claimed)
    await announceInboxChanged(input.agentId, claimed.userId)
    return claimed
  })
}

/**
 * F-SEC-1b — strip the "needs you" stamp while building a closed or reopened record.
 *
 * Inline rather than a call to `clearDmNeedsUser`, because every caller below is already
 * holding this agent's inbox lock and that lock is NOT re-entrant (see its note): taking it
 * again from inside would deadlock on a tail that only settles when the outer call returns.
 */
function withoutNeedsUser(delivery: DmRecord['delivery']): DmRecord['delivery'] {
  if (!delivery?.needsUser) return delivery
  const { needsUser: _cleared, ...rest } = delivery
  return rest
}

/**
 * Close a DM with a real result. `done` and `blocked` both REQUIRE result text — a closed
 * item with nothing to show for it is the thing this store exists to prevent.
 *
 * The owner is the RECIPIENT AGENT, not the claiming session, so an assignment abandoned
 * by a session that died can still be finished later. That is the one place this
 * deliberately differs from the team mailbox, whose stuck claims have no way out.
 */
export async function closeDm(input: {
  dmId: string
  agentId: string
  status: Extract<DmStatus, 'done' | 'blocked'>
  result: string
}): Promise<DmRecord> {
  const result = requireText(input.result, 'result', DM_RESULT_MAX_CHARS)
  return withInboxLock(input.agentId, async () => {
    const record = await requireOwnedDm(input.dmId, input.agentId)
    if (!isOpenDmStatus(record.status)) {
      throw new DmStoreError(
        `That DM is already ${record.status}. Terminal states are terminal.`,
        'already_closed'
      )
    }
    const closed: DmRecord = {
      ...record,
      status: input.status,
      result,
      completedAt: new Date().toISOString(),
      delivery: withoutNeedsUser(record.delivery)
    }
    await writeDm(closed)
    await applyRetention(closed.id)
    await announceInboxChanged(input.agentId, closed.userId)
    return closed
  })
}

/** `read` on an `info` item acknowledges it: `new → done`, per the mailbox's `ack`. */
export async function acknowledgeInfoDm(dmId: string, agentId: string): Promise<DmRecord> {
  return withInboxLock(agentId, async () => {
    const record = await requireOwnedDm(dmId, agentId)
    if (record.kind !== 'info' || !isOpenDmStatus(record.status)) return record
    const acked: DmRecord = {
      ...record,
      status: 'done',
      result: 'Read and acknowledged.',
      completedAt: new Date().toISOString(),
      delivery: withoutNeedsUser(record.delivery)
    }
    await writeDm(acked)
    await applyRetention(acked.id)
    await announceInboxChanged(agentId, acked.userId)
    return acked
  })
}

/**
 * Record which `result` DM a closed assignment produced, so a retry cannot double it.
 *
 * F-P2-3 applies here too, and this is the pairing that makes it necessary rather than
 * theoretical: an agent closing its assignment (which lands here) and the woken turn ending
 * (which lands in `stampDmDelivery`) happen at the same moment on the same record. With
 * only one of the two under the lock, the loser's whole-record write erases the winner.
 */
export async function linkResultDm(dmId: string, resultDmId: string): Promise<void> {
  const record = await getDm(dmId)
  if (!record) return
  await withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current) return
    await writeDm({ ...current, resultDmId })
  })
}

async function requireOwnedDm(dmId: string, agentId: string): Promise<DmRecord> {
  const record = await getDm(dmId)
  if (!record) {
    throw new DmStoreError(`DM "${dmId}" was not found (it may have expired).`, 'not_found')
  }
  if (record.to !== agentId) {
    throw new DmStoreError(
      `DM "${dmId}" was not addressed to you.`,
      'not_recipient',
      'Only the recipient can read, claim, or close a DM.'
    )
  }
  return record
}

/* ------------------------------------------------------------------ *
 * Delivery outcome (the wake half's write-back)
 * ------------------------------------------------------------------ */

/**
 * Stamp what actually happened to a `deliver: 'wake'` request.
 *
 * Called twice for a successful wake: once by `sys.dm.send` with the accepted session, and
 * again by the wake primitive when the turn ends, which is also where F-P1-4's
 * `agent_busy` lands — the case where send-routed answered 409 because the user started a
 * turn in that chat between the busy check and the POST. Nothing failed there, so the DM
 * says `wait`, not `failed`.
 *
 * F-P2-3: this is a read-modify-write of the WHOLE record, and a woken recipient can be
 * claiming that same record at the same moment. Both writers now run under the recipient's
 * inbox lock, so a late stamp can no longer revert a claim to `new`. The record is re-read
 * inside the lock for the same reason — a copy read before the wait is already stale.
 */
export async function stampDmDelivery(
  dmId: string,
  patch: Partial<DmRecord['delivery']>
): Promise<void> {
  if (!dmId?.trim()) return
  const record = await getDm(dmId)
  if (!record) return
  await withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current) return
    await writeDm({ ...current, delivery: { ...current.delivery, ...patch } })
  })
}

/**
 * SA-113 F-SEC-1b — mark this DM's woken turn as stopped waiting on the user.
 *
 * Two holdups reach here, and neither can be cleared by the agent:
 *   - `useControl` refusing a risky Fabric control with `CONTROL_RISK_NEEDS_HUMAN_TURN`
 *     (F-SEC-1), which happens MID-turn;
 *   - a woken turn that ended sitting in the persisted tool-approval state, seen by
 *     `finishWokenTurn`.
 *
 * Josh's reason for it, in his words: "the user might not even know that they need to do
 * it." A woken chat that stops for approval just ends its turn — the chat sits in the
 * sidebar and the DM sits at `working`, and nothing says the holdup is a person.
 *
 * A whole-record write like `stampDmDelivery`, so it runs under the recipient's lock for
 * the same reason, and it announces so the header envelope changes colour at once. Only
 * the FIRST holdup of a turn is recorded: a second refusal must not restamp a newer time
 * over the moment the chat actually stopped needing the agent.
 */
export async function stampDmNeedsUser(dmId: string, reason: string): Promise<void> {
  if (!dmId?.trim()) return
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  if (!trimmed) return
  const record = await getDm(dmId)
  if (!record) return
  await withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current) return
    if (current.delivery?.needsUser) return
    await writeDm({
      ...current,
      delivery: {
        ...current.delivery,
        needsUser: { reason: trimmed.slice(0, DM_RESULT_MAX_CHARS), at: new Date().toISOString() }
      }
    })
    await announceInboxChanged(current.to, current.userId)
  })
}

/**
 * F-SEC-1b — the holdup is over: the user replied in that chat, or the DM closed.
 *
 * Deletes the key rather than writing `undefined`, so a re-read never sees a half-present
 * marker. Silent when there was nothing stamped, because both callers fire on every send
 * and every close.
 */
export async function clearDmNeedsUser(dmId: string): Promise<void> {
  if (!dmId?.trim()) return
  const record = await getDm(dmId)
  if (!record?.delivery?.needsUser) return
  await withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current?.delivery?.needsUser) return
    const { needsUser: _cleared, ...delivery } = current.delivery
    await writeDm({ ...current, delivery })
    await announceInboxChanged(current.to, current.userId)
  })
}

/**
 * F-SEC-1b — the user replied in a chat: clear "needs you" on every open DM whose woken
 * turn landed THERE.
 *
 * Keyed on the DM's own `delivery.sessionId`, which every wake stamps — a new session, the
 * sender's original chat for a `result`, or the agent's current chat under "One at a
 * time". That is why it does NOT key on the session carrying an origin: a One-at-a-time
 * wake lands in a chat the user started, which has no origin, and a stamp there would
 * otherwise outlive the reply that answered it (Faye's P5b re-check, F-P5b-1). One inbox
 * read for the acting agent; send-routed pays it only for a DM-enabled agent's sends.
 * Returns the ids it cleared, for the test and for anyone curious.
 */
export async function clearNeedsUserForHumanReply(
  agentId: string,
  sessionId: string
): Promise<string[]> {
  const agent = typeof agentId === 'string' ? agentId.trim() : ''
  const session = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!agent || !session) return []
  const open = await listInbox(agent)
  const cleared: string[] = []
  for (const record of open) {
    if (!record.delivery?.needsUser || record.delivery.sessionId !== session) continue
    await clearDmNeedsUser(record.id)
    cleared.push(record.id)
  }
  return cleared
}

/**
 * SA-113 P3 (DL-113-09): record what the one-shot webhook result callback did.
 *
 * Under the recipient's lock for the same reason as `stampDmDelivery` — it is another
 * whole-record write, and it lands right after a close.
 */
export async function setDmCallbackStatus(dmId: string, callbackStatus: string): Promise<void> {
  if (!dmId?.trim()) return
  const record = await getDm(dmId)
  if (!record) return
  await withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current) return
    await writeDm({ ...current, callbackStatus })
  })
}

/* ------------------------------------------------------------------ *
 * The user's own actions (DL-113-10a, the inbox drawer)
 * ------------------------------------------------------------------ */

/**
 * The three drawer actions are the USER acting, not an agent.
 *
 * They are deliberately separate from `closeDm` / `claimDm`, which enforce the agent-side
 * contract (only the recipient, terminal is terminal, one assignment at a time). The user
 * owns the whole instance, so the only ownership rule here is `record.userId`, and Reopen
 * is allowed precisely because it is the one thing an agent must never do to itself.
 */
async function requireUserOwnedDm(userId: string, dmId: string): Promise<DmRecord> {
  const record = await getDm(dmId)
  if (!record || record.userId !== userId) {
    throw new DmStoreError(`DM "${dmId}" was not found.`, 'not_found')
  }
  return record
}

/** Close an open item on the user's behalf. The result text says who closed it. */
export async function userCloseDm(userId: string, dmId: string): Promise<DmRecord> {
  const record = await requireUserOwnedDm(userId, dmId)
  if (!isOpenDmStatus(record.status)) return record
  return withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current || !isOpenDmStatus(current.status)) return current ?? record
    const closed: DmRecord = {
      ...current,
      status: 'done',
      result: 'Closed by user',
      completedAt: new Date().toISOString(),
      delivery: withoutNeedsUser(current.delivery)
    }
    await writeDm(closed)
    await applyRetention(closed.id)
    await announceInboxChanged(closed.to, closed.userId)
    return closed
  })
}

/**
 * Put a closed, blocked, or expired item back in the inbox as `new`.
 *
 * Four things have to be undone, not one.
 *
 * The status is the obvious half. The second is the 30-day retention TTL that closing set,
 * because a reopened DM carrying it would quietly disappear while the roster still listed it
 * as open. An item whose `expiresAt` has already passed also gets a fresh window, or the lazy
 * reaper would expire it again on the next read.
 *
 * The other two are the "already reported" markers: `reportBack` returns early when
 * `resultDmId` is set and `fireWakeCallback` returns early when `callbackStatus` is set, so
 * leaving them behind makes the redo the user asked for finish SILENTLY — the sender gets no
 * second result DM and a webhook caller gets no second callback. The earlier result DM stays
 * in the sender's inbox as history; only the markers are cleared.
 */
export async function reopenDm(userId: string, dmId: string): Promise<DmRecord> {
  const record = await requireUserOwnedDm(userId, dmId)
  if (isOpenDmStatus(record.status)) return record
  return withInboxLock(record.to, async () => {
    const current = await getDm(dmId)
    if (!current || isOpenDmStatus(current.status)) return current ?? record
    const now = Date.now()
    const stillFresh = Number.isFinite(Date.parse(current.expiresAt))
      ? Date.parse(current.expiresAt) > now
      : false
    const reopened: DmRecord = {
      ...current,
      status: 'new',
      expiresAt: stillFresh
        ? current.expiresAt
        : resolveExpiresAt(current.kind, undefined, now),
      claimedBy: undefined,
      claimedAt: undefined,
      completedAt: undefined,
      result: undefined,
      resultDmId: undefined,
      callbackStatus: undefined,
      // F-SEC-1b: the holdup belonged to the previous run. A reopened item starts clean,
      // or the envelope would keep saying "needs you" about a turn that no longer exists.
      delivery: withoutNeedsUser(current.delivery)
    }
    await writeDm(reopened)
    await redis.persist(dmKey(reopened.id))
    await announceInboxChanged(reopened.to, reopened.userId)
    return reopened
  })
}

/** Delete one DM and every index that points at it. */
export async function deleteDmForUser(userId: string, dmId: string): Promise<void> {
  const record = await requireUserOwnedDm(userId, dmId)
  await withInboxLock(record.to, async () => {
    await redis.del(dmKey(record.id))
    await redis.execute(async (client) => {
      await client.zRem(dmInboxKey(record.to), [record.id])
      await client.zRem(dmUserIndexKey(record.userId), [record.id])
      if (record.from.kind === 'agent') {
        await client.zRem(dmSentKey(record.from.agentId), [record.id])
      }
    })
  })
  await announceInboxChanged(record.to, record.userId)
}

/* ------------------------------------------------------------------ *
 * Agent deletion (DL-113-02)
 * ------------------------------------------------------------------ */

/**
 * Delete everything addressed TO this agent, plus its two indexes.
 *
 * DMs it SENT stay where they are, with the frozen `from.name` — the recipient's copy of
 * a note is its own record, and deleting an agent should not blank the history of a
 * conversation it had with somebody else.
 */
export async function sweepAgentDms(agentId: string): Promise<number> {
  const inboxIds = await readIndexIds(dmInboxKey(agentId))

  let deleted = 0
  for (const dmId of inboxIds) {
    const record = await getDm(dmId)
    await redis.del(dmKey(dmId))
    deleted += 1
    if (!record) continue
    await redis.execute(async (client) => {
      await client.zRem(dmUserIndexKey(record.userId), [dmId])
      if (record.from.kind === 'agent') {
        await client.zRem(dmSentKey(record.from.agentId), [dmId])
      }
    })
  }

  // The sent INDEX goes, but the records it points at stay: each is the recipient's copy,
  // and it already carries the sender's name frozen at send time, so the other side of the
  // conversation does not go blank when an agent is deleted.
  await redis.del(dmInboxKey(agentId))
  await redis.del(dmSentKey(agentId))
  return deleted
}

/** Test-only: the per-agent lock chains are process state, like the wake registry's. */
export function __resetDmLocksForTests(): void {
  inboxLocks.clear()
}
