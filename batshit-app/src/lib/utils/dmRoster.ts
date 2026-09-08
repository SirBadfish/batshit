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
import { isOpenDmStatus, type DmRecord } from '$lib/types/dm'

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
    const isNew =
      typeof input.previousUserMessageTs !== 'number' ||
      record.createdTs > input.previousUserMessageTs
    const mark = isNew ? '✅' : '🟢'
    const urgent = record.priority === 'urgent' ? ' (urgent)' : ''
    lines.push(
      `- ${record.id} ${mark} ${record.kind}${urgent} from ${record.from.name}: ` +
        `"${record.subject}" — ${describeState(record, input.sessionId)}; ` +
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
