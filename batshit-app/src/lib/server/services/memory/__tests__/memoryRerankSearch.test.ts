import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'
import type { TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeClient, TypesafeSystemOneRequest } from '../../typesafe/typesafeClient'

/**
 * SA-120 P4a — `searchMemoriesOp` with the Jev Juice rerank wired in, against the real
 * Redis 8 search index (dedicated db0 lane, `npm run test:memory`).
 *
 * Three things only real FT.HYBRID can prove:
 *  1. switch OFF returns today's bytes: ONE search with the asked limit and Redis's default
 *     legs, no Jev call, and a result equal to an independent replay of today's ranking over
 *     the very hits Redis returned;
 *  2. the wider search's `KNN K` / `RRF WINDOW` arguments are accepted by the pinned Redis
 *     and really widen the vector leg past its default of ten;
 *  3. switch ON with an answering Jev lifts a memory the usual search did not return onto
 *     the page, and a Jev miss returns exactly the switch-OFF rows.
 *
 * The embedder is the same deterministic fake the other memory suites use; the Jev client
 * is a fake object handed in through the op's test seam. No network.
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

// A pass-through spy: the real search runs, and the suite can read what was asked and returned.
vi.mock('../memoryIndex', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryIndex')>()
  return { ...original, hybridSearchMemories: vi.fn(original.hybridSearchMemories) }
})

const configState = vi.hoisted(() => ({
  config: { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
}))
vi.mock('../../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve: vi.fn(async () => 'user-key') } }))

import { ensureMemoryIndexes, hybridSearchMemories, setMemoryConfig } from '../memoryIndex'
import { fetchMemoriesByKeys } from '../memoryStore'
import { blendMemoryRanking } from '../memoryRecall'
import { saveMemoryOp, searchMemoriesOp, supersedeMemoryOp, toMemorySummary } from '../memoryTools'
import { redis } from '$lib/server/redis'

useMemorySearchTestServer()

const USER = 'user_test'
const SESSION = 'sess_rerank'
const USUAL_NOTE_END = 'conversation stretches — recall their ids to receive the full episode summary.'

let agentCounter = 0
async function freshAgent(rerank: boolean): Promise<string> {
  agentCounter += 1
  const agentId = `agent_rerank_${agentCounter}`
  await redis.json.set(`agent:${agentId}`, '$', {
    id: agentId,
    user_id: USER,
    name: `Rerank ${agentCounter}`,
    memory_enabled: true,
    ...(rerank ? { jev_juice_memory_rerank: true } : {})
  } as never)
  return agentId
}

async function setRerank(agentId: string, enabled: boolean) {
  await redis.json.set(`agent:${agentId}`, '$.jev_juice_memory_rerank', enabled as never)
}

/** Twenty-four memories that all share the query's words, so the lexical leg fills the fused list. */
async function seed(agentId: string): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < 24; index++) {
    const saved = await saveMemoryOp(
      { userId: USER, agentId, sessionId: SESSION },
      { lane: 'ltm', content: `Josh project note ${index}: detail ${'z'.repeat((index % 7) + 1)} about topic ${index * 7}` }
    )
    ids.push(saved.saved.id)
  }
  return ids
}

function fakeJev(scoreFor: (text: string) => number): TypesafeClient & { calls: TypesafeSystemOneRequest[] } {
  const calls: TypesafeSystemOneRequest[] = []
  return {
    calls,
    async systemOne(request) {
      calls.push(request as TypesafeSystemOneRequest)
      const memories = (request.state as { memories: Record<string, string> }).memories
      const answers: Record<string, unknown> = {}
      for (const [key, text] of Object.entries(memories)) answers[`rel_${key}`] = { type: 'noul', noul: scoreFor(text) }
      return {
        status: 'ok',
        response: { model: 'jev-1.13.0', answers, usage: { inputTokens: 900, outputTokens: 40 } },
        latencyMs: 201,
        attempts: 1,
        deadlineHit: false,
        httpStatus: 200,
        requestChars: 2400
      } as never
    }
  }
}

function missingJev(): TypesafeClient & { calls: number } {
  const client = {
    calls: 0,
    async systemOne() {
      client.calls += 1
      return {
        status: 'unavailable',
        reason: 'deadline',
        latencyMs: 2000,
        attempts: 1,
        deadlineHit: true,
        requestChars: 2400
      } as never
    }
  }
  return client
}

/** For every search that must not reach Jev: a regression fails loudly here instead of calling the network. */
const neverJev: TypesafeClient = {
  async systemOne() {
    throw new Error('this search must not call Jev')
  }
}

const searchSpy = vi.mocked(hybridSearchMemories)

describe.runIf(memorySearchLaneActive())('memory search rerank (dedicated Redis 8 db0)', () => {
  beforeEach(async () => {
    configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
    searchSpy.mockClear()
    await setMemoryConfig({
      lane: 'local-ai',
      modelId: 'local-ai:test-embedder',
      localAi: { baseUrl: 'http://127.0.0.1:9/v1', modelName: 'test-embedder', dims: 8 }
    })
    await ensureMemoryIndexes()
  })

  it('switch OFF: the usual shortlist, no Jev call, and today\'s bytes', async () => {
    const agentId = await freshAgent(false)
    await seed(agentId)
    // One superseded pair that both legs rank at the very top (the content IS the query), so
    // the demoted tail is part of the pinned bytes whatever order Redis breaks ties in.
    const replaced = await saveMemoryOp({ userId: USER, agentId, sessionId: SESSION }, { lane: 'ltm', content: 'Josh project note' })
    const winner = await saveMemoryOp({ userId: USER, agentId, sessionId: SESSION }, { lane: 'ltm', content: 'Josh project note!' })
    await supersedeMemoryOp(
      { userId: USER, agentId, sessionId: SESSION },
      { memoryId: winner.saved.id, supersedes: [replaced.saved.id] }
    )
    searchSpy.mockClear()

    const jev = fakeJev(() => 0.99)
    const before = Date.now()
    const result = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: jev },
      { query: 'Josh project note', limit: 8 }
    )

    expect(jev.calls).toHaveLength(0)
    expect(searchSpy).toHaveBeenCalledTimes(1)
    expect(searchSpy.mock.calls[0][0].limit).toBe(8)
    expect(searchSpy.mock.calls[0][0].candidatesPerLeg).toBeUndefined()

    // An independent replay of today's ranking over the very hits Redis returned.
    const hits = await searchSpy.mock.results[0].value
    const records = await fetchMemoriesByKeys(hits.map((hit: { key: string }) => hit.key))
    const hitOrder = new Map<string, number>(hits.map((hit: { key: string }, index: number) => [hit.key.split(':').pop() as string, index]))
    const expected = [
      ...blendMemoryRanking(records.filter((record) => record.is_superseded !== 'y'), hitOrder, before),
      ...blendMemoryRanking(records.filter((record) => record.is_superseded === 'y'), hitOrder, before)
    ].map(toMemorySummary)
    expect(JSON.stringify(result.results)).toBe(JSON.stringify(expected))
    expect(result.results.some((row) => 'jev_relevance' in row)).toBe(false)
    expect(result.results.at(-1)).toMatchObject({ id: replaced.saved.id, superseded: true, superseded_by: winner.saved.id })
    // The note is today's note to the last character: nothing about Jev Juice.
    expect(result.note.endsWith(USUAL_NOTE_END)).toBe(true)
    expect(result.note).not.toContain('Jev Juice')
  })

  it('the wider search really widens the vector leg on the pinned Redis', async () => {
    const agentId = await freshAgent(false)
    await seed(agentId)
    const vector = new Array<number>(8).fill(0).map((_, index) => (index === 0 ? 1 : 0.1))
    // No word of this query is in any memory, so only the vector leg can answer.
    const usual = await hybridSearchMemories({ agentId, query: 'qqqq', vector, limit: 20 })
    const wide = await hybridSearchMemories({ agentId, query: 'qqqq', vector, limit: 20, candidatesPerLeg: 20 })
    expect(usual).toHaveLength(10)
    expect(wide).toHaveLength(20)
    expect(wide.slice(0, 10).map((hit) => hit.key)).toEqual(usual.map((hit) => hit.key))
  })

  it('switch ON: the usual search, a wider one, one Jev call, a memory lifted onto the page, and the agent told', async () => {
    const agentId = await freshAgent(false)
    await seed(agentId)

    // Learn what the usual search returns and what the wider one adds, then let Jev favour one of the extras.
    const usual = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: neverJev },
      { query: 'Josh project note', limit: 5 }
    )
    const usualIds = usual.results.map((row) => row.id)
    const widerCall = { ...searchSpy.mock.calls[0][0], limit: 20, candidatesPerLeg: 20 }
    const wideHits = await hybridSearchMemories(widerCall)
    const extraKey = wideHits.map((hit) => hit.key).find((key) => !usualIds.includes(key.split(':').pop() as string)) as string
    expect(extraKey).toBeTruthy()
    const buriedId = extraKey.split(':').pop() as string
    const [buried] = await fetchMemoriesByKeys([extraKey])

    await setRerank(agentId, true)
    searchSpy.mockClear()
    const jev = fakeJev((text) => (text === buried.content ? 0.97 : 0.04))
    const result = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: jev },
      { query: 'Josh project note', limit: 5 }
    )

    // Today's search first, untouched; then the wider one for Jev to judge.
    expect(searchSpy).toHaveBeenCalledTimes(2)
    expect(searchSpy.mock.calls[0][0]).toMatchObject({ limit: 5 })
    expect(searchSpy.mock.calls[0][0].candidatesPerLeg).toBeUndefined()
    expect(searchSpy.mock.calls[1][0]).toMatchObject({ limit: 20, candidatesPerLeg: 20 })
    expect(jev.calls).toHaveLength(1)
    expect(Object.keys(jev.calls[0].questions).length).toBeGreaterThanOrEqual(wideHits.length)
    expect((jev.calls[0].state as { query: string }).query).toBe('Josh project note')
    // Real memory ids never leave the machine.
    expect(JSON.stringify(jev.calls[0].state)).not.toContain(buriedId)

    expect(result.results).toHaveLength(5)
    expect(result.results[0].id).toBe(buriedId)
    expect(usualIds).not.toContain(buriedId)
    expect(result.results[0].jev_relevance).toBe(0.97)
    expect(result.results.slice(1).every((row) => row.jev_relevance === 0.04)).toBe(true)
    for (const row of result.results) {
      expect(row).not.toHaveProperty('content')
      expect(row).not.toHaveProperty('embedding')
    }
    expect(result.note).toContain('jev_relevance, 0 to 1, advisory')
  })

  it('switch ON but Jev misses: exactly the switch-OFF rows, and one honest sentence', async () => {
    const agentId = await freshAgent(false)
    await seed(agentId)
    const off = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: neverJev },
      { query: 'Josh project note', limit: 6 }
    )

    await setRerank(agentId, true)
    const jev = missingJev()
    const missed = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: jev },
      { query: 'Josh project note', limit: 6 }
    )
    expect(jev.calls).toBe(1)
    expect(JSON.stringify(missed.results)).toBe(JSON.stringify(off.results))
    expect(missed.note).toBe(
      `${off.note} Jev Juice did not rerank this search (TypeSafe did not answer in time.); the order is the usual ranking.`
    )

    // An answer set with one memory unjudged is never partly trusted: the OFF rows again.
    const partial = fakeJev(() => 0.99)
    const answerAll = partial.systemOne.bind(partial)
    partial.systemOne = (async (request: TypesafeSystemOneRequest) => {
      const outcome = (await answerAll(request as never)) as { response: { answers: Record<string, unknown> } }
      delete outcome.response.answers[Object.keys(outcome.response.answers)[0]]
      return outcome
    }) as never
    const half = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: partial },
      { query: 'Josh project note', limit: 6 }
    )
    expect(JSON.stringify(half.results)).toBe(JSON.stringify(off.results))
    expect(half.note).toBe(`${off.note} Jev Juice did not rerank this search (an answer was missing.); the order is the usual ranking.`)

    // Master switch OFF with the agent switch ON: no call at all (DL-120-11), same rows.
    configState.config = { ...configState.config, enabled: false }
    const masterOffJev = fakeJev(() => 0.99)
    const masterOff = await searchMemoriesOp(
      { userId: USER, agentId, sessionId: SESSION, typesafeClient: masterOffJev },
      { query: 'Josh project note', limit: 6 }
    )
    expect(masterOffJev.calls).toHaveLength(0)
    expect(JSON.stringify(masterOff.results)).toBe(JSON.stringify(off.results))
    expect(masterOff.note).toContain('Jev Juice is off in Settings → Admin.')
  })
})
