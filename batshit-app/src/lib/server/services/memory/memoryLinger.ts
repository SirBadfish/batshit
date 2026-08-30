/**
 * SA-104 — session-scoped recall/linger state (`memlinger:{sessionId}`, DL-104-17).
 *
 * P3 owns the pending-recall queue: `sys.memory.recall` appends memory ids here and the
 * recall engine consumes them into the single DCM memory-insert channel. P4 extended the
 * same record with linger tracking: entries the engine inserted recently and keeps
 * re-inserting for a configurable number of turns after their last relevance. The
 * cleanup/backup obligations landed with the key in P3 (DL-104-13).
 *
 * Compile-time reads never mutate this record. The only writer besides
 * `queuePendingMemoryRecalls` is `commitMemoryTurnState` (memoryRecall.ts), which runs
 * at the accepted-send boundary — the same place session clips consume.
 */

import { redis } from '$lib/server/redis'
import { memoryLingerKey } from './memoryKeys'
import { MEMORY_SCHEMA_VERSION } from './memoryTypes'

/** SA-104 P6: recall covers memories AND graduated segments (absent = memory). */
export type MemoryRecallKind = 'memory' | 'segment'

export interface PendingMemoryRecall {
  memory_id: string
  agent_id: string
  requested_at: string
  source: 'tool'
  kind?: MemoryRecallKind
}

export type MemoryLingerSource = 'trigger' | 'recall'

export interface MemoryLingerEntry {
  memory_id: string
  agent_id: string
  /** Which lane brought the memory into context (labels the DCM line). */
  source: MemoryLingerSource
  first_inserted_at: string
  /** Last turn the memory was newly relevant (inserted or refreshed). */
  last_relevant_at: string
  /** Accepted-send turns the entry keeps re-inserting; drops out at 0. */
  turns_remaining: number
  kind?: MemoryRecallKind
  /**
   * 2026-08-28 per-memory linger override: 'episode' entries never count down.
   * They drop when their episode ends — in a fixed (Infinite) session when
   * `episode_id` no longer matches the open episode, in a regular session when the
   * conversation idles past the agent's idle gap (tracked via `last_commit_ts`).
   */
  hold?: 'episode'
  /** Open episode id at creation ('episode' holds in Infinite Sessions; else absent). */
  episode_id?: string | null
}

export interface MemoryLingerRecord {
  pending: PendingMemoryRecall[]
  lingering?: MemoryLingerEntry[]
  /** Stamped at every accepted-send commit — the per-session conversation clock. */
  last_commit_at?: string
  last_commit_ts?: number
  schema_version: typeof MEMORY_SCHEMA_VERSION
}

const MAX_PENDING_RECALLS = 24

export async function getMemoryLingerState(sessionId: string): Promise<MemoryLingerRecord | null> {
  return (await redis.json.get(memoryLingerKey(sessionId))) as MemoryLingerRecord | null
}

export async function setMemoryLingerState(
  sessionId: string,
  record: MemoryLingerRecord
): Promise<void> {
  await redis.json.set(memoryLingerKey(sessionId), '$', record as never)
}

/** Queue memories/segments for DCM insertion. Re-recalling a pending id refreshes it. */
export async function queuePendingMemoryRecalls(
  sessionId: string,
  agentId: string,
  entries: Array<{ id: string; kind: MemoryRecallKind }>
): Promise<MemoryLingerRecord> {
  const existing = await getMemoryLingerState(sessionId)
  const requestedAt = new Date().toISOString()
  const requestedIds = entries.map((entry) => entry.id)
  const pending = (existing?.pending ?? []).filter(
    (entry) => !(entry.agent_id === agentId && requestedIds.includes(entry.memory_id))
  )
  for (const entry of entries) {
    pending.push({
      memory_id: entry.id,
      agent_id: agentId,
      requested_at: requestedAt,
      source: 'tool',
      ...(entry.kind === 'segment' ? { kind: 'segment' as const } : {})
    })
  }
  const record: MemoryLingerRecord = {
    pending: pending.slice(-MAX_PENDING_RECALLS),
    ...(existing?.lingering?.length ? { lingering: existing.lingering } : {}),
    ...(existing?.last_commit_at ? { last_commit_at: existing.last_commit_at } : {}),
    ...(typeof existing?.last_commit_ts === 'number' ? { last_commit_ts: existing.last_commit_ts } : {}),
    schema_version: MEMORY_SCHEMA_VERSION
  }
  await setMemoryLingerState(sessionId, record)
  return record
}
