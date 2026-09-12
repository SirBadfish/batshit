/**
 * SA-115 P1 — THE rules for scheduled wake-ups (DL-115-02, 03, 04, 08, 11).
 *
 * One module owns the cadence shapes, the next-run math, the DST rules, the missed-run
 * collapse, the human wording, and every cap constant. Nothing restates a rule inline.
 * `dmControl.ts` is the precedent: one gate module per system, so there is exactly one
 * place to audit.
 *
 * No `$lib/server` imports: the Admin card, the create form, and the missed-run dialog
 * load this in the browser.
 *
 * ## Why `@internationalized/date` and not a new dependency
 *
 * `@internationalized/date` is already a direct dependency of `batshit-app` (a bits-ui
 * peer used by the calendar), and it is Adobe's React Aria date library — real IANA zone
 * support with DST handled through `Intl`. Batshit adds no scheduling date library.
 *
 * ## The DST rules, measured rather than assumed
 *
 * Probed on Node 24.12.0 (Faye 2026-09-08, re-measured by Opie during the P1 build). These
 * are the library's `compatible` disambiguation rules, written down here so nobody has to
 * re-derive them:
 *
 *  - A local time that **does not exist** on that day moves **forward**: 02:30 on
 *    2026-03-08 in `America/Chicago` fires at 03:30 CDT.
 *  - A local time that **happens twice** fires at the **first** occurrence: 01:30 on
 *    2026-11-01 in `America/Chicago` fires at 01:30 CDT (−05:00), not CST.
 *  - A daily schedule keeps the **same wall-clock time** across a change: 09:00 on
 *    2026-11-01 and on 2026-11-02 are both 15:00Z even though the offset changed.
 *
 * `interval` cadences deliberately ignore the zone. "Every 30 minutes" means the same
 * thing everywhere, and anchoring it to a wall clock would make it fire twice or skip an
 * hour across a DST change.
 */

import { CalendarDate, CalendarDateTime, fromAbsolute, toZoned } from '@internationalized/date'
import { DM_BODY_MAX_CHARS } from '$lib/utils/dmControl'
import {
  SCHEDULE_CADENCE_TYPES,
  isScheduleDeliveryMode,
  isScheduleKind,
  type ScheduleCadence,
  type ScheduleDeliveryMode,
  type ScheduleKind
} from '$lib/types/schedule'

/* ------------------------------------------------------------------ *
 * Caps (DL-115-11) — fixed numbers in v1, printed in the docs.
 * A full cap REFUSES with a reason. Nothing here is ever clamped.
 * ------------------------------------------------------------------ */

/** The floor on "every N minutes". Below this a schedule is a busy loop, not a clock. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5
/** One week, so "every 7 days" is expressible without a monthly cadence. */
export const MAX_SCHEDULE_INTERVAL_MINUTES = 10080

export const MAX_SCHEDULES_PER_AGENT = 10
export const MAX_SCHEDULES_PER_INSTANCE = 50

export const SCHEDULE_NAME_MAX_CHARS = 80
/** A schedule's message becomes a DM body, so it shares that limit exactly. */
export const SCHEDULE_MESSAGE_MAX_CHARS = DM_BODY_MAX_CHARS

/** How often the in-process ticker sweeps for due schedules (DL-115-06). */
export const SCHEDULE_TICK_MS = 60_000

/**
 * The line between "fire late" and "ask me" (DL-115-08).
 *
 * A laptop that slept four minutes fires late and the DM says when it was due. One that
 * slept an hour gets the *Missed while Batshit was off* dialog instead. One number, with
 * comfortable margin over the ticker's own 60-second granularity.
 */
export const LATE_FIRE_GRACE_MS = 10 * 60_000

/**
 * How many past slots the missed-run collapse will walk before it stops counting.
 *
 * Roughly four years of a daily schedule. Past this the count is reported as capped and
 * `nextRunAt` jumps straight to the next future slot — the alternative is a ticker that
 * spends real time counting slots nobody will ever run.
 */
export const MAX_MISSED_SLOT_SCAN = 1500

/* ------------------------------------------------------------------ *
 * Time zones
 * ------------------------------------------------------------------ */

/**
 * Is this a zone the platform can actually resolve?
 *
 * **Measured, and NOT the same as `Intl.supportedValuesOf('timeZone')` membership.** That
 * list holds 418 canonical ids on Node 24 and deliberately excludes aliases — it does not
 * contain `UTC`, `Etc/UTC`, `GMT`, or `Asia/Kolkata` (which ICU canonicalises to
 * `Asia/Calcutta`). Validating against the list alone would refuse two of the zones this
 * story's own DST test matrix names. `Intl.DateTimeFormat` accepts exactly the set
 * `toZoned` will honour, so it is the honest acceptance test.
 *
 * The user's chosen string is stored verbatim, never canonicalised: someone who picked
 * "Asia/Kolkata" should not see their card say "Asia/Calcutta".
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
    return true
  } catch {
    return false
  }
}

/**
 * The zones the P2 create form offers. `UTC` is prepended because the canonical list
 * omits it and a Docker user whose container clock is UTC should be able to say so.
 */
export function listSelectableTimeZones(): string[] {
  let zones: string[] = []
  try {
    zones = Intl.supportedValuesOf('timeZone')
  } catch {
    zones = []
  }
  return zones.includes('UTC') ? zones : ['UTC', ...zones]
}

/* ------------------------------------------------------------------ *
 * Cadence validation (DL-115-03)
 * ------------------------------------------------------------------ */

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** `HH:MM`, 24-hour, minute precision. Anything else fails loudly. */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export type CadenceValidation =
  | { ok: true; cadence: ScheduleCadence }
  | { ok: false; error: string }

function parseTimeOfDay(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== 'string') return null
  const match = TIME_OF_DAY_PATTERN.exec(value.trim())
  if (!match) return null
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/**
 * Validate and normalise one cadence. Never clamps: an out-of-range interval or an
 * unreadable time is an error the caller has to show, not a number quietly changed.
 */
export function validateCadence(input: unknown): CadenceValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'A schedule needs a cadence: every N minutes, daily, or weekly.' }
  }
  const raw = input as Record<string, any>
  const type = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (!(SCHEDULE_CADENCE_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      error: `A cadence is one of ${SCHEDULE_CADENCE_TYPES.join(', ')}.`
    }
  }

  if (type === 'interval') {
    // Both spellings, deliberately (SA-115 P2). The stored record and the browser form use
    // `everyMinutes`; every model-facing field name in the Fabric families is snake_case,
    // so `sys.schedule.*` documents `every_minutes`. Reading only one of them would make an
    // agent following the published schema fail on its first call — the exact failure the
    // "name a control's input fields" rule exists to prevent, arriving through a different
    // door. Found by a test, not by reading.
    const rawMinutes = raw.everyMinutes ?? raw.every_minutes
    const minutes =
      typeof rawMinutes === 'number'
        ? rawMinutes
        : typeof rawMinutes === 'string' && rawMinutes.trim()
          ? Number(rawMinutes.trim())
          : Number.NaN
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes)) {
      return { ok: false, error: 'An interval cadence needs a whole number of minutes.' }
    }
    if (minutes < MIN_SCHEDULE_INTERVAL_MINUTES || minutes > MAX_SCHEDULE_INTERVAL_MINUTES) {
      return {
        ok: false,
        error: `An interval must be between ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes and ${MAX_SCHEDULE_INTERVAL_MINUTES} minutes (7 days).`
      }
    }
    return { ok: true, cadence: { type: 'interval', everyMinutes: minutes } }
  }

  const at = parseTimeOfDay(raw.at)
  if (!at) {
    return { ok: false, error: 'A time of day must look like 09:00 or 16:30 (24-hour).' }
  }
  const atText = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`

  if (type === 'daily') {
    return { ok: true, cadence: { type: 'daily', at: atText } }
  }

  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    return { ok: false, error: 'A weekly schedule needs at least one weekday.' }
  }
  const days: number[] = []
  for (const entry of raw.days) {
    // PR #106 review F-12: the interval branch's shape. `Number(null)`, `Number(false)`,
    // `Number('')` and `Number([])` are all 0, so a model emitting `[null]` used to get a
    // real Sunday schedule and a success answer — the exact "quietly changed number" the
    // contract above forbids.
    const day =
      typeof entry === 'number'
        ? entry
        : typeof entry === 'string' && entry.trim()
          ? Number(entry.trim())
          : Number.NaN
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, error: 'Weekdays are 0 to 6, with Sunday as 0.' }
    }
    if (!days.includes(day)) days.push(day)
  }
  days.sort((a, b) => a - b)
  return { ok: true, cadence: { type: 'weekly', days, at: atText } }
}

/* ------------------------------------------------------------------ *
 * Next-run math (DL-115-03, DL-115-04)
 * ------------------------------------------------------------------ */

/** Daily needs at most two days; the extra margin turns a surprise into a loud throw. */
const MAX_DAY_SCAN = 4
/** Weekly needs at most eight days to wrap the week. */
const MAX_WEEK_SCAN = 8

function weekdayOf(date: CalendarDate): number {
  // Proleptic Gregorian on both sides, so `Date.UTC` and `CalendarDate` agree. This is
  // deliberately not `getDayOfWeek(value, locale)`: that helper is relative to the
  // locale's first day of the week, and DL-115-03 pins Sunday = 0 absolutely.
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

function zonedInstant(date: CalendarDate, hour: number, minute: number, timeZone: string): Date {
  return toZoned(
    new CalendarDateTime(date.year, date.month, date.day, hour, minute),
    timeZone
  ).toDate()
}

function calendarDayIn(timeZone: string, at: Date): CalendarDate {
  const zoned = fromAbsolute(at.getTime(), timeZone)
  return new CalendarDate(zoned.year, zoned.month, zoned.day)
}

/**
 * The next instant this cadence is due, **strictly after** `from`.
 *
 * Strictly-after is what stops a double fire when a sweep happens to run exactly on the
 * slot: the fire records `lastRunAt = now` and then asks for the next run from that same
 * `now`, which must land on the following slot rather than the one just fired.
 *
 * `anchor` is used only by `interval`, where it names the **grid** the schedule runs on
 * (AMD-115-03). The answer is the first `anchor + k · everyMinutes` strictly after `from`.
 * A fire passes its own due slot as the anchor, so "every 5 minutes" stays on :00, :05,
 * :10 no matter how late the sweep that fired it happened to be. Creating a schedule
 * passes `now` for both, which starts the grid at `now + everyMinutes`.
 *
 * The alternative — `max(now, lastRunAt) + everyMinutes`, which this lock originally said
 * — measures the next run from the moment the fire *happened* rather than from the moment
 * it was *due*, so every fire's lateness (up to one sweep) is added to the period and
 * compounds: a 5-minute schedule fired at 09:00:37 goes next at 09:05:37, then 09:11:14,
 * then 09:16:51. `collapseMissedRuns` always kept the grid; this now matches it.
 *
 * Throws on an invalid cadence or an unresolvable zone. A schedule that cannot say when
 * it is next due must fail where it is written, not fire at a guessed time.
 */
export function computeNextRunAt(
  cadence: ScheduleCadence,
  timeZone: string,
  from: Date,
  anchor?: Date | null
): Date {
  const fromMs = from.getTime()
  if (!Number.isFinite(fromMs)) {
    throw new Error('computeNextRunAt needs a real "from" date.')
  }

  const validation = validateCadence(cadence)
  if (!validation.ok) throw new Error(validation.error)
  const normalized = validation.cadence

  if (normalized.type === 'interval') {
    const stepMs = normalized.everyMinutes * 60_000
    const anchorMs = anchor && Number.isFinite(anchor.getTime()) ? anchor.getTime() : fromMs
    // The smallest whole number of steps that lands strictly after `from`. `floor(x) + 1`
    // is that number for every real x, including an exact slot boundary (where floor(x)
    // is x itself, so the answer is the NEXT slot rather than this one) and an anchor that
    // is somehow ahead of `from` (where it goes negative and returns the anchor's own
    // grid point). Arithmetic, not a walk: a schedule that slept a month is one division.
    const steps = Math.floor((fromMs - anchorMs) / stepMs) + 1
    return new Date(anchorMs + steps * stepMs)
  }

  if (!isValidTimeZone(timeZone)) {
    throw new Error(`"${String(timeZone)}" is not a time zone this computer can resolve.`)
  }

  const parsed = parseTimeOfDay(normalized.at)
  if (!parsed) throw new Error(`"${normalized.at}" is not a readable time of day.`)

  let cursor = calendarDayIn(timeZone, from)
  const scan = normalized.type === 'daily' ? MAX_DAY_SCAN : MAX_WEEK_SCAN

  for (let step = 0; step <= scan; step += 1) {
    const dayMatches =
      normalized.type === 'daily' || normalized.days.includes(weekdayOf(cursor))
    if (dayMatches) {
      const candidate = zonedInstant(cursor, parsed.hour, parsed.minute, timeZone)
      if (candidate.getTime() > fromMs) return candidate
    }
    cursor = cursor.add({ days: 1 })
  }

  // Unreachable for a valid cadence: daily always matches within two days and weekly
  // within eight. Throwing is the only honest answer if that ever stops being true —
  // returning a past instant would make the ticker fire in a loop.
  throw new Error(
    `Could not find the next run for a ${normalized.type} schedule in ${timeZone}.`
  )
}

/* ------------------------------------------------------------------ *
 * Missed-run collapse (DL-115-07)
 * ------------------------------------------------------------------ */

export interface MissedRunCollapse {
  /** The most recent slot that went by unfired. */
  dueAt: Date
  /** How many slots went by unfired in THIS collapse. */
  missed: number
  /** The first slot strictly after `now`. Always in the future. */
  nextRunAt: Date
  /** True when the walk hit `MAX_MISSED_SLOT_SCAN` and the count is a floor, not a total. */
  capped: boolean
}

/**
 * Collapse every slot between a schedule's stored `nextRunAt` and now into ONE entry.
 *
 * Nothing fires here. The whole point is that a due time Batshit slept through waits for
 * the user: this only works out *what* was missed, *how many* times, and *when the next
 * real slot is*, so the ticker can move the schedule forward without running anything.
 *
 * `interval` is computed arithmetically rather than walked, because a 5-minute schedule
 * that was off for a month is 8,640 slots and walking them would cost real ticker time
 * for a number nobody reads precisely.
 */
export function collapseMissedRuns(input: {
  cadence: ScheduleCadence
  timeZone: string
  /** The schedule's stored `nextRunAt` — the first slot that went by. */
  dueAt: Date
  now: Date
}): MissedRunCollapse {
  const { cadence, timeZone, dueAt, now } = input
  const nowMs = now.getTime()

  const validation = validateCadence(cadence)
  if (!validation.ok) throw new Error(validation.error)
  const normalized = validation.cadence

  if (dueAt.getTime() > nowMs) {
    // Not overdue at all. The caller should not have asked, so say so rather than
    // inventing a missed run.
    throw new Error('collapseMissedRuns was called for a schedule that is not overdue.')
  }

  if (normalized.type === 'interval') {
    const stepMs = normalized.everyMinutes * 60_000
    const elapsed = nowMs - dueAt.getTime()
    const wholeSteps = Math.floor(elapsed / stepMs)
    const capped = wholeSteps + 1 > MAX_MISSED_SLOT_SCAN
    const missed = capped ? MAX_MISSED_SLOT_SCAN : wholeSteps + 1
    const mostRecent = new Date(dueAt.getTime() + wholeSteps * stepMs)
    return {
      dueAt: mostRecent,
      missed,
      nextRunAt: new Date(mostRecent.getTime() + stepMs),
      capped
    }
  }

  let slot = dueAt
  let mostRecent = dueAt
  let missed = 0
  let capped = false

  while (slot.getTime() <= nowMs) {
    missed += 1
    mostRecent = slot
    if (missed >= MAX_MISSED_SLOT_SCAN) {
      capped = true
      break
    }
    const next = computeNextRunAt(normalized, timeZone, slot, slot)
    if (next.getTime() <= slot.getTime()) {
      throw new Error('A cadence produced a next run that was not after the previous one.')
    }
    slot = next
  }

  // After a cap the walk stopped mid-history, so ask for the next slot from NOW rather
  // than from where the walk stopped. `nextRunAt` must always be in the future or the
  // ticker collapses the same schedule again every minute.
  const nextRunAt = capped
    ? computeNextRunAt(normalized, timeZone, now, now)
    : slot

  return { dueAt: mostRecent, missed, nextRunAt, capped }
}

/* ------------------------------------------------------------------ *
 * Wording
 * ------------------------------------------------------------------ */

function formatTimeOfDay(at: string): string {
  const parsed = parseTimeOfDay(at)
  if (!parsed) return at
  const period = parsed.hour < 12 ? 'AM' : 'PM'
  const hour12 = parsed.hour % 12 === 0 ? 12 : parsed.hour % 12
  return `${hour12}:${String(parsed.minute).padStart(2, '0')} ${period}`
}

/** "every 30 min", "every 2 hours", "daily at 9:00 AM", "Tue, Thu at 4:00 PM". */
export function describeCadence(cadence: ScheduleCadence): string {
  const validation = validateCadence(cadence)
  if (!validation.ok) return 'an invalid cadence'
  const normalized = validation.cadence

  if (normalized.type === 'interval') {
    const minutes = normalized.everyMinutes
    if (minutes % 1440 === 0) {
      const days = minutes / 1440
      return days === 1 ? 'every day' : `every ${days} days`
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60
      return hours === 1 ? 'every hour' : `every ${hours} hours`
    }
    return `every ${minutes} min`
  }

  if (normalized.type === 'daily') {
    return `daily at ${formatTimeOfDay(normalized.at)}`
  }

  const days = normalized.days.map((day) => WEEKDAY_LABELS[day]).join(', ')
  return `${days} at ${formatTimeOfDay(normalized.at)}`
}

/**
 * "Tue, Sep 15, 4:00 PM CDT" — always in the schedule's own zone, so the card shows the
 * time the user chose rather than the time the server happens to be in.
 *
 * `en-US` is pinned rather than left to the browser: the schedule's zone is the variable
 * that matters here, and a stable string keeps the tests honest.
 */
export function describeNextRun(at: Date | string, timeZone: string): string {
  const value = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(value.getTime())) return 'not scheduled'
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: zone
  }).format(value)
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: zone
  }).format(value)
  return `${day}, ${time}`
}

/**
 * "2 hours ago", "23 days ago" — how old a missed run is.
 *
 * This carries real weight in the *Missed while Batshit was off* dialog. Josh's rule was
 * that a long absence "probably shouldn't run at all", and the answer to that is **the
 * user reading the age and pressing Skip**, not a hidden cut-off that silently drops runs
 * (DL-115-07). So this sentence is the whole mechanism for that decision, and it stays
 * coarse and readable rather than precise: "23 days ago" is what makes someone press Skip.
 */
export function describeAge(at: Date | string, now: Date = new Date()): string {
  const value = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(value.getTime())) return 'at an unknown time'

  const seconds = Math.round((now.getTime() - value.getTime()) / 1000)
  if (seconds < 0) return 'in the future'
  if (seconds < 60) return 'just now'

  const units: [number, string][] = [
    [60, 'minute'],
    [60, 'hour'],
    [24, 'day'],
    [7, 'week']
  ]
  let amount = seconds
  let label = 'second'
  for (const [size, nextLabel] of units) {
    if (amount < size) break
    amount = Math.floor(amount / size)
    label = nextLabel
  }
  return `${amount} ${label}${amount === 1 ? '' : 's'} ago`
}

/* ------------------------------------------------------------------ *
 * Whole-schedule validation
 * ------------------------------------------------------------------ */

export interface ScheduleFieldsInput {
  name?: unknown
  cadence?: unknown
  timeZone?: unknown
  message?: unknown
  kind?: unknown
  deliver?: unknown
  enabled?: unknown
}

export interface NormalizedScheduleFields {
  name: string
  cadence: ScheduleCadence
  timeZone: string
  message: string
  kind: ScheduleKind
  deliver: ScheduleDeliveryMode
  enabled: boolean
}

export type ScheduleValidation =
  | { ok: true; fields: NormalizedScheduleFields }
  | { ok: false; error: string }

/**
 * Validate every field of a new schedule at once, so the form and `sys.schedule.create`
 * refuse the same things for the same reasons.
 *
 * `info` + `wake` is the default (DL-115-14): "wake this agent every day at 9am and say
 * X" is the sentence this story exists for.
 */
export function validateScheduleFields(input: ScheduleFieldsInput): ScheduleValidation {
  const name =
    typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { ok: false, error: 'A schedule needs a name.' }
  if (name.length > SCHEDULE_NAME_MAX_CHARS) {
    return {
      ok: false,
      error: `A schedule name is at most ${SCHEDULE_NAME_MAX_CHARS} characters.`
    }
  }

  const cadenceValidation = validateCadence(input.cadence)
  if (!cadenceValidation.ok) return { ok: false, error: cadenceValidation.error }
  const cadence = cadenceValidation.cadence

  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : ''
  if (!isValidTimeZone(timeZone)) {
    return {
      ok: false,
      error: 'A schedule needs a time zone this computer can resolve, for example America/Chicago.'
    }
  }

  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message) return { ok: false, error: 'A schedule needs a message to send.' }
  if (message.length > SCHEDULE_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      error: `A schedule message is at most ${SCHEDULE_MESSAGE_MAX_CHARS} characters.`
    }
  }

  let kind: ScheduleKind = 'info'
  if (input.kind !== undefined && input.kind !== null) {
    if (!isScheduleKind(input.kind)) {
      return { ok: false, error: 'A schedule sends either an info note or an assignment.' }
    }
    kind = input.kind
  }

  let deliver: ScheduleDeliveryMode = 'wake'
  if (input.deliver !== undefined && input.deliver !== null) {
    if (!isScheduleDeliveryMode(input.deliver)) {
      return {
        ok: false,
        error: 'A schedule either waits in the inbox ("wait") or wakes the agent ("wake").'
      }
    }
    deliver = input.deliver
  }

  const enabled = input.enabled === undefined || input.enabled === null ? true : input.enabled === true

  return { ok: true, fields: { name, cadence, timeZone, message, kind, deliver, enabled } }
}
