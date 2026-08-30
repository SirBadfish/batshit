/**
 * SA-104 memory-system record shapes (preflight §6, locked in P2).
 *
 * Lane vocabulary is the DL-104-03 official taxonomy and is used verbatim in schema,
 * tools, prompts, UI, and docs: awareness / stm / ltm.
 */

export const MEMORY_SCHEMA_VERSION = 1 as const

export type MemoryLane = 'awareness' | 'stm' | 'ltm'

export const MEMORY_LANES: readonly MemoryLane[] = ['awareness', 'stm', 'ltm']

export type MemorySupersededFlag = 'n' | 'y'

export interface MemoryProvenanceEntry {
  session_id: string
  message_id?: string
  quote?: string
  source: 'agent' | 'user' | 'dreaming'
  /** Set lazily when the source session no longer exists; recall says "original unavailable". */
  source_deleted?: boolean
}

export interface MemoryRecord {
  id: string
  agent_id: string
  user_id: string
  lane: MemoryLane
  content: string
  /** Compact one-line gist for summary-first search hits (DL-104-17). */
  gist?: string
  /** STM exact trigger terms. */
  trigger_terms?: string[]
  /** STM configured synonyms. */
  trigger_synonyms?: string[]
  /**
   * Per-memory linger override (2026-08-28, Lucy's idea): turns this memory keeps
   * re-inserting after its last relevance, or 'episode' to hold until the current
   * episode / conversation stretch ends. Absent = the agent's per-source default.
   */
  linger_override?: number | 'episode'
  /** 1-10; drives placement and ranking (DL-104-03 / DL-104-09). */
  importance: number
  /** When the fact was true (dual timestamps, DL-104-08). Epoch-ms mirror feeds FT NUMERIC. */
  event_at: string | null
  event_ts: number | null
  saved_at: string
  saved_ts: number
  updated_at?: string
  expires_at?: string | null
  expires_ts?: number | null
  /** Expiry demotes, never erases (DL-104-02). */
  expired_demoted_to?: MemoryLane | null
  /** Ids this memory replaced. */
  supersedes?: string[]
  superseded_by?: string | null
  /** TAG-indexable mirror of superseded_by (demoted + flagged in recall, DL-104-09). */
  is_superseded: MemorySupersededFlag
  /** [[links]] to other memory ids — 1-hop expansion in recall. */
  links?: string[]
  /** Clip ids for media-carrying memories. */
  clip_ids?: string[]
  provenance: MemoryProvenanceEntry[]
  /** Reserved for the deferred Private Reflections feature. */
  visibility: 'normal'
  /** Reserved for the deferred aging/gist tier. */
  aging?: { state: 'dense' | 'gist'; gisted_at?: string }
  last_recalled_at?: string | null
  last_recalled_ts?: number | null
  recall_count?: number
  /** FLOAT32 semantics; always regenerable from content (DL-104-10). */
  embedding: number[]
  embedding_model: string
  schema_version: typeof MEMORY_SCHEMA_VERSION
}

export type GraduationSource = 'nap' | 'dreaming' | 'session_close' | 'idle'

export interface MemorySegmentRecord {
  id: string
  agent_id: string
  user_id: string
  /** Mandatory session provenance (DL-104-16). */
  session_id: string
  episode_id?: string | null
  /** Originals stay untouched in their existing message keys (DL-104-02). */
  message_ids: string[]
  summary: string
  topics?: string[]
  first_message_at: string
  first_message_ts: number
  last_message_at: string
  last_message_ts: number
  token_count: number
  graduated_at: string
  graduated_by: GraduationSource
  source_deleted?: boolean
  /** SA-104 P6: recall-refresh stamps for recalled segments (additive, optional). */
  last_recalled_at?: string | null
  last_recalled_ts?: number | null
  recall_count?: number
  embedding: number[]
  embedding_model: string
  schema_version: typeof MEMORY_SCHEMA_VERSION
}

/** Instance-level memory configuration (`batshit:memory_config`). */
export interface MemoryConfigRecord {
  embedding: MemoryEmbeddingConfig
  schema_version: typeof MEMORY_SCHEMA_VERSION
}

export type MemoryEmbedderLane = 'builtin' | 'preset' | 'local-ai' | 'api'

export interface MemoryEmbeddingConfig {
  lane: MemoryEmbedderLane
  /** Canonical model id, e.g. 'builtin:embeddinggemma-300m'. */
  modelId: string
  /**
   * preset lane (2026-08-26; the user-facing non-builtin path): a saved Model
   * Manager preset supplies provider + model + connection; embedding-specific
   * settings stay here. `provider`/`modelName` are a SNAPSHOT of the preset at
   * save time so the canonical id stays stable — embed-time resolution re-reads
   * the live preset and fails loudly when it was deleted or repointed.
   */
  preset?: {
    presetId: string
    provider: string
    modelName: string
    dims: number
    documentPrefix?: string
    queryPrefix?: string
  }
  /** legacy local-ai lane (pre-preset raw fields; still executable, hidden from new UI). */
  localAi?: {
    baseUrl: string
    modelName: string
    apiKey?: string
    documentPrefix?: string
    queryPrefix?: string
    dims: number
  }
  /** legacy api lane (pre-preset raw fields; still executable, hidden from new UI). */
  api?: {
    provider: string
    modelName: string
    dims: number
  }
}

/** Instance-level derived index metadata (`batshit:memory_index_meta`). */
export interface MemoryIndexMetaRecord {
  embedding_model: string
  dims: number
  index_schema_version: number
  last_rebuilt_at: string
  schema_version: typeof MEMORY_SCHEMA_VERSION
}

/** Bump when the FT schema shape changes; drives explicit re-create on bootstrap. */
export const MEMORY_INDEX_SCHEMA_VERSION = 1
