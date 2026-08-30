/**
 * SA-104 memory Search indexes (preflight §7; DL-104-09 / DL-104-10 / DL-104-14).
 *
 * Two FT indexes over the JSON records on runtime db 0:
 *  - batshit_memory_idx  over `memory:`  (memories)
 *  - batshit_memseg_idx  over `memseg:`  (graduated segments)
 *
 * The indexes are a derived cache: always regenerable from the stored records, never
 * backed up. Bootstrap is idempotent and self-heals a missing index when the stored
 * meta record still matches the configured embedding model; an embedding-model change
 * requires the explicit re-index path — never a silent mixed-dimension write.
 *
 * Raw FT commands ride `client.sendCommand` (the executionViewerService precedent):
 * the exact command shapes were proven live in P0 §4 against the pinned Redis 8.10.1.
 */

import { redis } from '$lib/server/redis'
import type { RedisClientType } from 'redis'
import {
  MEMORY_CONFIG_KEY,
  MEMORY_INDEX_META_KEY,
  MEMORY_KEY_PREFIX,
  MEMORY_SEGMENT_KEY_PREFIX,
  memoryIndexName,
  memorySegmentIndexName
} from './memoryKeys'
import {
  MEMORY_INDEX_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
  type MemoryConfigRecord,
  type MemoryEmbeddingConfig,
  type MemoryIndexMetaRecord
} from './memoryTypes'
import {
  canonicalEmbeddingModelId,
  createMemoryEmbedder,
  DEFAULT_MEMORY_EMBEDDING_CONFIG
} from './memoryEmbedder'

type RawReply = unknown

function float32Blob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

/** Escape a value for use inside a TAG query `{...}` clause. */
export function escapeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, (char) => `\\${char}`)
}

/**
 * Neutralize RediSearch query syntax in free text. Query *semantics* (AND/OR shaping,
 * fuzziness) belong to the recall engine (P4); this only makes raw text safe.
 */
export function sanitizeTextQuery(text: string): string {
  return text
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
    .join(' ')
}

// ---------------------------------------------------------------------------
// Config + meta records
// ---------------------------------------------------------------------------

export async function getMemoryConfig(): Promise<MemoryConfigRecord> {
  const stored = (await redis.json.get(MEMORY_CONFIG_KEY)) as MemoryConfigRecord | null
  if (stored?.embedding?.lane && stored.embedding.modelId) {
    return stored
  }
  return { embedding: DEFAULT_MEMORY_EMBEDDING_CONFIG, schema_version: MEMORY_SCHEMA_VERSION }
}

export async function setMemoryConfig(embedding: MemoryEmbeddingConfig): Promise<MemoryConfigRecord> {
  // Validates lane requirements (and known builtin ids) before anything is stored.
  canonicalEmbeddingModelId(embedding.lane === 'builtin' ? embedding : embedding)
  const record: MemoryConfigRecord = { embedding, schema_version: MEMORY_SCHEMA_VERSION }
  await redis.json.set(MEMORY_CONFIG_KEY, '$', record as never)
  return record
}

export async function getMemoryIndexMeta(): Promise<MemoryIndexMetaRecord | null> {
  return (await redis.json.get(MEMORY_INDEX_META_KEY)) as MemoryIndexMetaRecord | null
}

async function writeMemoryIndexMeta(embeddingModel: string, dims: number): Promise<MemoryIndexMetaRecord> {
  const meta: MemoryIndexMetaRecord = {
    embedding_model: embeddingModel,
    dims,
    index_schema_version: MEMORY_INDEX_SCHEMA_VERSION,
    last_rebuilt_at: new Date().toISOString(),
    schema_version: MEMORY_SCHEMA_VERSION
  }
  await redis.json.set(MEMORY_INDEX_META_KEY, '$', meta as never)
  return meta
}

export function resolveConfiguredDims(config: MemoryEmbeddingConfig): number {
  if (config.lane === 'builtin') {
    return createMemoryEmbedder(config).dims
  }
  if (config.lane === 'local-ai') {
    if (!config.localAi?.dims) {
      throw new Error("Memory embedding lane 'local-ai' requires localAi.dims.")
    }
    return config.localAi.dims
  }
  if (!config.api?.dims) {
    throw new Error("Memory embedding lane 'api' requires api.dims.")
  }
  return config.api.dims
}

// ---------------------------------------------------------------------------
// Index creation / existence
// ---------------------------------------------------------------------------

async function indexExists(client: RedisClientType, indexName: string): Promise<boolean> {
  try {
    await client.sendCommand(['FT.INFO', indexName])
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Redis 8.10 says "SEARCH_INDEX_NOT_FOUND Index not found: <name>"; older builds said
    // "Unknown index name" / "no such index".
    if (/unknown index|no such index|index not found|SEARCH_INDEX_NOT_FOUND/i.test(message)) {
      return false
    }
    throw error
  }
}

function readInfoField(reply: unknown, field: string): unknown {
  const rows = reply as unknown[]
  if (!Array.isArray(rows)) return undefined
  for (let index = 0; index + 1 < rows.length; index += 2) {
    if (String(rows[index]) === field) return rows[index + 1]
  }
  return undefined
}

/**
 * Waits for background indexing of existing records and fails loudly when any record
 * could not be indexed (the classic cause: stored vectors whose dimension no longer
 * matches the index). Per-record indexing failures are exactly the "silent no-recall"
 * degradation DL-104-10 prohibits, so they are promoted to a hard error here.
 */
async function assertIndexHealthy(client: RedisClientType, indexName: string): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const info = await client.sendCommand(['FT.INFO', indexName])
    const stillIndexing = Number(readInfoField(info, 'indexing') ?? 0) === 1
    if (!stillIndexing) {
      const failures = Number(readInfoField(info, 'hash_indexing_failures') ?? 0)
      if (failures > 0) {
        throw new Error(
          `Memory index '${indexName}' failed to index ${failures} stored record(s) — usually stored embeddings ` +
            'whose dimensions do not match the configured model. Run the explicit memory re-index with re-embedding.'
        )
      }
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`Memory index '${indexName}' is still indexing after 15s; refusing to report it healthy.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function createMemoryIndex(client: RedisClientType, dims: number): Promise<void> {
  await client.sendCommand([
    'FT.CREATE', memoryIndexName(), 'ON', 'JSON', 'PREFIX', '1', MEMORY_KEY_PREFIX, 'SCHEMA',
    '$.agent_id', 'AS', 'agent', 'TAG',
    '$.lane', 'AS', 'lane', 'TAG',
    '$.is_superseded', 'AS', 'superseded', 'TAG',
    '$.content', 'AS', 'content', 'TEXT',
    '$.gist', 'AS', 'gist', 'TEXT',
    // JSON array attributes index one TAG per element via the [*] path (the hash-only
    // SEPARATOR form from the planning sketch is invalid on JSON indexes).
    '$.trigger_terms[*]', 'AS', 'trigger_terms', 'TAG',
    '$.importance', 'AS', 'importance', 'NUMERIC', 'SORTABLE',
    '$.event_ts', 'AS', 'event_ts', 'NUMERIC', 'SORTABLE',
    '$.saved_ts', 'AS', 'saved_ts', 'NUMERIC', 'SORTABLE',
    '$.last_recalled_ts', 'AS', 'recalled_ts', 'NUMERIC', 'SORTABLE',
    '$.embedding', 'AS', 'embedding', 'VECTOR', 'HNSW', '6',
    'TYPE', 'FLOAT32', 'DIM', String(dims), 'DISTANCE_METRIC', 'COSINE'
  ])
}

async function createMemorySegmentIndex(client: RedisClientType, dims: number): Promise<void> {
  await client.sendCommand([
    'FT.CREATE', memorySegmentIndexName(), 'ON', 'JSON', 'PREFIX', '1', MEMORY_SEGMENT_KEY_PREFIX, 'SCHEMA',
    '$.agent_id', 'AS', 'agent', 'TAG',
    '$.session_id', 'AS', 'session', 'TAG',
    '$.episode_id', 'AS', 'episode', 'TAG',
    '$.summary', 'AS', 'summary', 'TEXT',
    '$.topics[*]', 'AS', 'topics', 'TAG',
    '$.first_message_ts', 'AS', 'first_ts', 'NUMERIC', 'SORTABLE',
    '$.last_message_ts', 'AS', 'last_ts', 'NUMERIC', 'SORTABLE',
    '$.embedding', 'AS', 'embedding', 'VECTOR', 'HNSW', '6',
    'TYPE', 'FLOAT32', 'DIM', String(dims), 'DISTANCE_METRIC', 'COSINE'
  ])
}

export interface MemoryIndexBootstrapResult {
  status: 'ready' | 'created' | 'recreated'
  embeddingModel: string
  dims: number
}

/**
 * Idempotent boot-time bootstrap.
 *
 * - Fresh instance (no meta, no indexes): create both indexes for the configured
 *   embedding model and write the meta record.
 * - Meta matches config but an index is missing (post-restore, or index loss): recreate
 *   it — FT.CREATE re-indexes the existing JSON records automatically.
 * - Meta disagrees with config: FAIL LOUDLY and name the explicit re-index path.
 *   Nothing silently degrades to no-recall and nothing writes mixed dimensions.
 */
export async function ensureMemoryIndexes(): Promise<MemoryIndexBootstrapResult> {
  const config = (await getMemoryConfig()).embedding
  const embeddingModel = canonicalEmbeddingModelId(config)
  const dims = resolveConfiguredDims(config)
  const meta = await getMemoryIndexMeta()

  if (meta && (meta.embedding_model !== embeddingModel || meta.dims !== dims)) {
    throw new Error(
      `Memory embedding configuration (${embeddingModel}, ${dims}d) does not match the built index ` +
        `(${meta.embedding_model}, ${meta.dims}d). Run the explicit memory re-index (rebuildMemoryIndexes with reembed) ` +
        'to re-embed stored memories before using the new model.'
    )
  }

  return redis.execute(async (client) => {
    const [memoryExists, segmentExists] = await Promise.all([
      indexExists(client, memoryIndexName()),
      indexExists(client, memorySegmentIndexName())
    ])

    if (meta && memoryExists && segmentExists) {
      return { status: 'ready', embeddingModel, dims }
    }

    // Without a meta record an existing index is unverifiable drift (e.g. a restore of a
    // backup that predates the memory system over an instance that had indexes). Indexes
    // are a derived cache, so the safe move is drop + recreate from the stored records.
    if (!meta && memoryExists) await client.sendCommand(['FT.DROPINDEX', memoryIndexName()])
    if (!meta && segmentExists) await client.sendCommand(['FT.DROPINDEX', memorySegmentIndexName()])

    if (!meta || !memoryExists) await createMemoryIndex(client, dims)
    if (!meta || !segmentExists) await createMemorySegmentIndex(client, dims)
    await writeMemoryIndexMeta(embeddingModel, dims)
    await assertIndexHealthy(client, memoryIndexName())
    await assertIndexHealthy(client, memorySegmentIndexName())
    return { status: meta ? 'recreated' : 'created', embeddingModel, dims }
  })
}

/**
 * Post-restore reconciliation: a destructive restore replaces the memory records, the
 * config, and the meta record, but Search indexes are not Redis keys and survive with
 * whatever shape the pre-restore instance used. Drop and recreate them from the restored
 * configuration so records, config, and indexes agree again.
 */
export async function reconcileMemoryIndexesAfterRestore(): Promise<RebuildMemoryIndexesResult> {
  return rebuildMemoryIndexes({ reembed: false })
}

/** Loud runtime guard for every search/write path (DL-104-10: no silent no-recall). */
export async function requireReadyMemoryIndexes(): Promise<MemoryIndexMetaRecord> {
  const meta = await getMemoryIndexMeta()
  if (!meta) {
    throw new Error(
      'Memory indexes are not bootstrapped on this instance. Startup runs ensureMemoryIndexes(); ' +
        'check the app logs for the bootstrap failure instead of retrying blindly.'
    )
  }
  const config = (await getMemoryConfig()).embedding
  const embeddingModel = canonicalEmbeddingModelId(config)
  if (meta.embedding_model !== embeddingModel) {
    throw new Error(
      `Memory embedding model changed (${meta.embedding_model} -> ${embeddingModel}) without a re-index. ` +
        'Run the explicit memory re-index path first.'
    )
  }
  return meta
}

// ---------------------------------------------------------------------------
// Queries (raw candidates + scores; blended ranking happens in the recall engine, P4)
// ---------------------------------------------------------------------------

export interface MemorySearchFilters {
  lane?: string
  /** 'n' | 'y'; omit for both. */
  superseded?: string
  eventTsMin?: number
  eventTsMax?: number
  savedTsMin?: number
  savedTsMax?: number
}

export interface MemorySearchHit {
  key: string
  /** KNN: cosine distance (lower is closer). Text: BM25 score (higher is better). Hybrid: fused score. */
  score: number
}

function buildFilterClauses(filters: MemorySearchFilters | undefined): string {
  if (!filters) return ''
  const clauses: string[] = []
  if (filters.lane) clauses.push(`@lane:{${escapeTagValue(filters.lane)}}`)
  if (filters.superseded) clauses.push(`@superseded:{${escapeTagValue(filters.superseded)}}`)
  if (filters.eventTsMin !== undefined || filters.eventTsMax !== undefined) {
    clauses.push(`@event_ts:[${filters.eventTsMin ?? '-inf'} ${filters.eventTsMax ?? '+inf'}]`)
  }
  if (filters.savedTsMin !== undefined || filters.savedTsMax !== undefined) {
    clauses.push(`@saved_ts:[${filters.savedTsMin ?? '-inf'} ${filters.savedTsMax ?? '+inf'}]`)
  }
  return clauses.length > 0 ? ` ${clauses.join(' ')}` : ''
}

function parseSearchReplyWithField(reply: RawReply, fieldName: string): MemorySearchHit[] {
  const rows = reply as unknown[]
  if (!Array.isArray(rows) || rows.length === 0) return []
  const hits: MemorySearchHit[] = []
  for (let index = 1; index < rows.length; index += 2) {
    const key = String(rows[index])
    const fields = rows[index + 1] as unknown[]
    let score = Number.NaN
    if (Array.isArray(fields)) {
      for (let f = 0; f + 1 < fields.length; f += 2) {
        if (String(fields[f]) === fieldName) score = Number(fields[f + 1])
      }
    }
    hits.push({ key, score })
  }
  return hits
}

function parseSearchReplyWithScores(reply: RawReply): MemorySearchHit[] {
  const rows = reply as unknown[]
  if (!Array.isArray(rows) || rows.length === 0) return []
  const hits: MemorySearchHit[] = []
  for (let index = 1; index + 1 < rows.length; index += 2) {
    hits.push({ key: String(rows[index]), score: Number(rows[index + 1]) })
  }
  return hits
}

export async function knnSearchMemories(options: {
  agentId: string
  vector: number[]
  k: number
  filters?: MemorySearchFilters
}): Promise<MemorySearchHit[]> {
  const meta = await requireReadyMemoryIndexes()
  if (options.vector.length !== meta.dims) {
    throw new Error(
      `Memory query vector has ${options.vector.length} dims but the index expects ${meta.dims}.`
    )
  }
  const prefilter = `@agent:{${escapeTagValue(options.agentId)}}${buildFilterClauses(options.filters)}`
  const query = `(${prefilter})=>[KNN ${options.k} @embedding $qvec AS knn_dist]`
  return redis.execute(async (client) => {
    const reply = await client.sendCommand([
      'FT.SEARCH', memoryIndexName(), query,
      'PARAMS', '2', 'qvec', float32Blob(options.vector),
      'SORTBY', 'knn_dist', 'ASC',
      'RETURN', '1', 'knn_dist',
      'LIMIT', '0', String(options.k),
      'DIALECT', '2'
    ])
    return parseSearchReplyWithField(reply, 'knn_dist')
  })
}

export async function textSearchMemories(options: {
  agentId: string
  query: string
  limit: number
  filters?: MemorySearchFilters
}): Promise<MemorySearchHit[]> {
  await requireReadyMemoryIndexes()
  const text = sanitizeTextQuery(options.query)
  if (!text) return []
  const query = `@agent:{${escapeTagValue(options.agentId)}}${buildFilterClauses(options.filters)} (@content:(${text}) | @gist:(${text}))`
  return redis.execute(async (client) => {
    const reply = await client.sendCommand([
      'FT.SEARCH', memoryIndexName(), query,
      'WITHSCORES', 'RETURN', '0',
      'LIMIT', '0', String(options.limit),
      'DIALECT', '2'
    ])
    return parseSearchReplyWithScores(reply)
  })
}

/**
 * FT.HYBRID lexical+vector fusion (proven live in P0 §4; the vector must ride a named
 * `$param`, inline blobs are a syntax error). Reply-shape parsing is deliberately
 * tolerant and is pinned by the real-instance memory test lane.
 */
export async function hybridSearchMemories(options: {
  agentId: string
  query: string
  vector: number[]
  limit: number
  filters?: MemorySearchFilters
}): Promise<MemorySearchHit[]> {
  const meta = await requireReadyMemoryIndexes()
  if (options.vector.length !== meta.dims) {
    throw new Error(
      `Memory query vector has ${options.vector.length} dims but the index expects ${meta.dims}.`
    )
  }
  const text = sanitizeTextQuery(options.query)
  const prefilter = `@agent:{${escapeTagValue(options.agentId)}}${buildFilterClauses(options.filters)}`
  const lexical = text ? `${prefilter} (@content:(${text}) | @gist:(${text}))` : prefilter
  return redis.execute(async (client) => {
    const reply = await client.sendCommand([
      'FT.HYBRID', memoryIndexName(),
      'SEARCH', lexical,
      'VSIM', '@embedding', '$qvec', 'FILTER', prefilter,
      'LIMIT', '0', String(options.limit),
      'PARAMS', '2', 'qvec', float32Blob(options.vector)
    ])
    return parseHybridReply(reply)
  })
}

function parseHybridReply(reply: RawReply): MemorySearchHit[] {
  // RESP2 FT.HYBRID replies arrive as a map-style array: [ 'total_results', N,
  // 'results', [ [ '__key', <key>, '__score', <score>, ... ], ... ], ... ].
  const rows = reply as unknown[]
  if (!Array.isArray(rows)) return []
  let results: unknown[] | null = null
  for (let index = 0; index + 1 < rows.length; index += 2) {
    if (String(rows[index]) === 'results' && Array.isArray(rows[index + 1])) {
      results = rows[index + 1] as unknown[]
    }
  }
  if (!results) return []
  const hits: MemorySearchHit[] = []
  for (const entry of results) {
    if (!Array.isArray(entry)) continue
    let key: string | null = null
    let score = Number.NaN
    for (let f = 0; f + 1 < entry.length; f += 2) {
      const field = String(entry[f])
      if (field === '__key' || field === 'key') key = String(entry[f + 1])
      if (field === '__score' || field === 'score') score = Number(entry[f + 1])
    }
    if (key) hits.push({ key, score })
  }
  return hits
}

/**
 * SA-104 P6 — graduated segments join search (the P4 deferral). Hybrid lexical+vector
 * over the segment index; the requested time range matches by OVERLAP with each
 * segment's [first_ts, last_ts] span ("last week" returns episodes that touched last
 * week). Same named-`$param` FT.HYBRID contract as memories.
 */
export interface SegmentSearchFilters {
  timeMin?: number
  timeMax?: number
}

function buildSegmentFilterClauses(filters: SegmentSearchFilters | undefined): string {
  if (!filters) return ''
  const clauses: string[] = []
  if (filters.timeMin !== undefined) clauses.push(`@last_ts:[${filters.timeMin} +inf]`)
  if (filters.timeMax !== undefined) clauses.push(`@first_ts:[-inf ${filters.timeMax}]`)
  return clauses.length > 0 ? ` ${clauses.join(' ')}` : ''
}

export async function hybridSearchSegments(options: {
  agentId: string
  query: string
  vector: number[]
  limit: number
  filters?: SegmentSearchFilters
}): Promise<MemorySearchHit[]> {
  const meta = await requireReadyMemoryIndexes()
  if (options.vector.length !== meta.dims) {
    throw new Error(
      `Memory query vector has ${options.vector.length} dims but the index expects ${meta.dims}.`
    )
  }
  const text = sanitizeTextQuery(options.query)
  const prefilter = `@agent:{${escapeTagValue(options.agentId)}}${buildSegmentFilterClauses(options.filters)}`
  const lexical = text ? `${prefilter} (@summary:(${text}))` : prefilter
  return redis.execute(async (client) => {
    const reply = await client.sendCommand([
      'FT.HYBRID', memorySegmentIndexName(),
      'SEARCH', lexical,
      'VSIM', '@embedding', '$qvec', 'FILTER', prefilter,
      'LIMIT', '0', String(options.limit),
      'PARAMS', '2', 'qvec', float32Blob(options.vector)
    ])
    return parseHybridReply(reply)
  })
}

export async function knnSearchSegments(options: {
  agentId: string
  vector: number[]
  k: number
}): Promise<MemorySearchHit[]> {
  const meta = await requireReadyMemoryIndexes()
  if (options.vector.length !== meta.dims) {
    throw new Error(
      `Memory query vector has ${options.vector.length} dims but the index expects ${meta.dims}.`
    )
  }
  const query = `(@agent:{${escapeTagValue(options.agentId)}})=>[KNN ${options.k} @embedding $qvec AS knn_dist]`
  return redis.execute(async (client) => {
    const reply = await client.sendCommand([
      'FT.SEARCH', memorySegmentIndexName(), query,
      'PARAMS', '2', 'qvec', float32Blob(options.vector),
      'SORTBY', 'knn_dist', 'ASC',
      'RETURN', '1', 'knn_dist',
      'LIMIT', '0', String(options.k),
      'DIALECT', '2'
    ])
    return parseSearchReplyWithField(reply, 'knn_dist')
  })
}

// ---------------------------------------------------------------------------
// Explicit re-index path (DL-104-10)
// ---------------------------------------------------------------------------

export interface RebuildMemoryIndexesResult {
  embeddingModel: string
  dims: number
  reembeddedMemories: number
  reembeddedSegments: number
}

/**
 * Drops and recreates both indexes for the CONFIGURED embedding model.
 *
 * With `reembed: true` every stored memory/segment is re-embedded first (batched via the
 * configured embedder) — required when the embedding model changed. Without it, the
 * stored vectors are kept and FT.CREATE re-indexes them (index-loss recovery); that mode
 * refuses to run across a model change.
 */
export async function rebuildMemoryIndexes(options: {
  reembed: boolean
  /** Batch contexts and tests may supply the embedder; it must match the configured model. */
  embedder?: import('./memoryEmbedder').MemoryEmbedder
  /** User context for api-lane key resolution when this call constructs the embedder. */
  userId?: string | null
}): Promise<RebuildMemoryIndexesResult> {
  const config = (await getMemoryConfig()).embedding
  const embeddingModel = canonicalEmbeddingModelId(config)
  const meta = await getMemoryIndexMeta()
  const modelChanged = meta !== null && meta.embedding_model !== embeddingModel

  if (modelChanged && !options.reembed) {
    throw new Error(
      `Memory index rebuild without re-embedding refused: the configured model (${embeddingModel}) differs from ` +
        `the indexed model (${meta?.embedding_model}). Re-run with reembed to regenerate stored vectors.`
    )
  }

  let reembeddedMemories = 0
  let reembeddedSegments = 0
  let dims = resolveConfiguredDims(config)

  if (options.reembed) {
    const embedder =
      options.embedder ?? createMemoryEmbedder(config, { userId: options.userId ?? null })
    if (embedder.modelId !== embeddingModel) {
      throw new Error(
        `Memory re-index refused: supplied embedder (${embedder.modelId}) does not match the configured model (${embeddingModel}).`
      )
    }
    dims = embedder.dims
    reembeddedMemories = await reembedByPattern(`${MEMORY_KEY_PREFIX}*`, '$.content', embedder.modelId, (texts) =>
      embedder.embedDocuments(texts)
    )
    reembeddedSegments = await reembedByPattern(
      `${MEMORY_SEGMENT_KEY_PREFIX}*`,
      '$.summary',
      embedder.modelId,
      (texts) => embedder.embedDocuments(texts)
    )
  }

  return redis.execute(async (client) => {
    for (const indexName of [memoryIndexName(), memorySegmentIndexName()]) {
      if (await indexExists(client, indexName)) {
        await client.sendCommand(['FT.DROPINDEX', indexName])
      }
    }
    await createMemoryIndex(client, dims)
    await createMemorySegmentIndex(client, dims)
    await writeMemoryIndexMeta(embeddingModel, dims)
    await assertIndexHealthy(client, memoryIndexName())
    await assertIndexHealthy(client, memorySegmentIndexName())
    return { embeddingModel, dims, reembeddedMemories, reembeddedSegments }
  })
}

const REEMBED_BATCH_SIZE = 32

async function reembedByPattern(
  pattern: string,
  textJsonPath: '$.content' | '$.summary',
  embeddingModelId: string,
  embedBatch: (texts: string[]) => Promise<number[][]>
): Promise<number> {
  return redis.execute(async (client) => {
    const keys = await client.keys(pattern)
    let updated = 0
    for (let start = 0; start < keys.length; start += REEMBED_BATCH_SIZE) {
      const batchKeys = keys.slice(start, start + REEMBED_BATCH_SIZE)
      const texts: string[] = []
      const validKeys: string[] = []
      for (const key of batchKeys) {
        const raw = await client.sendCommand(['JSON.GET', key, textJsonPath])
        if (typeof raw !== 'string') continue
        const parsed = JSON.parse(raw) as unknown
        const text = Array.isArray(parsed) ? parsed[0] : parsed
        if (typeof text !== 'string') continue
        texts.push(text)
        validKeys.push(key)
      }
      if (texts.length === 0) continue
      const vectors = await embedBatch(texts)
      for (let i = 0; i < validKeys.length; i++) {
        await client.sendCommand(['JSON.SET', validKeys[i], '$.embedding', JSON.stringify(vectors[i])])
        await client.sendCommand([
          'JSON.SET', validKeys[i], '$.embedding_model', JSON.stringify(embeddingModelId)
        ])
        updated++
      }
    }
    return updated
  })
}
