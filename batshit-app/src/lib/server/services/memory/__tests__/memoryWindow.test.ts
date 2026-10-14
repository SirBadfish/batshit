import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  memorySearchLaneActive,
  useMemorySearchTestServer
} from '$lib/test-utils/memory-search-server'

/**
 * SA-104 P6 — window mechanics on the dedicated Redis 8 db0 lane (npm run test:memory):
 * the nap's fixed relief order (graduate closed episodes → rezip stale bulk →
 * open-episode compaction with whiteboard extraction), pin/hold/floor honoring,
 * idle-gap episode boundaries, regular-session graduation (additive, watermark-driven),
 * the whiteboard lifecycle, and graduated segments joining search + recall.
 *
 * Deterministic seams: summary generation and token estimation are injected; the
 * embedder is the P2 fake. No live model calls (live proof is P8).
 */

// BL-436: every door into the embedder factory is recorded, and a test can make a call with no
// signed-in user fail the way a Model Manager preset on a local runtime does in production.
const embedderFactory = vi.hoisted(() => ({
  calls: [] as Array<{ userId: string | null }>,
  requireUser: false,
  setupError: null as Error | null,
  beforeResolve: null as (() => Promise<void>) | null
}))

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
    createMemoryEmbedderAsync: async (_config: unknown, options?: { userId?: string | null }) => {
      embedderFactory.calls.push({ userId: options?.userId ?? null })
      if (embedderFactory.beforeResolve) await embedderFactory.beforeResolve()
      if (embedderFactory.setupError) throw embedderFactory.setupError
      if (embedderFactory.requireUser && !options?.userId) {
        throw new Error(
          "The memory embedding preset 'preset_window_test' points at a local runtime, which needs a signed-in user context to resolve its base URL."
        )
      }
      return testEmbedder()
    }
  }
})

import { ensureMemoryIndexes, setMemoryConfig } from '../memoryIndex'
import { createMemorySegment, listMemorySegments, getMemorySegment } from '../memoryStore'
import {
  graduateRegularSessionTail,
  parseNapCompactionSections,
  runFixedSessionNap,
  swapGraduationEvents
} from '../memoryGraduation'
import {
  beginSessionDelete,
  endSessionDelete,
  registerSessionTurn,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  ensureFixedSessionOpenEpisode,
  episodeKey,
  getEpisode,
  sessionEpisodesKey,
  type EpisodeRecord
} from '../memoryEpisodes'
import {
  closeEpisodeOp,
  deleteMemoryOp,
  updateWhiteboardOp,
  searchMemoriesOp,
  recallMemoriesOp,
  MemoryToolError
} from '../memoryTools'
import {
  commitMemoryTurnState,
  computeMemoryCompileContext,
  foldAwarenessState,
  getMemoryFold
} from '../memoryRecall'
import { getMemoryLingerState } from '../memoryLinger'
import { reportForCliSnapshot } from '$lib/utils/cliContextWindow'
import { countMessageTokens } from '$lib/utils/tokenCounter'
import {
  applyFixedSessionGraduationToMessages,
  getFixedSessionGraduationState,
  getFixedSessionNapRecords
} from '$lib/utils/fixedSessionGraduation'
import { redis } from '$lib/server/redis'

const harness = useMemorySearchTestServer()

const USER = 'user_window'
const AGENT = 'agent_window'
const FIXED_SESSION = 'sess_window_fixed'
const REGULAR_SESSION = 'sess_window_regular'
const PRESET_ID = 'preset_window_test'

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
    name: 'Window Agent',
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
}

async function seedFixedSession() {
  await redis.json.set(`session:${FIXED_SESSION}`, '$', {
    id: FIXED_SESSION,
    user_id: USER,
    agent_id: AGENT,
    metadata: {
      fixedSession: { version: 1, enabled: true, created_at: '2026-06-01T00:00:00.000Z' }
    }
  } as never)
}

async function seedRegularSession() {
  await redis.json.set(`session:${REGULAR_SESSION}`, '$', {
    id: REGULAR_SESSION,
    user_id: USER,
    agent_id: AGENT,
    metadata: {}
  } as never)
}

async function seedMessage(
  sessionId: string,
  id: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: string,
  metadata: Record<string, any> = {},
  agentId: string = AGENT
) {
  await redis.json.set(`message:${sessionId}:${id}`, '$', {
    id,
    session_id: sessionId,
    user_id: USER,
    agent_id: agentId,
    role,
    content,
    created_at: createdAt,
    metadata
  } as never)
  await redis.rPush(`messages:${sessionId}`, id)
}

async function seedEpisode(episode: Partial<EpisodeRecord> & { id: string }) {
  const record: EpisodeRecord = {
    session_id: FIXED_SESSION,
    agent_id: AGENT,
    state: 'open',
    opened_at: '2026-06-10T08:00:00.000Z',
    whiteboard: null,
    schema_version: 1,
    ...episode
  } as EpisodeRecord
  await redis.json.set(episodeKey(FIXED_SESSION, record.id), '$', record as never)
  await redis.rPush(sessionEpisodesKey(FIXED_SESSION), record.id)
  return record
}

/** Sequential estimate stub: returns queued values, repeating the last one. */
function estimateQueue(values: number[]) {
  const queue = [...values]
  return async () => (queue.length > 1 ? (queue.shift() as number) : queue[0])
}

const bigText = (label: string) => `${label} ${'x'.repeat(6_000)}`

describe.runIf(memorySearchLaneActive())('SA-104 P6 window mechanics', () => {
  beforeEach(async () => {
    for (const key of CLAUDE_CAP_ENV_KEYS) vi.stubEnv(key, '')
    embedderFactory.calls = []
    embedderFactory.requireUser = false
    embedderFactory.setupError = null
    embedderFactory.beforeResolve = null
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
    await seedFixedSession()
    await seedRegularSession()
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
  // Episode idle-gap boundaries (packet §1.6)
  // -------------------------------------------------------------------------

  it('idle gap closes the open episode at the accepted-send boundary; holds suppress it', async () => {
    const session = await redis.getSession(FIXED_SESSION)
    const t0 = new Date('2026-06-10T08:00:00.000Z')
    const first = await ensureFixedSessionOpenEpisode({
      session,
      sessionId: FIXED_SESSION,
      agentId: AGENT,
      now: t0
    })
    expect(first?.state).toBe('open')
    expect(first?.last_activity_at).toBe(t0.toISOString())

    // Within the gap (default idle 8h not stored → resolver default; agent stores none
    // in memory_window → default 8h): 2h later, same episode.
    const t1 = new Date('2026-06-10T10:00:00.000Z')
    const same = await ensureFixedSessionOpenEpisode({
      session,
      sessionId: FIXED_SESSION,
      agentId: AGENT,
      now: t1
    })
    expect(same?.id).toBe(first?.id)

    // 10h after t1 → idle close + fresh episode.
    const t2 = new Date('2026-06-10T20:30:00.000Z')
    const next = await ensureFixedSessionOpenEpisode({
      session,
      sessionId: FIXED_SESSION,
      agentId: AGENT,
      now: t2
    })
    expect(next?.id).not.toBe(first?.id)
    const closed = await getEpisode(FIXED_SESSION, first!.id)
    expect(closed?.state).toBe('closed')
    expect(closed?.boundary_signal).toBe('idle_gap')

    // A future hold keeps the new episode open across a bigger gap.
    await redis.json.set(
      episodeKey(FIXED_SESSION, next!.id),
      '$.hold_until',
      '2026-06-12T09:00:00.000Z' as never
    )
    const t3 = new Date('2026-06-11T20:00:00.000Z')
    const held = await ensureFixedSessionOpenEpisode({
      session,
      sessionId: FIXED_SESSION,
      agentId: AGENT,
      now: t3
    })
    expect(held?.id).toBe(next?.id)

    // Regular sessions never get episodes.
    const regular = await ensureFixedSessionOpenEpisode({
      session: await redis.getSession(REGULAR_SESSION),
      sessionId: REGULAR_SESSION,
      agentId: AGENT,
      now: t3
    })
    expect(regular).toBeNull()
  })

  // -------------------------------------------------------------------------
  // The nap (packet §1.4): relief order, pins, floor, loud failure
  // -------------------------------------------------------------------------

  async function seedNapConversation() {
    // Old stretch (episode 1, closed): 4 small messages.
    await seedMessage(FIXED_SESSION, 'm1', 'user', 'Plan the lake trip', '2026-06-10T08:00:00.000Z')
    await seedMessage(FIXED_SESSION, 'm2', 'assistant', 'Trip planned for July.', '2026-06-10T08:05:00.000Z')
    await seedMessage(FIXED_SESSION, 'm3', 'user', 'Book the cabin', '2026-06-10T08:10:00.000Z')
    await seedMessage(FIXED_SESSION, 'm4', 'assistant', 'Cabin booked.', '2026-06-10T08:15:00.000Z')
    // Current stretch (episode 2, open): stale part + big recent tail. The last
    // completed assistant message (m12) belongs to ANOTHER agent so a
    // response_failed mark on m6 stays recovery-held (per-agent hold semantics).
    await seedMessage(FIXED_SESSION, 'm5', 'user', 'Now the garage project', '2026-06-10T09:00:00.000Z', {
      zipIds: ['zip_stale_1']
    })
    await seedMessage(FIXED_SESSION, 'm6', 'assistant', 'Measured the garage.', '2026-06-10T09:05:00.000Z', {
      zipIds: ['zip_stale_2', 'zip_pinned']
    })
    await seedMessage(FIXED_SESSION, 'm7', 'user', 'What shelving fits?', '2026-06-10T09:10:00.000Z')
    await seedMessage(FIXED_SESSION, 'm8', 'assistant', 'Metal shelving, 40cm deep.', '2026-06-10T09:15:00.000Z')
    await seedMessage(FIXED_SESSION, 'm9', 'user', 'Order two units', '2026-06-10T09:20:00.000Z')
    await seedMessage(FIXED_SESSION, 'm10', 'assistant', 'Ordered.', '2026-06-10T09:25:00.000Z')
    await seedMessage(FIXED_SESSION, 'm11', 'user', bigText('Recent context'), '2026-06-10T11:00:00.000Z')
    await seedMessage(
      FIXED_SESSION,
      'm12',
      'assistant',
      bigText('Recent reply'),
      '2026-06-10T11:05:00.000Z',
      {},
      'agent_other'
    )

    const ep1 = await seedEpisode({
      id: 'ep1',
      state: 'closed',
      opened_at: '2026-06-10T08:00:00.000Z',
      closed_at: '2026-06-10T08:20:00.000Z',
      boundary_signal: 'agent_mark'
    })
    const ep2 = await seedEpisode({
      id: 'ep2',
      state: 'open',
      opened_at: '2026-06-10T09:00:00.000Z',
      // Written by a NAP: the refresh path stays open. An agent-written board is never rewritten
      // (2026-09-19, Josh) — that case has its own test below.
      whiteboard: { content: 'Garage width: 6m', updated_at: '2026-06-10T09:30:00.000Z', written_by: 'nap' }
    })
    return { ep1, ep2 }
  }

  it.each(['open', 'empty closed'] as const)(
    'BL-790: stale zips relieve a nap with an unavailable embedder and %s episode',
    async (episodeKind) => {
      await seedNapConversation()
      // No eligible closed summary. The empty closed episode exercises selection, too.
      await redis.json.set(episodeKey(FIXED_SESSION, 'ep1'), '$.state', 'open' as never)
      if (episodeKind === 'empty closed') {
        await seedEpisode({ id: 'empty', state: 'closed', opened_at: '2026-05-01T00:00:00.000Z', closed_at: '2026-05-02T00:00:00.000Z' })
      }
      await redis.sAdd(`unzipped:${FIXED_SESSION}`, 'zip_pinned')
      await redis.json.set(`unzipped_item:${FIXED_SESSION}:zip_pinned`, '$', { source: 'user' } as never)
      await redis.json.set(`message:${FIXED_SESSION}:m6`, '$.metadata.response_failed', true as never)
      const messagesBefore = await redis.getSessionMessages(FIXED_SESSION)
      embedderFactory.setupError = new Error('BL-790 embedding setup unavailable')
      const generateSummary = vi.fn(async () => 'must not be called')

      const outcome = await runFixedSessionNap({
        userId: USER, agent: agentRecord(), sessionId: FIXED_SESSION,
        trigger: 'manual', eventFetch: fetch, now: NOW, generateSummary,
        estimateTokens: estimateQueue([150_000, 150_000, 70_000])
      })

      expect(outcome.status, outcome.error).toBe('completed')
      expect(embedderFactory.calls).toEqual([])
      expect(generateSummary).not.toHaveBeenCalled()
      expect(outcome.record?.rezippedZipCount).toBe(1)
      expect(await redis.sMembers(`rezipped:${FIXED_SESSION}`)).toEqual(['zip_stale_1'])
      expect(await redis.json.get(`rezipped_item:${FIXED_SESSION}:zip_stale_1`)).toMatchObject({ source: 'agent', reason: 'nap', napId: outcome.record?.id })
      expect(await redis.exists(`rezipped_item:${FIXED_SESSION}:zip_pinned`)).toBe(false)
      expect(await redis.exists(`rezipped_item:${FIXED_SESSION}:zip_stale_2`)).toBe(false)
      expect(await redis.getSessionMessages(FIXED_SESSION)).toEqual(messagesBefore)
      expect(await listMemorySegments(AGENT)).toEqual([])
      const stored = await redis.getSession(FIXED_SESSION)
      expect(getFixedSessionGraduationState(stored?.metadata).events).toEqual([])
      expect(getFixedSessionNapRecords(stored?.metadata).at(-1)?.status).toBe('completed')
      expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.content).toBe('Garage width: 6m')
    }
  )

  it.each(['step 1', 'step 3'] as const)(
    'BL-790: unavailable embedding setup fails before the needed %s summary',
    async (step) => {
      await seedNapConversation()
      if (step === 'step 3') await redis.json.set(episodeKey(FIXED_SESSION, 'ep1'), '$.state', 'open' as never)
      embedderFactory.setupError = new Error('BL-790 embedding setup unavailable')
      const generateSummary = vi.fn(async () => 'must not be called')
      const outcome = await runFixedSessionNap({
        userId: USER, agent: agentRecord(), sessionId: FIXED_SESSION,
        trigger: 'manual', eventFetch: fetch, now: NOW, generateSummary,
        estimateTokens: estimateQueue([150_000, 150_000, 150_000])
      })
      expect(outcome.status).toBe('failed')
      expect(outcome.error).toBe('BL-790 embedding setup unavailable')
      expect(embedderFactory.calls).toEqual([{ userId: USER }])
      expect(generateSummary).not.toHaveBeenCalled()
      expect(await listMemorySegments(AGENT)).toEqual([])
      const stored = await redis.getSession(FIXED_SESSION)
      expect(getFixedSessionGraduationState(stored?.metadata).events).toEqual([])
      expect(getFixedSessionNapRecords(stored?.metadata).at(-1)?.status).toBe('failed')
      expect(outcome.record?.rezippedZipCount).toBe(step === 'step 3' ? 3 : 0)
      expect((await getEpisode(FIXED_SESSION, 'ep1'))?.state).toBe(step === 'step 3' ? 'open' : 'closed')
      expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.content).toBe('Garage width: 6m')
    }
  )

  it.each([
    ['step 1', 'turn_started', false], ['step 1', 'chat_deleted', false],
    ['step 3', 'turn_started', false], ['step 3', 'chat_deleted', false],
    ['step 1', 'turn_started', true], ['step 1', 'chat_deleted', true],
    ['step 3', 'turn_started', true], ['step 3', 'chat_deleted', true]
  ] as const)(
    'BL-790: %s setup interrupted by %s (rejected=%s) spends no summary and writes no segment',
    async (step, stop, rejected) => {
      await seedNapConversation()
      if (step === 'step 3') await redis.json.set(episodeKey(FIXED_SESSION, 'ep1'), '$.state', 'open' as never)
      let resolveEntered!: () => void
      let releaseSetup!: () => void
      const entered = new Promise<void>((resolve) => { resolveEntered = resolve })
      const held = new Promise<void>((resolve) => { releaseSetup = resolve })
      embedderFactory.beforeResolve = async () => { resolveEntered(); await held }
      if (rejected) embedderFactory.setupError = new Error('BL-790 interrupted setup failed')
      const generateSummary = vi.fn(async () => 'must not be called')
      let turnId: number | null = null
      const nap = runFixedSessionNap({
        userId: USER, agent: agentRecord(), sessionId: FIXED_SESSION,
        trigger: 'manual', eventFetch: fetch, now: NOW, generateSummary,
        estimateTokens: estimateQueue([150_000, 150_000, 150_000])
      })
      try {
        await Promise.race([
          entered,
          nap.then(() => { throw new Error('Nap settled before embedding setup was reached') })
        ])
        if (stop === 'chat_deleted') await redis.deleteSession(FIXED_SESSION)
        else {
          const registered = registerSessionTurn(FIXED_SESSION, 'single', 'msg_bl790_setup')
          expect(registered.ok).toBe(true)
          turnId = registered.ok ? registered.entry.turnId : null
        }
        releaseSetup()
        const outcome = await nap
        expect(outcome.status, outcome.error).toBe('ended_early')
        expect(outcome.endedEarly).toBe(stop)
        expect(embedderFactory.calls).toEqual([{ userId: USER }])
        expect(generateSummary).not.toHaveBeenCalled()
        expect(await listMemorySegments(AGENT)).toEqual([])
        if (stop === 'chat_deleted') {
          expect(outcome.record).toBeNull()
          expect(await keysOfFixedSession()).toEqual([])
        } else {
          expect(outcome.record?.awarenessFold).toBe('skipped')
          expect(outcome.record?.rezippedZipCount).toBe(step === 'step 3' ? 3 : 0)
          const stored = await redis.getSession(FIXED_SESSION)
          expect(getFixedSessionGraduationState(stored?.metadata).events).toEqual([])
          expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.content).toBe('Garage width: 6m')
        }
      } finally {
        releaseSetup()
        try {
          await nap
        } finally {
          if (turnId !== null) releaseSessionTurn(FIXED_SESSION, turnId)
        }
      }
    }
  )

  it('nap step 1 graduates closed episodes: memseg + window event + episode mark, floor-protected tail untouched', async () => {
    await seedNapConversation()
    const prompts: string[] = []
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'threshold',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        prompts.push(prompt)
        return 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 60_000])
    })

    expect(outcome.status).toBe('completed')
    expect(outcome.record?.graduatedEpisodeIds).toEqual(['ep1'])
    expect(outcome.record?.rezippedZipCount).toBe(0)
    expect(outcome.record?.compaction).toBeNull()

    // The memseg preserves the episode's message ids; originals stay stored.
    const segments = await listMemorySegments(AGENT)
    expect(segments).toHaveLength(1)
    expect(segments[0].episode_id).toBe('ep1')
    expect(segments[0].message_ids).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(segments[0].graduated_by).toBe('nap')
    for (const id of segments[0].message_ids) {
      expect(await redis.json.get(`message:${FIXED_SESSION}:${id}`)).toBeTruthy()
    }

    // The graduation event excludes those messages and splices the gist.
    const session = await redis.getSession(FIXED_SESSION)
    const state = getFixedSessionGraduationState(session?.metadata ?? null)
    expect(state.events).toHaveLength(1)
    expect(state.events[0].sourceMessageIds).toEqual(['m1', 'm2', 'm3', 'm4'])
    const window = applyFixedSessionGraduationToMessages(
      await redis.getSessionMessages(FIXED_SESSION),
      session
    )
    const windowIds = window.map((message) => message.id)
    expect(windowIds).not.toContain('m1')
    expect(windowIds).toContain('m5')
    const splice = window.find((message) => message.metadata?.fixedSessionGraduation)
    expect(splice?.content).toContain('Lake trip planned for July')
    expect(splice?.metadata?.contextCompactSummary).toBe(true)

    // Episode marked; whiteboard content joined the summary input.
    expect((await getEpisode(FIXED_SESSION, 'ep1'))?.state).toBe('graduated')
    expect(prompts[0]).toContain('CONVERSATION SEGMENT TO GRADUATE')

    // Visible nap record.
    const naps = getFixedSessionNapRecords((await redis.getSession(FIXED_SESSION))?.metadata)
    expect(naps).toHaveLength(1)
    expect(naps[0].status).toBe('completed')
    expect(naps[0].tokensBefore).toBe(150_000)
    expect(naps[0].tokensAfter).toBe(60_000)
  })

  it('nap steps 2+3: stale zips rezip (pins + recovery holds skipped), open-episode narrative compacts with whiteboard refresh', async () => {
    await seedNapConversation()
    // Pin one zip via manual unzip; mark m6's run as failed (recovery hold).
    await redis.sAdd(`unzipped:${FIXED_SESSION}`, 'zip_pinned')
    await redis.json.set(
      `message:${FIXED_SESSION}:m6`,
      '$.metadata.response_failed',
      true as never
    )

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        if (prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')) {
          expect(prompt).toContain('CURRENT EPISODE WHITEBOARD:\nGarage width: 6m')
          return ['SUMMARY:', 'Garage project started; measurements done.', 'WHITEBOARD:', 'Garage width: 6m. Next: order shelving.'].join('\n')
        }
        return 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(outcome.status).toBe('completed')
    const record = outcome.record!
    expect(record.graduatedEpisodeIds).toEqual(['ep1'])

    // Step 2: m5's stale zip rezipped; the pinned zip and the recovery-held message's
    // zips were skipped.
    const rezipped = await redis.sMembers(`rezipped:${FIXED_SESSION}`)
    expect(rezipped).toContain('zip_stale_1')
    expect(rezipped).not.toContain('zip_pinned')
    expect(rezipped).not.toContain('zip_stale_2')
    expect(record.rezippedZipCount).toBe(1)

    // Step 3: open-episode compaction covers the stale, unheld open-episode messages —
    // not the recovery-held m6, not the floor-protected newest message (m12).
    expect(record.compaction).not.toBeNull()
    const step3Segment = await getMemorySegment(AGENT, record.compaction!.segmentId)
    expect(step3Segment?.message_ids).toEqual(['m5', 'm7', 'm8', 'm9', 'm10', 'm11'])
    expect(step3Segment?.episode_id).toBe('ep2')

    // Whiteboard refreshed on the open episode (a nap wrote it, so a nap may rewrite it).
    const ep2 = await getEpisode(FIXED_SESSION, 'ep2')
    expect(ep2?.state).toBe('open')
    expect(ep2?.whiteboard?.content).toBe('Garage width: 6m. Next: order shelving.')
    expect(ep2?.whiteboard?.written_by).toBe('nap')
    expect(record.compaction!.whiteboard).toBe('refreshed')

    // The window now splices both gists; compacted messages excluded, the held m6 and
    // the floor-protected m12 still live.
    const session = await redis.getSession(FIXED_SESSION)
    const window = applyFixedSessionGraduationToMessages(
      await redis.getSessionMessages(FIXED_SESSION),
      session
    )
    const ids = window.map((message) => message.id)
    expect(ids).not.toContain('m5')
    expect(ids).not.toContain('m11')
    expect(ids).toContain('m6')
    expect(ids).toContain('m12')
  })

  // BL-436: a Model Manager preset on a local runtime (or the api lane with a key saved in
  // Settings) only embeds for a signed-in user. The nap used to write its segments through the
  // store's no-user default, so every nap with such a preset failed and the window got no relief.
  it('a nap embeds steps 1 and 3 with the signed-in user\'s embedder (BL-436)', async () => {
    await seedNapConversation()
    embedderFactory.requireUser = true

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) =>
        prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')
          ? ['SUMMARY:', 'Garage project started.', 'WHITEBOARD:', 'Garage width: 6m.'].join('\n')
          : 'Lake trip planned for July; cabin booked.',
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe('completed')
    expect(outcome.record?.graduatedEpisodeIds).toEqual(['ep1'])
    expect(outcome.record?.compaction?.segmentId).toBeTruthy()
    expect((await listMemorySegments(AGENT)).map((segment) => segment.episode_id).sort()).toEqual([
      'ep1',
      'ep2'
    ])
    // One embedder for the whole nap, built for the signed-in user.
    expect(embedderFactory.calls).toEqual([{ userId: USER }])
  })

  // BL-749: step 2's rezip loop takes no lock of its own against a delete (the zip state lock
  // guards writers of zip state, not the delete route), and the loop can span several Redis round
  // trips fetching `unzipped`/`rezipped` membership before it ever writes. A delete that starts in
  // that gap must stop the loop before its first write, the same way `look()` stops step 1 and
  // step 3.
  it('BL-749: a delete that starts during the step-2 loop leaves no rezipped key', async () => {
    await seedNapConversation()
    await redis.json.set(
      `message:${FIXED_SESSION}:m6`,
      '$.metadata.response_failed',
      true as never
    )

    const realSMembers = redis.sMembers.bind(redis)
    let unzippedReadCount = 0
    let sawUnzippedRead = false
    const spy = vi
      .spyOn(redis, 'sMembers')
      .mockImplementation(async (key: string) => {
        const result = await realSMembers(key)
        // `loadContextProtections` (at the nap's start) reads `unzipped:{id}` once already; the
        // step-2 loop's OWN read of it is the second. A delete starting exactly there — after the
        // membership reads, before any write — is the race this test drives.
        if (key === `unzipped:${FIXED_SESSION}`) {
          unzippedReadCount += 1
          if (unzippedReadCount === 2) {
            sawUnzippedRead = true
            beginSessionDelete(FIXED_SESSION)
          }
        }
        return result
      })

    try {
      const outcome = await runFixedSessionNap({
        userId: USER,
        agent: agentRecord(),
        sessionId: FIXED_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async () => 'Lake trip planned for July; cabin booked.',
        estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
      })

      expect(sawUnzippedRead).toBe(true)
      expect(outcome.status).toBe('ended_early')
      expect(outcome.endedEarly).toBe('chat_deleted')
      expect(await redis.sMembers(`rezipped:${FIXED_SESSION}`)).toEqual([])
      expect(await redis.exists(`rezipped_item:${FIXED_SESSION}:zip_stale_1`)).toBe(false)
    } finally {
      spy.mockRestore()
      endSessionDelete(FIXED_SESSION)
    }
  })

  it('nap step 3 never rewrites a board the agent wrote: summary-only call, board kept (2026-09-19)', async () => {
    await seedNapConversation()
    // The agent writes the board through its control — that makes it the agent's.
    await updateWhiteboardOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { content: 'Garage width: 6m. Josh wants metal shelving.' }
    )
    expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.written_by).toBe('agent')

    let step3Prompt = ''
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        if (prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')) {
          step3Prompt = prompt
          // A model that returns a WHITEBOARD section anyway: it must be ignored.
          return ['SUMMARY:', 'Garage project started; measurements done.', 'WHITEBOARD:', 'a board the nap must not write'].join('\n')
        }
        return 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(outcome.status).toBe('completed')
    // Summary-only call: the board rides along as read-only context, no WHITEBOARD asked for.
    expect(step3Prompt).toContain('Return EXACTLY one section')
    expect(step3Prompt).toContain(
      'CURRENT EPISODE WHITEBOARD (kept by the agent; context only, not yours to change):\nGarage width: 6m. Josh wants metal shelving.'
    )
    expect(step3Prompt).not.toContain('Return EXACTLY two sections')
    // The compaction still happened; the board did not move.
    expect(outcome.record!.compaction).not.toBeNull()
    expect(outcome.record!.compaction!.whiteboard).toBe('kept')
    const ep2 = await getEpisode(FIXED_SESSION, 'ep2')
    expect(ep2?.whiteboard?.content).toBe('Garage width: 6m. Josh wants metal shelving.')
    expect(ep2?.whiteboard?.written_by).toBe('agent')
  })

  it('nap step 3 fills an EMPTY board and signs it as the nap (2026-09-19)', async () => {
    await seedNapConversation()
    await redis.json.set(episodeKey(FIXED_SESSION, 'ep2'), '$.whiteboard', null as never)

    let step3Prompt = ''
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        if (prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')) {
          step3Prompt = prompt
          return ['SUMMARY:', 'Garage project started; measurements done.', 'WHITEBOARD:', 'Garage width: 6m. Next: order shelving.'].join('\n')
        }
        return 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(outcome.status).toBe('completed')
    expect(step3Prompt).toContain('Return EXACTLY two sections')
    expect(step3Prompt).toContain('CURRENT EPISODE WHITEBOARD: (empty — build it from the segment below)')
    expect(outcome.record!.compaction!.whiteboard).toBe('filled')
    const ep2 = await getEpisode(FIXED_SESSION, 'ep2')
    expect(ep2?.whiteboard?.content).toBe('Garage width: 6m. Next: order shelving.')
    expect(ep2?.whiteboard?.written_by).toBe('nap')
  })

  // BL-549: a turn sent in the middle of a nap can write the board while the nap waits on its
  // summary model. The nap read an empty board (it would fill it) or a board a nap wrote (it
  // would refresh it); its write must not land on the board the agent wrote since.
  it.each([
    ['an empty board (the fill path)', null],
    [
      'a board a nap wrote (the refresh path)',
      { content: 'Garage width: 6m', updated_at: '2026-06-10T09:30:00.000Z', written_by: 'nap' }
    ]
  ])('BL-549: the agent writes its board while the nap waits on the model, from %s: the agent\'s board stays', async (_label, board) => {
    await seedNapConversation()
    await redis.json.set(episodeKey(FIXED_SESSION, 'ep2'), '$.whiteboard', board as never)

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        if (prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')) {
          // The turn that arrived mid-nap: the agent writes its board through its control.
          await updateWhiteboardOp(
            { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
            { content: 'Agent board: buy the metal shelving.' }
          )
          return ['SUMMARY:', 'Garage project started; measurements done.', 'WHITEBOARD:', 'a nap board that must not land'].join('\n')
        }
        return 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(outcome.status).toBe('completed')
    const ep2 = await getEpisode(FIXED_SESSION, 'ep2')
    expect(ep2?.whiteboard?.content).toBe('Agent board: buy the metal shelving.')
    expect(ep2?.whiteboard?.written_by).toBe('agent')
    expect(outcome.record!.compaction!.whiteboard).toBe('kept')
    // The summary of the older stretch still stands: a finished step is complete by itself.
    const step3Segment = await getMemorySegment(AGENT, outcome.record!.compaction!.segmentId)
    expect(step3Segment?.summary).toContain('Garage project started')
  })

  // BL-549 review: a turn sent during the nap's summary call can close the open episode (the
  // agent's close control). The nap's summary and event are already written by then; the board
  // write must not turn the finished nap into a failure. The board stays on the closed episode.
  it('BL-549: the agent closes the episode while the nap waits on the model: the nap completes and keeps the board', async () => {
    await seedNapConversation()
    await redis.json.set(episodeKey(FIXED_SESSION, 'ep2'), '$.whiteboard', null as never)

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        if (prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')) {
          await closeEpisodeOp({ userId: USER, agentId: AGENT, sessionId: FIXED_SESSION })
          return ['SUMMARY:', 'Garage project started; measurements done.', 'WHITEBOARD:', 'a nap board that must not land'].join('\n')
        }
        return 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(outcome.status, outcome.error).toBe('completed')
    expect(outcome.record!.compaction!.whiteboard).toBe('kept')
    const ep2 = await getEpisode(FIXED_SESSION, 'ep2')
    expect(ep2?.state).toBe('closed')
    expect(ep2?.whiteboard).toBeNull()
  })

  // BL-623: a nap takes no turn registration, so a chat delete sweeps at once, also in the middle
  // of a nap's summary call. Whatever the nap writes after the sweep must not bring back a key of
  // the chat. Its summary is agent memory (`memseg:{agentId}:…`), which outlives a deleted chat
  // by design, like the summary of any chat graduated before its delete.
  it.each([
    // Deleted in step 3, the chat had one summary from step 1 already, written before the delete.
    ['step 1 (a closed episode)', 'CONVERSATION SEGMENT TO GRADUATE', 0],
    ['step 3 (the open episode)', 'OLDER OPEN-EPISODE SEGMENT TO COMPACT', 1]
  ])('BL-623: a chat deleted during the summary call of %s: the nap ends early and writes no key of the chat', async (_label, marker, summaries) => {
    await seedNapConversation()
    const keysOfTheChat = () =>
      redis.execute(async (client) => {
        const keys: string[] = []
        for await (const batch of client.scanIterator({ MATCH: `*${FIXED_SESSION}*`, COUNT: 500 })) {
          keys.push(...(Array.isArray(batch) ? batch : [batch]))
        }
        return keys
      })
    // The scan sees the chat's keys while the chat exists (the positive control).
    expect(await keysOfTheChat()).toEqual(
      expect.arrayContaining([`session:${FIXED_SESSION}`, `messages:${FIXED_SESSION}`, episodeKey(FIXED_SESSION, 'ep2')])
    )
    let deleted = false
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) => {
        if (prompt.includes(marker) && !deleted) {
          deleted = true
          await redis.deleteSession(FIXED_SESSION)
        }
        return prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')
          ? ['SUMMARY:', 'Garage project started; measurements done.', 'WHITEBOARD:', 'Garage width: 6m.'].join('\n')
          : 'Lake trip planned for July; cabin booked.'
      },
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
    })

    expect(deleted).toBe(true)
    // BL-549 N1: the nap looks for a deleted chat before it writes the summary made in that
    // call, and ends early: no summary, no event, no record (the chat is gone).
    expect(outcome.status).toBe('ended_early')
    expect(outcome.endedEarly).toBe('chat_deleted')
    expect(outcome.record).toBeNull()
    expect(outcome.metadata).toBeNull()
    expect(await keysOfTheChat()).toEqual([])
    // What stays is agent memory written BEFORE the delete (step 1's summary in the step 3
    // case), like the summary of any chat graduated before its delete.
    const segments = await listMemorySegments(AGENT)
    expect(segments.map((segment) => segment.session_id)).toEqual(
      new Array(summaries).fill(FIXED_SESSION)
    )
  })

  // BL-751: `createMemorySegment` embeds BEFORE it writes the segment, so a chat deleted during
  // that embedding call is still there when the segment lands, but gone by the time the window
  // event write runs right after (the summary call itself is covered by BL-623 above; this is the
  // one gap still open after that fix). The event write then answers `missing`; before this fix
  // that was a thrown error, the nap recorded `failed`, and the route answered 500 instead of
  // `chat_deleted`. The segment this call just created, never wired into any window, must not
  // survive it either.
  it('BL-751: a chat deleted during the embedding call for a graduated segment leaves no memseg, and the nap ends as chat_deleted', async () => {
    await seedNapConversation()
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

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async () => 'Lake trip planned for July; cabin booked.',
      estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000]),
      embedder
    })

    expect(deleted).toBe(true)
    expect(outcome.status).toBe('ended_early')
    expect(outcome.endedEarly).toBe('chat_deleted')
    expect(outcome.record).toBeNull()
    expect(await listMemorySegments(AGENT)).toEqual([])
  })

  it('nap step 3 parse failure is loud and leaves the window untouched by step 3', async () => {
    await seedNapConversation()
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) =>
        prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')
          ? 'no sections here at all'
          : 'Lake trip planned for July; cabin booked.',
      estimateTokens: estimateQueue([150_000, 130_000, 128_000])
    })

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('SUMMARY/WHITEBOARD')
    // Step 1's graduation stands (individually coherent); no step-3 event exists.
    const state = getFixedSessionGraduationState(
      (await redis.getSession(FIXED_SESSION))?.metadata ?? null
    )
    expect(state.events).toHaveLength(1)
    expect(state.events[0].episodeId).toBe('ep1')
    // Whiteboard untouched.
    expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.content).toBe('Garage width: 6m')
    // The failure is recorded visibly.
    const naps = getFixedSessionNapRecords((await redis.getSession(FIXED_SESSION))?.metadata)
    expect(naps[0].status).toBe('failed')
  })

  it('threshold naps below the trigger return not_needed without a record', async () => {
    await seedNapConversation()
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'threshold',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async () => 'unused',
      estimateTokens: estimateQueue([50_000])
    })
    expect(outcome.status).toBe('not_needed')
    expect(outcome.record).toBeNull()
    expect(
      getFixedSessionNapRecords((await redis.getSession(FIXED_SESSION))?.metadata)
    ).toHaveLength(0)
  })

  it('uses the session runtime window for a named CLI nap; absent report keeps the verified choice', async () => {
    const cliAgent = namedClaudeCliAgent()
    const reportSession = 'sess_window_cli_report'
    const choiceSession = 'sess_window_cli_choice'
    for (const sessionId of [reportSession, choiceSession]) {
      await redis.json.set(`session:${sessionId}`, '$', {
        id: sessionId,
        user_id: USER,
        agent_id: AGENT,
        metadata: { fixedSession: { version: 1, enabled: true, created_at: NOW.toISOString() } }
      } as never)
      await seedMessage(sessionId, `source-${sessionId}`, 'user', 'This original source remains available.',
        '2026-06-09T08:00:00.000Z')
    }
    await seedCliContextReport(reportSession, cliAgent, 200_000)

    let summaryCalls = 0
    const runtimeNap = await runFixedSessionNap({
      userId: USER,
      agent: cliAgent,
      sessionId: reportSession,
      trigger: 'threshold',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async () => {
        summaryCalls += 1
        return 'unused summary'
      },
      estimateTokens: estimateQueue([170_000])
    })
    const choiceNap = await runFixedSessionNap({
      userId: USER,
      agent: cliAgent,
      sessionId: choiceSession,
      trigger: 'threshold',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async () => {
        summaryCalls += 1
        return 'unused summary'
      },
      estimateTokens: estimateQueue([170_000])
    })

    expect(runtimeNap.window?.contextLimit).toBe(200_000)
    expect(runtimeNap.window?.napAtTokens).toBeLessThan(170_000)
    expect(runtimeNap.status).toBe('completed')
    expect(choiceNap.window?.contextLimit).toBe(1_000_000)
    expect(choiceNap.window?.napAtTokens).toBeGreaterThan(170_000)
    expect(choiceNap.status).toBe('not_needed')
    expect(summaryCalls).toBe(0)
    for (const sessionId of [reportSession, choiceSession]) {
      expect((await redis.getSessionMessages(sessionId)).map((message) => message.content)).toContain(
        'This original source remains available.'
      )
    }
  })

  it('keeps an unknown CLI default honest and refuses a nap before a summary call', async () => {
    const unknownAgent = namedClaudeCliAgent(undefined, {
      claude_settings: { permissionMode: 'default' }
    })
    const sessionId = 'sess_window_cli_unknown'
    await redis.json.set(`session:${sessionId}`, '$', {
      id: sessionId,
      user_id: USER,
      agent_id: AGENT,
      metadata: { fixedSession: { version: 1, enabled: true, created_at: NOW.toISOString() } }
    } as never)
    let summaryCalls = 0

    await expect(runFixedSessionNap({
      userId: USER,
      agent: unknownAgent,
      sessionId,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async () => {
        summaryCalls += 1
        return 'should not run'
      }
    })).rejects.toThrow('could not resolve a model context limit')
    expect(summaryCalls).toBe(0)
  })

  it('naps refuse regular sessions and memory-disabled agents', async () => {
    await expect(
      runFixedSessionNap({
        userId: USER,
        agent: agentRecord(),
        sessionId: REGULAR_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async () => 'unused',
        estimateTokens: estimateQueue([150_000])
      })
    ).rejects.toThrow(/Infinite Sessions/)

    await expect(
      runFixedSessionNap({
        userId: USER,
        agent: agentRecord({ memory_enabled: false }),
        sessionId: FIXED_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async () => 'unused',
        estimateTokens: estimateQueue([150_000])
      })
    ).rejects.toThrow(/memory/)
  })

  it('nap section parser accepts labeled sections and rejects everything else', () => {
    const parsed = parseNapCompactionSections(
      ['SUMMARY:', 'The summary text.', '', 'WHITEBOARD:', '- fact one', '- fact two'].join('\n')
    )
    expect(parsed.summary).toBe('The summary text.')
    expect(parsed.whiteboard).toBe('- fact one\n- fact two')
    expect(() => parseNapCompactionSections('just prose')).toThrow(/SUMMARY\/WHITEBOARD/)
    // Summary-only mode (the agent owns the board): WHITEBOARD is dropped, only SUMMARY is required.
    const summaryOnly = parseNapCompactionSections(
      ['SUMMARY:', 'Only this.', 'WHITEBOARD:', 'ignored'].join('\n'),
      { whiteboard: false }
    )
    expect(summaryOnly).toEqual({ summary: 'Only this.', whiteboard: null })
    expect(() => parseNapCompactionSections('WHITEBOARD:\nno summary', { whiteboard: false })).toThrow(
      /required SUMMARY section/
    )
  })

  // -------------------------------------------------------------------------
  // Regular-session graduation (packet §1.7)
  // -------------------------------------------------------------------------

  it('graduates an idle regular-session tail additively and advances the watermark', async () => {
    const times = ['08:00', '08:05', '08:10', '08:15', '08:20', '08:25']
    for (let i = 0; i < 6; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the garden project`,
        `2026-06-09T${times[i]}:00.000Z`
      )
    }

    // Not idle yet (now = 2 hours after the last message; gap default 8h).
    const early = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'idle',
      now: new Date('2026-06-09T10:00:00.000Z'),
      generateSummary: async () => 'Garden project discussed.'
    })
    expect(early.status).toBe('not_idle')

    // Idle a day later: graduates the whole tail.
    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'idle',
      now: NOW,
      generateSummary: async () => 'Garden project discussed.'
    })
    expect(outcome.status).toBe('graduated')
    expect(outcome.messageCount).toBe(6)

    const segments = await listMemorySegments(AGENT)
    const regularSegment = segments.find((segment) => segment.session_id === REGULAR_SESSION)
    expect(regularSegment?.graduated_by).toBe('idle')

    // Watermark advanced; window metadata untouched (no graduation events, DL-104-12).
    const session = await redis.getSession(REGULAR_SESSION)
    expect(session?.metadata?.memoryGraduation?.lastGraduatedMessageId).toBe('r6')
    expect(getFixedSessionGraduationState(session?.metadata ?? null).events).toHaveLength(0)
    const window = applyFixedSessionGraduationToMessages(
      await redis.getSessionMessages(REGULAR_SESSION),
      session
    )
    expect(window.map((message) => message.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])

    // Nothing new afterwards.
    const again = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'idle',
      now: NOW,
      generateSummary: async () => 'unused'
    })
    expect(again.status).toBe('nothing_new')
  })

  it('uses a matching CLI runtime window for the regular graduation summary budget', async () => {
    const cliAgent = namedClaudeCliAgent({
      floor_mode: 'custom',
      floor_tokens: 1_000,
      ceiling_headroom_mode: 'custom',
      ceiling_headroom_tokens: 50_000,
      nap_threshold_percent: 80
    })
    const reportSession = 'sess_window_regular_cli_report'
    const choiceSession = 'sess_window_regular_cli_choice'
    for (const sessionId of [reportSession, choiceSession]) {
      await redis.json.set(`session:${sessionId}`, '$', {
        id: sessionId,
        user_id: USER,
        agent_id: AGENT,
        metadata: {}
      } as never)
      for (let index = 0; index < 6; index += 1) {
        await seedMessage(sessionId, `long-${sessionId}-${index}`, index % 2 ? 'assistant' : 'user',
          `Source detail ${'garden detail '.repeat(10_000)}`,
          `2026-06-09T08:${String(index * 5).padStart(2, '0')}:00.000Z`)
      }
    }
    await seedCliContextReport(reportSession, cliAgent, 200_000)
    const caps: Record<string, number> = {}
    for (const sessionId of [reportSession, choiceSession]) {
      const messages = await redis.getSessionMessages(sessionId)
      const sourceTokens = messages.reduce((total, message) => total + countMessageTokens(message), 0)
      expect(sourceTokens).toBeGreaterThan(40_000)
      await graduateRegularSessionTail({
        userId: USER,
        agent: cliAgent,
        sessionId,
        reason: 'close',
        now: NOW,
        generateSummary: async (_prompt, hardMaxTokens) => {
          caps[sessionId] = hardMaxTokens
          return 'The source segment was reviewed and preserved.'
        }
      })
    }

    expect(caps[reportSession]).toBe(5_000)
    expect(caps[choiceSession]).toBe(16_000)
  })

  // BL-436: the same fix for regular chats — `/api/memory/graduate-session` passes no embedder.
  it('regular-session graduation embeds with the signed-in user\'s embedder (BL-436)', async () => {
    const times = ['08:00', '08:05', '08:10', '08:15', '08:20', '08:25']
    for (let i = 0; i < 6; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the garden project`,
        `2026-06-09T${times[i]}:00.000Z`
      )
    }
    embedderFactory.requireUser = true

    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'Garden project discussed.'
    })

    expect(outcome.status).toBe('graduated')
    expect((await listMemorySegments(AGENT)).map((segment) => segment.session_id)).toEqual([
      REGULAR_SESSION
    ])
    expect(embedderFactory.calls).toEqual([{ userId: USER }])
  })

  // BL-224: the summarizer reads a switched chat with the compiler's speaker view, so the
  // agent's own memory never records another agent's words as its own.
  it('names another agent in a switched regular chat and keeps the graduating agent as <assistant>', async () => {
    await redis.json.set('agent:agent_window_other', '$', {
      id: 'agent_window_other',
      user_id: USER,
      displayName: 'Bram'
    } as never)
    await seedMessage(REGULAR_SESSION, 'r1', 'user', 'Which color for the kitchen?', '2026-06-10T11:50:00.000Z')
    await seedMessage(REGULAR_SESSION, 'r2', 'assistant', 'Sage green.', '2026-06-10T11:51:00.000Z')
    await seedMessage(REGULAR_SESSION, 'r3', 'user', 'Ask Bram too.', '2026-06-10T11:52:00.000Z')
    await seedMessage(
      REGULAR_SESSION,
      'r4',
      'assistant',
      'I promised to paint it navy.',
      '2026-06-10T11:53:00.000Z',
      {},
      'agent_window_other'
    )

    let prompt = ''
    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async (text) => {
        prompt = text
        return 'Kitchen colors discussed.'
      }
    })

    expect(outcome.status).toBe('graduated')
    expect(prompt).toContain('<assistant id="r2" time="2026-06-10T11:51:00.000Z">\nSage green.\n</assistant>')
    expect(prompt).toContain(
      '<agent name="Bram" id="r4" time="2026-06-10T11:53:00.000Z">\nI promised to paint it navy.\n</agent>'
    )
    await redis.del('agent:agent_window_other')
  })

  it('close-reason graduation skips the idle requirement; small tails and fixed/group sessions refuse', async () => {
    await seedMessage(REGULAR_SESSION, 'r1', 'user', 'Quick note', '2026-06-10T11:50:00.000Z')
    await seedMessage(REGULAR_SESSION, 'r2', 'assistant', 'Noted.', '2026-06-10T11:51:00.000Z')
    const small = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'unused'
    })
    expect(small.status).toBe('too_small')

    await seedMessage(REGULAR_SESSION, 'r3', 'user', 'More detail on the plan', '2026-06-10T11:52:00.000Z')
    await seedMessage(REGULAR_SESSION, 'r4', 'assistant', 'Plan expanded.', '2026-06-10T11:53:00.000Z')
    const closed = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'Plan summary.'
    })
    expect(closed.status).toBe('graduated')
    const segments = await listMemorySegments(AGENT)
    expect(segments.find((s) => s.session_id === REGULAR_SESSION)?.graduated_by).toBe(
      'session_close'
    )

    await expect(
      graduateRegularSessionTail({
        userId: USER,
        agent: agentRecord(),
        sessionId: FIXED_SESSION,
        reason: 'close',
        now: NOW,
        generateSummary: async () => 'unused'
      })
    ).rejects.toThrow(/Infinite Sessions/)
  })

  // BL-723: the graduation mark is written at its own path. The writer used to read the chat
  // after the summary call and write that copy's whole metadata back: a Compact event or any
  // other block written after its read was erased.
  it('the graduation mark keeps the blocks other writers added during the graduation (BL-723)', async () => {
    for (let i = 0; i < 4; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the shed roof`,
        `2026-06-10T11:5${i}:00.000Z`
      )
    }
    await redis.json.set(`session:${REGULAR_SESSION}`, '$.metadata.memoryGraduation', {
      version: 1,
      lastGraduatedMessageId: 'r0',
      lastGraduatedAt: '2026-06-01T00:00:00.000Z',
      segmentIds: ['zcmeta_seg_before']
    } as never)
    const compactEvent = {
      id: 'zcmeta_evt_during_summary',
      createdAt: '2026-06-10T11:59:00.000Z',
      sourceMessageIds: ['r1', 'r2'],
      summary: 'A Compact written while the graduation waited on its summary.'
    }
    const origin = { kind: 'zcmeta_written_just_before_the_mark' }

    // BL-738: write the origin block INSIDE the summary call — the exact window between the
    // graduation's read and its mark write — so this assertion can never be silently switched off.
    // The old version guarded it behind `if (originWritten)`, set by a hook counting a second
    // `redis.getSession` call: an unrelated extra read anywhere in the graduation path would
    // change which call was "the second one" and disable the assertion with no test failure.
    // The blocks written inside the summary call would also survive the OLD writer (it re-read the
    // chat after the summary), so the assertions below cannot tell old from new alone; the spy
    // pins that the graduation never writes the whole record (BL-738 review).
    const wholeRecordWrites = vi.spyOn(redis, 'updateSession')
    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => {
        const written = await redis.appendContextCompactionEvent(REGULAR_SESSION, compactEvent, null)
        expect(written.ok).toBe(true)
        await redis.json.set(`session:${REGULAR_SESSION}`, '$.metadata.origin', origin as never)
        return 'Shed roof discussed.'
      }
    })
    expect(outcome.status).toBe('graduated')
    expect(wholeRecordWrites.mock.calls.filter(([id]) => id === REGULAR_SESSION)).toEqual([])
    wholeRecordWrites.mockRestore()

    const metadata = (await redis.getSession(REGULAR_SESSION))?.metadata as Record<string, any>
    expect(metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
    expect(metadata.origin).toEqual(origin)
    expect(metadata.memoryGraduation).toEqual({
      version: 1,
      lastGraduatedMessageId: 'r4',
      lastGraduatedAt: NOW.toISOString(),
      segmentIds: ['zcmeta_seg_before', outcome.segmentId]
    })
  })

  // BL-737: the mark write is a compare-and-set on the id THIS graduation read at its own start,
  // never an ordering check on any timestamp. Two graduations racing settle by whichever CAS
  // lands first; the loser reports `superseded`, not `graduated`, and its segment (already a
  // duplicate of ground the winner covers) does not survive it.
  it('two overlapping graduations of the same tail: the one whose CAS loses answers superseded and discards its segment', async () => {
    for (let i = 0; i < 4; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the fence`,
        `2026-06-10T11:5${i}:00.000Z`
      )
    }

    // Inside the racing graduation's own summary call, a second graduation of the SAME tail
    // (reading the same "no mark yet" start) writes and wins first.
    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => {
        const winner = await redis.writeRegularGraduationMark(
          REGULAR_SESSION,
          {
            lastGraduatedMessageId: 'r4',
            lastGraduatedAt: '2026-06-10T12:01:00.000Z',
            segmentId: 'zcmeta_seg_winner'
          },
          null
        )
        expect(winner).toBe('ok')
        return 'Fence discussed.'
      }
    })

    expect(outcome.status).toBe('superseded')
    // The winner's mark stands untouched.
    const mark = (await redis.getSession(REGULAR_SESSION))?.metadata?.memoryGraduation as any
    expect(mark.lastGraduatedMessageId).toBe('r4')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_winner'])
    // The loser's own segment (never reused, never linked) does not survive it.
    const segments = await listMemorySegments(AGENT)
    expect(segments.map((segment) => segment.id)).not.toContain('zcmeta_seg_winner')
    expect(segments.filter((segment) => segment.session_id === REGULAR_SESSION)).toHaveLength(0)
  })

  // BL-737's regular-session counterpart to BL-751: `createMemorySegment` embeds before it
  // writes, so a chat deleted during THIS call's own embed is still there for the segment write
  // but gone by the time the mark write runs. There is no window event here to catch it first
  // (regular sessions write no window event, DL-104-12) — the mark write's own MISSING answer is
  // the only place this gap can surface, and it must not be reported as `graduated`.
  it('the chat is deleted during the embedding call: chat_deleted, and the just-created segment does not survive it', async () => {
    for (let i = 0; i < 4; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the deck`,
        `2026-06-10T11:5${i}:00.000Z`
      )
    }
    let deleted = false
    const embedder = {
      modelId: 'local-ai:test-embedder@8',
      dims: 8,
      async embedDocuments(texts: string[]) {
        if (!deleted) {
          deleted = true
          await redis.deleteSession(REGULAR_SESSION)
        }
        return texts.map(() => new Array(8).fill(0.1))
      },
      async embedQuery() {
        return new Array(8).fill(0.1)
      }
    }

    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'Deck discussed.',
      embedder
    })

    expect(deleted).toBe(true)
    expect(outcome.status).toBe('chat_deleted')
    expect(await listMemorySegments(AGENT)).toEqual([])
  })

  // The BL-751 discard must never touch a REUSED segment: a same-range attempt from an earlier
  // partial run is owned by whatever created (or already reused) it, not by this losing call.
  it('a reused segment is left alone when this graduation loses its CAS', async () => {
    for (let i = 0; i < 4; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the porch`,
        `2026-06-10T11:5${i}:00.000Z`
      )
    }
    // An earlier partial attempt already wrote a segment covering this exact tail (episode_id
    // null, same message ids), which `writeGraduationForMessages` will find and reuse.
    const existing = await createMemorySegment({
      agent_id: AGENT,
      user_id: USER,
      session_id: REGULAR_SESSION,
      episode_id: null,
      message_ids: ['r1', 'r2', 'r3', 'r4'],
      summary: 'Porch discussed (earlier attempt).',
      first_message_at: '2026-06-10T11:50:00.000Z',
      last_message_at: '2026-06-10T11:53:00.000Z',
      token_count: 10,
      graduated_by: 'session_close'
    })

    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => {
        // A competing write beats this one to the mark, so this call's CAS loses.
        const winner = await redis.writeRegularGraduationMark(
          REGULAR_SESSION,
          {
            lastGraduatedMessageId: 'r4',
            lastGraduatedAt: '2026-06-10T12:01:00.000Z',
            segmentId: 'zcmeta_seg_other_winner'
          },
          null
        )
        expect(winner).toBe('ok')
        return 'Porch discussed (this attempt).'
      }
    })

    expect(outcome.status).toBe('superseded')
    // The reused segment survives: it belongs to whatever attempt created or is using it, not to
    // this losing call.
    expect(await getMemorySegment(AGENT, existing.id)).not.toBeNull()
  })

  // BL-737 review: the mirror case of the test above. THIS call creates a brand-new segment (not
  // reused), but the WINNER is the one that reuses it and links it into the mark it writes. The
  // old code deleted any segment it did not itself reuse whenever its CAS lost, so it deleted the
  // segment the winner's mark now names — leaving that mark pointing at nothing.
  it('the winner reused THIS losing call\'s own new segment: it survives the discard (BL-737 review)', async () => {
    for (let i = 0; i < 4; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the attic`,
        `2026-06-10T11:5${i}:00.000Z`
      )
    }

    const original = redis.writeRegularGraduationMark.bind(redis)
    const spy = vi
      .spyOn(redis, 'writeRegularGraduationMark')
      .mockImplementationOnce(async (sessionId, mark, expected) => {
        // Simulate the winner landing first, reusing THIS call's about-to-be-written segment id
        // (the same id `written.segmentId` this call created moments ago via `createMemorySegment`
        // inside `writeGraduationForMessages`) and linking it into the mark it writes.
        const winner = await original(
          sessionId,
          {
            lastGraduatedMessageId: 'r4',
            lastGraduatedAt: '2026-06-10T12:01:00.000Z',
            segmentId: mark.segmentId
          },
          null
        )
        expect(winner).toBe('ok')
        // Now run this (the losing) call for real: its CAS no longer matches.
        return original(sessionId, mark, expected)
      })

    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'Attic discussed.'
    })
    spy.mockRestore()

    expect(outcome.status).toBe('superseded')
    const mark = (await redis.getSession(REGULAR_SESSION))?.metadata?.memoryGraduation as any
    expect(mark.lastGraduatedMessageId).toBe('r4')
    // The segment this losing call created is the one the winner's mark now lists — it must
    // survive, not be deleted out from under that mark.
    expect(mark.segmentIds).toHaveLength(1)
    const segments = await listMemorySegments(AGENT)
    expect(segments.map((segment) => segment.id)).toEqual(mark.segmentIds)
  })

  // BL-737 review (FIX 2, test gap): the headline bug end-to-end through
  // `graduateRegularSessionTail` itself, not just the Lua script it calls. A mark naming a
  // message that no longer exists in the chat must still let the NEXT graduation move forward,
  // not answer something that looks like `graduated` forever nor get stuck. The old
  // `lastGraduatedMessageTs` "forward only" ordering check got stuck exactly here: resuming from
  // message 0 always re-derives a tail whose last message is at or before the deleted mark's own
  // timestamp, so `storedTsValue >= tonumber(ARGV[5])` was true and the write answered `STALE`
  // forever — the caller ignored that `false` and reported `graduated` anyway on every call,
  // never actually advancing the watermark. The CAS fix reads and matches the CURRENT stored id
  // instead, so this must both graduate once and then report `nothing_new`.
  it('a mark naming a deleted message still lets the next graduation advance, then reports nothing_new (BL-737 review)', async () => {
    for (let i = 0; i < 5; i++) {
      await seedMessage(
        REGULAR_SESSION,
        `r${i + 1}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `Regular message ${i + 1} about the greenhouse`,
        `2026-06-10T11:5${i}:00.000Z`
      )
    }
    // The mark names r5 as already graduated...
    await redis.json.set(`session:${REGULAR_SESSION}`, '$.metadata.memoryGraduation', {
      version: 1,
      lastGraduatedMessageId: 'r5',
      lastGraduatedAt: '2026-06-01T00:00:00.000Z',
      segmentIds: ['zcmeta_seg_before_delete']
    } as never)
    // ...but r5 was since deleted from the chat (the user deleted the message), leaving a tail
    // of exactly MIN_GRADUATION_MESSAGES (4: r1-r4) once resumed from message 0.
    await redis.deleteMessage('r5', REGULAR_SESSION, USER)

    const outcome = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'Greenhouse discussed.'
    })
    expect(outcome.status).toBe('graduated')
    expect(outcome.messageCount).toBe(4)

    const mark = (await redis.getSession(REGULAR_SESSION))?.metadata?.memoryGraduation as any
    expect(mark.lastGraduatedMessageId).toBe('r4')
    expect(mark.segmentIds).toEqual(['zcmeta_seg_before_delete', outcome.segmentId])

    const again = await graduateRegularSessionTail({
      userId: USER,
      agent: agentRecord(),
      sessionId: REGULAR_SESSION,
      reason: 'close',
      now: NOW,
      generateSummary: async () => 'unused'
    })
    expect(again.status).toBe('nothing_new')
  })

  // -------------------------------------------------------------------------
  // Whiteboard lifecycle (packet §1.9)
  // -------------------------------------------------------------------------

  it('whiteboard: tool-edited, compiled as DCM lines (SA-110), dissolved (kept) at close', async () => {
    await seedEpisode({ id: 'epw', state: 'open', opened_at: '2026-06-10T08:00:00.000Z' })

    const updated = await updateWhiteboardOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { content: 'Current goal: ship P6.' }
    )
    expect(updated.whiteboard).toBe('Current goal: ship P6.')

    const compiled = await computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'hello'
    })
    // SA-110 (DL-110-01): the board is DCM lines now — never a system-prompt block.
    expect(compiled.whiteboardDcmLines[0]).toContain('Episode whiteboard (')
    // 2026-09-19: the board names its author, and the agent is told naps leave its board alone.
    expect(compiled.whiteboardDcmLines[0]).toContain('last written by you')
    expect(compiled.whiteboardDcmLines.join('\n')).toContain('Current goal: ship P6.')
    expect(compiled.whiteboardDcmLines.join('\n')).toContain('sys.memory.whiteboard')
    expect(compiled.whiteboardDcmLines.join('\n')).toContain('Naps never change a board you wrote')
    expect(compiled.memoryContext?.whiteboard?.present).toBe(true)
    expect(compiled.memoryContext?.whiteboard?.placement).toBe('dcm')
    expect(compiled.memoryContext?.whiteboard?.writtenBy).toBe('agent')
    expect((await getEpisode(FIXED_SESSION, 'epw'))?.whiteboard?.written_by).toBe('agent')

    // A nap-filled board says so where the agent reads it.
    await redis.json.set(episodeKey(FIXED_SESSION, 'epw'), '$.whiteboard.written_by', 'nap' as never)
    const napCompiled = await computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'hello'
    })
    expect(napCompiled.whiteboardDcmLines[0]).toContain('filled in by a nap')
    expect(napCompiled.memoryContext?.whiteboard?.writtenBy).toBe('nap')
    await redis.json.set(episodeKey(FIXED_SESSION, 'epw'), '$.whiteboard.written_by', 'agent' as never)

    // Regular sessions never compile a whiteboard.
    const regularCompiled = await computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: REGULAR_SESSION,
      currentUserMessage: 'hello'
    })
    expect(regularCompiled.whiteboardDcmLines).toEqual([])

    // Close dissolves: content kept on the record, section no longer compiled.
    const { closeEpisode } = await import('../memoryEpisodes')
    await closeEpisode(FIXED_SESSION, 'epw', 'agent_mark')
    expect((await getEpisode(FIXED_SESSION, 'epw'))?.whiteboard?.content).toBe(
      'Current goal: ship P6.'
    )
    const afterClose = await computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'hello'
    })
    expect(afterClose.whiteboardDcmLines).toEqual([])

    // With no open episode left, the whiteboard control refuses loudly.
    await expect(
      updateWhiteboardOp(
        { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
        { content: 'anything' }
      )
    ).rejects.toBeInstanceOf(MemoryToolError)
  })

  // -------------------------------------------------------------------------
  // SA-110 P2 — the awareness fold (DL-110-05/06)
  // -------------------------------------------------------------------------

  async function seedAwarenessRecord(
    id: string,
    content: string,
    overrides: Record<string, any> = {}
  ) {
    await redis.json.set(`memory:${AGENT}:${id}`, '$', {
      id,
      agent_id: AGENT,
      user_id: USER,
      lane: 'awareness',
      content,
      importance: 7,
      saved_at: '2026-06-09T00:00:00.000Z',
      saved_ts: Date.parse('2026-06-09T00:00:00.000Z'),
      is_superseded: 'n',
      provenance: [{ session_id: FIXED_SESSION, source: 'agent' }],
      visibility: 'normal',
      embedding: [],
      embedding_model: 'test',
      schema_version: 1,
      ...overrides
    } as never)
  }

  const compileFixed = () =>
    computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'hello'
    })

  it('awareness fold: bootstrap at first commit, byte-stable SP across edits, pending notes, trigger refresh', async () => {
    await seedAwarenessRecord('mem_fold_a', 'Fact A version one.')

    // No fold record yet: live render (byte-identical to the pre-fold world), no pending.
    const live = await compileFixed()
    expect(live.onMyMindBlock).toContain('Fact A version one.')
    expect(live.awarenessPendingDcmLines).toEqual([])
    expect(live.memoryContext?.awarenessFold?.source).toBe('live-bootstrap')

    // The session's first accepted-send commit bootstraps the fold from the same bytes.
    await commitMemoryTurnState({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'hello'
    })
    const fold = await getMemoryFold(AGENT)
    expect(fold?.reason).toBe('bootstrap')
    expect(fold?.block).toBe(live.onMyMindBlock)

    // Mid-session edit + new entry: the SP block must not move a byte.
    await redis.json.set(`memory:${AGENT}:mem_fold_a`, '$.content', 'Fact A version two.' as never)
    await seedAwarenessRecord('mem_fold_b', 'Fact B is brand new.')
    const gated = await compileFixed()
    expect(gated.onMyMindBlock).toBe(live.onMyMindBlock)
    expect(gated.memoryContext?.awarenessFold?.source).toBe('fold')
    const pending = gated.awarenessPendingDcmLines.join('\n')
    expect(pending).toContain('Awareness updates (active NOW')
    expect(pending).toContain('Fact B is brand new.')
    expect(pending).toContain('Fact A version two.')
    expect(pending).toContain('replaces the AWARENESS version')
    expect(gated.memoryContext?.awarenessFold?.pending).toMatchObject({ new: 1, updated: 1 })

    // A later commit in the SAME session is not a fold boundary.
    await commitMemoryTurnState({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'again'
    })
    expect((await getMemoryFold(AGENT))?.folded_at).toBe(fold?.folded_at)

    // A fold trigger adopts both changes and clears the pending section.
    const folded = await foldAwarenessState({ agentId: AGENT, reason: 'nap' })
    expect(folded.changed).toBe(true)
    const after = await compileFixed()
    expect(after.onMyMindBlock).toContain('Fact A version two.')
    expect(after.onMyMindBlock).toContain('Fact B is brand new.')
    expect(after.awarenessPendingDcmLines).toEqual([])

    // Byte-identical refolds are no-ops.
    expect((await foldAwarenessState({ agentId: AGENT, reason: 'dreaming' })).changed).toBe(false)
  })

  it('awareness fold: a NEW session first commit is a fold boundary (DL-110-06c)', async () => {
    await seedAwarenessRecord('mem_fold_c', 'Fact C.')
    await commitMemoryTurnState({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'hello'
    })
    await redis.json.set(`memory:${AGENT}:mem_fold_c`, '$.content', 'Fact C revised.' as never)

    // Another session of the same agent: ITS first commit refolds the shared state.
    await commitMemoryTurnState({
      userId: USER,
      agentId: AGENT,
      sessionId: REGULAR_SESSION,
      currentUserMessage: 'new session'
    })
    const fold = await getMemoryFold(AGENT)
    expect(fold?.reason).toBe('new-session')
    expect(fold?.block).toContain('Fact C revised.')
  })

  it('awareness fold: superseded/expired/moved entries get disregard notes while the SP stays frozen', async () => {
    await seedAwarenessRecord('mem_fold_d', 'Fact D.')
    await seedAwarenessRecord('mem_fold_e', 'Fact E.')
    await seedAwarenessRecord('mem_fold_f', 'Fact F.')
    await foldAwarenessState({ agentId: AGENT, reason: 'nap' })

    await redis.json.set(`memory:${AGENT}:mem_fold_d`, '$.is_superseded', 'y' as never)
    await redis.json.set(
      `memory:${AGENT}:mem_fold_e`,
      '$.expires_at',
      new Date(Date.now() - 1000).toISOString() as never
    )
    await redis.json.set(`memory:${AGENT}:mem_fold_e`, '$.expires_ts', (Date.now() - 1000) as never)
    await redis.json.set(`memory:${AGENT}:mem_fold_f`, '$.lane', 'ltm' as never)

    const ctx = await compileFixed()
    // The frozen view still shows all three; the pending notes carry the truth.
    expect(ctx.onMyMindBlock).toContain('Fact D.')
    expect(ctx.onMyMindBlock).toContain('Fact E.')
    expect(ctx.onMyMindBlock).toContain('Fact F.')
    const pending = ctx.awarenessPendingDcmLines.join('\n')
    expect(pending).toContain('superseded [mem_fold_d]')
    expect(pending).toContain('expired [mem_fold_e')
    expect(pending).toContain('moved [mem_fold_f → ltm]')
    expect(ctx.memoryContext?.awarenessFold?.pending).toMatchObject({
      superseded: 1,
      expired: 1,
      moved: 1
    })
  })

  it('awareness fold: deleting an awareness record re-folds immediately (DL-110-05)', async () => {
    await seedAwarenessRecord('mem_fold_g', 'Fact G.')
    await seedAwarenessRecord('mem_fold_h', 'Fact H.')
    await foldAwarenessState({ agentId: AGENT, reason: 'nap' })

    await deleteMemoryOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { memoryId: 'mem_fold_g' }
    )
    const fold = await getMemoryFold(AGENT)
    expect(fold?.reason).toBe('delete')
    expect(fold?.block).not.toContain('Fact G.')
    expect(fold?.block).toContain('Fact H.')

    const ctx = await compileFixed()
    expect(ctx.onMyMindBlock).not.toContain('Fact G.')
    expect(ctx.awarenessPendingDcmLines).toEqual([])
  })

  it('nap: the awareness fold rides the nap tail (DL-110-06a)', async () => {
    await seedAwarenessRecord('mem_fold_i', 'Fact I.')
    await seedMessage(FIXED_SESSION, 'mw_fold_1', 'user', 'hello', '2026-06-10T09:00:00.000Z')

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      generateSummary: async () => 'SUMMARY:\nunused\nWHITEBOARD:\nunused',
      estimateTokens: estimateQueue([10]),
      now: NOW
    })
    expect(outcome.record?.awarenessFold).toBe('folded')
    const fold = await getMemoryFold(AGENT)
    expect(fold?.reason).toBe('nap')
    expect(fold?.block).toContain('Fact I.')
  })

  // -------------------------------------------------------------------------
  // Segments join search + recall (packet §1.10)
  // -------------------------------------------------------------------------

  it('graduated segments join search results and recall through the single DCM channel', async () => {
    const segment = await createMemorySegment({
      agent_id: AGENT,
      user_id: USER,
      session_id: FIXED_SESSION,
      episode_id: 'ep_old',
      message_ids: ['m1', 'm2'],
      summary: 'The lake house trip: cabin booked for July, kayaks reserved.',
      first_message_at: '2026-06-01T08:00:00.000Z',
      last_message_at: '2026-06-01T09:00:00.000Z',
      token_count: 500,
      graduated_by: 'nap'
    })

    const search = await searchMemoriesOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { query: 'lake house trip cabin' }
    )
    expect(search.segments?.length).toBeGreaterThan(0)
    expect(search.segments?.[0].id).toBe(segment.id)
    expect(search.segments?.[0].gist).toContain('lake house')

    // Time-scope by overlap: a window ending before the segment excludes it.
    const outside = await searchMemoriesOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { query: 'lake house trip cabin', event_to: '2026-05-01T00:00:00.000Z' }
    )
    expect(outside.segments ?? []).toHaveLength(0)

    // Recall queues the segment (kind: 'segment') and the engine inserts its summary.
    const recall = await recallMemoriesOp(
      { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
      { memoryIds: [segment.id] }
    )
    expect(recall.recalledSegments?.[0].id).toBe(segment.id)
    expect(recall.recalledSegments?.[0].summary).toBe(segment.summary)
    const linger = await getMemoryLingerState(FIXED_SESSION)
    expect(linger?.pending?.[0]).toMatchObject({ memory_id: segment.id, kind: 'segment' })

    const compiled = await computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'What about that trip?'
    })
    const dcm = compiled.dcmLines.join('\n')
    expect(dcm).toContain('graduated episode')
    expect(dcm).toContain(segment.id)
    expect(dcm).toContain('kayaks reserved')

    // Commit lingers the segment and stamps recall-refresh on it.
    const commit = await commitMemoryTurnState({
      userId: USER,
      agentId: AGENT,
      sessionId: FIXED_SESSION,
      currentUserMessage: 'What about that trip?'
    })
    expect(commit.insertedNewIds).toContain(segment.id)
    const afterCommit = await getMemoryLingerState(FIXED_SESSION)
    expect(afterCommit?.lingering?.find((entry) => entry.memory_id === segment.id)?.kind).toBe(
      'segment'
    )
    const touched = await getMemorySegment(AGENT, segment.id)
    expect(touched?.recall_count).toBe(2) // once at recall op, once at delivery
  })

  it('nap graduation reuses an existing same-range segment instead of duplicating (retry safety)', async () => {
    await seedNapConversation()
    // Simulate a crash after the memseg write but before the event: pre-create the
    // exact segment the nap would write.
    await createMemorySegment({
      agent_id: AGENT,
      user_id: USER,
      session_id: FIXED_SESSION,
      episode_id: 'ep1',
      message_ids: ['m1', 'm2', 'm3', 'm4'],
      summary: 'Pre-existing summary from the crashed attempt.',
      first_message_at: '2026-06-10T08:00:00.000Z',
      last_message_at: '2026-06-10T08:15:00.000Z',
      token_count: 100,
      graduated_by: 'nap'
    })

    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async () => 'Fresh summary that must NOT create a second segment.',
      estimateTokens: estimateQueue([150_000, 60_000])
    })
    expect(outcome.status).toBe('completed')

    const segments = (await listMemorySegments(AGENT)).filter(
      (segment) => segment.episode_id === 'ep1'
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].summary).toBe('Pre-existing summary from the crashed attempt.')
    // The window event carries the reused segment's summary.
    const state = getFixedSessionGraduationState(
      (await redis.getSession(FIXED_SESSION))?.metadata ?? null
    )
    expect(state.events[0].summary).toContain('Pre-existing summary')
  })
  // -------------------------------------------------------------------------
  // BL-549 N1/N2: a nap yields to a turn and to a chat delete; N4: its writes go by path
  // -------------------------------------------------------------------------

  const keysOfFixedSession = () =>
    redis.execute(async (client) => {
      const keys: string[] = []
      for await (const batch of client.scanIterator({ MATCH: `*${FIXED_SESSION}*`, COUNT: 500 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]))
      }
      return keys.sort()
    })

  it('BL-549 N1/N2: a turn that starts after step 1 ends the nap early; step 1 stays, steps 2 and 3 never run', async () => {
    await seedNapConversation()
    let calls = 0
    let turnId: number | null = null
    const prompts: string[] = []
    try {
      const outcome = await runFixedSessionNap({
        userId: USER,
        agent: agentRecord(),
        sessionId: FIXED_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async (prompt) => {
          prompts.push(prompt)
          return prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')
            ? ['SUMMARY:', 'Garage.', 'WHITEBOARD:', 'a nap board that must not land'].join('\n')
            : 'Lake trip planned for July; cabin booked.'
        },
        estimateTokens: async () => {
          calls += 1
          // The user sends while the nap measures the window after step 1.
          if (calls === 2) {
            const registered = registerSessionTurn(FIXED_SESSION, 'single', 'msg_zcnap_turn')
            expect(registered.ok).toBe(true)
            turnId = registered.ok ? registered.entry.turnId : null
          }
          return [150_000, 130_000, 128_000, 70_000][Math.min(calls - 1, 3)]
        }
      })

      expect(outcome.status, outcome.error).toBe('ended_early')
      expect(outcome.endedEarly).toBe('turn_started')
      expect(outcome.record?.status).toBe('ended_early')
      expect(outcome.record?.endedEarly).toBe('ended early: a message arrived; 1 closed episode written')
      // BL-549 N2: the next step does not start, the Awareness fold included.
      expect(outcome.record?.awarenessFold).toBe('skipped')
      // Step 1 is finished and stays: ep1 graduated, its event in the window.
      expect(outcome.record?.graduatedEpisodeIds).toEqual(['ep1'])
      expect((await getEpisode(FIXED_SESSION, 'ep1'))?.state).toBe('graduated')
      const stored = await redis.getSession(FIXED_SESSION)
      const events = getFixedSessionGraduationState(stored?.metadata ?? null).events
      expect(events.map((event) => event.episodeId)).toEqual(['ep1'])
      // Step 2 never ran: no zip was compressed. Step 3 never ran: no call, board untouched.
      expect(outcome.record?.rezippedZipCount).toBe(0)
      expect(await redis.sMembers(`rezipped:${FIXED_SESSION}`)).toEqual([])
      expect(prompts.some((prompt) => prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT'))).toBe(false)
      expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.content).toBe('Garage width: 6m')
      // The record is stored with the chat.
      const naps = getFixedSessionNapRecords(stored?.metadata ?? null)
      expect(naps.at(-1)?.status).toBe('ended_early')
      expect(naps.at(-1)?.endedEarly).toBe('ended early: a message arrived; 1 closed episode written')
    } finally {
      if (turnId !== null) releaseSessionTurn(FIXED_SESSION, turnId)
    }
  })

  it('BL-549 N1: a turn that starts during the step 3 summary call: the nap writes no summary, event or board for it', async () => {
    await seedNapConversation()
    let turnId: number | null = null
    try {
      const outcome = await runFixedSessionNap({
        userId: USER,
        agent: agentRecord(),
        sessionId: FIXED_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async (prompt) => {
          if (prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')) {
            const registered = registerSessionTurn(FIXED_SESSION, 'single', 'msg_zcnap_turn3')
            turnId = registered.ok ? registered.entry.turnId : null
            return ['SUMMARY:', 'Garage.', 'WHITEBOARD:', 'a nap board that must not land'].join('\n')
          }
          return 'Lake trip planned for July; cabin booked.'
        },
        estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
      })

      expect(outcome.status, outcome.error).toBe('ended_early')
      expect(outcome.endedEarly).toBe('turn_started')
      // Steps 1 and 2 are finished and stay.
      expect(outcome.record?.graduatedEpisodeIds).toEqual(['ep1'])
      expect(outcome.record?.rezippedZipCount).toBeGreaterThan(0)
      expect(outcome.record?.compaction).toBeNull()
      const events = getFixedSessionGraduationState(
        (await redis.getSession(FIXED_SESSION))?.metadata ?? null
      ).events
      expect(events.map((event) => event.episodeId)).toEqual(['ep1'])
      expect((await listMemorySegments(AGENT)).filter((segment) => segment.episode_id === 'ep2')).toEqual([])
      expect((await getEpisode(FIXED_SESSION, 'ep2'))?.whiteboard?.content).toBe('Garage width: 6m')
    } finally {
      if (turnId !== null) releaseSessionTurn(FIXED_SESSION, turnId)
    }
  })

  // BL-549, Faye's option A (2026-09-27): a closed episode does not change when a message
  // arrives, so a step-1 summary whose call FINISHED is written; then the nap ends early.
  async function seedThreeClosedEpisodes() {
    const stretch = [
      ['A', '2026-06-10T06:00:00.000Z'],
      ['B', '2026-06-10T07:00:00.000Z'],
      ['C', '2026-06-10T08:00:00.000Z']
    ] as const
    for (const [label, start] of stretch) {
      const base = new Date(start).getTime()
      for (let index = 0; index < 4; index += 1) {
        await seedMessage(
          FIXED_SESSION,
          `m${label}${index}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `Stretch ${label} note ${index}`,
          new Date(base + index * 60_000).toISOString()
        )
      }
      await seedEpisode({
        id: `ep${label}`,
        state: 'closed',
        opened_at: start,
        closed_at: new Date(base + 10 * 60_000).toISOString(),
        boundary_signal: 'agent_mark'
      })
    }
    await seedMessage(FIXED_SESSION, 'mTail', 'user', bigText('Recent context'), '2026-06-10T11:00:00.000Z')
  }

  it('BL-549 option A: a turn that starts during episode 1\'s summary call: episode 1 is written, episodes 2 and 3 are untouched, the nap ends', async () => {
    await seedThreeClosedEpisodes()
    let turnId: number | null = null
    let calls = 0
    try {
      const outcome = await runFixedSessionNap({
        userId: USER,
        agent: agentRecord(),
        sessionId: FIXED_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async () => {
          calls += 1
          if (turnId === null) {
            const registered = registerSessionTurn(FIXED_SESSION, 'single', 'msg_zcnap_optA')
            turnId = registered.ok ? registered.entry.turnId : -1
          }
          return `Summary number ${calls}.`
        },
        estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
      })

      expect(turnId).toBeGreaterThan(0)
      expect(calls).toBe(1)
      expect(outcome.status, outcome.error).toBe('ended_early')
      expect(outcome.endedEarly).toBe('turn_started')
      expect(outcome.record?.graduatedEpisodeIds).toEqual(['epA'])
      expect(outcome.record?.endedEarly).toBe('ended early: a message arrived; 1 closed episode written')
      expect(outcome.record?.awarenessFold).toBe('skipped')
      expect((await getEpisode(FIXED_SESSION, 'epA'))?.state).toBe('graduated')
      expect((await getEpisode(FIXED_SESSION, 'epB'))?.state).toBe('closed')
      expect((await getEpisode(FIXED_SESSION, 'epC'))?.state).toBe('closed')
      const events = getFixedSessionGraduationState(
        (await redis.getSession(FIXED_SESSION))?.metadata ?? null
      ).events
      expect(events.map((event) => event.episodeId)).toEqual(['epA'])
      expect(events[0].summary).toBe('Summary number 1.')
      const segments = (await listMemorySegments(AGENT)).map((segment) => segment.episode_id)
      expect(segments).toEqual(['epA'])
      expect(await redis.sMembers(`rezipped:${FIXED_SESSION}`)).toEqual([])
    } finally {
      if (turnId !== null && turnId > 0) releaseSessionTurn(FIXED_SESSION, turnId)
    }
  })

  // BL-623 leak: a delete that lands during the token estimate before step 2 left
  // `rezipped:{id}` and `rezipped_item:{id}:*` behind (probe, 2026-09-27, yield helper).
  it('BL-623: a chat deleted during the estimate before step 2 leaves no key of the chat', async () => {
    await seedNapConversation()
    let calls = 0
    const outcome = await runFixedSessionNap({
      userId: USER,
      agent: agentRecord(),
      sessionId: FIXED_SESSION,
      trigger: 'manual',
      eventFetch: fetch,
      now: NOW,
      generateSummary: async (prompt) =>
        prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')
          ? ['SUMMARY:', 'Garage.', 'WHITEBOARD:', 'Garage width: 6m.'].join('\n')
          : 'Lake trip planned for July; cabin booked.',
      estimateTokens: async () => {
        calls += 1
        if (calls === 2) await redis.deleteSession(FIXED_SESSION)
        return [150_000, 130_000, 128_000, 70_000][Math.min(calls - 1, 3)]
      }
    })

    expect(outcome.status, outcome.error).toBe('ended_early')
    expect(outcome.endedEarly).toBe('chat_deleted')
    expect(outcome.record).toBeNull()
    expect(await keysOfFixedSession()).toEqual([])
  })

  // BL-549 N4: the nap's event and its record go at their own paths. Another writer's block,
  // written between any read of the nap and its next write, stays.
  it('BL-549 N4: blocks another writer adds to the chat record during the nap survive the graduation event and the nap record', async () => {
    await seedNapConversation()
    const realGetSession = redis.getSession.bind(redis)
    let written = 0
    const spy = vi.spyOn(redis, 'getSession').mockImplementation(async (id: string) => {
      const session = await realGetSession(id)
      if (id === FIXED_SESSION && session) {
        // Another writer lands right after this read (a Compact, a group move, anything).
        written += 1
        await redis.json.set(`session:${FIXED_SESSION}`, `$.metadata.zcnap_other_${written}`, { n: written } as never)
      }
      return session
    })
    try {
      const outcome = await runFixedSessionNap({
        userId: USER,
        agent: agentRecord(),
        sessionId: FIXED_SESSION,
        trigger: 'manual',
        eventFetch: fetch,
        now: NOW,
        generateSummary: async (prompt) =>
          prompt.includes('OLDER OPEN-EPISODE SEGMENT TO COMPACT')
            ? ['SUMMARY:', 'Garage.', 'WHITEBOARD:', 'Garage width: 6m.'].join('\n')
            : 'Lake trip planned for July; cabin booked.',
        estimateTokens: estimateQueue([150_000, 130_000, 128_000, 70_000])
      })
      expect(outcome.status, outcome.error).toBe('completed')
    } finally {
      spy.mockRestore()
    }
    expect(written).toBeGreaterThan(0)
    const stored = (await redis.getSession(FIXED_SESSION)) as any
    for (let n = 1; n <= written; n += 1) {
      expect(stored.metadata[`zcnap_other_${n}`], `block ${n} of ${written}`).toEqual({ n })
    }
    // The nap's own writes are there too: two events (step 1 and step 3) and one record.
    expect(getFixedSessionGraduationState(stored.metadata).events).toHaveLength(2)
    expect(getFixedSessionNapRecords(stored.metadata)).toHaveLength(1)
    expect(stored.metadata.fixedSession.enabled).toBe(true)
  })

  it('BL-549 N4: two nap records and two graduation events written at once both stay; the record list keeps its last 20', async () => {
    await redis.json.set(`session:${FIXED_SESSION}`, '$.metadata.fixedSession.naps', [] as never)
    for (let n = 0; n < 19; n += 1) {
      await redis.execute((client) =>
        client.json.arrAppend(`session:${FIXED_SESSION}`, '$.metadata.fixedSession.naps', {
          id: `nap_old_${n}`, at: NOW.toISOString(), status: 'completed'
        })
      )
    }
    const record = (id: string) => ({
      id, at: NOW.toISOString(), trigger: 'manual' as const, status: 'completed' as const,
      tokensBefore: 1, tokensAfter: 1, napAtTokens: 1, graduatedEpisodeIds: [], segmentIds: [],
      skippedEpisodes: [], rezippedZipCount: 0, compaction: null
    })
    const event = (id: string) => ({
      id, createdAt: NOW.toISOString(), source: 'nap' as const, episodeId: null, segmentId: `seg_${id}`,
      sourceMessageIds: ['m1'], compactedMessageCount: 1, summary: `summary ${id}`, summaryTokenEstimate: 3
    })
    await Promise.all([
      redis.appendFixedSessionNapRecord(FIXED_SESSION, record('nap_a')),
      redis.appendFixedSessionNapRecord(FIXED_SESSION, record('nap_b')),
      redis.appendFixedSessionGraduationEvent(FIXED_SESSION, event('grad_a')),
      redis.appendFixedSessionGraduationEvent(FIXED_SESSION, event('grad_b'))
    ])
    const stored = (await redis.getSession(FIXED_SESSION)) as any
    const naps = getFixedSessionNapRecords(stored.metadata).map((nap) => nap.id)
    expect(naps).toHaveLength(20)
    expect(naps).toEqual(expect.arrayContaining(['nap_a', 'nap_b']))
    expect(naps).not.toContain('nap_old_0')
    const events = getFixedSessionGraduationState(stored.metadata).events.map((entry) => entry.id)
    expect(events.sort()).toEqual(['grad_a', 'grad_b'])
    // A chat that is gone gets no write and is never recreated.
    await redis.deleteSession(FIXED_SESSION)
    expect(await redis.appendFixedSessionNapRecord(FIXED_SESSION, record('nap_c'))).toBeNull()
    expect(await redis.appendFixedSessionGraduationEvent(FIXED_SESSION, event('grad_c'))).toBe('missing')
    expect(await redis.exists(`session:${FIXED_SESSION}`)).toBe(false)
  })

  it('BL-549 N4: the era swap keeps a block and an event another writer added, and refuses when a replaced event is gone', async () => {
    const event = (id: string) => ({
      id, createdAt: NOW.toISOString(), source: 'nap' as const, episodeId: null, segmentId: `seg_${id}`,
      sourceMessageIds: [`m_${id}`], compactedMessageCount: 1, summary: `summary ${id}`, summaryTokenEstimate: 3
    })
    await redis.json.set(`session:${FIXED_SESSION}`, '$.metadata.fixedSession.graduation', {
      version: 1, events: [event('g1'), event('g2'), event('g3')]
    } as never)
    // Written after dreaming read the events for its era summary: a block and a new event.
    await redis.json.set(`session:${FIXED_SESSION}`, '$.metadata.zcnap_swap_before', { kept: true } as never)
    await redis.execute((client) =>
      client.json.arrAppend(`session:${FIXED_SESSION}`, '$.metadata.fixedSession.graduation.events', event('g4') as never)
    )
    // And another writer that lands right after any read the swap itself makes.
    const realGetSession = redis.getSession.bind(redis)
    let written = 0
    const spy = vi.spyOn(redis, 'getSession').mockImplementation(async (id: string) => {
      const session = await realGetSession(id)
      if (id === FIXED_SESSION && session) {
        written += 1
        await redis.json.set(`session:${FIXED_SESSION}`, `$.metadata.zcnap_swap_other_${written}`, { n: written } as never)
      }
      return session
    })
    try {
      await swapGraduationEvents(FIXED_SESSION, ['g1', 'g2'], event('era'))
    } finally {
      spy.mockRestore()
    }
    const stored = (await redis.getSession(FIXED_SESSION)) as any
    expect(stored.metadata.zcnap_swap_before).toEqual({ kept: true })
    for (let n = 1; n <= written; n += 1) {
      expect(stored.metadata[`zcnap_swap_other_${n}`], `block ${n} of ${written}`).toEqual({ n })
    }
    const ids = getFixedSessionGraduationState(stored.metadata).events.map((entry) => entry.id)
    expect(ids).toEqual(['era', 'g3', 'g4'])
    // A replaced event that is gone refuses the swap and changes nothing.
    await expect(swapGraduationEvents(FIXED_SESSION, ['g1', 'g3'], event('era2'))).rejects.toThrow(/changed underneath/)
    const after = getFixedSessionGraduationState(((await redis.getSession(FIXED_SESSION)) as any).metadata).events
    expect(after.map((entry) => entry.id)).toEqual(['era', 'g3', 'g4'])
  })
})
