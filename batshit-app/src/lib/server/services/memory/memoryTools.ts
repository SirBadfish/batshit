/**
 * SA-104 P3 — the memory tool operations layer.
 *
 * One shared implementation behind BOTH agent-facing surfaces:
 *  - the Fabric `sys.memory.*` controls (fabricRegistry.ts handlers), and
 *  - the inline `<batshit-memory>` save route (`/api/memory/inline-saves`).
 *
 * The parity requirement (P3) is structural here: both surfaces call the same ops with
 * the same validated payload shape, so a tool save and an inline save produce identical
 * records (modulo id/timestamps/provenance message id).
 *
 * Responses are summary-first (DL-104-17): references only — id, lane, gist, dates,
 * importance, supersession flags. Full memory content is never echoed through tool
 * results; it reaches the agent through the single DCM insert channel (`sys.memory.recall`
 * queues it; the P4 recall engine delivers it).
 */

import { redis } from '$lib/server/redis'
import {
  resolveAgentMemoryEnabled,
  validateMemorySavePayload,
  type MemorySavePayload
} from '$lib/utils/memoryControl'
import {
  createMemory,
  createMemoryId,
  deleteMemory,
  fetchMemoriesByKeys,
  fetchMemorySegmentsByIds,
  getMemory,
  getMemorySegment,
  listMemories,
  supersedeMemory,
  touchMemoryRecall,
  touchMemorySegmentRecall,
  unsupersedeMemory,
  updateMemory,
  type UpdateMemoryInput
} from './memoryStore'
import type {
  MemoryLane,
  MemoryMediaMode,
  MemoryMediaRecord,
  MemoryRecord,
  MemorySegmentRecord
} from './memoryTypes'
import { MEMORY_LANES } from './memoryTypes'
import { createMemoryEmbedderAsync } from './memoryEmbedder'
import {
  getMemoryConfig,
  hybridSearchMemories,
  hybridSearchSegments,
  knnSearchMemories,
  type MemorySearchFilters,
  type SegmentSearchFilters
} from './memoryIndex'
import { MEMORY_SEGMENT_KEY_PREFIX } from './memoryKeys'
import { queuePendingMemoryRecalls } from './memoryLinger'
import { blendMemoryRanking, foldAwarenessState, getMemoryFold } from './memoryRecall'
import {
  closeEpisode,
  getOpenEpisode,
  updateEpisodeBounds,
  updateEpisodeWhiteboard,
  type EpisodeRecord
} from './memoryEpisodes'
import { isFixedSession } from '$lib/utils/fixedSession'
import {
  copyClipToMemoryMedia,
  deleteMemoryMedia,
  MEMORY_STANDING_MEDIA_CAP,
  MemoryMediaError
} from './memoryMedia'

/** Cosine-distance ceiling for the dedup-on-save assist (records ≤ this are "near"). */
export const MEMORY_NEAR_DUPLICATE_MAX_DISTANCE = 0.1
const SEARCH_DEFAULT_LIMIT = 8
const SEARCH_MAX_LIMIT = 25
const LIST_DEFAULT_LIMIT = 25
const LIST_MAX_LIMIT = 100
const RECALL_MAX_IDS = 8

export interface MemoryToolContext {
  userId: string
  agentId: string
  sessionId?: string | null
}

export class MemoryToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'MemoryToolError'
  }
}

/**
 * Server-side enablement gate (belt and suspenders under the broker allow-list gating):
 * memory ops run only for an existing, user-owned, memory-enabled agent.
 */
export async function requireMemoryEnabledAgent(
  userId: string,
  agentId: string | null | undefined
): Promise<Record<string, any>> {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalizedAgentId) {
    throw new MemoryToolError('Memory operations require an agent context (agentId missing).')
  }
  const agent = (await redis.get(`agent:${normalizedAgentId}`)) as Record<string, any> | null
  if (!agent) {
    throw new MemoryToolError(`Agent "${normalizedAgentId}" was not found.`)
  }
  if (typeof agent.user_id === 'string' && agent.user_id !== userId) {
    throw new MemoryToolError(`Agent "${normalizedAgentId}" does not belong to this user.`)
  }
  if (!resolveAgentMemoryEnabled(agent)) {
    throw new MemoryToolError(
      `Memory is not enabled for agent "${agent.name ?? normalizedAgentId}".`,
      'Enable memory for this agent before saving or recalling memories.'
    )
  }
  return agent
}

/** Summary-first reference shape (DL-104-17): never content, never embeddings. */
export interface MemorySummary {
  id: string
  lane: MemoryLane
  gist: string
  importance: number
  event_at: string | null
  saved_at: string
  expires_at?: string | null
  superseded: boolean
  superseded_by?: string | null
  trigger_terms?: string[]
  /** Per-memory linger override (turns or 'episode'), when set. */
  linger_override?: number | 'episode'
  links?: string[]
  media_count?: number
  media_mode?: MemoryMediaMode
  last_recalled_at?: string | null
  /** P4 1-hop link expansion: set when this row rode in via another result's [[links]]. */
  linked_from?: string
}

const GIST_PREVIEW_CHARS = 140

export function toMemorySummary(record: MemoryRecord): MemorySummary {
  const gist =
    record.gist?.trim() ||
    (record.content.length > GIST_PREVIEW_CHARS
      ? `${record.content.slice(0, GIST_PREVIEW_CHARS).trimEnd()}…`
      : record.content)
  return {
    id: record.id,
    lane: record.lane,
    gist,
    importance: record.importance,
    event_at: record.event_at,
    saved_at: record.saved_at,
    ...(record.expires_at ? { expires_at: record.expires_at } : {}),
    superseded: record.is_superseded === 'y',
    ...(record.superseded_by ? { superseded_by: record.superseded_by } : {}),
    ...(record.trigger_terms?.length ? { trigger_terms: record.trigger_terms } : {}),
    ...(record.linger_override !== undefined ? { linger_override: record.linger_override } : {}),
    ...(record.links?.length ? { links: record.links } : {}),
    ...(record.media?.length ? { media_count: record.media.length } : {}),
    ...(record.media?.length ? { media_mode: record.media_mode ?? 'on_recall' } : {}),
    ...(record.last_recalled_at ? { last_recalled_at: record.last_recalled_at } : {})
  }
}

export interface MemoryNearDuplicate {
  id: string
  gist: string
  saved_at: string
  distance: number
}

async function findNearDuplicates(
  agentId: string,
  record: MemoryRecord
): Promise<MemoryNearDuplicate[]> {
  const hits = await knnSearchMemories({
    agentId,
    vector: record.embedding,
    k: 4,
    filters: { superseded: 'n' }
  })
  const nearKeys = hits
    .filter((hit) => Number.isFinite(hit.score) && hit.score <= MEMORY_NEAR_DUPLICATE_MAX_DISTANCE)
    .map((hit) => ({ key: hit.key, distance: hit.score }))
  if (nearKeys.length === 0) return []

  const records = await fetchMemoriesByKeys(nearKeys.map((entry) => entry.key))
  const distanceByKey = new Map(nearKeys.map((entry) => [entry.key, entry.distance]))
  return records
    .filter((candidate) => candidate.id !== record.id)
    .map((candidate) => ({
      id: candidate.id,
      gist: toMemorySummary(candidate).gist,
      saved_at: candidate.saved_at,
      distance: distanceByKey.get(`memory:${agentId}:${candidate.id}`) ?? Number.NaN
    }))
}

export interface MemorySaveResult {
  saved: MemorySummary
  superseded?: string[]
  nearDuplicates?: MemoryNearDuplicate[]
  note?: string
}

export interface MemorySaveContext extends MemoryToolContext {
  /** Inline saves know the finalized assistant message; tool saves usually do not. */
  messageId?: string | null
}

function memoryIsExpired(record: MemoryRecord, nowTs = Date.now()): boolean {
  return typeof record.expires_ts === 'number' && record.expires_ts <= nowTs
}

export async function assertStandingMediaCapacity(options: {
  agentId: string
  mode: MemoryMediaMode
  mediaCount: number
  excludeMemoryId?: string
}): Promise<void> {
  if (options.mode !== 'always' || options.mediaCount === 0) return
  const records = await listMemories(options.agentId)
  const existingCount = records
    .filter(
      (record) =>
        record.id !== options.excludeMemoryId &&
        record.lane === 'awareness' &&
        record.media_mode === 'always' &&
        record.is_superseded !== 'y' &&
        !memoryIsExpired(record)
    )
    .reduce((sum, record) => sum + (record.media?.length ?? 0), 0)
  if (existingCount + options.mediaCount > MEMORY_STANDING_MEDIA_CAP) {
    throw new MemoryToolError(
      `Always-on Awareness media is capped at ${MEMORY_STANDING_MEDIA_CAP} images per agent; this change would make ${existingCount + options.mediaCount}.`,
      'Turn off "Show this image every message" for another Awareness memory, or keep this image on recall.'
    )
  }
}

async function copyClipInputs(options: {
  userId: string
  agentId: string
  memoryId: string
  clipIds: string[]
}): Promise<MemoryMediaRecord[]> {
  const copied: MemoryMediaRecord[] = []
  try {
    for (const clipId of options.clipIds) {
      copied.push(
        await copyClipToMemoryMedia({
          userId: options.userId,
          agentId: options.agentId,
          memoryId: options.memoryId,
          clipId
        })
      )
    }
    return copied
  } catch (error) {
    for (const media of copied) await deleteMemoryMedia(media).catch(() => {})
    if (error instanceof MemoryMediaError) {
      throw new MemoryToolError(
        `Memory media could not be copied: ${error.message}`,
        'Attach an existing JPEG, PNG, GIF, or WebP Clip and retry the memory save.'
      )
    }
    throw error
  }
}

/**
 * The single save path (tool + inline). Validates through the shared payload contract,
 * writes through the data layer, chains save-time supersession, and surfaces
 * near-duplicate assistance — a warning with references, never a silent merge or
 * rejection.
 */
export async function saveMemoryOp(
  context: MemorySaveContext,
  rawPayload: unknown
): Promise<MemorySaveResult> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)

  const validation = validateMemorySavePayload(rawPayload)
  if (!validation.ok) {
    throw new MemoryToolError(validation.error, validation.hint)
  }
  const payload: MemorySavePayload = validation.value

  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : ''
  if (!sessionId) {
    throw new MemoryToolError(
      'Memory saves need a chat session context for provenance (DL-104-08).',
      'Save memories from within a chat run; provenance records where each memory came from.'
    )
  }

  // Save-time supersession targets must exist BEFORE the new record is written so a bad
  // id cannot leave an orphaned half-applied save.
  if (payload.supersedes?.length) {
    for (const oldId of payload.supersedes) {
      const existing = await getMemory(context.agentId, oldId)
      if (!existing) {
        throw new MemoryToolError(
          `Cannot supersede memory "${oldId}": it does not exist for this agent.`,
          'Use sys.memory.search or sys.memory.list to find the exact memory id first.'
        )
      }
    }
  }

  // SA-104 P5: the embedder is built with the caller's user context so the api lane
  // can resolve the user's saved provider key.
  // SA-102 P5 (DL-102-14): async door, because the local lane's key lives in the
  // shared encrypted store and reading it is async. The sync door would hand a
  // key-protected local program the old `local-ai` placeholder and 401.
  const embedder = await createMemoryEmbedderAsync((await getMemoryConfig()).embedding, {
    userId: context.userId
  })

  const memoryId = createMemoryId()
  const mediaMode = payload.media_mode ?? 'on_recall'
  const media = payload.clip_ids?.length
    ? await copyClipInputs({
        userId: context.userId,
        agentId: context.agentId,
        memoryId,
        clipIds: payload.clip_ids
      })
    : []
  try {
    await assertStandingMediaCapacity({
      agentId: context.agentId,
      mode: mediaMode,
      mediaCount: media.length
    })
  } catch (error) {
    for (const item of media) await deleteMemoryMedia(item).catch(() => {})
    throw error
  }

  let record: MemoryRecord
  try {
    record = await createMemory(
      {
        id: memoryId,
        agent_id: context.agentId,
        user_id: context.userId,
        lane: payload.lane,
        content: payload.content,
        gist: payload.gist,
        trigger_terms: payload.trigger_terms,
        linger_override: payload.linger,
        importance: payload.importance,
        event_at: payload.event_at ?? null,
        expires_at: payload.expires_at ?? null,
        links: payload.links,
        media,
        media_mode: mediaMode,
        provenance: [
          {
            session_id: sessionId,
            ...(context.messageId ? { message_id: context.messageId } : {}),
            source: 'agent'
          }
        ]
      },
      { embedder }
    )
  } catch (error) {
    for (const item of media) await deleteMemoryMedia(item).catch(() => {})
    throw error
  }

  let superseded: string[] | undefined
  if (payload.supersedes?.length) {
    await supersedeMemory(context.agentId, record.id, payload.supersedes)
    superseded = payload.supersedes
  }

  const nearDuplicates = await findNearDuplicates(context.agentId, record)

  return {
    saved: toMemorySummary(record),
    ...(superseded ? { superseded } : {}),
    ...(nearDuplicates.length > 0
      ? {
          nearDuplicates,
          note:
            'Very similar memories already exist. If this save restates one of them, supersede the old id ' +
            '(sys.memory.supersede) or update it (sys.memory.update) instead of keeping duplicates.'
        }
      : {})
  }
}

const BARE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function parseIsoToMs(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new MemoryToolError(`"${field}" must be an ISO timestamp string.`)
  }
  // Bare dates mean calendar days in this instance's local timezone: `_from` is the
  // start of that day, `_to` runs through its end. `new Date('YYYY-MM-DD')` is midnight
  // UTC — a day's START in the wrong timezone — which silently excluded every memory
  // saved later that local day (found live in P8: Claude CLI passed bare dates and got
  // zero results for a week that contained the memories; a late-evening local save sits
  // past even end-of-day UTC). Models pass bare dates constantly; single-user instances
  // run in the user's timezone.
  const bare = BARE_DATE_PATTERN.exec(value.trim())
  if (bare) {
    const [, year, month, day] = bare
    const localStart = new Date(Number(year), Number(month) - 1, Number(day)).getTime()
    if (!Number.isFinite(localStart)) {
      throw new MemoryToolError(`"${field}" is not a valid timestamp: '${value}'.`)
    }
    return field.endsWith('_to') ? localStart + 86_399_999 : localStart
  }
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) {
    throw new MemoryToolError(`"${field}" is not a valid timestamp: '${value}'.`)
  }
  return parsed
}

function parseLaneFilter(value: unknown): MemoryLane | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const lane = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!MEMORY_LANES.includes(lane as MemoryLane)) {
    throw new MemoryToolError(`"lane" must be one of: ${MEMORY_LANES.join(', ')}.`)
  }
  return lane as MemoryLane
}

export interface MemorySearchInput {
  query: string
  lane?: string
  include_superseded?: boolean
  event_from?: string
  event_to?: string
  saved_from?: string
  saved_to?: string
  limit?: number
}

/** SA-104 P6: summary-first graduated-segment reference (search + recall target). */
export interface MemorySegmentSummary {
  id: string
  session_id: string
  episode_id?: string | null
  gist: string
  first_message_at: string
  last_message_at: string
  message_count: number
  graduated_by: string
  last_recalled_at?: string | null
}

export interface MemorySearchResult {
  results: MemorySummary[]
  /** Graduated conversation segments matching the query (P6; recall their ids too). */
  segments?: MemorySegmentSummary[]
  totalReturned: number
  note: string
}

const LINK_EXPANSION_MAX = 4
const SEGMENT_SEARCH_MAX = 6

export function toMemorySegmentSummary(segment: MemorySegmentRecord): MemorySegmentSummary {
  const gist =
    segment.summary.length > GIST_PREVIEW_CHARS
      ? `${segment.summary.slice(0, GIST_PREVIEW_CHARS).trimEnd()}…`
      : segment.summary
  return {
    id: segment.id,
    session_id: segment.session_id,
    ...(segment.episode_id ? { episode_id: segment.episode_id } : {}),
    gist,
    first_message_at: segment.first_message_at,
    last_message_at: segment.last_message_at,
    message_count: segment.message_ids.length,
    graduated_by: segment.graduated_by,
    ...(segment.last_recalled_at ? { last_recalled_at: segment.last_recalled_at } : {})
  }
}

/**
 * Hybrid (lexical + vector) search with lane/superseded/time filters, summary-first.
 * P4 (DL-104-09): final ordering is the blended relevance × recency × importance
 * ranking in application code, superseded results stay demoted to the tail (flagged,
 * never hidden), and up to four 1-hop [[link]] neighbors of the ranked hits append as
 * `linked_from` references outside the limit.
 */
export async function searchMemoriesOp(
  context: MemoryToolContext,
  input: MemorySearchInput
): Promise<MemorySearchResult> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)

  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query.length < 2) {
    throw new MemoryToolError('"query" is required (at least 2 characters).')
  }
  const limitRaw = typeof input.limit === 'number' ? Math.floor(input.limit) : SEARCH_DEFAULT_LIMIT
  const limit = Math.min(Math.max(limitRaw, 1), SEARCH_MAX_LIMIT)

  const filters: MemorySearchFilters = {}
  const lane = parseLaneFilter(input.lane)
  if (lane) filters.lane = lane
  if (input.include_superseded === false) filters.superseded = 'n'
  const eventFrom = parseIsoToMs(input.event_from, 'event_from')
  const eventTo = parseIsoToMs(input.event_to, 'event_to')
  if (eventFrom !== undefined) filters.eventTsMin = eventFrom
  if (eventTo !== undefined) filters.eventTsMax = eventTo
  const savedFrom = parseIsoToMs(input.saved_from, 'saved_from')
  const savedTo = parseIsoToMs(input.saved_to, 'saved_to')
  if (savedFrom !== undefined) filters.savedTsMin = savedFrom
  if (savedTo !== undefined) filters.savedTsMax = savedTo

  const embedder = await createMemoryEmbedderAsync((await getMemoryConfig()).embedding, {
    userId: context.userId
  })
  const vector = await embedder.embedQuery(query)
  const hits = await hybridSearchMemories({
    agentId: context.agentId,
    query,
    vector,
    limit,
    filters
  })

  const records = await fetchMemoriesByKeys(hits.map((hit) => hit.key))
  const hitOrder = new Map<string, number>()
  hits.forEach((hit, index) => {
    const memoryId = hit.key.split(':').pop() as string
    if (!hitOrder.has(memoryId)) hitOrder.set(memoryId, index)
  })

  // DL-104-09: blended ranking in application code; superseded results stay visible
  // but demoted behind current ones (each group blended internally).
  const nowTs = Date.now()
  const current = blendMemoryRanking(
    records.filter((record) => record.is_superseded !== 'y'),
    hitOrder,
    nowTs
  )
  const supersededRecords = blendMemoryRanking(
    records.filter((record) => record.is_superseded === 'y'),
    hitOrder,
    nowTs
  )
  const ranked = [...current, ...supersededRecords]

  // 1-hop link expansion over the ranked hits, best-first, outside the limit.
  const includedIds = new Set(ranked.map((record) => record.id))
  const linkedSummaries: MemorySummary[] = []
  for (const record of ranked) {
    if (linkedSummaries.length >= LINK_EXPANSION_MAX) break
    for (const linkedId of record.links ?? []) {
      if (linkedSummaries.length >= LINK_EXPANSION_MAX) break
      if (includedIds.has(linkedId)) continue
      const linked = await getMemory(context.agentId, linkedId)
      if (!linked) continue
      includedIds.add(linkedId)
      linkedSummaries.push({ ...toMemorySummary(linked), linked_from: record.id })
    }
  }

  const results = [...ranked.map(toMemorySummary), ...linkedSummaries]

  // SA-104 P6: graduated segments join search (the P4 deferral). Ordering keeps the
  // index's fused hit order — segments carry no importance, so the memory group's
  // blended ranking deliberately stays a memory-only contract. Time scoping matches
  // by overlap with each segment's message span.
  const segmentFilters: SegmentSearchFilters = {}
  const segmentTimeMin = eventFrom ?? savedFrom
  const segmentTimeMax = eventTo ?? savedTo
  if (segmentTimeMin !== undefined) segmentFilters.timeMin = segmentTimeMin
  if (segmentTimeMax !== undefined) segmentFilters.timeMax = segmentTimeMax
  const segmentHits = await hybridSearchSegments({
    agentId: context.agentId,
    query,
    vector,
    limit: Math.min(limit, SEGMENT_SEARCH_MAX),
    filters: segmentFilters
  })
  const segmentIds = segmentHits
    .map((hit) => hit.key.startsWith(`${MEMORY_SEGMENT_KEY_PREFIX}${context.agentId}:`)
      ? hit.key.slice(`${MEMORY_SEGMENT_KEY_PREFIX}${context.agentId}:`.length)
      : '')
    .filter(Boolean)
  const segmentRecords = await fetchMemorySegmentsByIds(context.agentId, segmentIds)
  const segmentOrder = new Map(segmentIds.map((id, index) => [id, index]))
  segmentRecords.sort(
    (a, b) => (segmentOrder.get(a.id) ?? 0) - (segmentOrder.get(b.id) ?? 0)
  )
  const segments = segmentRecords.map(toMemorySegmentSummary)

  return {
    results,
    ...(segments.length > 0 ? { segments } : {}),
    totalReturned: results.length + segments.length,
    note:
      'These are summary references, not full memories. To bring chosen memories into your context, call ' +
      'sys.memory.recall with their ids. Entries marked superseded point to the chosen current memory — timestamps ' +
      'do not decide the winner. Rows with linked_from rode in via another result’s [[links]]. Rows under segments are graduated ' +
      'conversation stretches — recall their ids to receive the full episode summary.'
  }
}

export interface MemoryListInput {
  lane?: string
  include_superseded?: boolean
  limit?: number
}

export async function listMemoriesOp(
  context: MemoryToolContext,
  input: MemoryListInput
): Promise<MemorySearchResult> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)

  const lane = parseLaneFilter(input.lane)
  const limitRaw = typeof input.limit === 'number' ? Math.floor(input.limit) : LIST_DEFAULT_LIMIT
  const limit = Math.min(Math.max(limitRaw, 1), LIST_MAX_LIMIT)

  let records = await listMemories(context.agentId)
  if (lane) records = records.filter((record) => record.lane === lane)
  if (input.include_superseded === false) {
    records = records.filter((record) => record.is_superseded !== 'y')
  }

  return {
    results: records.slice(0, limit).map(toMemorySummary),
    totalReturned: Math.min(records.length, limit),
    note:
      'Newest first, summary references only. Use sys.memory.recall with chosen ids to bring full memories ' +
      'into your context.'
  }
}

export interface MemoryUpdateInput {
  memoryId: string
  content?: string
  gist?: string | null
  trigger_terms?: string[] | null
  trigger_synonyms?: string[] | null
  /** Per-memory linger override: turns, 'episode', or null to clear. */
  linger?: number | 'episode' | null
  importance?: number
  event_at?: string | null
  expires_at?: string | null
  links?: string[] | null
  clip_ids?: string[] | null
  media_mode?: MemoryMediaMode | null
}

export async function updateMemoryOp(
  context: MemoryToolContext,
  input: MemoryUpdateInput
): Promise<{ updated: MemorySummary }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const existing = await getMemory(context.agentId, input.memoryId)
  if (!existing) throw new MemoryToolError(`Memory "${input.memoryId}" was not found for this agent.`)
  if (
    input.media_mode !== undefined &&
    input.media_mode !== null &&
    input.media_mode !== 'on_recall' &&
    input.media_mode !== 'always'
  ) {
    throw new MemoryToolError('media_mode must be "on_recall" or "always".')
  }
  const updates: UpdateMemoryInput = {}
  if (input.content !== undefined) updates.content = input.content
  if (input.gist !== undefined) updates.gist = input.gist
  if (input.trigger_terms !== undefined) updates.trigger_terms = input.trigger_terms
  if (input.trigger_synonyms !== undefined) updates.trigger_synonyms = input.trigger_synonyms
  if (input.linger !== undefined) updates.linger_override = input.linger
  if (input.importance !== undefined) updates.importance = input.importance
  if (input.event_at !== undefined) updates.event_at = input.event_at
  if (input.expires_at !== undefined) updates.expires_at = input.expires_at
  if (input.links !== undefined) updates.links = input.links
  let replacementMedia: MemoryMediaRecord[] | null | undefined
  if (input.clip_ids !== undefined) {
    replacementMedia = input.clip_ids?.length
      ? await copyClipInputs({
          userId: context.userId,
          agentId: context.agentId,
          memoryId: input.memoryId,
          clipIds: input.clip_ids
        })
      : null
    updates.media = replacementMedia
  }
  if (input.media_mode !== undefined) updates.media_mode = input.media_mode
  if (Object.keys(updates).length === 0) {
    for (const item of replacementMedia ?? []) await deleteMemoryMedia(item).catch(() => {})
    throw new MemoryToolError('Memory update needs at least one field to change.')
  }
  const nextMode = input.media_mode === null ? 'on_recall' : input.media_mode ?? existing.media_mode ?? 'on_recall'
  const nextMedia = replacementMedia === undefined ? existing.media ?? [] : replacementMedia ?? []
  if (nextMode === 'always' && existing.lane !== 'awareness') {
    for (const item of replacementMedia ?? []) await deleteMemoryMedia(item).catch(() => {})
    throw new MemoryToolError('Always-on media is only valid for an awareness memory.')
  }
  try {
    await assertStandingMediaCapacity({
      agentId: context.agentId,
      mode: nextMode,
      mediaCount: nextMedia.length,
      excludeMemoryId: existing.id
    })
  } catch (error) {
    for (const item of replacementMedia ?? []) await deleteMemoryMedia(item).catch(() => {})
    throw error
  }
  const embedder = await createMemoryEmbedderAsync((await getMemoryConfig()).embedding, {
    userId: context.userId
  })
  let record: MemoryRecord
  try {
    record = await updateMemory(context.agentId, input.memoryId, updates, { embedder })
  } catch (error) {
    for (const item of replacementMedia ?? []) await deleteMemoryMedia(item).catch(() => {})
    throw error
  }
  if (replacementMedia !== undefined) {
    for (const item of existing.media ?? []) await deleteMemoryMedia(item)
  }
  return { updated: toMemorySummary(record) }
}

/** Deliberate lane move (DL-104-03: placement changes are explicit acts). */
export async function moveMemoryLaneOp(
  context: MemoryToolContext,
  input: { memoryId: string; lane: string }
): Promise<{ moved: MemorySummary }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const lane = parseLaneFilter(input.lane)
  if (!lane) {
    throw new MemoryToolError(`"lane" is required and must be one of: ${MEMORY_LANES.join(', ')}.`)
  }
  const existing = await getMemory(context.agentId, input.memoryId)
  if (!existing) {
    throw new MemoryToolError(`Memory "${input.memoryId}" was not found for this agent.`)
  }
  if (lane === 'stm' && !existing.trigger_terms?.length) {
    throw new MemoryToolError(
      'Moving a memory to stm requires trigger terms. Update the memory with trigger_terms first (or in the same update call).'
    )
  }
  if (lane !== 'awareness' && existing.media_mode === 'always') {
    throw new MemoryToolError(
      'Turn off always-on media before moving this memory out of the awareness lane.'
    )
  }
  const record = await updateMemory(context.agentId, input.memoryId, { lane })
  return { moved: toMemorySummary(record) }
}

export async function supersedeMemoryOp(
  context: MemoryToolContext,
  input: { memoryId: string; supersedes: string[] }
): Promise<{ superseder: MemorySummary; superseded: string[] }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  if (!Array.isArray(input.supersedes) || input.supersedes.length === 0) {
    throw new MemoryToolError('"supersedes" must list at least one memory id to supersede.')
  }
  const record = await supersedeMemory(context.agentId, input.memoryId, input.supersedes)
  return { superseder: toMemorySummary(record), superseded: input.supersedes }
}

export async function unsupersedeMemoryOp(
  context: MemoryToolContext,
  input: { memoryId: string }
): Promise<{ restored: MemorySummary }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const record = await unsupersedeMemory(context.agentId, input.memoryId)
  return { restored: toMemorySummary(record) }
}

export async function deleteMemoryOp(
  context: MemoryToolContext,
  input: { memoryId: string }
): Promise<{ deleted: boolean; memoryId: string }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const existing = await getMemory(context.agentId, input.memoryId)
  if (!existing) {
    throw new MemoryToolError(`Memory "${input.memoryId}" was not found for this agent.`)
  }
  const deleted = await deleteMemory(context.agentId, input.memoryId)
  if (deleted) {
    await refoldAwarenessAfterDelete(context.agentId, input.memoryId, existing.lane)
  }
  return { deleted, memoryId: input.memoryId }
}

/**
 * SA-110 P2 (DL-110-05): deleting an awareness record (or a record the stored fold
 * still shows) is the ONE immediate re-fold — showing deleted content in the SP
 * until a fold boundary would lie. One bounded cache reset, rare and deliberate.
 * A failed re-fold is logged loudly but never fails the delete: the compile's
 * pending diff renders a "removed — disregard it" note for a fold entry with no
 * live record, so the SP stays honest either way.
 */
export async function refoldAwarenessAfterDelete(
  agentId: string,
  memoryId: string,
  deletedLane: string | undefined
): Promise<void> {
  try {
    const needsRefold =
      deletedLane === 'awareness' ||
      Boolean((await getMemoryFold(agentId))?.records.some((entry) => entry.id === memoryId))
    if (needsRefold) {
      await foldAwarenessState({ agentId, reason: 'delete' })
    }
  } catch (error) {
    console.error(
      '[memoryTools] Awareness re-fold after delete failed (the pending "removed" note keeps the SP honest):',
      error
    )
  }
}

export interface MemoryRecallResult {
  /**
   * 2026-08-29: recall now returns FULL CONTENT in-turn (Josh's call — the agent
   * reads what it recalls immediately). Memory tool results leave no compiled-
   * history footprint (the DL-104-17 zip exemption), so this
   * costs context only in the turn that asked; persistence across later turns
   * stays exclusively the DCM linger channel the queue below arms.
   */
  recalled: Array<
    MemorySummary & {
      content: string
      /**
       * SA-105 P2: byte-free media plan. `delivery`/`reason`/`media_note` are
       * filled in at render time, where the run's lane is known.
       */
      media?: Array<{
        media_id: string
        filename: string
        mime_type: string
        bytes: number
        delivery?: 'in_turn' | 'next_message'
        reason?: string
      }>
      media_note?: string
    }
  >
  recalledSegments?: Array<MemorySegmentSummary & { summary: string }>
  note: string
}

/**
 * Recall returns full content in-turn and queues ids (`memlinger:{sessionId}`)
 * for the single DCM insert channel on later sends. DL-104-17 keeps memory tool
 * results out of compiled history; linger owns their cross-turn persistence.
 * P6: graduated segment ids (`memseg_…`, from search's segments group) recall through
 * the same queue and channel — the inserted content is the episode summary.
 */
export async function recallMemoriesOp(
  context: MemoryToolContext,
  input: { memoryIds: string[] }
): Promise<MemoryRecallResult> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)

  const memoryIds = Array.isArray(input.memoryIds)
    ? Array.from(
        new Set(
          input.memoryIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter((id) => id.length > 0)
        )
      )
    : []
  if (memoryIds.length === 0) {
    throw new MemoryToolError('"memoryIds" must list at least one memory id to recall.')
  }
  if (memoryIds.length > RECALL_MAX_IDS) {
    throw new MemoryToolError(`Recall at most ${RECALL_MAX_IDS} memories per call.`)
  }

  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : ''
  if (!sessionId) {
    throw new MemoryToolError('Memory recall needs a chat session context.')
  }

  const recalled: MemoryRecallResult['recalled'] = []
  const recalledSegments: Array<MemorySegmentSummary & { summary: string }> = []
  const entries: Array<{ id: string; kind: 'memory' | 'segment' }> = []
  for (const memoryId of memoryIds) {
    if (memoryId.startsWith('memseg_')) {
      const segment = await getMemorySegment(context.agentId, memoryId)
      if (!segment) {
        throw new MemoryToolError(
          `Segment "${memoryId}" was not found for this agent; nothing was queued.`,
          'Use sys.memory.search to find valid ids, then recall again.'
        )
      }
      recalledSegments.push({ ...toMemorySegmentSummary(segment), summary: segment.summary })
      entries.push({ id: memoryId, kind: 'segment' })
      continue
    }
    const record = await getMemory(context.agentId, memoryId)
    if (!record) {
      throw new MemoryToolError(
        `Memory "${memoryId}" was not found for this agent; nothing was queued.`,
        'Use sys.memory.search to find valid ids, then recall again.'
      )
    }
    recalled.push({
      ...toMemorySummary(record),
      content: record.content,
      // SA-105 P2 (DL-105-04): a BYTE-FREE media plan. Bytes are loaded later,
      // at delivery time, from the media id — never here, because this object
      // rides into intermediate steps, the Execution Viewer and the persisted
      // step payload, which is exactly the pile-up the story exists to prevent.
      //
      // Delivery is deliberately NOT decided here. This op has no provider
      // knowledge (its context is userId/agentId/sessionId), and the honest
      // answer depends on the run's lane. `applyRecallMediaDelivery` in
      // memoryRecallDelivery.ts fills in `delivery`, `reason` and the per-memory
      // `media_note` where the lane IS known, so the model never reads a note
      // that contradicts what it actually received.
      ...(record.media?.length
        ? {
            media: record.media.map((entry) => ({
              media_id: entry.id,
              filename: entry.display_name,
              mime_type: entry.mime_type,
              bytes: entry.bytes
            }))
          }
        : {})
    })
    entries.push({ id: memoryId, kind: 'memory' })
  }

  for (const entry of entries) {
    if (entry.kind === 'segment') await touchMemorySegmentRecall(context.agentId, entry.id)
    else await touchMemoryRecall(context.agentId, entry.id)
  }
  await queuePendingMemoryRecalls(sessionId, context.agentId, entries)

  return {
    recalled,
    ...(recalledSegments.length > 0 ? { recalledSegments } : {}),
    note:
      'Full content above — read it now; this tool result never enters chat history. The same memories also ' +
      'arrive in your Memory context from the next message and linger there, so you keep them for the follow-up turns.'
  }
}

// ---------------------------------------------------------------------------
// SA-104 P5 — episode boundary controls (Infinite Sessions only; DL-104-07 surface)
// ---------------------------------------------------------------------------

function episodeSummary(episode: EpisodeRecord): Record<string, any> {
  return {
    id: episode.id,
    state: episode.state,
    opened_at: episode.opened_at,
    ...(episode.closed_at ? { closed_at: episode.closed_at } : {}),
    ...(episode.boundary_signal ? { boundary_signal: episode.boundary_signal } : {}),
    ...(episode.hold_until ? { hold_until: episode.hold_until } : {})
  }
}

async function requireFixedSessionForEpisodes(
  context: MemoryToolContext
): Promise<{ sessionId: string; openEpisode: EpisodeRecord }> {
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : ''
  if (!sessionId) {
    throw new MemoryToolError('Episode controls need a chat session context.')
  }
  const session = (await redis.get(`session:${sessionId}`)) as Record<string, any> | null
  if (!session || (typeof session.user_id === 'string' && session.user_id !== context.userId)) {
    throw new MemoryToolError(`Session "${sessionId}" was not found for this user.`)
  }
  if (!isFixedSession(session)) {
    throw new MemoryToolError(
      'Episode controls only work in Infinite Sessions.',
      'This chat is a regular session; episodes exist only in Infinite Sessions.'
    )
  }
  const openEpisode = await getOpenEpisode(sessionId)
  if (!openEpisode) {
    throw new MemoryToolError(
      'This Infinite Session has no open episode yet.',
      'An episode opens automatically on the next accepted message.'
    )
  }
  return { sessionId, openEpisode }
}

/**
 * Close the open episode (`boundary_signal: 'agent_mark'`). Graduation of closed
 * episodes is dreaming/nap work (P6/P7) — closing only marks the boundary; the next
 * accepted message opens the next episode.
 */
export async function closeEpisodeOp(
  context: MemoryToolContext
): Promise<{ closed: Record<string, any>; note: string }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const { sessionId, openEpisode } = await requireFixedSessionForEpisodes(context)
  const closed = await closeEpisode(sessionId, openEpisode.id, 'agent_mark')
  return {
    closed: episodeSummary(closed),
    note:
      'Episode closed. A new episode opens on the next message; graduation of closed episodes happens during naps and dreaming.'
  }
}

/** Whiteboards compile into the current-message DCM every turn — keep them compact. */
export const WHITEBOARD_MAX_CHARS = 6_000

/**
 * SA-104 P6 — update (or clear) the open episode's whiteboard: the agent-maintained
 * working-facts block that rides the current-message DCM until the episode closes (DL-104-07).
 * Content replaces the whole whiteboard (the agent rewrites it deliberately); null or
 * empty clears it. Closing an episode keeps the final content on the record
 * (dissolved = kept, no longer compiled — DL-104-02).
 */
export async function updateWhiteboardOp(
  context: MemoryToolContext,
  input: { content?: string | null }
): Promise<{ episode: Record<string, any>; whiteboard: string | null; note: string }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const { sessionId, openEpisode } = await requireFixedSessionForEpisodes(context)

  const rawContent = typeof input.content === 'string' ? input.content.trim() : ''
  if (rawContent.length > WHITEBOARD_MAX_CHARS) {
    throw new MemoryToolError(
      `The whiteboard is capped at ${WHITEBOARD_MAX_CHARS} characters (it arrives with every current message). Keep only load-bearing working facts; move durable knowledge into memories instead.`
    )
  }

  const content = rawContent.length > 0 ? rawContent : null
  const updated = await updateEpisodeWhiteboard(sessionId, openEpisode.id, content)
  return {
    episode: episodeSummary(updated),
    whiteboard: updated.whiteboard?.content ?? null,
    note: content
      ? 'Whiteboard updated. It arrives with every current message (Episode whiteboard section) until this episode closes.'
      : 'Whiteboard cleared.'
  }
}

/** Set (or clear) the "continuing tomorrow" hold on the open episode. */
export async function holdEpisodeOp(
  context: MemoryToolContext,
  input: { hold_until?: string | null }
): Promise<{ episode: Record<string, any>; note: string }> {
  await requireMemoryEnabledAgent(context.userId, context.agentId)
  const { sessionId, openEpisode } = await requireFixedSessionForEpisodes(context)

  let holdUntil: string | null = null
  if (input.hold_until !== undefined && input.hold_until !== null && input.hold_until !== '') {
    if (typeof input.hold_until !== 'string' || !Number.isFinite(new Date(input.hold_until).getTime())) {
      throw new MemoryToolError('"hold_until" must be an ISO timestamp (or null to clear the hold).')
    }
    holdUntil = input.hold_until
  }

  const updated = await updateEpisodeBounds(sessionId, openEpisode.id, { hold_until: holdUntil })
  return {
    episode: episodeSummary(updated),
    note: holdUntil
      ? 'Hold set: this episode stays open across idle gaps until the hold passes.'
      : 'Hold cleared.'
  }
}

export interface InlineMemorySaveResultEntry {
  index: number
  saved?: MemorySummary
  superseded?: string[]
  nearDuplicates?: MemoryNearDuplicate[]
  note?: string
  error?: string
  hint?: string
}

/**
 * The inline `<batshit-memory>` processing path — the exact same op per payload as
 * `sys.memory.save`. One malformed or failing block never blocks the others; every
 * failure is returned loudly for the DL-104-05 surface.
 */
export async function processInlineMemorySaves(options: {
  userId: string
  agentId: string
  sessionId: string
  messageId?: string | null
  payloads: unknown[]
}): Promise<InlineMemorySaveResultEntry[]> {
  const results: InlineMemorySaveResultEntry[] = []
  for (let index = 0; index < options.payloads.length; index++) {
    try {
      const result = await saveMemoryOp(
        {
          userId: options.userId,
          agentId: options.agentId,
          sessionId: options.sessionId,
          messageId: options.messageId ?? null
        },
        options.payloads[index]
      )
      results.push({
        index,
        saved: result.saved,
        ...(result.superseded ? { superseded: result.superseded } : {}),
        ...(result.nearDuplicates ? { nearDuplicates: result.nearDuplicates } : {}),
        ...(result.note ? { note: result.note } : {})
      })
    } catch (error) {
      results.push({
        index,
        error: error instanceof Error ? error.message : 'Memory save failed.',
        ...(error instanceof MemoryToolError && error.hint ? { hint: error.hint } : {})
      })
    }
  }
  return results
}
