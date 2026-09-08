/**
 * SA-113 P4 (DL-113-10a) — the per-agent open-DM counts behind the header badge.
 *
 * Small on purpose. The badge needs two numbers per agent and nothing else, and the server
 * already publishes exactly those on the user channel (`dm_inbox_changed`, written by the
 * DM store's `announceInboxChanged`). So this store is a map, a hydrate, and an apply — no
 * polling, no fetching on a timer, and no second source of truth for what is in an inbox.
 *
 * The drawer reads the DM records themselves from `/api/dms`; that list is bigger, and a
 * user looking at it can afford a request. The badge cannot, because it is on screen the
 * whole time.
 */

export type DmInboxCounts = {
  /** Open items: `new` plus `working`. This is the number on the badge. */
  openCount: number
  /** Of those, the ones the agent has not claimed yet. */
  newCount: number
  /**
   * F-SEC-1b: of those, the ones whose woken turn stopped waiting on the USER — a risky
   * control Batshit refused in a woken chat, or a tool approval nobody answered. This is
   * the only count that changes the envelope's colour to a warning, because it is the only
   * one that means "you have to go do something".
   */
  needsUserCount: number
}

const counts = $state<Record<string, DmInboxCounts>>({})

export function getDmInboxCounts(agentId: string | null | undefined): DmInboxCounts {
  const id = typeof agentId === 'string' ? agentId.trim() : ''
  if (!id) return { openCount: 0, newCount: 0, needsUserCount: 0 }
  return counts[id] ?? { openCount: 0, newCount: 0, needsUserCount: 0 }
}

export function applyDmInboxChanged(event: {
  agentId?: unknown
  openCount?: unknown
  newCount?: unknown
  needsUserCount?: unknown
}): void {
  const agentId = typeof event.agentId === 'string' ? event.agentId.trim() : ''
  if (!agentId) return
  counts[agentId] = {
    openCount: Number.isFinite(event.openCount) ? Math.max(0, Number(event.openCount)) : 0,
    newCount: Number.isFinite(event.newCount) ? Math.max(0, Number(event.newCount)) : 0,
    needsUserCount: Number.isFinite(event.needsUserCount)
      ? Math.max(0, Number(event.needsUserCount))
      : 0
  }
}

/**
 * Seed every agent's count from a `/api/dms` read, so a freshly opened tab shows the right
 * badge before any live event arrives. Agents missing from `rows` are reset to zero rather
 * than left stale — a DM deleted while this tab was closed must not keep its badge.
 */
export function hydrateDmInboxCounts(
  rows: Array<{ to?: unknown; status?: unknown; delivery?: { needsUser?: unknown } }>,
  agentIds: string[]
): void {
  const next: Record<string, DmInboxCounts> = {}
  for (const id of agentIds) next[id] = { openCount: 0, newCount: 0, needsUserCount: 0 }
  for (const row of rows) {
    const to = typeof row.to === 'string' ? row.to : ''
    if (!to) continue
    if (row.status !== 'new' && row.status !== 'working') continue
    const entry = (next[to] ??= { openCount: 0, newCount: 0, needsUserCount: 0 })
    entry.openCount += 1
    if (row.status === 'new') entry.newCount += 1
    if (row.delivery?.needsUser) entry.needsUserCount += 1
  }
  for (const key of Object.keys(counts)) delete counts[key]
  Object.assign(counts, next)
}

let hydrating: Promise<void> | null = null
let hydrated = false

/**
 * Seed the counts once per page load, so a fresh tab shows the right badge before any live
 * event arrives.
 *
 * One request, shared: the drawer and the header envelope both want the same numbers, and
 * whoever asks first pays for it. After that the user channel keeps them current, so this
 * never runs on a timer.
 */
export async function ensureDmInboxCountsHydrated(): Promise<void> {
  if (hydrated) return
  if (hydrating) return hydrating
  hydrating = (async () => {
    try {
      const response = await fetch('/api/dms')
      const payload = await response.json()
      if (!response.ok || !payload?.success) return
      const agentIds = Array.isArray(payload.agents)
        ? payload.agents.map((agent: { id?: unknown }) => String(agent?.id ?? '')).filter(Boolean)
        : []
      hydrateDmInboxCounts(Array.isArray(payload.dms) ? payload.dms : [], agentIds)
      hydrated = true
    } catch {
      // A badge that could not be seeded stays at zero and the next live event corrects it.
    } finally {
      hydrating = null
    }
  })()
  return hydrating
}

/** Test-only reset; the store is module state, like `chatRunRegistry`'s. */
export function __resetDmInboxCountsForTests(): void {
  for (const key of Object.keys(counts)) delete counts[key]
  hydrated = false
  hydrating = null
}
