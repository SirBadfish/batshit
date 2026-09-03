import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'

/**
 * SA-104 P5 — Memory Panel management ops + Infinite Session episode controls
 * (dedicated Redis 8 db0 lane, npm run test:memory).
 *
 * The management layer is ownership-gated but NOT enablement-gated (DL-104-16: the
 * user always sees and manages everything, including a memory-disabled agent's
 * records). Episode controls are Infinite-Session-only and agent-facing (enablement
 * gated like every other memory tool).
 */

vi.mock('../memoryEmbedder', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryEmbedder')>()

  function normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
    return vector.map((v) => v / magnitude)
  }

  function fakeVector(text: string): number[] {
    const vector = new Array<number>(8).fill(0)
    for (let i = 0; i < text.length; i++) {
      vector[i % 8] += (text.charCodeAt(i) % 23) / 23
    }
    return normalize(vector)
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

  return {
    ...original,
    createMemoryEmbedder: testEmbedder,
    // SA-102 P5 moved the production write/search paths onto the async door so
    // the local lane can read its key from the shared encrypted store. BOTH
    // doors have to return the same deterministic fake: `...original` spreads
    // the REAL `createMemoryEmbedderAsync`, whose internal call resolves the
    // module-local `createMemoryEmbedder` binding rather than this mock, so
    // overriding only the sync name silently runs the real embedder.
    createMemoryEmbedderAsync: async () => testEmbedder()
  }
})

import { ensureMemoryIndexes, setMemoryConfig } from '../memoryIndex'
import { createMemory, createMemorySegment, getMemory, supersedeMemory } from '../memoryStore'
import {
  deleteManagedMemory,
  getManagedMemoryDetail,
  getManagedAwareness,
  listManagedMemories,
  listManagedSegments,
  MemoryManageError,
  searchManagedMemories,
  updateManagedMemory
} from '../memoryManage'
import { closeEpisodeOp, holdEpisodeOp, MemoryToolError } from '../memoryTools'
import {
  ensureFixedSessionOpenEpisode,
  getOpenEpisode,
  listEpisodes
} from '../memoryEpisodes'
import { redis } from '$lib/server/redis'

const harness = useMemorySearchTestServer()

const USER = 'user_test'
const OTHER_USER = 'user_other'
const AGENT = 'agent_manage'
const AGENT_DISABLED = 'agent_manage_off'
const FIXED_SESSION = 'sess_fixed_manage'
const REGULAR_SESSION = 'sess_regular_manage'

const fixedSessionRecord = () => ({
  id: FIXED_SESSION,
  user_id: USER,
  metadata: { fixedSession: { version: 1, enabled: true, created_at: '2026-08-25T00:00:00.000Z' } }
})

async function seedMemory(agentId: string, content: string, overrides: Record<string, any> = {}) {
  return createMemory({
    agent_id: agentId,
    user_id: USER,
    lane: overrides.lane ?? 'ltm',
    content,
    importance: overrides.importance ?? 5,
    event_at: overrides.event_at ?? null,
    expires_at: overrides.expires_at ?? null,
    trigger_terms: overrides.trigger_terms,
    clip_ids: overrides.clip_ids,
    provenance: [{ session_id: REGULAR_SESSION, source: 'agent' }]
  })
}

describe.runIf(memorySearchLaneActive())('memory manage ops + episode controls', () => {
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
      name: 'Managed Agent',
      memory_enabled: true
    } as never)
    await redis.json.set(`agent:${AGENT_DISABLED}`, '$', {
      id: AGENT_DISABLED,
      user_id: USER,
      name: 'Disabled Agent',
      memory_enabled: false
    } as never)
    await redis.json.set(`session:${FIXED_SESSION}`, '$', fixedSessionRecord() as never)
    await redis.json.set(`session:${REGULAR_SESSION}`, '$', {
      id: REGULAR_SESSION,
      user_id: USER,
      metadata: {}
    } as never)
  })

  it('lists, filters, and reports totals — and works for a memory-DISABLED agent (DL-104-16)', async () => {
    await seedMemory(AGENT_DISABLED, 'Fact one about the project', { lane: 'ltm' })
    await seedMemory(AGENT_DISABLED, 'Maggie is the dog', {
      lane: 'stm',
      trigger_terms: ['maggie']
    })

    const all = await listManagedMemories({ userId: USER, agentId: AGENT_DISABLED }, {})
    expect(all.total).toBe(2)
    expect(all.results).toHaveLength(2)
    expect((all.results[0] as any).embedding).toBeUndefined()

    const stmOnly = await listManagedMemories(
      { userId: USER, agentId: AGENT_DISABLED },
      { lane: 'stm' }
    )
    expect(stmOnly.results).toHaveLength(1)
    expect(stmOnly.results[0].lane).toBe('stm')
  })

  it('refuses another user\'s agent', async () => {
    await redis.json.set(`agent:agent_foreign`, '$', {
      id: 'agent_foreign',
      user_id: OTHER_USER,
      memory_enabled: true
    } as never)
    await expect(
      listManagedMemories({ userId: USER, agentId: 'agent_foreign' }, {})
    ).rejects.toBeInstanceOf(MemoryManageError)
  })

  it('search returns summary references through the hybrid index', async () => {
    await seedMemory(AGENT, 'Josh has an Irish Setter named Maggie')
    await seedMemory(AGENT, 'Batshit runs Redis 8 with the JSON module')

    const result = await searchManagedMemories(
      { userId: USER, agentId: AGENT },
      { query: 'Irish Setter named Maggie' }
    )
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results[0].gist).toContain('Irish Setter')
    expect((result.results[0] as any).content).toBeUndefined()
  })

  it('detail returns the record without embedding plus the supersession chain', async () => {
    const oldFact = await seedMemory(AGENT, 'Josh works Tuesdays')
    const newFact = await seedMemory(AGENT, 'Josh works Wednesdays now')
    await supersedeMemory(AGENT, newFact.id, [oldFact.id])

    const detail = await getManagedMemoryDetail({ userId: USER, agentId: AGENT }, newFact.id)
    expect((detail.record as any).embedding).toBeUndefined()
    expect(detail.record.content).toBe('Josh works Wednesdays now')
    expect(detail.chain.predecessors.map((entry) => entry.id)).toEqual([oldFact.id])

    const oldDetail = await getManagedMemoryDetail({ userId: USER, agentId: AGENT }, oldFact.id)
    expect(oldDetail.chain.successors.map((entry) => entry.id)).toEqual([newFact.id])
    expect(oldDetail.record.is_superseded).toBe('y')
  })

  it('update edits fields (content change re-embeds) and delete removes explicitly', async () => {
    const record = await seedMemory(AGENT, 'The original fact')
    const updated = await updateManagedMemory({ userId: USER, agentId: AGENT }, record.id, {
      content: 'The corrected fact',
      importance: 8
    })
    expect(updated.content).toBe('The corrected fact')
    expect(updated.importance).toBe(8)
    const stored = await getMemory(AGENT, record.id)
    expect(stored?.content).toBe('The corrected fact')

    const deleted = await deleteManagedMemory({ userId: USER, agentId: AGENT }, record.id)
    expect(deleted.deleted).toBe(true)
    expect(await getMemory(AGENT, record.id)).toBeNull()
  })

  it('awareness returns entries in the compile order with expiry flags', async () => {
    await seedMemory(AGENT, 'Low importance thought', { lane: 'awareness', importance: 3 })
    await seedMemory(AGENT, 'Critical standing fact', { lane: 'awareness', importance: 9 })
    await seedMemory(AGENT, 'Expired reminder', {
      lane: 'awareness',
      importance: 7,
      expires_at: '2020-01-01T00:00:00.000Z'
    })
    await seedMemory(AGENT, 'Not awareness', { lane: 'ltm', importance: 10 })

    const result = await getManagedAwareness({ userId: USER, agentId: AGENT })
    expect(result.entries).toHaveLength(3)
    expect(result.entries[0].content).toBe('Critical standing fact')
    expect(result.entries.map((entry) => entry.expired)).toEqual([false, true, false])
    expect((result.entries[0] as any).embedding).toBeUndefined()
  })

  it('graduated history: lists segments newest-first, searches them, and stays ownership-gated', async () => {
    await createMemorySegment({
      agent_id: AGENT,
      user_id: USER,
      session_id: 'sess_old',
      episode_id: 'ep_a',
      message_ids: ['m1', 'm2'],
      summary: 'Planned the garden beds and ordered tomato seedlings.',
      first_message_at: '2026-05-01T08:00:00.000Z',
      last_message_at: '2026-05-01T09:00:00.000Z',
      token_count: 400,
      graduated_by: 'nap'
    })
    await createMemorySegment({
      agent_id: AGENT,
      user_id: USER,
      session_id: 'sess_new',
      episode_id: 'ep_b',
      message_ids: ['m3'],
      summary: 'Debugged the deck lighting timer wiring.',
      first_message_at: '2026-07-01T08:00:00.000Z',
      last_message_at: '2026-07-01T09:00:00.000Z',
      token_count: 200,
      graduated_by: 'dreaming'
    })

    const listed = await listManagedSegments({ userId: USER, agentId: AGENT }, {})
    expect(listed.total).toBe(2)
    expect(listed.results[0].summary).toContain('deck lighting')
    expect(listed.results[1].summary).toContain('garden beds')
    expect((listed.results[0] as any).embedding).toBeUndefined()

    const searched = await listManagedSegments(
      { userId: USER, agentId: AGENT },
      { query: 'tomato seedlings garden' }
    )
    expect(searched.results.length).toBeGreaterThanOrEqual(1)
    expect(searched.results[0].summary).toContain('garden beds')

    await expect(
      listManagedSegments({ userId: OTHER_USER, agentId: AGENT }, {})
    ).rejects.toThrow(MemoryManageError)
  })

  it('episodes: lazy open only for Infinite Sessions, close/hold controls work, non-fixed refuses', async () => {
    // Regular session: no episode opens.
    const none = await ensureFixedSessionOpenEpisode({
      session: { id: REGULAR_SESSION, user_id: USER, metadata: {} },
      sessionId: REGULAR_SESSION,
      agentId: AGENT
    })
    expect(none).toBeNull()
    expect(await getOpenEpisode(REGULAR_SESSION)).toBeNull()

    // Infinite Session: first call opens, second call reuses (single-open invariant).
    const opened = await ensureFixedSessionOpenEpisode({
      session: fixedSessionRecord(),
      sessionId: FIXED_SESSION,
      agentId: AGENT
    })
    expect(opened?.state).toBe('open')
    const reused = await ensureFixedSessionOpenEpisode({
      session: fixedSessionRecord(),
      sessionId: FIXED_SESSION,
      agentId: AGENT
    })
    expect(reused?.id).toBe(opened?.id)

    // Hold sets and clears on the open episode.
    const held = await holdEpisodeOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { hold_until: '2027-01-01T00:00:00.000Z' }
    )
    expect(held.episode.hold_until).toBe('2027-01-01T00:00:00.000Z')
    const cleared = await holdEpisodeOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { hold_until: null }
    )
    expect(cleared.episode.hold_until).toBeUndefined()

    // Close marks the boundary; the ledger keeps the record; next ensure opens a new one.
    const closed = await closeEpisodeOp({ userId: USER, agentId: AGENT, sessionId: FIXED_SESSION })
    expect(closed.closed.state).toBe('closed')
    expect(closed.closed.boundary_signal).toBe('agent_mark')
    expect(await getOpenEpisode(FIXED_SESSION)).toBeNull()

    const next = await ensureFixedSessionOpenEpisode({
      session: fixedSessionRecord(),
      sessionId: FIXED_SESSION,
      agentId: AGENT
    })
    expect(next?.id).not.toBe(opened?.id)
    expect((await listEpisodes(FIXED_SESSION)).length).toBe(2)

    // Regular sessions refuse episode controls loudly.
    await expect(
      closeEpisodeOp({ userId: USER, agentId: AGENT, sessionId: REGULAR_SESSION })
    ).rejects.toBeInstanceOf(MemoryToolError)

    // An Infinite Session with no open episode explains itself.
    await closeEpisodeOp({ userId: USER, agentId: AGENT, sessionId: FIXED_SESSION })
    await expect(
      holdEpisodeOp({ userId: USER, agentId: AGENT, sessionId: FIXED_SESSION }, {})
    ).rejects.toThrow(/no open episode/i)
  })
})
