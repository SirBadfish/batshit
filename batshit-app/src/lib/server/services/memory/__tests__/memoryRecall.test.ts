import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'

/**
 * SA-104 P4 — recall engine suite (dedicated Redis 8 db0 lane, npm run test:memory).
 *
 * Deterministic fixtures per the story's P4 list: trigger hit/miss/budget/dedup, linger
 * transitions with status marks, on-my-mind compilation and byte-stability, time
 * awareness, superseded/expired handling, blended-ranking ordering, link expansion,
 * empty-store behavior, and the index-unavailable loud failure (search fails loudly
 * while the record-read compile lanes keep working).
 */

vi.mock('../memoryEmbedder', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryEmbedder')>()

  function normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
    return vector.map((v) => v / magnitude)
  }

  const KNOWN_VECTORS: Record<string, number[]> = {
    'Maggie is the Irish Setter': normalize([1, 0.1, 0, 0, 0, 0, 0, 0]),
    'Maggie loves swimming in the lake': normalize([0.97, 0.12, 0, 0, 0, 0, 0, 0]),
    'what do we know about the dog': normalize([0.95, 0.15, 0, 0, 0, 0, 0, 0])
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
import { createMemory, getMemory, supersedeMemory, type CreateMemoryInput } from '../memoryStore'
import { getMemoryLingerState, queuePendingMemoryRecalls } from '../memoryLinger'
import {
  blendMemoryRanking,
  commitMemoryTurnState,
  computeMemoryCompileContext,
  formatInteractionGap,
  messageMatchesTriggerTerm
} from '../memoryRecall'
import { searchMemoriesOp } from '../memoryTools'
import { redis } from '$lib/server/redis'

useMemorySearchTestServer()

const USER = 'user_recall'
const AGENT = 'agent_recall'
const SESSION = 'sess_recall'

async function seedAgent(
  agentId: string,
  extras: Record<string, unknown> = {}
): Promise<void> {
  await redis.json.set(`agent:${agentId}`, '$', {
    id: agentId,
    user_id: USER,
    name: 'Recall Agent',
    memory_enabled: true,
    ...extras
  } as never)
}

let memoryCounter = 0
async function seedMemory(
  overrides: Partial<CreateMemoryInput> & { content?: string } = {}
): Promise<string> {
  memoryCounter += 1
  const record = await createMemory({
    agent_id: AGENT,
    user_id: USER,
    lane: 'ltm',
    content: overrides.content ?? `Fixture memory number ${memoryCounter}`,
    importance: 5,
    provenance: [{ session_id: SESSION, source: 'agent' }],
    ...overrides
  })
  return record.id
}

async function patchMemoryField(memoryId: string, path: string, value: unknown): Promise<void> {
  await redis.execute(async (client) => {
    await client.json.set(`memory:${AGENT}:${memoryId}`, path, value as never)
  })
}

function compileArgs(message: string) {
  return {
    userId: USER,
    agentId: AGENT,
    sessionId: SESSION,
    currentUserMessage: message
  }
}

describe.runIf(memorySearchLaneActive())('memory recall engine (dedicated Redis 8 db0)', () => {
  beforeEach(async () => {
    memoryCounter = 0
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
    await seedAgent(AGENT)
  })

  describe('trigger matching', () => {
    it('matches whole words case-insensitively and refuses substring hits', () => {
      expect(messageMatchesTriggerTerm('We saw Maggie today', 'maggie')).toBe(true)
      expect(messageMatchesTriggerTerm('MAGGIE!', 'maggie')).toBe(true)
      expect(messageMatchesTriggerTerm('the concatenated file', 'cat')).toBe(false)
      expect(messageMatchesTriggerTerm('my cat sleeps', 'cat')).toBe(true)
    })

    it('matches multi-word terms across flexible whitespace', () => {
      expect(messageMatchesTriggerTerm('an Irish   Setter ran by', 'irish setter')).toBe(true)
      expect(messageMatchesTriggerTerm('irishsetter', 'irish setter')).toBe(false)
    })
  })

  describe('computeMemoryCompileContext', () => {
    it('returns the disabled empty context for memory-off and foreign agents', async () => {
      await redis.json.set(`agent:agent_off`, '$', {
        id: 'agent_off',
        user_id: USER,
        memory_enabled: false
      } as never)
      const off = await computeMemoryCompileContext({
        ...compileArgs('maggie'),
        agentId: 'agent_off'
      })
      expect(off.enabled).toBe(false)
      expect(off.dcmLines).toEqual([])
      expect(off.onMyMindBlock).toBe('')
    })

    it('handles an empty store: enabled, no inserts, no on-my-mind block', async () => {
      const context = await computeMemoryCompileContext(compileArgs('hello maggie'))
      expect(context.enabled).toBe(true)
      expect(context.onMyMindBlock).toBe('')
      expect(context.dcmLines).toEqual([])
      expect(context.memoryContext?.inserts).toEqual([])
    })

    it('fires a trigger as a Current insert with dated-claim formatting and provenance', async () => {
      const memoryId = await seedMemory({
        lane: 'stm',
        content: 'Maggie is the Irish Setter',
        trigger_terms: ['maggie'],
        importance: 7,
        event_at: '2026-05-01T12:00:00.000Z'
      })
      const context = await computeMemoryCompileContext(compileArgs('How is Maggie doing?'))
      const text = context.dcmLines.join('\n')
      expect(context.dcmLines[0]).toBe('Memory context:')
      expect(text).toContain('- Current (new this message):')
      expect(text).toContain('✅')
      expect(text).toContain(`trigger "maggie" | stm | ${memoryId} | importance 7`)
      expect(text).toContain('event 5/1/2026')
      expect(text).toContain('this chat')
      expect(text).toContain('Maggie is the Irish Setter')
      expect(context.memoryContext?.inserts).toHaveLength(1)
      expect(context.memoryContext?.inserts[0]).toMatchObject({
        id: memoryId,
        source: 'trigger',
        status: 'new'
      })
    })

    it('labels cross-session provenance as another chat', async () => {
      await seedMemory({
        lane: 'stm',
        content: 'Fact from elsewhere about maggie',
        trigger_terms: ['maggie'],
        provenance: [{ session_id: 'some_other_session', source: 'agent' }]
      })
      const context = await computeMemoryCompileContext(compileArgs('maggie?'))
      expect(context.dcmLines.join('\n')).toContain('another chat,')
    })

    it('inserts a multi-trigger memory once with every matched term listed', async () => {
      await seedMemory({
        lane: 'stm',
        content: 'Maggie the dog fact',
        trigger_terms: ['maggie', 'dog']
      })
      const context = await computeMemoryCompileContext(compileArgs('is maggie a good dog'))
      expect(context.memoryContext?.inserts).toHaveLength(1)
      expect(context.memoryContext?.inserts[0].matchedTerms).toEqual(['maggie', 'dog'])
    })

    it('matches configured synonyms too', async () => {
      await seedMemory({
        lane: 'stm',
        content: 'Maggie fact via synonym',
        trigger_terms: ['maggie'],
        trigger_synonyms: ['the setter']
      })
      const context = await computeMemoryCompileContext(compileArgs('how is the setter today'))
      expect(context.memoryContext?.inserts).toHaveLength(1)
    })

    it('never auto-fires superseded or expired trigger memories', async () => {
      const oldId = await seedMemory({
        lane: 'stm',
        content: 'Old maggie fact',
        trigger_terms: ['maggie']
      })
      const newId = await seedMemory({
        lane: 'stm',
        content: 'Current maggie fact',
        trigger_terms: ['maggie']
      })
      await supersedeMemory(AGENT, newId, [oldId])
      await seedMemory({
        lane: 'stm',
        content: 'Expired maggie fact',
        trigger_terms: ['maggie'],
        expires_at: '2020-01-01T00:00:00.000Z'
      })
      const context = await computeMemoryCompileContext(compileArgs('maggie'))
      expect(context.memoryContext?.inserts).toHaveLength(1)
      expect(context.memoryContext?.inserts[0].id).toBe(newId)
    })

    it('delivers pending recalls as Current inserts, flags superseded ones loudly', async () => {
      const oldId = await seedMemory({ content: 'Outdated decision' })
      const newId = await seedMemory({ content: 'Current decision' })
      await supersedeMemory(AGENT, newId, [oldId])
      await queuePendingMemoryRecalls(SESSION, AGENT, [{ id: oldId, kind: 'memory' }])
      const context = await computeMemoryCompileContext(compileArgs('unrelated message'))
      const text = context.dcmLines.join('\n')
      expect(text).toContain('recalled')
      expect(text).toContain(`SUPERSEDED by ${newId}`)
      expect(context.memoryContext?.inserts[0]).toMatchObject({ id: oldId, superseded: true })
    })

    it('never re-inserts an on-my-mind entry through the DCM channel (dedup rule 2)', async () => {
      const awarenessId = await seedMemory({
        lane: 'awareness',
        content: 'Always-on fact',
        importance: 9
      })
      await queuePendingMemoryRecalls(SESSION, AGENT, [{ id: awarenessId, kind: 'memory' }])
      const context = await computeMemoryCompileContext(compileArgs('anything'))
      expect(context.onMyMindBlock).toContain('Always-on fact')
      expect(context.memoryContext?.inserts).toEqual([])
      expect(context.dcmLines.join('\n')).toContain('already in your AWARENESS block')
    })

    it('enforces the trigger budget with ranked truncation and a More available line', async () => {
      await seedAgent(AGENT, { memory_lane_budgets: { triggers: 30 } })
      await seedMemory({
        lane: 'stm',
        content:
          'High importance maggie fact that is long enough to consume the whole trigger budget by itself for the test',
        trigger_terms: ['maggie'],
        importance: 9
      })
      await seedMemory({
        lane: 'stm',
        content: 'Low importance maggie fact that no longer fits',
        trigger_terms: ['maggie'],
        importance: 2
      })
      const context = await computeMemoryCompileContext(compileArgs('maggie'))
      expect(context.memoryContext?.inserts).toHaveLength(1)
      expect(context.memoryContext?.inserts[0].importance).toBe(9)
      expect(context.dcmLines.join('\n')).toMatch(/More available: 1 trigger match not inserted/)
    })

    it('compiles on-my-mind deterministically: importance order, expiry filter, truncation line', async () => {
      await seedAgent(AGENT, { memory_lane_budgets: { on_my_mind: 30 } })
      const topId = await seedMemory({
        lane: 'awareness',
        content: 'Most important standing fact that fills the whole on-my-mind budget on its own here',
        importance: 10
      })
      await seedMemory({
        lane: 'awareness',
        content: 'Second awareness entry that gets truncated',
        importance: 4
      })
      await seedMemory({
        lane: 'awareness',
        content: 'Expired awareness entry',
        importance: 8,
        expires_at: '2020-01-01T00:00:00.000Z'
      })
      const first = await computeMemoryCompileContext(compileArgs('hello'))
      expect(first.onMyMindBlock).toContain('==== AWARENESS (YOUR MEMORIES) ====')
      expect(first.onMyMindBlock).toContain(topId)
      expect(first.onMyMindBlock).not.toContain('Expired awareness entry')
      expect(first.onMyMindBlock).toContain('1 more awareness entry exceeds the Awareness budget')
      // Byte-stability (DL-104-04 cache anchoring): identical across compiles.
      const second = await computeMemoryCompileContext(compileArgs('different message'))
      expect(second.onMyMindBlock).toBe(first.onMyMindBlock)
    })

    it('keeps an older chosen Awareness winner and excludes the newer superseded duplicate', async () => {
      const olderCanonicalId = await seedMemory({
        lane: 'awareness',
        content: 'Canonical standing fact',
        importance: 9
      })
      const newerDuplicateId = await seedMemory({
        lane: 'awareness',
        content: 'Duplicate standing fact',
        importance: 10
      })
      await supersedeMemory(AGENT, olderCanonicalId, [newerDuplicateId])

      const context = await computeMemoryCompileContext(compileArgs('hello'))
      expect(context.onMyMindBlock).toContain('Canonical standing fact')
      expect(context.onMyMindBlock).not.toContain('Duplicate standing fact')
    })

    it('keeps on-recall Awareness media textual and exposes standing media separately', async () => {
      await seedMemory({
        lane: 'awareness',
        content: 'Maggie portrait memory',
        media: [{
          id: 'media_maggie',
          filename: `${AGENT}/mem_placeholder/media_maggie.png`,
          display_name: 'maggie.png',
          mime_type: 'image/png',
          bytes: 123,
          width: 64,
          height: 48,
          token_estimate: 6,
          sha256: 'a'.repeat(64)
        }]
      })
      const context = await computeMemoryCompileContext(compileArgs('hi'))
      expect(context.onMyMindBlock).toContain('has media: 1 owned image')
      expect(context.standingMedia).toEqual([])
    })

    it('keeps eligible standing media even when its Awareness text is outside the text budget', async () => {
      await seedAgent(AGENT, { memory_lane_budgets: { on_my_mind: 8 } })
      await seedMemory({
        lane: 'awareness',
        content: 'The highest-priority Awareness fact consumes the text budget by itself.',
        importance: 10
      })
      const standingMemoryId = await seedMemory({
        lane: 'awareness',
        content: 'Lower-priority portrait text is budget-truncated but its standing image remains.',
        importance: 1,
        media_mode: 'always',
        media: [{
          id: 'media_budget_standing',
          filename: `${AGENT}/mem_placeholder/media_budget_standing.png`,
          display_name: 'standing.png',
          mime_type: 'image/png',
          bytes: 123,
          width: 64,
          height: 48,
          token_estimate: 6,
          sha256: 'c'.repeat(64)
        }]
      })

      const context = await computeMemoryCompileContext(compileArgs('hi'))
      expect(context.onMyMindBlock).not.toContain('Lower-priority portrait text')
      expect(context.standingMedia).toMatchObject([
        { memoryId: standingMemoryId, media: { id: 'media_budget_standing' } }
      ])
    })

    it('surfaces owned media for inserted trigger memories (structured image path)', async () => {
      const memoryId = await seedMemory({
        lane: 'stm',
        content: 'Maggie with her photo',
        trigger_terms: ['maggie'],
        media: [{
          id: 'media_photo_1',
          filename: `${AGENT}/mem_placeholder/media_photo_1.png`,
          display_name: 'photo.png',
          mime_type: 'image/png',
          bytes: 123,
          width: 64,
          height: 48,
          token_estimate: 6,
          sha256: 'b'.repeat(64)
        }]
      })
      const context = await computeMemoryCompileContext(compileArgs('maggie'))
      expect(context.rememberedMedia).toMatchObject([
        { memoryId, media: { id: 'media_photo_1' } }
      ])
      expect(context.dcmLines.join('\n')).toContain('1 owned image attached below')
    })

    it('SA-109: leaves session clip lines to the general DCM roster', async () => {
      await redis.set(`session:${SESSION}:clip_state`, {
        sessionId: SESSION,
        clips: [
          {
            clipId: 'clip_old',
            attachedAt: '2026-08-01T00:00:00.000Z',
            attachedToMessageId: 'msg_history_1',
            messagesUntilUnclip: 3
          }
        ]
      })
      const context = await computeMemoryCompileContext(compileArgs('no triggers here'))
      // Clip rows moved to the general roster (DL-109-04) so memory-enabled
      // agents never get the same clip listed twice.
      expect(context.dcmLines.join('\n')).not.toContain('clip clip_old')
    })

    it('adds the agent-level time-awareness line from the last-interaction stamp', async () => {
      const lastTs = Date.now() - 3 * 86_400_000
      await seedAgent(AGENT, {
        memory_last_interaction_at: new Date(lastTs).toISOString(),
        memory_last_interaction_ts: lastTs
      })
      const context = await computeMemoryCompileContext(compileArgs('good morning'))
      expect(context.dcmLines[1]).toMatch(/^- Last interaction with the user: 3 days ago \(/)
      expect(context.memoryContext?.timeAwareness).toMatch(/^Last interaction with the user: 3 days ago/)
    })
  })

  describe('formatInteractionGap', () => {
    it('formats human gaps deterministically', () => {
      const now = Date.now()
      expect(formatInteractionGap(now - 30_000, now)).toBe('moments ago')
      expect(formatInteractionGap(now - 5 * 60_000, now)).toBe('5 minutes ago')
      expect(formatInteractionGap(now - 3 * 3_600_000, now)).toBe('3 hours ago')
      expect(formatInteractionGap(now - 6 * 86_400_000, now)).toBe('6 days ago')
      expect(formatInteractionGap(now - 21 * 86_400_000, now)).toBe('3 weeks ago')
      expect(formatInteractionGap(now - 100 * 86_400_000, now)).toBe('3 months ago')
      expect(formatInteractionGap(now - 800 * 86_400_000, now)).toBe('2 years ago')
    })
  })

  describe('commitMemoryTurnState (accepted-send boundary)', () => {
    it('consumes pending recalls into lingering, bumps recall-refresh, stamps last interaction', async () => {
      const memoryId = await seedMemory({ content: 'Recall me' })
      await queuePendingMemoryRecalls(SESSION, AGENT, [{ id: memoryId, kind: 'memory' }])

      const result = await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'no triggers'
      })
      expect(result.committed).toBe(true)
      expect(result.insertedNewIds).toEqual([memoryId])

      const linger = await getMemoryLingerState(SESSION)
      expect(linger?.pending).toEqual([])
      expect(linger?.lingering).toHaveLength(1)
      expect(linger?.lingering?.[0]).toMatchObject({
        memory_id: memoryId,
        source: 'recall',
        turns_remaining: 2
      })

      const record = await getMemory(AGENT, memoryId)
      expect(record?.recall_count).toBe(1)
      expect(record?.last_recalled_at).toBeTruthy()

      const agent = (await redis.get(`agent:${AGENT}`)) as Record<string, any>
      expect(typeof agent.memory_last_interaction_ts).toBe('number')
      expect(agent.memory_last_interaction_at).toBeTruthy()
    })

    it('decrements held entries per turn and drops them at zero (linger window end)', async () => {
      const memoryId = await seedMemory({
        lane: 'stm',
        content: 'Trigger once',
        trigger_terms: ['zanzibar']
      })
      await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'tell me about zanzibar'
      })
      let linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0]).toMatchObject({ memory_id: memoryId, turns_remaining: 2 })

      await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'unrelated turn one'
      })
      linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0]).toMatchObject({ memory_id: memoryId, turns_remaining: 1 })

      await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'unrelated turn two'
      })
      linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering ?? []).toEqual([])
    })

    it('marks a lingering entry as refreshed on re-trigger and resets its window', async () => {
      await seedMemory({
        lane: 'stm',
        content: 'Refreshing fact',
        trigger_terms: ['quokka']
      })
      await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'quokka photos'
      })
      await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'held turn'
      })
      // Now at turns_remaining 1; a re-trigger shows as refreshed and resets to 2.
      const context = await computeMemoryCompileContext(compileArgs('another quokka question'))
      expect(context.memoryContext?.inserts[0].status).toBe('refreshed')
      const result = await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'another quokka question'
      })
      expect(result.refreshedIds).toHaveLength(1)
      const linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0].turns_remaining).toBe(2)
    })

    it('keeps budget-deferred recalls queued so they insert on later turns', async () => {
      await seedAgent(AGENT, { memory_lane_budgets: { recalled: 25 } })
      const bigId = await seedMemory({
        content:
          'A very long recalled memory that consumes the entire recalled lane budget on its own for this test case',
        importance: 9
      })
      const deferredId = await seedMemory({ content: 'Deferred recall', importance: 2 })
      await queuePendingMemoryRecalls(SESSION, AGENT, [{ id: bigId, kind: 'memory' }, { id: deferredId, kind: 'memory' }])

      const context = await computeMemoryCompileContext(compileArgs('hello'))
      expect(context.memoryContext?.inserts.map((entry: any) => entry.id)).toEqual([bigId])
      expect(context.dcmLines.join('\n')).toMatch(/1 recalled memory stays queued/)

      await commitMemoryTurnState({
        userId: USER,
        agentId: AGENT,
        sessionId: SESSION,
        currentUserMessage: 'hello'
      })
      const linger = await getMemoryLingerState(SESSION)
      expect(linger?.pending.map((entry) => entry.memory_id)).toEqual([deferredId])
      expect(linger?.lingering?.map((entry) => entry.memory_id)).toEqual([bigId])
    })

    it('is a no-op for memory-disabled agents', async () => {
      await redis.json.set('agent:agent_plain', '$', {
        id: 'agent_plain',
        user_id: USER,
        memory_enabled: false
      } as never)
      const result = await commitMemoryTurnState({
        userId: USER,
        agentId: 'agent_plain',
        sessionId: SESSION,
        currentUserMessage: 'anything'
      })
      expect(result.committed).toBe(false)
    })
  })

  describe('per-memory linger overrides and split defaults (2026-08-28)', () => {
    const commit = (currentUserMessage: string) =>
      commitMemoryTurnState({ userId: USER, agentId: AGENT, sessionId: SESSION, currentUserMessage })

    it('applies a numeric linger_override instead of the trigger default', async () => {
      const memoryId = await seedMemory({
        lane: 'stm',
        content: 'Sticky trigger fact',
        trigger_terms: ['walrus'],
        linger_override: 4
      })
      await commit('a walrus appeared')
      const linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0]).toMatchObject({ memory_id: memoryId, turns_remaining: 4 })
    })

    it('uses the recall linger default for recalled inserts, separate from the trigger default', async () => {
      await seedAgent(AGENT, { memory_linger_turns: 1, memory_recall_linger_turns: 5 })
      const recalledId = await seedMemory({ content: 'Recalled with long linger' })
      await queuePendingMemoryRecalls(SESSION, AGENT, [{ id: recalledId, kind: 'memory' }])
      await commit('no triggers here')
      const linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0]).toMatchObject({
        memory_id: recalledId,
        source: 'recall',
        turns_remaining: 5
      })
    })

    it("holds an 'episode' override without counting down in a regular session, then drops it after the idle gap", async () => {
      const memoryId = await seedMemory({
        lane: 'stm',
        content: 'Episode-long subject',
        trigger_terms: ['orchid'],
        linger_override: 'episode'
      })
      await commit('look at this orchid')
      let linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0]).toMatchObject({
        memory_id: memoryId,
        hold: 'episode',
        turns_remaining: 0
      })

      // Several unrelated turns later, the hold is still there (no countdown).
      await commit('unrelated one')
      await commit('unrelated two')
      await commit('unrelated three')
      linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering?.[0]).toMatchObject({ memory_id: memoryId, hold: 'episode' })

      // The conversation idles past the agent's idle gap (default 8h): the stretch
      // ended, so the episode hold dies on the next accepted send.
      await redis.execute(async (client) => {
        await client.json.set(
          `memlinger:${SESSION}`,
          '$.last_commit_ts',
          (Date.now() - 9 * 3_600_000) as never
        )
      })
      await commit('back after a long break')
      linger = await getMemoryLingerState(SESSION)
      expect(linger?.lingering ?? []).toEqual([])
    })

    it('stamps per-item rows for the chip popover on the commit result', async () => {
      const memoryId = await seedMemory({
        lane: 'stm',
        content: 'Chip popover fact',
        gist: 'Chip popover fact',
        trigger_terms: ['pelican']
      })
      const result = await commit('a pelican flew by')
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        id: memoryId,
        lane: 'stm',
        source: 'trigger',
        status: 'new',
        gist: 'Chip popover fact',
        matchedTerms: ['pelican']
      })
    })
  })

  describe('blended ranking and link expansion (DL-104-09)', () => {
    it('blendMemoryRanking lets recency and importance reorder close-relevance hits', () => {
      const nowTs = Date.now()
      const base = {
        agent_id: AGENT,
        user_id: USER,
        lane: 'ltm' as const,
        event_at: null,
        event_ts: null,
        is_superseded: 'n' as const,
        provenance: [],
        visibility: 'normal' as const,
        embedding: [],
        embedding_model: 'x',
        schema_version: 1 as const
      }
      const oldUnimportant = {
        ...base,
        id: 'mem_old',
        content: 'old',
        importance: 2,
        saved_at: new Date(nowTs - 90 * 86_400_000).toISOString(),
        saved_ts: nowTs - 90 * 86_400_000
      }
      const freshImportant = {
        ...base,
        id: 'mem_fresh',
        content: 'fresh',
        importance: 9,
        saved_at: new Date(nowTs - 86_400_000).toISOString(),
        saved_ts: nowTs - 86_400_000
      }
      // The stale record wins raw relevance (rank 0), but recency + importance flip it.
      const ranked = blendMemoryRanking(
        [oldUnimportant, freshImportant],
        new Map([
          ['mem_old', 0],
          ['mem_fresh', 1]
        ]),
        nowTs
      )
      expect(ranked.map((record) => record.id)).toEqual(['mem_fresh', 'mem_old'])
    })

    it('search returns blended order, appends 1-hop linked references outside the limit', async () => {
      const linkedId = await seedMemory({ content: 'Lake house detail', importance: 3 })
      const primaryId = await seedMemory({
        content: 'Maggie is the Irish Setter',
        importance: 8,
        links: [linkedId]
      })
      await seedMemory({ content: 'Maggie loves swimming in the lake', importance: 4 })

      const result = await searchMemoriesOp(
        { userId: USER, agentId: AGENT, sessionId: SESSION },
        { query: 'what do we know about the dog', limit: 2 }
      )
      const ids = result.results.map((row) => row.id)
      expect(ids).toContain(primaryId)
      const linkedRow = result.results.find((row) => row.id === linkedId)
      expect(linkedRow?.linked_from).toBe(primaryId)
    })

    it('supports time-scoped search filters (event range)', async () => {
      const insideId = await seedMemory({
        content: 'Event inside the window about zebras',
        event_at: '2026-06-15T00:00:00.000Z'
      })
      await seedMemory({
        content: 'Event outside the window about zebras',
        event_at: '2025-01-01T00:00:00.000Z'
      })
      const result = await searchMemoriesOp(
        { userId: USER, agentId: AGENT, sessionId: SESSION },
        {
          query: 'zebras',
          event_from: '2026-06-01T00:00:00.000Z',
          event_to: '2026-07-01T00:00:00.000Z'
        }
      )
      expect(result.results.map((row) => row.id)).toEqual([insideId])
    })
  })

  describe('index-unavailable loud failure (DL-104-10 posture)', () => {
    it('search fails loudly without bootstrapped indexes while compile lanes keep working', async () => {
      await seedMemory({
        lane: 'stm',
        content: 'Trigger without index',
        trigger_terms: ['walrus']
      })
      // Simulate index-meta loss (e.g. a bad restore): search must fail loudly...
      await redis.del('batshit:memory_index_meta')
      await expect(
        searchMemoriesOp(
          { userId: USER, agentId: AGENT, sessionId: SESSION },
          { query: 'walrus' }
        )
      ).rejects.toThrow(/not bootstrapped/)
      // ...while the record-read compile lanes still deliver ambient recall.
      const context = await computeMemoryCompileContext(compileArgs('walrus season'))
      expect(context.memoryContext?.inserts).toHaveLength(1)
    })
  })
})
