/**
 * SA-115 P1 (DL-115-06, DL-115-07, DL-115-08) — Batshit's clock.
 *
 * One in-process 60-second interval, armed from `hooks.server.ts`'s startup-integrity
 * pass beside `startMemoryDreamingScheduler`. Native, Docker, and the packaged Mac app all
 * run this same SvelteKit node server, so one code path serves all three lanes.
 *
 * **It arms on the first HTTP request after boot, not at module load** — and that is
 * enough on every launcher-started lane, because something already sends that request
 * with no tab open:
 *
 *   - packaged Mac app: the runtime supervisor polls `/` every 5 seconds, forever.
 *   - Docker Compose: the healthcheck fetches `/api/health` every 10 seconds, forever.
 *   - source checkout: the dev launcher waits on `/` (and on `/api/health`) during startup.
 *
 * The one honest gap is `npm run dev` started by hand with no launcher and no tab open.
 * That is a developer-only case; it is recorded rather than fixed.
 *
 * ## The two things a sweep can do, and the one it cannot
 *
 * For each enabled schedule whose next run has arrived:
 *
 *   - **Fire**, when it is overdue by no more than `LATE_FIRE_GRACE_MS`. The DM says when
 *     the run was due, so a late fire is visibly late.
 *   - **Collapse**, when it is overdue by more than that. The slots that went by are
 *     folded into one `missedRun` entry, `nextRunAt` moves to the next future slot, and
 *     **nothing fires**. Only the user's **Run now** can start a missed run.
 *
 * It can never queue. A schedule missed three times shows "missed 3" and fires at most
 * once, when a person says so. Nothing here retries, and nothing waits in the dark.
 */

import {
  LATE_FIRE_GRACE_MS,
  SCHEDULE_TICK_MS,
  computeNextRunAt
} from '$lib/utils/scheduleControl'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { deliverScheduledDm } from '$lib/server/services/dm/dmTools'
import type { ScheduleRecord } from '$lib/types/schedule'
import {
  collapseMissedRun,
  disableScheduleAfterFailure,
  listDueSchedules,
  recordFire
} from './scheduleStore'

const TICKER_FLAG = Symbol.for('batshit.scheduleTicker')

let sweepInProgress = false

export interface ScheduleFireReport {
  scheduleId: string
  name: string
  agentId: string
  dueAt: string
  /** False when the fire threw. The schedule still advanced; the reason is in `outcome`. */
  ok: boolean
  deliveredAs?: 'wait' | 'wake'
  sessionId?: string
  dmId?: string
  outcome: string
}

export interface ScheduleMissedReport {
  scheduleId: string
  name: string
  agentId: string
  timeZone: string
  dueAt: string
  count: number
  nextRunAt: string
}

export interface ScheduleSweepReport {
  at: string
  fired: ScheduleFireReport[]
  missed: ScheduleMissedReport[]
  skipped: { scheduleId: string; reason: string }[]
}

/**
 * One sweep. Exported so the internal trigger route (DL-115-13) and the dev smoke row can
 * prove a fire, a late fire, and a missed-run collapse without waiting a minute or a day.
 *
 * Schedules are handled **one at a time**: a fire can start a whole agent turn, and three
 * of them racing would spend the hourly wake budget in an order nobody chose.
 */
export async function runScheduleSweep(now = new Date()): Promise<ScheduleSweepReport> {
  const report: ScheduleSweepReport = { at: now.toISOString(), fired: [], missed: [], skipped: [] }
  if (sweepInProgress) {
    report.skipped.push({ scheduleId: '*', reason: 'A schedule sweep was already running.' })
    return report
  }
  sweepInProgress = true

  /** Newly collapsed runs, grouped so each user gets ONE `schedule_missed` event. */
  const missedByUser = new Map<string, ScheduleMissedReport[]>()

  try {
    const due = await listDueSchedules(now)

    for (const schedule of due) {
      const dueAt = new Date(Date.parse(schedule.nextRunAt))
      if (!Number.isFinite(dueAt.getTime())) {
        report.skipped.push({
          scheduleId: schedule.id,
          reason: 'Its next run time could not be read.'
        })
        continue
      }

      const overdueBy = now.getTime() - dueAt.getTime()

      if (overdueBy > LATE_FIRE_GRACE_MS) {
        try {
          const collapsed = await collapseMissedRun({ schedule, now })
          const entry: ScheduleMissedReport = {
            scheduleId: schedule.id,
            name: schedule.name,
            agentId: schedule.agentId,
            timeZone: schedule.timeZone,
            dueAt: collapsed.dueAt,
            count: collapsed.count,
            nextRunAt: collapsed.nextRunAt
          }
          report.missed.push(entry)
          const bucket = missedByUser.get(schedule.userId) ?? []
          bucket.push(entry)
          missedByUser.set(schedule.userId, bucket)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(
            `[Schedules] Could not collapse the missed runs of schedule ${schedule.id}:`,
            error
          )
          report.skipped.push({ scheduleId: schedule.id, reason })
          // PR #106 review F-3: a collapse that cannot compute the next run would throw here
          // again every 60 seconds, forever, with nothing on the Admin card. Stop it and say why.
          await stopScheduleThatCannotAdvance(schedule.id, reason, now)
        }
        continue
      }

      report.fired.push(await fireSchedule(schedule, dueAt, now))
    }
  } finally {
    sweepInProgress = false
  }

  for (const [userId, schedules] of missedByUser) {
    // The dialog is the ONLY place a missed run can start, so it has to hear about one
    // the moment it is noticed rather than on the next page load.
    await publishUserEvent(userId, { type: 'schedule_missed', schedules })
  }

  return report
}

/**
 * Fire one schedule and move it on.
 *
 * A fire that throws is recorded as `failed: <reason>` and **still advances
 * `nextRunAt`**. Retrying the same slot every minute would turn one broken schedule into
 * a storm against a provider, an agent's hourly wake budget, and the log.
 */
async function fireSchedule(
  schedule: ScheduleRecord,
  dueAt: Date,
  now: Date
): Promise<ScheduleFireReport> {
  const base: Pick<ScheduleFireReport, 'scheduleId' | 'name' | 'agentId' | 'dueAt'> = {
    scheduleId: schedule.id,
    name: schedule.name,
    agentId: schedule.agentId,
    dueAt: dueAt.toISOString()
  }

  let outcome: string
  let dmId: string | null = null
  let ok = true
  let deliveredAs: 'wait' | 'wake' | undefined
  let sessionId: string | undefined

  try {
    const delivered = await deliverScheduledDm(schedule, { trigger: 'tick', dueAt, now })
    outcome = delivered.outcome
    dmId = delivered.dmId
    deliveredAs = delivered.deliveredAs
    sessionId = delivered.sessionId
  } catch (error) {
    ok = false
    const reason = error instanceof Error ? error.message : String(error)
    outcome = `failed: ${reason}`
    console.error(`[Schedules] Schedule ${schedule.id} ("${schedule.name}") failed to fire:`, error)
  }

  // AMD-115-03 — the anchor is the slot this run was DUE, not the moment it actually fired.
  // A sweep is up to 60 seconds late by construction; anchoring on `now` would add that
  // lateness to every period and compound it, so "every 30 minutes" would slowly become
  // every 31. Anchoring on `dueAt` keeps the grid.
  //
  // PR #106 review F-3: computed on its own, BEFORE `recordFire`. Evaluated inside that call's
  // argument object, a throw here (an unresolvable stored zone) skipped the whole record —
  // no `lastOutcome`, no advanced `nextRunAt` — and the same slot fired again every sweep.
  let nextRunAt: Date | null = null
  let cannotAdvance: string | null = null
  try {
    nextRunAt = computeNextRunAt(schedule.cadence, schedule.timeZone, now, dueAt)
  } catch (error) {
    ok = false
    cannotAdvance = error instanceof Error ? error.message : String(error)
    outcome = `failed: ${cannotAdvance}`
    console.error(
      `[Schedules] Schedule ${schedule.id} ("${schedule.name}") cannot compute its next run:`,
      error
    )
  }

  try {
    await recordFire({
      scheduleId: schedule.id,
      ranAt: now,
      outcome,
      dmId,
      ...(nextRunAt ? { nextRunAt } : {})
    })
  } catch (error) {
    // A schedule deleted mid-fire is the expected case here and is a no-op by design
    // (path-scoped writes). Anything else is worth seeing.
    console.warn(`[Schedules] Could not record the fire of schedule ${schedule.id}:`, error)
  }
  if (cannotAdvance) await stopScheduleThatCannotAdvance(schedule.id, cannotAdvance, now)

  return {
    ...base,
    ok,
    ...(deliveredAs ? { deliveredAs } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(dmId ? { dmId } : {}),
    outcome
  }
}

/**
 * PR #106 review F-3 — switch a schedule off with its reason, never throwing from a sweep.
 * A schedule deleted in the meantime is a no-op; anything else is logged and the sweep goes on.
 */
async function stopScheduleThatCannotAdvance(scheduleId: string, reason: string, now: Date) {
  try {
    await disableScheduleAfterFailure(scheduleId, reason, now)
    console.error(
      `[Schedules] Schedule ${scheduleId} was switched off: it cannot compute its next run (${reason}). Edit it to turn it back on.`
    )
  } catch (error) {
    console.warn(`[Schedules] Could not switch off schedule ${scheduleId} after a failure:`, error)
  }
}

/**
 * Idempotent interval start, `globalThis`-guarded so a dev-server module reload cannot
 * double-arm it and `unref`'d so the clock never holds the process open.
 *
 * The `[Schedules] ticker armed` line is the boot-arming proof: it appears exactly once
 * per process, in the launcher's log, before any tab is opened.
 */
export function startScheduleTicker(): void {
  const globalState = globalThis as Record<PropertyKey, unknown>
  if (globalState[TICKER_FLAG]) return

  const timer = setInterval(() => {
    void runScheduleSweep().catch((error) => {
      console.error('[Schedules] Sweep failed:', error)
    })
  }, SCHEDULE_TICK_MS)

  if (typeof timer === 'object' && timer && 'unref' in timer) {
    ;(timer as NodeJS.Timeout).unref()
  }
  globalState[TICKER_FLAG] = timer
  console.info(
    `[Schedules] ticker armed (every ${Math.round(SCHEDULE_TICK_MS / 1000)}s, late-fire grace ${Math.round(LATE_FIRE_GRACE_MS / 60_000)} min).`
  )
}

/** Tests only: stop and forget the interval so suites do not leak timers into each other. */
export function __resetScheduleTickerForTests(): void {
  const globalState = globalThis as Record<PropertyKey, unknown>
  const timer = globalState[TICKER_FLAG]
  if (timer) clearInterval(timer as NodeJS.Timeout)
  delete globalState[TICKER_FLAG]
  sweepInProgress = false
}
