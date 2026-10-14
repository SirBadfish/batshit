/**
 * SA-113 P2 (DL-113-04b) — the DCM `DMs:` roster, as pure text.
 *
 * The third member of the "durable per-agent state you should act on" family, emitted
 * directly after `Clips attached:` and before `Memory context:`. It lists OPEN items only:
 * a done item is gone from the roster, which is the whole point — Josh's rule is that a
 * handled DM must stop costing tokens, and that re-listing it is confusing as well as
 * wasteful.
 *
 * No Redis and no `$lib/server` import. The store read happens ONCE at the compile site,
 * beside `resolveSessionClipCompileState`, and the records are handed here already read —
 * the DL-104-17 / SA-109 rule that keeps a compile to one read per source of truth.
 *
 * Returns `[]` when there is nothing open, so an agent with an empty inbox — and every
 * agent without DMs turned on — compiles byte-identically to before this shipped.
 */

import { DM_ROSTER_MAX_LINES } from '$lib/utils/dmControl'
import { isOpenDmStatus, readDmFires, type DmRecord } from '$lib/types/dm'

const DAY_MS = 24 * 60 * 60 * 1000

export interface DmRosterInput {
  records: DmRecord[]
  /** The session being compiled, so "claimed here" reads differently from "claimed elsewhere". */
  sessionId?: string | null
  /**
   * When this session's PREVIOUS user message was written. A DM created after it is new to
   * the agent this turn (✅); anything older was already on the roster last turn (🟢).
   * Undefined for a session with no previous user message — a woken session's first turn,
   * where everything is genuinely new.
   */
  previousUserMessageTs?: number | null
  now?: number
  /**
   * BL-401: the zone a fire's time is written in. Left out in production, so it is the
   * runtime's own zone (the `TZ` a launcher sets to the user's), the zone every other
   * agent-facing time in the compile uses. Tests pin it.
   */
  timeZone?: string
}

export interface DmRosterResult {
  lines: string[]
  /** The ids the roster listed, for the Execution Viewer twin. */
  listedIds: string[]
  totalOpen: number
}

function describeExpiry(expiresAt: string, now: number): string {
  const expiresTs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresTs)) return 'expiry unknown'
  const remaining = expiresTs - now
  if (remaining <= 0) return 'expired'
  const days = Math.floor(remaining / DAY_MS)
  if (days >= 1) return `expires in ${days}d`
  const hours = Math.max(1, Math.round(remaining / (60 * 60 * 1000)))
  return `expires in ${hours}h`
}

/**
 * A fire's time for an agent: "9:00 AM" on the day of `now`, "Sep 25 9:00 AM" on another day,
 * in `en-US` like the compile's other times. The narrow no-break space some ICU builds put
 * before AM/PM becomes a plain space, so the roster's bytes do not depend on the ICU version.
 */
function formatFireTime(atTs: number, now: number, timeZone: string | undefined): string {
  const zone = timeZone ? { timeZone } : {}
  const day = (ts: number) =>
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...zone
    }).format(ts)
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...zone
  })
    .format(atTs)
    .replace(/\u202f/g, ' ')
  if (day(atTs) === day(now)) return time
  const shortDay = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...zone
  }).format(atTs)
  return `${shortDay} ${time}`
}

/**
 * BL-401 S3 — the phrase that tells an agent how often a schedule fired onto one note:
 * `fired 14 times, first 9:00 AM, last 5:00 PM`. `null` for a note that fired once (and for
 * every other DM), so an inbox without such a note compiles byte-identically to before.
 * The roster line and `sys.dm.list` both use it.
 */
export function describeDmFires(
  record: Pick<DmRecord, 'createdAt' | 'createdTs' | 'fireCount' | 'firstFiredAt' | 'lastFiredAt'>,
  options: { now?: number; timeZone?: string } = {}
): string | null {
  const fires = readDmFires(record)
  if (fires.count <= 1) return null
  const now = options.now ?? Date.now()
  const firstTs = Date.parse(fires.firstAt)
  const first = Number.isFinite(firstTs)
    ? formatFireTime(firstTs, now, options.timeZone)
    : 'unknown'
  const last = formatFireTime(fires.lastTs, now, options.timeZone)
  return `fired ${fires.count} times, first ${first}, last ${last}`
}

function describeState(record: DmRecord, sessionId: string | null | undefined): string {
  if (record.status !== 'working') return 'new'
  const claimedSession = record.claimedBy?.sessionId ?? null
  if (claimedSession && sessionId && claimedSession === sessionId) {
    return 'claimed in this session'
  }
  return 'claimed in another session'
}

/**
 * Build the roster. Open items only, in the store's own order (urgent first, then oldest),
 * capped so a busy inbox cannot crowd out the rest of the DCM.
 */
export function buildDmRosterDcmLines(input: DmRosterInput): DmRosterResult {
  const now = input.now ?? Date.now()
  const open = input.records.filter((record) => isOpenDmStatus(record.status))
  if (open.length === 0) return { lines: [], listedIds: [], totalOpen: 0 }

  const shown = open.slice(0, DM_ROSTER_MAX_LINES)
  const lines: string[] = [
    'DMs (your inbox; open items only; use sys.dm.* to read, claim, and close):'
  ]

  for (const record of shown) {
    // BL-401 S3: the mark follows the LAST fire, so a schedule note that fired again since
    // the agent's previous turn reads as new again. For every other DM that is `createdTs`.
    const isNew =
      typeof input.previousUserMessageTs !== 'number' ||
      readDmFires(record).lastTs > input.previousUserMessageTs
    const mark = isNew ? '✅' : '🟢'
    const urgent = record.priority === 'urgent' ? ' (urgent)' : ''
    const fires = describeDmFires(record, { now, timeZone: input.timeZone })
    lines.push(
      `- ${record.id} ${mark} ${record.kind}${urgent} from ${record.from.name}: ` +
        `"${record.subject}" — ${describeState(record, input.sessionId)}; ` +
        (fires ? `${fires}; ` : '') +
        describeExpiry(record.expiresAt, now)
    )
  }

  const remaining = open.length - shown.length
  if (remaining > 0) {
    lines.push(`- More open: ${remaining} (use sys.dm.list to see them all)`)
  }

  return {
    lines,
    listedIds: shown.map((record) => record.id),
    totalOpen: open.length
  }
}
