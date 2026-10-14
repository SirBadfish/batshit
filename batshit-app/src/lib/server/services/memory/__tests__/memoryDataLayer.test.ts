import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

  describe('date validation before embedding (BL-825)', () => {
    it.each([
      ['event_at', '2026-02-31', /not a real calendar day/],
      ['expires_at', '2026-02-31', /not a real calendar day/],
      ['event_at', 'invalid-timestamp', /event_at is not a valid timestamp/],
      ['expires_at', 'invalid-timestamp', /expires_at is not a valid timestamp/]
    ] as const)('refuses %s=%s without embedding or changing stored records', async (field, value, error) => {
      const original = await createMemory(memoryInput(), { embedder: fakeEmbedder })
      const key = memoryKey('agent_test', original.id)
      const rawBefore = await harness.adminClient().sendCommand(['JSON.GET', key])
      const keysBefore = (await harness.adminClient().keys('memory:agent_test:*')).sort()
      const embedDocuments = vi.fn(fakeEmbedder.embedDocuments)
      const embedder = { ...fakeEmbedder, embedDocuments }

      for (const id of [original.id, 'mem_bl825_refused']) {
        await expect(createMemory(memoryInput({ id, [field]: value }), { embedder }))
          .rejects.toThrow(error)
      }

      expect(embedDocuments).not.toHaveBeenCalled()
      expect(await harness.adminClient().sendCommand(['JSON.GET', key])).toBe(rawBefore)
      expect((await harness.adminClient().keys('memory:agent_test:*')).sort()).toEqual(keysBefore)
      expect(await getMemory('agent_test', 'mem_bl825_refused')).toBeNull()
    })

    it('embeds accepted explicit dates once and preserves the complete saved record', async () => {
      const embedDocuments = vi.fn(async (texts: string[]) =>
        texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]))
      const input = memoryInput({
        event_at: '2026-06-01T08:30:00.000-04:00',
        expires_at: '2026-07-01T08:30:00.000-04:00',
        gist: 'Maggie',
        links: ['https://example.test/maggie']
      })
      const created = await createMemory(input, { embedder: { ...fakeEmbedder, embedDocuments } })

      expect(embedDocuments).toHaveBeenCalledExactlyOnceWith([input.content])
      expect(created).toMatchObject({
        ...input,
        event_ts: Date.parse(input.event_at!),
        expires_ts: Date.parse(input.expires_at!),
        embedding: [1, 0, 0, 0, 0, 0, 0, 0],
        embedding_model: fakeEmbedder.modelId
      })
      expect(created.saved_ts).toBe(Date.parse(created.saved_at))
      expect(await harness.adminClient().json.get(memoryKey(input.agent_id, created.id))).toEqual(created)
      expect(await getMemory(input.agent_id, created.id)).toEqual(created)
    })
  })

  describe('repeated final-hour expiry storage (BL-1237)', () => {
    // Exact binary vectors keep full-record equality focused on expiry/preservation, without
    // comparing the original embedder's pre-serialization rounding to Redis JSON's output.
    const calendarEmbedder: MemoryEmbedder = {
      ...fakeEmbedder,
      async embedDocuments(texts) {
        return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0])
      }
    }

    async function inSantiago(check: () => Promise<void>) {
      const previous = process.env.TZ
      process.env.TZ = 'America/Santiago'
      try {
        expect(new Date('2026-04-05T02:30:00.000Z').getTimezoneOffset()).toBe(180)
        expect(new Date('2026-04-05T03:30:00.000Z').getTimezoneOffset()).toBe(240)
        await check()
      } finally {
        if (previous === undefined) delete process.env.TZ
        else process.env.TZ = previous
      }
    }

    it('create stores both expiry fields through the second final hour and keeps Awareness eligible', async () => {
      await inSantiago(async () => {
        const created = await createMemory(memoryInput({
          lane: 'awareness',
          expires_at: '2026-04-04',
          event_at: '2026-04-04'
        }), { embedder: calendarEmbedder })
        expect(await harness.adminClient().json.get(memoryKey('agent_test', created.id))).toEqual(created)
        const stored = await getMemory('agent_test', created.id)
        expect(stored).toEqual(created)
        expect(stored?.expires_at).toBe('2026-04-05T03:59:59.999Z')
        expect(stored?.expires_ts).toBe(Date.parse('2026-04-05T03:59:59.999Z'))
        expect(stored?.event_at).toBe('2026-04-04T03:00:00.000Z')
        if (!stored) throw new Error('Created memory was not stored')
        const { selectAwarenessState } = await import('../memoryRecall')
        const budgets = { onMyMind: 1000, triggers: 1000, recalled: 1000 }
        expect(selectAwarenessState([stored], budgets, Date.parse('2026-04-05T03:30:00.000Z')).entries)
          .toEqual([stored])
        expect(selectAwarenessState([stored], budgets, Date.parse('2026-04-05T04:00:00.000Z')).entries)
          .toEqual([])
      })
    })

    it('update stores a newly chosen bare expiry without changing the other record fields', async () => {
      await inSantiago(async () => {
        const original = await createMemory(memoryInput({
          expires_at: '2026-04-05T02:59:59.999Z'
        }), { embedder: calendarEmbedder })
        const updated = await updateMemory('agent_test', original.id, {
          expires_at: ' 2026-04-04 '
        }, { embedder: calendarEmbedder })
        expect(await harness.adminClient().json.get(memoryKey('agent_test', original.id))).toEqual(updated)
        expect(await getMemory('agent_test', original.id)).toEqual(updated)
        expect(updated.expires_at).toBe('2026-04-05T03:59:59.999Z')
        expect(updated.expires_ts).toBe(Date.parse('2026-04-05T03:59:59.999Z'))
        const { expires_at, expires_ts, updated_at, ...unchanged } = updated
        const { expires_at: oldExpiry, expires_ts: oldTs, ...originalFields } = original
        expect(unchanged).toEqual(originalFields)
      })
    })

    it('preserves old explicit expiry bytes on unrelated writes and invalid-day refusal', async () => {
      await inSantiago(async () => {
        const oldExpiry = '2026-04-04T23:59:59.999-03:00'
        const original = await createMemory(memoryInput({ expires_at: oldExpiry }), {
          embedder: calendarEmbedder
        })
        expect(original.expires_at).toBe(oldExpiry)
        const updated = await updateMemory('agent_test', original.id, { importance: 8 })
        expect(await harness.adminClient().json.get(memoryKey('agent_test', original.id))).toEqual(updated)
        expect(await getMemory('agent_test', original.id)).toEqual(updated)
        expect(updated.expires_at).toBe(oldExpiry)
        expect(updated.expires_ts).toBe(original.expires_ts)
        expect(updated).toEqual({ ...original, importance: 8, updated_at: updated.updated_at })
        const rawBeforeRefusal = await harness.adminClient().sendCommand(['JSON.GET', memoryKey('agent_test', original.id)])
        await expect(updateMemory('agent_test', original.id, { expires_at: '2026-02-31' }))
          .rejects.toThrow(/not a real calendar day/)
        expect(await harness.adminClient().sendCommand(['JSON.GET', memoryKey('agent_test', original.id)]))
          .toBe(rawBeforeRefusal)
        expect(await harness.adminClient().json.get(memoryKey('agent_test', original.id))).toEqual(updated)
        expect(await getMemory('agent_test', original.id)).toEqual(updated)
        const cleared = await updateMemory('agent_test', original.id, { expires_at: null })
        expect(Object.prototype.hasOwnProperty.call(cleared, 'expires_at')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(cleared, 'expires_ts')).toBe(false)
        expect((await getMemory('agent_test', original.id))?.content).toBe(original.content)
      })
    })
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

  it('refuses always-on media outside the Awareness lane at the storage boundary', async () => {
    await expect(
      createMemory(
        memoryInput({
          lane: 'ltm',
          media_mode: 'always',
          media: [
            {
              id: 'media_test',
              filename: 'agent_test/mem_test/media_test.png',
              display_name: 'test.png',
              mime_type: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
              token_estimate: 1,
              sha256: 'a'.repeat(64)
            }
          ]
        }),
        { embedder: fakeEmbedder }
      )
    ).rejects.toThrow(/only valid in the awareness lane/)
  })

  it('refuses a fifth active standing image at the storage boundary', async () => {
    const media = (id: string) => ({
      id,
      filename: `agent_test/mem_cap/${id}.png`,
      display_name: `${id}.png`,
      mime_type: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
      token_estimate: 1,
      sha256: id.padEnd(64, 'a').slice(0, 64)
    })
    await createMemory(
      memoryInput({
        lane: 'awareness',
        content: 'Four standing images',
        media_mode: 'always',
        media: ['one', 'two', 'three', 'four'].map(media)
      }),
      { embedder: fakeEmbedder }
    )
    await expect(
      createMemory(
        memoryInput({
          lane: 'awareness',
          content: 'Fifth standing image',
          media_mode: 'always',
          media: [media('five')]
        }),
        { embedder: fakeEmbedder }
      )
    ).rejects.toThrow(/capped at 4 images/)
  })

  // BL-438: a superseded record's always-on images stop counting toward the cap, so the agent can
  // fill the slots; restoring it with no check left the agent over the cap, and every send then
  // failed at the compile until the user fixed it in the panel.
  it('unsupersede refuses to restore always-on images past the 4-image cap, before any write (BL-438)', async () => {
    const media = (id: string) => ({
      id,
      filename: `agent_test/mem_bl438/${id}.png`,
      display_name: `${id}.png`,
      mime_type: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
      token_estimate: 1,
      sha256: id.padEnd(64, 'b').slice(0, 64)
    })
    const pair = await createMemory(
      memoryInput({
        lane: 'awareness',
        content: 'Standing pair of photos',
        media_mode: 'always',
        media: ['p1', 'p2'].map(media)
      }),
      { embedder: fakeEmbedder }
    )
    const winner = await createMemory(
      memoryInput({ lane: 'awareness', content: 'The winner without photos' }),
      { embedder: fakeEmbedder }
    )
    await supersedeMemory('agent_test', winner.id, [pair.id])
    // The superseded pair no longer counts, so three more standing images fit.
    const trio = await createMemory(
      memoryInput({
        lane: 'awareness',
        content: 'Standing trio of photos',
        media_mode: 'always',
        media: ['t1', 't2', 't3'].map(media)
      }),
      { embedder: fakeEmbedder }
    )

    await expect(unsupersedeMemory('agent_test', pair.id)).rejects.toThrow(
      /capped at 4 images per agent; this change would make 5\./
    )
    // Refused before the first write: the pair and its winner are exactly as they were.
    const stillSuperseded = await getMemory('agent_test', pair.id)
    expect(stillSuperseded?.is_superseded).toBe('y')
    expect(stillSuperseded?.superseded_by).toBe(winner.id)
    expect((await getMemory('agent_test', winner.id))?.supersedes).toContain(pair.id)

    // An expired always-on record shows no images, so restoring it is never refused, even with
    // every slot taken. (Created while a slot is free: a save counts its own images.)
    const expired = await createMemory(
      memoryInput({
        lane: 'awareness',
        content: 'Expired standing photo',
        media_mode: 'always',
        media: [media('e1')],
        expires_at: '2020-01-01T00:00:00.000Z'
      }),
      { embedder: fakeEmbedder }
    )
    await supersedeMemory('agent_test', winner.id, [expired.id])
    const single = await createMemory(
      memoryInput({
        lane: 'awareness',
        content: 'Standing single photo',
        media_mode: 'always',
        media: [media('s1')]
      }),
      { embedder: fakeEmbedder }
    )
    expect((await unsupersedeMemory('agent_test', expired.id)).is_superseded).toBe('n')

    // With slots freed (the trio arrives on recall), the pair restores as before: 1 + 2 = 3.
    await updateMemory('agent_test', trio.id, { media_mode: 'on_recall' }, { embedder: fakeEmbedder })
    const restored = await unsupersedeMemory('agent_test', pair.id)
    expect(restored.is_superseded).toBe('n')
    expect(restored.media_mode).toBe('always')
    expect((await getMemory('agent_test', single.id))?.media_mode).toBe('always')
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

  it('supports an older chosen winner but loudly refuses a cyclic reversal', async () => {
    const olderCanonical = await createMemory(
      memoryInput({ content: 'Maggie prefers the original blue leash' }),
      { embedder: fakeEmbedder }
    )
    const newerDuplicate = await createMemory(
      memoryInput({ content: 'Duplicate note: Maggie prefers the original blue leash' }),
      { embedder: fakeEmbedder }
    )

    await supersedeMemory('agent_test', olderCanonical.id, [newerDuplicate.id])
    expect((await getMemory('agent_test', newerDuplicate.id))?.superseded_by).toBe(
      olderCanonical.id
    )

    await expect(
      supersedeMemory('agent_test', newerDuplicate.id, [olderCanonical.id])
    ).rejects.toThrow(/supersession cycle.*Unsupersede the chosen winner first/i)

    // The rejected operation validates before writing, so the supported direction survives.
    expect((await getMemory('agent_test', newerDuplicate.id))?.superseded_by).toBe(
      olderCanonical.id
    )
    expect((await getMemory('agent_test', olderCanonical.id))?.is_superseded).toBe('n')
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

    const withBoard = await updateEpisodeWhiteboard('sess_ep', episode.id, 'vet Friday; rope toy', 'agent')
    expect(withBoard.whiteboard?.content).toContain('vet Friday')
    expect(withBoard.whiteboard?.written_by).toBe('agent')
    await updateEpisodeBounds('sess_ep', episode.id, { last_message_id: 'm9', hold_until: '2026-08-26T09:00:00.000Z' })

    await expect(markEpisodeGraduated('sess_ep', episode.id)).rejects.toThrow(/only closed episodes graduate/)

    const closed = await closeEpisode('sess_ep', episode.id, 'agent_mark')
    expect(closed.state).toBe('closed')
    expect(closed.hold_until).toBeNull()
    expect(closed.whiteboard?.content).toContain('vet Friday')

    await expect(updateEpisodeWhiteboard('sess_ep', episode.id, 'nope', 'agent')).rejects.toThrow(
      /belongs to the open episode/
    )

    const graduated = await markEpisodeGraduated('sess_ep', episode.id)
    expect(graduated.state).toBe('graduated')

    const second = await openEpisode({ session_id: 'sess_ep', agent_id: 'agent_test' })
    const ledger = await listEpisodes('sess_ep')
    expect(ledger.map((entry) => entry.id)).toEqual([episode.id, second.id])
  })

  it('BL-549: a conditional whiteboard write lands only on the board its writer read', async () => {
    const {
      openEpisode,
      closeEpisode,
      episodeKey,
      getEpisode,
      readWhiteboard,
      updateEpisodeWhiteboard,
      EpisodeNotOpenError,
      EpisodeWhiteboardChangedError
    } = await import('../memoryEpisodes')
    const { redis } = await import('$lib/server/redis')

    const episode = await openEpisode({ session_id: 'sess_cond', agent_id: 'agent_test' })
    const key = episodeKey('sess_cond', episode.id)
    const napBoard = { content: 'nap v1', updated_at: '2026-09-27T10:00:00.000Z', written_by: 'nap' }
    const setBoard = (board: unknown) => redis.json.set(key, '$.whiteboard', board as never)
    const boardNow = async () => (await getEpisode('sess_cond', episode.id))?.whiteboard ?? null

    // Read empty, still empty: the write lands and answers the stored record.
    const filled = await updateEpisodeWhiteboard('sess_cond', episode.id, 'nap fill', 'nap', {
      onlyIf: readWhiteboard(null)
    })
    expect(filled.whiteboard).toMatchObject({ content: 'nap fill', written_by: 'nap' })
    expect(await boardNow()).toEqual(filled.whiteboard)

    // Read empty, written since: refused, nothing written.
    await setBoard({ content: 'agent board', updated_at: '2026-09-27T10:05:00.000Z', written_by: 'agent' })
    await expect(
      updateEpisodeWhiteboard('sess_cond', episode.id, 'nap fill', 'nap', { onlyIf: readWhiteboard(null) })
    ).rejects.toBeInstanceOf(EpisodeWhiteboardChangedError)
    expect((await boardNow())?.content).toBe('agent board')

    // Only the AUTHOR changed since the read (same update time): refused.
    await setBoard(napBoard)
    const napRead = readWhiteboard(napBoard as never)
    await redis.json.set(key, '$.whiteboard.written_by', 'agent' as never)
    await expect(
      updateEpisodeWhiteboard('sess_cond', episode.id, 'nap refresh', 'nap', { onlyIf: napRead })
    ).rejects.toBeInstanceOf(EpisodeWhiteboardChangedError)
    expect((await boardNow())?.content).toBe('nap v1')

    // Only the UPDATE TIME changed since the read (another nap wrote it): refused.
    await setBoard(napBoard)
    await redis.json.set(key, '$.whiteboard.updated_at', '2026-09-27T10:09:00.000Z' as never)
    await expect(
      updateEpisodeWhiteboard('sess_cond', episode.id, 'nap refresh', 'nap', { onlyIf: napRead })
    ).rejects.toBeInstanceOf(EpisodeWhiteboardChangedError)
    expect((await boardNow())?.updated_at).toBe('2026-09-27T10:09:00.000Z')

    // Read a board, board cleared since: refused.
    await setBoard(null)
    await expect(
      updateEpisodeWhiteboard('sess_cond', episode.id, 'nap refresh', 'nap', { onlyIf: napRead })
    ).rejects.toBeInstanceOf(EpisodeWhiteboardChangedError)
    expect(await boardNow()).toBeNull()

    // Unchanged since the read: the refresh lands.
    await setBoard(napBoard)
    const refreshed = await updateEpisodeWhiteboard('sess_cond', episode.id, 'nap refresh', 'nap', {
      onlyIf: napRead
    })
    expect(refreshed.whiteboard?.content).toBe('nap refresh')

    // A record older than the author field reads as it is stored: an absent author stays absent.
    await setBoard({ content: 'old board', updated_at: '2026-09-01T00:00:00.000Z' })
    const oldRead = readWhiteboard((await boardNow()) as never)
    expect(oldRead).toEqual({ updated_at: '2026-09-01T00:00:00.000Z', written_by: null })
    await updateEpisodeWhiteboard('sess_cond', episode.id, 'over the old board', 'nap', { onlyIf: oldRead })
    expect((await boardNow())?.content).toBe('over the old board')

    // The agent's write has no condition: it lands over any board.
    await setBoard(napBoard)
    const agentWrite = await updateEpisodeWhiteboard('sess_cond', episode.id, 'agent wins', 'agent')
    expect(agentWrite.whiteboard).toMatchObject({ content: 'agent wins', written_by: 'agent' })

    // A closed episode refuses both kinds of write with the same words as before.
    await closeEpisode('sess_cond', episode.id, 'agent_mark')
    await expect(updateEpisodeWhiteboard('sess_cond', episode.id, 'late', 'agent')).rejects.toThrow(
      /is closed; the whiteboard belongs to the open episode/
    )
    await expect(
      updateEpisodeWhiteboard('sess_cond', episode.id, 'late', 'nap', {
        onlyIf: readWhiteboard((await boardNow()) as never)
      })
    ).rejects.toThrow(/is closed; the whiteboard belongs to the open episode/)
    // A typed refusal, so a writer can tell "the episode closed while I waited" from a failure.
    await expect(updateEpisodeWhiteboard('sess_cond', episode.id, 'late', 'agent')).rejects.toBeInstanceOf(
      EpisodeNotOpenError
    )
    expect((await boardNow())?.content).toBe('agent wins')
    await expect(updateEpisodeWhiteboard('sess_cond', 'ep_missing', 'x', 'agent')).rejects.toThrow(
      /Episode ep_missing not found for session sess_cond/
    )
  })

  it('parallel episode field updaters cannot erase each other (SA-110 whiteboard drift race)', async () => {
    const { openEpisode, updateEpisodeWhiteboard, updateEpisodeBounds, getEpisode } =
      await import('../memoryEpisodes')

    // Bob's goodnight interleaving, deterministically: Promise.all starts both
    // await-chains, so both read the episode before either writes. With the old
    // full-document writes the bounds write restored the pre-rewrite board every
    // time; path-scoped field writes must keep BOTH fields on every round.
    // Round 0 also pins that `$.hold_until` path-creation works on a fresh
    // record that never carried the field.
    const episode = await openEpisode({ session_id: 'sess_race', agent_id: 'agent_test' })
    for (let round = 0; round < 5; round++) {
      const hold = `2026-09-0${round + 2}T09:00:00.000Z`
      await Promise.all([
        updateEpisodeWhiteboard('sess_race', episode.id, `board r${round}`, 'agent'),
        updateEpisodeBounds('sess_race', episode.id, { hold_until: hold })
      ])
      const stored = await getEpisode('sess_race', episode.id)
      expect(stored?.whiteboard?.content).toBe(`board r${round}`)
      expect(stored?.hold_until).toBe(hold)
    }
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
    const previousUploadsDir = process.env.UPLOADS_DIR
    const uploadRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-memory-agent-delete-'))
    const mediaFilename = `agent_test/${mine.id}/media_delete.png`
    const mediaPath = path.join(uploadRoot, 'memory-media', mediaFilename)
    await mkdir(path.dirname(mediaPath), { recursive: true })
    await writeFile(mediaPath, 'owned-memory-image')
    await redis.json.set(`upload:memory-media:${mediaFilename}`, '$', {
      filename: mediaFilename,
      uploadType: 'memory-media',
      storage: 'filesystem',
      relativePath: `memory-media/${mediaFilename}`,
      filePath: mediaPath
    } as never)
    process.env.UPLOADS_DIR = uploadRoot

    try {
      await redis.deleteAgent('agent_test')

      const admin = harness.adminClient()
      expect(await admin.keys('memory:agent_test:*')).toHaveLength(0)
      expect(await admin.keys('memseg:agent_test:*')).toHaveLength(0)
      expect(await admin.keys('upload:memory-media:agent_test/*')).toHaveLength(0)
      await expect(stat(mediaPath)).rejects.toThrow()
      expect(await getMemory('agent_other', other.id)).not.toBeNull()
      expect(await getMemory('agent_test', mine.id)).toBeNull()
    } finally {
      if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR
      else process.env.UPLOADS_DIR = previousUploadsDir
      await rm(uploadRoot, { recursive: true, force: true })
    }
  })
})
