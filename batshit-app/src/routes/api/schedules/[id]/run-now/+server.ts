import { json, type RequestHandler } from '@sveltejs/kit'
import { deliverScheduledDm } from '$lib/server/services/dm/dmTools'
import {
  clearMissedRun,
  getOwnedSchedule,
  getSchedule,
  recordFire,
  ScheduleError
} from '$lib/server/services/schedules/scheduleStore'
import { toScheduleSummary } from '$lib/types/schedule'

/**
 * SA-115 P2 (DL-115-07) — **Run now**.
 *
 * Two callers, one behaviour: the row's button in the Schedules card, and *Run now* on an
 * item in the *Missed while Batshit was off* dialog. **This route is the only place a
 * missed run can start** — the ticker collapses missed slots and never fires them, so
 * without a person pressing this button nothing that was due while Batshit was off ever
 * runs.
 *
 * Three deliberate properties:
 *
 *  - It **spends the hourly wake budget** like any other wake, because it is one. A user
 *    clearing a long backlog runs into the same caps an agent would.
 *  - It **does not move the schedule's own clock**. Pressing Run now at 08:55 on a
 *    "daily at 9am" schedule must not skip today's 9am run. A missed run's `nextRunAt` was
 *    already moved forward by the collapse, so there is nothing to advance there either.
 *  - It **clears `missedRun` even when the fire fails**, because the user has now
 *    answered the dialog. Leaving the entry would re-ask a question they already answered;
 *    the failure itself is visible as the schedule's `lastOutcome`.
 *  - It **fires a PAUSED schedule too** (F-P2-3a). There is deliberately no `enabled`
 *    check here: the button says "run this once, now", and a paused schedule is one whose
 *    automatic times are off, not one that is forbidden to run. It is also the only way to
 *    answer a missed-run item for a schedule the user paused afterwards. The card's tooltip
 *    and the UserDocs both say so, because it is the kind of thing somebody would otherwise
 *    file as a bug.
 */

function errorStatus(error: unknown): number {
  return error instanceof ScheduleError ? error.status : 500
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const scheduleId = typeof params.id === 'string' ? params.id : ''
  if (!scheduleId) {
    return json({ success: false, error: 'A schedule id is required.' }, { status: 400 })
  }

  let schedule
  try {
    schedule = await getOwnedSchedule(locals.user.id, scheduleId)
  } catch (error) {
    return json(
      { success: false, error: errorMessage(error, 'That schedule was not found.') },
      { status: errorStatus(error) }
    )
  }

  const now = new Date()
  let outcome: string
  let dmId: string | null = null
  let ok = true

  try {
    const delivered = await deliverScheduledDm(schedule, { trigger: 'run-now', now })
    outcome = delivered.outcome
    dmId = delivered.dmId
  } catch (error) {
    // A failed Run now is recorded and shown, never retried and never hidden. The user
    // pressed a button and is owed a straight answer about what happened.
    ok = false
    outcome = `failed: ${errorMessage(error, 'the schedule could not fire')}`
    console.error(`[Schedules] Run now failed for schedule ${schedule.id}:`, error)
  }

  try {
    await recordFire({ scheduleId: schedule.id, ranAt: now, outcome, dmId })
    await clearMissedRun({ userId: locals.user.id, scheduleId: schedule.id, now })
  } catch (error) {
    // A schedule deleted mid-run is the expected case and is a no-op by design.
    console.warn(`[Schedules] Could not record the Run now of schedule ${schedule.id}:`, error)
  }

  const updated = await getSchedule(schedule.id)
  return json({
    success: ok,
    outcome,
    ...(dmId ? { dmId } : {}),
    ...(ok ? {} : { error: outcome }),
    ...(updated ? { schedule: toScheduleSummary(updated) } : {})
  })
}
