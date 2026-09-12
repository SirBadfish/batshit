import { json, type RequestHandler } from '@sveltejs/kit'
import {
  deleteSchedule,
  patchSchedule,
  ScheduleError
} from '$lib/server/services/schedules/scheduleStore'

/**
 * SA-115 P2 — edit or delete one schedule.
 *
 * The id arrives as a URL path segment, so it is attacker-controlled text. It is never
 * turned into a Redis key before `SCHEDULE_ID_PATTERN` has seen it — the store's
 * `isWellFormedScheduleId` guard runs first on every read, because `schedule:` + `s:{userId}`
 * is byte-identical to the `schedules:{userId}` index SET.
 *
 * Ownership is checked in the store, not here, so every caller gets the same answer: a
 * schedule belonging to somebody else is "not found", never "forbidden" — the difference
 * would confirm the id exists.
 */

function errorStatus(error: unknown): number {
  return error instanceof ScheduleError ? error.status : 500
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function errorHint(error: unknown): string | undefined {
  return error instanceof ScheduleError ? error.hint : undefined
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const scheduleId = typeof params.id === 'string' ? params.id : ''
  if (!scheduleId) {
    return json({ success: false, error: 'A schedule id is required.' }, { status: 400 })
  }

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }
    const schedule = await patchSchedule({
      userId: locals.user.id,
      scheduleId,
      name: body.name,
      cadence: body.cadence,
      timeZone: body.timeZone,
      message: body.message,
      kind: body.kind,
      deliver: body.deliver,
      enabled: body.enabled
    })
    return json({ success: true, schedule })
  } catch (error) {
    if (!(error instanceof ScheduleError)) {
      console.error('[Schedules] Could not update a schedule:', error)
    }
    return json(
      {
        success: false,
        error: errorMessage(error, 'Could not update the schedule.'),
        ...(errorHint(error) ? { hint: errorHint(error) } : {})
      },
      { status: errorStatus(error) }
    )
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  const scheduleId = typeof params.id === 'string' ? params.id : ''
  if (!scheduleId) {
    return json({ success: false, error: 'A schedule id is required.' }, { status: 400 })
  }

  try {
    await deleteSchedule({ userId: locals.user.id, scheduleId })
    return json({ success: true })
  } catch (error) {
    if (!(error instanceof ScheduleError)) {
      console.error('[Schedules] Could not delete a schedule:', error)
    }
    return json(
      { success: false, error: errorMessage(error, 'Could not delete the schedule.') },
      { status: errorStatus(error) }
    )
  }
}
