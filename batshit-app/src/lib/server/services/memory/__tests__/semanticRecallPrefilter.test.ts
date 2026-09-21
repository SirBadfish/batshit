import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'

/**
 * SA-120 P4b — the recall-by-meaning PRE-FILTER against the real Redis 8 search index
 * (dedicated db0 lane, `npm run test:memory`): only current, unexpired LTM memories, never
 * an id the recall engine says is already in context, a whole sentence works as the query
 * (any-word lexical leg), and the shortlist is capped. No TypeSafe traffic anywhere here.
 */

vi.mock('../memoryEmbedder', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryEmbedder')>()
  function fakeVector(text: string): number[] {
    const vector = new Array<number>(8).fill(0)
    for (let i = 0; i < text.length; i++) vector[i % 8] += (text.charCodeAt(i) % 23) / 23
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
    return vector.map((v) => v / magnitude)
  }
  const testEmbedder = () => ({
    modelId: 'local-ai:test-embedder@8',
    dims: 8,
    async embedDocuments(texts: string[]) {
      return texts.map((text) => fakeVector(text))
    },
    async embedQuery(text: string) {
      return fakeVector(text)
    }
  })
  // Both doors must return the fake (see memoryTools.test.ts for why).
  return { ...original, createMemoryEmbedder: testEmbedder, createMemoryEmbedderAsync: async () => testEmbedder() }
})

import { anyWordTextQuery, ensureMemoryIndexes, hybridSearchMemories, setMemoryConfig } from '../memoryIndex'
import { createMemory, supersedeMemory, type CreateMemoryInput } from '../memoryStore'
import { SEMANTIC_RECALL_LIMITS, prefilterSemanticRecallCandidates } from '../semanticRecall.jev'
import { redis } from '$lib/server/redis'

useMemorySearchTestServer()

const USER = 'user_prefilter'
const AGENT = 'agent_prefilter'
const SESSION = 'sess_prefilter'

async function seedMemory(overrides: Partial<CreateMemoryInput> & { content: string }): Promise<string> {
  const record = await createMemory({
    agent_id: AGENT,
    user_id: USER,
    lane: 'ltm',
    importance: 5,
    provenance: [{ session_id: SESSION, source: 'agent' }],
    ...overrides
  })
  return record.id
}

describe('anyWordTextQuery', () => {
  it('turns a sentence into alternatives: short words and repeats dropped, syntax neutralized, count capped', () => {
    expect(anyWordTextQuery('What snack should I bring to the (party)? A snack!')).toBe('what|snack|should|bring|the|party')
    expect(anyWordTextQuery('@agent:{x} | -secret')).toBe('agent|secret')
    expect(anyWordTextQuery('a b')).toBe('')
    expect(anyWordTextQuery(Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')).split('|')).toHaveLength(32)
  })
})

describe.runIf(memorySearchLaneActive())('recall-by-meaning pre-filter (dedicated Redis 8 db0)', () => {
  beforeEach(async () => {
    await setMemoryConfig({
      lane: 'local-ai',
      modelId: 'local-ai:test-embedder',
      localAi: { baseUrl: 'http://127.0.0.1:9/v1', modelName: 'test-embedder', dims: 8 }
    })
    await ensureMemoryIndexes()
    await redis.json.set(`agent:${AGENT}`, '$', { id: AGENT, user_id: USER, name: 'Prefilter Agent', memory_enabled: true } as never)
  })

  it('a whole sentence finds a memory that shares one word with it (any-word lexical leg)', async () => {
    const shellfishId = await seedMemory({ content: 'Josh is allergic to shellfish' })
    // Fifteen unrelated memories, so the vector leg alone (the fake geometry is arbitrary) cannot be what finds it.
    for (let index = 0; index < 15; index++) await seedMemory({ content: `Unrelated workshop note number ${index} about lathes` })
    const sentence = 'can you pick a snack for movie night, my sister is bringing shellfish dip'
    const vector = new Array<number>(8).fill(0).map((_, index) => (index === 7 ? 1 : 0))

    const everyWord = await hybridSearchMemories({ agentId: AGENT, query: sentence, vector, limit: 3 })
    const anyWord = await hybridSearchMemories({ agentId: AGENT, query: sentence, vector, limit: 3, lexicalMode: 'any' })
    // Today's every-word leg cannot match a fourteen-word sentence; the any-word leg ranks the one shared rare word first.
    expect(anyWord[0].key).toBe(`memory:${AGENT}:${shellfishId}`)
    expect(everyWord[0]?.key).not.toBe(`memory:${AGENT}:${shellfishId}`)
  })

  it('returns only current, unexpired LTM memories and never an id that is already in context', async () => {
    const keepId = await seedMemory({ content: 'Josh likes shellfish-free snacks at parties' })
    const excludedId = await seedMemory({ content: 'Josh brought snacks to the last party' })
    const stmId = await seedMemory({ lane: 'stm', content: 'Party snack trigger memory', trigger_terms: ['party'] })
    const awarenessId = await seedMemory({ lane: 'awareness', content: 'Always-on party snack fact', importance: 9 })
    const oldId = await seedMemory({ content: 'Outdated party snack decision' })
    const newId = await seedMemory({ content: 'Current party snack decision' })
    await supersedeMemory(AGENT, newId, [oldId])
    const expiredId = await seedMemory({ content: 'Expired party snack fact' })
    await redis.execute(async (client) => {
      await client.json.set(`memory:${AGENT}:${expiredId}`, '$.expires_ts', (Date.now() - 1000) as never)
    })

    const candidates = await prefilterSemanticRecallCandidates({
      userId: USER,
      agentId: AGENT,
      message: 'what party snack should I bring?',
      excludeIds: [excludedId]
    })
    const ids = candidates.map((record) => record.id)
    expect(ids).toContain(keepId)
    expect(ids).toContain(newId)
    for (const id of [excludedId, stmId, awarenessId, oldId, expiredId]) expect(ids).not.toContain(id)
    expect(candidates.every((record) => record.lane === 'ltm' && record.is_superseded !== 'y')).toBe(true)
  })

  it('caps the shortlist and returns nothing for an empty message', async () => {
    for (let index = 0; index < SEMANTIC_RECALL_LIMITS.maxCandidates + 8; index++) {
      await seedMemory({ content: `Party snack note ${index}` })
    }
    const candidates = await prefilterSemanticRecallCandidates({
      userId: USER,
      agentId: AGENT,
      message: 'party snack',
      excludeIds: []
    })
    expect(candidates).toHaveLength(SEMANTIC_RECALL_LIMITS.maxCandidates)
    expect(await prefilterSemanticRecallCandidates({ userId: USER, agentId: AGENT, message: '   ', excludeIds: [] })).toEqual([])
  })
})
