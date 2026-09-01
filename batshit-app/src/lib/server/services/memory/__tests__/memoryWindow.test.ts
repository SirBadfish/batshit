import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { createMemorySegment, listMemorySegments, getMemorySegment } from '../memoryStore'
import {
  graduateRegularSessionTail,
  parseNapCompactionSections,
  runFixedSessionNap
} from '../memoryGraduation'
import {
  ensureFixedSessionOpenEpisode,
  episodeKey,
  getEpisode,
  sessionEpisodesKey,
  type EpisodeRecord
} from '../memoryEpisodes'
import { updateWhiteboardOp, searchMemoriesOp, recallMemoriesOp, MemoryToolError } from '../memoryTools'
import { computeMemoryCompileContext, commitMemoryTurnState } from '../memoryRecall'
import { getMemoryLingerState } from '../memoryLinger'
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
      whiteboard: { content: 'Garage width: 6m', updated_at: '2026-06-10T09:30:00.000Z' }
    })
    return { ep1, ep2 }
  }

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

    // Whiteboard refreshed on the open episode.
    const ep2 = await getEpisode(FIXED_SESSION, 'ep2')
    expect(ep2?.state).toBe('open')
    expect(ep2?.whiteboard?.content).toBe('Garage width: 6m. Next: order shelving.')

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

  // -------------------------------------------------------------------------
  // Whiteboard lifecycle (packet §1.9)
  // -------------------------------------------------------------------------

  it('whiteboard: tool-edited, compiled into awareness, dissolved (kept) at close', async () => {
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
    expect(compiled.whiteboardBlock).toContain('==== EPISODE WHITEBOARD (CURRENT EPISODE) ====')
    expect(compiled.whiteboardBlock).toContain('Current goal: ship P6.')
    expect(compiled.memoryContext?.whiteboard?.present).toBe(true)

    // Regular sessions never compile a whiteboard.
    const regularCompiled = await computeMemoryCompileContext({
      userId: USER,
      agentId: AGENT,
      sessionId: REGULAR_SESSION,
      currentUserMessage: 'hello'
    })
    expect(regularCompiled.whiteboardBlock).toBe('')

    // Close dissolves: content kept on the record, block no longer compiled.
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
    expect(afterClose.whiteboardBlock).toBe('')

    // With no open episode left, the whiteboard control refuses loudly.
    await expect(
      updateWhiteboardOp(
        { userId: USER, agentId: AGENT, sessionId: FIXED_SESSION },
        { content: 'anything' }
      )
    ).rejects.toBeInstanceOf(MemoryToolError)
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
})
