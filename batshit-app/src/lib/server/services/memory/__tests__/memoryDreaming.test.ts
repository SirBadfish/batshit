import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'

/**
 * SA-104 P7 — Dreaming v1 on the dedicated Redis 8 db0 lane (npm run test:memory):
 * the deterministic maintenance pipeline (consolidation with provenance union,
 * supersession repair, expiry demotion, overnight episode closure/graduation,
 * regular-session idle sweep, embedding refresh, era consolidation), the visible
 * memdream log with a WHY per action, the no-live-turn interlock, the model-call
 * budget, log rotation, and DL-104-13 cleanup.
 *
 * Deterministic seams: summary generation, the embedder, and the clock are injected
 * (the P2/P6 pattern). No live model calls (live dreaming proof is P8).
 */

vi.mock('../memoryEmbedder', async (importOriginal) => {
  const original = await importOriginal<typeof import('../memoryEmbedder')>()

  function normalize(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
    return vector.map((v) => v / magnitude)
  }

  function fakeVector(text: string): number[] {
    // Controllable geometry for clustering tests: a leading [vecN] marker maps to a
    // basis vector, so same-marker texts are identical (distance 0) and different
    // markers are orthogonal (distance 1) — no accidental near-duplicates.
    const marker = /^\[vec(\d+)\]/.exec(text)
    if (marker) {
      const vector = new Array<number>(8).fill(0)
      vector[Number(marker[1]) % 8] = 1
      return vector
    }
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
import {
  createMemory,
  getMemory,
  listMemories,
  listMemorySegments,
  supersedeMemory,
  type CreateMemoryInput
} from '../memoryStore'
import {
  DREAMING_ERA_BATCH_MAX,
  DREAMING_RUN_HISTORY_LIMIT,
  DreamingBusyError,
  getDreamRun,
  getDreamRunSummaries,
  parseDreamingConsolidationVerdict,
  runDreamingPass,
  shouldRunScheduledDream
} from '../memoryDreaming'
import { episodeKey, getEpisode, sessionEpisodesKey, type EpisodeRecord } from '../memoryEpisodes'
import {
  applyFixedSessionGraduationToMessages,
  getFixedSessionGraduationState,
  type FixedSessionGraduationEvent
} from '$lib/utils/fixedSessionGraduation'
import {
  clearSessionTurn,
  registerSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import { redis } from '$lib/server/redis'

const harness = useMemorySearchTestServer()

const USER = 'user_dream'
const AGENT = 'agent_dream'
const FIXED_SESSION = 'sess_dream_fixed'
const REGULAR_SESSION = 'sess_dream_regular'
const ARCHIVED_SESSION = 'sess_dream_archived'
const PRESET_ID = 'preset_dream_test'

const NOW = new Date('2026-06-10T12:00:00.000Z')

function agentRecord(overrides: Record<string, any> = {}) {
  return {
    id: AGENT,
    user_id: USER,
    name: 'Dream Agent',
    memory_enabled: true,
    primary_model_preset_id: PRESET_ID,
    memory_window: {
      floor_mode: 'custom',
      floor_tokens: 1_000,
      ceiling_headroom_mode: 'custom',
      ceiling_headroom_tokens: 50_000,
      nap_threshold_percent: 80
    },
    ...overrides
  }
}

async function seedAgent(overrides: Record<string, any> = {}) {
  await redis.json.set(`agent:${AGENT}`, '$', agentRecord(overrides) as never)
  await redis.sAdd(`user:${USER}:agents`, AGENT)
}

async function seedSession(
  sessionId: string,
  options: { fixed?: boolean; archived?: boolean; metadata?: Record<string, any> } = {}
) {
  await redis.json.set(`session:${sessionId}`, '$', {
    id: sessionId,
    user_id: USER,
    agent_id: AGENT,
    ...(options.archived ? { archived: true } : {}),
    last_modified_at: '2026-06-10T00:00:00.000Z',
    metadata: {
      ...(options.fixed
        ? { fixedSession: { version: 1, enabled: true, created_at: '2026-06-01T00:00:00.000Z' } }
        : {}),
      ...(options.metadata ?? {})
    }
  } as never)
  await redis.sAdd(`user:${USER}:sessions`, sessionId)
}

async function seedMessage(
  sessionId: string,
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: string,
  metadata: Record<string, any> = {}
) {
  await redis.json.set(`message:${sessionId}:${id}`, '$', {
    id,
    session_id: sessionId,
    user_id: USER,
    agent_id: AGENT,
    role,
    content,
    created_at: createdAt,
    metadata
  } as never)
  await redis.rPush(`messages:${sessionId}`, id)
}

async function seedEpisode(sessionId: string, episode: Partial<EpisodeRecord> & { id: string }) {
  const record: EpisodeRecord = {
    session_id: sessionId,
    agent_id: AGENT,
    state: 'open',
    opened_at: '2026-06-09T08:00:00.000Z',
    whiteboard: null,
    schema_version: 1,
    ...episode
  } as EpisodeRecord
  await redis.json.set(episodeKey(sessionId, record.id), '$', record as never)
  await redis.rPush(sessionEpisodesKey(sessionId), record.id)
  return record
}

async function seedMemory(overrides: Partial<CreateMemoryInput> & { content: string }) {
  return createMemory({
    agent_id: AGENT,
    user_id: USER,
    lane: 'ltm',
    importance: 5,
    provenance: [{ session_id: 'sess_origin', source: 'agent' }],
    ...overrides
  } as CreateMemoryInput)
}

const stubGenerator = (output: string) => async () => output

const bigText = (label: string) => `${label} ${'x'.repeat(6_000)}`

describe.runIf(memorySearchLaneActive())('SA-104 P7 dreaming', () => {
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
    await seedAgent()
    await redis.json.set(`model:${PRESET_ID}`, '$', {
      id: PRESET_ID,
      modelId: 'test-model',
      modelName: 'Test Model',
      provider: 'openai',
      contextWindow: 200_000
    } as never)
  })

  // -------------------------------------------------------------------------
  // Pure pieces: scheduled eligibility + verdict parsing
  // -------------------------------------------------------------------------

  it('shouldRunScheduledDream: memory on + idle past the gap + no run since last interaction', () => {
    const idleAgent = agentRecord({
      memory_last_interaction_ts: NOW.getTime() - 10 * 3_600_000
    })
    // Eligible: idle 10h > default 8h gap, no prior run.
    expect(shouldRunScheduledDream(idleAgent, null, NOW)).toBe(true)
    // A run since the last interaction settles the idle period.
    expect(
      shouldRunScheduledDream(idleAgent, new Date(NOW.getTime() - 3_600_000).toISOString(), NOW)
    ).toBe(false)
    // A run BEFORE the last interaction does not block the next idle period.
    expect(
      shouldRunScheduledDream(idleAgent, new Date(NOW.getTime() - 20 * 3_600_000).toISOString(), NOW)
    ).toBe(true)
    // Not idle long enough.
    expect(
      shouldRunScheduledDream(
        agentRecord({ memory_last_interaction_ts: NOW.getTime() - 3_600_000 }),
        null,
        NOW
      )
    ).toBe(false)
    // Never interacted → nothing to maintain.
    expect(shouldRunScheduledDream(agentRecord(), null, NOW)).toBe(false)
    // Memory off.
    expect(
      shouldRunScheduledDream(
        agentRecord({
          memory_enabled: false,
          memory_last_interaction_ts: NOW.getTime() - 10 * 3_600_000
        }),
        null,
        NOW
      )
    ).toBe(false)
  })

  it('parseDreamingConsolidationVerdict: strict JSON, fences tolerated, garbage refused', () => {
    expect(
      parseDreamingConsolidationVerdict(
        '{"merge": false, "reason": "different facts about the same dog"}'
      )
    ).toEqual({ merge: false, reason: 'different facts about the same dog' })
    const fenced = parseDreamingConsolidationVerdict(
      '```json\n{"merge": true, "reason": "same fact", "merged": {"lane": "ltm", "content": "Maggie is an Irish Setter"}}\n```'
    )
    expect(fenced.merge).toBe(true)
    expect(fenced.merged?.content).toContain('Maggie')
    expect(() => parseDreamingConsolidationVerdict('Sure! I think they should merge.')).toThrow(
      /not a JSON object/
    )
    expect(() => parseDreamingConsolidationVerdict('{"merge": true}')).toThrow(/reason/)
    expect(() =>
      parseDreamingConsolidationVerdict('{"merge": true, "reason": "same"}')
    ).toThrow(/no "merged"/)
  })

  // -------------------------------------------------------------------------
  // Consolidation (packet §1.2 phase 6)
  // -------------------------------------------------------------------------

  it('merges near-duplicates with provenance union and supersession; originals survive', async () => {
    const a = await seedMemory({
      content: '[vec1] Josh has an Irish Setter named Maggie',
      provenance: [{ session_id: 'sess_a', message_id: 'msg_a', source: 'agent' }]
    })
    const b = await seedMemory({
      content: '[vec1] Josh has an Irish Setter called Maggie (saved again later)',
      importance: 7,
      provenance: [{ session_id: 'sess_b', source: 'user' }]
    })
    const other = await seedMemory({
      content: '[vec2] The Batshit launch happened in June and went well overall'
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator(
        '{"merge": true, "reason": "both state the same dog fact", "merged": {"lane": "ltm", "content": "Josh has an Irish Setter named Maggie.", "gist": "Maggie the Irish Setter"}}'
      )
    })

    expect(run.status).toBe('completed')
    expect(run.counts.consolidationMerges).toBe(1)
    const mergeAction = run.actions.find((action) => action.kind === 'consolidate_merge')
    expect(mergeAction?.status).toBe('done')
    expect(mergeAction?.why).toContain('same dog fact')

    const memories = await listMemories(AGENT)
    const merged = memories.find(
      (memory) => memory.is_superseded !== 'y' && memory.content.includes('Maggie')
    )
    expect(merged).toBeTruthy()
    // DL-104-02: provenance union — both members' provenance entries survive.
    expect(merged?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_id: 'sess_a', message_id: 'msg_a' }),
        expect.objectContaining({ session_id: 'sess_b', source: 'user' })
      ])
    )
    // Importance is the deterministic max of the members.
    expect(merged?.importance).toBe(7)
    expect(new Set(merged?.supersedes)).toEqual(new Set([a.id, b.id]))
    // Originals are superseded, never deleted.
    expect((await getMemory(AGENT, a.id))?.is_superseded).toBe('y')
    expect((await getMemory(AGENT, b.id))?.is_superseded).toBe('y')
    // The unrelated memory is untouched.
    expect((await getMemory(AGENT, other.id))?.is_superseded).toBe('n')
  })

  it('logs kept-separate reviews and leaves malformed verdicts loudly failed', async () => {
    await seedMemory({ content: '[vec4] Josh prefers dark roast coffee in the morning' })
    await seedMemory({ content: '[vec4] Josh prefers dark roast coffee every morning' })

    const kept = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "one is about espresso"}')
    })
    expect(kept.counts.consolidationReviews).toBe(1)
    expect(kept.counts.consolidationMerges).toBe(0)
    const review = kept.actions.find((action) => action.kind === 'consolidation_review')
    expect(review?.why).toContain('kept separate')
    expect(review?.why).toContain('espresso')
    expect((await listMemories(AGENT)).every((memory) => memory.is_superseded !== 'y')).toBe(true)

    const malformed = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: new Date(NOW.getTime() + 60_000),
      generateSummary: stubGenerator('I refuse to answer in JSON today.')
    })
    expect(malformed.status).toBe('completed_with_errors')
    const failed = malformed.actions.find(
      (action) => action.kind === 'consolidate_merge' && action.status === 'failed'
    )
    expect(failed?.error).toMatch(/not a JSON object/)
    expect((await listMemories(AGENT)).every((memory) => memory.is_superseded !== 'y')).toBe(true)
  })

  it('auto-fills stm trigger terms from the members when the verdict omits them', async () => {
    await seedMemory({
      content: '[vec3] Maggie is afraid of thunder and hides under the desk',
      lane: 'stm',
      trigger_terms: ['maggie', 'thunder']
    })
    await seedMemory({
      content: '[vec3] Maggie hides under the desk during thunderstorms',
      lane: 'stm',
      trigger_terms: ['storm']
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator(
        '{"merge": true, "reason": "same fear fact", "merged": {"lane": "stm", "content": "Maggie is afraid of thunder and hides under the desk."}}'
      )
    })
    expect(run.counts.consolidationMerges).toBe(1)
    const merged = (await listMemories(AGENT)).find((memory) => memory.is_superseded !== 'y')
    expect(merged?.lane).toBe('stm')
    expect(new Set(merged?.trigger_terms)).toEqual(new Set(['maggie', 'thunder', 'storm']))
  })

  // -------------------------------------------------------------------------
  // Expiry processing (packet §1.2 phase 4 — demote, never erase)
  // -------------------------------------------------------------------------

  it('demotes expired memories by lane and settles them exactly once', async () => {
    const past = new Date(NOW.getTime() - 86_400_000).toISOString()
    const awarenessWithTriggers = await seedMemory({
      content: 'Remember the birthday party plan every day until it happens',
      lane: 'awareness',
      trigger_terms: ['birthday'],
      expires_at: past
    })
    const awarenessPlain = await seedMemory({
      content: 'Keep the migration deadline in mind through the week',
      lane: 'awareness',
      expires_at: past
    })
    const stm = await seedMemory({
      content: 'The temporary door code for the venue is 4417',
      lane: 'stm',
      trigger_terms: ['door code'],
      expires_at: past
    })
    const ltm = await seedMemory({
      content: 'The catering quote was only valid through last Friday',
      lane: 'ltm',
      expires_at: past
    })
    const unexpired = await seedMemory({
      content: 'The venue balance is due at the end of next month',
      lane: 'awareness',
      expires_at: new Date(NOW.getTime() + 86_400_000).toISOString()
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })
    expect(run.counts.expiriesDemoted).toBe(4)

    expect((await getMemory(AGENT, awarenessWithTriggers.id))?.lane).toBe('stm')
    expect((await getMemory(AGENT, awarenessPlain.id))?.lane).toBe('ltm')
    expect((await getMemory(AGENT, stm.id))?.lane).toBe('ltm')
    const settledLtm = await getMemory(AGENT, ltm.id)
    expect(settledLtm?.lane).toBe('ltm')
    expect(settledLtm?.expired_demoted_to).toBe('ltm')
    expect((await getMemory(AGENT, unexpired.id))?.lane).toBe('awareness')
    // Nothing was erased.
    expect((await listMemories(AGENT)).length).toBeGreaterThanOrEqual(5)

    // Second pass: everything is settled — zero new demotions.
    const second = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: new Date(NOW.getTime() + 60_000),
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })
    expect(second.counts.expiriesDemoted).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Supersession repair (packet §1.2 phase 5 — the pointer is the authority)
  // -------------------------------------------------------------------------

  it('repairs dangling pointers, crashed half-writes, and flag mismatches', async () => {
    // (a) dangling superseded_by: successor explicitly deleted.
    const orphaned = await seedMemory({ content: 'The old office wifi password was hunter2' })
    const ghost = await seedMemory({ content: 'The new office wifi password is hunter3' })
    await supersedeMemory(AGENT, ghost.id, [orphaned.id])
    await redis.execute(async (client) => {
      await client.del(`memory:${AGENT}:${ghost.id}`)
    })

    // (b) crashed supersede: predecessor marked, successor never updated.
    const pred = await seedMemory({ content: 'Standup moved to 9am starting Monday' })
    const succ = await seedMemory({ content: 'Standup is at 9:30am now, changed again' })
    const predRecord = (await getMemory(AGENT, pred.id)) as Record<string, any>
    predRecord.superseded_by = succ.id
    predRecord.is_superseded = 'y'
    await redis.json.set(`memory:${AGENT}:${pred.id}`, '$', predRecord as never)

    // (c) crashed unsupersede: predecessor already restored, successor still claims it.
    const restored = await seedMemory({ content: 'The staging server lives at 10.0.0.7' })
    const claimer = await seedMemory({ content: 'The staging server moved to 10.0.0.9' })
    const claimerRecord = (await getMemory(AGENT, claimer.id)) as Record<string, any>
    claimerRecord.supersedes = [restored.id]
    await redis.json.set(`memory:${AGENT}:${claimer.id}`, '$', claimerRecord as never)

    // (d) flag mismatch: superseded flag on with no pointer.
    const flagged = await seedMemory({ content: 'Lunch orders go through the deli app' })
    const flaggedRecord = (await getMemory(AGENT, flagged.id)) as Record<string, any>
    flaggedRecord.is_superseded = 'y'
    await redis.json.set(`memory:${AGENT}:${flagged.id}`, '$', flaggedRecord as never)

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })
    expect(run.counts.supersessionRepairs).toBeGreaterThanOrEqual(4)

    const repairedOrphan = await getMemory(AGENT, orphaned.id)
    expect(repairedOrphan?.superseded_by).toBeNull()
    expect(repairedOrphan?.is_superseded).toBe('n')

    const completedSucc = await getMemory(AGENT, succ.id)
    expect(completedSucc?.supersedes).toContain(pred.id)
    expect((await getMemory(AGENT, pred.id))?.is_superseded).toBe('y')

    const prunedClaimer = await getMemory(AGENT, claimer.id)
    expect(prunedClaimer?.supersedes ?? []).not.toContain(restored.id)
    expect((await getMemory(AGENT, restored.id))?.is_superseded).toBe('n')

    expect((await getMemory(AGENT, flagged.id))?.is_superseded).toBe('n')
  })

  // -------------------------------------------------------------------------
  // Overnight episode work (packet §1.2 phase 1)
  // -------------------------------------------------------------------------

  it('closes idle episodes, honors holds, and graduates closed episodes with the floor intact', async () => {
    await seedSession(FIXED_SESSION, { fixed: true })
    // Old closed episode: 4 small messages before its closed_at.
    await seedMessage(FIXED_SESSION, 'm1', 'user', 'Plan the lake trip', '2026-06-09T08:00:00.000Z')
    await seedMessage(FIXED_SESSION, 'm2', 'assistant', 'Trip planned for July.', '2026-06-09T08:05:00.000Z')
    await seedMessage(FIXED_SESSION, 'm3', 'user', 'Book the cabin', '2026-06-09T08:10:00.000Z')
    await seedMessage(FIXED_SESSION, 'm4', 'assistant', 'Cabin booked.', '2026-06-09T08:15:00.000Z')
    // Recent tail AFTER the boundary: big enough to absorb the 1,000-token floor.
    await seedMessage(FIXED_SESSION, 'm5', 'user', bigText('Recent work'), '2026-06-10T11:00:00.000Z')
    await seedEpisode(FIXED_SESSION, {
      id: 'ep_closed',
      state: 'closed',
      opened_at: '2026-06-09T08:00:00.000Z',
      closed_at: '2026-06-09T09:00:00.000Z',
      boundary_signal: 'agent_mark'
    })
    // Open episode, idle for 27 hours — no hold.
    await seedEpisode(FIXED_SESSION, {
      id: 'ep_open',
      state: 'open',
      opened_at: '2026-06-09T09:00:00.000Z',
      last_activity_at: '2026-06-09T09:00:00.000Z'
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('Lake trip planned and cabin booked for July.')
    })

    expect(run.counts.episodesClosed).toBe(1)
    expect((await getEpisode(FIXED_SESSION, 'ep_open'))?.state).toBe('closed')
    expect((await getEpisode(FIXED_SESSION, 'ep_open'))?.boundary_signal).toBe('dreaming')

    // The closed episode graduated: memseg + window event + graduated mark.
    expect(run.counts.episodesGraduated).toBeGreaterThanOrEqual(1)
    expect((await getEpisode(FIXED_SESSION, 'ep_closed'))?.state).toBe('graduated')
    const segments = await listMemorySegments(AGENT)
    const graduatedSegment = segments.find((segment) => segment.episode_id === 'ep_closed')
    expect(graduatedSegment?.graduated_by).toBe('dreaming')
    const session = await redis.getSession(FIXED_SESSION)
    const events = getFixedSessionGraduationState(session?.metadata ?? null).events
    expect(events.some((event) => event.episodeId === 'ep_closed')).toBe(true)
    // The floor-protected recent tail stays live: m5 is not in any graduated range.
    expect(events.flatMap((event) => event.sourceMessageIds)).not.toContain('m5')

    // A future hold suppresses overnight closure — logged, not silent.
    await seedSession('sess_dream_held', { fixed: true })
    await seedEpisode('sess_dream_held', {
      id: 'ep_held',
      state: 'open',
      opened_at: '2026-06-09T09:00:00.000Z',
      last_activity_at: '2026-06-09T09:00:00.000Z',
      hold_until: '2026-06-12T09:00:00.000Z'
    })
    const heldRun = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: new Date(NOW.getTime() + 60_000),
      generateSummary: stubGenerator('unused')
    })
    expect((await getEpisode('sess_dream_held', 'ep_held'))?.state).toBe('open')
    const holdSkip = heldRun.actions.find(
      (action) => action.kind === 'close_episode' && action.status === 'skipped'
    )
    expect(holdSkip?.why).toContain('held')
  })

  it('skips sessions with a live turn and logs why (DL-104-15)', async () => {
    await seedSession(FIXED_SESSION, { fixed: true })
    await seedEpisode(FIXED_SESSION, {
      id: 'ep_live',
      state: 'closed',
      opened_at: '2026-06-09T08:00:00.000Z',
      closed_at: '2026-06-09T09:00:00.000Z'
    })
    const registered = registerSessionTurn(FIXED_SESSION, 'single', 'msg_live')
    expect(registered.ok).toBe(true)
    try {
      const run = await runDreamingPass({
        userId: USER,
        agent: agentRecord(),
        trigger: 'manual',
        now: NOW,
        generateSummary: stubGenerator('unused')
      })
      const skips = run.actions.filter(
        (action) => action.kind === 'skip_session' && action.refs?.sessionId === FIXED_SESSION
      )
      expect(skips.length).toBeGreaterThanOrEqual(1)
      expect(skips[0].why).toContain('live turn')
      expect((await getEpisode(FIXED_SESSION, 'ep_live'))?.state).toBe('closed')
    } finally {
      clearSessionTurn(FIXED_SESSION)
    }
  })

  // -------------------------------------------------------------------------
  // Regular-session idle sweep (packet §1.2 phase 2 — the durable lane)
  // -------------------------------------------------------------------------

  it('sweeps idle regular sessions (archived included) through the shared writer', async () => {
    await seedSession(REGULAR_SESSION, {})
    await seedSession(ARCHIVED_SESSION, { archived: true })
    for (const [sessionId, prefix] of [
      [REGULAR_SESSION, 'r'],
      [ARCHIVED_SESSION, 'a']
    ] as const) {
      await seedMessage(sessionId, `${prefix}1`, 'user', 'What is the wifi password?', '2026-06-09T08:00:00.000Z')
      await seedMessage(sessionId, `${prefix}2`, 'assistant', 'It is hunter3.', '2026-06-09T08:01:00.000Z')
      await seedMessage(sessionId, `${prefix}3`, 'user', 'Thanks, noted.', '2026-06-09T08:02:00.000Z')
      await seedMessage(sessionId, `${prefix}4`, 'assistant', 'Anytime.', '2026-06-09T08:03:00.000Z')
    }

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('Shared the wifi password.')
    })

    expect(run.counts.regularSessionsGraduated).toBe(2)
    const segments = await listMemorySegments(AGENT)
    expect(segments.filter((segment) => segment.graduated_by === 'idle')).toHaveLength(2)
    const regular = await redis.getSession(REGULAR_SESSION)
    expect((regular?.metadata as Record<string, any>)?.memoryGraduation?.lastGraduatedMessageId).toBe('r4')

    // A fresh pass finds nothing new — the watermark holds (quiet no-op, no actions).
    const second = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: new Date(NOW.getTime() + 60_000),
      generateSummary: stubGenerator('unused')
    })
    expect(second.counts.regularSessionsGraduated).toBe(0)
    expect(second.actions.filter((action) => action.kind === 'graduate_regular_tail')).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Embedding refresh (packet §1.2 phase 3)
  // -------------------------------------------------------------------------

  it('re-embeds records whose embedding model drifted from the built index', async () => {
    const memory = await seedMemory({ content: 'Josh works from the standing desk on Tuesdays' })
    await redis.json.set(`memory:${AGENT}:${memory.id}`, '$.embedding_model', 'old-model@8' as never)

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })
    expect(run.counts.reembedded).toBe(1)
    const refreshed = await getMemory(AGENT, memory.id)
    expect(refreshed?.embedding_model).toBe('local-ai:test-embedder@8')
    const action = run.actions.find((entry) => entry.kind === 'reembed')
    expect(action?.why).toContain('old-model@8')
  })

  // -------------------------------------------------------------------------
  // Era consolidation (packet §1.2 phase 7)
  // -------------------------------------------------------------------------

  it('distills the oldest aged graduation events into one era event + era segment', async () => {
    const events: FixedSessionGraduationEvent[] = []
    for (let index = 0; index < 13; index += 1) {
      events.push({
        id: `grad_old_${index}`,
        createdAt: new Date(
          new Date('2026-05-01T00:00:00.000Z').getTime() + index * 60_000
        ).toISOString(),
        source: 'nap',
        episodeId: null,
        segmentId: `memseg_missing_${index}`,
        sourceMessageIds: [`em${index}`],
        compactedMessageCount: 1,
        summary: `Old stretch ${index}: work on chapter ${index}.`,
        summaryTokenEstimate: 12
      })
    }
    await seedSession(FIXED_SESSION, {
      fixed: true,
      metadata: { fixedSession: { version: 1, enabled: true, graduation: { version: 1, events } } }
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('Era summary: chapters 0 through 7 in one arc.')
    })
    expect(run.counts.eraConsolidations).toBe(1)

    const session = await redis.getSession(FIXED_SESSION)
    const after = getFixedSessionGraduationState(session?.metadata ?? null).events
    expect(after).toHaveLength(13 - DREAMING_ERA_BATCH_MAX + 1)
    const eraEvent = after[0]
    expect(eraEvent.source).toBe('dreaming')
    expect(eraEvent.summary).toContain('Era summary')
    expect(eraEvent.sourceMessageIds).toEqual(
      Array.from({ length: DREAMING_ERA_BATCH_MAX }, (_, index) => `em${index}`)
    )
    // The remaining events are the untouched newer ones, in order.
    expect(after.slice(1).map((event) => event.id)).toEqual(
      Array.from({ length: 13 - DREAMING_ERA_BATCH_MAX }, (_, index) => `grad_old_${index + DREAMING_ERA_BATCH_MAX}`)
    )
    // The era segment exists and is searchable-class data.
    const eraSegment = (await listMemorySegments(AGENT)).find(
      (segment) => segment.id === eraEvent.segmentId
    )
    expect(eraSegment?.graduated_by).toBe('dreaming')
    expect(eraSegment?.summary).toContain('Era summary')
    // The splice applier consumes the era event like any other (idempotent shape).
    const messages = Array.from({ length: 13 }, (_, index) => ({
      id: `em${index}`,
      role: 'user',
      content: `original ${index}`,
      created_at: '2026-05-01T00:00:00.000Z',
      metadata: {}
    })) as never[]
    const applied = applyFixedSessionGraduationToMessages(messages as never, session as never)
    const splices = applied.filter(
      (message) => (message as Record<string, any>).metadata?.fixedSessionGraduation
    )
    // One era splice replaces the 8 merged gists; the 5 newer events keep theirs.
    expect(splices).toHaveLength(13 - DREAMING_ERA_BATCH_MAX + 1)
    expect(
      applied.filter((message) => String((message as Record<string, any>).id).startsWith('em'))
    ).toHaveLength(0)

    // A second pass with the same clock finds only 6 events (≤ 12) — era waits.
    const second = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: new Date(NOW.getTime() + 60_000),
      generateSummary: stubGenerator('unused')
    })
    expect(second.counts.eraConsolidations).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Budget, mutex, log, rotation, cleanup
  // -------------------------------------------------------------------------

  it('stops model-dependent work at the model-call budget with skipped-with-why actions', async () => {
    await seedMemory({ content: '[vec5] Duplicate fact one about the garden gnome collection' })
    await seedMemory({ content: '[vec5] Duplicate fact one about the gnome collection again' })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      maxModelCalls: 0,
      generateSummary: stubGenerator('{"merge": false, "reason": "reviewed, distinct"}')
    })
    expect(run.counts.modelCalls).toBe(0)
    expect(run.counts.consolidationReviews).toBe(0)
    const skipped = run.actions.find(
      (action) => action.kind === 'consolidate_merge' && action.status === 'skipped'
    )
    expect(skipped?.why).toContain('budget')
    // Budget exhaustion is bounded-by-design, not a failure.
    expect(run.status).toBe('completed')
  })

  it('refuses concurrent dreams per agent (busy mutex) and reports via isAgentDreaming', async () => {
    await seedSession(FIXED_SESSION, { fixed: true })
    await seedMessage(FIXED_SESSION, 'b1', 'user', bigText('one'), '2026-06-09T08:00:00.000Z')
    await seedMessage(FIXED_SESSION, 'b2', 'assistant', bigText('two'), '2026-06-09T08:01:00.000Z')
    await seedMessage(FIXED_SESSION, 'b3', 'user', bigText('three'), '2026-06-09T08:02:00.000Z')
    await seedMessage(FIXED_SESSION, 'b4', 'assistant', bigText('four'), '2026-06-09T08:03:00.000Z')
    await seedMessage(FIXED_SESSION, 'b5', 'user', bigText('recent tail'), '2026-06-10T11:00:00.000Z')
    await seedEpisode(FIXED_SESSION, {
      id: 'ep_slow',
      state: 'closed',
      opened_at: '2026-06-09T08:00:00.000Z',
      closed_at: '2026-06-09T09:00:00.000Z'
    })

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const first = runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: async () => {
        await gate
        return 'Slow summary.'
      }
    })
    await expect(
      runDreamingPass({
        userId: USER,
        agent: agentRecord(),
        trigger: 'manual',
        now: NOW,
        generateSummary: stubGenerator('unused')
      })
    ).rejects.toThrow(DreamingBusyError)
    release()
    const finished = await first
    expect(finished.status).toBe('completed')
  })

  it('keeps a capped, newest-first visible log and rotates old run records out', async () => {
    // Pre-fill the index to the cap with fake runs.
    for (let index = DREAMING_RUN_HISTORY_LIMIT - 1; index >= 0; index -= 1) {
      const runId = `dream_fake_${index}`
      await redis.json.set(`memdream:${AGENT}:${runId}`, '$', {
        id: runId,
        agent_id: AGENT,
        user_id: USER,
        trigger: 'scheduled',
        started_at: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
        finished_at: null,
        status: 'completed',
        actions: [],
        counts: { failures: 0 },
        schema_version: 1
      } as never)
      await redis.execute(async (client) => client.lPush(`memdream_index:${AGENT}`, runId))
    }

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('unused')
    })

    const index = await redis.execute(async (client) =>
      client.lRange(`memdream_index:${AGENT}`, 0, -1)
    )
    expect(index).toHaveLength(DREAMING_RUN_HISTORY_LIMIT)
    expect(index[0]).toBe(run.id)
    // The rotated-out oldest fake run record was deleted with its index entry.
    expect(index).not.toContain(`dream_fake_${DREAMING_RUN_HISTORY_LIMIT - 1}`)
    expect(await getDreamRun(AGENT, `dream_fake_${DREAMING_RUN_HISTORY_LIMIT - 1}`)).toBeNull()

    const summaries = await getDreamRunSummaries(AGENT, 5)
    expect(summaries[0].id).toBe(run.id)
    expect(summaries[0].status).toBe('completed')
    const full = await getDreamRun(AGENT, run.id)
    expect(full?.actions).toBeDefined()
  })

  it('deleteAgent removes the dreaming log (DL-104-13)', async () => {
    await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('unused')
    })
    const before = await redis.execute(async (client) => client.keys(`memdream:${AGENT}:*`))
    expect(before.length).toBeGreaterThan(0)

    await redis.deleteAgent(AGENT)

    const after = await redis.execute(async (client) => client.keys(`memdream*`))
    expect(after).toHaveLength(0)
  })

  it('a failed run persists an honest failed record instead of vanishing', async () => {
    // Break the index meta so requireReadyMemoryIndexes throws mid-run.
    await redis.execute(async (client) => {
      await client.del('batshit:memory_index_meta')
    })
    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('unused')
    })
    expect(run.status).toBe('failed')
    expect(run.error).toBeTruthy()
    const persisted = await getDreamRun(AGENT, run.id)
    expect(persisted?.status).toBe('failed')
    const summaries = await getDreamRunSummaries(AGENT)
    expect(summaries[0]?.id).toBe(run.id)
  })
})
