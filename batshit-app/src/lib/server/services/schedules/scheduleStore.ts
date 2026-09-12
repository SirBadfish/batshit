/**
 * SA-115 P1 (DL-115-02, DL-115-06, DL-115-07, DL-115-11) — the schedule records.
 *
 * `wakeHookStore.ts` is the store this copies, including the two rules its header
 * documents, which are the spec for what not to repeat here:
 *
 *  1. **The id guard runs before ANY key read.** A malformed id answers "no such
 *     schedule" without touching Redis: bounded charset and length, nothing attacker-shaped
 *     in a key name or a log line, a clean miss instead of a Redis error escaping as a 500.
 *     (Not a collision fix — `schedule:` and `schedules:` cannot collide; SA-116 P1
 *     corrected that claim.) `scheduleKeys.ts` owns the pattern.
 *  2. **Create is the ONLY whole-record write.** `JSON.SET key $ record` CREATES a
 *     missing key (F-P3-2), so a root write racing a delete resurrects the record — and
 *     the ticker writes to a schedule on every fire while the user may be deleting it in
 *     the Admin card. Every later mutation is a `$.field` write, which RedisJSON refuses
 *     when the root is gone, making a deleted schedule a no-op instead of a zombie that
 *     keeps waking an agent with no way to stop it.
 *
 * The rules — cadences, the next-run math, the DST behaviour, the caps — live in
 * `$lib/utils/scheduleControl.ts` and are never restated here.
 */

import { randomBytes } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import {
  MAX_SCHEDULES_PER_AGENT,
  MAX_SCHEDULES_PER_INSTANCE,
  collapseMissedRuns,
  computeNextRunAt,
  validateScheduleFields,
  type ScheduleFieldsInput
} from '$lib/utils/scheduleControl'
import {
  hasMissedRun,
  toScheduleSummary,
  type ScheduleCreator,
  type ScheduleRecord,
  type ScheduleSummary
} from '$lib/types/schedule'
import {
  isWellFormedScheduleId,
  scheduleKey,
  schedulesIndexKey,
  SCHEDULES_INDEX_PREFIX
} from './scheduleKeys'

const SCHEDULE_ID_BYTES = 12

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'ScheduleError'
  }
}

function generateScheduleId(): string {
  return `sch_${randomBytes(SCHEDULE_ID_BYTES).toString('base64url')}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed) : null
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getSchedule(scheduleId: unknown): Promise<ScheduleRecord | null> {
  const normalized = typeof scheduleId === 'string' ? scheduleId.trim() : ''
  // A malformed id is "no such schedule", never a key read: see `isWellFormedScheduleId`.
  if (!isWellFormedScheduleId(normalized)) return null
  const record = (await redis.json.get(scheduleKey(normalized))) as ScheduleRecord | null
  return record && typeof record === 'object' ? record : null
}

async function readIndexMembers(userId: string): Promise<string[]> {
  const members = await redis.execute(async (client) =>
    client.sMembers(schedulesIndexKey(userId))
  )
  return Array.isArray(members) ? (members as string[]) : []
}

async function removeIndexMember(userId: string, scheduleId: string): Promise<void> {
  await redis.execute(async (client) =>
    client.sRem(schedulesIndexKey(userId), [scheduleId])
  )
}

/**
 * Every schedule this user owns, newest first. An index member whose record is gone (or
 * whose record belongs to somebody else) is pruned as it is found — `listWakeHooks` does
 * the same, and it is the only self-healing this keyspace needs.
 */
export async function listSchedules(userId: string): Promise<ScheduleSummary[]> {
  const ids = await readIndexMembers(userId)
  const summaries: ScheduleSummary[] = []
  for (const id of ids) {
    const record = await getSchedule(id)
    if (!record || record.userId !== userId) {
      await removeIndexMember(userId, id)
      continue
    }
    summaries.push(toScheduleSummary(record))
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function requireOwnedSchedule(
  userId: string,
  scheduleId: unknown
): Promise<ScheduleRecord> {
  const record = await getSchedule(scheduleId)
  if (!record || record.userId !== userId) {
    throw new ScheduleError('That schedule was not found.', 404)
  }
  return record
}

/** Public form of the ownership read, for routes and `sys.schedule.*`. */
export async function getOwnedSchedule(
  userId: string,
  scheduleId: unknown
): Promise<ScheduleRecord> {
  return requireOwnedSchedule(userId, scheduleId)
}

/**
 * Every enabled schedule on the instance whose next run has arrived, oldest due first.
 *
 * Enumerating index keys rather than agents (the dreaming sweep's shape) keeps the sweep
 * proportional to "users who actually have schedules", which on a single-user instance is
 * one key. A disabled schedule is skipped here rather than in the ticker so "paused" can
 * never be confused with "missed".
 */
export async function listDueSchedules(now: Date): Promise<ScheduleRecord[]> {
  const indexKeys = await redis.execute(async (client) =>
    client.keys(`${SCHEDULES_INDEX_PREFIX}*`)
  )
  const due: ScheduleRecord[] = []

  for (const indexKey of Array.isArray(indexKeys) ? (indexKeys as string[]) : []) {
    const userId = indexKey.slice(SCHEDULES_INDEX_PREFIX.length)
    if (!userId) continue
    for (const id of await readIndexMembers(userId)) {
      const record = await getSchedule(id)
      if (!record || record.userId !== userId) continue
      if (record.enabled !== true) continue
      const nextRunAt = readInstant(record.nextRunAt)
      if (!nextRunAt || nextRunAt.getTime() > now.getTime()) continue
      due.push(record)
    }
  }

  return due.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
}

/* ------------------------------------------------------------------ *
 * Create — the ONE whole-record write
 * ------------------------------------------------------------------ */

async function requireEligibleAgent(
  userId: string,
  agentId: unknown
): Promise<Record<string, any>> {
  const normalized = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalized) throw new ScheduleError('Choose which agent this schedule writes to.')
  const agent = (await redis.get(`agent:${normalized}`)) as Record<string, any> | null
  if (!agent || (agent.user_id && agent.user_id !== userId)) {
    throw new ScheduleError(`Agent "${normalized}" was not found.`, 404)
  }
  const agentType = normalizePrimaryAgentType(agent as any)
  if (agentType !== 'api' && agentType !== 'cli') {
    throw new ScheduleError('Only API and CLI primary agents can be put on a schedule.')
  }
  // AMD-113-05 parity: a fire writes a DM, so an agent with DMs off would never see it
  // and would have no `sys.dm.*` tools to close it with.
  if (!resolveAgentDmsEnabled(agent)) {
    throw new ScheduleError(
      `${agent.displayName ?? agent.name ?? normalized} does not have Agent DMs turned on, so it would never see this.`,
      400,
      'Turn on Agent DMs for that agent in Agent Settings.'
    )
  }
  return agent
}

/**
 * Create a schedule.
 *
 * Both caps refuse with a reason rather than clamping (DL-115-11), and both are counted
 * from the live index so a delete frees a slot immediately. The per-instance cap is
 * checked against this user's schedules because Batshit is single-user-per-instance; if
 * that ever changes, this is the line that changes with it.
 */
export async function createSchedule(options: {
  userId: string
  agentId: unknown
  createdBy?: ScheduleCreator
  now?: Date
} & ScheduleFieldsInput): Promise<ScheduleSummary> {
  const validation = validateScheduleFields(options)
  if (!validation.ok) throw new ScheduleError(validation.error)
  const fields = validation.fields

  await requireEligibleAgent(options.userId, options.agentId)
  const agentId = String(options.agentId).trim()

  const existing = await listSchedules(options.userId)
  if (existing.length >= MAX_SCHEDULES_PER_INSTANCE) {
    throw new ScheduleError(
      `This Batshit already has ${existing.length} schedules (limit ${MAX_SCHEDULES_PER_INSTANCE}).`,
      400,
      'Delete a schedule you no longer need first.'
    )
  }
  const forAgent = existing.filter((record) => record.agentId === agentId)
  if (forAgent.length >= MAX_SCHEDULES_PER_AGENT) {
    throw new ScheduleError(
      `That agent already has ${forAgent.length} schedules (limit ${MAX_SCHEDULES_PER_AGENT}).`,
      400,
      'Delete one of its schedules first.'
    )
  }

  const now = options.now ?? new Date()
  const createdAt = now.toISOString()
  const record: ScheduleRecord = {
    id: generateScheduleId(),
    userId: options.userId,
    agentId,
    name: fields.name,
    cadence: fields.cadence,
    timeZone: fields.timeZone,
    message: fields.message,
    kind: fields.kind,
    deliver: fields.deliver,
    enabled: fields.enabled,
    nextRunAt: computeNextRunAt(fields.cadence, fields.timeZone, now, now).toISOString(),
    lastRunAt: null,
    lastOutcome: null,
    lastDmId: null,
    runCount: 0,
    missedRun: null,
    createdBy: options.createdBy ?? 'user',
    createdAt,
    updatedAt: createdAt
  }

  await redis.json.set(scheduleKey(record.id), '$', record as never)
  await redis.execute(async (client) => client.sAdd(schedulesIndexKey(record.userId), record.id))
  return toScheduleSummary(record)
}

/* ------------------------------------------------------------------ *
 * Path-scoped writes — everything after create
 * ------------------------------------------------------------------ */

/**
 * Is this the RedisJSON reply that means "the record this path belongs to is gone"?
 *
 * SA-115 F-P1-4(b). This is the ONLY error a path write is allowed to swallow, and it has
 * to be recognised rather than assumed: mapping every throw to "not found" turned a Redis
 * outage, a WRONGTYPE, or a serialisation bug into a calm 404 saying the schedule the user
 * is looking at does not exist — a silent fallback, and a confusing one.
 *
 * Redis 8 note: the quoted path fragment is deliberately NOT matched. ReJSON's missing-path
 * text changed from `ERR Path '.x' does not exist` to `ERR Path does not exist` between
 * versions, so matching the quote would stop working on exactly one of them.
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
 * Fields whose write must land LAST, and why (SA-115 F-P1-4(a)).
 *
 * `enabled` is the switch the ticker reads to decide whether a schedule exists for this
 * sweep. Path writes go one at a time, so on a re-enable the old code wrote `enabled: true`
 * *before* the recomputed `nextRunAt` — and a sweep landing in that window saw an enabled
 * schedule still carrying its stale, long-past next run and collapsed a missed run that
 * never happened. The user would then be shown the *Missed while Batshit was off* dialog
 * for a schedule they had just switched on.
 *
 * This lives here rather than in the order of a caller's object literal on purpose: an
 * object literal's key order is invisible as a correctness rule, and the next person to
 * tidy that literal would silently bring the bug back.
 */
const WRITE_LAST_FIELDS = new Set(['enabled'])

/**
 * Put the `WRITE_LAST_FIELDS` at the end, keeping everything else in the caller's order.
 *
 * Exported so the invariant can be asserted directly rather than inferred from a spy on
 * the Redis client: the order these come back in IS the order they hit Redis.
 */
export function orderScheduleFieldWrites(
  fields: Record<string, unknown>
): [string, unknown][] {
  const entries = Object.entries(fields)
  return [
    ...entries.filter(([field]) => !WRITE_LAST_FIELDS.has(field)),
    ...entries.filter(([field]) => WRITE_LAST_FIELDS.has(field))
  ]
}

/**
 * Write named fields onto an EXISTING schedule, never the whole record (F-P3-2).
 *
 * A path write cannot create the root, so a schedule deleted between a read and this
 * write is a no-op rather than a resurrection. That matters more here than it did for
 * wake-up webhooks: the ticker writes to a schedule on every fire, and a resurrected
 * schedule would keep waking an agent with no row in the Admin card to turn it off.
 */
async function patchScheduleFields(
  scheduleId: string,
  fields: Record<string, unknown>
): Promise<void> {
  if (!isWellFormedScheduleId(scheduleId)) {
    throw new ScheduleError('That schedule was not found.', 404)
  }
  const key = scheduleKey(scheduleId)
  try {
    for (const [field, value] of orderScheduleFieldWrites(fields)) {
      await redis.json.set(key, `$.${field}`, value as never)
    }
  } catch (error) {
    if (isMissingRecordError(error)) {
      throw new ScheduleError('That schedule was not found.', 404)
    }
    // Anything else is a real failure and must say so. Fail loudly, never silently drift.
    console.error(`[Schedules] Could not write to schedule ${scheduleId}:`, error)
    throw error
  }
}

/**
 * Apply a user's or an agent's edit.
 *
 * `nextRunAt` is recomputed whenever the *when* changed — the cadence, the zone, or a
 * pause being lifted — so an edit governs the very next sweep with no reload (LS-046).
 * Turning a schedule OFF leaves `nextRunAt` alone: a paused schedule is skipped entirely
 * and is not "missed", so its stored next run is simply ignored until it is switched back
 * on, at which point it is recomputed from that moment.
 */
export async function patchSchedule(options: {
  userId: string
  scheduleId: unknown
  now?: Date
} & ScheduleFieldsInput): Promise<ScheduleSummary> {
  const current = await requireOwnedSchedule(options.userId, options.scheduleId)
  const merged = validateScheduleFields({
    name: options.name ?? current.name,
    cadence: options.cadence ?? current.cadence,
    timeZone: options.timeZone ?? current.timeZone,
    message: options.message ?? current.message,
    kind: options.kind ?? current.kind,
    deliver: options.deliver ?? current.deliver,
    enabled: options.enabled ?? current.enabled
  })
  if (!merged.ok) throw new ScheduleError(merged.error)
  const fields = merged.fields

  const now = options.now ?? new Date()
  const whenChanged =
    JSON.stringify(fields.cadence) !== JSON.stringify(current.cadence) ||
    fields.timeZone !== current.timeZone ||
    (fields.enabled === true && current.enabled !== true)

  // `enabled` is written last regardless of where it sits here — see `WRITE_LAST_FIELDS`.
  await patchScheduleFields(current.id, {
    name: fields.name,
    cadence: fields.cadence,
    timeZone: fields.timeZone,
    message: fields.message,
    kind: fields.kind,
    deliver: fields.deliver,
    enabled: fields.enabled,
    ...(whenChanged
      ? { nextRunAt: computeNextRunAt(fields.cadence, fields.timeZone, now, now).toISOString() }
      : {}),
    updatedAt: now.toISOString()
  })

  const updated = await getSchedule(current.id)
  if (!updated) throw new ScheduleError('That schedule was not found.', 404)
  return toScheduleSummary(updated)
}

export async function deleteSchedule(options: {
  userId: string
  scheduleId: unknown
}): Promise<void> {
  const record = await requireOwnedSchedule(options.userId, options.scheduleId)
  await redis.del(scheduleKey(record.id))
  await removeIndexMember(record.userId, record.id)
}

/**
 * Record one fire and move the schedule on to its next slot.
 *
 * Called for a success AND for a failure: DL-115-06 says a fire that throws still
 * advances `nextRunAt`, because a schedule that retries the same slot every minute is a
 * storm, not a clock. The outcome sentence is what the card shows and is the only place
 * a failed fire is visible, so it carries the reason.
 */
export async function recordFire(options: {
  scheduleId: string
  ranAt: Date
  outcome: string
  dmId?: string | null
  /**
   * Where the clock goes next — omitted by **Run now** (P2), on purpose.
   *
   * A Run now is the user pressing a button, not a slot arriving, so it must not move the
   * schedule's own grid: pressing Run now at 08:55 on a "daily at 9am" schedule would
   * otherwise skip today's 9am run, which is the opposite of what the button says. A
   * missed run's `nextRunAt` was already moved forward by the collapse, so there is
   * nothing for it to advance there either.
   */
  nextRunAt?: Date | null
}): Promise<void> {
  await patchScheduleFields(options.scheduleId, {
    lastRunAt: options.ranAt.toISOString(),
    lastOutcome: options.outcome,
    lastDmId: options.dmId ?? null,
    ...(options.nextRunAt ? { nextRunAt: options.nextRunAt.toISOString() } : {}),
    updatedAt: options.ranAt.toISOString()
  })
  try {
    await redis.json.numIncrBy(scheduleKey(options.scheduleId), '$.runCount', 1)
  } catch (error) {
    if (isMissingRecordError(error)) {
      // The schedule was deleted between the two writes. The fire already happened and is
      // recorded on its DM; there is nothing here worth a warning.
      return
    }
    // F-P1-4(b): anything else — an outage, a WRONGTYPE — is a real failure. The fire
    // itself already succeeded and is recorded, so this does not throw; but a run counter
    // that silently stops counting is exactly the kind of drift nobody notices for months.
    console.error(
      `[Schedules] Could not increment the run count of schedule ${options.scheduleId}:`,
      error
    )
  }
}

/**
 * Collapse every slot this schedule slept through into its ONE missed-run entry, and move
 * `nextRunAt` to the next future slot. **Nothing fires.**
 *
 * When an entry already exists the counts add up, because both sets of runs are still
 * unaddressed: the user has not pressed Run now or Skip yet, so the number they read must
 * mean "runs you have missed", not "runs missed since the last time I noticed".
 */
export async function collapseMissedRun(options: {
  schedule: ScheduleRecord
  now: Date
}): Promise<{ dueAt: string; count: number; nextRunAt: string }> {
  const { schedule, now } = options
  const dueAt = readInstant(schedule.nextRunAt)
  if (!dueAt) {
    throw new ScheduleError(`Schedule ${schedule.id} has no readable next run.`, 500)
  }

  const collapse = collapseMissedRuns({
    cadence: schedule.cadence,
    timeZone: schedule.timeZone,
    dueAt,
    now
  })

  const previous = hasMissedRun(schedule) ? (schedule.missedRun?.count ?? 0) : 0
  const missedRun = {
    dueAt: collapse.dueAt.toISOString(),
    count: previous + collapse.missed,
    noticedAt: now.toISOString()
  }

  await patchScheduleFields(schedule.id, {
    missedRun,
    nextRunAt: collapse.nextRunAt.toISOString(),
    updatedAt: now.toISOString()
  })

  return {
    dueAt: missedRun.dueAt,
    count: missedRun.count,
    nextRunAt: collapse.nextRunAt.toISOString()
  }
}

/**
 * Clear the missed-run entry. Both **Run now** and **Skip** end here; the difference is
 * that Run now fires first (P2's routes).
 *
 * Writes an explicit `null` rather than deleting the path — see the note on
 * `ScheduleRecord.missedRun`.
 */
export async function clearMissedRun(options: {
  userId: string
  scheduleId: unknown
  now?: Date
}): Promise<ScheduleSummary> {
  const record = await requireOwnedSchedule(options.userId, options.scheduleId)
  const now = options.now ?? new Date()
  await patchScheduleFields(record.id, {
    missedRun: null,
    updatedAt: now.toISOString()
  })
  const updated = await getSchedule(record.id)
  if (!updated) throw new ScheduleError('That schedule was not found.', 404)
  return toScheduleSummary(updated)
}

/* ------------------------------------------------------------------ *
 * Agent deletion (DL-115-12; wired into `deleteAgent` in P3)
 * ------------------------------------------------------------------ */

/**
 * Delete every schedule pointing at a deleted agent.
 *
 * A schedule whose agent is gone is a clock that can only ever fail, so it goes with the
 * agent — the same reason its inbox and its wake-up webhooks do. Schedules belonging to
 * OTHER agents of the same user are untouched. Reads `agent.user_id`, so `deleteAgent`
 * must call this BEFORE it removes the agent record.
 */
export async function sweepAgentSchedules(agentId: string): Promise<number> {
  const record = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  const userId = typeof record?.user_id === 'string' ? record.user_id : null
  if (!userId) return 0

  let deleted = 0
  for (const id of await readIndexMembers(userId)) {
    const schedule = await getSchedule(id)
    if (!schedule || schedule.agentId !== agentId) continue
    await redis.del(scheduleKey(id))
    await removeIndexMember(userId, id)
    deleted += 1
  }
  return deleted
}
