// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryRecord } from '../memoryTypes'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'

/** BL-444: ranking arithmetic and the real search op over controlled index hits.
 * The default Redis fake stores full records; index/embedding boundaries are injected.
 * This does not exercise FT.HYBRID, a live embedder, or a live Judge Juice call.
 */
const index = vi.hoisted(() => ({
  hits: [] as { key: string; score: number }[],
  masterEnabled: false
}))
vi.mock('../memoryIndex', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryIndex')>()
  return {
    ...original,
    hybridSearchMemories: vi.fn(async () => index.hits),
    hybridSearchSegments: vi.fn(async () => [])
  }
})
vi.mock('../memoryEmbedder', async (importOriginal) => ({
  ...await importOriginal<typeof import('../memoryEmbedder')>(),
  createMemoryEmbedderAsync: vi.fn(async () => ({ embedQuery: async () => [1, 0] }))
}))
vi.mock('../../typesafe/typesafeConfig', () => ({
  getTypesafeConfig: vi.fn(async () => ({
    enabled: index.masterEnabled, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000,
    inChatWaitMs: 750, screenIncomingText: false, updatedAt: null
  }))
}))

import { redis } from '$lib/server/redis'
import { blendMemoryRanking } from '../memoryRecall'
import { searchMemoriesOp } from '../memoryTools'
import { hybridSearchMemories } from '../memoryIndex'

useRedisTestServer()
const NOW = Date.UTC(2026, 9, 6, 12)
const DAY = 86_400_000
const AGENT = 'bl444-agent'
const USER = 'bl444-user'

function memory(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, agent_id: AGENT, user_id: USER, lane: 'ltm', content: `Memory ${id}`,
    importance: 1, event_at: null, event_ts: null,
    saved_at: new Date(NOW - 180 * DAY).toISOString(), saved_ts: NOW - 180 * DAY,
    is_superseded: 'n', provenance: [], visibility: 'normal', embedding: [],
    embedding_model: 'test', schema_version: 1, ...overrides
  }
}

function group(prefix: string, superseded: boolean): MemoryRecord[] {
  const fields = { is_superseded: superseded ? 'y' as const : 'n' as const }
  return [
    memory(`${prefix}-a`, fields), memory(`${prefix}-c`, fields),
    memory(`${prefix}-b`, { ...fields, importance: 10, saved_ts: NOW }),
    memory(`${prefix}-d`, fields)
  ]
}
const ids = (records: MemoryRecord[]) => records.map((record) => record.id)

beforeEach(() => { index.hits = []; index.masterEnabled = false; vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe('BL-444 group-local memory ranking', () => {
  it.each([false, true])('balances freshness and importance in an interleaved group (superseded=%s)', (superseded) => {
    const records = group('g', superseded)
    const hitOrder = new Map(records.map((record, i) => [record.id, i * 2 + Number(superseded)]))
    // A fresh, important third hit outweighs the first old, unimportant hit.
    expect(ids(blendMemoryRanking(records, hitOrder, NOW))).toEqual(['g-b', 'g-a', 'g-c', 'g-d'])
  })

  it('keeps the complete dense blend exact, including its optional fourth term', () => {
    const records = group('g', false)
    const hitOrder = new Map(records.map((record, i) => [record.id, i]))
    const scores = new Map([['g-a', 0.91], ['g-b', 0.1], ['g-c', 0.2], ['g-d', 0.3]])
    for (const judged of [false, true]) {
      // Independent existing formula, not a replay of the new rank normalization.
      const expected = records.map((record, rank) => ({ record, rank, score:
        0.55 * (1 - rank / records.length) +
        0.25 * Math.exp(-Math.LN2 * ((NOW - record.saved_ts) / DAY) / 14) +
        0.2 * ((record.importance - 1) / 9) + (judged ? scores.get(record.id)! : 0)
      })).sort((a, b) => b.score - a.score || a.rank - b.rank || a.record.id.localeCompare(b.record.id))
      expect(blendMemoryRanking(records, hitOrder, NOW,
        judged ? { weight: 1, scoreById: scores } : undefined)).toEqual(expected.map((entry) => entry.record))
    }
  })

  it('ignores absent stored hits in a sparse Judge Juice pool without changing the fourth-term weight', () => {
    const records = group('g', false)
    const sparse = new Map([['missing-1', 0], ['g-a', 1], ['g-c', 3], ['missing-2', 4], ['g-b', 7], ['g-d', 9]])
    const dense = new Map(records.map((record, i) => [record.id, i]))
    const judged = { weight: 1, scoreById: new Map(records.map((record) => [record.id, 0.4])) }
    expect(ids(blendMemoryRanking(records, sparse, NOW, judged))).toEqual(['g-b', 'g-a', 'g-c', 'g-d'])
    expect(blendMemoryRanking(records, sparse, NOW, judged)).toEqual(blendMemoryRanking(records, dense, NOW, judged))
  })

  it('preserves original-rank/id ties, missing-ID fallback, empty input and inputs themselves', () => {
    const records = Object.freeze([memory('z'), memory('a'), memory('missing')])
    const hitOrder = new Map([['z', 0], ['a', 0]])
    const before = JSON.stringify(records)
    const orderBefore = [...hitOrder]
    expect(ids(blendMemoryRanking(records as MemoryRecord[], hitOrder, NOW))).toEqual(['a', 'z', 'missing'])
    expect(blendMemoryRanking([], hitOrder, NOW)).toEqual([])
    expect(JSON.stringify(records)).toBe(before)
    expect([...hitOrder]).toEqual(orderBefore)
  })

  it.each([false, true])('the actual search op keeps current groups first and corrected usual ranking on fallback (agent rerank=%s)', async (rerank) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    await redis.json.set(`agent:${AGENT}`, '$', {
      id: AGENT, user_id: USER, memory_enabled: true, jev_juice_memory_rerank: rerank
    } as never)
    const current = group('current', false)
    const superseded = group('old', true)
    const mixed = current.flatMap((record, i) => [record, superseded[i]])
    for (const record of mixed) {
      await redis.json.set(`memory:${AGENT}:${record.id}`, '$', record as never)
    }
    index.hits = mixed.map((record) => ({ key: `memory:${AGENT}:${record.id}`, score: 1 }))
    const systemOne = vi.fn(async () => { throw new Error('Master OFF must not call Judge Juice') })
    const result = await searchMemoriesOp({ userId: USER, agentId: AGENT, sessionId: null,
      typesafeClient: { systemOne } }, { query: 'memory facts', limit: 8 })
    expect(result.results.map((record) => record.id)).toEqual([
      'current-b', 'current-a', 'current-c', 'current-d', 'old-b', 'old-a', 'old-c', 'old-d'
    ])
    expect(result.results.slice(4).every((record) => record.superseded)).toBe(true)
    expect(result.totalReturned).toBe(8)
    expect(result.results.every((record) => !('jev_relevance' in record))).toBe(true)
    expect(systemOne).not.toHaveBeenCalled()
    expect(vi.mocked(hybridSearchMemories).mock.calls.map(([arg]) => arg)).toEqual([
      { agentId: AGENT, query: 'memory facts', vector: [1, 0], limit: 8, filters: {} },
      ...(rerank ? [{ agentId: AGENT, query: 'memory facts', vector: [1, 0], limit: 20, filters: {}, candidatesPerLeg: 20 }] : [])
    ])
    if (rerank) expect(result.note).toContain('the order is the usual ranking')
    else expect(result.note).not.toContain('Judge Juice')
  })
})
