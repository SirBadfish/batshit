// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeCallOutcome, TypesafeClient, TypesafeSystemOneRequest } from '../../typesafe/typesafeClient'
import type { MemoryRecord } from '../memoryTypes'

/**
 * SA-120 P4a — the memory search rerank lane: request shape, the answer reader (all or
 * nothing), the ranking with the Jev term (weight-sensitive at the case that defines it),
 * the cut back to the asked limit, the superseded tail, and the orchestrator against a
 * fake client (the agent switch, the DL-120-11 master-off no-call pin, a deadline miss,
 * a missing answer). No network, no Redis: `searchMemoriesOp`'s own wiring, the switch-OFF
 * byte pin, and the FT.HYBRID paging pin run in the memory lane (memoryRerankSearch.test.ts).
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))

import { createTypesafeClient, type TypesafeFetch } from '../../typesafe/typesafeClient'
import { blendMemoryRanking } from '../memoryRecall'
import {
  MEMORY_RERANK_LIMITS,
  MEMORY_RERANK_QUESTIONS,
  MEMORY_RERANK_WEIGHTS,
  buildMemoryRerankPool,
  buildMemoryRerankRequest,
  computeMemoryRerank,
  describeMemoryForJev,
  rankMemoriesWithJevRelevance,
  readMemoryRerankAnswers,
  resolveMemoryRerankShortlistSize,
  summarizeMemoryRerank
} from '../memoryRerank.jev'

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)
const DAY = 86_400_000

function mem(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    agent_id: 'agent-1',
    user_id: 'josh',
    lane: 'ltm',
    content: `memory ${id}`,
    importance: 5,
    event_at: null,
    event_ts: null,
    saved_at: new Date(NOW - 30 * DAY).toISOString(),
    saved_ts: NOW - 30 * DAY,
    is_superseded: 'n',
    provenance: [{ session_id: 's1', source: 'agent' }],
    visibility: 'normal',
    embedding: [],
    embedding_model: 'test',
    schema_version: 1,
    ...overrides
  } as MemoryRecord
}

function orderOf(records: MemoryRecord[]): Map<string, number> {
  return new Map(records.map((record, index) => [record.id, index]))
}

const AGENT_ON = { id: 'agent-1', user_id: 'josh', name: 'Lucy', jev_juice_memory_rerank: true }
const AGENT_OFF = { id: 'agent-1', user_id: 'josh', name: 'Lucy' }

beforeEach(() => {
  retrieve.mockReset()
  retrieve.mockResolvedValue('user-key')
  dynamicPrivateEnv.env = {}
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
})

describe('buildMemoryRerankRequest', () => {
  it('asks one Noul per shortlisted memory over a state of the query and short-keyed memory texts', () => {
    const records = [
      mem('mem_a', { content: 'Josh prefers Geist Sans at weight 300.' }),
      mem('mem_b', { content: "Josh's dog is named Biscuit\nand hates thunderstorms." })
    ]
    const built = buildMemoryRerankRequest('  what is the name of the dog  ', records)
    expect(built).not.toBeNull()
    expect(built?.state).toEqual({
      query: 'what is the name of the dog',
      memories: {
        m1: 'Josh prefers Geist Sans at weight 300.',
        m2: "Josh's dog is named Biscuit and hates thunderstorms."
      }
    })
    expect(Object.keys(built?.questions ?? {})).toEqual(['rel_m1', 'rel_m2'])
    expect(built?.questions.rel_m2).toEqual({
      type: 'noul',
      instructions: MEMORY_RERANK_QUESTIONS.relevance.instructions('m2'),
      criteria: MEMORY_RERANK_QUESTIONS.relevance.criteria
    })
    // The id is never shown to the model, so the instructions must point at the state themselves.
    expect(String(built?.questions.rel_m2.instructions)).toContain('`memories.m2`')
    expect(String(built?.questions.rel_m2.instructions)).toContain('`query`')
    // Real memory ids stay home; Jev only ever sees the short keys.
    expect(JSON.stringify({ state: built?.state, questions: built?.questions })).not.toContain('mem_b')
    expect(built?.candidates).toEqual([
      { memoryId: 'mem_a', key: 'm1', text: 'Josh prefers Geist Sans at weight 300.' },
      { memoryId: 'mem_b', key: 'm2', text: "Josh's dog is named Biscuit and hates thunderstorms." }
    ])
  })

  it('has nothing to ask without a query or without at least two candidates', () => {
    expect(buildMemoryRerankRequest('   ', [mem('a'), mem('b')])).toBeNull()
    expect(buildMemoryRerankRequest('dog', [mem('a')])).toBeNull()
    expect(buildMemoryRerankRequest('dog', [])).toBeNull()
    // A blank memory is not a candidate; the keys stay dense.
    const built = buildMemoryRerankRequest('dog', [mem('a'), mem('blank', { content: '   ' }), mem('c')])
    expect(built?.candidates.map((candidate) => [candidate.memoryId, candidate.key])).toEqual([
      ['a', 'm1'],
      ['c', 'm2']
    ])
  })

  it('caps the candidates, the query, and each memory text', () => {
    const many = Array.from({ length: 40 }, (_, index) => mem(`mem_${index}`))
    const built = buildMemoryRerankRequest('q'.repeat(2000), many)
    expect(built?.candidates).toHaveLength(MEMORY_RERANK_LIMITS.maxCandidates)
    expect(built?.state.query.length).toBe(MEMORY_RERANK_LIMITS.maxQueryChars)
    expect(built?.state.query.endsWith('…')).toBe(true)

    const long = mem('long', { content: 'x'.repeat(5000) })
    expect(describeMemoryForJev(long).length).toBe(MEMORY_RERANK_LIMITS.maxMemoryChars)
    // A cut memory leads with the agent's own gist; an uncut one is just its content.
    const withGist = describeMemoryForJev({ content: 'y'.repeat(5000), gist: 'The Mac app ports' })
    expect(withGist.startsWith('The Mac app ports | yyy')).toBe(true)
    expect(withGist.length).toBe(MEMORY_RERANK_LIMITS.maxMemoryChars)
    expect(describeMemoryForJev({ content: 'short fact', gist: 'a gist' })).toBe('short fact')
  })
})

describe('resolveMemoryRerankShortlistSize', () => {
  it('widens a small ask to the shortlist size and never past the search tool ceiling', () => {
    expect(MEMORY_RERANK_LIMITS.shortlistSize).toBe(20)
    expect(resolveMemoryRerankShortlistSize(8, 25)).toBe(20)
    expect(resolveMemoryRerankShortlistSize(1, 25)).toBe(20)
    expect(resolveMemoryRerankShortlistSize(23, 25)).toBe(23)
    expect(resolveMemoryRerankShortlistSize(25, 25)).toBe(25)
    expect(resolveMemoryRerankShortlistSize(8, 12)).toBe(12)
  })
})

describe('buildMemoryRerankPool', () => {
  it('judges the wider hits first and always covers the usual result', () => {
    expect(buildMemoryRerankPool(['w1', 'w2', 'u1', 'w3'], ['u1', 'u2'])).toEqual(['w1', 'w2', 'u1', 'w3', 'u2'])
    expect(buildMemoryRerankPool([], ['u1'])).toEqual(['u1'])
  })

  it('drops only wide-only keys, from the end, when the cap bites', () => {
    const wide = Array.from({ length: 25 }, (_, index) => `w${index}`)
    const pool = buildMemoryRerankPool(wide, ['w3', 'u_a', 'u_b'])
    expect(pool).toHaveLength(MEMORY_RERANK_LIMITS.maxCandidates)
    expect(pool).toEqual([...wide.slice(0, 23), 'u_a', 'u_b'])
    expect(pool).toContain('w3')
  })
})

describe('readMemoryRerankAnswers', () => {
  const request = buildMemoryRerankRequest('dog', [mem('a'), mem('b'), mem('c')])!

  it('maps each probability to its real memory id', () => {
    const read = readMemoryRerankAnswers(
      { rel_m1: { type: 'noul', noul: 0.03 }, rel_m2: { type: 'noul', noul: 0.97 }, rel_m3: { type: 'noul', noul: 1.4 } },
      request
    )
    expect(read && Array.from(read.entries())).toEqual([
      ['a', 0.03],
      ['b', 0.97],
      ['c', 1]
    ])
  })

  it('trusts nothing when any answer is missing, not a Noul, or not a number', () => {
    expect(readMemoryRerankAnswers({ rel_m1: { type: 'noul', noul: 0.5 }, rel_m2: { type: 'noul', noul: 0.5 } }, request)).toBeNull()
    expect(
      readMemoryRerankAnswers(
        { rel_m1: { type: 'noul', noul: 0.5 }, rel_m2: { type: 'choice', choice: 'x' }, rel_m3: { type: 'noul', noul: 0.5 } },
        request
      )
    ).toBeNull()
    expect(
      readMemoryRerankAnswers(
        { rel_m1: { type: 'noul', noul: 0.5 }, rel_m2: { type: 'noul', noul: Number.NaN }, rel_m3: { type: 'noul', noul: 0.5 } },
        request
      )
    ).toBeNull()
  })
})

describe('rankMemoriesWithJevRelevance', () => {
  /** Twenty hits: the first is fresh and important, the sixteenth is old, unimportant, and the real answer. */
  function shortlist(): MemoryRecord[] {
    return Array.from({ length: 20 }, (_, index) => {
      if (index === 0) return mem('fresh_important', { importance: 10, saved_ts: NOW, saved_at: new Date(NOW).toISOString() })
      if (index === 15) return mem('the_answer', { importance: 1, saved_ts: NOW - 400 * DAY })
      return mem(`filler_${index}`, { importance: 5 })
    })
  }

  function usual(records: MemoryRecord[], limit: number): MemoryRecord[] {
    const hitOrder = orderOf(records)
    return blendMemoryRanking(records.slice(0, limit), hitOrder, NOW)
  }

  it('lets a decisive Jev answer outvote hybrid rank, recency, and importance together', () => {
    const records = shortlist()
    const relevanceById = new Map(records.map((record) => [record.id, record.id === 'the_answer' ? 0.97 : 0.05]))
    const ranking = rankMemoriesWithJevRelevance({
      records,
      hitOrder: orderOf(records),
      relevanceById,
      limit: 8,
      nowTs: NOW,
      usualRanking: usual(records, 8)
    })
    // Weight-sensitive: under about 0.94 the fresh, important first hit keeps first place
    // (0.1375 + 0.97w against 1.0 + 0.05w).
    expect(ranking.ranked[0].id).toBe('the_answer')
    expect(ranking.ranked).toHaveLength(8)
    expect(ranking.promotedIds).toEqual(['the_answer'])
    expect(ranking.changed).toBe(true)
    expect(MEMORY_RERANK_WEIGHTS.jevRelevance).toBe(1)
  })

  it('leaves the usual blend standing when Jev is flat, because an equal term cancels out', () => {
    const records = shortlist()
    const hitOrder = orderOf(records)
    const flat = new Map(records.map((record) => [record.id, 0.41]))
    const ranking = rankMemoriesWithJevRelevance({
      records,
      hitOrder,
      relevanceById: flat,
      limit: 20,
      nowTs: NOW,
      usualRanking: blendMemoryRanking(records, hitOrder, NOW)
    })
    expect(ranking.ranked.map((record) => record.id)).toEqual(
      blendMemoryRanking(records, hitOrder, NOW).map((record) => record.id)
    )
    expect(ranking.promotedIds).toEqual([])
    expect(ranking.changed).toBe(false)
  })

  it('treats a memory Jev did not score as zero instead of guessing', () => {
    const records = [mem('a'), mem('b')]
    const ranking = rankMemoriesWithJevRelevance({
      records,
      hitOrder: orderOf(records),
      relevanceById: new Map([['b', 0.9]]),
      limit: 2,
      nowTs: NOW,
      usualRanking: records
    })
    expect(ranking.ranked.map((record) => record.id)).toEqual(['b', 'a'])
  })

  it('cuts back to the asked limit and keeps superseded results at the tail in their own order', () => {
    const records = [
      mem('old_1', { is_superseded: 'y', superseded_by: 'cur_1' }),
      mem('cur_1'),
      mem('old_2', { is_superseded: 'y', superseded_by: 'cur_2' }),
      mem('cur_2'),
      mem('cur_3')
    ]
    const relevanceById = new Map([
      ['old_1', 0.2],
      ['cur_1', 0.1],
      ['old_2', 0.99],
      ['cur_2', 0.6],
      ['cur_3', 0.01]
    ])
    const ranking = rankMemoriesWithJevRelevance({
      records,
      hitOrder: orderOf(records),
      relevanceById,
      limit: 4,
      nowTs: NOW,
      usualRanking: [records[1], records[3], records[0], records[2]]
    })
    // cur_3 scores lowest and is the one cut; old_2 earns its place on merit but stays behind every current memory.
    expect(ranking.ranked.map((record) => record.id)).toEqual(['cur_2', 'cur_1', 'old_2', 'old_1'])
    expect(ranking.promotedIds).toEqual([])
  })

  it('summarizes what Jev said and what code did with it in one line', () => {
    const records = shortlist()
    const request = buildMemoryRerankRequest('dog name', records)!
    const relevanceById = new Map(records.map((record) => [record.id, record.id === 'the_answer' ? 0.97 : 0.05]))
    const ranking = rankMemoriesWithJevRelevance({
      records,
      hitOrder: orderOf(records),
      relevanceById,
      limit: 8,
      nowTs: NOW,
      usualRanking: usual(records, 8)
    })
    expect(summarizeMemoryRerank(request, relevanceById, ranking, 8)).toBe(
      'judged 20, returned 8 (asked 8); top the_answer 0.97; promoted 1 the usual search did not return → order changed'
    )
  })
})

describe('computeMemoryRerank', () => {
  const RECORDS = [mem('a', { content: 'Josh prefers Geist Sans.' }), mem('b', { content: "Josh's dog is named Biscuit." })]

  function fakeClient(outcome?: Partial<TypesafeCallOutcome>): TypesafeClient & { calls: TypesafeSystemOneRequest[] } {
    const calls: TypesafeSystemOneRequest[] = []
    return {
      calls,
      async systemOne(request) {
        calls.push(request as TypesafeSystemOneRequest)
        return {
          status: 'ok',
          response: {
            model: 'jev-1.13.0',
            answers: { rel_m1: { type: 'noul', noul: 0.04 }, rel_m2: { type: 'noul', noul: 0.96 } },
            usage: { inputTokens: 210, outputTokens: 12 }
          },
          latencyMs: 188,
          attempts: 1,
          deadlineHit: false,
          httpStatus: 200,
          requestChars: 640,
          ...outcome
        } as never
      }
    }
  }

  it('asks nothing and writes no record when the agent switch is off', async () => {
    const client = fakeClient()
    const outcome = await computeMemoryRerank({ userId: 'josh', agent: AGENT_OFF, query: 'dog name', records: RECORDS, client })
    expect(client.calls).toHaveLength(0)
    expect(outcome).toEqual({ relevanceById: null, request: null, record: null })
  })

  it('makes one call under its own tool-lane deadline and returns a probability per memory id', async () => {
    const client = fakeClient()
    const outcome = await computeMemoryRerank({ userId: 'josh', agent: AGENT_ON, query: 'dog name', records: RECORDS, client })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toMatchObject({
      apiKey: 'user-key',
      model: 'jev-1.13.0',
      deadlineMs: MEMORY_RERANK_LIMITS.deadlineMs,
      state: { query: 'dog name', memories: { m1: 'Josh prefers Geist Sans.', m2: "Josh's dog is named Biscuit." } }
    })
    expect(MEMORY_RERANK_LIMITS.deadlineMs).toBe(2000)
    expect(outcome.relevanceById && Array.from(outcome.relevanceById.entries())).toEqual([
      ['a', 0.04],
      ['b', 0.96]
    ])
    expect(outcome.record).toMatchObject({
      feature: 'memory_rerank',
      status: 'ok',
      model: 'jev-1.13.0',
      latencyMs: 188,
      usage: { inputTokens: 210, outputTokens: 12 },
      questionCount: 2
    })
  })

  it('makes no call with the master switch off (DL-120-11), whatever the agent switch says', async () => {
    configState.config = { ...configState.config, enabled: false }
    const fetchImpl = vi.fn<TypesafeFetch>()
    const outcome = await computeMemoryRerank({
      userId: 'josh',
      agent: AGENT_ON,
      query: 'dog name',
      records: RECORDS,
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null, sleep: async () => {} })
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(outcome.relevanceById).toBeNull()
    expect(outcome.record).toMatchObject({ feature: 'memory_rerank', status: 'unavailable', reason: 'master_off' })
  })

  it('reports a missed deadline as a record with no relevance, so the usual ranking stands', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    )
    const outcome = await computeMemoryRerank({
      userId: 'josh',
      agent: AGENT_ON,
      query: 'dog name',
      records: RECORDS,
      client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null, now: (() => { let t = 0; return () => (t += 1500) })() })
    })
    expect(outcome.relevanceById).toBeNull()
    expect(outcome.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })
  })

  it('never half-trusts an answer set: one missing probability means the usual ranking, and the row says why', async () => {
    const client = fakeClient({
      response: { model: 'jev-1.13.0', answers: { rel_m1: { type: 'noul', noul: 0.5 } }, usage: null }
    } as never)
    const outcome = await computeMemoryRerank({ userId: 'josh', agent: AGENT_ON, query: 'dog name', records: RECORDS, client })
    expect(outcome.relevanceById).toBeNull()
    expect(outcome.record?.status).toBe('ok')
    expect(outcome.record?.decision).toBe('an answer was missing → usual ranking')
  })
})
