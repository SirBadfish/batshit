import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'
import type { MemoryEmbedder } from '../memoryEmbedder'
import {
  ensureMemoryIndexes,
  getMemoryIndexMeta,
  hybridSearchMemories,
  knnSearchMemories,
  knnSearchSegments,
  rebuildMemoryIndexes,
  requireReadyMemoryIndexes,
  setMemoryConfig,
  textSearchMemories
} from '../memoryIndex'
import {
  createMemory,
  createMemorySegment,
  deleteMemory,
  fetchMemoriesByKeys,
  getMemory,
  getSupersessionChain,
  listMemories,
  listMemorySegments,
  markExpiredDemotion,
  supersedeMemory,
  unsupersedeMemory,
  updateMemory,
  type CreateMemoryInput
} from '../memoryStore'
import { memoryKey } from '../memoryKeys'

/**
 * SA-104 memory data-layer suite. Runs ONLY under the dedicated memory-search lane
 * (npm run test:memory), which provides a disposable Redis 8 instance whose db 0 the
 * harness owns (testing-architecture.md §3 / DL-104-14).
 */

const harness = useMemorySearchTestServer()

/** Deterministic 8-dim embedder: known texts get hand-crafted geometry. */
function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
  return vector.map((v) => v / magnitude)
}

const KNOWN_VECTORS: Record<string, number[]> = {
  'Josh has an Irish Setter named Maggie': normalize([1, 0.1, 0, 0, 0, 0, 0, 0]),
  'what dog does Josh have': normalize([0.95, 0.15, 0, 0, 0, 0, 0, 0]),
  'Batshit runs Redis 8 with the JSON module': normalize([0, 0, 1, 0.1, 0, 0, 0, 0]),
  'The nap relieves context pressure between turns': normalize([0, 0, 0, 0, 1, 0.1, 0, 0]),
  'context window relief mechanics': normalize([0, 0, 0, 0, 0.95, 0.2, 0, 0])
}

function fakeVector(text: string): number[] {
  const known = KNOWN_VECTORS[text]
  if (known) return known
  const vector = new Array<number>(8).fill(0)
  for (let i = 0; i < text.length; i++) {
    vector[i % 8] += (text.charCodeAt(i) % 23) / 23
  }
  return normalize(vector)
}

function makeFakeEmbedder(modelId = 'local-ai:test-embedder@8', dims = 8): MemoryEmbedder {
  return {
    modelId,
    dims,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => fakeVector(text).slice(0, dims))
    },
    async embedQuery(text: string) {
      return fakeVector(text).slice(0, dims)
    }
  }
}

const fakeEmbedder = makeFakeEmbedder()

async function configureTestEmbedding(dims = 8, modelName = 'test-embedder'): Promise<void> {
  await setMemoryConfig({
    lane: 'local-ai',
    modelId: `local-ai:${modelName}`,
    localAi: {
      baseUrl: 'http://127.0.0.1:9/v1',
      modelName,
      dims
    }
  })
}

function memoryInput(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  return {
    agent_id: 'agent_test',
    user_id: 'user_test',
    lane: 'ltm',
    content: 'Josh has an Irish Setter named Maggie',
    importance: 7,
    provenance: [{ session_id: 'sess_x', message_id: 'msg_x', source: 'agent' }],
    ...overrides
  }
}

describe.runIf(memorySearchLaneActive())('memory data layer (dedicated Redis 8 db0)', () => {
  beforeEach(async () => {
    await configureTestEmbedding()
    await ensureMemoryIndexes()
  })

  afterAll(async () => {
    // Nothing extra: the harness tears the disposable instance down completely.
  })

  it('bootstraps idempotently and records index meta', async () => {
    const again = await ensureMemoryIndexes()
    expect(again.status).toBe('ready')
    const meta = await getMemoryIndexMeta()
    expect(meta).toMatchObject({ embedding_model: 'local-ai:test-embedder@8', dims: 8 })
    await expect(requireReadyMemoryIndexes()).resolves.toMatchObject({ dims: 8 })
  })

  it('creates, reads, lists, updates, and explicitly deletes memory records', async () => {
    const created = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    expect(created.id).toMatch(/^mem_/)
    expect(created.embedding).toHaveLength(8)
    expect(created.embedding_model).toBe('local-ai:test-embedder@8')
    expect(created.is_superseded).toBe('n')

    const fetched = await getMemory('agent_test', created.id)
    expect(fetched?.content).toContain('Maggie')

    const second = await createMemory(
      memoryInput({ content: 'Batshit runs Redis 8 with the JSON module', importance: 5 }),
      { embedder: fakeEmbedder }
    )
    const listed = await listMemories('agent_test')
    expect(listed.map((record) => record.id)).toContain(created.id)
    expect(listed.map((record) => record.id)).toContain(second.id)

    const originalEmbedding = [...created.embedding]
    const updated = await updateMemory(
      'agent_test',
      created.id,
      { content: 'The nap relieves context pressure between turns', importance: 9 },
      { embedder: fakeEmbedder }
    )
    expect(updated.importance).toBe(9)
    expect(updated.embedding).not.toEqual(originalEmbedding)
    expect(updated.updated_at).toBeDefined()

    expect(await deleteMemory('agent_test', created.id)).toBe(true)
    expect(await getMemory('agent_test', created.id)).toBeNull()
  })

  it('refuses any write that leaves an stm record without trigger terms (2026-08-28)', async () => {
    const record = await createMemory(
      memoryInput({
        lane: 'stm',
        content: 'Trigger-guard fixture',
        trigger_terms: ['guard']
      }),
      { embedder: fakeEmbedder }
    )
    // Clearing the triggers while the lane stays stm = a memory that can never fire.
    await expect(
      updateMemory('agent_test', record.id, { trigger_terms: null }, { embedder: fakeEmbedder })
    ).rejects.toThrow(/needs at least one trigger term/)
    // Moving another lane to stm without triggers fails the same way.
    const plain = await createMemory(
      memoryInput({ content: 'Plain LTM fixture' }),
      { embedder: fakeEmbedder }
    )
    await expect(
      updateMemory('agent_test', plain.id, { lane: 'stm' }, { embedder: fakeEmbedder })
    ).rejects.toThrow(/needs at least one trigger term/)
    // Bad linger overrides fail loudly too.
    await expect(
      updateMemory('agent_test', record.id, { linger_override: 99 }, { embedder: fakeEmbedder })
    ).rejects.toThrow(/linger_override/)
  })

  it('validates lane, importance, content, and provenance loudly', async () => {
    await expect(
      createMemory(memoryInput({ lane: 'bogus' as never }), { embedder: fakeEmbedder })
    ).rejects.toThrow(/Unknown memory lane/)
    await expect(
      createMemory(memoryInput({ importance: 0 }), { embedder: fakeEmbedder })
    ).rejects.toThrow(/importance/)
    await expect(
      createMemory(memoryInput({ content: '   ' }), { embedder: fakeEmbedder })
    ).rejects.toThrow(/non-empty content/)
    await expect(
      createMemory(memoryInput({ provenance: [] }), { embedder: fakeEmbedder })
    ).rejects.toThrow(/provenance/)
  })

  it('supersedes with pointers, never deletes, and can undo', async () => {
    const oldFact = await createMemory(
      memoryInput({ content: 'Maggie loves the beach ball' }),
      { embedder: fakeEmbedder }
    )
    const newFact = await createMemory(
      memoryInput({ content: 'Maggie now prefers the rope toy' }),
      { embedder: fakeEmbedder }
    )

    await supersedeMemory('agent_test', newFact.id, [oldFact.id])
    const supersededOld = await getMemory('agent_test', oldFact.id)
    expect(supersededOld?.is_superseded).toBe('y')
    expect(supersededOld?.superseded_by).toBe(newFact.id)
    expect(supersededOld?.content).toContain('beach ball')

    const chain = await getSupersessionChain('agent_test', oldFact.id)
    expect(chain.successors.map((record) => record.id)).toEqual([newFact.id])
    const chainFromNew = await getSupersessionChain('agent_test', newFact.id)
    expect(chainFromNew.predecessors.map((record) => record.id)).toEqual([oldFact.id])

    const restored = await unsupersedeMemory('agent_test', oldFact.id)
    expect(restored.is_superseded).toBe('n')
    expect(restored.superseded_by).toBeNull()
    const successorAfterUndo = await getMemory('agent_test', newFact.id)
    expect(successorAfterUndo?.supersedes ?? []).not.toContain(oldFact.id)
  })

  it('demotes expired memories without erasing them', async () => {
    const expiring = await createMemory(
      memoryInput({
        lane: 'awareness',
        content: 'Reminder: pick up the trailer Friday',
        expires_at: '2026-08-29T00:00:00.000Z'
      }),
      { embedder: fakeEmbedder }
    )
    const demoted = await markExpiredDemotion('agent_test', expiring.id, 'ltm')
    expect(demoted.lane).toBe('ltm')
    expect(demoted.expired_demoted_to).toBe('ltm')
    expect(demoted.content).toContain('trailer')

    const noExpiry = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    await expect(markExpiredDemotion('agent_test', noExpiry.id, 'ltm')).rejects.toThrow(/no expiry/)
  })

  it('answers KNN with agent scoping and filters', async () => {
    const dog = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    await createMemory(
      memoryInput({ content: 'Batshit runs Redis 8 with the JSON module' }),
      { embedder: fakeEmbedder }
    )
    await createMemory(
      memoryInput({ agent_id: 'agent_other', content: 'what dog does Josh have' }),
      { embedder: fakeEmbedder }
    )

    const queryVector = await fakeEmbedder.embedQuery('what dog does Josh have')
    const hits = await knnSearchMemories({ agentId: 'agent_test', vector: queryVector, k: 3 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].key).toBe(memoryKey('agent_test', dog.id))
    expect(hits.every((hit) => hit.key.startsWith('memory:agent_test:'))).toBe(true)

    const records = await fetchMemoriesByKeys(hits.map((hit) => hit.key))
    expect(records[0].content).toContain('Maggie')

    const awarenessOnly = await knnSearchMemories({
      agentId: 'agent_test',
      vector: queryVector,
      k: 3,
      filters: { lane: 'awareness' }
    })
    expect(awarenessOnly).toHaveLength(0)

    const futureOnly = await knnSearchMemories({
      agentId: 'agent_test',
      vector: queryVector,
      k: 3,
      filters: { savedTsMin: Date.now() + 60_000 }
    })
    expect(futureOnly).toHaveLength(0)
  })

  it('excludes superseded records when filtered and still returns them unfiltered', async () => {
    const oldFact = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    const newFact = await createMemory(
      memoryInput({ content: 'what dog does Josh have' }),
      { embedder: fakeEmbedder }
    )
    await supersedeMemory('agent_test', newFact.id, [oldFact.id])

    const queryVector = await fakeEmbedder.embedQuery('what dog does Josh have')
    const currentOnly = await knnSearchMemories({
      agentId: 'agent_test',
      vector: queryVector,
      k: 5,
      filters: { superseded: 'n' }
    })
    expect(currentOnly.map((hit) => hit.key)).not.toContain(memoryKey('agent_test', oldFact.id))

    const everything = await knnSearchMemories({ agentId: 'agent_test', vector: queryVector, k: 5 })
    expect(everything.map((hit) => hit.key)).toContain(memoryKey('agent_test', oldFact.id))
  })

  it('answers keyword search with BM25 scores', async () => {
    const dog = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    await createMemory(
      memoryInput({ content: 'Batshit runs Redis 8 with the JSON module' }),
      { embedder: fakeEmbedder }
    )
    const hits = await textSearchMemories({ agentId: 'agent_test', query: 'Irish Setter', limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0].key).toBe(memoryKey('agent_test', dog.id))
    expect(hits[0].score).toBeGreaterThan(0)

    // Syntax junk is neutralized, surviving words still match (terms AND together).
    const weird = await textSearchMemories({
      agentId: 'agent_test',
      query: '@Setter:{(!! | *)',
      limit: 5
    })
    expect(weird.map((hit) => hit.key)).toContain(memoryKey('agent_test', dog.id))

    // A query that is nothing but syntax returns cleanly with no hits and no error.
    const emptyAfterSanitize = await textSearchMemories({
      agentId: 'agent_test',
      query: '@{(| * )}',
      limit: 5
    })
    expect(emptyAfterSanitize).toHaveLength(0)
  })

  it('fuses lexical and vector results through FT.HYBRID', async () => {
    const dog = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    await createMemory(
      memoryInput({ content: 'The nap relieves context pressure between turns' }),
      { embedder: fakeEmbedder }
    )
    const queryVector = await fakeEmbedder.embedQuery('what dog does Josh have')
    const hits = await hybridSearchMemories({
      agentId: 'agent_test',
      query: 'Irish Setter',
      vector: queryVector,
      limit: 5
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map((hit) => hit.key)).toContain(memoryKey('agent_test', dog.id))
  })

  it('creates and searches graduated segments with mandatory session provenance', async () => {
    const segment = await createMemorySegment(
      {
        agent_id: 'agent_test',
        user_id: 'user_test',
        session_id: 'sess_fixed_1',
        episode_id: 'ep_1',
        message_ids: ['m1', 'm2'],
        summary: 'The nap relieves context pressure between turns',
        topics: ['nap', 'context'],
        first_message_at: '2026-08-25T00:00:00.000Z',
        last_message_at: '2026-08-25T01:00:00.000Z',
        token_count: 420,
        graduated_by: 'session_close'
      },
      { embedder: fakeEmbedder }
    )
    expect(segment.id).toMatch(/^memseg_/)

    const listed = await listMemorySegments('agent_test')
    expect(listed.map((record) => record.id)).toContain(segment.id)

    const queryVector = await fakeEmbedder.embedQuery('context window relief mechanics')
    const hits = await knnSearchSegments({ agentId: 'agent_test', vector: queryVector, k: 2 })
    expect(hits[0]?.key).toBe(`memseg:agent_test:${segment.id}`)

    await expect(
      createMemorySegment(
        {
          agent_id: 'agent_test',
          user_id: 'user_test',
          session_id: '',
          message_ids: ['m1'],
          summary: 'missing session',
          first_message_at: '2026-08-25T00:00:00.000Z',
          last_message_at: '2026-08-25T01:00:00.000Z',
          token_count: 10,
          graduated_by: 'nap'
        },
        { embedder: fakeEmbedder }
      )
    ).rejects.toThrow(/session provenance/)
  })

  it('rebuilds the indexes from records alone (index-loss recovery)', async () => {
    const created = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    const result = await rebuildMemoryIndexes({ reembed: false })
    expect(result.embeddingModel).toBe('local-ai:test-embedder@8')

    const queryVector = await fakeEmbedder.embedQuery('what dog does Josh have')
    const hits = await knnSearchMemories({ agentId: 'agent_test', vector: queryVector, k: 1 })
    expect(hits[0]?.key).toBe(memoryKey('agent_test', created.id))
  })

  it('refuses writes and searches after a model change until the explicit re-index runs', async () => {
    await createMemory(memoryInput(), { embedder: fakeEmbedder })

    // Change the configured embedding model without re-indexing.
    await configureTestEmbedding(4, 'test-embedder-v2')

    await expect(ensureMemoryIndexes()).rejects.toThrow(/does not match the built index/)
    await expect(requireReadyMemoryIndexes()).rejects.toThrow(/without a re-index/)
    await expect(
      createMemory(memoryInput({ content: 'new fact after model change' }), {
        embedder: makeFakeEmbedder('local-ai:test-embedder-v2@4', 4)
      })
    ).rejects.toThrow(/re-index/)
    await expect(rebuildMemoryIndexes({ reembed: false })).rejects.toThrow(/refused/)

    const v2Embedder = makeFakeEmbedder('local-ai:test-embedder-v2@4', 4)
    const rebuilt = await rebuildMemoryIndexes({ reembed: true, embedder: v2Embedder })
    expect(rebuilt.embeddingModel).toBe('local-ai:test-embedder-v2@4')
    expect(rebuilt.dims).toBe(4)
    expect(rebuilt.reembeddedMemories).toBe(1)

    const meta = await getMemoryIndexMeta()
    expect(meta?.dims).toBe(4)
    const queryVector = await v2Embedder.embedQuery('what dog does Josh have')
    const hits = await knnSearchMemories({ agentId: 'agent_test', vector: queryVector, k: 1 })
    expect(hits).toHaveLength(1)

    // Old-dimension query vectors are rejected loudly.
    await expect(
      knnSearchMemories({ agentId: 'agent_test', vector: new Array(8).fill(0.1), k: 1 })
    ).rejects.toThrow(/dims/)
  })

  it('fails loudly when stored records cannot be indexed (wrong-dimension vectors)', async () => {
    await createMemory(memoryInput(), { embedder: fakeEmbedder })

    // Bypass the store and corrupt a record with a wrong-dimension embedding.
    const admin = harness.adminClient()
    await admin.json.set('memory:agent_test:mem_corrupt', '$', {
      id: 'mem_corrupt',
      agent_id: 'agent_test',
      user_id: 'user_test',
      lane: 'ltm',
      content: 'corrupt vector record',
      importance: 5,
      event_at: null,
      event_ts: null,
      saved_at: new Date().toISOString(),
      saved_ts: Date.now(),
      is_superseded: 'n',
      provenance: [{ session_id: 'sess_x', source: 'agent' }],
      visibility: 'normal',
      embedding: [0.1, 0.2],
      embedding_model: 'local-ai:test-embedder@8',
      schema_version: 1
    })

    await expect(rebuildMemoryIndexes({ reembed: false })).rejects.toThrow(
      /failed to index 1 stored record/
    )
  })

  it('runs the episode lifecycle with a single-open invariant and a dissolving whiteboard', async () => {
    const { openEpisode, closeEpisode, markEpisodeGraduated, updateEpisodeWhiteboard, updateEpisodeBounds, getOpenEpisode, listEpisodes } =
      await import('../memoryEpisodes')

    const episode = await openEpisode({ session_id: 'sess_ep', agent_id: 'agent_test', first_message_id: 'm1' })
    expect(episode.state).toBe('open')
    expect(await getOpenEpisode('sess_ep')).toMatchObject({ id: episode.id })

    await expect(openEpisode({ session_id: 'sess_ep', agent_id: 'agent_test' })).rejects.toThrow(
      /already has open episode/
    )

    const withBoard = await updateEpisodeWhiteboard('sess_ep', episode.id, 'vet Friday; rope toy')
    expect(withBoard.whiteboard?.content).toContain('vet Friday')
    await updateEpisodeBounds('sess_ep', episode.id, { last_message_id: 'm9', hold_until: '2026-08-26T09:00:00.000Z' })

    await expect(markEpisodeGraduated('sess_ep', episode.id)).rejects.toThrow(/only closed episodes graduate/)

    const closed = await closeEpisode('sess_ep', episode.id, 'agent_mark')
    expect(closed.state).toBe('closed')
    expect(closed.hold_until).toBeNull()
    expect(closed.whiteboard?.content).toContain('vet Friday')

    await expect(updateEpisodeWhiteboard('sess_ep', episode.id, 'nope')).rejects.toThrow(
      /belongs to the open episode/
    )

    const graduated = await markEpisodeGraduated('sess_ep', episode.id)
    expect(graduated.state).toBe('graduated')

    const second = await openEpisode({ session_id: 'sess_ep', agent_id: 'agent_test' })
    const ledger = await listEpisodes('sess_ep')
    expect(ledger.map((entry) => entry.id)).toEqual([episode.id, second.id])
  })

  it('deleteSession removes the episode ledger', async () => {
    const { openEpisode } = await import('../memoryEpisodes')
    const { redis } = await import('$lib/server/redis')

    await redis.json.set('session:sess_del', '$', { id: 'sess_del', user_id: 'user_test' } as never)
    await openEpisode({ session_id: 'sess_del', agent_id: 'agent_test' })

    await redis.deleteSession('sess_del')

    const admin = harness.adminClient()
    expect(await admin.keys('episode:sess_del:*')).toHaveLength(0)
    expect(await admin.exists('session:sess_del:episodes')).toBe(0)
  })

  it('deleteAgent removes the whole memory store for that agent only', async () => {
    const mine = await createMemory(memoryInput(), { embedder: fakeEmbedder })
    await createMemorySegment(
      {
        agent_id: 'agent_test',
        user_id: 'user_test',
        session_id: 'sess_1',
        message_ids: ['m1'],
        summary: 'segment to delete',
        first_message_at: '2026-08-25T00:00:00.000Z',
        last_message_at: '2026-08-25T01:00:00.000Z',
        token_count: 10,
        graduated_by: 'session_close'
      },
      { embedder: fakeEmbedder }
    )
    const other = await createMemory(
      memoryInput({ agent_id: 'agent_other', content: 'survives the neighbor deletion' }),
      { embedder: fakeEmbedder }
    )

    const { redis } = await import('$lib/server/redis')
    await redis.deleteAgent('agent_test')

    const admin = harness.adminClient()
    expect(await admin.keys('memory:agent_test:*')).toHaveLength(0)
    expect(await admin.keys('memseg:agent_test:*')).toHaveLength(0)
    expect(await getMemory('agent_other', other.id)).not.toBeNull()
    expect(await getMemory('agent_test', mine.id)).toBeNull()
  })
})
