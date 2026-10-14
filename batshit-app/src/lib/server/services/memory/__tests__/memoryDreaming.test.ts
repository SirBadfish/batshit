import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { updateManagedMemory } from '../memoryManage'
import {
  applyFixedSessionGraduationToMessages,
  getFixedSessionGraduationState,
  type FixedSessionGraduationEvent
} from '$lib/utils/fixedSessionGraduation'
import { reportForCliSnapshot } from '$lib/utils/cliContextWindow'
import {
  clearSessionTurn,
  registerSessionTurn,
  releaseSessionTurn
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
const CLAUDE_CAP_ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
] as const

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

function namedClaudeCliAgent(memoryWindow: Record<string, unknown> = {
  floor_mode: 'auto',
  ceiling_headroom_mode: 'auto',
  nap_threshold_percent: 80
}, overrides: Record<string, unknown> = {}) {
  return agentRecord({
    primary_model_preset_id: null,
    primary_model_provider: 'claude-cli',
    primary_model_name: 'claude/claude-cli',
    primary_model_connection: { id: 'claude-cli', type: 'direct', service: 'claude-cli' },
    claude_settings: { permissionMode: 'default', model: 'sonnet' },
    memory_window: memoryWindow,
    ...overrides
  })
}

async function seedCliContextReport(sessionId: string, agent: Record<string, any>, contextWindow: number) {
  const report = reportForCliSnapshot({
    runtime: 'claude',
    model: 'sonnet',
    actualModel: 'claude-sonnet-5',
    contextWindow,
    evidence: 'runtime',
    disableClaude1M: false,
    reportedAt: NOW.getTime()
  }, agent, null, null, agent.primary_model_name)
  await redis.json.set(`session:${sessionId}:execution_log`, '$', [{
    id: `reply-${sessionId}`,
    sessionId,
    userId: USER,
    agentId: agent.id,
    agentName: 'Claude context report fixture',
    agentType: 'cli',
    createdAt: NOW.toISOString(),
    runtime: { runtimeId: 'claude', metadata: { cliContextWindow: report } }
  }] as never)
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
    for (const key of CLAUDE_CAP_ENV_KEYS) vi.stubEnv(key, '')
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

  afterEach(() => {
    vi.unstubAllEnvs()
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

    // SA-110 P2 (DL-110-06b): the awareness fold is the run's final logged step —
    // 'done' when the run changed what awareness compiles to, 'skipped' otherwise.
    const foldAction = run.actions.at(-1)
    expect(foldAction?.kind).toBe('awareness_fold')
    expect(['done', 'skipped']).toContain(foldAction?.status)

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

  // BL-786: expiry demotion moved an Awareness record out of Awareness but left
  // `media_mode: 'always'`, a state only Awareness may hold. Every later save of that record
  // was refused ("Turn off 'Show this image every message' before moving this memory out of
  // Awareness"), and the panel hides that switch outside Awareness, so the user had no way out.
  const expiredStandingImage = (id: string) => ({
    id,
    filename: `${AGENT}/mem_bl786/${id}.png`,
    display_name: `${id}.png`,
    mime_type: 'image/png' as const,
    bytes: 3,
    width: 1,
    height: 1,
    token_estimate: 1,
    sha256: id.padEnd(64, 'e').slice(0, 64)
  })
  // What the Memory Panel's Save Changes sends for an LTM record when only importance changed.
  const panelSave = (importance: number) =>
    ({
      gist: null,
      importance,
      lane: 'ltm',
      trigger_terms: null,
      trigger_synonyms: null,
      linger_override: null
    }) as never

  it('expiry demotion turns a standing image to recall-only, logs it, and the panel can save the record (BL-786)', async () => {
    const standing = await seedMemory({
      lane: 'awareness',
      content: '[vec5] The photo of the conference badge',
      media_mode: 'always',
      media: [expiredStandingImage('b1')],
      expires_at: '2026-06-01T12:00:00.000Z'
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })

    const demoted = await getMemory(AGENT, standing.id)
    expect(demoted?.lane).toBe('ltm')
    expect(demoted?.media_mode).toBe('on_recall')
    expect(demoted?.media).toHaveLength(1)
    const action = run.actions.find(
      (entry) => entry.kind === 'expire_demote' && entry.refs?.memoryId === standing.id
    )
    expect(action?.status).toBe('done')
    expect(action?.why).toMatch(/only when the memory is recalled/)
    expect(action?.refs).toMatchObject({ mediaMode: { from: 'always', to: 'on_recall' } })

    const saved = await updateManagedMemory({ userId: USER, agentId: AGENT }, standing.id, panelSave(8))
    expect(saved.importance).toBe(8)
  })

  it('dreaming settles a record an older demotion left with a standing image outside Awareness (BL-786)', async () => {
    const stuck = await seedMemory({
      lane: 'awareness',
      content: '[vec6] The photo of the old office door',
      media_mode: 'always',
      media: [expiredStandingImage('d1')],
      expires_at: '2026-06-01T12:00:00.000Z'
    })
    // The shape the old demotion wrote: out of Awareness, already marked processed, still `always`.
    const record = (await getMemory(AGENT, stuck.id)) as Record<string, any>
    record.lane = 'ltm'
    record.expired_demoted_to = 'ltm'
    await redis.json.set(`memory:${AGENT}:${stuck.id}`, '$', record as never)
    await expect(
      updateManagedMemory({ userId: USER, agentId: AGENT }, stuck.id, panelSave(8))
    ).rejects.toThrow(/before moving this memory out of Awareness/)

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })

    const settled = await getMemory(AGENT, stuck.id)
    expect(settled?.lane).toBe('ltm')
    expect(settled?.media_mode).toBe('on_recall')
    expect(settled?.media).toHaveLength(1)
    const action = run.actions.find(
      (entry) => entry.kind === 'expire_demote' && entry.refs?.memoryId === stuck.id
    )
    expect(action?.why).toMatch(/only when the memory is recalled/)
    expect(action?.refs).toMatchObject({ mediaMode: { from: 'always', to: 'on_recall' } })
    expect((await updateManagedMemory({ userId: USER, agentId: AGENT }, stuck.id, panelSave(8))).importance).toBe(8)

    // Settled once: the next dream finds nothing to do for it.
    const second = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: new Date(NOW.getTime() + 60_000),
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })
    expect(second.actions.some((entry) => entry.refs?.memoryId === stuck.id)).toBe(false)
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

    // (e) valid reverse-age direction: the older record is deliberately canonical.
    const olderWinner = await seedMemory({ content: '[vec6] Canonical original decision' })
    const newerDuplicate = await seedMemory({ content: '[vec7] Later duplicate decision' })
    await supersedeMemory(AGENT, olderWinner.id, [newerDuplicate.id])

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
    expect((await getMemory(AGENT, newerDuplicate.id))?.superseded_by).toBe(olderWinner.id)
    expect((await getMemory(AGENT, olderWinner.id))?.supersedes).toContain(newerDuplicate.id)
  })

  // BL-438: restoring a record to current must not push the agent past the 4-image standing
  // cap, or every send of the agent then fails at the compile. Dreaming cannot refuse (the record
  // is broken and must become current), so an over-cap record comes back with its images on
  // recall, and the action log says so.
  const standingImage = (id: string) => ({
    id,
    filename: `${AGENT}/mem_bl438/${id}.png`,
    display_name: `${id}.png`,
    mime_type: 'image/png' as const,
    bytes: 3,
    width: 1,
    height: 1,
    token_estimate: 1,
    sha256: id.padEnd(64, 'c').slice(0, 64)
  })

  async function activeStandingImages(): Promise<number> {
    return (await listMemories(AGENT))
      .filter(
        (memory) =>
          memory.lane === 'awareness' &&
          memory.media_mode === 'always' &&
          memory.is_superseded !== 'y' &&
          !(typeof memory.expires_ts === 'number' && memory.expires_ts <= Date.now())
      )
      .reduce((sum, memory) => sum + (memory.media?.length ?? 0), 0)
  }

  it('repair restores an over-cap standing record with its images on recall and logs why (BL-438)', async () => {
    // (a) dangling pointer: the pair's successor is deleted after the slots filled up.
    const pair = await seedMemory({
      lane: 'awareness',
      content: '[vec1] The two photos of the cabin',
      media_mode: 'always',
      media: ['p1', 'p2'].map(standingImage)
    })
    const ghost = await seedMemory({ lane: 'awareness', content: '[vec2] Cabin notes without photos' })
    await supersedeMemory(AGENT, ghost.id, [pair.id])
    // (b) flag mismatch: the superseded flag is on with no pointer.
    const single = await seedMemory({
      lane: 'awareness',
      content: '[vec3] The photo of the dock',
      media_mode: 'always',
      media: [standingImage('s1')]
    })
    const singleRecord = (await getMemory(AGENT, single.id)) as Record<string, any>
    singleRecord.is_superseded = 'y'
    await redis.json.set(`memory:${AGENT}:${single.id}`, '$', singleRecord as never)
    // The agent fills all four slots meanwhile.
    const full = await seedMemory({
      lane: 'awareness',
      content: '[vec4] Four photos of the lake',
      media_mode: 'always',
      media: ['f1', 'f2', 'f3', 'f4'].map(standingImage)
    })
    await redis.execute(async (client) => {
      await client.del(`memory:${AGENT}:${ghost.id}`)
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })

    for (const [restoredId, imageCount] of [
      [pair.id, 2],
      [single.id, 1]
    ] as const) {
      const restored = await getMemory(AGENT, restoredId)
      expect(restored?.is_superseded).toBe('n')
      expect(restored?.superseded_by ?? null).toBeNull()
      expect(restored?.media_mode).toBe('on_recall')
      // Nothing is dropped: the images stay on the memory and arrive when it is recalled.
      expect(restored?.media).toHaveLength(imageCount)
      const action = run.actions.find(
        (entry) => entry.kind === 'supersession_repair' && entry.refs?.memoryId === restoredId
      )
      expect(action?.status).toBe('done')
      expect(action?.why).toMatch(/cap of 4/)
      expect(action?.why).toMatch(/only when the memory is recalled/)
      expect(action?.refs).toMatchObject({ mediaMode: { from: 'always', to: 'on_recall' } })
    }
    expect((await getMemory(AGENT, full.id))?.media_mode).toBe('always')
    expect(await activeStandingImages()).toBe(4)
  })

  it('repair keeps always-on images that still fit under the cap (BL-438)', async () => {
    const pair = await seedMemory({
      lane: 'awareness',
      content: '[vec1] The two photos of the cabin',
      media_mode: 'always',
      media: ['p1', 'p2'].map(standingImage)
    })
    const ghost = await seedMemory({ lane: 'awareness', content: '[vec2] Cabin notes without photos' })
    await supersedeMemory(AGENT, ghost.id, [pair.id])
    await seedMemory({
      lane: 'awareness',
      content: '[vec4] Two photos of the lake',
      media_mode: 'always',
      media: ['f1', 'f2'].map(standingImage)
    })
    await redis.execute(async (client) => {
      await client.del(`memory:${AGENT}:${ghost.id}`)
    })

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('{"merge": false, "reason": "unrelated"}')
    })

    const restored = await getMemory(AGENT, pair.id)
    expect(restored?.is_superseded).toBe('n')
    expect(restored?.media_mode).toBe('always')
    const action = run.actions.find(
      (entry) => entry.kind === 'supersession_repair' && entry.refs?.memoryId === pair.id
    )
    expect(action?.why).not.toMatch(/recalled/)
    expect(await activeStandingImages()).toBe(4)
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

  it('uses each fixed session report for dreaming floor and era-summary budgets', async () => {
    const cliAgent = namedClaudeCliAgent()
    const reportSession = 'sess_dream_cli_report'
    const choiceSession = 'sess_dream_cli_choice'
    const oldGraduationEvents = (sessionId: string): FixedSessionGraduationEvent[] =>
      Array.from({ length: 13 }, (_, index) => ({
        id: `grad_${sessionId}_${index}`,
        createdAt: new Date(Date.parse('2026-05-01T00:00:00.000Z') + index * 60_000).toISOString(),
        source: 'nap' as const,
        episodeId: null,
        segmentId: `memseg_${sessionId}_${index}`,
        sourceMessageIds: [`archived-${sessionId}-${index}`],
        compactedMessageCount: 1,
        summary: `Old stretch ${index}: ${'important remembered detail '.repeat(6_000)}`,
        summaryTokenEstimate: 18_000
      }))

    for (const sessionId of [reportSession, choiceSession]) {
      await seedSession(sessionId, {
        fixed: true,
        metadata: {
          fixedSession: {
            version: 1,
            enabled: true,
            created_at: '2026-06-01T00:00:00.000Z',
            graduation: { version: 1, events: oldGraduationEvents(sessionId) }
          }
        }
      })
      await seedMessage(sessionId, `old-${sessionId}-1`, 'user', 'Earlier episode start.', '2026-06-09T08:00:00.000Z')
      await seedMessage(sessionId, `old-${sessionId}-2`, 'assistant', 'Earlier episode reply.', '2026-06-09T08:05:00.000Z')
      await seedMessage(sessionId, `old-${sessionId}-3`, 'user', 'Earlier episode follow-up.', '2026-06-09T08:10:00.000Z')
      await seedMessage(sessionId, `old-${sessionId}-4`, 'assistant', `Older episode detail ${'episode detail '.repeat(14_000)}`, '2026-06-09T08:15:00.000Z')
      await seedMessage(sessionId, `recent-${sessionId}`, 'user', `Recent tail ${'recent detail '.repeat(18_000)}`, '2026-06-10T11:00:00.000Z')
      await seedEpisode(sessionId, {
        id: `closed-${sessionId}`,
        state: 'closed',
        opened_at: '2026-06-09T08:00:00.000Z',
        closed_at: '2026-06-09T09:00:00.000Z',
        boundary_signal: 'agent_mark'
      })
    }
    await seedCliContextReport(reportSession, cliAgent, 200_000)

    const eraHardMaxes: number[] = []
    const run = await runDreamingPass({
      userId: USER,
      agent: cliAgent,
      trigger: 'manual',
      now: NOW,
      generateSummary: async (prompt, hardMaxTokens) => {
        if (prompt.includes('STRETCH 1 (graduated')) eraHardMaxes.push(hardMaxTokens)
        return prompt.includes('STRETCH 1 (graduated')
          ? 'Era summary: older chapters form one arc.'
          : 'Episode summary: preserve the earlier decision.'
      }
    })

    const graduated = await listMemorySegments(AGENT)
    expect.soft(graduated.some((segment) => segment.episode_id === `closed-${reportSession}`)).toBe(true)
    expect.soft(graduated.some((segment) => segment.episode_id === `closed-${choiceSession}`)).toBe(false)
    expect(run.counts.eraConsolidations).toBe(2)
    expect.soft(eraHardMaxes.sort((a, b) => a - b)).toEqual([5_000, 16_000])
  })

  it('skips unknown CLI-default floor and era work without summary calls', async () => {
    const unknownAgent = namedClaudeCliAgent(undefined, {
      claude_settings: { permissionMode: 'default' }
    })
    const events: FixedSessionGraduationEvent[] = Array.from({ length: 13 }, (_, index) => ({
      id: `unknown-grad-${index}`,
      createdAt: new Date(Date.parse('2026-05-01T00:00:00.000Z') + index * 60_000).toISOString(),
      source: 'nap',
      episodeId: null,
      segmentId: `unknown-memseg-${index}`,
      sourceMessageIds: [`unknown-source-${index}`],
      compactedMessageCount: 1,
      summary: `Unknown model stretch ${index}.`,
      summaryTokenEstimate: 5
    }))
    await seedSession(FIXED_SESSION, {
      fixed: true,
      metadata: {
        fixedSession: {
          version: 1,
          enabled: true,
          created_at: '2026-06-01T00:00:00.000Z',
          graduation: { version: 1, events }
        }
      }
    })
    let summaryCalls = 0

    const run = await runDreamingPass({
      userId: USER,
      agent: unknownAgent,
      trigger: 'manual',
      now: NOW,
      generateSummary: async () => {
        summaryCalls += 1
        return 'should not run'
      }
    })

    expect(summaryCalls).toBe(0)
    expect(run.actions.some((action) => action.kind === 'skip_session' && action.why.includes('no model context limit'))).toBe(true)
    expect(run.actions.some((action) => action.kind === 'era_consolidation' && action.status === 'skipped' && action.why.includes('no model context limit'))).toBe(true)
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
      // An OWNED release. `clearSessionTurn` without the id no longer deletes a young
      // owned lock (SA-113 review fix: an id-less release used to let a stale Stop cancel
      // a live turn), so leaving it unowned kept this lock alive into the next test, where
      // dreaming then skipped FIXED_SESSION as "live" and distilled nothing.
      clearSessionTurn(FIXED_SESSION, 'msg_live')
    }
  })

  // BL-549 N7: dreaming looks for a turn before each write, not only when it reaches the chat.
  it('BL-549 N7 (option A): a turn that starts during the episode summary call: that finished episode is written, then the chat\'s dreaming ends early', async () => {
    await seedSession(FIXED_SESSION, { fixed: true })
    await seedMessage(FIXED_SESSION, 'm1', 'user', 'Plan the lake trip', '2026-06-09T08:00:00.000Z')
    await seedMessage(FIXED_SESSION, 'm2', 'assistant', 'Trip planned for July.', '2026-06-09T08:05:00.000Z')
    await seedMessage(FIXED_SESSION, 'm3', 'user', 'Book the cabin', '2026-06-09T08:10:00.000Z')
    await seedMessage(FIXED_SESSION, 'm4', 'assistant', 'Cabin booked.', '2026-06-09T08:15:00.000Z')
    await seedMessage(FIXED_SESSION, 'm5', 'user', bigText('Recent work'), '2026-06-10T11:00:00.000Z')
    await seedEpisode(FIXED_SESSION, {
      id: 'ep_closed',
      state: 'closed',
      opened_at: '2026-06-09T08:00:00.000Z',
      closed_at: '2026-06-09T09:00:00.000Z',
      boundary_signal: 'agent_mark'
    })
    let turnId: number | null = null
    try {
      const run = await runDreamingPass({
        userId: USER,
        agent: agentRecord(),
        trigger: 'manual',
        now: NOW,
        generateSummary: async () => {
          if (turnId === null) {
            const registered = registerSessionTurn(FIXED_SESSION, 'single', 'msg_zcnap_dream')
            turnId = registered.ok ? registered.entry.turnId : -1
          }
          return 'Lake trip planned and cabin booked for July.'
        }
      })
      expect(turnId).toBeGreaterThan(0)
      expect((await getEpisode(FIXED_SESSION, 'ep_closed'))?.state).toBe('graduated')
      expect(
        (await listMemorySegments(AGENT))
          .filter((segment) => segment.session_id === FIXED_SESSION)
          .map((segment) => segment.episode_id)
      ).toEqual(['ep_closed'])
      const session = await redis.getSession(FIXED_SESSION)
      expect(
        getFixedSessionGraduationState(session?.metadata ?? null).events.map((event) => event.episodeId)
      ).toEqual(['ep_closed'])
      const ended = run.actions.find(
        (action) => action.kind === 'skip_session' && action.refs?.sessionId === FIXED_SESSION
      )
      expect(ended?.why).toContain('ended early: a message arrived')
    } finally {
      if (turnId !== null && turnId > 0) releaseSessionTurn(FIXED_SESSION, turnId)
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

  // BL-751: the era segment's own `createMemorySegment` embeds before it writes, so a chat
  // deleted during THAT embedding call is still there for the segment write but gone by the time
  // `swapGraduationEvents` runs right after (`memoryDreaming.ts` ~1277-1285). The swap answers
  // `chat_deleted`; the pass must end that chat early instead of throwing, and the era segment
  // just created (never wired into any window) must not survive it.
  it('a chat deleted during the era summary embedding call ends that chat early and leaves no era segment', async () => {
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

    let deleted = false
    const embedder = {
      modelId: 'local-ai:test-embedder@8',
      dims: 8,
      async embedDocuments(texts: string[]) {
        if (!deleted) {
          deleted = true
          await redis.deleteSession(FIXED_SESSION)
        }
        return texts.map(() => new Array(8).fill(0.1))
      },
      async embedQuery() {
        return new Array(8).fill(0.1)
      }
    }

    const run = await runDreamingPass({
      userId: USER,
      agent: agentRecord(),
      trigger: 'manual',
      now: NOW,
      generateSummary: stubGenerator('Era summary: chapters 0 through 7 in one arc.'),
      embedder
    })

    expect(deleted).toBe(true)
    expect(run.counts.eraConsolidations).toBe(0)
    const endedEarly = run.actions.find(
      (action) => action.kind === 'skip_session' && action.refs?.sessionId === FIXED_SESSION
    )
    expect(endedEarly?.why).toContain('deleted')
    expect((await listMemorySegments(AGENT)).some((segment) => segment.session_id === FIXED_SESSION)).toBe(
      false
    )
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
