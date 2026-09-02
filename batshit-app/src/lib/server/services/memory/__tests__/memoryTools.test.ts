import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'

/**
 * SA-104 P3 — memory tool ops suite (dedicated Redis 8 db0 lane, npm run test:memory).
 *
 * The ops layer resolves its embedder from the stored config, so the embedder module is
 * mocked with the same deterministic 8-dim geometry the data-layer suite uses. Everything
 * else (records, FT indexes, hybrid search, linger queue) runs against the real instance.
 */

vi.mock('../memoryEmbedder', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryEmbedder')>()

  function normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
    return vector.map((v) => v / magnitude)
  }

  const KNOWN_VECTORS: Record<string, number[]> = {
    'Josh has an Irish Setter named Maggie': normalize([1, 0.1, 0, 0, 0, 0, 0, 0]),
    'what dog does Josh have': normalize([0.95, 0.15, 0, 0, 0, 0, 0, 0]),
    'Batshit runs Redis 8 with the JSON module': normalize([0, 0, 1, 0.1, 0, 0, 0, 0]),
    'The nap relieves context pressure between turns': normalize([0, 0, 0, 0, 1, 0.1, 0, 0])
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

  return {
    ...original,
    createMemoryEmbedder: () => ({
      modelId: 'local-ai:test-embedder@8',
      dims: 8,
      async embedDocuments(texts: string[]) {
        return texts.map((text) => fakeVector(text))
      },
      async embedQuery(text: string) {
        return fakeVector(text)
      }
    })
  }
})

import { ensureMemoryIndexes, setMemoryConfig } from '../memoryIndex'
import { getMemory } from '../memoryStore'
import { getMemoryLingerState } from '../memoryLinger'
import {
  MemoryToolError,
  deleteMemoryOp,
  listMemoriesOp,
  moveMemoryLaneOp,
  processInlineMemorySaves,
  recallMemoriesOp,
  requireMemoryEnabledAgent,
  saveMemoryOp,
  searchMemoriesOp,
  supersedeMemoryOp,
  unsupersedeMemoryOp,
  updateMemoryOp
} from '../memoryTools'
import { redis } from '$lib/server/redis'

const harness = useMemorySearchTestServer()

const USER = 'user_test'
const AGENT = 'agent_mem'
const AGENT_DISABLED = 'agent_nomem'
const SESSION = 'sess_tools'

function toolContext(overrides: Partial<{ agentId: string; sessionId: string | null }> = {}) {
  return {
    userId: USER,
    agentId: overrides.agentId ?? AGENT,
    sessionId: overrides.sessionId === undefined ? SESSION : overrides.sessionId
  }
}

let agentCounter = 0
async function freshAgent(): Promise<string> {
  agentCounter += 1
  const agentId = `agent_fresh_${agentCounter}`
  await redis.json.set(`agent:${agentId}`, '$', {
    id: agentId,
    user_id: USER,
    name: `Fresh ${agentCounter}`,
    memory_enabled: true
  } as never)
  return agentId
}

describe.runIf(memorySearchLaneActive())('memory tool ops (dedicated Redis 8 db0)', () => {
  beforeEach(async () => {
    await setMemoryConfig({
      lane: 'local-ai',
      modelId: 'local-ai:test-embedder',
      localAi: {
        baseUrl: 'http://127.0.0.1:9/v1',
        modelName: 'test-embedder',
        dims: 8
      }
    })
    await ensureMemoryIndexes()
    await redis.json.set(`agent:${AGENT}`, '$', {
      id: AGENT,
      user_id: USER,
      name: 'Memory Agent',
      memory_enabled: true
    } as never)
    await redis.json.set(`agent:${AGENT_DISABLED}`, '$', {
      id: AGENT_DISABLED,
      user_id: USER,
      name: 'Plain Agent',
      memory_enabled: false
    } as never)
  })

  describe('enablement gate (server-side belt and suspenders)', () => {
    it('refuses ops for a missing agent, a disabled agent, and a missing agent context', async () => {
      await expect(requireMemoryEnabledAgent(USER, 'agent_ghost')).rejects.toThrow(/not found/)
      await expect(requireMemoryEnabledAgent(USER, AGENT_DISABLED)).rejects.toThrow(
        /Memory is not enabled/
      )
      await expect(requireMemoryEnabledAgent(USER, '')).rejects.toThrow(/agent context/)
      await expect(requireMemoryEnabledAgent(USER, AGENT)).resolves.toMatchObject({ id: AGENT })
    })

    it('refuses ops for an agent owned by a different user', async () => {
      await redis.json.set('agent:agent_foreign', '$', {
        id: 'agent_foreign',
        user_id: 'someone_else',
        memory_enabled: true
      } as never)
      await expect(requireMemoryEnabledAgent(USER, 'agent_foreign')).rejects.toThrow(
        /does not belong/
      )
    })
  })

  describe('saveMemoryOp', () => {
    it('saves through the shared contract and returns a summary-first reference', async () => {
      const agentId = await freshAgent()
      const result = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie',
        gist: 'Maggie = Irish Setter',
        importance: 7
      })
      expect(result.saved.id).toMatch(/^mem_/)
      expect(result.saved.lane).toBe('ltm')
      expect(result.saved.gist).toBe('Maggie = Irish Setter')
      expect(result.saved.superseded).toBe(false)
      expect(result.saved).not.toHaveProperty('content')
      expect(result.saved).not.toHaveProperty('embedding')

      const record = await getMemory(agentId, result.saved.id)
      expect(record?.provenance).toEqual([
        { session_id: SESSION, source: 'agent' }
      ])
    })

    it('rejects invalid payloads and missing session context loudly', async () => {
      await expect(
        saveMemoryOp(toolContext(), { lane: 'stm', content: 'no triggers' })
      ).rejects.toThrow(/trigger_terms/)
      await expect(
        saveMemoryOp(toolContext({ sessionId: null }), { lane: 'ltm', content: 'x' })
      ).rejects.toThrow(/session context/)
      await expect(
        saveMemoryOp(toolContext({ agentId: AGENT_DISABLED }), { lane: 'ltm', content: 'x' })
      ).rejects.toThrow(/Memory is not enabled/)
    })

    it('chains save-time supersession and validates the target ids first', async () => {
      const agentId = await freshAgent()
      const original = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Batshit runs Redis 8 with the JSON module'
      })

      await expect(
        saveMemoryOp(toolContext({ agentId }), {
          lane: 'ltm',
          content: 'anything',
          supersedes: ['mem_missing']
        })
      ).rejects.toThrow(/does not exist/)

      const replacement = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'The nap relieves context pressure between turns',
        supersedes: [original.saved.id]
      })
      expect(replacement.superseded).toEqual([original.saved.id])

      const supersededRecord = await getMemory(agentId, original.saved.id)
      expect(supersededRecord?.is_superseded).toBe('y')
      expect(supersededRecord?.superseded_by).toBe(replacement.saved.id)
    })

    it('surfaces near-duplicates as a warning without blocking the save', async () => {
      const agentId = await freshAgent()
      const first = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie'
      })
      expect(first.nearDuplicates).toBeUndefined()

      const duplicate = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie'
      })
      expect(duplicate.saved.id).not.toBe(first.saved.id)
      expect(duplicate.nearDuplicates?.map((entry) => entry.id)).toContain(first.saved.id)
      expect(duplicate.note).toContain('supersede')

      const distinct = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Batshit runs Redis 8 with the JSON module'
      })
      expect(distinct.nearDuplicates).toBeUndefined()
    })
  })

  describe('searchMemoriesOp', () => {
    it('returns summary-first hybrid hits with superseded results demoted and flagged', async () => {
      const agentId = await freshAgent()
      const old = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie'
      })
      const current = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'what dog does Josh have',
        supersedes: [old.saved.id]
      })

      const result = await searchMemoriesOp(toolContext({ agentId }), {
        query: 'what dog does Josh have'
      })
      expect(result.results.length).toBeGreaterThanOrEqual(2)
      for (const summary of result.results) {
        expect(summary).not.toHaveProperty('content')
        expect(summary).not.toHaveProperty('embedding')
      }
      const ids = result.results.map((summary) => summary.id)
      expect(ids.indexOf(current.saved.id)).toBeLessThan(ids.indexOf(old.saved.id))
      const supersededRow = result.results.find((summary) => summary.id === old.saved.id)
      expect(supersededRow?.superseded).toBe(true)
      expect(supersededRow?.superseded_by).toBe(current.saved.id)
      expect(result.note).toContain('sys.memory.recall')

      const currentOnly = await searchMemoriesOp(toolContext({ agentId }), {
        query: 'what dog does Josh have',
        include_superseded: false
      })
      expect(currentOnly.results.map((summary) => summary.id)).not.toContain(old.saved.id)
    })

    it('keeps an older chosen winner ahead of a newer superseded duplicate', async () => {
      const agentId = await freshAgent()
      const olderCanonical = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie'
      })
      const newerDuplicate = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'what dog does Josh have'
      })
      await supersedeMemoryOp(toolContext({ agentId }), {
        memoryId: olderCanonical.saved.id,
        supersedes: [newerDuplicate.saved.id]
      })

      const result = await searchMemoriesOp(toolContext({ agentId }), {
        query: 'what dog does Josh have'
      })
      const ids = result.results.map((summary) => summary.id)
      expect(ids.indexOf(olderCanonical.saved.id)).toBeLessThan(
        ids.indexOf(newerDuplicate.saved.id)
      )
      expect(result.results.find((row) => row.id === newerDuplicate.saved.id)).toMatchObject({
        superseded: true,
        superseded_by: olderCanonical.saved.id
      })
      expect(result.note).toContain('timestamps do not decide the winner')
    })

    it('applies lane and saved-time range filters and validates inputs loudly', async () => {
      const agentId = await freshAgent()
      await saveMemoryOp(toolContext({ agentId }), {
        lane: 'stm',
        content: 'Josh has an Irish Setter named Maggie',
        trigger_terms: ['maggie']
      })
      await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Batshit runs Redis 8 with the JSON module'
      })

      const stmOnly = await searchMemoriesOp(toolContext({ agentId }), {
        query: 'Maggie Irish Setter',
        lane: 'stm'
      })
      expect(stmOnly.results.every((summary) => summary.lane === 'stm')).toBe(true)
      expect(stmOnly.results.length).toBeGreaterThan(0)

      const futureOnly = await searchMemoriesOp(toolContext({ agentId }), {
        query: 'Maggie Irish Setter',
        saved_from: '2099-01-01T00:00:00.000Z'
      })
      expect(futureOnly.results).toHaveLength(0)

      // P8 live find: bare dates are LOCAL calendar days — `_to` runs through the end of
      // that local day. Midnight-UTC semantics silently excluded every memory saved later
      // the same local day (a just-saved memory missed a saved_to of "today").
      const now = new Date()
      const localToday = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      ].join('-')
      const bareDateWindow = await searchMemoriesOp(toolContext({ agentId }), {
        query: 'Maggie Irish Setter',
        saved_from: '2000-01-01',
        saved_to: localToday
      })
      expect(bareDateWindow.results.length).toBeGreaterThan(0)

      await expect(
        searchMemoriesOp(toolContext({ agentId }), { query: 'x' })
      ).rejects.toThrow(/at least 2 characters/)
      await expect(
        searchMemoriesOp(toolContext({ agentId }), { query: 'ok', lane: 'bogus' })
      ).rejects.toThrow(/lane/)
      await expect(
        searchMemoriesOp(toolContext({ agentId }), { query: 'ok', saved_from: 'nope' })
      ).rejects.toThrow(/not a valid timestamp/)
    })
  })

  describe('list / update / move-lane / supersede / delete ops', () => {
    it('lists newest-first summaries with lane filtering', async () => {
      const agentId = await freshAgent()
      const first = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Batshit runs Redis 8 with the JSON module'
      })
      const second = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'awareness',
        content: 'The nap relieves context pressure between turns'
      })

      const all = await listMemoriesOp(toolContext({ agentId }), {})
      expect(all.results.map((summary) => summary.id)).toEqual([second.saved.id, first.saved.id])

      const awarenessOnly = await listMemoriesOp(toolContext({ agentId }), { lane: 'awareness' })
      expect(awarenessOnly.results.map((summary) => summary.id)).toEqual([second.saved.id])
    })

    it('updates fields, moves lanes deliberately, and guards stm moves without triggers', async () => {
      const agentId = await freshAgent()
      const saved = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie'
      })

      const updated = await updateMemoryOp(toolContext({ agentId }), {
        memoryId: saved.saved.id,
        importance: 9,
        gist: 'Maggie facts'
      })
      expect(updated.updated.importance).toBe(9)
      expect(updated.updated.gist).toBe('Maggie facts')

      await expect(
        updateMemoryOp(toolContext({ agentId }), { memoryId: saved.saved.id })
      ).rejects.toThrow(/at least one field/)

      await expect(
        moveMemoryLaneOp(toolContext({ agentId }), { memoryId: saved.saved.id, lane: 'stm' })
      ).rejects.toThrow(/trigger terms/)

      await updateMemoryOp(toolContext({ agentId }), {
        memoryId: saved.saved.id,
        trigger_terms: ['maggie']
      })
      const moved = await moveMemoryLaneOp(toolContext({ agentId }), {
        memoryId: saved.saved.id,
        lane: 'stm'
      })
      expect(moved.moved.lane).toBe('stm')
    })

    it('supersedes and un-supersedes through the ops layer', async () => {
      const agentId = await freshAgent()
      const older = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Batshit runs Redis 8 with the JSON module'
      })
      const newer = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'The nap relieves context pressure between turns'
      })

      const superseded = await supersedeMemoryOp(toolContext({ agentId }), {
        memoryId: newer.saved.id,
        supersedes: [older.saved.id]
      })
      expect(superseded.superseder.id).toBe(newer.saved.id)
      expect((await getMemory(agentId, older.saved.id))?.is_superseded).toBe('y')

      const restored = await unsupersedeMemoryOp(toolContext({ agentId }), {
        memoryId: older.saved.id
      })
      expect(restored.restored.superseded).toBe(false)
      expect((await getMemory(agentId, older.saved.id))?.is_superseded).toBe('n')
    })

    it('deletes explicitly and reports a missing id loudly', async () => {
      const agentId = await freshAgent()
      const saved = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'temporary memory'
      })
      const deleted = await deleteMemoryOp(toolContext({ agentId }), { memoryId: saved.saved.id })
      expect(deleted.deleted).toBe(true)
      await expect(
        deleteMemoryOp(toolContext({ agentId }), { memoryId: saved.saved.id })
      ).rejects.toThrow(/not found/)
    })
  })

  describe('recallMemoriesOp (read-now + DCM linger handoff)', () => {
    it('returns full content in-turn, queues pending recalls, and bumps recall-refresh', async () => {
      const agentId = await freshAgent()
      const saved = await saveMemoryOp(toolContext({ agentId }), {
        lane: 'ltm',
        content: 'Josh has an Irish Setter named Maggie'
      })

      const result = await recallMemoriesOp(toolContext({ agentId }), {
        memoryIds: [saved.saved.id]
      })
      expect(result.recalled.map((entry) => entry.id)).toEqual([saved.saved.id])
      // 2026-08-29: recall is the read — full content returns in-turn (the tool
      // result never compiles into history; the DCM linger channel takes over).
      expect(result.recalled[0].content).toBe('Josh has an Irish Setter named Maggie')
      expect(result.note).toContain('never enters chat history')

      const record = await getMemory(agentId, saved.saved.id)
      expect(record?.recall_count).toBe(1)
      expect(record?.last_recalled_ts).toBeGreaterThan(0)

      const linger = await getMemoryLingerState(SESSION)
      expect(linger?.pending.map((entry) => entry.memory_id)).toContain(saved.saved.id)

      // Re-recalling refreshes the pending entry instead of duplicating it.
      await recallMemoriesOp(toolContext({ agentId }), { memoryIds: [saved.saved.id] })
      const refreshed = await getMemoryLingerState(SESSION)
      expect(
        refreshed?.pending.filter((entry) => entry.memory_id === saved.saved.id)
      ).toHaveLength(1)
      expect((await getMemory(agentId, saved.saved.id))?.recall_count).toBe(2)
    })

    it('fails loudly on unknown ids and missing session context', async () => {
      const agentId = await freshAgent()
      await expect(
        recallMemoriesOp(toolContext({ agentId }), { memoryIds: ['mem_ghost'] })
      ).rejects.toThrow(/not found/)
      await expect(
        recallMemoriesOp(toolContext({ agentId, sessionId: null }), { memoryIds: ['mem_x'] })
      ).rejects.toThrow(/session context/)
      await expect(
        recallMemoriesOp(toolContext({ agentId }), { memoryIds: [] })
      ).rejects.toThrow(/at least one/)
    })
  })

  describe('inline saves (parity with the save tool, DL-104-05 loud failures)', () => {
    it('produces records identical in shape to tool saves, plus the message id in provenance', async () => {
      const agentId = await freshAgent()
      const toolSave = await saveMemoryOp(
        { userId: USER, agentId, sessionId: SESSION, messageId: null },
        { lane: 'ltm', content: 'Batshit runs Redis 8 with the JSON module', importance: 6 }
      )

      const [inline] = await processInlineMemorySaves({
        userId: USER,
        agentId,
        sessionId: SESSION,
        messageId: 'msg_inline_1',
        payloads: [
          { lane: 'ltm', content: 'Batshit runs Redis 8 with the JSON module', importance: 6 }
        ]
      })
      expect(inline.error).toBeUndefined()
      expect(inline.saved).toBeTruthy()

      const toolRecord = await getMemory(agentId, toolSave.saved.id)
      const inlineRecord = await getMemory(agentId, inline.saved!.id)
      expect(toolRecord).toBeTruthy()
      expect(inlineRecord).toBeTruthy()

      // Identical records modulo id/timestamps/provenance message id (P3 parity).
      const normalize = (record: Record<string, any>) => {
        const { id, saved_at, saved_ts, updated_at, provenance, ...rest } = record
        return {
          ...rest,
          provenance: provenance.map((entry: Record<string, any>) => ({
            ...entry,
            message_id: undefined
          }))
        }
      }
      expect(normalize(inlineRecord as never)).toEqual(normalize(toolRecord as never))
      expect(inlineRecord?.provenance[0].message_id).toBe('msg_inline_1')
      expect(toolRecord?.provenance[0].message_id).toBeUndefined()
    })

    it('processes every block independently and reports failures loudly per block', async () => {
      const agentId = await freshAgent()
      const results = await processInlineMemorySaves({
        userId: USER,
        agentId,
        sessionId: SESSION,
        messageId: 'msg_inline_2',
        payloads: [
          { lane: 'ltm', content: 'valid save one' },
          { lane: 'stm', content: 'missing triggers' },
          { lane: 'ltm', content: 'valid save two' }
        ]
      })
      expect(results).toHaveLength(3)
      expect(results[0].saved).toBeTruthy()
      expect(results[1].error).toContain('trigger_terms')
      expect(results[1].hint).toBeTruthy()
      expect(results[2].saved).toBeTruthy()
    })

    it('refuses inline saves for memory-disabled agents', async () => {
      const [result] = await processInlineMemorySaves({
        userId: USER,
        agentId: AGENT_DISABLED,
        sessionId: SESSION,
        messageId: null,
        payloads: [{ lane: 'ltm', content: 'should not store' }]
      })
      expect(result.error).toContain('Memory is not enabled')
    })
  })

  describe('lifecycle (DL-104-13: memlinger joins deleteSession in this packet)', () => {
    it('deleteSession removes the recall/linger state', async () => {
      const agentId = await freshAgent()
      await redis.json.set('session:sess_linger_del', '$', {
        id: 'sess_linger_del',
        user_id: USER
      } as never)
      const saved = await saveMemoryOp(
        { userId: USER, agentId, sessionId: 'sess_linger_del' },
        { lane: 'ltm', content: 'linger cleanup test' }
      )
      await recallMemoriesOp(
        { userId: USER, agentId, sessionId: 'sess_linger_del' },
        { memoryIds: [saved.saved.id] }
      )

      const admin = harness.adminClient()
      expect(await admin.exists('memlinger:sess_linger_del')).toBe(1)
      await redis.deleteSession('sess_linger_del')
      expect(await admin.exists('memlinger:sess_linger_del')).toBe(0)
      // Agent-scoped memories survive session deletion (DL-104-16).
      expect(await getMemory(agentId, saved.saved.id)).not.toBeNull()
    })
  })

  describe('lane vocabulary stays mirrored (client-safe util vs data layer)', () => {
    it('MEMORY_CONTROL_LANES equals MEMORY_LANES', async () => {
      const { MEMORY_CONTROL_LANES } = await import('$lib/utils/memoryControl')
      const { MEMORY_LANES } = await import('../memoryTypes')
      expect([...MEMORY_CONTROL_LANES]).toEqual([...MEMORY_LANES])
    })
  })

  describe('MemoryToolError carries hints for the loud-failure surface', () => {
    it('exposes hint text for correction lines', () => {
      const error = new MemoryToolError('bad save', 'fix it like this')
      expect(error.message).toBe('bad save')
      expect(error.hint).toBe('fix it like this')
    })
  })
})
