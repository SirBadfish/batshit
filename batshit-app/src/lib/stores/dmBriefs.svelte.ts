/**
 * SA-120 P7 — a chat page's short read of a DM, by DM id: who wrote it, its subject and the
 * start of its body, and what the Jev Juice incoming-text screen said about it.
 *
 * Three surfaces ask: the Agent DM tool card (by the `dm_id` in its own result), and, in a
 * chat a wake-up message started, the origin line on an approval card and the notice card
 * above it (both by the `metadata.wake.dmId` of the user message before the reply), plus the
 * flag on that wake-up message itself.
 *
 * A DM is screened ONCE, when it arrives and before it is delivered, so by the time any card
 * can name a DM id the answer is already stored: one read per id, remembered for the life of
 * the tab, hit or miss. Asks made in the same tick share one request. No polling, no event.
 *
 * `screen` only ever holds what may be drawn: a flag, or the note that the screen could not
 * run. "No flag" and "never screened" are the same `null` here, on purpose (DL-120-12).
 */

import { readUntrustedTextScreen, type UntrustedTextScreenView, type WakeOrigin } from '$lib/utils/jevJuice'

export interface DmBriefView {
  from: WakeOrigin
  subject: string
  snippet: string
  screen: UntrustedTextScreenView | null
}

const DM_ID_PATTERN = /^dm_[A-Za-z0-9_]{1,64}$/
const MAX_IDS_PER_REQUEST = 50

/** `undefined` = never asked, `null` = asked and not ours (or gone). */
let briefsByDmId = $state<Record<string, DmBriefView | null>>({})

const asked = new Set<string>()
let queued: string[] = []
let flushScheduled = false
let fetcher: typeof fetch | null = null

function normalize(value?: string | null): string | null {
  const id = typeof value === 'string' ? value.trim() : ''
  return DM_ID_PATTERN.test(id) ? id : null
}

function readBrief(value: unknown): DmBriefView | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { from?: { kind?: unknown; name?: unknown }; subject?: unknown; snippet?: unknown; screen?: unknown }
  const kind = raw.from?.kind === 'webhook' || raw.from?.kind === 'schedule' ? raw.from.kind : 'agent'
  return {
    from: { kind, name: typeof raw.from?.name === 'string' ? raw.from.name : '' },
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
    screen: readUntrustedTextScreen(raw.screen)
  }
}

/** One DM's brief, or `null`. Reactive: a card that reads it redraws when it lands. */
export function getDmBrief(dmId: string | null | undefined): DmBriefView | null {
  const id = normalize(dmId)
  return id ? (briefsByDmId[id] ?? null) : null
}

/** The drawable screen of one DM, or `null`: a flag, or the note that the screen could not run. */
export function getJevJuiceDmScreen(dmId: string | null | undefined): UntrustedTextScreenView | null {
  return getDmBrief(dmId)?.screen ?? null
}

async function flush(): Promise<void> {
  flushScheduled = false
  const ids = queued.splice(0, MAX_IDS_PER_REQUEST)
  if (queued.length > 0) scheduleFlush()
  if (ids.length === 0) return
  try {
    const response = await (fetcher ?? fetch)(`/api/dms/brief?ids=${encodeURIComponent(ids.join(','))}`)
    if (!response.ok) throw new Error(`status ${response.status}`)
    const payload = await response.json().catch(() => null)
    const briefs = (payload?.briefs ?? {}) as Record<string, unknown>
    const next = { ...briefsByDmId }
    for (const id of ids) next[id] = readBrief(briefs[id])
    briefsByDmId = next
  } catch (error) {
    // A card that did not load must never break a chat. Forget the ask so a later card can retry.
    for (const id of ids) asked.delete(id)
    console.warn('[Agent DMs] Could not read DM briefs:', error)
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => void flush())
}

/** Ask for a DM's brief once. Safe to call from an `$effect` on every render. */
export function requestDmBrief(dmId: string | null | undefined, options: { fetch?: typeof fetch } = {}): void {
  const id = normalize(dmId)
  if (!id || asked.has(id)) return
  asked.add(id)
  if (options.fetch) fetcher = options.fetch
  queued.push(id)
  scheduleFlush()
}

/** Test seam. */
export function __resetDmBriefsForTests(): void {
  briefsByDmId = {}
  asked.clear()
  queued = []
  flushScheduled = false
  fetcher = null
}
