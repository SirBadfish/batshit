import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { countRedisCommands } from '$lib/test-utils/redis-command-counter'
import { redis } from '$lib/server/redis'
import {
  MAX_SCHEDULES_PER_AGENT,
  MAX_SCHEDULES_PER_INSTANCE
} from '$lib/utils/scheduleControl'
import {
  SCHEDULE_DUE_CACHE_MAX_MS,
  ScheduleError,
  __resetScheduleDueCacheForTests,
  clearMissedRun,
  collapseMissedRun,
  createSchedule,
  deleteSchedule,
  disableScheduleAfterFailure,
  getSchedule,
  listDueSchedules,
  listSchedules,
  orderScheduleFieldWrites,
  patchSchedule,
  recordFire,
  sweepAgentSchedules
} from '../scheduleStore'
import { isWellFormedScheduleId, schedulesIndexKey } from '../scheduleKeys'

/**
 * SA-115 P1 (DL-115-02) — the schedule records.
 *
 * The claims that matter here are Redis claims, so this suite is on the curated
 * `npm run test:redis` lane in `.github/workflows/ci.yml` as well as the default fake
 * lane: a path write that must be a no-op on a deleted key, an index that must be a SET,
 * and an id guard that exists because two key spaces overlap.
 */

useRedisTestServer()

const USER = 'user-schedules'
const OTHER_USER = 'user-other'
const COOPER = 'agent-cooper'
const FAYE = 'agent-faye'
const CHICAGO = 'America/Chicago'

async function seedAgent(id: string, userId = USER, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: id.replace('agent-', '').replace(/^./, (c) => c.toUpperCase()),
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true,
    ...overrides
  } as any)
}

function baseInput(overrides: Record<string, any> = {}) {
  return {
    userId: USER,
    agentId: COOPER,
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: CHICAGO,
    message: 'Say good morning.',
    ...overrides
  }
}

async function indexMembers(userId: string): Promise<string[]> {
  const members = await redis.execute(async (client) => client.sMembers(schedulesIndexKey(userId)))
  return Array.isArray(members) ? (members as string[]) : []
}

beforeEach(async () => {
  // The due cache is module-level, so it outlives a test unless it is cleared. Every
  // assertion below about walking or not walking depends on starting from "unknown".
  __resetScheduleDueCacheForTests()
  await seedAgent(COOPER)
  await seedAgent(FAYE)
})

describe('creating a schedule', () => {
  it('stores the record, indexes it, and computes the first run', async () => {
    const now = new Date('2026-09-08T15:00:00.000Z')
    const record = await createSchedule(baseInput({ now }))

    expect(record.id.startsWith('sch_')).toBe(true)
    expect(record.enabled).toBe(true)
    expect(record.kind).toBe('info')
    expect(record.deliver).toBe('wake')
    expect(record.runCount).toBe(0)
    expect(record.lastRunAt).toBeNull()
    expect(record.missedRun).toBeNull()
    expect(record.createdBy).toBe('user')
    // 15:00Z on 2026-09-08 is 10:00 in Chicago, so the first 09:00 run is tomorrow.
    expect(record.nextRunAt).toBe('2026-09-09T14:00:00.000Z')

    expect(await indexMembers(USER)).toEqual([record.id])
    const stored = await getSchedule(record.id)
    expect(stored?.name).toBe('Morning check')
  })

  it('records the agent that created it, for the card', async () => {
    const record = await createSchedule(baseInput({ createdBy: { agentId: COOPER } }))
    expect(record.createdBy).toEqual({ agentId: COOPER })
  })

  it('refuses an agent that does not exist or belongs to somebody else', async () => {
    await expect(createSchedule(baseInput({ agentId: 'agent-nope' }))).rejects.toThrow(ScheduleError)
    await seedAgent('agent-theirs', OTHER_USER)
    await expect(createSchedule(baseInput({ agentId: 'agent-theirs' }))).rejects.toThrow(
      ScheduleError
    )
  })

  it('refuses an agent with Agent DMs turned off (AMD-113-05 parity)', async () => {
    await seedAgent('agent-quiet', USER, { dms_enabled: false })
    await expect(createSchedule(baseInput({ agentId: 'agent-quiet' }))).rejects.toThrow(
      /Agent DMs/i
    )
  })

  it('refuses an agent that is not an API or CLI primary', async () => {
    await seedAgent('agent-n8n', USER, { agentType: 'n8n' })
    await expect(createSchedule(baseInput({ agentId: 'agent-n8n' }))).rejects.toThrow(
      /API and CLI/i
    )
  })

  it('refuses an invalid cadence rather than clamping it', async () => {
    await expect(
      createSchedule(baseInput({ cadence: { type: 'interval', everyMinutes: 1 } }))
    ).rejects.toThrow(ScheduleError)
    expect(await listSchedules(USER)).toHaveLength(0)
  })

  it('REFUSES past the per-agent cap, with the number in the reason', async () => {
    for (let index = 0; index < MAX_SCHEDULES_PER_AGENT; index += 1) {
      await createSchedule(baseInput({ name: `Check ${index}` }))
    }
    await expect(createSchedule(baseInput({ name: 'One too many' }))).rejects.toThrow(
      new RegExp(String(MAX_SCHEDULES_PER_AGENT))
    )
    // The cap refuses; it does not silently drop an older schedule.
    expect(await listSchedules(USER)).toHaveLength(MAX_SCHEDULES_PER_AGENT)
  })

  it('REFUSES past the per-instance cap across agents', async () => {
    const agents: string[] = []
    const needed = Math.ceil(MAX_SCHEDULES_PER_INSTANCE / MAX_SCHEDULES_PER_AGENT) + 1
    for (let index = 0; index < needed; index += 1) {
      const id = `agent-bulk-${index}`
      await seedAgent(id)
      agents.push(id)
    }

    let created = 0
    let refusal: unknown = null
    outer: for (const agentId of agents) {
      for (let index = 0; index < MAX_SCHEDULES_PER_AGENT; index += 1) {
        try {
          await createSchedule(baseInput({ agentId, name: `${agentId}-${index}` }))
          created += 1
        } catch (error) {
          refusal = error
          break outer
        }
      }
    }

    expect(created).toBe(MAX_SCHEDULES_PER_INSTANCE)
    expect(String(refusal)).toMatch(new RegExp(String(MAX_SCHEDULES_PER_INSTANCE)))
  })
})

describe('the id guard', () => {
  it('refuses anything that is not `sch_` + base64url', () => {
    expect(isWellFormedScheduleId('sch_abc-DEF_123')).toBe(true)
    expect(isWellFormedScheduleId('sch_')).toBe(false)
    expect(isWellFormedScheduleId('whk_abc')).toBe(false)
    expect(isWellFormedScheduleId(`s:${USER}`)).toBe(false)
    expect(isWellFormedScheduleId('sch_' + 'a'.repeat(65))).toBe(false)
    expect(isWellFormedScheduleId(null)).toBe(false)
  })

  it('never turns a crafted id into a read of the index SET', async () => {
    // `schedule:` + `s:{userId}` is byte-identical to `schedules:{userId}` — the exact
    // collision that made the wake-hook route answer 500 and leak whether a user id was
    // real. With a live index in place this must still be a quiet "no such schedule".
    await createSchedule(baseInput())
    expect(await indexMembers(USER)).toHaveLength(1)
    await expect(getSchedule(`s:${USER}`)).resolves.toBeNull()
  })
})

describe('listing', () => {
  it('prunes an index member whose record is gone', async () => {
    const record = await createSchedule(baseInput())
    await redis.del(`schedule:${record.id}`)

    expect(await listSchedules(USER)).toHaveLength(0)
    expect(await indexMembers(USER)).toHaveLength(0)
  })

  it('returns only enabled, due schedules, oldest due first', async () => {
    const now = new Date('2026-09-08T15:00:00.000Z')
    const due = await createSchedule(baseInput({ name: 'Due', now }))
    const alsoDue = await createSchedule(baseInput({ name: 'Also due', now }))
    const paused = await createSchedule(baseInput({ name: 'Paused', now }))
    const future = await createSchedule(baseInput({ name: 'Future', now }))

    await redis.json.set(`schedule:${due.id}`, '$.nextRunAt', '2026-09-08T12:00:00.000Z' as never)
    await redis.json.set(
      `schedule:${alsoDue.id}`,
      '$.nextRunAt',
      '2026-09-08T11:00:00.000Z' as never
    )
    await redis.json.set(`schedule:${paused.id}`, '$.nextRunAt', '2026-09-08T10:00:00.000Z' as never)
    await redis.json.set(`schedule:${paused.id}`, '$.enabled', false as never)

    const result = await listDueSchedules(new Date('2026-09-08T13:00:00.000Z'), { walk: true })
    expect(result.map((entry) => entry.name)).toEqual(['Also due', 'Due'])
    expect(result.map((entry) => entry.id)).not.toContain(future.id)
    // A paused schedule is skipped entirely — it is off, not "missed".
    expect(result.map((entry) => entry.id)).not.toContain(paused.id)
  })
})

describe('editing', () => {
  it('recomputes the next run when the cadence changes', async () => {
    const record = await createSchedule(
      baseInput({ now: new Date('2026-09-08T15:00:00.000Z') })
    )
    expect(record.nextRunAt).toBe('2026-09-09T14:00:00.000Z')

    const updated = await patchSchedule({
      userId: USER,
      scheduleId: record.id,
      cadence: { type: 'daily', at: '17:00' },
      now: new Date('2026-09-08T15:00:00.000Z')
    })
    // 17:00 Chicago on the 8th is 22:00Z, still ahead of 15:00Z, so it moves to today.
    expect(updated.nextRunAt).toBe('2026-09-08T22:00:00.000Z')
  })

  it('recomputes the next run when the time zone changes', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    const updated = await patchSchedule({
      userId: USER,
      scheduleId: record.id,
      timeZone: 'UTC',
      now: new Date('2026-09-08T15:00:00.000Z')
    })
    expect(updated.timeZone).toBe('UTC')
    expect(updated.nextRunAt).toBe('2026-09-09T09:00:00.000Z')
  })

  it('leaves the next run alone for a rename', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    const updated = await patchSchedule({
      userId: USER,
      scheduleId: record.id,
      name: 'Renamed',
      now: new Date('2026-09-08T16:00:00.000Z')
    })
    expect(updated.name).toBe('Renamed')
    expect(updated.nextRunAt).toBe(record.nextRunAt)
  })

  it('recomputes when a paused schedule is switched back on, but not when it is paused', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    const paused = await patchSchedule({
      userId: USER,
      scheduleId: record.id,
      enabled: false,
      now: new Date('2026-09-08T16:00:00.000Z')
    })
    expect(paused.enabled).toBe(false)
    expect(paused.nextRunAt).toBe(record.nextRunAt)

    const resumed = await patchSchedule({
      userId: USER,
      scheduleId: record.id,
      enabled: true,
      now: new Date('2026-09-20T15:00:00.000Z')
    })
    expect(resumed.enabled).toBe(true)
    // A schedule switched back on a fortnight later must not look overdue.
    expect(resumed.nextRunAt).toBe('2026-09-21T14:00:00.000Z')
  })

  it('refuses an invalid edit and leaves the stored record untouched', async () => {
    const record = await createSchedule(baseInput())
    await expect(
      patchSchedule({ userId: USER, scheduleId: record.id, timeZone: 'Not/AZone' })
    ).rejects.toThrow(ScheduleError)
    expect((await getSchedule(record.id))?.timeZone).toBe(CHICAGO)
  })
})

describe('path-scoped writes (F-P3-2)', () => {
  it('a patch after a delete writes NOTHING — no resurrection', async () => {
    const record = await createSchedule(baseInput())
    await deleteSchedule({ userId: USER, scheduleId: record.id })

    // The exact race the wake-hook store documents: the ticker holds a schedule it read a
    // moment ago while the user deletes it in the Admin card. A whole-record write would
    // re-create the key with `enabled: true` and no index entry — a clock nothing in the
    // UI could ever stop.
    await recordFire({
      scheduleId: record.id,
      ranAt: new Date('2026-09-08T15:00:00.000Z'),
      outcome: 'woke: session-x',
      dmId: 'dm_x',
      nextRunAt: new Date('2026-09-09T14:00:00.000Z')
    }).catch(() => undefined)

    expect(await getSchedule(record.id)).toBeNull()
    expect(await indexMembers(USER)).toHaveLength(0)
  })

  it('a collapse after a delete writes NOTHING', async () => {
    const record = await createSchedule(baseInput())
    const stored = await getSchedule(record.id)
    await deleteSchedule({ userId: USER, scheduleId: record.id })

    await expect(
      collapseMissedRun({ schedule: stored!, now: new Date(Date.parse(stored!.nextRunAt) + 3_600_000) })
    ).rejects.toThrow()
    expect(await getSchedule(record.id)).toBeNull()
  })
})

describe('recording a fire', () => {
  it('writes the outcome, the DM, the next run, and counts the run', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    await recordFire({
      scheduleId: record.id,
      ranAt: new Date('2026-09-09T14:00:05.000Z'),
      outcome: 'woke: session-abc',
      dmId: 'dm_abc',
      nextRunAt: new Date('2026-09-10T14:00:00.000Z')
    })

    const stored = await getSchedule(record.id)
    expect(stored?.lastRunAt).toBe('2026-09-09T14:00:05.000Z')
    expect(stored?.lastOutcome).toBe('woke: session-abc')
    expect(stored?.lastDmId).toBe('dm_abc')
    expect(stored?.nextRunAt).toBe('2026-09-10T14:00:00.000Z')
    expect(stored?.runCount).toBe(1)

    await recordFire({
      scheduleId: record.id,
      ranAt: new Date('2026-09-10T14:00:02.000Z'),
      outcome: 'failed: the agent was deleted',
      nextRunAt: new Date('2026-09-11T14:00:00.000Z')
    })
    const after = await getSchedule(record.id)
    expect(after?.runCount).toBe(2)
    expect(after?.lastOutcome).toBe('failed: the agent was deleted')
    // A failed fire clears the previous DM link rather than leaving a stale one.
    expect(after?.lastDmId).toBeNull()
  })
})

describe('missed runs', () => {
  it('collapses several slots into ONE entry and moves the next run into the future', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    const stored = await getSchedule(record.id)
    const now = new Date('2026-09-11T13:00:00.000Z')

    // The first slot is the 9th, so the 9th and the 10th went by; the 11th at 09:00
    // Chicago (14:00Z) is still ahead of `now` and is therefore not missed.
    const result = await collapseMissedRun({ schedule: stored!, now })
    expect(result.count).toBe(2)
    expect(result.dueAt).toBe('2026-09-10T14:00:00.000Z')

    const after = await getSchedule(record.id)
    expect(after?.missedRun).toEqual({
      dueAt: '2026-09-10T14:00:00.000Z',
      count: 2,
      noticedAt: now.toISOString()
    })
    expect(Date.parse(after!.nextRunAt)).toBeGreaterThan(now.getTime())
  })

  it('adds to an existing entry rather than replacing it, because nothing was addressed', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    const first = await getSchedule(record.id)
    await collapseMissedRun({ schedule: first!, now: new Date('2026-09-10T13:00:00.000Z') })

    const second = await getSchedule(record.id)
    expect(second?.missedRun?.count).toBe(1)

    await collapseMissedRun({ schedule: second!, now: new Date('2026-09-13T13:00:00.000Z') })
    const third = await getSchedule(record.id)
    // One the first time, three more the second (the 10th, 11th and 12th): the number a
    // person reads means "runs you have missed", not "runs missed since I last looked".
    expect(third?.missedRun?.count).toBe(4)
    expect(third?.missedRun?.dueAt).toBe('2026-09-12T14:00:00.000Z')
  })

  it('is cleared by Skip, leaving the schedule running', async () => {
    const record = await createSchedule(baseInput({ now: new Date('2026-09-08T15:00:00.000Z') }))
    const stored = await getSchedule(record.id)
    await collapseMissedRun({ schedule: stored!, now: new Date('2026-09-11T13:00:00.000Z') })

    const cleared = await clearMissedRun({ userId: USER, scheduleId: record.id })
    expect(cleared.missedRun).toBeNull()
    expect(cleared.enabled).toBe(true)
    expect(Date.parse(cleared.nextRunAt)).toBeGreaterThan(Date.parse('2026-09-11T13:00:00.000Z'))
  })
})

describe('ownership', () => {
  it('refuses every owned operation on another user’s schedule', async () => {
    const record = await createSchedule(baseInput())
    await expect(
      patchSchedule({ userId: OTHER_USER, scheduleId: record.id, name: 'Theirs now' })
    ).rejects.toThrow(ScheduleError)
    await expect(
      clearMissedRun({ userId: OTHER_USER, scheduleId: record.id })
    ).rejects.toThrow(ScheduleError)
    await expect(
      deleteSchedule({ userId: OTHER_USER, scheduleId: record.id })
    ).rejects.toThrow(ScheduleError)
    expect(await getSchedule(record.id)).not.toBeNull()
  })
})

describe('deleting', () => {
  it('removes the record and its index member', async () => {
    const record = await createSchedule(baseInput())
    await deleteSchedule({ userId: USER, scheduleId: record.id })
    expect(await getSchedule(record.id)).toBeNull()
    expect(await indexMembers(USER)).toHaveLength(0)
  })

  it('sweeps only the deleted agent’s schedules', async () => {
    const cooperSchedule = await createSchedule(baseInput({ name: 'Cooper morning' }))
    const fayeSchedule = await createSchedule(
      baseInput({ agentId: FAYE, name: 'Faye morning' })
    )

    const removed = await sweepAgentSchedules(COOPER)
    expect(removed).toBe(1)
    expect(await getSchedule(cooperSchedule.id)).toBeNull()
    expect(await getSchedule(fayeSchedule.id)).not.toBeNull()
    expect(await indexMembers(USER)).toEqual([fayeSchedule.id])
  })

  it('does nothing when the agent record is already gone', async () => {
    await createSchedule(baseInput())
    await redis.del(`agent:${COOPER}`)
    // `sweepAgentSchedules` reads `agent.user_id`, so `deleteAgent` must call it BEFORE
    // removing the record. This pins the failure mode if that order ever flips.
    expect(await sweepAgentSchedules(COOPER)).toBe(0)
  })
})

describe('SA-115 F-P1-4 — the store is honest about what happened', () => {
  /**
   * (a) Path writes go one field at a time, so the ORDER is observable to a sweep running
   * beside them. On a re-enable the old code wrote `enabled: true` first and the
   * recomputed `nextRunAt` after — and `listDueSchedules` reads exactly those two fields.
   * A sweep landing between them saw an enabled schedule still carrying its stale,
   * long-past next run, collapsed a missed run that never happened, and showed the user
   * the *Missed while Batshit was off* dialog for a schedule they had just switched on.
   */
  it('writes nextRunAt BEFORE enabled, so a sweep can never see a stale pair', () => {
    // `orderScheduleFieldWrites` IS the order the fields hit Redis, so asserting it here
    // asserts the invariant itself rather than a spy's view of the client.
    const ordered = orderScheduleFieldWrites({
      name: 'Morning check',
      // Deliberately written in the WRONG order, the way `patchSchedule`'s object literal
      // happens to read today. The rule must not depend on that literal staying tidy.
      enabled: true,
      nextRunAt: '2026-09-08T17:30:00.000Z',
      updatedAt: '2026-09-08T17:00:00.000Z'
    }).map(([field]) => field)

    expect(ordered.indexOf('nextRunAt')).toBeLessThan(ordered.indexOf('enabled'))
    // `enabled` is the LAST write, full stop — the ticker reads it to decide a schedule
    // exists for this sweep, so every other field must already be settled behind it.
    expect(ordered[ordered.length - 1]).toBe('enabled')
    // Nothing else is reordered; the rule is narrow on purpose.
    expect(ordered).toEqual(['name', 'nextRunAt', 'updatedAt', 'enabled'])
  })

  it('re-enabling recomputes the next run from NOW, so nothing is retroactively missed', async () => {
    const record = await createSchedule(
      baseInput({
        cadence: { type: 'interval', everyMinutes: 30 },
        enabled: false,
        now: new Date('2026-09-08T09:00:00.000Z')
      })
    )
    // Eight hours later the stored next run is long past. Switching the schedule back on
    // must move it forward, not hand the sweep an overdue slot.
    const now = new Date('2026-09-08T17:00:00.000Z')
    const updated = await patchSchedule({ userId: USER, scheduleId: record.id, enabled: true, now })

    expect(updated.enabled).toBe(true)
    expect(Date.parse(updated.nextRunAt)).toBeGreaterThan(now.getTime())
    expect(await listDueSchedules(now, { walk: true })).toHaveLength(0)
  })

  /**
   * (b) Every throw used to become a 404 "that schedule was not found", so a Redis outage
   * or a WRONGTYPE told the user their schedule did not exist. Only the reply that really
   * means "the record is gone" may be swallowed.
   */
  it('turns a MISSING record into a clean 404', async () => {
    const record = await createSchedule(baseInput())
    await redis.del(`schedule:${record.id}`)

    // A path write cannot create the root, so this is a no-op rather than a resurrection.
    await expect(
      recordFire({
        scheduleId: record.id,
        ranAt: new Date(),
        outcome: 'woke: session-1',
        nextRunAt: new Date('2026-09-09T14:00:00.000Z')
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(await getSchedule(record.id)).toBeNull()
  })

  it('RETHROWS a real Redis failure instead of calling it "not found"', async () => {
    const record = await createSchedule(baseInput())
    const outage = new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    const spy = vi.spyOn(redis.json, 'set').mockRejectedValue(outage)

    try {
      await expect(
        patchSchedule({ userId: USER, scheduleId: record.id, name: 'Renamed' })
      ).rejects.toThrow(/WRONGTYPE/)
      // And specifically NOT the reassuring 404 the old code produced.
      await expect(
        patchSchedule({ userId: USER, scheduleId: record.id, name: 'Renamed' })
      ).rejects.not.toBeInstanceOf(ScheduleError)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not lose a recorded fire when only the run counter fails', async () => {
    const record = await createSchedule(baseInput())
    const spy = vi
      .spyOn(redis.json, 'numIncrBy')
      .mockRejectedValue(new Error('ECONNRESET: the connection went away'))

    try {
      // The fire itself already happened and is on its DM, so this must not throw — but
      // it must not be silent either, which is why the store logs it.
      await recordFire({
        scheduleId: record.id,
        ranAt: new Date('2026-09-08T14:00:00.000Z'),
        outcome: 'woke: session-1',
        nextRunAt: new Date('2026-09-09T14:00:00.000Z')
      })
    } finally {
      spy.mockRestore()
    }

    const stored = await getSchedule(record.id)
    expect(stored?.lastOutcome).toBe('woke: session-1')
    expect(stored?.runCount).toBe(0)
  })
})

/**
 * PR #106 review F-8 (DL-118-01) — the sweep does not walk when nothing can be due.
 *
 * `listDueSchedules` runs `KEYS schedules:*` to find the per-user index sets. `KEYS` is
 * O(every key in the database) and blocks Redis's single command thread for the scan, and
 * the ticker called it **every 60 seconds forever, including on an instance with no
 * schedules at all**. The fix is one module-level fact — "no enabled schedule is due
 * before T" — so the claim to prove is about commands issued, not about results returned:
 * "it returned nothing" is equally true of a walk that found nothing.
 *
 * `countRedisCommands` counts real commands on both lanes; see its header for why it does
 * not use `vi.spyOn`.
 */
describe('the due cache (F-8, DL-118-01)', () => {
  const NOW = new Date('2026-09-08T15:00:00.000Z')

  /** A schedule whose next run is a day away, and one walk to learn that. */
  async function primeWithNothingDue(now = NOW) {
    const record = await createSchedule(baseInput({ now }))
    // The create emptied the cache, so this UNFORCED call walks — and it is the ticker's
    // kind of walk, the only kind that publishes (review F-P1-7): a forced walk never does.
    const { counts } = await countRedisCommands(() => listDueSchedules(now))
    expect(counts.commands.keys ?? 0).toBe(1)
    return record
  }

  async function keysIssuedBy(now: Date): Promise<number> {
    const { counts } = await countRedisCommands(() => listDueSchedules(now))
    return counts.commands.keys ?? 0
  }

  it('walks the first time, because it knows nothing yet', async () => {
    await createSchedule(baseInput({ now: NOW }))
    expect(await keysIssuedBy(NOW)).toBe(1)
  })

  it('issues NO Redis command at all on a second call inside the bound', async () => {
    await primeWithNothingDue()

    const { result, counts } = await countRedisCommands(() =>
      listDueSchedules(new Date(NOW.getTime() + 60_000))
    )

    expect(result).toEqual([])
    // Not just "no KEYS": nothing is read at all, which is the point on an idle instance.
    expect(counts.commands.keys ?? 0).toBe(0)
    expect(counts.executes).toBe(0)
  })

  it('walks again once the cached earliest run has arrived', async () => {
    const record = await createSchedule(baseInput({ now: NOW }))
    // Two minutes out, so this test is about the earliest-run bound and not the
    // five-minute one. Written raw and BEFORE the priming walk, so the walk is what
    // learns it — going through the store here would just invalidate the cache.
    const dueAt = new Date(NOW.getTime() + 2 * 60_000)
    await redis.json.set(`schedule:${record.id}`, '$.nextRunAt', dueAt.toISOString() as never)
    // Unforced: the create emptied the cache, so this call walks — and it is the ticker's
    // kind of walk, the only kind that publishes (review F-P1-7).
    await countRedisCommands(() => listDueSchedules(NOW))

    // One second before the stored next run: still nothing that can be due.
    expect(await keysIssuedBy(new Date(dueAt.getTime() - 1000))).toBe(0)
    // The moment it arrives, the cache stops answering and the walk happens.
    expect(await keysIssuedBy(dueAt)).toBe(1)
  })

  it('walks again once the five-minute bound expires, even with nothing due', async () => {
    await primeWithNothingDue()

    // The cache is in-process and the keyspace is not, so trusting it forever would let a
    // restore or a missed invalidation park the clock. One minute in: still trusted.
    expect(await keysIssuedBy(new Date(NOW.getTime() + 60_000))).toBe(0)
    expect(await keysIssuedBy(new Date(NOW.getTime() + SCHEDULE_DUE_CACHE_MAX_MS))).toBe(1)
  })

  it('trusts "no schedules at all" the same way, and stops walking an empty instance', async () => {
    const { counts: first } = await countRedisCommands(() => listDueSchedules(NOW))
    expect(first.commands.keys ?? 0).toBe(1)
    // This is the case F-8 is really about: nothing exists, and the old code scanned the
    // whole keyspace for it once a minute, forever.
    expect(await keysIssuedBy(new Date(NOW.getTime() + 60_000))).toBe(0)
  })

  it('walks whenever it is told to, cache or no cache', async () => {
    await primeWithNothingDue()
    const { counts } = await countRedisCommands(() =>
      listDueSchedules(new Date(NOW.getTime() + 60_000), { walk: true })
    )
    expect(counts.commands.keys ?? 0).toBe(1)
  })

  it("does not let a forced walk stamp the cache with its caller's clock (review F-P1-7)", async () => {
    // The internal route and the tests pass their own `now`. If a walk forced a day ahead
    // published "nothing due before tomorrow" with a computedAt a day in the future, the
    // ticker at real time would read it as fresh for a day and five minutes, not five —
    // and the five-minute bound is the whole promise behind trusting an in-process cache.
    await createSchedule(baseInput({ now: NOW }))
    const aDayAhead = new Date(NOW.getTime() + 24 * 60 * 60_000)
    await listDueSchedules(aDayAhead, { walk: true })
    expect(await keysIssuedBy(NOW)).toBe(1)
  })

  it('does not let a walk that started before a write publish its stale answer', async () => {
    // A sweep reads the keyspace; a schedule is created while it is reading; the sweep then
    // writes back the earliest run it saw, which knows nothing about the new one. Without
    // the generation guard the next sweeps would skip the walk until the bound expired.
    const soon = new Date(NOW.getTime() + 90_000)
    const originalExecute = redis.execute
    let interleaved = false
    ;(redis as any).execute = async (operation: any) => {
      const value = await (originalExecute as any).call(redis, operation)
      if (!interleaved) {
        interleaved = true
        const created = await createSchedule(baseInput({ name: 'Snuck in', now: NOW }))
        await redis.json.set(
          `schedule:${created.id}`,
          '$.nextRunAt',
          soon.toISOString() as never
        )
      }
      return value
    }
    try {
      await listDueSchedules(NOW, { walk: true })
    } finally {
      ;(redis as any).execute = originalExecute
    }

    // The interleaved create invalidated the cache, so the walk's answer was discarded.
    expect(await keysIssuedBy(new Date(NOW.getTime() + 1000))).toBe(1)
  })

  /**
   * One row per writer. DL-118-01's rule is "every writer in the store invalidates"; its
   * enumeration does not name `sweepAgentSchedules`, which is safe today only because that
   * sweep deletes — it can move the earliest run later, never earlier (F-P1-1). The rule is
   * what is pinned here, so a writer added later without an invalidation fails a test
   * instead of quietly delaying a fire by up to five minutes.
   */
  describe('every writer makes the next sweep walk', () => {
    const writers: [name: string, act: (scheduleId: string) => Promise<unknown>][] = [
      ['createSchedule', () => createSchedule(baseInput({ name: 'Another', now: NOW }))],
      ['patchSchedule', (id) => patchSchedule({ userId: USER, scheduleId: id, name: 'Renamed' })],
      ['recordFire', (id) => recordFire({ scheduleId: id, ranAt: NOW, outcome: 'woke: s' })],
      [
        'collapseMissedRun',
        // Two days on, so the seeded schedule really is overdue: `collapseMissedRuns`
        // refuses to invent a missed run for one that is not.
        async (id) =>
          collapseMissedRun({
            schedule: (await getSchedule(id))!,
            now: new Date('2026-09-10T15:00:00.000Z')
          })
      ],
      ['disableScheduleAfterFailure', (id) => disableScheduleAfterFailure(id, 'unknown zone', NOW)],
      ['clearMissedRun', (id) => clearMissedRun({ userId: USER, scheduleId: id, now: NOW })],
      ['deleteSchedule', (id) => deleteSchedule({ userId: USER, scheduleId: id })],
      ['sweepAgentSchedules', () => sweepAgentSchedules(COOPER)]
    ]

    for (const [name, act] of writers) {
      it(name, async () => {
        const record = await primeWithNothingDue()
        expect(await keysIssuedBy(new Date(NOW.getTime() + 1000))).toBe(0)

        await act(record.id)

        expect(await keysIssuedBy(new Date(NOW.getTime() + 2000))).toBe(1)
      })
    }
  })
})
