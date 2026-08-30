/**
 * SA-104 memory data layer — record CRUD, supersession, and expiry-demotion primitives
 * (DL-104-02: nothing is silently destroyed; supersession invalidates with a pointer,
 * expiry demotes, and the only true delete is an explicit delete call).
 *
 * Every write path verifies the configured embedder still matches the built index
 * (DL-104-10): a model change without the explicit re-index path must fail loudly
 * before any mixed-dimension vector lands in Redis.
 */

import { redis } from '$lib/server/redis'
import {
  memoryKey,
  memoryAgentPattern,
  memorySegmentKey,
  memorySegmentAgentPattern
} from './memoryKeys'
import {
  MEMORY_LANES,
  MEMORY_SCHEMA_VERSION,
  type MemoryLane,
  type MemoryProvenanceEntry,
  type MemoryRecord,
  type MemorySegmentRecord,
  type GraduationSource
} from './memoryTypes'
import { createMemoryEmbedder, type MemoryEmbedder } from './memoryEmbedder'
import { getMemoryConfig, requireReadyMemoryIndexes } from './memoryIndex'

function randomIdSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

function nowStamps(): { iso: string; ts: number } {
  const now = new Date()
  return { iso: now.toISOString(), ts: now.getTime() }
}

/** Batch contexts (graduation, dreaming, tests) may supply one embedder for many writes. */
export interface MemoryWriteOptions {
  embedder?: MemoryEmbedder
}

async function resolveWriteEmbedder(override?: MemoryEmbedder): Promise<MemoryEmbedder> {
  const meta = await requireReadyMemoryIndexes()
  const embedder = override ?? createMemoryEmbedder((await getMemoryConfig()).embedding)
  if (embedder.modelId !== meta.embedding_model || embedder.dims !== meta.dims) {
    throw new Error(
      `Memory write refused: configured embedder (${embedder.modelId}, ${embedder.dims}d) does not match the ` +
        `built index (${meta.embedding_model}, ${meta.dims}d). Run the explicit memory re-index path first.`
    )
  }
  return embedder
}

function assertLane(lane: string): asserts lane is MemoryLane {
  if (!MEMORY_LANES.includes(lane as MemoryLane)) {
    throw new Error(`Unknown memory lane '${lane}'. Valid lanes: ${MEMORY_LANES.join(', ')}.`)
  }
}

function assertImportance(importance: number): void {
  if (!Number.isFinite(importance) || importance < 1 || importance > 10) {
    throw new Error(`Memory importance must be a number from 1 to 10 (got ${importance}).`)
  }
}

const MAX_LINGER_OVERRIDE_TURNS = 30

function assertLingerOverride(value: number | 'episode'): void {
  if (value === 'episode') return
  if (!Number.isInteger(value) || value < 0 || value > MAX_LINGER_OVERRIDE_TURNS) {
    throw new Error(
      `Memory linger_override must be an integer 0-${MAX_LINGER_OVERRIDE_TURNS} or 'episode' (got ${JSON.stringify(value)}).`
    )
  }
}

export interface CreateMemoryInput {
  agent_id: string
  user_id: string
  lane: MemoryLane
  content: string
  gist?: string
  trigger_terms?: string[]
  /** Retired 2026-08-29 (folded into trigger_terms); kept for legacy callers only. */
  trigger_synonyms?: string[]
  linger_override?: number | 'episode'
  importance: number
  event_at?: string | null
  expires_at?: string | null
  links?: string[]
  clip_ids?: string[]
  provenance: MemoryProvenanceEntry[]
}

export async function createMemory(
  input: CreateMemoryInput,
  options?: MemoryWriteOptions
): Promise<MemoryRecord> {
  assertLane(input.lane)
  assertImportance(input.importance)
  if (input.linger_override !== undefined) assertLingerOverride(input.linger_override)
  if (!input.agent_id?.trim()) throw new Error('Memory records require agent_id.')
  if (!input.user_id?.trim()) throw new Error('Memory records require user_id.')
  if (!input.content?.trim()) throw new Error('Memory records require non-empty content.')
  if (!Array.isArray(input.provenance) || input.provenance.length === 0) {
    throw new Error('Memory records require at least one provenance entry (DL-104-08).')
  }

  const embedder = await resolveWriteEmbedder(options?.embedder)
  const [embedding] = await embedder.embedDocuments([input.content])
  const { iso, ts } = nowStamps()
  const eventAt = input.event_at ?? null
  const eventTs = eventAt ? new Date(eventAt).getTime() : null
  if (eventAt && !Number.isFinite(eventTs)) {
    throw new Error(`Memory event_at is not a valid timestamp: '${eventAt}'.`)
  }
  const expiresAt = input.expires_at ?? null
  const expiresTs = expiresAt ? new Date(expiresAt).getTime() : null
  if (expiresAt && !Number.isFinite(expiresTs)) {
    throw new Error(`Memory expires_at is not a valid timestamp: '${expiresAt}'.`)
  }

  const record: MemoryRecord = {
    id: `mem_${ts}_${randomIdSuffix()}`,
    agent_id: input.agent_id,
    user_id: input.user_id,
    lane: input.lane,
    content: input.content,
    ...(input.gist ? { gist: input.gist } : {}),
    ...(input.trigger_terms?.length ? { trigger_terms: input.trigger_terms } : {}),
    ...(input.trigger_synonyms?.length ? { trigger_synonyms: input.trigger_synonyms } : {}),
    ...(input.linger_override !== undefined ? { linger_override: input.linger_override } : {}),
    importance: input.importance,
    event_at: eventAt,
    event_ts: eventTs,
    saved_at: iso,
    saved_ts: ts,
    ...(expiresAt ? { expires_at: expiresAt, expires_ts: expiresTs } : {}),
    is_superseded: 'n',
    ...(input.links?.length ? { links: input.links } : {}),
    ...(input.clip_ids?.length ? { clip_ids: input.clip_ids } : {}),
    provenance: input.provenance,
    visibility: 'normal',
    embedding,
    embedding_model: embedder.modelId,
    schema_version: MEMORY_SCHEMA_VERSION
  }

  await redis.json.set(memoryKey(record.agent_id, record.id), '$', record as never)
  return record
}

export async function getMemory(agentId: string, memoryId: string): Promise<MemoryRecord | null> {
  return (await redis.json.get(memoryKey(agentId, memoryId))) as MemoryRecord | null
}

export async function listMemories(agentId: string): Promise<MemoryRecord[]> {
  return redis.execute(async (client) => {
    // KEYS is blocking but fine at single-user scale — the deleteSession house pattern.
    const keys = await client.keys(memoryAgentPattern(agentId))
    const records: MemoryRecord[] = []
    for (const key of keys) {
      const record = (await client.json.get(key)) as unknown as MemoryRecord | null
      if (record) records.push(record)
    }
    records.sort((a, b) => b.saved_ts - a.saved_ts)
    return records
  })
}

export async function fetchMemoriesByKeys(keys: string[]): Promise<MemoryRecord[]> {
  if (keys.length === 0) return []
  return redis.execute(async (client) => {
    const records: MemoryRecord[] = []
    for (const key of keys) {
      const record = (await client.json.get(key)) as unknown as MemoryRecord | null
      if (record) records.push(record)
    }
    return records
  })
}

export interface UpdateMemoryInput {
  content?: string
  gist?: string | null
  lane?: MemoryLane
  trigger_terms?: string[] | null
  trigger_synonyms?: string[] | null
  linger_override?: number | 'episode' | null
  importance?: number
  event_at?: string | null
  expires_at?: string | null
  links?: string[] | null
  clip_ids?: string[] | null
}

export async function updateMemory(
  agentId: string,
  memoryId: string,
  updates: UpdateMemoryInput,
  options?: MemoryWriteOptions
): Promise<MemoryRecord> {
  const existing = await getMemory(agentId, memoryId)
  if (!existing) throw new Error(`Memory ${memoryId} not found for agent ${agentId}.`)

  if (updates.lane !== undefined) assertLane(updates.lane)
  if (updates.importance !== undefined) assertImportance(updates.importance)
  if (updates.content !== undefined && !updates.content.trim()) {
    throw new Error('Memory content cannot be updated to empty; delete the memory explicitly instead.')
  }

  const next: MemoryRecord = { ...existing }
  if (updates.content !== undefined) next.content = updates.content
  if (updates.gist !== undefined) {
    if (updates.gist === null) delete next.gist
    else next.gist = updates.gist
  }
  if (updates.lane !== undefined) next.lane = updates.lane
  if (updates.trigger_terms !== undefined) {
    if (updates.trigger_terms === null || updates.trigger_terms.length === 0) delete next.trigger_terms
    else next.trigger_terms = updates.trigger_terms
  }
  if (updates.trigger_synonyms !== undefined) {
    if (updates.trigger_synonyms === null || updates.trigger_synonyms.length === 0) {
      delete next.trigger_synonyms
    } else next.trigger_synonyms = updates.trigger_synonyms
  }
  if (updates.linger_override !== undefined) {
    if (updates.linger_override === null) delete next.linger_override
    else {
      assertLingerOverride(updates.linger_override)
      next.linger_override = updates.linger_override
    }
  }
  if (updates.importance !== undefined) next.importance = updates.importance
  if (updates.event_at !== undefined) {
    next.event_at = updates.event_at
    next.event_ts = updates.event_at ? new Date(updates.event_at).getTime() : null
    if (updates.event_at && !Number.isFinite(next.event_ts)) {
      throw new Error(`Memory event_at is not a valid timestamp: '${updates.event_at}'.`)
    }
  }
  if (updates.expires_at !== undefined) {
    if (updates.expires_at === null) {
      delete next.expires_at
      delete next.expires_ts
    } else {
      next.expires_at = updates.expires_at
      next.expires_ts = new Date(updates.expires_at).getTime()
      if (!Number.isFinite(next.expires_ts)) {
        throw new Error(`Memory expires_at is not a valid timestamp: '${updates.expires_at}'.`)
      }
    }
  }
  if (updates.links !== undefined) {
    if (updates.links === null || updates.links.length === 0) delete next.links
    else next.links = updates.links
  }
  if (updates.clip_ids !== undefined) {
    if (updates.clip_ids === null || updates.clip_ids.length === 0) delete next.clip_ids
    else next.clip_ids = updates.clip_ids
  }

  // A Trigger Memory without trigger words can never fire — refuse the dead state
  // loudly instead of storing it (2026-08-28; matches save + move_lane validation).
  if (next.lane === 'stm' && !next.trigger_terms?.length) {
    throw new Error(
      'A Trigger Memory (stm) needs at least one trigger term. Add trigger_terms, or move the memory to another lane.'
    )
  }

  if (updates.content !== undefined && updates.content !== existing.content) {
    const embedder = await resolveWriteEmbedder(options?.embedder)
    const [embedding] = await embedder.embedDocuments([next.content])
    next.embedding = embedding
    next.embedding_model = embedder.modelId
  }

  next.updated_at = nowStamps().iso
  await redis.json.set(memoryKey(agentId, memoryId), '$', next as never)
  return next
}

/** The only true delete (DL-104-02) — explicit user/agent action, never housekeeping. */
export async function deleteMemory(agentId: string, memoryId: string): Promise<boolean> {
  return redis.execute(async (client) => {
    const removed = await client.del(memoryKey(agentId, memoryId))
    return removed > 0
  })
}

// ---------------------------------------------------------------------------
// Supersession primitives (DL-104-02: invalidate with a pointer, never delete)
// ---------------------------------------------------------------------------

export async function supersedeMemory(
  agentId: string,
  newMemoryId: string,
  supersededIds: string[]
): Promise<MemoryRecord> {
  if (supersededIds.length === 0) {
    throw new Error('supersedeMemory requires at least one memory id to supersede.')
  }
  if (supersededIds.includes(newMemoryId)) {
    throw new Error('A memory cannot supersede itself.')
  }
  const successor = await getMemory(agentId, newMemoryId)
  if (!successor) throw new Error(`Memory ${newMemoryId} not found for agent ${agentId}.`)

  for (const oldId of supersededIds) {
    const old = await getMemory(agentId, oldId)
    if (!old) throw new Error(`Cannot supersede missing memory ${oldId} (agent ${agentId}).`)
    old.superseded_by = newMemoryId
    old.is_superseded = 'y'
    old.updated_at = nowStamps().iso
    await redis.json.set(memoryKey(agentId, oldId), '$', old as never)
  }

  const merged = new Set([...(successor.supersedes ?? []), ...supersededIds])
  successor.supersedes = Array.from(merged)
  successor.updated_at = nowStamps().iso
  await redis.json.set(memoryKey(agentId, newMemoryId), '$', successor as never)
  return successor
}

/** Undo for a mistaken supersession — restores the record to current status. */
export async function unsupersedeMemory(agentId: string, memoryId: string): Promise<MemoryRecord> {
  const record = await getMemory(agentId, memoryId)
  if (!record) throw new Error(`Memory ${memoryId} not found for agent ${agentId}.`)
  const supersederId = record.superseded_by
  if (!supersederId) return record

  record.superseded_by = null
  record.is_superseded = 'n'
  record.updated_at = nowStamps().iso
  await redis.json.set(memoryKey(agentId, memoryId), '$', record as never)

  const superseder = await getMemory(agentId, supersederId)
  if (superseder?.supersedes?.length) {
    superseder.supersedes = superseder.supersedes.filter((id) => id !== memoryId)
    if (superseder.supersedes.length === 0) delete superseder.supersedes
    superseder.updated_at = nowStamps().iso
    await redis.json.set(memoryKey(agentId, supersederId), '$', superseder as never)
  }
  return record
}

export interface SupersessionChain {
  /** Oldest-first chain of records this memory (transitively) superseded. */
  predecessors: MemoryRecord[]
  record: MemoryRecord
  /** The successors above this record, current-most last. */
  successors: MemoryRecord[]
}

export async function getSupersessionChain(agentId: string, memoryId: string): Promise<SupersessionChain> {
  const record = await getMemory(agentId, memoryId)
  if (!record) throw new Error(`Memory ${memoryId} not found for agent ${agentId}.`)

  const successors: MemoryRecord[] = []
  const seenUp = new Set<string>([memoryId])
  let cursor = record
  while (cursor.superseded_by && !seenUp.has(cursor.superseded_by)) {
    seenUp.add(cursor.superseded_by)
    const next = await getMemory(agentId, cursor.superseded_by)
    if (!next) break
    successors.push(next)
    cursor = next
  }

  const predecessors: MemoryRecord[] = []
  const seenDown = new Set<string>([memoryId])
  const queue = [...(record.supersedes ?? [])]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seenDown.has(id)) continue
    seenDown.add(id)
    const predecessor = await getMemory(agentId, id)
    if (!predecessor) continue
    predecessors.push(predecessor)
    queue.push(...(predecessor.supersedes ?? []))
  }
  predecessors.sort((a, b) => a.saved_ts - b.saved_ts)

  return { predecessors, record, successors }
}

/**
 * Recall-refresh (DL-104-09): bump last-recalled stamps + count when a memory is actually
 * delivered toward context (the recall op / P4 insert lanes) — never on mere search hits.
 */
export async function touchMemoryRecall(agentId: string, memoryId: string): Promise<MemoryRecord> {
  const record = await getMemory(agentId, memoryId)
  if (!record) throw new Error(`Memory ${memoryId} not found for agent ${agentId}.`)
  const { iso, ts } = nowStamps()
  record.last_recalled_at = iso
  record.last_recalled_ts = ts
  record.recall_count = (record.recall_count ?? 0) + 1
  await redis.json.set(memoryKey(agentId, memoryId), '$', record as never)
  return record
}

/** Expiry demotes (records the demotion and moves the lane) — never erases (DL-104-02). */
export async function markExpiredDemotion(
  agentId: string,
  memoryId: string,
  demotedTo: MemoryLane
): Promise<MemoryRecord> {
  assertLane(demotedTo)
  const record = await getMemory(agentId, memoryId)
  if (!record) throw new Error(`Memory ${memoryId} not found for agent ${agentId}.`)
  if (!record.expires_ts) {
    throw new Error(`Memory ${memoryId} has no expiry; demotion is an expiry-processing act.`)
  }
  record.expired_demoted_to = demotedTo
  record.lane = demotedTo
  record.updated_at = nowStamps().iso
  await redis.json.set(memoryKey(agentId, memoryId), '$', record as never)
  return record
}

// ---------------------------------------------------------------------------
// Graduated segments
// ---------------------------------------------------------------------------

export interface CreateMemorySegmentInput {
  agent_id: string
  user_id: string
  session_id: string
  episode_id?: string | null
  message_ids: string[]
  summary: string
  topics?: string[]
  first_message_at: string
  last_message_at: string
  token_count: number
  graduated_by: GraduationSource
}

export async function createMemorySegment(
  input: CreateMemorySegmentInput,
  options?: MemoryWriteOptions
): Promise<MemorySegmentRecord> {
  if (!input.agent_id?.trim()) throw new Error('Memory segments require agent_id.')
  if (!input.session_id?.trim()) {
    throw new Error('Memory segments require session provenance (DL-104-16).')
  }
  if (!input.summary?.trim()) throw new Error('Memory segments require a non-empty summary.')
  if (!Array.isArray(input.message_ids) || input.message_ids.length === 0) {
    throw new Error('Memory segments require the graduated message ids.')
  }

  const firstTs = new Date(input.first_message_at).getTime()
  const lastTs = new Date(input.last_message_at).getTime()
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs)) {
    throw new Error('Memory segments require valid first/last message timestamps.')
  }

  const embedder = await resolveWriteEmbedder(options?.embedder)
  const [embedding] = await embedder.embedDocuments([input.summary])
  const { iso, ts } = nowStamps()

  const record: MemorySegmentRecord = {
    id: `memseg_${ts}_${randomIdSuffix()}`,
    agent_id: input.agent_id,
    user_id: input.user_id,
    session_id: input.session_id,
    episode_id: input.episode_id ?? null,
    message_ids: input.message_ids,
    summary: input.summary,
    ...(input.topics?.length ? { topics: input.topics } : {}),
    first_message_at: input.first_message_at,
    first_message_ts: firstTs,
    last_message_at: input.last_message_at,
    last_message_ts: lastTs,
    token_count: input.token_count,
    graduated_at: iso,
    graduated_by: input.graduated_by,
    embedding,
    embedding_model: embedder.modelId,
    schema_version: MEMORY_SCHEMA_VERSION
  }

  await redis.json.set(memorySegmentKey(record.agent_id, record.id), '$', record as never)
  return record
}

export async function getMemorySegment(
  agentId: string,
  segmentId: string
): Promise<MemorySegmentRecord | null> {
  return (await redis.json.get(memorySegmentKey(agentId, segmentId))) as MemorySegmentRecord | null
}

export async function listMemorySegments(agentId: string): Promise<MemorySegmentRecord[]> {
  return redis.execute(async (client) => {
    const keys = await client.keys(memorySegmentAgentPattern(agentId))
    const records: MemorySegmentRecord[] = []
    for (const key of keys) {
      const record = (await client.json.get(key)) as unknown as MemorySegmentRecord | null
      if (record) records.push(record)
    }
    records.sort((a, b) => b.last_message_ts - a.last_message_ts)
    return records
  })
}

export async function fetchMemorySegmentsByIds(
  agentId: string,
  segmentIds: string[]
): Promise<MemorySegmentRecord[]> {
  if (segmentIds.length === 0) return []
  return redis.execute(async (client) => {
    const records: MemorySegmentRecord[] = []
    for (const segmentId of segmentIds) {
      const record = (await client.json.get(
        memorySegmentKey(agentId, segmentId)
      )) as unknown as MemorySegmentRecord | null
      if (record) records.push(record)
    }
    return records
  })
}

/** SA-104 P6 — recall-refresh for recalled segments (delivery-time, never search-time). */
export async function touchMemorySegmentRecall(
  agentId: string,
  segmentId: string
): Promise<MemorySegmentRecord> {
  const record = await getMemorySegment(agentId, segmentId)
  if (!record) throw new Error(`Memory segment ${segmentId} not found for agent ${agentId}.`)
  const { iso, ts } = nowStamps()
  record.last_recalled_at = iso
  record.last_recalled_ts = ts
  record.recall_count = (record.recall_count ?? 0) + 1
  await redis.json.set(memorySegmentKey(agentId, segmentId), '$', record as never)
  return record
}

/** Explicit delete only (DL-104-02); graduation never removes segments. */
export async function deleteMemorySegment(agentId: string, segmentId: string): Promise<boolean> {
  return redis.execute(async (client) => {
    const removed = await client.del(memorySegmentKey(agentId, segmentId))
    return removed > 0
  })
}
