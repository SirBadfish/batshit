import { describe, expect, it } from 'vitest'
import {
  LATE_FIRE_GRACE_MS,
  MAX_MISSED_SLOT_SCAN,
  MAX_SCHEDULE_INTERVAL_MINUTES,
  MIN_SCHEDULE_INTERVAL_MINUTES,
  SCHEDULE_NAME_MAX_CHARS,
  SCHEDULE_TICK_MS,
  collapseMissedRuns,
  computeNextRunAt,
  describeAge,
  describeCadence,
  describeNextRun,
  isValidTimeZone,
  listSelectableTimeZones,
  validateCadence,
  validateScheduleFields
} from '$lib/utils/scheduleControl'
import type { ScheduleCadence } from '$lib/types/schedule'

/**
 * SA-115 P1 (DL-115-03, DL-115-04, DL-115-07, DL-115-08, DL-115-11) — the schedule rules.
 *
 * The DST block is the reason this file exists. Every instant asserted here was measured
 * on Node 24.12.0 against the installed `@internationalized/date`, not derived by hand, so
 * a library upgrade that changes disambiguation fails loudly instead of quietly moving
 * somebody's 9am.
 */

const CHICAGO = 'America/Chicago'
const SYDNEY = 'Australia/Sydney'
const KOLKATA = 'Asia/Kolkata'

function at(iso: string): Date {
  return new Date(Date.parse(iso))
}

function nextIso(cadence: ScheduleCadence, zone: string, from: string, anchor?: string): string {
  return computeNextRunAt(cadence, zone, at(from), anchor ? at(anchor) : null).toISOString()
}

/* ------------------------------------------------------------------ *
 * Cadence validation
 * ------------------------------------------------------------------ */

describe('validateCadence', () => {
  it('accepts the three shapes and normalises them', () => {
    expect(validateCadence({ type: 'interval', everyMinutes: 30 })).toEqual({
      ok: true,
      cadence: { type: 'interval', everyMinutes: 30 }
    })
    expect(validateCadence({ type: 'daily', at: '09:00' })).toEqual({
      ok: true,
      cadence: { type: 'daily', at: '09:00' }
    })
    // Weekdays are de-duplicated and sorted, so two forms of "Tuesdays and Thursdays"
    // produce one stored value.
    expect(validateCadence({ type: 'weekly', days: [4, 2, 2], at: '16:00' })).toEqual({
      ok: true,
      cadence: { type: 'weekly', days: [2, 4], at: '16:00' }
    })
  })

  it('REFUSES an out-of-range interval instead of clamping it', () => {
    const tooFast = validateCadence({
      type: 'interval',
      everyMinutes: MIN_SCHEDULE_INTERVAL_MINUTES - 1
    })
    expect(tooFast.ok).toBe(false)
    const tooSlow = validateCadence({
      type: 'interval',
      everyMinutes: MAX_SCHEDULE_INTERVAL_MINUTES + 1
    })
    expect(tooSlow.ok).toBe(false)
    // The boundaries themselves are valid — a refusal must not eat the legal values.
    expect(
      validateCadence({ type: 'interval', everyMinutes: MIN_SCHEDULE_INTERVAL_MINUTES }).ok
    ).toBe(true)
    expect(
      validateCadence({ type: 'interval', everyMinutes: MAX_SCHEDULE_INTERVAL_MINUTES }).ok
    ).toBe(true)
  })

  it('SA-115 P2: accepts both `everyMinutes` and the model-facing `every_minutes`', () => {
    // The stored record and the browser form use `everyMinutes`; `sys.schedule.*` documents
    // `every_minutes`, because every model-facing field in the Fabric families is
    // snake_case. Reading only one makes an agent following the published schema fail on
    // its first call.
    expect(validateCadence({ type: 'interval', every_minutes: 30 })).toEqual({
      ok: true,
      cadence: { type: 'interval', everyMinutes: 30 }
    })
    expect(validateCadence({ type: 'interval', everyMinutes: 30 })).toEqual({
      ok: true,
      cadence: { type: 'interval', everyMinutes: 30 }
    })
    // Neither spelling escapes the range check.
    expect(validateCadence({ type: 'interval', every_minutes: 1 }).ok).toBe(false)
  })

  it('refuses a cron string, a fractional interval, and an unreadable time', () => {
    expect(validateCadence({ type: 'cron', expression: '0 9 * * *' }).ok).toBe(false)
    expect(validateCadence({ type: 'interval', everyMinutes: 7.5 }).ok).toBe(false)
    expect(validateCadence({ type: 'daily', at: '9am' }).ok).toBe(false)
    expect(validateCadence({ type: 'daily', at: '24:00' }).ok).toBe(false)
    expect(validateCadence({ type: 'daily', at: '09:60' }).ok).toBe(false)
    expect(validateCadence(null).ok).toBe(false)
  })

  it('PR #106 F-12: never invents Sunday from an empty, null or boolean weekday', () => {
    for (const bad of [null, false, true, '', ' ', [], {}]) {
      const result = validateCadence({ type: 'weekly', days: [bad], at: '09:00' })
      expect(result.ok, `days: [${JSON.stringify(bad)}]`).toBe(false)
    }
    const numeric = validateCadence({ type: 'weekly', days: ['0', 6], at: '09:00' })
    expect(numeric.ok).toBe(true)
    if (numeric.ok && numeric.cadence.type === 'weekly') expect(numeric.cadence.days).toEqual([0, 6])
  })

  it('refuses a weekly cadence with no days or an out-of-range day', () => {
    expect(validateCadence({ type: 'weekly', days: [], at: '09:00' }).ok).toBe(false)
    expect(validateCadence({ type: 'weekly', days: [7], at: '09:00' }).ok).toBe(false)
    expect(validateCadence({ type: 'weekly', days: [-1], at: '09:00' }).ok).toBe(false)
    // Sunday is 0 and is legal (DL-115-03).
    expect(validateCadence({ type: 'weekly', days: [0], at: '09:00' }).ok).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * computeNextRunAt
 * ------------------------------------------------------------------ */

describe('computeNextRunAt — interval', () => {
  const every30: ScheduleCadence = { type: 'interval', everyMinutes: 30 }

  it('anchors on the previous fire', () => {
    expect(nextIso(every30, CHICAGO, '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z')).toBe(
      '2026-09-08T12:30:00.000Z'
    )
  })

  it('never returns a time already in the past when the anchor is stale', () => {
    // Batshit was off for two hours. The answer is the first grid point still ahead of us,
    // which here is exactly two hours down the anchor's own grid.
    expect(nextIso(every30, CHICAGO, '2026-09-08T14:00:00Z', '2026-09-08T12:00:00Z')).toBe(
      '2026-09-08T14:30:00.000Z'
    )
  })

  it('uses "now" when there is no anchor at all', () => {
    expect(nextIso(every30, CHICAGO, '2026-09-08T12:00:00Z')).toBe('2026-09-08T12:30:00.000Z')
  })

  it('ignores the time zone entirely', () => {
    const a = nextIso(every30, CHICAGO, '2026-11-01T05:00:00Z', '2026-11-01T05:00:00Z')
    const b = nextIso(every30, SYDNEY, '2026-11-01T05:00:00Z', '2026-11-01T05:00:00Z')
    // 05:00Z on 2026-11-01 is inside Chicago's fall-back hour. An interval cadence must
    // not care: "every 30 minutes" is 30 minutes everywhere.
    expect(a).toBe(b)
    expect(a).toBe('2026-11-01T05:30:00.000Z')
  })
})

describe('AMD-115-03 / F-P1-3 — an interval schedule keeps its grid', () => {
  const every5: ScheduleCadence = { type: 'interval', everyMinutes: 5 }

  /**
   * The bug this pins: the lock originally said `max(now, lastRunAt) + everyMinutes`,
   * which measures the next run from the moment a fire HAPPENED rather than the moment it
   * was DUE. A sweep is up to 60 seconds late by construction, so every fire added its own
   * lateness to the period and the error compounded — 09:00:37, 09:05:37, 09:11:14,
   * 09:16:51. "Every five minutes" quietly became every five and a half.
   */
  it('lands on an exact grid across three consecutive late fires', () => {
    const start = Date.parse('2026-09-08T09:00:00Z')
    // A sweep runs every 60s, so real lateness is somewhere in 0…60s. These are measured
    // sweep delays, not round numbers, precisely so a grid answer cannot be a coincidence.
    const lateness = [37_000, 21_000, 49_000]

    let dueAt = new Date(start)
    const grid: string[] = []
    for (const late of lateness) {
      const firedAt = new Date(dueAt.getTime() + late)
      dueAt = computeNextRunAt(every5, CHICAGO, firedAt, dueAt)
      grid.push(dueAt.toISOString())
    }

    expect(grid).toEqual([
      '2026-09-08T09:05:00.000Z',
      '2026-09-08T09:10:00.000Z',
      '2026-09-08T09:15:00.000Z'
    ])
  })

  it('skips to the next grid point when a fire was late by more than one whole step', () => {
    // Due 09:00, fired 09:07 (inside the ten-minute late-fire grace). 09:05 is already
    // behind us, so the next run is 09:10 — still on the grid, never 09:12.
    expect(
      nextIso(every5, CHICAGO, '2026-09-08T09:07:00Z', '2026-09-08T09:00:00Z')
    ).toBe('2026-09-08T09:10:00.000Z')
  })

  it('is strictly after, even when "now" lands exactly on a grid point', () => {
    // The sweep that fires the 09:05 slot at exactly 09:05 must be sent to 09:10, not
    // handed its own slot back, or the ticker fires the same slot twice.
    expect(
      nextIso(every5, CHICAGO, '2026-09-08T09:05:00Z', '2026-09-08T09:00:00Z')
    ).toBe('2026-09-08T09:10:00.000Z')
  })

  it('still starts a NEW schedule at now + the interval', () => {
    // Creation passes `now` for both, so the grid begins one whole step from now — there
    // is no earlier grid to inherit.
    expect(
      nextIso(every5, CHICAGO, '2026-09-08T09:02:13Z', '2026-09-08T09:02:13Z')
    ).toBe('2026-09-08T09:07:13.000Z')
  })

  it('answers in one step for a schedule that slept a month', () => {
    // Arithmetic, not a walk: 8,640 slots must not cost 8,640 iterations of ticker time.
    expect(nextIso(every5, CHICAGO, '2026-10-08T09:01:00Z', '2026-09-08T09:00:00Z')).toBe(
      '2026-10-08T09:05:00.000Z'
    )
  })
})

describe('computeNextRunAt — daily and weekly', () => {
  const at9: ScheduleCadence = { type: 'daily', at: '09:00' }

  it('finds today when today is still ahead, and tomorrow when it is not', () => {
    // 2026-09-08 08:00 Chicago (13:00Z) → today at 09:00 (14:00Z).
    expect(nextIso(at9, CHICAGO, '2026-09-08T13:00:00Z')).toBe('2026-09-08T14:00:00.000Z')
    // 2026-09-08 10:00 Chicago (15:00Z) → tomorrow.
    expect(nextIso(at9, CHICAGO, '2026-09-08T15:00:00Z')).toBe('2026-09-09T14:00:00.000Z')
  })

  it('is STRICTLY after, so a sweep landing exactly on the slot cannot fire twice', () => {
    const slot = '2026-09-08T14:00:00.000Z'
    expect(nextIso(at9, CHICAGO, slot)).toBe('2026-09-09T14:00:00.000Z')
  })

  it('picks the next matching weekday and wraps the week', () => {
    // 2026-09-08 is a Tuesday (weekday 2). Tue+Thu at 16:00 Chicago.
    const tueThu: ScheduleCadence = { type: 'weekly', days: [2, 4], at: '16:00' }
    // Tuesday 09:00 Chicago → Tuesday 16:00 Chicago (21:00Z).
    expect(nextIso(tueThu, CHICAGO, '2026-09-08T14:00:00Z')).toBe('2026-09-08T21:00:00.000Z')
    // Tuesday 17:00 Chicago → Thursday.
    expect(nextIso(tueThu, CHICAGO, '2026-09-08T22:00:00Z')).toBe('2026-09-10T21:00:00.000Z')
    // Thursday 17:00 Chicago → the following Tuesday (the wrap).
    expect(nextIso(tueThu, CHICAGO, '2026-09-10T22:00:00Z')).toBe('2026-09-15T21:00:00.000Z')
  })

  it('treats Sunday as 0', () => {
    // 2026-11-01 is a Sunday.
    const sundays: ScheduleCadence = { type: 'weekly', days: [0], at: '09:00' }
    expect(nextIso(sundays, 'UTC', '2026-10-31T12:00:00Z')).toBe('2026-11-01T09:00:00.000Z')
  })

  it('throws rather than guessing on an invalid cadence or an unresolvable zone', () => {
    expect(() =>
      computeNextRunAt({ type: 'daily', at: 'noon' } as never, CHICAGO, at('2026-09-08T12:00:00Z'))
    ).toThrow()
    expect(() => computeNextRunAt(at9, 'Not/AZone', at('2026-09-08T12:00:00Z'))).toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * The DST matrix (DL-115-04) — measured, not derived
 * ------------------------------------------------------------------ */

describe('DST', () => {
  it('keeps the same wall-clock time across a fall-back in America/Chicago', () => {
    const at9: ScheduleCadence = { type: 'daily', at: '09:00' }
    // 2026-11-01 is the fall-back day. 09:00 the day before is CDT (−05:00); 09:00 on the
    // day itself is CST (−06:00). Same wall clock, one hour apart in absolute time.
    const beforeChange = nextIso(at9, CHICAGO, '2026-10-31T00:00:00Z')
    expect(beforeChange).toBe('2026-10-31T14:00:00.000Z')
    const afterChange = nextIso(at9, CHICAGO, beforeChange)
    expect(afterChange).toBe('2026-11-01T15:00:00.000Z')
    const dayAfter = nextIso(at9, CHICAGO, afterChange)
    expect(dayAfter).toBe('2026-11-02T15:00:00.000Z')
  })

  it('moves a NON-EXISTENT local time forward (spring forward)', () => {
    // 02:30 does not exist on 2026-03-08 in Chicago; the clock jumps 02:00 → 03:00.
    const at0230: ScheduleCadence = { type: 'daily', at: '02:30' }
    const springDay = nextIso(at0230, CHICAGO, '2026-03-08T00:00:00Z')
    expect(springDay).toBe('2026-03-08T08:30:00.000Z')
    // 08:30Z on that day is 03:30 CDT — the run moved forward, it was not skipped.
    expect(describeNextRun(springDay, CHICAGO)).toBe('Sun, Mar 8, 3:30 AM CDT')
  })

  it('takes the FIRST occurrence of an AMBIGUOUS local time (fall back)', () => {
    // 01:30 happens twice on 2026-11-01 in Chicago. The first is CDT (−05:00) = 06:30Z;
    // the second would be CST (−06:00) = 07:30Z.
    const at0130: ScheduleCadence = { type: 'daily', at: '01:30' }
    expect(nextIso(at0130, CHICAGO, '2026-11-01T00:00:00Z')).toBe('2026-11-01T06:30:00.000Z')
  })

  it('applies the same two rules in the southern hemisphere (Australia/Sydney)', () => {
    const at0230: ScheduleCadence = { type: 'daily', at: '02:30' }
    // 2026-10-04 is Sydney's spring forward (02:00 → 03:00): 02:30 moves forward to 03:30
    // +11:00, which is 16:30Z on 2026-10-03.
    expect(nextIso(at0230, SYDNEY, '2026-10-03T14:00:00Z')).toBe('2026-10-03T16:30:00.000Z')
    // 2027-04-04 is Sydney's fall back: 02:30 happens twice and the FIRST (+11:00) wins,
    // which is 15:30Z on 2027-04-03.
    expect(nextIso(at0230, SYDNEY, '2027-04-03T14:00:00Z')).toBe('2027-04-03T15:30:00.000Z')
  })

  it('handles a zone with no DST and a non-hour offset, and plain UTC', () => {
    const at9: ScheduleCadence = { type: 'daily', at: '09:00' }
    // Asia/Kolkata is +05:30 all year.
    expect(nextIso(at9, KOLKATA, '2026-06-01T00:00:00Z')).toBe('2026-06-01T03:30:00.000Z')
    expect(nextIso(at9, 'UTC', '2026-06-01T00:00:00Z')).toBe('2026-06-01T09:00:00.000Z')
  })
})

/* ------------------------------------------------------------------ *
 * Time zones (the `supportedValuesOf` trap)
 * ------------------------------------------------------------------ */

describe('isValidTimeZone', () => {
  it('accepts UTC and Asia/Kolkata, which the canonical zone list does NOT contain', () => {
    // This is the whole reason validation is an `Intl.DateTimeFormat` probe rather than
    // list membership: `Intl.supportedValuesOf('timeZone')` excludes aliases, so it holds
    // neither of these — and both are zones this story's own DST matrix uses.
    const canonical = Intl.supportedValuesOf('timeZone')
    expect(canonical.includes('UTC')).toBe(false)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone(KOLKATA)).toBe(true)
  })

  it('accepts real zones and refuses everything else', () => {
    expect(isValidTimeZone(CHICAGO)).toBe(true)
    expect(isValidTimeZone(SYDNEY)).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('   ')).toBe(false)
    expect(isValidTimeZone(null)).toBe(false)
    expect(isValidTimeZone(42)).toBe(false)
  })

  it('offers a select list that always contains UTC', () => {
    const zones = listSelectableTimeZones()
    expect(zones).toContain('UTC')
    expect(zones).toContain(CHICAGO)
    expect(zones.length).toBeGreaterThan(100)
  })
})

/* ------------------------------------------------------------------ *
 * Missed-run collapse (DL-115-07)
 * ------------------------------------------------------------------ */

describe('collapseMissedRuns', () => {
  it('counts every interval slot that went by and lands the next run in the future', () => {
    const every30: ScheduleCadence = { type: 'interval', everyMinutes: 30 }
    const result = collapseMissedRuns({
      cadence: every30,
      timeZone: CHICAGO,
      dueAt: at('2026-09-08T12:00:00Z'),
      now: at('2026-09-08T13:30:00Z')
    })
    // Slots at 12:00, 12:30, 13:00 and 13:30 all went by.
    expect(result.missed).toBe(4)
    expect(result.dueAt.toISOString()).toBe('2026-09-08T13:30:00.000Z')
    expect(result.nextRunAt.toISOString()).toBe('2026-09-08T14:00:00.000Z')
    expect(result.capped).toBe(false)
  })

  it('counts daily slots and never leaves the next run in the past', () => {
    const at9: ScheduleCadence = { type: 'daily', at: '09:00' }
    const result = collapseMissedRuns({
      cadence: at9,
      timeZone: CHICAGO,
      dueAt: at('2026-09-08T14:00:00Z'),
      now: at('2026-09-11T13:00:00Z')
    })
    // 8th, 9th and 10th were missed; the 11th at 09:00 Chicago is still ahead.
    expect(result.missed).toBe(3)
    expect(result.dueAt.toISOString()).toBe('2026-09-10T14:00:00.000Z')
    expect(result.nextRunAt.toISOString()).toBe('2026-09-11T14:00:00.000Z')
    expect(result.nextRunAt.getTime()).toBeGreaterThan(at('2026-09-11T13:00:00Z').getTime())
  })

  it('caps a very long absence and STILL returns a future next run', () => {
    const every5: ScheduleCadence = { type: 'interval', everyMinutes: 5 }
    const now = at('2027-09-08T12:00:00Z')
    const result = collapseMissedRuns({
      cadence: every5,
      timeZone: CHICAGO,
      dueAt: at('2026-09-08T12:00:00Z'),
      now
    })
    expect(result.capped).toBe(true)
    expect(result.missed).toBe(MAX_MISSED_SLOT_SCAN)
    expect(result.nextRunAt.getTime()).toBeGreaterThan(now.getTime())
  })

  it('caps a very long DAILY absence without walking forever, and still moves forward', () => {
    const at9: ScheduleCadence = { type: 'daily', at: '09:00' }
    const now = at('2036-09-08T12:00:00Z')
    const result = collapseMissedRuns({
      cadence: at9,
      timeZone: CHICAGO,
      dueAt: at('2026-09-08T14:00:00Z'),
      now
    })
    expect(result.capped).toBe(true)
    expect(result.missed).toBe(MAX_MISSED_SLOT_SCAN)
    expect(result.nextRunAt.getTime()).toBeGreaterThan(now.getTime())
  })

  it('refuses to invent a missed run for a schedule that is not overdue', () => {
    expect(() =>
      collapseMissedRuns({
        cadence: { type: 'daily', at: '09:00' },
        timeZone: CHICAGO,
        dueAt: at('2026-09-09T14:00:00Z'),
        now: at('2026-09-08T14:00:00Z')
      })
    ).toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * Wording
 * ------------------------------------------------------------------ */

describe('describeCadence', () => {
  it('says every cadence the way a person would', () => {
    expect(describeCadence({ type: 'interval', everyMinutes: 30 })).toBe('every 30 min')
    expect(describeCadence({ type: 'interval', everyMinutes: 60 })).toBe('every hour')
    expect(describeCadence({ type: 'interval', everyMinutes: 120 })).toBe('every 2 hours')
    expect(describeCadence({ type: 'interval', everyMinutes: 1440 })).toBe('every day')
    expect(describeCadence({ type: 'interval', everyMinutes: 10080 })).toBe('every 7 days')
    expect(describeCadence({ type: 'daily', at: '09:00' })).toBe('daily at 9:00 AM')
    expect(describeCadence({ type: 'daily', at: '00:05' })).toBe('daily at 12:05 AM')
    expect(describeCadence({ type: 'daily', at: '12:00' })).toBe('daily at 12:00 PM')
    expect(describeCadence({ type: 'weekly', days: [2, 4], at: '16:00' })).toBe(
      'Tue, Thu at 4:00 PM'
    )
  })
})

describe('describeNextRun', () => {
  it('shows the time in the schedule’s own zone, with the zone named', () => {
    expect(describeNextRun('2026-09-15T21:00:00.000Z', CHICAGO)).toBe('Tue, Sep 15, 4:00 PM CDT')
    expect(describeNextRun('2026-06-01T09:00:00.000Z', 'UTC')).toBe('Mon, Jun 1, 9:00 AM UTC')
    expect(describeNextRun('2026-06-01T03:30:00.000Z', KOLKATA)).toBe(
      'Mon, Jun 1, 9:00 AM GMT+5:30'
    )
  })

  it('says so rather than throwing on an unusable value', () => {
    expect(describeNextRun('not a date', CHICAGO)).toBe('not scheduled')
  })
})

/* ------------------------------------------------------------------ *
 * Whole-schedule validation and the constants
 * ------------------------------------------------------------------ */

describe('validateScheduleFields', () => {
  const base = {
    name: 'Morning check',
    cadence: { type: 'daily', at: '09:00' },
    timeZone: CHICAGO,
    message: 'Say good morning.'
  }

  it('defaults to an info note that WAKES the agent (DL-115-14)', () => {
    const result = validateScheduleFields(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fields.kind).toBe('info')
    expect(result.fields.deliver).toBe('wake')
    expect(result.fields.enabled).toBe(true)
  })

  it('refuses a missing name, an over-long name, and a missing message', () => {
    expect(validateScheduleFields({ ...base, name: '   ' }).ok).toBe(false)
    expect(
      validateScheduleFields({ ...base, name: 'x'.repeat(SCHEDULE_NAME_MAX_CHARS + 1) }).ok
    ).toBe(false)
    expect(validateScheduleFields({ ...base, message: '' }).ok).toBe(false)
  })

  it('refuses an unresolvable time zone and an unknown kind or delivery mode', () => {
    expect(validateScheduleFields({ ...base, timeZone: 'Not/AZone' }).ok).toBe(false)
    expect(validateScheduleFields({ ...base, kind: 'result' }).ok).toBe(false)
    expect(validateScheduleFields({ ...base, deliver: 'steer' }).ok).toBe(false)
  })

  it('collapses whitespace in the name so two schedules cannot look identical', () => {
    const result = validateScheduleFields({ ...base, name: '  Morning   check  ' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fields.name).toBe('Morning check')
  })
})

describe('constants', () => {
  it('pins the two numbers the docs print', () => {
    expect(SCHEDULE_TICK_MS).toBe(60_000)
    expect(LATE_FIRE_GRACE_MS).toBe(10 * 60_000)
  })
})

describe('describeAge — the sentence the missed-run decision rests on', () => {
  const now = new Date('2026-09-08T12:00:00Z')

  it('reads the way a person would say it', () => {
    expect(describeAge('2026-09-08T11:59:30Z', now)).toBe('just now')
    expect(describeAge('2026-09-08T11:59:00Z', now)).toBe('1 minute ago')
    expect(describeAge('2026-09-08T11:20:00Z', now)).toBe('40 minutes ago')
    expect(describeAge('2026-09-08T10:00:00Z', now)).toBe('2 hours ago')
    expect(describeAge('2026-09-07T12:00:00Z', now)).toBe('1 day ago')
    expect(describeAge('2026-09-02T12:00:00Z', now)).toBe('6 days ago')
    // Josh's "three weeks — probably shouldn't run at all" is served by reading THIS and
    // pressing Skip, not by a hidden cut-off. So the long end has to stay legible.
    expect(describeAge('2026-08-16T12:00:00Z', now)).toBe('3 weeks ago')
  })

  it('never invents a time it does not have', () => {
    expect(describeAge('not a date', now)).toBe('at an unknown time')
    expect(describeAge('2026-09-08T13:00:00Z', now)).toBe('in the future')
  })
})
