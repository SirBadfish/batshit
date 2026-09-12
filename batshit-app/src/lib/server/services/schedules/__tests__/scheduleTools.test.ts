import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { MAX_SCHEDULES_PER_AGENT } from '$lib/utils/scheduleControl'
import { createSchedule, getSchedule } from '../scheduleStore'
import {
  createScheduleOp,
  deleteScheduleOp,
  listSchedulesOp,
  ScheduleToolError,
  updateScheduleOp
} from '../scheduleTools'

/**
 * SA-115 P2 (DL-115-10) — `sys.schedule.*`.
 *
 * Two rules carry everything here, and both are asserted from the operations rather than
 * from the registration that is supposed to protect them:
 *
 *  1. **Self-only.** An agent may only touch schedules whose `agentId` is itself. This is
 *     what keeps a misbehaving agent inside its own caps instead of spending a colleague's
 *     hourly wake budget.
 *  2. **The gate is re-checked per operation**, not merely at registration. The broker
 *     allow-list should already have stopped a DM-disabled agent; this is the layer that
 *     makes that true rather than assumed.
 */

useRedisTestServer()

const USER = 'user-schedule-tools'
const OTHER_USER = 'user-somebody-else'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'
const CHICAGO = 'America/Chicago'

async function seedAgent(id: string, userId = USER, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: id === COOPER ? 'Cooper' : 'Faye',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true,
    ...overrides
  } as any)
}

function context(agentId = COOPER, userId = USER) {
  return { userId, agentId }
}

function createInput(overrides: Record<string, any> = {}) {
  return {
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    message: 'Check my open DMs and say what needs me.',
    time_zone: CHICAGO,
    ...overrides
  } as any
}

beforeEach(async () => {
  await seedAgent(COOPER)
  await seedAgent(FAYE)
})

describe('the enablement gate, re-checked per operation', () => {
  it('refuses an agent with Agent DMs off, and says why', async () => {
    await seedAgent('agent-quiet', USER, { dms_enabled: false })
    const quiet = context('agent-quiet')
    for (const run of [
      () => listSchedulesOp(quiet),
      () => createScheduleOp(quiet, createInput()),
      () => updateScheduleOp(quiet, { schedule_id: 'sch_x', name: 'x' } as any),
      () => deleteScheduleOp(quiet, { schedule_id: 'sch_x' })
    ]) {
      await expect(run()).rejects.toThrow(/Agent DMs are not turned on/)
    }
  })

  it('refuses an agent belonging to a different user', async () => {
    await seedAgent('agent-theirs', OTHER_USER)
    await expect(listSchedulesOp(context('agent-theirs'))).rejects.toThrow(
      /does not belong to this user/
    )
  })

  it('refuses a missing agent context', async () => {
    await expect(listSchedulesOp(context('') as any)).rejects.toThrow(/agentId missing/)
  })
})

describe('self-only (DL-115-10)', () => {
  it('creates a schedule for ITSELF, and records that an agent made it', async () => {
    const result = await createScheduleOp(context(), createInput())
    expect(result.created).toBe(true)
    expect(result.schedule.created_by).toBe('agent')

    const stored = await getSchedule(result.schedule.schedule_id)
    // The agent id is server-owned: there is no input field a model could set to point
    // this at somebody else.
    expect(stored?.agentId).toBe(COOPER)
    expect(stored?.createdBy).toEqual({ agentId: COOPER })
  })

  it('lists only its OWN schedules, never a colleague’s', async () => {
    await createScheduleOp(context(), createInput({ name: 'Cooper morning' }))
    await createScheduleOp(context(FAYE), createInput({ name: 'Faye morning' }))

    const mine = await listSchedulesOp(context())
    expect(mine.schedules.map((entry) => entry.name)).toEqual(['Cooper morning'])
    expect(mine.total).toBe(1)
    expect(mine.limit).toBe(MAX_SCHEDULES_PER_AGENT)
  })

  it('REFUSES to update or delete another agent’s schedule, and does not touch it', async () => {
    const theirs = await createSchedule({
      userId: USER,
      agentId: FAYE,
      name: 'Faye morning',
      cadence: { type: 'daily', at: '09:00' },
      timeZone: CHICAGO,
      message: 'Say good morning.'
    })

    await expect(
      updateScheduleOp(context(), { schedule_id: theirs.id, name: 'Hijacked' })
    ).rejects.toThrow(/belongs to a different agent/)
    await expect(deleteScheduleOp(context(), { schedule_id: theirs.id })).rejects.toThrow(
      /belongs to a different agent/
    )

    const stored = await getSchedule(theirs.id)
    expect(stored?.name).toBe('Faye morning')
  })

  it('answers "not found" for another USER’s schedule rather than confirming it exists', async () => {
    await seedAgent('agent-theirs', OTHER_USER)
    const theirs = await createSchedule({
      userId: OTHER_USER,
      agentId: 'agent-theirs',
      name: 'Theirs',
      cadence: { type: 'daily', at: '09:00' },
      timeZone: CHICAGO,
      message: 'Not yours.'
    })
    await expect(
      updateScheduleOp(context(), { schedule_id: theirs.id, name: 'Hijacked' })
    ).rejects.toThrow(/not found/)
  })
})

describe('the operations', () => {
  it('updates only the fields it was given', async () => {
    const created = await createScheduleOp(context(), createInput())
    const id = created.schedule.schedule_id

    const updated = await updateScheduleOp(context(), {
      schedule_id: id,
      message: 'A different message.'
    })
    expect(updated.updated).toBe(true)
    expect(updated.schedule.message).toBe('A different message.')
    expect(updated.schedule.name).toBe('Morning check')
    expect(updated.schedule.cadence).toBe('daily at 9:00 AM')
  })

  it('pauses with enabled false without deleting', async () => {
    const created = await createScheduleOp(context(), createInput())
    const id = created.schedule.schedule_id

    const paused = await updateScheduleOp(context(), { schedule_id: id, enabled: false })
    expect(paused.schedule.enabled).toBe(false)
    // A paused schedule says so instead of quoting a time it will not honour.
    expect(paused.schedule.next_run).toBe('paused, so nothing is scheduled')
    expect(await getSchedule(id)).not.toBeNull()
  })

  it('deletes for good', async () => {
    const created = await createScheduleOp(context(), createInput())
    const id = created.schedule.schedule_id
    const result = await deleteScheduleOp(context(), { schedule_id: id })
    expect(result).toMatchObject({ deleted: true, schedule_id: id, name: 'Morning check' })
    expect(await getSchedule(id)).toBeNull()
  })

  it('REFUSES a bad cadence with a reason instead of clamping it', async () => {
    await expect(
      createScheduleOp(context(), createInput({ cadence: { type: 'interval', everyMinutes: 1 } }))
    ).rejects.toThrow(ScheduleToolError)
    await expect(
      createScheduleOp(context(), createInput({ cadence: { type: 'cron', at: '* * * * *' } }))
    ).rejects.toThrow(ScheduleToolError)
  })

  it('accepts the model-facing snake_case cadence field too', async () => {
    // The schema the agent reads says `every_minutes`; the store's validator reads
    // `everyMinutes`. Both have to work or the documented shape fails on first use.
    const created = await createScheduleOp(
      context(),
      createInput({ cadence: { type: 'interval', every_minutes: 30 } })
    )
    expect(created.schedule.cadence).toBe('every 30 min')
  })

  it('tells the agent a missed run is waiting, and that only the user can act on it', async () => {
    const created = await createScheduleOp(context(), createInput())
    await redis.json.set(`schedule:${created.schedule.schedule_id}`, '$.missedRun', {
      dueAt: '2026-09-01T14:00:00.000Z',
      count: 3,
      noticedAt: '2026-09-08T15:00:00.000Z'
    } as never)

    const listed = await listSchedulesOp(context())
    // DL-115-07: an agent that could start its own missed run would be exactly the
    // "it fired in the dark" outcome the missed-run rule exists to prevent.
    expect(listed.schedules[0].missed_run).toMatchObject({ count: 3 })
    expect(listed.schedules[0].missed_run.note).toContain('Only they can')
  })
})
