/**
 * BL-437: the Memory Panel's Expires field is a date picker (a `YYYY-MM-DD` day in the
 * browser's local calendar), while a memory stores one exact instant (`expires_at`, with
 * `expires_ts` as its epoch-ms mirror). These helpers are the only conversion between the two.
 *
 * - The picker shows the LOCAL day the stored instant falls on (never the UTC date part of
 *   the ISO string, which is the next day for a late-evening expiry west of UTC).
 * - A picked day means "through the end of that local day": the last millisecond before the
 *   next local midnight (BL-1237: the final hour can repeat), so the
 *   memory stays in Awareness for the whole day the user chose and the picker shows that same
 *   day again after the save. (`new Date('YYYY-MM-DD')` is midnight UTC, which is the previous
 *   afternoon in the Americas: the old save expired a picked day before it began.)
 * - A Save sends `expires_at` only when the user changed the field, so saving any other field
 *   leaves a stored expiry, time of day included, exactly as it was.
 *
 * BL-785: the same rule holds for an expiry an agent writes (`sys.memory.save`/`update`, the
 * inline tag): the store passes every incoming `expires_at` through `normalizeExpiryInput`, so a
 * bare day means the end of that local day there too (the server's local day), and a full
 * timestamp stays exactly as given.
 *
 * BL-817: an event day an agent writes (`event_at`) is the other end of the same day. The store
 * passes every incoming `event_at` through `normalizeEventAtInput`: a bare day means the START of
 * that local day (the day memory search reads a bare `event_from` as, and the local day the
 * "Happened" line and the memory lines print), and a full timestamp stays exactly as given.
 *
 * Client-safe and pure: no server imports.
 */

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** The local calendar day (`YYYY-MM-DD`) a stored expiry falls on, or '' when there is none. */
export function expiryToDateInput(expiresAt: unknown): string {
  if (typeof expiresAt !== 'string' || !expiresAt.trim()) return ''
  const instant = new Date(expiresAt)
  if (!Number.isFinite(instant.getTime())) return ''
  return `${instant.getFullYear()}-${twoDigits(instant.getMonth() + 1)}-${twoDigits(instant.getDate())}`
}

/**
 * A bare `YYYY-MM-DD` day as a local instant at the given time of day, refused when it is not a
 * calendar day (`new Date(2026, 1, 31)` would roll over to March 3). `label` names the field in
 * the refusal.
 */
function localDayInstant(
  value: string,
  label: string,
  time: { hours: number; minutes: number; seconds: number; ms: number }
): string {
  const match = DATE_INPUT_PATTERN.exec(value.trim())
  if (!match) throw new Error(`The ${label} date must be a calendar day (YYYY-MM-DD), not '${value}'.`)
  const [year, month, day] = match.slice(1).map(Number)
  const instant = new Date(year, month - 1, day, time.hours, time.minutes, time.seconds, time.ms)
  if (instant.getFullYear() !== year || instant.getMonth() !== month - 1 || instant.getDate() !== day) {
    throw new Error(`The ${label} date '${value}' is not a real calendar day.`)
  }
  return instant.toISOString()
}

/** The last instant of a picked local day as an ISO instant. Throws on a bad day. */
export function dateInputToExpiry(value: string): string {
  // Keep the existing calendar validation, then include a repeated final hour (BL-1237).
  const localEnd = new Date(localDayInstant(value, 'expiry', { hours: 23, minutes: 59, seconds: 59, ms: 999 }))
  const nextMidnight = new Date(localEnd.getFullYear(), localEnd.getMonth(), localEnd.getDate() + 1)
  return new Date(nextMidnight.getTime() - 1).toISOString()
}

/** The start of a local day (00:00:00.000 local time) as an ISO instant. Throws on a bad day. */
export function dateInputToEventStart(value: string): string {
  return localDayInstant(value, 'event', { hours: 0, minutes: 0, seconds: 0, ms: 0 })
}

/**
 * BL-785: the one reading of an incoming `expires_at`. A bare calendar day (`YYYY-MM-DD`) becomes
 * the end of that local day (`dateInputToExpiry`, which refuses a day that does not exist rather
 * than letting `new Date('2026-02-31')` roll over to March 3); anything else is returned exactly
 * as given for the caller's own timestamp validation.
 */
export function normalizeExpiryInput(value: string): string {
  return DATE_INPUT_PATTERN.test(value.trim()) ? dateInputToExpiry(value) : value
}

/**
 * BL-817: the one reading of an incoming `event_at`, the start-of-day twin of
 * `normalizeExpiryInput`. A bare calendar day (`YYYY-MM-DD`) becomes the START of that local day
 * (`dateInputToEventStart`), so the day an agent named is the day the memory prints and the day a
 * search for it finds; anything else is returned exactly as given for the caller's own timestamp
 * validation.
 */
export function normalizeEventAtInput(value: string): string {
  return DATE_INPUT_PATTERN.test(value.trim()) ? dateInputToEventStart(value) : value
}

/**
 * The `expires_at` part of a Memory Panel save. `hydrated` is what the picker showed when the
 * record loaded (`expiryToDateInput` of the stored value). Unchanged: nothing, so the stored
 * instant stays byte for byte. Cleared: `null`. A new day: the end of that local day.
 */
export function expiresAtUpdate(draft: string, hydrated: string): { expires_at?: string | null } {
  if (draft === hydrated) return {}
  if (!draft.trim()) return { expires_at: null }
  return { expires_at: dateInputToExpiry(draft) }
}
