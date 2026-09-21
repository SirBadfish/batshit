// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypesafeConfig } from '$lib/types/typesafe'
import type { TypesafeCallOutcome, TypesafeClient, TypesafeSystemOneRequest } from '../../typesafe/typesafeClient'
import type { MemoryRecord } from '../memoryTypes'

/**
 * SA-120 P4b — recall by meaning: request shape, the floor at its exact boundary, the cap,
 * and the orchestrator against a fake client and a fake pre-filter — the agent switch, the
 * DL-120-11 master-off pin (no call AND no pre-filter), a pre-filter failure, a pre-filter
 * that eats the budget, the shared deadline, and a Jev miss. No network, no Redis: the
 * real pre-filter and the recall engine's handling run in the memory lane
 * (semanticRecallPrefilter.test.ts, memoryRecall.test.ts).
 */

const retrieve = vi.hoisted(() => vi.fn<(service: string, userId: string) => Promise<string | null>>())
const dynamicPrivateEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }))
const configState = vi.hoisted(() => ({
  config: { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null } as TypesafeConfig
}))

vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: { retrieve } }))
vi.mock('$env/dynamic/private', () => dynamicPrivateEnv)
vi.mock('../../typesafe/typesafeConfig', () => ({ getTypesafeConfig: vi.fn(async () => configState.config) }))

import {
  SEMANTIC_RECALL_LIMITS,
  SEMANTIC_RECALL_QUESTIONS,
  SEMANTIC_RECALL_THRESHOLDS,
  buildSemanticRecallRequest,
  clipSemanticRecallMessage,
  computeSemanticRecall,
  decideSemanticRecall
} from '../semanticRecall.jev'

function mem(id: string, content = `memory ${id}`): MemoryRecord {
  return {
    id,
    agent_id: 'agent-1',
    user_id: 'josh',
    lane: 'ltm',
    content,
    importance: 5,
    event_at: null,
    event_ts: null,
    saved_at: '2026-08-01T00:00:00.000Z',
    saved_ts: Date.UTC(2026, 7, 1),
    is_superseded: 'n',
    provenance: [{ session_id: 's1', source: 'agent' }],
    visibility: 'normal',
    embedding: [],
    embedding_model: 'test',
    schema_version: 1
  } as MemoryRecord
}

const AGENT_ON = { id: 'agent-1', user_id: 'josh', name: 'Lucy', memory_enabled: true, jev_juice_memory_recall: true }
const AGENT_OFF = { id: 'agent-1', user_id: 'josh', name: 'Lucy', memory_enabled: true }
const RECORDS = [mem('mem_a', 'Josh is allergic to shellfish.'), mem('mem_b', 'Josh prefers Geist Sans.'), mem('mem_c', 'Josh plays bass.')]

function noulAnswers(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([key, noul]) => [`rel_${key}`, { type: 'noul', noul }]))
}

function fakeClient(
  answers: Record<string, unknown>,
  outcome?: Partial<TypesafeCallOutcome>
): TypesafeClient & { calls: TypesafeSystemOneRequest[] } {
  const calls: TypesafeSystemOneRequest[] = []
  return {
    calls,
    async systemOne(request) {
      calls.push(request as TypesafeSystemOneRequest)
      return {
        status: 'ok',
        response: { model: 'jev-1.13.0', answers, usage: { inputTokens: 640, outputTokens: 30 } },
        latencyMs: 212,
        attempts: 1,
        deadlineHit: false,
        httpStatus: 200,
        requestChars: 1900,
        ...outcome
      } as never
    }
  }
}

/** A clock the test moves by hand, so the shared 750 ms budget is exact. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

beforeEach(() => {
  retrieve.mockReset()
  retrieve.mockResolvedValue('user-key')
  dynamicPrivateEnv.env = {}
  configState.config = { enabled: true, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000, inChatWaitMs: 750, screenIncomingText: false, updatedAt: null }
})

describe('buildSemanticRecallRequest', () => {
  it('asks one Noul per candidate over a state of the message and short-keyed memory texts', () => {
    const built = buildSemanticRecallRequest('  what snack should\nI bring?  ', RECORDS)
    expect(built?.state).toEqual({
      message: 'what snack should I bring?',
      memories: { m1: 'Josh is allergic to shellfish.', m2: 'Josh prefers Geist Sans.', m3: 'Josh plays bass.' }
    })
    expect(Object.keys(built?.questions ?? {})).toEqual(['rel_m1', 'rel_m2', 'rel_m3'])
    expect(built?.questions.rel_m1).toEqual({
      type: 'noul',
      instructions: SEMANTIC_RECALL_QUESTIONS.relevance.instructions('m1'),
      criteria: SEMANTIC_RECALL_QUESTIONS.relevance.criteria
    })
    expect(String(built?.questions.rel_m1.instructions)).toContain('`memories.m1`')
    expect(String(built?.questions.rel_m1.instructions)).toContain('`message`')
    // Real memory ids stay home.
    expect(JSON.stringify({ state: built?.state, questions: built?.questions })).not.toContain('mem_a')
  })

  it('has nothing to ask without a message or a candidate, and caps both', () => {
    expect(buildSemanticRecallRequest('   ', RECORDS)).toBeNull()
    expect(buildSemanticRecallRequest('hello', [])).toBeNull()
    // One candidate IS worth asking about: this lane decides in or out, not an order.
    expect(buildSemanticRecallRequest('hello', [RECORDS[0]])?.candidates).toHaveLength(1)
    const many = Array.from({ length: 50 }, (_, index) => mem(`mem_${index}`))
    expect(buildSemanticRecallRequest('hello', many)?.candidates).toHaveLength(SEMANTIC_RECALL_LIMITS.maxCandidates)
    expect(clipSemanticRecallMessage('x'.repeat(9000)).length).toBe(SEMANTIC_RECALL_LIMITS.maxMessageChars)
  })
})

describe('decideSemanticRecall', () => {
  const request = buildSemanticRecallRequest('what snack should I bring?', RECORDS)!

  it('brings in what clears the floor, best first, and says so in one line', () => {
    const decision = decideSemanticRecall(noulAnswers({ m1: 0.94, m2: 0.05, m3: 0.66 }), request)
    expect(decision.recalls).toEqual([
      { id: 'mem_a', probability: 0.94 },
      { id: 'mem_c', probability: 0.66 }
    ])
    expect(decision.summary).toBe('judged 3; top mem_a 0.94, mem_c 0.66, mem_b 0.05 → brought in 2 (floor 0.60)')
  })

  it('holds the floor at its exact boundary', () => {
    expect(SEMANTIC_RECALL_THRESHOLDS.relevanceFloor).toBe(0.6)
    const at = decideSemanticRecall(noulAnswers({ m1: 0.6, m2: 0.59999, m3: 0.1 }), request)
    expect(at.recalls).toEqual([{ id: 'mem_a', probability: 0.6 }])
    const under = decideSemanticRecall(noulAnswers({ m1: 0.59, m2: 0.4, m3: 0.1 }), request)
    expect(under.recalls).toEqual([])
    expect(under.summary).toContain('none at or over 0.60 → nothing brought in')
  })

  it('caps how many come in per message and says how many were over the floor', () => {
    expect(SEMANTIC_RECALL_THRESHOLDS.maxInserts).toBe(3)
    const five = [1, 2, 3, 4, 5].map((n) => mem(`mem_${n}`))
    const wide = buildSemanticRecallRequest('hello', five)!
    const decision = decideSemanticRecall(noulAnswers({ m1: 0.7, m2: 0.95, m3: 0.8, m4: 0.9, m5: 0.75 }), wide)
    expect(decision.recalls.map((recall) => recall.id)).toEqual(['mem_2', 'mem_4', 'mem_3'])
    expect(decision.summary).toContain('5 over the floor, cap 3')
  })

  it('never inserts a candidate whose answer is missing or unreadable, and clamps the rest', () => {
    const decision = decideSemanticRecall(
      { rel_m1: { type: 'noul', noul: 1.7 }, rel_m2: { type: 'choice', choice: 'x' } },
      request
    )
    expect(decision.recalls).toEqual([{ id: 'mem_a', probability: 1 }])
    expect(decision.readings.map((reading) => reading.probability)).toEqual([1, null, null])
  })
})

describe('computeSemanticRecall', () => {
  it('searches nothing, asks nothing, and writes no record when the agent switch is off', async () => {
    const client = fakeClient({})
    const prefilter = vi.fn(async () => RECORDS)
    const outcome = await computeSemanticRecall({ userId: 'josh', agent: AGENT_OFF, message: 'snack?', excludeIds: [], client, prefilter })
    expect(prefilter).not.toHaveBeenCalled()
    expect(client.calls).toHaveLength(0)
    expect(outcome).toEqual({ recalls: [], record: null, note: null, decision: null })
  })

  it('pre-filters, makes one call with what is left of the compile-lane budget, and returns the winners', async () => {
    const time = clock()
    const client = fakeClient(noulAnswers({ m1: 0.94, m2: 0.05, m3: 0.3 }))
    const prefilter = vi.fn(async () => {
      time.advance(120)
      return RECORDS
    })
    const outcome = await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'what snack should I bring?',
      excludeIds: ['mem_z'],
      client,
      prefilter,
      now: time.now
    })
    expect(prefilter).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'josh', agentId: 'agent-1', message: 'what snack should I bring?', excludeIds: ['mem_z'] })
    )
    expect(client.calls).toHaveLength(1)
    // The call gets what the pre-filter left of the user's In-Chat Wait Limit (SA-120 P8).
    expect(client.calls[0].deadlineMs).toBe(configState.config.inChatWaitMs - 120)
    expect(client.calls[0].deadlineMs).toBe(630)
    expect(client.calls[0].state).toEqual({
      message: 'what snack should I bring?',
      memories: { m1: 'Josh is allergic to shellfish.', m2: 'Josh prefers Geist Sans.', m3: 'Josh plays bass.' }
    })
    expect(outcome.recalls).toEqual([{ id: 'mem_a', probability: 0.94 }])
    expect(outcome.note).toBeNull()
    expect(outcome.record).toMatchObject({
      feature: 'memory_recall',
      status: 'ok',
      questionCount: 3,
      usage: { inputTokens: 640, outputTokens: 30 },
      detail: 'pre-filter 120 ms, 3 candidates',
      decision: 'judged 3; top mem_a 0.94, mem_c 0.30, mem_b 0.05 → brought in 1 (floor 0.60)'
    })
  })

  it('with the master switch off (DL-120-11) makes no call and does not even pre-filter', async () => {
    configState.config = { ...configState.config, enabled: false }
    const client = fakeClient({})
    const prefilter = vi.fn(async () => RECORDS)
    const outcome = await computeSemanticRecall({ userId: 'josh', agent: AGENT_ON, message: 'snack?', excludeIds: [], client, prefilter })
    expect(prefilter).not.toHaveBeenCalled()
    expect(client.calls).toHaveLength(0)
    expect(outcome.recalls).toEqual([])
    expect(outcome.record).toMatchObject({ feature: 'memory_recall', status: 'unavailable', reason: 'master_off' })
    expect(outcome.note).toMatchObject({ feature: 'memory_recall', status: 'unavailable', reason: 'master_off' })
  })

  it('with no key does not pre-filter either', async () => {
    retrieve.mockResolvedValue(null)
    const prefilter = vi.fn(async () => RECORDS)
    const outcome = await computeSemanticRecall({ userId: 'josh', agent: AGENT_ON, message: 'snack?', excludeIds: [], client: fakeClient({}), prefilter })
    expect(prefilter).not.toHaveBeenCalled()
    expect(outcome.note).toMatchObject({ reason: 'no_key' })
  })

  it('asks nothing when no long-term memory is near the message', async () => {
    const client = fakeClient({})
    const outcome = await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'snack?',
      excludeIds: [],
      client,
      prefilter: async () => []
    })
    expect(client.calls).toHaveLength(0)
    expect(outcome).toEqual({ recalls: [], record: null, note: null, decision: null })
  })

  it('a pre-filter failure is a visible local error, never a thrown send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = fakeClient({})
    const outcome = await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'snack?',
      excludeIds: [],
      client,
      prefilter: async () => {
        throw new Error('Memory index batshit_memory_idx is missing')
      }
    })
    errorSpy.mockRestore()
    expect(client.calls).toHaveLength(0)
    expect(outcome.recalls).toEqual([])
    expect(outcome.record).toMatchObject({
      feature: 'memory_recall',
      status: 'error',
      reason: 'local_error',
      detail: 'memory pre-filter failed: Memory index batshit_memory_idx is missing'
    })
    expect(outcome.note).toMatchObject({ status: 'error', reason: 'local_error' })
  })

  it('a pre-filter that eats the budget means no call, reported as a missed deadline', async () => {
    const time = clock()
    const client = fakeClient({})
    const budget = configState.config.inChatWaitMs - SEMANTIC_RECALL_LIMITS.minCallBudgetMs
    const slow = await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'snack?',
      excludeIds: [],
      client,
      prefilter: async () => {
        time.advance(budget + 1)
        return RECORDS
      },
      now: time.now
    })
    expect(client.calls).toHaveLength(0)
    expect(slow.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })
    expect(slow.record?.detail).toContain(`took ${budget + 1} ms of the ${configState.config.inChatWaitMs} ms In-Chat Wait Limit`)
    expect(slow.note).toMatchObject({ reason: 'deadline' })

    // Exactly at the boundary the call is still made, with exactly the minimum budget.
    const edge = clock()
    await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'snack?',
      excludeIds: [],
      client,
      prefilter: async () => {
        edge.advance(budget)
        return RECORDS
      },
      now: edge.now
    })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].deadlineMs).toBe(SEMANTIC_RECALL_LIMITS.minCallBudgetMs)
  })

  it('SA-120 P8: a raised In-Chat Wait Limit reaches the very next send, pre-filter and call together', async () => {
    configState.config = { ...configState.config, inChatWaitMs: 5000 }
    const time = clock()
    const client = fakeClient({})
    await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'snack?',
      excludeIds: [],
      client,
      prefilter: async () => {
        // A slow pre-filter (a cold embedder) that would have eaten the whole 750 ms default.
        time.advance(900)
        return RECORDS
      },
      now: time.now
    })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].deadlineMs).toBe(4100)
  })

  it('a Jev miss brings nothing in and leaves a note', async () => {
    const client = fakeClient({}, { status: 'unavailable', reason: 'deadline', deadlineHit: true, response: undefined } as never)
    const outcome = await computeSemanticRecall({
      userId: 'josh',
      agent: AGENT_ON,
      message: 'snack?',
      excludeIds: [],
      client,
      prefilter: async () => RECORDS
    })
    expect(outcome.recalls).toEqual([])
    expect(outcome.record).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true })
    expect(outcome.record?.detail).toContain('3 candidates')
    expect(outcome.note).toMatchObject({ feature: 'memory_recall', reason: 'deadline' })
  })
})
