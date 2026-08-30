/**
 * SA-104 memory-system key namespace — the single source of truth for every Redis key
 * pattern and Search index name the memory system owns.
 *
 * Lifecycle obligations (DL-104-13): `memory:` / `memseg:` / `memdream*` keys are
 * agent-scoped and must be enumerated by `redis.deleteAgent`; `episode:` /
 * `session:{id}:episodes` / `memlinger:` keys are session-scoped and must be enumerated
 * by `redis.deleteSession`; every pattern here must be mapped in the Backup/Restore
 * `memory` group. Adding a key builder to this file without updating those surfaces in
 * the same packet is a defect.
 */

export const MEMORY_KEY_PREFIX = 'memory:'
export const MEMORY_SEGMENT_KEY_PREFIX = 'memseg:'
export const MEMORY_LINGER_KEY_PREFIX = 'memlinger:'
export const MEMORY_DREAM_RUN_KEY_PREFIX = 'memdream:'
export const MEMORY_DREAM_INDEX_KEY_PREFIX = 'memdream_index:'
export const MEMORY_CONFIG_KEY = 'batshit:memory_config'
export const MEMORY_INDEX_META_KEY = 'batshit:memory_index_meta'

export function memoryKey(agentId: string, memoryId: string): string {
  return `${MEMORY_KEY_PREFIX}${agentId}:${memoryId}`
}

export function memoryAgentPattern(agentId: string): string {
  return `${MEMORY_KEY_PREFIX}${agentId}:*`
}

export function memorySegmentKey(agentId: string, segmentId: string): string {
  return `${MEMORY_SEGMENT_KEY_PREFIX}${agentId}:${segmentId}`
}

export function memorySegmentAgentPattern(agentId: string): string {
  return `${MEMORY_SEGMENT_KEY_PREFIX}${agentId}:*`
}

/**
 * Session-scoped recall/linger state (DL-104-17). P3 writes the pending-recall queue
 * here; P4's DCM builder consumes it and extends the same key with linger tracking.
 * Cleanup: `deleteSession`. Backup: `memory` group (restore-empty acceptable).
 */
export function memoryLingerKey(sessionId: string): string {
  return `${MEMORY_LINGER_KEY_PREFIX}${sessionId}`
}

/**
 * SA-104 P7 — the visible dreaming log (DL-104-02 honesty / DL-104-15). One JSON run
 * record per pass plus a capped per-agent LIST of run ids, newest first; rotation
 * deletes rotated run records (bounded operational telemetry, not memory content).
 * Cleanup: `deleteAgent`. Backup: `memory` group.
 */
export function memoryDreamRunKey(agentId: string, runId: string): string {
  return `${MEMORY_DREAM_RUN_KEY_PREFIX}${agentId}:${runId}`
}

export function memoryDreamRunAgentPattern(agentId: string): string {
  return `${MEMORY_DREAM_RUN_KEY_PREFIX}${agentId}:*`
}

export function memoryDreamIndexKey(agentId: string): string {
  return `${MEMORY_DREAM_INDEX_KEY_PREFIX}${agentId}`
}

/**
 * Search index names. BATSHIT_MEMORY_INDEX_SUFFIX exists for the dedicated memory-search
 * test harness only (run-unique index names on the disposable instance, per
 * testing-architecture.md §3); production never sets it.
 */
function indexSuffix(): string {
  const raw = process.env.BATSHIT_MEMORY_INDEX_SUFFIX
  return typeof raw === 'string' && raw.trim().length > 0 ? `_${raw.trim()}` : ''
}

export function memoryIndexName(): string {
  return `batshit_memory_idx${indexSuffix()}`
}

export function memorySegmentIndexName(): string {
  return `batshit_memseg_idx${indexSuffix()}`
}
