import { json, type RequestHandler } from '@sveltejs/kit'
import {
  clearMissedRun,
  ScheduleError
} from '$lib/server/services/schedules/scheduleStore'

/**
 * SA-115 P2 (DL-115-03, DL-115-07) — **Skip**.
 *
 * Skip means *skip this one run*. The schedule stays on and runs again at its next time —
 * which is why the word is "Skip" and never "Cancel" (Josh's wording lock): "Cancel" reads
 * as turning the schedule off, which this does not do. It clears the missed-run entry and
 * touches nothing else — not `enabled`, not `nextRunAt`, not the run count.
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

  try {
    const schedule = await clearMissedRun({ userId: locals.user.id, scheduleId })
    return json({ success: true, schedule })
  } catch (error) {
    if (!(error instanceof ScheduleError)) {
      console.error('[Schedules] Could not skip a missed run:', error)
    }
    return json(
      { success: false, error: errorMessage(error, 'Could not skip that missed run.') },
      { status: errorStatus(error) }
    )
  }
}
