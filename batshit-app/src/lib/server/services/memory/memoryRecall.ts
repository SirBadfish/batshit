/**
 * SA-104 P4 — the recall engine (DL-104-04 / -08 / -09 / -16 / -17).
 *
 * One server-side implementation computes everything prompt-visible about memory:
 * trigger scanning over the current user message, pending-recall consumption, linger
 * classification with three-way dedup, per-lane budgets with visible "more available"
 * honesty, the on-my-mind system-prompt block, agent-level time awareness, and the
 * formatted DCM "Memory context" section. The one compilation path calls
 * `computeMemoryCompileContext` directly (SA-106 retired the second, n8n-only twin and
 * its `POST /api/memory/compile-context` route). Presentation is formatted HERE, not at
 * the call site (P0 §1.1: never implement ranking twice).
 *
 * Compile-time computation is strictly READ-ONLY. State changes happen only in
 * `commitMemoryTurnState`, called from send-routed at the accepted-send boundary — the
 * same place session clips consume, and since SA-106 the only such boundary — gated by
 * the same continuation flag so
 * context-exhaustion auto-continues never double-tick the linger window.
 *
 * The automatic lanes deliberately read records directly (listMemories house pattern)
 * instead of the FT indexes: ambient recall cannot be silently killed by index trouble,
 * and the loud index guards stay where DL-104-10 put them (boot, saves, search).
 */

import { redis } from '$lib/server/redis'
import { estimateTokens } from '$lib/utils/tokens'
import {
  resolveAgentMemoryEnabled,
  resolveMemoryIdleGapHours,
  resolveMemoryLaneBudgets,
  resolveMemoryLingerOverride,
  resolveMemoryLingerTurns,
  resolveMemoryRecallLingerTurns,
  type MemoryLaneBudgets
} from '$lib/utils/memoryControl'
import {
  fetchMemorySegmentsByIds,
  listMemories,
  touchMemoryRecall,
  touchMemorySegmentRecall
} from './memoryStore'
import type { MemoryRecord, MemorySegmentRecord } from './memoryTypes'
import {
  getMemoryLingerState,
  setMemoryLingerState,
  type MemoryLingerEntry,
  type MemoryLingerRecord,
  type MemoryLingerSource
} from './memoryLinger'
import { MEMORY_SCHEMA_VERSION } from './memoryTypes'
import { isFixedSession } from '$lib/utils/fixedSession'
import { getOpenEpisode } from './memoryEpisodes'

// Status icons match the DCM's existing key: new / updated / unchanged.
const ICON_NEW = '✅'
const ICON_REFRESHED = '✳️'
const ICON_HELD = '\u{1F7E2}'

export type MemoryInsertStatus = 'new' | 'refreshed' | 'held'

export interface MemoryInsertCandidate {
  record: MemoryRecord
  source: MemoryLingerSource
  status: MemoryInsertStatus
  /** Trigger terms from THIS message that matched (trigger + refreshed entries). */
  matchedTerms: string[]
  /** Remaining linger turns as stored (held entries only; this turn included). */
  turnsRemaining?: number
  /** True for 'episode' linger holds — no countdown; drops when the episode ends. */
  holdEpisode?: boolean
  firstInsertedAt?: string
}

/**
 * Episode context for 'episode' linger holds, computed identically by compile and
 * commit: the open episode id (fixed/Infinite sessions), and whether the regular
 * session's conversation stretch ended (idled past the agent's idle gap since the
 * previous accepted-send commit).
 */
export interface MemoryEpisodeContext {
  isFixedSession: boolean
  openEpisodeId: string | null
  /** Regular sessions: true when the idle gap has passed since the last commit. */
  stretchEnded: boolean
}

export interface MemorySelection {
  current: MemoryInsertCandidate[]
  lingering: MemoryInsertCandidate[]
  /** Pending ids resolved this turn (inserted, already-on-mind, or missing). */
  consumedPendingIds: string[]
  /** Pending ids deferred by the recalled-lane budget; they stay queued. */
  deferredPendingIds: string[]
  moreAvailable: string[]
  onMyMind: {
    entries: MemoryRecord[]
    truncatedCount: number
    tokenEstimate: number
  }
}

export interface MemoryCompileContext {
  enabled: boolean
  /**
   * Full `==== AWARENESS … ====` block, or '' when there are no entries.
   * Internal field name stays `onMyMindBlock` (persisted EV metadata mirrors it);
   * the product language is "Awareness" everywhere (2026-08-26 rename).
   */
  onMyMindBlock: string
  /**
   * SA-104 P6: the open episode's whiteboard as a system-prompt block (Infinite Sessions
   * only), appended directly after AWARENESS. '' when absent.
   */
  whiteboardBlock: string
  /** Formatted "Memory context:" lines for the DCM, or [] when there is nothing. */
  dcmLines: string[]
  /** Clip ids carried by inserted memories, for the structured image path. */
  memoryClipIds: string[]
  /** clipId → memoryId, for REMEMBERED MEDIA labeling. */
  memoryClipSources: Record<string, string>
  /** Execution Viewer metadata (structuredInput.metadata.memoryContext). */
  memoryContext: Record<string, any> | null
}

const EMPTY_CONTEXT: MemoryCompileContext = {
  enabled: false,
  onMyMindBlock: '',
  whiteboardBlock: '',
  dcmLines: [],
  memoryClipIds: [],
  memoryClipSources: {},
  memoryContext: null
}

function nowStamps(): { iso: string; ts: number } {
  const now = new Date()
  return { iso: now.toISOString(), ts: now.getTime() }
}

// ---------------------------------------------------------------------------
// SA-104 P6: recalled graduated segments ride the SAME insert machinery as memory
// records (single-channel rule, DL-104-17). A segment becomes a record-shaped
// insertable whose content is its summary; `__segment` carries the display metadata
// and marks the kind for linger entries and recall-refresh.
// ---------------------------------------------------------------------------

interface SegmentInsertMeta {
  sessionId: string
  firstMessageAt: string
  lastMessageAt: string
  messageCount: number
}

type InsertableRecord = MemoryRecord & { __segment?: SegmentInsertMeta }

function segmentToInsertable(segment: MemorySegmentRecord): InsertableRecord {
  const graduatedTs = new Date(segment.graduated_at).getTime()
  return {
    id: segment.id,
    agent_id: segment.agent_id,
    user_id: segment.user_id,
    lane: 'ltm',
    content: segment.summary,
    importance: 5,
    event_at: segment.first_message_at,
    event_ts: segment.first_message_ts,
    saved_at: segment.graduated_at,
    saved_ts: Number.isFinite(graduatedTs) ? graduatedTs : 0,
    is_superseded: 'n',
    provenance: [{ session_id: segment.session_id, source: 'agent' }],
    visibility: 'normal',
    ...(segment.last_recalled_at ? { last_recalled_at: segment.last_recalled_at } : {}),
    ...(typeof segment.last_recalled_ts === 'number'
      ? { last_recalled_ts: segment.last_recalled_ts }
      : {}),
    ...(typeof segment.recall_count === 'number' ? { recall_count: segment.recall_count } : {}),
    embedding: [],
    embedding_model: segment.embedding_model,
    schema_version: MEMORY_SCHEMA_VERSION,
    __segment: {
      sessionId: segment.session_id,
      firstMessageAt: segment.first_message_at,
      lastMessageAt: segment.last_message_at,
      messageCount: segment.message_ids.length
    }
  }
}

/** Segments referenced by the session's pending/lingering recall state, as insertables. */
async function loadRecalledSegmentInsertables(
  agentId: string,
  linger: MemoryLingerRecord | null
): Promise<InsertableRecord[]> {
  const segmentIds = new Set<string>()
  for (const entry of linger?.pending ?? []) {
    if (entry.agent_id === agentId && entry.kind === 'segment') segmentIds.add(entry.memory_id)
  }
  for (const entry of linger?.lingering ?? []) {
    if (entry.agent_id === agentId && entry.kind === 'segment') segmentIds.add(entry.memory_id)
  }
  if (segmentIds.size === 0) return []
  const segments = await fetchMemorySegmentsByIds(agentId, Array.from(segmentIds))
  return segments.map(segmentToInsertable)
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive whole-word match. Multi-word terms match across flexible
 * whitespace. Terms that do not start/end on word characters fall back to plain
 * substring semantics (regex boundaries only exist next to word characters).
 */
export function messageMatchesTriggerTerm(message: string, term: string): boolean {
  const normalized = term.trim()
  if (!normalized) return false
  const pattern = escapeRegex(normalized).replace(/\s+/g, '\\s+')
  const leading = /^[\p{L}\p{N}_]/u.test(normalized) ? '(?<![\\p{L}\\p{N}_])' : ''
  const trailing = /[\p{L}\p{N}_]$/u.test(normalized) ? '(?![\\p{L}\\p{N}_])' : ''
  return new RegExp(`${leading}${pattern}${trailing}`, 'iu').test(message)
}

function matchTriggerTerms(message: string, record: MemoryRecord): string[] {
  const matched: string[] = []
  for (const term of [...(record.trigger_terms ?? []), ...(record.trigger_synonyms ?? [])]) {
    if (messageMatchesTriggerTerm(message, term)) matched.push(term)
  }
  return matched
}

// ---------------------------------------------------------------------------
// Selection (pure given loaded state — the one function compile AND commit share)
// ---------------------------------------------------------------------------

function isExpired(record: MemoryRecord, nowTs: number): boolean {
  return typeof record.expires_ts === 'number' && record.expires_ts <= nowTs
}

function insertTokenCost(record: MemoryRecord): number {
  return estimateTokens(record.content)
}

/** True while an 'episode' linger hold's episode / conversation stretch is still live. */
function episodeHoldAlive(
  entry: { episode_id?: string | null },
  episode: MemoryEpisodeContext
): boolean {
  if (episode.isFixedSession) {
    return Boolean(entry.episode_id) && entry.episode_id === episode.openEpisodeId
  }
  return !episode.stretchEnded
}

function selectMemoryInserts(options: {
  agentId: string
  currentUserMessage: string
  records: MemoryRecord[]
  linger: MemoryLingerRecord | null
  budgets: MemoryLaneBudgets
  episode: MemoryEpisodeContext
  nowTs: number
}): MemorySelection {
  const { agentId, currentUserMessage, records, linger, budgets, episode, nowTs } = options
  const byId = new Map(records.map((record) => [record.id, record]))

  // --- On-my-mind compile (also the DL-104-17 rule-2 dedup set) ---
  const awarenessSorted = records
    .filter(
      (record) =>
        record.lane === 'awareness' && record.is_superseded !== 'y' && !isExpired(record, nowTs)
    )
    .sort(
      (a, b) =>
        b.importance - a.importance || a.saved_ts - b.saved_ts || a.id.localeCompare(b.id)
    )
  const onMyMindEntries: MemoryRecord[] = []
  let onMyMindTokens = 0
  for (const record of awarenessSorted) {
    const cost = insertTokenCost(record)
    if (onMyMindEntries.length > 0 && onMyMindTokens + cost > budgets.onMyMind) continue
    onMyMindEntries.push(record)
    onMyMindTokens += cost
  }
  const onMyMindIds = new Set(onMyMindEntries.map((record) => record.id))
  const onMyMindTruncated = awarenessSorted.length - onMyMindEntries.length

  // --- Raw buckets ---
  const lingerEntries = (linger?.lingering ?? []).filter(
    (entry) =>
      entry.agent_id === agentId &&
      (entry.hold === 'episode' ? episodeHoldAlive(entry, episode) : entry.turns_remaining > 0) &&
      byId.has(entry.memory_id)
  )
  const lingerById = new Map(lingerEntries.map((entry) => [entry.memory_id, entry]))
  const pending = (linger?.pending ?? []).filter((entry) => entry.agent_id === agentId)

  const candidates = new Map<string, MemoryInsertCandidate>()
  const consumedPendingIds: string[] = []
  const moreAvailable: string[] = []
  let alreadyOnMindCount = 0
  let missingPendingCount = 0

  // Pending recalls first (deliberate acts outrank reflex hits on the label).
  for (const entry of pending) {
    const record = byId.get(entry.memory_id)
    if (!record) {
      missingPendingCount += 1
      consumedPendingIds.push(entry.memory_id)
      continue
    }
    if (onMyMindIds.has(record.id)) {
      alreadyOnMindCount += 1
      consumedPendingIds.push(entry.memory_id)
      continue
    }
    const lingerEntry = lingerById.get(record.id)
    candidates.set(record.id, {
      record,
      source: 'recall',
      status: lingerEntry ? 'refreshed' : 'new',
      matchedTerms: [],
      firstInsertedAt: lingerEntry?.first_inserted_at
    })
  }

  // Trigger scan (STM only; superseded memories never auto-fire, expired stop firing).
  for (const record of records) {
    if (record.lane !== 'stm') continue
    if (record.is_superseded === 'y' || isExpired(record, nowTs)) continue
    if (onMyMindIds.has(record.id)) continue
    const matched = matchTriggerTerms(currentUserMessage, record)
    if (matched.length === 0) continue
    const existing = candidates.get(record.id)
    if (existing) {
      existing.matchedTerms = Array.from(new Set([...existing.matchedTerms, ...matched]))
      continue
    }
    const lingerEntry = lingerById.get(record.id)
    candidates.set(record.id, {
      record,
      source: lingerEntry?.source ?? 'trigger',
      status: lingerEntry ? 'refreshed' : 'new',
      matchedTerms: matched,
      firstInsertedAt: lingerEntry?.first_inserted_at
    })
  }

  // Held linger entries (not re-relevant this message).
  for (const entry of lingerEntries) {
    if (candidates.has(entry.memory_id)) continue
    const record = byId.get(entry.memory_id) as MemoryRecord
    if (onMyMindIds.has(record.id)) continue
    candidates.set(record.id, {
      record,
      source: entry.source,
      status: 'held',
      matchedTerms: [],
      ...(entry.hold === 'episode'
        ? { holdEpisode: true }
        : { turnsRemaining: entry.turns_remaining }),
      firstInsertedAt: entry.first_inserted_at
    })
  }

  // --- Budgets per lane with ranked truncation (Current > refreshed > held,
  //     then importance, then recency) ---
  const statusRank: Record<MemoryInsertStatus, number> = { new: 0, refreshed: 1, held: 2 }
  const ranked = Array.from(candidates.values()).sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      b.record.importance - a.record.importance ||
      (b.record.last_recalled_ts ?? b.record.saved_ts) -
        (a.record.last_recalled_ts ?? a.record.saved_ts) ||
      a.record.id.localeCompare(b.record.id)
  )

  const spentByLane: Record<MemoryLingerSource, number> = { trigger: 0, recall: 0 }
  const kept: MemoryInsertCandidate[] = []
  let droppedTriggerNew = 0
  let droppedLingering = 0
  const deferredPendingIds: string[] = []
  const pendingIds = new Set(pending.map((entry) => entry.memory_id))

  for (const candidate of ranked) {
    const budget = candidate.source === 'trigger' ? budgets.triggers : budgets.recalled
    const cost = insertTokenCost(candidate.record)
    const laneHasEntries = kept.some((entry) => entry.source === candidate.source)
    if (laneHasEntries && spentByLane[candidate.source] + cost > budget) {
      if (candidate.source === 'recall' && pendingIds.has(candidate.record.id)) {
        // Budget-deferred recalls stay queued and insert on upcoming turns.
        deferredPendingIds.push(candidate.record.id)
      } else if (candidate.status === 'new') {
        droppedTriggerNew += 1
      } else {
        droppedLingering += 1
      }
      continue
    }
    spentByLane[candidate.source] += cost
    kept.push(candidate)
  }

  // Pending consumption: everything inserted or refreshed this turn is consumed;
  // budget-deferred stays queued for the next turn.
  const keptIds = new Set(kept.map((candidate) => candidate.record.id))
  for (const entry of pending) {
    if (keptIds.has(entry.memory_id) && !consumedPendingIds.includes(entry.memory_id)) {
      consumedPendingIds.push(entry.memory_id)
    }
  }

  if (alreadyOnMindCount > 0) {
    moreAvailable.push(
      `${alreadyOnMindCount} recalled ${alreadyOnMindCount === 1 ? 'memory is' : 'memories are'} already in your AWARENESS block and ${alreadyOnMindCount === 1 ? 'was' : 'were'} not re-inserted.`
    )
  }
  if (missingPendingCount > 0) {
    moreAvailable.push(
      `${missingPendingCount} recalled memory id${missingPendingCount === 1 ? '' : 's'} no longer exist${missingPendingCount === 1 ? 's' : ''} and ${missingPendingCount === 1 ? 'was' : 'were'} dropped from the queue.`
    )
  }
  if (droppedTriggerNew > 0) {
    moreAvailable.push(
      `${droppedTriggerNew} trigger match${droppedTriggerNew === 1 ? '' : 'es'} not inserted (trigger budget ${budgets.triggers} tokens) — use sys.memory.search / sys.memory.recall to fetch.`
    )
  }
  if (deferredPendingIds.length > 0) {
    moreAvailable.push(
      `${deferredPendingIds.length} recalled ${deferredPendingIds.length === 1 ? 'memory stays' : 'memories stay'} queued (recall budget ${budgets.recalled} tokens) and will insert on upcoming turns.`
    )
  }
  if (droppedLingering > 0) {
    moreAvailable.push(
      `${droppedLingering} lingering ${droppedLingering === 1 ? 'memory' : 'memories'} dropped early (budget).`
    )
  }

  return {
    current: kept.filter((candidate) => candidate.status === 'new'),
    lingering: kept.filter((candidate) => candidate.status !== 'new'),
    consumedPendingIds,
    deferredPendingIds,
    moreAvailable,
    onMyMind: {
      entries: onMyMindEntries,
      truncatedCount: onMyMindTruncated,
      tokenEstimate: onMyMindTokens
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting (dated claims, DL-104-08; "insert" terminology)
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown date'
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'unknown date'
  return date.toLocaleDateString('en-US')
}

function fmtDateTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 'unknown time'
  const hours24 = date.getHours()
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const meridiem = hours24 < 12 ? 'AM' : 'PM'
  return `${date.toLocaleDateString('en-US')}, ${hours}:${minutes} ${meridiem}`
}

export function formatInteractionGap(fromTs: number, toTs: number): string {
  const ms = Math.max(0, toTs - fromTs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (ms < minute) return 'moments ago'
  if (ms < hour) {
    const minutes = Math.floor(ms / minute)
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  }
  if (ms < day) {
    const hours = Math.floor(ms / hour)
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  if (ms < 14 * day) {
    const days = Math.floor(ms / day)
    return `${days} day${days === 1 ? '' : 's'} ago`
  }
  if (ms < 60 * day) {
    const weeks = Math.floor(ms / (7 * day))
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  }
  if (ms < 365 * day) {
    const months = Math.floor(ms / (30 * day))
    return `${months} month${months === 1 ? '' : 's'} ago`
  }
  const years = Math.floor(ms / (365 * day))
  return `${years} year${years === 1 ? '' : 's'} ago`
}

function indentContent(content: string): string[] {
  return content.split('\n').map((line) => `    ${line}`)
}

function formatInsertLine(
  candidate: MemoryInsertCandidate,
  sessionId: string,
  nowTs: number
): string[] {
  const record = candidate.record
  const icon =
    candidate.status === 'new' ? ICON_NEW : candidate.status === 'refreshed' ? ICON_REFRESHED : ICON_HELD

  // SA-104 P6: recalled graduated segments present as dated episode gists.
  const segmentMeta = (record as InsertableRecord).__segment
  if (segmentMeta) {
    const parts: string[] = ['recalled', 'graduated episode', record.id]
    parts.push(
      `covers ${fmtDate(segmentMeta.firstMessageAt)} – ${fmtDate(segmentMeta.lastMessageAt)} (${segmentMeta.messageCount} message${segmentMeta.messageCount === 1 ? '' : 's'})`
    )
    if (candidate.status === 'refreshed') parts.push('refreshed')
    if (candidate.status === 'held' && candidate.holdEpisode) {
      parts.push('lingering for the rest of this episode')
    } else if (candidate.status === 'held' && typeof candidate.turnsRemaining === 'number') {
      parts.push(`${candidate.turnsRemaining} turn${candidate.turnsRemaining === 1 ? '' : 's'} left`)
    }
    parts.push(`graduated ${fmtDate(record.saved_at)}`)
    parts.push(segmentMeta.sessionId === sessionId ? 'this chat' : 'another chat')
    const lines = [`  - ${icon} [${parts.join(' | ')}]`]
    lines.push(...indentContent(record.content))
    return lines
  }

  const parts: string[] = []
  if (candidate.source === 'trigger' || candidate.matchedTerms.length > 0) {
    parts.push(
      candidate.matchedTerms.length > 0
        ? `trigger ${candidate.matchedTerms.map((term) => `"${term}"`).join(', ')}`
        : 'trigger'
    )
  }
  if (candidate.source === 'recall') parts.push('recalled')
  parts.push(record.lane)
  parts.push(record.id)
  parts.push(`importance ${record.importance}`)
  if (candidate.status === 'refreshed') parts.push('refreshed')
  if (candidate.status === 'held' && candidate.holdEpisode) {
    parts.push('lingering for the rest of this episode')
  } else if (candidate.status === 'held' && typeof candidate.turnsRemaining === 'number') {
    parts.push(`${candidate.turnsRemaining} turn${candidate.turnsRemaining === 1 ? '' : 's'} left`)
  }
  if (record.event_at) parts.push(`event ${fmtDate(record.event_at)}`)
  parts.push(`saved ${fmtDate(record.saved_at)}`)

  const originSessionId = record.provenance?.[0]?.session_id
  parts.push(
    originSessionId === sessionId
      ? 'this chat'
      : `another chat, ${fmtDate(record.saved_at)}`
  )
  if (isExpired(record, nowTs)) parts.push(`expired ${fmtDate(record.expires_at)}`)

  const lines = [`  - ${icon} [${parts.join(' | ')}]`]
  lines.push(...indentContent(record.content))
  if (record.is_superseded === 'y') {
    lines.push(
      `    SUPERSEDED${record.superseded_by ? ` by ${record.superseded_by}` : ''} — prefer the current version.`
    )
  }
  if (record.clip_ids?.length) {
    lines.push(
      `    [media attached below: ${record.clip_ids.join(', ')} — see REMEMBERED MEDIA]`
    )
  }
  return lines
}

/**
 * SA-104 P6 — the episode whiteboard block (design §1.3): the agent-maintained
 * working-facts block for the OPEN episode, kept in awareness until the episode
 * closes. Byte-stable across turns; changes only through deliberate edits
 * (sys.memory.whiteboard), nap extraction, or episode close (DL-104-04 posture).
 */
function formatWhiteboardBlock(whiteboard: { content: string; updated_at: string }): string {
  return [
    '==== EPISODE WHITEBOARD (CURRENT EPISODE) ====',
    '',
    `Working facts you keep in front of yourself for the current episode (updated ${fmtDate(whiteboard.updated_at)}). Rewrite with sys.memory.whiteboard; it dissolves when the episode closes.`,
    '',
    whiteboard.content
  ].join('\n')
}

function formatOnMyMindBlock(entries: MemoryRecord[], truncatedCount: number): string {
  if (entries.length === 0 && truncatedCount === 0) return ''
  const lines: string[] = [
    '==== AWARENESS (AGENT MEMORY) ====',
    '',
    'Entries you deliberately keep in mind (lane: awareness). You wrote these; edit or reorganize them with your memory tools (sys.memory.update / move_lane / supersede).'
  ]
  for (const record of entries) {
    const parts = [record.id, `importance ${record.importance}`, `saved ${fmtDate(record.saved_at)}`]
    if (record.event_at) parts.push(`event ${fmtDate(record.event_at)}`)
    if (record.expires_at) parts.push(`expires ${fmtDate(record.expires_at)}`)
    lines.push(`- [${parts.join(' | ')}] ${record.content}`)
    if (record.clip_ids?.length) {
      lines.push(
        `  (has media: ${record.clip_ids.length} clip${record.clip_ids.length === 1 ? '' : 's'} — recall ${record.id} to view)`
      )
    }
  }
  if (truncatedCount > 0) {
    lines.push(
      `- ${truncatedCount} more awareness entr${truncatedCount === 1 ? 'y exceeds' : 'ies exceed'} the Awareness budget — list them with sys.memory.list (lane: awareness).`
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

async function loadAgentRecord(agentId: string): Promise<Record<string, any> | null> {
  const agent = (await redis.get(`agent:${agentId}`)) as Record<string, any> | null
  return agent && typeof agent === 'object' ? agent : null
}

/**
 * Shared episode-context loader for 'episode' linger holds — compile and commit call
 * this with identical inputs so the selection pair stays deterministic. The regular-
 * session stretch boundary uses the linger record's `last_commit_ts` (the per-session
 * accepted-send clock) against the agent's idle gap — the same knob that defines
 * conversation stretches for graduation.
 */
async function loadEpisodeContext(options: {
  agent: Record<string, any>
  sessionId: string
  linger: MemoryLingerRecord | null
  nowTs: number
}): Promise<{
  sessionRecord: Record<string, any> | null
  openEpisode: Awaited<ReturnType<typeof getOpenEpisode>>
  episode: MemoryEpisodeContext
}> {
  const sessionRecord = (await redis
    .get(`session:${options.sessionId}`)
    .catch(() => null)) as Record<string, any> | null
  const fixed = isFixedSession(sessionRecord)
  const openEpisode = fixed ? await getOpenEpisode(options.sessionId) : null
  const idleGapMs = resolveMemoryIdleGapHours(options.agent) * 3_600_000
  const lastCommitTs =
    typeof options.linger?.last_commit_ts === 'number' ? options.linger.last_commit_ts : null
  return {
    sessionRecord,
    openEpisode,
    episode: {
      isFixedSession: fixed,
      openEpisodeId: openEpisode?.id ?? null,
      stretchEnded: !fixed && lastCommitTs !== null && options.nowTs - lastCommitTs > idleGapMs
    }
  }
}

// ---------------------------------------------------------------------------
// Compile-time context (read-only)
// ---------------------------------------------------------------------------

export async function computeMemoryCompileContext(options: {
  userId: string
  agentId: string
  sessionId: string
  currentUserMessage: string
}): Promise<MemoryCompileContext> {
  const agentId = options.agentId?.trim()
  const sessionId = options.sessionId?.trim()
  if (!agentId || !sessionId) return EMPTY_CONTEXT

  const agent = await loadAgentRecord(agentId)
  if (!agent || !resolveAgentMemoryEnabled(agent)) return EMPTY_CONTEXT
  if (typeof agent.user_id === 'string' && agent.user_id !== options.userId) {
    return EMPTY_CONTEXT
  }

  const { ts: nowTs } = nowStamps()
  const budgets = resolveMemoryLaneBudgets(agent)
  const lingerWindow = resolveMemoryLingerTurns(agent)
  const recallLingerWindow = resolveMemoryRecallLingerTurns(agent)
  const [memoryRecords, linger] = await Promise.all([
    listMemories(agentId),
    getMemoryLingerState(sessionId)
  ])
  // SA-104 P6: recalled graduated segments join the same selection machinery.
  const records = [
    ...memoryRecords,
    ...(await loadRecalledSegmentInsertables(agentId, linger))
  ]

  const { openEpisode, episode } = await loadEpisodeContext({ agent, sessionId, linger, nowTs })

  const selection = selectMemoryInserts({
    agentId,
    currentUserMessage: options.currentUserMessage ?? '',
    records,
    linger,
    budgets,
    episode,
    nowTs
  })

  // SA-109 (DL-109-04): session clips are NOT listed here any more. The general
  // DCM clip roster owns every clip line for every agent, memory-on or not, so
  // a memory-enabled agent never sees the same clip twice.

  // Time awareness (agent-level, DL-104-16): gap since the previous interaction.
  const lastInteractionAt =
    typeof agent.memory_last_interaction_at === 'string' ? agent.memory_last_interaction_at : null
  const lastInteractionTs =
    typeof agent.memory_last_interaction_ts === 'number'
      ? agent.memory_last_interaction_ts
      : lastInteractionAt
        ? new Date(lastInteractionAt).getTime()
        : null
  const timeAwarenessLine =
    lastInteractionAt && Number.isFinite(lastInteractionTs)
      ? `- Last interaction with the user: ${formatInteractionGap(lastInteractionTs as number, nowTs)} (${fmtDateTime(lastInteractionAt)}).`
      : null

  // --- DCM section assembly ---
  const inserted = [...selection.current, ...selection.lingering]
  const currentLines = selection.current.flatMap((candidate) =>
    formatInsertLine(candidate, sessionId, nowTs)
  )
  const lingeringLines = selection.lingering.flatMap((candidate) =>
    formatInsertLine(candidate, sessionId, nowTs)
  )

  const dcmLines: string[] = []
  if (timeAwarenessLine || currentLines.length > 0 || lingeringLines.length > 0 || selection.moreAvailable.length > 0) {
    dcmLines.push('Memory context:')
    if (timeAwarenessLine) dcmLines.push(timeAwarenessLine)
    if (currentLines.length > 0) {
      dcmLines.push('- Current (new this message):')
      dcmLines.push(...currentLines)
    }
    if (lingeringLines.length > 0) {
      dcmLines.push('- Lingering (from earlier messages):')
      dcmLines.push(...lingeringLines)
    }
    for (const note of selection.moreAvailable) {
      dcmLines.push(`- More available: ${note}`)
    }
  }

  // Clip media carried by inserted memories rides the structured image path.
  const memoryClipIds: string[] = []
  const memoryClipSources: Record<string, string> = {}
  for (const candidate of inserted) {
    for (const clipId of candidate.record.clip_ids ?? []) {
      if (!memoryClipIds.includes(clipId)) {
        memoryClipIds.push(clipId)
        memoryClipSources[clipId] = candidate.record.id
      }
    }
  }

  const onMyMindBlock = formatOnMyMindBlock(
    selection.onMyMind.entries,
    selection.onMyMind.truncatedCount
  )

  // SA-104 P6: the open episode's whiteboard joins awareness for Infinite Sessions
  // (already loaded by the shared episode-context loader above).
  let whiteboardBlock = ''
  let whiteboardTokens = 0
  if (episode.isFixedSession) {
    const whiteboard = openEpisode?.whiteboard
    if (whiteboard?.content?.trim()) {
      whiteboardBlock = formatWhiteboardBlock(whiteboard)
      whiteboardTokens = estimateTokens(whiteboard.content)
    }
  }

  return {
    enabled: true,
    onMyMindBlock,
    whiteboardBlock,
    dcmLines,
    memoryClipIds,
    memoryClipSources,
    memoryContext: {
      lingerWindowTurns: lingerWindow,
      recallLingerWindowTurns: recallLingerWindow,
      budgets,
      whiteboard: { present: whiteboardBlock.length > 0, tokenEstimate: whiteboardTokens },
      onMyMind: {
        count: selection.onMyMind.entries.length,
        truncatedCount: selection.onMyMind.truncatedCount,
        tokenEstimate: selection.onMyMind.tokenEstimate
      },
      inserts: inserted.map((candidate) => ({
        id: candidate.record.id,
        lane: candidate.record.lane,
        ...((candidate.record as InsertableRecord).__segment ? { type: 'segment' } : {}),
        source: candidate.source,
        status: candidate.status,
        importance: candidate.record.importance,
        gist:
          candidate.record.gist?.trim() ||
          (candidate.record.content.length > 140
            ? `${candidate.record.content.slice(0, 140).trimEnd()}…`
            : candidate.record.content),
        ...(candidate.matchedTerms.length > 0 ? { matchedTerms: candidate.matchedTerms } : {}),
        ...(typeof candidate.turnsRemaining === 'number'
          ? { turnsRemaining: candidate.turnsRemaining }
          : {}),
        ...(candidate.holdEpisode ? { holdEpisode: true } : {}),
        ...(candidate.record.clip_ids?.length ? { clipIds: candidate.record.clip_ids } : {}),
        ...(candidate.record.is_superseded === 'y' ? { superseded: true } : {})
      })),
      moreAvailable: selection.moreAvailable,
      timeAwareness: timeAwarenessLine ? timeAwarenessLine.replace(/^- /, '') : null
    }
  }
}

// ---------------------------------------------------------------------------
// Blended search ranking (DL-104-09: application-code ranking over Redis scores)
// ---------------------------------------------------------------------------

const RANK_WEIGHT_RELEVANCE = 0.55
const RANK_WEIGHT_RECENCY = 0.25
const RANK_WEIGHT_IMPORTANCE = 0.2
const RECENCY_HALF_LIFE_DAYS = 14

/**
 * Blends relevance × recency × importance in application code. Relevance is
 * rank-normalized (mode-agnostic across KNN distance / BM25 / hybrid fusion scores);
 * recency decays with a 14-day half-life over the LAST DELIVERY (recall-refresh:
 * `last_recalled_ts` beats `saved_ts`); importance maps 1-10 linearly. Returns a new
 * array, best first. Deterministic tiebreak: original hit order, then id.
 */
export function blendMemoryRanking(
  records: MemoryRecord[],
  hitOrder: Map<string, number>,
  nowTs: number
): MemoryRecord[] {
  const total = Math.max(records.length, 1)
  const scored = records.map((record) => {
    const rank = hitOrder.get(record.id) ?? total - 1
    const relevance = 1 - rank / total
    const freshTs = Math.max(record.saved_ts, record.last_recalled_ts ?? 0)
    const ageDays = Math.max(0, nowTs - freshTs) / 86_400_000
    const recency = Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS)
    const importance = (record.importance - 1) / 9
    const score =
      RANK_WEIGHT_RELEVANCE * relevance +
      RANK_WEIGHT_RECENCY * recency +
      RANK_WEIGHT_IMPORTANCE * importance
    return { record, score, rank }
  })
  scored.sort(
    (a, b) => b.score - a.score || a.rank - b.rank || a.record.id.localeCompare(b.record.id)
  )
  return scored.map((entry) => entry.record)
}

// ---------------------------------------------------------------------------
// Accepted-send commit (the ONLY writer besides the recall queue)
// ---------------------------------------------------------------------------

/** Per-insert row for the chat "surfaced" chip popover (metadata.memoryInserted.items). */
export interface MemoryInsertedItem {
  id: string
  lane: string
  source: MemoryLingerSource
  status: MemoryInsertStatus
  gist: string
  segment?: boolean
  matchedTerms?: string[]
  /** STM rows: the record's trigger terms (first few) so lingering rows can badge too. */
  triggerTerms?: string[]
  turnsRemaining?: number
  holdEpisode?: boolean
}

export interface MemoryTurnCommitResult {
  committed: boolean
  insertedNewIds: string[]
  refreshedIds: string[]
  heldIds: string[]
  /** What actually rode into context this turn, in insert order (capped). */
  items: MemoryInsertedItem[]
}

/**
 * Applies the turn's linger transitions at the accepted-send boundary. Recomputes the
 * same deterministic selection the compile produced (identical inputs — the linger
 * record only changes here or via the recall queue, which runs mid-stream after this),
 * then: consumed pending entries leave the queue, new/refreshed entries get the full
 * linger window plus a recall-refresh touch, held entries decrement and drop at zero,
 * and the agent-level last-interaction stamp advances (read at compile as the previous
 * interaction). Group runs and continuation re-sends must not call this.
 */
export async function commitMemoryTurnState(options: {
  userId: string
  agentId: string
  sessionId: string
  currentUserMessage: string
}): Promise<MemoryTurnCommitResult> {
  const agentId = options.agentId?.trim()
  const sessionId = options.sessionId?.trim()
  const empty: MemoryTurnCommitResult = {
    committed: false,
    insertedNewIds: [],
    refreshedIds: [],
    heldIds: [],
    items: []
  }
  if (!agentId || !sessionId) return empty

  const agent = await loadAgentRecord(agentId)
  if (!agent || !resolveAgentMemoryEnabled(agent)) return empty
  if (typeof agent.user_id === 'string' && agent.user_id !== options.userId) return empty

  const { iso: nowIso, ts: nowTs } = nowStamps()
  const budgets = resolveMemoryLaneBudgets(agent)
  const lingerWindow = resolveMemoryLingerTurns(agent)
  const recallLingerWindow = resolveMemoryRecallLingerTurns(agent)
  const [memoryRecords, linger] = await Promise.all([
    listMemories(agentId),
    getMemoryLingerState(sessionId)
  ])
  const records = [
    ...memoryRecords,
    ...(await loadRecalledSegmentInsertables(agentId, linger))
  ]

  const { episode } = await loadEpisodeContext({ agent, sessionId, linger, nowTs })

  const selection = selectMemoryInserts({
    agentId,
    currentUserMessage: options.currentUserMessage ?? '',
    records,
    linger,
    budgets,
    episode,
    nowTs
  })

  const previousLingering = (linger?.lingering ?? []).filter(
    (entry) => entry.agent_id === agentId
  )
  const previousByMemoryId = new Map(previousLingering.map((entry) => [entry.memory_id, entry]))

  const nextLingering: MemoryLingerEntry[] = []
  const insertedNewIds: string[] = []
  const refreshedIds: string[] = []
  const heldIds: string[] = []

  const recallKindById = new Map<string, 'memory' | 'segment'>()
  for (const candidate of [...selection.current, ...selection.lingering]) {
    const memoryId = candidate.record.id
    const kind: 'memory' | 'segment' = (candidate.record as InsertableRecord).__segment
      ? 'segment'
      : 'memory'
    recallKindById.set(memoryId, kind)
    const kindField = kind === 'segment' ? { kind: 'segment' as const } : {}
    if (candidate.status === 'held') {
      const previous = previousByMemoryId.get(memoryId)
      if (candidate.holdEpisode) {
        // Episode holds never count down; selection already dropped dead episodes.
        heldIds.push(memoryId)
        nextLingering.push({
          memory_id: memoryId,
          agent_id: agentId,
          source: candidate.source,
          first_inserted_at: candidate.firstInsertedAt ?? previous?.first_inserted_at ?? nowIso,
          last_relevant_at: previous?.last_relevant_at ?? nowIso,
          turns_remaining: 0,
          hold: 'episode',
          episode_id: previous?.episode_id ?? null,
          ...kindField
        })
        continue
      }
      const remaining = (previous?.turns_remaining ?? candidate.turnsRemaining ?? 1) - 1
      if (remaining <= 0) continue
      heldIds.push(memoryId)
      nextLingering.push({
        memory_id: memoryId,
        agent_id: agentId,
        source: candidate.source,
        first_inserted_at: candidate.firstInsertedAt ?? previous?.first_inserted_at ?? nowIso,
        last_relevant_at: previous?.last_relevant_at ?? nowIso,
        turns_remaining: remaining,
        ...kindField
      })
      continue
    }
    if (candidate.status === 'new') insertedNewIds.push(memoryId)
    else refreshedIds.push(memoryId)
    // Per-memory override beats the per-source default; a zero window means
    // insert-once with no re-holds; 'episode' holds until the episode ends.
    const override = resolveMemoryLingerOverride(candidate.record)
    if (override === 'episode') {
      nextLingering.push({
        memory_id: memoryId,
        agent_id: agentId,
        source: candidate.source,
        first_inserted_at:
          candidate.firstInsertedAt ?? previousByMemoryId.get(memoryId)?.first_inserted_at ?? nowIso,
        last_relevant_at: nowIso,
        turns_remaining: 0,
        hold: 'episode',
        // Defensive: with no open episode at commit (should not happen — episode
        // upkeep runs before the commit), the hold dies on the next commit.
        episode_id: episode.isFixedSession ? episode.openEpisodeId : null,
        ...kindField
      })
      continue
    }
    const window =
      typeof override === 'number'
        ? override
        : candidate.source === 'trigger'
          ? lingerWindow
          : recallLingerWindow
    if (window > 0) {
      nextLingering.push({
        memory_id: memoryId,
        agent_id: agentId,
        source: candidate.source,
        first_inserted_at:
          candidate.firstInsertedAt ?? previousByMemoryId.get(memoryId)?.first_inserted_at ?? nowIso,
        last_relevant_at: nowIso,
        turns_remaining: window,
        ...kindField
      })
    }
  }

  // Entries owned by OTHER agents in this session record pass through untouched
  // (group sessions never commit, but the record shape stays honest either way).
  const foreignLingering = (linger?.lingering ?? []).filter((entry) => entry.agent_id !== agentId)
  const consumed = new Set(selection.consumedPendingIds)
  const nextPending = (linger?.pending ?? []).filter(
    (entry) => !(entry.agent_id === agentId && consumed.has(entry.memory_id))
  )

  const nextRecord: MemoryLingerRecord = {
    pending: nextPending,
    ...(nextLingering.length + foreignLingering.length > 0
      ? { lingering: [...foreignLingering, ...nextLingering] }
      : {}),
    last_commit_at: nowIso,
    last_commit_ts: nowTs,
    schema_version: MEMORY_SCHEMA_VERSION
  }
  await setMemoryLingerState(sessionId, nextRecord)

  // Recall-refresh fires on delivery (new + refreshed), never on mere search hits.
  for (const memoryId of [...insertedNewIds, ...refreshedIds]) {
    const touch =
      recallKindById.get(memoryId) === 'segment' ? touchMemorySegmentRecall : touchMemoryRecall
    await touch(agentId, memoryId).catch((error) => {
      console.warn('[memoryRecall] Failed to touch recall-refresh for', memoryId, error)
    })
  }

  // Agent-level last-interaction stamp (DL-104-16); compile reads the pre-commit value.
  await redis.execute(async (client) => {
    await client.json.set(`agent:${agentId}`, '$.memory_last_interaction_at', nowIso as never)
    await client.json.set(`agent:${agentId}`, '$.memory_last_interaction_ts', nowTs as never)
  })

  // Per-item rows for the chat chip popover — capped so message metadata stays small.
  const items: MemoryInsertedItem[] = [...selection.current, ...selection.lingering]
    .slice(0, 20)
    .map((candidate) => ({
      id: candidate.record.id,
      lane: candidate.record.lane,
      source: candidate.source,
      status: candidate.status,
      gist:
        candidate.record.gist?.trim() ||
        (candidate.record.content.length > 140
          ? `${candidate.record.content.slice(0, 140).trimEnd()}…`
          : candidate.record.content),
      ...((candidate.record as InsertableRecord).__segment ? { segment: true } : {}),
      ...(candidate.matchedTerms.length > 0 ? { matchedTerms: candidate.matchedTerms } : {}),
      ...(candidate.record.trigger_terms?.length
        ? { triggerTerms: candidate.record.trigger_terms.slice(0, 3) }
        : {}),
      ...(typeof candidate.turnsRemaining === 'number'
        ? { turnsRemaining: candidate.turnsRemaining }
        : {}),
      ...(candidate.holdEpisode ? { holdEpisode: true } : {})
    }))

  return { committed: true, insertedNewIds, refreshedIds, heldIds, items }
}
