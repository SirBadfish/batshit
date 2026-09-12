/**
 * SA-115 P1 (DL-115-02, DL-115-03) — a scheduled wake-up, as stored.
 *
 * A schedule is a saved *when* and *what* for one agent. When it is due, the ticker
 * writes a DM from the schedule and — for `deliver: 'wake'` — asks the wake primitive to
 * start that agent's turn. Everything after the fire is SA-113 unchanged.
 *
 * Two shapes here are load-bearing:
 *
 *  - **The cadence is a closed three-shape union.** No cron strings in v1 (Josh's call).
 *    Every rule that reads it lives in `$lib/utils/scheduleControl.ts`, never inline.
 *  - **`missedRun` holds at most ONE entry, ever.** A due time Batshit slept through is
 *    collapsed into it, never queued: a weekly schedule missed three times shows one row
 *    saying "missed 3", and only the user's **Run now** can start it.
 *
 * Browser-safe on purpose: the P2 Admin card and the missed-run dialog read these shapes.
 */

/** `info` = a note to read. `assignment` = do this and report back. A schedule never writes a `result`. */
export const SCHEDULE_KINDS = ['info', 'assignment'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

/** `wait` leaves the DM in the inbox; `wake` asks the wake primitive to start a turn. */
export const SCHEDULE_DELIVERY_MODES = ['wait', 'wake'] as const
export type ScheduleDeliveryMode = (typeof SCHEDULE_DELIVERY_MODES)[number]

/**
 * The three cadence shapes, and only these three (DL-115-03).
 *
 * `interval` deliberately ignores the time zone: "every 30 minutes" means the same thing
 * everywhere, and anchoring it to a wall clock would make it fire twice or skip an hour
 * across a DST change. `daily` and `weekly` are wall-clock and therefore zoned.
 */
export type ScheduleCadence =
  | { type: 'interval'; everyMinutes: number }
  | { type: 'daily'; at: string }
  | { type: 'weekly'; days: number[]; at: string }

export const SCHEDULE_CADENCE_TYPES = ['interval', 'daily', 'weekly'] as const
export type ScheduleCadenceType = (typeof SCHEDULE_CADENCE_TYPES)[number]

/**
 * One collapsed missed run (DL-115-07).
 *
 * `dueAt` is the most recent slot the schedule slept through, and `count` is how many
 * slots went by unfired since it last actually ran (or since the last time this entry was
 * written, if the user has not cleared it yet). A second miss updates this same entry —
 * there is never a queue of them.
 */
export interface ScheduleMissedRun {
  dueAt: string
  count: number
  /** When the collapse happened, so the dialog can say "23 days ago" honestly. */
  noticedAt: string
}

/** Who made this schedule. An agent-made one says so on the card (DL-115-10). */
export type ScheduleCreator = 'user' | { agentId: string }

export interface ScheduleRecord {
  id: string
  userId: string
  /** The agent this schedule writes to. One schedule, one recipient. */
  agentId: string
  name: string
  cadence: ScheduleCadence
  /** IANA zone captured in the browser at creation. Ignored by `interval` cadences. */
  timeZone: string
  message: string
  kind: ScheduleKind
  deliver: ScheduleDeliveryMode
  /** A paused schedule is skipped entirely — it is not "missed", it is off. */
  enabled: boolean

  /** ISO instant of the next due slot. The ticker's only "is it time?" input. */
  nextRunAt: string
  lastRunAt: string | null
  /** A readable sentence: `woke: <sessionId>`, `waiting in inbox`, `waited: …`, `failed: …`. */
  lastOutcome: string | null
  lastDmId: string | null
  runCount: number
  /**
   * `null` and absent both mean "nothing missed".
   *
   * Clearing writes an explicit `null` rather than deleting the path: `node-redis`'s JSON
   * delete has been seen to ignore a positional path and remove the whole document
   * (recorded in shared agent memory), and a schedule is not worth that risk. Read it
   * through `hasMissedRun`, never by checking the key's presence.
   */
  missedRun?: ScheduleMissedRun | null

  createdBy: ScheduleCreator
  createdAt: string
  updatedAt: string
}

/**
 * What the Admin card, the missed-run dialog, and `sys.schedule.list` receive.
 *
 * A schedule holds no secret, so this is the whole record today. It exists anyway so a
 * later private field cannot leak by default — the same reason `WakeHookSummary` does.
 */
export type ScheduleSummary = ScheduleRecord

export function toScheduleSummary(record: ScheduleRecord): ScheduleSummary {
  return { ...record }
}

/** THE "is there a missed run waiting for the user?" read. Tolerates `null` and absent. */
export function hasMissedRun(
  record: Pick<ScheduleRecord, 'missedRun'> | null | undefined
): boolean {
  const missed = record?.missedRun
  return Boolean(missed && typeof missed === 'object' && typeof missed.dueAt === 'string')
}

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return typeof value === 'string' && (SCHEDULE_KINDS as readonly string[]).includes(value)
}

export function isScheduleDeliveryMode(value: unknown): value is ScheduleDeliveryMode {
  return (
    typeof value === 'string' &&
    (SCHEDULE_DELIVERY_MODES as readonly string[]).includes(value)
  )
}
