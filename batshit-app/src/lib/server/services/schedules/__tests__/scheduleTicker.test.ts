import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { countRedisCommands } from '$lib/test-utils/redis-command-counter'
import { redis } from '$lib/server/redis'
import { LATE_FIRE_GRACE_MS } from '$lib/utils/scheduleControl'
import {
  __resetScheduleDueCacheForTests,
  createSchedule,
  getSchedule
} from '../scheduleStore'
import {
  __resetScheduleTickerForTests,
  runScheduleSweep,
  startScheduleTicker
} from '../scheduleTicker'

/**
 * SA-115 P1 (DL-115-06, DL-115-07, DL-115-08) — Batshit's clock.
 *
 * The rule this suite exists to protect is "nothing fires in the dark": a due time
 * Batshit slept through is collapsed and waits for a person, a fire that throws still
 * moves the schedule on rather than retrying every minute, and two sweeps never run at
 * once. The fire path itself is stubbed, so what is pinned here is the ticker's
 * decisions, not the DM.
 */

const deliverScheduledDm = vi.hoisted(() => vi.fn())
const publishUserEvent = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$lib/server/services/dm/dmTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/dm/dmTools')>()),
  deliverScheduledDm
}))

vi.mock('$lib/server/ssePublisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/ssePublisher')>()),
  publishUserEvent
}))

useRedisTestServer()

const USER = 'user-ticker'
const COOPER = 'agent-cooper'
const CHICAGO = 'America/Chicago'

async function seedAgent(id: string, userId = USER) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName: 'Cooper',
    agentType: 'api',
    primary_model_provider: 'anthropic',
    primary_model_name: 'claude-sonnet-4-5',
    dms_enabled: true
  } as any)
}

/** Create a schedule and force its next run to an exact instant. */
async function seedSchedule(options: {
  name: string
  nextRunAt: string
  userId?: string
  agentId?: string
  cadence?: Record<string, unknown>
  enabled?: boolean
}) {
  const record = await createSchedule({
    userId: options.userId ?? USER,
    agentId: options.agentId ?? COOPER,
    name: options.name,
    cadence: options.cadence ?? { type: 'daily', at: '09:00' },
    timeZone: CHICAGO,
    message: 'Say good morning.',
    now: new Date('2026-09-01T00:00:00.000Z')
  })
  await redis.json.set(`schedule:${record.id}`, '$.nextRunAt', options.nextRunAt as never)
  if (options.enabled === false) {
    await redis.json.set(`schedule:${record.id}`, '$.enabled', false as never)
  }
  return record
}

beforeEach(async () => {
  deliverScheduledDm.mockReset()
  deliverScheduledDm.mockResolvedValue({
    dmId: 'dm_seeded',
    deliveredAs: 'wake',
    sessionId: 'session-seeded',
    outcome: 'woke: session-seeded'
  })
  publishUserEvent.mockClear()
  __resetScheduleTickerForTests()
  // SA-118 DL-118-01: the store's due cache is module-level, so it outlives a test. Every
  // sweep below passes `{ walk: true }` for the same reason — a test asks "is this due
  // now?" about a keyspace it has just written to behind the store's back.
  __resetScheduleDueCacheForTests()
  await seedAgent(COOPER)
})

afterEach(() => {
  __resetScheduleTickerForTests()
  vi.restoreAllMocks()
})

describe('firing', () => {
  it('fires a schedule that is due, and records the outcome and the next run', async () => {
    const record = await seedSchedule({ name: 'Morning', nextRunAt: '2026-09-08T14:00:00.000Z' })
    const now = new Date('2026-09-08T14:00:30.000Z')

    const report = await runScheduleSweep(now, { walk: true })

    expect(report.fired).toHaveLength(1)
    expect(report.missed).toHaveLength(0)
    expect(report.fired[0]).toMatchObject({
      scheduleId: record.id,
      ok: true,
      deliveredAs: 'wake',
      sessionId: 'session-seeded',
      outcome: 'woke: session-seeded'
    })
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
    expect(deliverScheduledDm.mock.calls[0][1]).toMatchObject({ trigger: 'tick' })

    const stored = await getSchedule(record.id)
    expect(stored?.lastOutcome).toBe('woke: session-seeded')
    expect(stored?.lastDmId).toBe('dm_seeded')
    expect(stored?.runCount).toBe(1)
    expect(stored?.nextRunAt).toBe('2026-09-09T14:00:00.000Z')
  })

  it('fires LATE inside the grace, and tells the fire path when the run was due', async () => {
    const record = await seedSchedule({ name: 'Morning', nextRunAt: '2026-09-08T14:00:00.000Z' })
    // Four minutes behind: the laptop slept, the run still happens.
    const now = new Date(Date.parse('2026-09-08T14:00:00.000Z') + 4 * 60_000)

    const report = await runScheduleSweep(now, { walk: true })

    expect(report.fired).toHaveLength(1)
    expect(report.missed).toHaveLength(0)
    const dueAt = deliverScheduledDm.mock.calls[0][1].dueAt as Date
    expect(dueAt.toISOString()).toBe('2026-09-08T14:00:00.000Z')
    expect((await getSchedule(record.id))?.missedRun ?? null).toBeNull()
  })

  it('skips a paused schedule entirely — paused is not missed', async () => {
    await seedSchedule({
      name: 'Paused',
      nextRunAt: '2026-09-01T14:00:00.000Z',
      enabled: false
    })
    const report = await runScheduleSweep(new Date('2026-09-08T14:00:00.000Z'), { walk: true })
    expect(report.fired).toHaveLength(0)
    expect(report.missed).toHaveLength(0)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })

  it('leaves a schedule alone until its next run arrives', async () => {
    await seedSchedule({ name: 'Later', nextRunAt: '2026-09-09T14:00:00.000Z' })
    const report = await runScheduleSweep(new Date('2026-09-08T14:00:00.000Z'), { walk: true })
    expect(report.fired).toHaveLength(0)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })

  it('handles schedules ONE AT A TIME so two fires never race for the wake budget', async () => {
    await seedSchedule({ name: 'A', nextRunAt: '2026-09-08T14:00:00.000Z' })
    await seedSchedule({ name: 'B', nextRunAt: '2026-09-08T14:00:00.000Z' })
    await seedSchedule({ name: 'C', nextRunAt: '2026-09-08T14:00:00.000Z' })

    let inFlight = 0
    let peak = 0
    deliverScheduledDm.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return { dmId: 'dm_x', deliveredAs: 'wake', sessionId: 's', outcome: 'woke: s' }
    })

    const report = await runScheduleSweep(new Date('2026-09-08T14:00:30.000Z'), { walk: true })
    expect(report.fired).toHaveLength(3)
    expect(peak).toBe(1)
  })
})

describe('a fire that throws', () => {
  it('records the failure, STILL advances, and does not retry the same slot', async () => {
    const record = await seedSchedule({ name: 'Broken', nextRunAt: '2026-09-08T14:00:00.000Z' })
    deliverScheduledDm.mockRejectedValue(new Error('That agent no longer exists.'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const first = await runScheduleSweep(new Date('2026-09-08T14:00:30.000Z'), { walk: true })
    expect(first.fired).toHaveLength(1)
    expect(first.fired[0].ok).toBe(false)
    expect(first.fired[0].outcome).toBe('failed: That agent no longer exists.')

    const stored = await getSchedule(record.id)
    expect(stored?.lastOutcome).toBe('failed: That agent no longer exists.')
    expect(stored?.nextRunAt).toBe('2026-09-09T14:00:00.000Z')

    // A minute later the same schedule must NOT be tried again: a broken schedule that
    // retried every tick would be a storm against the log and the agent's wake budget.
    deliverScheduledDm.mockClear()
    const second = await runScheduleSweep(new Date('2026-09-08T14:01:30.000Z'), { walk: true })
    expect(second.fired).toHaveLength(0)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
  })
})

describe('missed runs', () => {
  it('collapses a run Batshit slept through and fires NOTHING', async () => {
    const record = await seedSchedule({ name: 'Morning', nextRunAt: '2026-09-08T14:00:00.000Z' })
    const now = new Date(Date.parse('2026-09-08T14:00:00.000Z') + LATE_FIRE_GRACE_MS + 60_000)

    const report = await runScheduleSweep(now, { walk: true })

    expect(deliverScheduledDm).not.toHaveBeenCalled()
    expect(report.fired).toHaveLength(0)
    expect(report.missed).toHaveLength(1)
    expect(report.missed[0]).toMatchObject({ scheduleId: record.id, count: 1 })

    const stored = await getSchedule(record.id)
    expect(stored?.missedRun?.dueAt).toBe('2026-09-08T14:00:00.000Z')
    expect(stored?.missedRun?.count).toBe(1)
    expect(stored?.runCount).toBe(0)
    expect(Date.parse(stored!.nextRunAt)).toBeGreaterThan(now.getTime())
  })

  it('never fires a collapsed run on the next sweep', async () => {
    const record = await seedSchedule({ name: 'Morning', nextRunAt: '2026-09-08T14:00:00.000Z' })
    await runScheduleSweep(new Date('2026-09-08T16:00:00.000Z'), { walk: true })
    expect(deliverScheduledDm).not.toHaveBeenCalled()

    // One minute later: the missed run is still sitting there waiting for the user, and
    // the ticker walks past it. Only **Run now** can start it.
    const second = await runScheduleSweep(new Date('2026-09-08T16:01:00.000Z'), { walk: true })
    expect(second.fired).toHaveLength(0)
    expect(second.missed).toHaveLength(0)
    expect(deliverScheduledDm).not.toHaveBeenCalled()
    expect((await getSchedule(record.id))?.missedRun?.count).toBe(1)
  })

  it('publishes ONE schedule_missed event per user, listing every collapsed schedule', async () => {
    await seedSchedule({ name: 'A', nextRunAt: '2026-09-08T14:00:00.000Z' })
    await seedSchedule({ name: 'B', nextRunAt: '2026-09-08T14:00:00.000Z' })

    await runScheduleSweep(new Date('2026-09-08T18:00:00.000Z'), { walk: true })

    expect(publishUserEvent).toHaveBeenCalledTimes(1)
    const [userId, event] = publishUserEvent.mock.calls[0]
    expect(userId).toBe(USER)
    expect(event.type).toBe('schedule_missed')
    expect(event.schedules.map((entry: any) => entry.name).sort()).toEqual(['A', 'B'])
    expect(event.schedules[0]).toMatchObject({ agentId: COOPER, timeZone: CHICAGO })
  })

  it('says nothing when nothing was missed', async () => {
    await seedSchedule({ name: 'Morning', nextRunAt: '2026-09-08T14:00:00.000Z' })
    await runScheduleSweep(new Date('2026-09-08T14:00:30.000Z'), { walk: true })
    expect(publishUserEvent).not.toHaveBeenCalled()
  })
})

describe('sweep overlap', () => {
  it('refuses to start a second sweep while one is running', async () => {
    await seedSchedule({ name: 'Slow', nextRunAt: '2026-09-08T14:00:00.000Z' })

    let release: (() => void) | null = null
    deliverScheduledDm.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { dmId: 'dm_x', deliveredAs: 'wake', sessionId: 's', outcome: 'woke: s' }
    })

    const first = runScheduleSweep(new Date('2026-09-08T14:00:30.000Z'), { walk: true })
    // Let the first sweep reach the fire and park there.
    await vi.waitFor(() => expect(release).not.toBeNull())

    const second = await runScheduleSweep(new Date('2026-09-08T14:00:31.000Z'), { walk: true })
    expect(second.fired).toHaveLength(0)
    expect(second.skipped).toEqual([
      { scheduleId: '*', reason: 'A schedule sweep was already running.' }
    ])

    release!()
    await expect(first).resolves.toMatchObject({ fired: [{ ok: true }] })
  })
})

describe('arming', () => {
  it('logs `[Schedules] ticker armed` exactly once, however often it is started', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    startScheduleTicker()
    startScheduleTicker()
    startScheduleTicker()

    const armed = info.mock.calls.filter((call) => String(call[0]).includes('[Schedules] ticker armed'))
    expect(armed).toHaveLength(1)
  })
})

describe('AMD-115-03 / F-P1-3 — the ticker anchors the next run on the DUE slot', () => {
  /**
   * The end-to-end half of the grid fix. `computeNextRunAt` can walk a grid all it likes;
   * if `fireSchedule` hands it `now` instead of `dueAt`, every fire still adds its own
   * sweep lateness to the period and "every five minutes" compounds into every five and a
   * half. This drives three real sweeps, each late by a different plausible amount.
   */
  it('keeps a five-minute schedule on an exact grid across three late sweeps', async () => {
    const record = await seedSchedule({
      name: 'Queue check',
      cadence: { type: 'interval', everyMinutes: 5 },
      nextRunAt: '2026-09-08T09:00:00.000Z'
    })

    // A sweep runs every 60 s, so its lateness is somewhere in 0…60 s. Deliberately not
    // round numbers: a grid answer must not be reachable by coincidence.
    const lateness = [37_000, 21_000, 49_000]
    const landed: (string | undefined)[] = []

    for (const late of lateness) {
      const due = Date.parse((await getSchedule(record.id))!.nextRunAt)
      const report = await runScheduleSweep(new Date(due + late), { walk: true })
      expect(report.fired).toHaveLength(1)
      landed.push((await getSchedule(record.id))?.nextRunAt)
    }

    expect(landed).toEqual([
      '2026-09-08T09:05:00.000Z',
      '2026-09-08T09:10:00.000Z',
      '2026-09-08T09:15:00.000Z'
    ])
  })

  it('passes the due slot, not the fire time, to the delivery', async () => {
    await seedSchedule({
      name: 'Queue check',
      cadence: { type: 'interval', everyMinutes: 5 },
      nextRunAt: '2026-09-08T09:00:00.000Z'
    })
    await runScheduleSweep(new Date('2026-09-08T09:00:37.000Z'), { walk: true })

    // The DM body says when the run was DUE (DL-115-08), so the agent reading a late note
    // knows which slot it belongs to. That only works if `dueAt` reaches this far.
    const [, options] = deliverScheduledDm.mock.calls[0]
    expect(options.dueAt.toISOString()).toBe('2026-09-08T09:00:00.000Z')
    expect(options.now.toISOString()).toBe('2026-09-08T09:00:37.000Z')
  })
})

/* -------------------------------------------------------------------------- *
 * PR #106 review F-3 — a schedule whose stored zone this host cannot resolve.
 *
 * The zone is stored verbatim (AMD-115-01) and restored verbatim, so a backup from a host
 * with newer tzdata can carry a zone this ICU rejects. `computeNextRunAt` then throws for a
 * record `listDueSchedules` and `deliverScheduledDm` both accept.
 * -------------------------------------------------------------------------- */

describe('a schedule whose zone this host cannot resolve (PR #106 F-3)', () => {
  const now = new Date('2026-09-02T14:05:00.000Z')

  it('fires once, records the failure, and switches itself off instead of storming', async () => {
    const record = await seedSchedule({
      name: 'Bad zone',
      nextRunAt: new Date(now.getTime() - 60_000).toISOString()
    })
    await redis.json.set(`schedule:${record.id}`, '$.timeZone', 'Mars/Olympus_Mons' as never)

    const first = await runScheduleSweep(now, { walk: true })
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
    expect(first.fired).toHaveLength(1)
    expect(first.fired[0]?.ok).toBe(false)

    const stored = await getSchedule(record.id)
    expect(stored?.enabled).toBe(false)
    expect(stored?.lastOutcome).toMatch(/^failed: .*time zone/)
    expect(stored?.lastRunAt).toBe(now.toISOString())

    // The storm: before the fix nothing was recorded, so the same slot fired every sweep.
    await runScheduleSweep(new Date(now.getTime() + 60_000), { walk: true })
    await runScheduleSweep(new Date(now.getTime() + 120_000), { walk: true })
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
  })

  it('stops a missed-run collapse that cannot compute the next slot, with the reason on the card', async () => {
    const record = await seedSchedule({
      name: 'Bad zone, overdue',
      nextRunAt: new Date(now.getTime() - LATE_FIRE_GRACE_MS - 60_000).toISOString()
    })
    await redis.json.set(`schedule:${record.id}`, '$.timeZone', 'Mars/Olympus_Mons' as never)

    const report = await runScheduleSweep(now, { walk: true })
    expect(deliverScheduledDm).not.toHaveBeenCalled()
    expect(report.skipped.map((entry) => entry.scheduleId)).toContain(record.id)

    const stored = await getSchedule(record.id)
    expect(stored?.enabled).toBe(false)
    expect(stored?.lastOutcome).toMatch(/^failed: .*time zone/)

    // Nothing to retry every minute any more.
    const again = await runScheduleSweep(new Date(now.getTime() + 60_000), { walk: true })
    expect(again.skipped.map((entry) => entry.scheduleId)).not.toContain(record.id)
  })
})

/**
 * PR #106 review F-8 (DL-118-01) — the 60-second sweep stops walking the keyspace.
 *
 * The ticker is the ONLY caller that does not force a walk, and it is the caller that
 * mattered: `KEYS` is O(every key in the database) and blocked Redis's command thread for
 * the scan, once a minute, forever, on an instance that may hold no schedules at all.
 * The store's own suite pins the cache; what is pinned here is that the ticker gets the
 * benefit and still fires on time.
 */
describe('the sweep does not walk when nothing can be due (F-8)', () => {
  it('issues no Redis command on a second sweep inside the bound', async () => {
    await seedSchedule({ name: 'Tomorrow', nextRunAt: '2026-09-09T14:00:00.000Z' })

    const first = await countRedisCommands(() =>
      runScheduleSweep(new Date('2026-09-08T14:00:00.000Z'))
    )
    expect(first.counts.commands.keys ?? 0).toBe(1)

    const second = await countRedisCommands(() =>
      runScheduleSweep(new Date('2026-09-08T14:01:00.000Z'))
    )
    expect(second.result.fired).toHaveLength(0)
    expect(second.counts.commands.keys ?? 0).toBe(0)
    expect(second.counts.executes).toBe(0)
  })

  it('still fires the moment the schedule is actually due', async () => {
    await seedSchedule({ name: 'Soon', nextRunAt: '2026-09-08T14:02:00.000Z' })

    const early = await runScheduleSweep(new Date('2026-09-08T14:00:00.000Z'))
    expect(early.fired).toHaveLength(0)
    // A sweep that skipped the walk must not skip the fire: the cache knows when the
    // earliest run is, so the tick that reaches it walks.
    const onTime = await runScheduleSweep(new Date('2026-09-08T14:02:00.000Z'))
    expect(onTime.fired).toHaveLength(1)
    expect(deliverScheduledDm).toHaveBeenCalledTimes(1)
  })

  it('notices a schedule created after the last walk', async () => {
    await seedSchedule({ name: 'Tomorrow', nextRunAt: '2026-09-09T14:00:00.000Z' })
    await runScheduleSweep(new Date('2026-09-08T14:00:00.000Z'))

    // `createSchedule` invalidates, which is the whole reason the cache is safe to trust.
    const fresh = await createSchedule({
      userId: USER,
      agentId: COOPER,
      name: 'Just added',
      cadence: { type: 'interval', everyMinutes: 30 },
      timeZone: CHICAGO,
      message: 'Say hello.',
      now: new Date('2026-09-08T14:00:30.000Z')
    })
    expect(Date.parse(fresh.nextRunAt)).toBe(Date.parse('2026-09-08T14:30:30.000Z'))

    const report = await runScheduleSweep(new Date('2026-09-08T14:30:30.000Z'))
    expect(report.fired.map((entry) => entry.name)).toEqual(['Just added'])
  })
})
