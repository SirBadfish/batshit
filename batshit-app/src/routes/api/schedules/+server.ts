import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  createSchedule,
  listSchedules,
  ScheduleError
} from '$lib/server/services/schedules/scheduleStore'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

/**
 * SA-115 P2 (DL-115-01, DL-115-09) — the Admin "Schedules" card's list and create.
 *
 * Cookie-only, like every other Admin surface and like the `wake-hooks` routes this
 * copies. There is no inbound counterpart: a schedule is Batshit's own clock, so nothing
 * outside the app ever posts to it. The one internal caller is
 * `POST /api/internal/schedules/sweep`, which authenticates as a trusted internal request
 * and must never be confused for one of these.
 *
 * Object-shape validation lives here; every field rule lives in
 * `$lib/utils/scheduleControl.ts` so the card, `sys.schedule.*`, and these routes refuse
 * the same things for the same reasons.
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

/**
 * The agents a schedule may point at.
 *
 * Only API/CLI primaries with **Agent DMs on** are eligible (AMD-113-05 parity): a fire
 * writes a DM, so an agent with DMs off would never see it and would have no `sys.dm.*`
 * tools to close it with. The card shows this list rather than every agent, and says why
 * when it is empty, so nobody discovers the rule from a 400 after filling in a form.
 */
async function listEligibleAgents(userId: string) {
  const agents = await redis.getAgents(userId)
  return agents
    .map((agent) => agent as unknown as Record<string, any>)
    .filter((agent) => {
      const type = normalizePrimaryAgentType(agent as any)
      return (type === 'api' || type === 'cli') && resolveAgentDmsEnabled(agent)
    })
    .map((agent) => ({
      id: agent.id,
      name:
        (typeof agent.displayName === 'string' && agent.displayName.trim()) ||
        (typeof agent.name === 'string' && agent.name.trim()) ||
        agent.id
    }))
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const [schedules, agents] = await Promise.all([
      listSchedules(locals.user.id),
      listEligibleAgents(locals.user.id)
    ])
    return json({ success: true, schedules, agents })
  } catch (error) {
    console.error('[Schedules] Could not list schedules:', error)
    return json(
      { success: false, error: errorMessage(error, 'Could not list schedules.') },
      { status: errorStatus(error) }
    )
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const schedule = await createSchedule({
      userId: locals.user.id,
      agentId: body.agentId,
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
      console.error('[Schedules] Could not create a schedule:', error)
    }
    // A cap refusal carries its own hint ("Delete a schedule you no longer need first"),
    // and the card shows both verbatim rather than inventing friendlier wording.
    return json(
      {
        success: false,
        error: errorMessage(error, 'Could not create the schedule.'),
        ...(errorHint(error) ? { hint: errorHint(error) } : {})
      },
      { status: errorStatus(error) }
    )
  }
}
