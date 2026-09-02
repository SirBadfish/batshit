/**
 * SA-104 P5 — the Memory Panel's management operations.
 *
 * Ownership-gated, NOT enablement-gated: the agent-facing ops layer
 * (`memoryTools.ts`, `requireMemoryEnabledAgent`) gates what AGENTS may do; the user
 * must always be able to see and manage everything an agent has stored — including a
 * currently memory-disabled agent's records (DL-104-16 full visibility, nothing
 * hidden). Responses never carry embedding vectors (P2 note).
 */

import { redis } from '$lib/server/redis'
import {
  deleteMemory,
  fetchMemoriesByKeys,
  fetchMemorySegmentsByIds,
  getMemory,
  getSupersessionChain,
  listMemories,
  listMemorySegments,
  updateMemory,
  type UpdateMemoryInput
} from './memoryStore'
import {
  getMemoryConfig,
  hybridSearchMemories,
  hybridSearchSegments,
  type MemorySearchFilters
} from './memoryIndex'
import { createMemoryEmbedder } from './memoryEmbedder'
import { awarenessEntryLineHash, getMemoryFold } from './memoryRecall'
import { refoldAwarenessAfterDelete, toMemorySummary, type MemorySummary } from './memoryTools'
import type { MemoryLane, MemoryRecord, MemorySegmentRecord } from './memoryTypes'
import { MEMORY_LANES } from './memoryTypes'

export class MemoryManageError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message)
    this.name = 'MemoryManageError'
  }
}

export interface MemoryManageContext {
  userId: string
  agentId: string
}

/** Ownership gate only — a disabled agent's memories stay fully manageable. */
export async function requireOwnedAgent(
  userId: string,
  agentId: string | null | undefined
): Promise<Record<string, any>> {
  const normalized = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalized) {
    throw new MemoryManageError('agentId is required.', 400)
  }
  const agent = (await redis.get(`agent:${normalized}`)) as Record<string, any> | null
  if (!agent) {
    throw new MemoryManageError(`Agent "${normalized}" was not found.`, 404)
  }
  if (typeof agent.user_id === 'string' && agent.user_id !== userId) {
    throw new MemoryManageError(`Agent "${normalized}" does not belong to this user.`, 403)
  }
  return agent
}

function parseLane(value: unknown): MemoryLane | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const lane = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!MEMORY_LANES.includes(lane as MemoryLane)) {
    throw new MemoryManageError(`lane must be one of: ${MEMORY_LANES.join(', ')}.`, 400)
  }
  return lane as MemoryLane
}

function parseIsoMs(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = new Date(String(value)).getTime()
  if (!Number.isFinite(parsed)) {
    throw new MemoryManageError(`${field} is not a valid timestamp.`, 400)
  }
  return parsed
}

/** Full record for the detail lane — embedding stripped, everything else visible. */
export type MemoryRecordView = Omit<MemoryRecord, 'embedding'>

function toRecordView(record: MemoryRecord): MemoryRecordView {
  const { embedding: _embedding, ...view } = record
  return view
}

export interface MemoryManageListInput {
  lane?: string
  includeSuperseded?: boolean
  limit?: number
  savedFrom?: string
  savedTo?: string
}

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 500

export async function listManagedMemories(
  context: MemoryManageContext,
  input: MemoryManageListInput
): Promise<{ results: MemorySummary[]; total: number }> {
  await requireOwnedAgent(context.userId, context.agentId)
  const lane = parseLane(input.lane)
  const savedFrom = parseIsoMs(input.savedFrom, 'savedFrom')
  const savedTo = parseIsoMs(input.savedTo, 'savedTo')
  const limitRaw = typeof input.limit === 'number' ? Math.floor(input.limit) : LIST_DEFAULT_LIMIT
  const limit = Math.min(Math.max(limitRaw, 1), LIST_MAX_LIMIT)

  let records = await listMemories(context.agentId)
  if (lane) records = records.filter((record) => record.lane === lane)
  if (input.includeSuperseded === false) {
    records = records.filter((record) => record.is_superseded !== 'y')
  }
  if (savedFrom !== undefined) records = records.filter((record) => record.saved_ts >= savedFrom)
  if (savedTo !== undefined) records = records.filter((record) => record.saved_ts <= savedTo)

  return {
    results: records.slice(0, limit).map(toMemorySummary),
    total: records.length
  }
}

export interface MemoryManageSearchInput extends MemoryManageListInput {
  query: string
}

export async function searchManagedMemories(
  context: MemoryManageContext,
  input: MemoryManageSearchInput
): Promise<{ results: MemorySummary[] }> {
  await requireOwnedAgent(context.userId, context.agentId)
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query.length < 2) {
    throw new MemoryManageError('query must be at least 2 characters.', 400)
  }
  const filters: MemorySearchFilters = {}
  const lane = parseLane(input.lane)
  if (lane) filters.lane = lane
  if (input.includeSuperseded === false) filters.superseded = 'n'
  const savedFrom = parseIsoMs(input.savedFrom, 'savedFrom')
  const savedTo = parseIsoMs(input.savedTo, 'savedTo')
  if (savedFrom !== undefined) filters.savedTsMin = savedFrom
  if (savedTo !== undefined) filters.savedTsMax = savedTo

  const limitRaw = typeof input.limit === 'number' ? Math.floor(input.limit) : 25
  const limit = Math.min(Math.max(limitRaw, 1), 100)

  const embedder = createMemoryEmbedder((await getMemoryConfig()).embedding, {
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
  return { results: records.map(toMemorySummary) }
}

export interface MemoryManageDetail {
  record: MemoryRecordView
  chain: {
    predecessors: MemorySummary[]
    successors: MemorySummary[]
  }
}

export async function getManagedMemoryDetail(
  context: MemoryManageContext,
  memoryId: string
): Promise<MemoryManageDetail> {
  await requireOwnedAgent(context.userId, context.agentId)
  const normalized = typeof memoryId === 'string' ? memoryId.trim() : ''
  if (!normalized) throw new MemoryManageError('memoryId is required.', 400)
  const record = await getMemory(context.agentId, normalized)
  if (!record) {
    throw new MemoryManageError(`Memory "${normalized}" was not found for this agent.`, 404)
  }
  const chain = await getSupersessionChain(context.agentId, normalized)
  return {
    record: toRecordView(record),
    chain: {
      predecessors: chain.predecessors.map(toMemorySummary),
      successors: chain.successors.map(toMemorySummary)
    }
  }
}

export async function updateManagedMemory(
  context: MemoryManageContext,
  memoryId: string,
  updates: UpdateMemoryInput
): Promise<MemoryRecordView> {
  await requireOwnedAgent(context.userId, context.agentId)
  const normalized = typeof memoryId === 'string' ? memoryId.trim() : ''
  if (!normalized) throw new MemoryManageError('memoryId is required.', 400)
  if (!updates || Object.keys(updates).length === 0) {
    throw new MemoryManageError('At least one field to update is required.', 400)
  }
  const embedder = createMemoryEmbedder((await getMemoryConfig()).embedding, {
    userId: context.userId
  })
  const record = await updateMemory(context.agentId, normalized, updates, { embedder })
  return toRecordView(record)
}

export async function deleteManagedMemory(
  context: MemoryManageContext,
  memoryId: string
): Promise<{ deleted: boolean }> {
  await requireOwnedAgent(context.userId, context.agentId)
  const normalized = typeof memoryId === 'string' ? memoryId.trim() : ''
  if (!normalized) throw new MemoryManageError('memoryId is required.', 400)
  const existing = await getMemory(context.agentId, normalized)
  if (!existing) {
    throw new MemoryManageError(`Memory "${normalized}" was not found for this agent.`, 404)
  }
  const deleted = await deleteMemory(context.agentId, normalized)
  if (deleted) {
    // SA-110 P2 (DL-110-05): panel deletion is as destructive as the tool's — the
    // same immediate re-fold rule applies so the SP never shows deleted content.
    await refoldAwarenessAfterDelete(context.agentId, normalized, existing.lane)
  }
  return { deleted }
}

/**
 * The agent-authored Awareness section, in EXACTLY the compile order the P4 engine
 * uses (importance desc, saved asc, then id) — DL-104-16: what the agent wrote into
 * its own system prompt is never hidden from the user. Expired entries are included
 * and flagged so the panel can show why they no longer compile. ("Awareness" is the
 * product name for the former on-my-mind block, 2026-08-26 rename.)
 */
export async function getManagedAwareness(
  context: MemoryManageContext
): Promise<{ entries: Array<MemoryRecordView & { expired: boolean; pending: 'new' | 'updated' | null }> }> {
  await requireOwnedAgent(context.userId, context.agentId)
  const nowTs = Date.now()
  const records = (await listMemories(context.agentId)).filter(
    (record) => record.lane === 'awareness' && record.is_superseded !== 'y'
  )
  records.sort(
    (a, b) =>
      b.importance - a.importance || a.saved_ts - b.saved_ts || a.id.localeCompare(b.id)
  )
  // SA-110 P2 honesty: rows newer than the stored fold snapshot are flagged so the
  // panel can say the entry is active via chat context but not yet in the permanent
  // AWARENESS block (display only). No fold record = nothing pending (live compile).
  const fold = await getMemoryFold(context.agentId)
  const foldHashById = fold
    ? new Map(fold.records.map((entry) => [entry.id, entry.line_hash]))
    : null
  return {
    entries: records.map((record) => ({
      ...toRecordView(record),
      expired: Boolean(record.expires_ts && record.expires_ts <= nowTs),
      pending: !foldHashById
        ? null
        : !foldHashById.has(record.id)
          ? 'new'
          : foldHashById.get(record.id) !== awarenessEntryLineHash(record)
            ? 'updated'
            : null
    }))
  }
}

/** Graduated-history row for the panel — full summary text, embedding stripped. */
export type MemorySegmentView = Omit<MemorySegmentRecord, 'embedding'>

function toSegmentView(segment: MemorySegmentRecord): MemorySegmentView {
  const { embedding: _embedding, ...view } = segment
  return view
}

const SEGMENTS_DEFAULT_LIMIT = 50
const SEGMENTS_MAX_LIMIT = 200

/**
 * Graduated History browser (2026-08-26): the summarized old-chat segments, newest
 * first, with optional hybrid search. Read-only in v1 — an Infinite Session's window
 * splices still reference their segments, so deletion needs its own design before it
 * gets a button. Ownership-gated like every manage surface.
 */
export async function listManagedSegments(
  context: MemoryManageContext,
  input: { query?: string; limit?: number }
): Promise<{ results: MemorySegmentView[]; total: number }> {
  await requireOwnedAgent(context.userId, context.agentId)
  const limitRaw =
    typeof input.limit === 'number' ? Math.floor(input.limit) : SEGMENTS_DEFAULT_LIMIT
  const limit = Math.min(Math.max(limitRaw, 1), SEGMENTS_MAX_LIMIT)
  const query = typeof input.query === 'string' ? input.query.trim() : ''

  if (query.length >= 2) {
    const embedder = createMemoryEmbedder((await getMemoryConfig()).embedding, {
      userId: context.userId
    })
    const vector = await embedder.embedQuery(query)
    const hits = await hybridSearchSegments({
      agentId: context.agentId,
      query,
      vector,
      limit
    })
    const segmentIds = hits
      .map((hit) => hit.key.split(':').pop() ?? '')
      .filter((id) => id.length > 0)
    const records = await fetchMemorySegmentsByIds(context.agentId, segmentIds)
    return { results: records.map(toSegmentView), total: records.length }
  }

  const records = await listMemorySegments(context.agentId)
  return {
    results: records.slice(0, limit).map(toSegmentView),
    total: records.length
  }
}
