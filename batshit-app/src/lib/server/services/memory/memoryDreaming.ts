/**
 * SA-104 P7 — Dreaming v1: between-conversation memory maintenance (DL-104-02 /
 * DL-104-13 / DL-104-15; p7 packet doc §1).
 *
 * THE architecture decision (packet §1.1): dreaming is a deterministic maintenance
 * pipeline over the EXISTING grounded memory operations, with the configured summary
 * model consulted at exactly three bounded judgment points — episode graduation
 * summaries (the shared P6 writer), consolidation merge verdicts (strict JSON), and
 * era summaries. It is NOT a free tool-calling agent run: bounded budgets,
 * per-operation atomic commits, and deterministic tests all require code-owned
 * control flow (the Letta sleep-time-compute shape).
 *
 * Seven phases in a fixed order (packet §1.2): fixed-session episode work →
 * regular-session idle sweep → embedding refresh → expiry processing → supersession
 * repair → consolidation → era consolidation. Every mutation commits atomically
 * through its primitive; every action (including meaningful skips and kept-separate
 * reviews) lands on the visible run log with a WHY. A failed operation marks that
 * one action failed and the pass continues — partial work is real, coherent, and
 * never hidden.
 *
 * DL-104-15 interlock: the run checks the session-turn registry immediately before
 * every session-touching phase and skips live sessions with a logged reason. The
 * native n8n lane never registers turns (recorded accepted gap, packet §1.4): its
 * protections are the scheduled trigger's hours-long agent-idle requirement plus the
 * nap's immutable-write safety argument.
 *
 * Deterministic tests inject `generateSummary`, `embedder`, and `now` (the P2/P6
 * seam pattern); live model calls never run in the test lane (live proof is P8).
 */

import { redis } from '$lib/server/redis'
import type { Message } from '$lib/stores/messages.svelte'
import { getActiveSessionTurn } from '$lib/server/services/streamAbortRegistry'
import { isFixedSession } from '$lib/utils/fixedSession'
import {
  resolveAgentMemoryEnabled,
  resolveMemoryIdleGapHours,
  resolveMemoryWindowSettings,
  resolveEffectiveMemoryWindow,
  validateMemorySavePayload
} from '$lib/utils/memoryControl'
import {
  getFixedSessionGraduationState,
  type FixedSessionGraduationEvent
} from '$lib/utils/fixedSessionGraduation'
import { calculateRecoveryHoldByIndex } from '$lib/utils/zipMessageAge'
import { resolveCompactSummaryBudget } from '$lib/utils/contextCompaction'
import { countTotalTokens } from '$lib/utils/tokenCounter'
import {
  loadContextProtections,
  normalizeMessages,
  resolveAgentBudgetSettings
} from '$lib/server/services/contextTokenPreview'
import {
  buildDefaultSummaryGenerator,
  graduateClosedEpisodesForSession,
  graduateRegularSessionTail,
  resolveMemorySummaryModelChoice,
  swapGraduationEvents,
  type SummaryGenerator
} from './memoryGraduation'
import { closeEpisode, getOpenEpisode } from './memoryEpisodes'
import { foldAwarenessState } from './memoryRecall'
import {
  createMemory,
  createMemorySegment,
  fetchMemoriesByKeys,
  fetchMemorySegmentsByIds,
  listMemories,
  listMemorySegments,
  markExpiredDemotion,
  supersedeMemory
} from './memoryStore'
import { createMemoryEmbedderAsync, type MemoryEmbedder } from './memoryEmbedder'
import { getMemoryConfig, knnSearchMemories, requireReadyMemoryIndexes } from './memoryIndex'
import {
  memoryDreamIndexKey,
  memoryDreamRunKey,
  memoryKey,
  memorySegmentKey
} from './memoryKeys'
import { MEMORY_NEAR_DUPLICATE_MAX_DISTANCE } from './memoryTools'
import type { MemoryLane, MemoryProvenanceEntry, MemoryRecord } from './memoryTypes'

type AgentRecord = Record<string, any>

// ---------------------------------------------------------------------------
// Bounds (DL-104-15 "bounded budgets, bounded item counts" — packet §1.6)
// ---------------------------------------------------------------------------

export const DREAMING_MAX_FIXED_SESSIONS = 10
export const DREAMING_MAX_EPISODES_PER_SESSION = 10
export const DREAMING_MAX_REGULAR_SESSIONS = 20
export const DREAMING_MAX_REEMBEDS = 50
export const DREAMING_MAX_EXPIRY_DEMOTIONS = 50
export const DREAMING_MAX_SUPERSESSION_REPAIRS = 50
export const DREAMING_MAX_CONSOLIDATION_SCAN = 100
export const DREAMING_MAX_CONSOLIDATION_CLUSTERS = 5
export const DREAMING_MAX_CLUSTER_MEMBERS = 4
export const DREAMING_MAX_MODEL_CALLS = 12
export const DREAMING_RUN_HISTORY_LIMIT = 50
export const DREAMING_ERA_MIN_EVENTS = 12
export const DREAMING_ERA_BATCH_MAX = 8
export const DREAMING_ERA_MIN_AGE_DAYS = 14

// ---------------------------------------------------------------------------
// Run record shapes (`memdream:{agentId}:{runId}` — the visible log, packet §1.5)
// ---------------------------------------------------------------------------

export type DreamingTrigger = 'manual' | 'scheduled'

export type DreamingActionKind =
  | 'close_episode'
  | 'graduate_episode'
  | 'graduate_regular_tail'
  | 'reembed'
  | 'expire_demote'
  | 'supersession_repair'
  | 'consolidation_review'
  | 'consolidate_merge'
  | 'era_consolidation'
  | 'awareness_fold'
  | 'skip_session'

export interface DreamingActionRecord {
  at: string
  kind: DreamingActionKind
  status: 'done' | 'failed' | 'skipped'
  /** Every action carries its WHY — the log is the inspectability surface (DL-104-02). */
  why: string
  refs?: Record<string, unknown>
  error?: string
}

export interface DreamingRunCounts {
  episodesClosed: number
  episodesGraduated: number
  regularSessionsGraduated: number
  reembedded: number
  expiriesDemoted: number
  supersessionRepairs: number
  consolidationMerges: number
  consolidationReviews: number
  eraConsolidations: number
  modelCalls: number
  failures: number
  skips: number
}

export interface DreamingRunRecord {
  id: string
  agent_id: string
  user_id: string
  trigger: DreamingTrigger
  started_at: string
  finished_at?: string | null
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed'
  actions: DreamingActionRecord[]
  counts: DreamingRunCounts
  error?: string
  schema_version: 1
}

/** Summary row for the manage/dreams listing (actions omitted). */
export interface DreamingRunSummary {
  id: string
  trigger: DreamingTrigger
  started_at: string
  finished_at?: string | null
  status: DreamingRunRecord['status']
  counts: DreamingRunCounts
  error?: string
}

export class DreamingBusyError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} is already dreaming; one pass runs at a time.`)
    this.name = 'DreamingBusyError'
  }
}

/** Module-private sentinel: the global model-call budget for one pass ran out. */
class DreamingModelBudgetExhausted extends Error {
  constructor() {
    super(`Dreaming model-call budget (${DREAMING_MAX_MODEL_CALLS}) reached for this pass.`)
    this.name = 'DreamingModelBudgetExhausted'
  }
}

const activeDreamRuns = new Set<string>()

function randomIdSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

// ---------------------------------------------------------------------------
// Scheduled-trigger eligibility (pure — unit-tested; packet §1.3)
// ---------------------------------------------------------------------------

/**
 * At most one dream per idle period per agent: memory enabled, a last interaction
 * exists, the agent has been idle past its idle gap, and no run has started since
 * that interaction. `memory_last_interaction_ts` is stamped at every accepted send —
 * Every live Primary Agent send passes through send-routed's accepted-send commit
 * boundary, so "idle" is lane-complete.
 */
export function shouldRunScheduledDream(
  agent: AgentRecord | null | undefined,
  lastRunStartedAt: string | null,
  now: Date
): boolean {
  if (!agent || !resolveAgentMemoryEnabled(agent)) return false
  const lastInteractionTs =
    typeof agent.memory_last_interaction_ts === 'number' ? agent.memory_last_interaction_ts : null
  if (!lastInteractionTs || !Number.isFinite(lastInteractionTs)) return false
  const idleMs = resolveMemoryIdleGapHours(agent) * 3_600_000
  if (now.getTime() - lastInteractionTs < idleMs) return false
  if (lastRunStartedAt) {
    const runTs = new Date(lastRunStartedAt).getTime()
    if (Number.isFinite(runTs) && runTs >= lastInteractionTs) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Consolidation verdict parsing (strict — DL-104-05 posture; exported for tests)
// ---------------------------------------------------------------------------

export interface DreamingConsolidationVerdict {
  merge: boolean
  reason: string
  merged?: {
    lane: MemoryLane
    content: string
    gist?: string
    trigger_terms?: string[]
    trigger_synonyms?: string[]
  }
}

const DREAMING_CONSOLIDATION_PROMPT = [
  'You are performing overnight memory maintenance ("dreaming") for a Batshit agent. Below are stored memories whose embeddings are nearly identical — likely duplicates.',
  '',
  'Decide whether they state the SAME underlying fact. Reply with EXACTLY one JSON object and nothing else (no prose, no code fences):',
  '{"merge": true, "reason": "one sentence", "merged": {"lane": "awareness|stm|ltm", "content": "the single best combined memory", "gist": "short line", "trigger_terms": ["only if lane is stm"]}}',
  'or',
  '{"merge": false, "reason": "one sentence"}',
  '',
  'Rules: merge only true restatements or partial copies of one fact — different facts about the same topic stay separate. When merging: keep every distinct detail, prefer newer corrections over older wording, choose the most fitting lane among the members\' lanes, and include trigger_terms only when the merged memory belongs in stm.'
].join('\n')

export function parseDreamingConsolidationVerdict(text: string): DreamingConsolidationVerdict {
  const stripped = text.replace(/```[a-z]*\n?/gi, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('Consolidation verdict was not a JSON object; the cluster was left untouched.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch (error) {
    throw new Error(
      `Consolidation verdict was not valid JSON (${error instanceof Error ? error.message : 'parse error'}); the cluster was left untouched.`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Consolidation verdict must be a JSON object; the cluster was left untouched.')
  }
  const record = parsed as Record<string, any>
  if (typeof record.merge !== 'boolean') {
    throw new Error('Consolidation verdict is missing the boolean "merge" field.')
  }
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : ''
  if (!reason) {
    throw new Error('Consolidation verdict is missing "reason" — every dreaming decision records its why.')
  }
  if (!record.merge) return { merge: false, reason }
  const merged = record.merged
  if (!merged || typeof merged !== 'object' || Array.isArray(merged)) {
    throw new Error('Consolidation verdict has merge=true but no "merged" object.')
  }
  return { merge: true, reason, merged: merged as DreamingConsolidationVerdict['merged'] }
}

const DREAMING_ERA_PROMPT = [
  'You are performing overnight memory maintenance ("dreaming") for a Batshit agent\'s long-running Infinite Session. Below are the gist summaries of several old, already-graduated conversation stretches. They currently occupy one window splice each; you are distilling them into ONE era summary that will replace them in the live window. The detailed per-stretch summaries remain searchable — nothing is lost.',
  '',
  'Write one dense, factual era summary preserving the facts, decisions, preferences, outcomes, names, dates, and unresolved items that still matter. Order it chronologically. No preamble, no closing remarks — return only the summary.'
].join('\n')

// ---------------------------------------------------------------------------
// Run storage + readers
// ---------------------------------------------------------------------------

async function writeRun(record: DreamingRunRecord): Promise<void> {
  await redis.json.set(memoryDreamRunKey(record.agent_id, record.id), '$', record as never)
}

async function pushRunToIndex(agentId: string, runId: string): Promise<void> {
  await redis.execute(async (client) => {
    const indexKey = memoryDreamIndexKey(agentId)
    await client.lPush(indexKey, runId)
    // Bounded operational telemetry (packet §1.5): rotation deletes rotated records.
    const rotated = await client.lRange(indexKey, DREAMING_RUN_HISTORY_LIMIT, -1)
    for (const staleId of rotated) {
      await client.del(memoryDreamRunKey(agentId, staleId))
    }
    await client.lTrim(indexKey, 0, DREAMING_RUN_HISTORY_LIMIT - 1)
  })
}

export async function getDreamRun(agentId: string, runId: string): Promise<DreamingRunRecord | null> {
  return (await redis.json.get(memoryDreamRunKey(agentId, runId))) as DreamingRunRecord | null
}

export async function getDreamRunSummaries(
  agentId: string,
  limit = 20
): Promise<DreamingRunSummary[]> {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), DREAMING_RUN_HISTORY_LIMIT)
  const runIds = await redis.execute(async (client) =>
    client.lRange(memoryDreamIndexKey(agentId), 0, bounded - 1)
  )
  const summaries: DreamingRunSummary[] = []
  for (const runId of runIds) {
    const record = await getDreamRun(agentId, runId)
    if (!record) continue
    summaries.push({
      id: record.id,
      trigger: record.trigger,
      started_at: record.started_at,
      finished_at: record.finished_at ?? null,
      status: record.status,
      counts: record.counts,
      ...(record.error ? { error: record.error } : {})
    })
  }
  return summaries
}

export async function getLatestDreamRunStartedAt(agentId: string): Promise<string | null> {
  const runIds = await redis.execute(async (client) =>
    client.lRange(memoryDreamIndexKey(agentId), 0, 0)
  )
  if (runIds.length === 0) return null
  const record = await getDreamRun(agentId, runIds[0])
  return record?.started_at ?? null
}

export function isAgentDreaming(agentId: string): boolean {
  return activeDreamRuns.has(agentId)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function countsFromActions(actions: DreamingActionRecord[], modelCalls: number): DreamingRunCounts {
  const counts: DreamingRunCounts = {
    episodesClosed: 0,
    episodesGraduated: 0,
    regularSessionsGraduated: 0,
    reembedded: 0,
    expiriesDemoted: 0,
    supersessionRepairs: 0,
    consolidationMerges: 0,
    consolidationReviews: 0,
    eraConsolidations: 0,
    modelCalls,
    failures: 0,
    skips: 0
  }
  for (const action of actions) {
    if (action.status === 'failed') counts.failures += 1
    if (action.status === 'skipped') counts.skips += 1
    if (action.status !== 'done') continue
    switch (action.kind) {
      case 'close_episode':
        counts.episodesClosed += 1
        break
      case 'graduate_episode':
        counts.episodesGraduated += 1
        break
      case 'graduate_regular_tail':
        counts.regularSessionsGraduated += 1
        break
      case 'reembed':
        counts.reembedded += 1
        break
      case 'expire_demote':
        counts.expiriesDemoted += 1
        break
      case 'supersession_repair':
        counts.supersessionRepairs += 1
        break
      case 'consolidate_merge':
        counts.consolidationMerges += 1
        break
      case 'consolidation_review':
        counts.consolidationReviews += 1
        break
      case 'era_consolidation':
        counts.eraConsolidations += 1
        break
    }
  }
  return counts
}

function sessionModifiedTs(session: Record<string, any>): number {
  const raw = session.last_modified_at || session.created_at
  const parsed = raw ? new Date(raw).getTime() : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function dedupeProvenance(entries: MemoryProvenanceEntry[]): MemoryProvenanceEntry[] {
  const seen = new Set<string>()
  const result: MemoryProvenanceEntry[] = []
  for (const entry of entries) {
    const key = JSON.stringify([
      entry.session_id,
      entry.message_id ?? null,
      entry.source,
      entry.quote ?? null
    ])
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

/** Union-find clustering over near-duplicate pairs (cosine distance ≤ 0.1). */
async function buildConsolidationClusters(
  agentId: string,
  candidates: MemoryRecord[]
): Promise<string[][]> {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let cursor = id
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }

  const candidateIds = new Set(candidates.map((record) => record.id))
  for (const id of candidateIds) parent.set(id, id)

  for (const record of candidates) {
    const hits = await knnSearchMemories({
      agentId,
      vector: record.embedding,
      k: DREAMING_MAX_CLUSTER_MEMBERS,
      filters: { superseded: 'n' }
    })
    for (const hit of hits) {
      if (!Number.isFinite(hit.score) || hit.score > MEMORY_NEAR_DUPLICATE_MAX_DISTANCE) continue
      const hitId = hit.key.split(':').pop() as string
      if (hitId === record.id) continue
      if (!candidateIds.has(hitId)) continue
      union(record.id, hitId)
    }
  }

  const clusters = new Map<string, string[]>()
  for (const id of candidateIds) {
    const root = find(id)
    const cluster = clusters.get(root) ?? []
    cluster.push(id)
    clusters.set(root, cluster)
  }

  const newestTs = new Map(candidates.map((record) => [record.id, record.saved_ts]))
  return Array.from(clusters.values())
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) =>
      cluster
        .sort((a, b) => (newestTs.get(b) ?? 0) - (newestTs.get(a) ?? 0))
        .slice(0, DREAMING_MAX_CLUSTER_MEMBERS)
    )
    .sort(
      (a, b) => (newestTs.get(b[0]) ?? 0) - (newestTs.get(a[0]) ?? 0)
    )
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface DreamingRunOptions {
  userId: string
  agent: AgentRecord
  trigger: DreamingTrigger
  /** Test seams (P2/P6 pattern): summary generator, embedder, clock, budget. */
  generateSummary?: SummaryGenerator
  embedder?: MemoryEmbedder
  now?: Date
  maxModelCalls?: number
}

export async function runDreamingPass(options: DreamingRunOptions): Promise<DreamingRunRecord> {
  const agentId = String(options.agent?.id ?? '')
  if (!agentId) throw new Error('Dreaming requires an agent id.')
  if (!resolveAgentMemoryEnabled(options.agent)) {
    throw new Error('Dreaming requires agent memory to be enabled.')
  }
  if (activeDreamRuns.has(agentId)) throw new DreamingBusyError(agentId)
  activeDreamRuns.add(agentId)

  const now = options.now ?? new Date()
  const stamp = () => (options.now ? now.toISOString() : new Date().toISOString())

  const record: DreamingRunRecord = {
    id: `dream_${now.getTime()}_${randomIdSuffix()}`,
    agent_id: agentId,
    user_id: options.userId,
    trigger: options.trigger,
    started_at: now.toISOString(),
    finished_at: null,
    status: 'running',
    actions: [],
    counts: countsFromActions([], 0),
    schema_version: 1
  }

  let modelCalls = 0
  const act = (
    kind: DreamingActionKind,
    status: DreamingActionRecord['status'],
    why: string,
    refs?: Record<string, unknown>,
    error?: string
  ) => {
    record.actions.push({
      at: stamp(),
      kind,
      status,
      why,
      ...(refs ? { refs } : {}),
      ...(error ? { error } : {})
    })
  }
  const flush = async () => {
    record.counts = countsFromActions(record.actions, modelCalls)
    await writeRun(record)
  }

  try {
    // The run is discoverable from its first breath — even an index-bootstrap
    // failure below leaves an honest failed record in the visible log.
    await writeRun(record)
    await pushRunToIndex(agentId, record.id)

    // Indexes must be operational before any maintenance write (DL-104-10).
    const indexMeta = await requireReadyMemoryIndexes()

    // Model seam: the configured summary model (inherit → Auto Compact choice). A
    // configuration error becomes a per-call loud failure so deterministic phases
    // still run (packet §1.1).
    let baseGenerate: SummaryGenerator
    if (options.generateSummary) {
      baseGenerate = options.generateSummary
    } else {
      try {
        const userSettings = await redis.getUserSettings(options.userId).catch(() => null)
        const choice = resolveMemorySummaryModelChoice(
          options.agent,
          userSettings?.global_auto_compact_settings
        )
        baseGenerate = buildDefaultSummaryGenerator({
          userId: options.userId,
          agent: options.agent,
          choice
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Summary model unavailable.'
        baseGenerate = async () => {
          throw new Error(message)
        }
      }
    }
    const maxModelCalls = options.maxModelCalls ?? DREAMING_MAX_MODEL_CALLS
    const generate: SummaryGenerator = async (prompt, hardMaxTokens) => {
      if (modelCalls >= maxModelCalls) throw new DreamingModelBudgetExhausted()
      modelCalls += 1
      return baseGenerate(prompt, hardMaxTokens)
    }

    // SA-102 P5 (DL-102-14): async door so a key-protected local program gets
    // the key from the shared encrypted store rather than the placeholder.
    const embedder =
      options.embedder ??
      (await createMemoryEmbedderAsync((await getMemoryConfig()).embedding, {
        userId: options.userId
      }))

    const allSessions = await redis.getSessions(options.userId, true)
    const agentSessions = allSessions.filter(
      (session) => (session as Record<string, any>).agent_id === agentId
    )
    const nonGroup = agentSessions.filter(
      (session) => !(session.metadata as Record<string, any> | undefined)?.group_chat
    )
    const fixedSessions = nonGroup
      .filter((session) => isFixedSession(session))
      .sort((a, b) => sessionModifiedTs(b) - sessionModifiedTs(a))
      .slice(0, DREAMING_MAX_FIXED_SESSIONS)
    const regularSessions = nonGroup
      .filter((session) => !isFixedSession(session))
      .sort((a, b) => sessionModifiedTs(a) - sessionModifiedTs(b))
      .slice(0, DREAMING_MAX_REGULAR_SESSIONS)

    // ---- Phase 1: fixed-session episode work (close idle → graduate closed) ----
    for (const session of fixedSessions) {
      const sessionId = session.id
      if (getActiveSessionTurn(sessionId)) {
        act('skip_session', 'skipped', 'live turn in progress — dreaming never touches an active session (DL-104-15)', { sessionId })
        continue
      }

      try {
        const open = await getOpenEpisode(sessionId)
        if (open) {
          const idleGapMs = resolveMemoryIdleGapHours(options.agent) * 3_600_000
          const holdTs = open.hold_until ? new Date(open.hold_until).getTime() : Number.NaN
          const holdActive = Number.isFinite(holdTs) && holdTs > now.getTime()
          const lastActivityTs = new Date(open.last_activity_at ?? open.opened_at).getTime()
          const idleFor = now.getTime() - lastActivityTs
          if (holdActive && Number.isFinite(lastActivityTs) && idleFor > idleGapMs) {
            act(
              'close_episode',
              'skipped',
              `open episode is idle but held ("continue tomorrow") until ${open.hold_until} — it stays open, whole and untouched`,
              { sessionId, episodeId: open.id }
            )
          } else if (!holdActive && Number.isFinite(lastActivityTs) && idleFor > idleGapMs) {
            await closeEpisode(sessionId, open.id, 'dreaming')
            act(
              'close_episode',
              'done',
              `open episode idle past the ${resolveMemoryIdleGapHours(options.agent)}h gap with no hold — closed overnight so it can graduate`,
              { sessionId, episodeId: open.id }
            )
          }
        }

        const windowSettings = resolveMemoryWindowSettings(options.agent)
        const budgetSettings = await resolveAgentBudgetSettings(options.agent)
        const window = resolveEffectiveMemoryWindow(windowSettings, budgetSettings.contextLimit)
        if (!window) {
          act(
            'skip_session',
            'skipped',
            'no model context limit resolvable for this agent — the floor cannot be computed, so episode graduation waits (honest unknown)',
            { sessionId }
          )
          continue
        }

        const messages = normalizeMessages(await redis.getSessionMessages(sessionId))
        const protections = await loadContextProtections(sessionId)
        const recoveryHold = calculateRecoveryHoldByIndex(messages)
        const recoveryHoldIds = new Set(
          messages.filter((_, index) => recoveryHold[index]).map((message) => message.id)
        )

        const result = await graduateClosedEpisodesForSession({
          userId: options.userId,
          agentId,
          sessionId,
          source: 'dreaming',
          window,
          messages,
          protections,
          recoveryHoldIds,
          generateSummary: generate,
          embedder,
          now,
          maxEpisodes: DREAMING_MAX_EPISODES_PER_SESSION
        })
        for (const entry of result.graduated) {
          act(
            'graduate_episode',
            'done',
            entry.segmentId
              ? 'closed episode consolidated into searchable memory; its gist now splices into the window (next-morning position = floor + gists)'
              : 'episode was already excluded from the window by an earlier write — finished the graduation mark (retry-safe ladder)',
            { sessionId, episodeId: entry.episodeId, ...(entry.segmentId ? { segmentId: entry.segmentId } : {}) }
          )
        }
        for (const skipped of result.skippedEpisodes) {
          act('graduate_episode', 'skipped', `episode not graduated: ${skipped.reason}`, {
            sessionId,
            episodeId: skipped.episodeId
          })
        }
      } catch (error) {
        if (error instanceof DreamingModelBudgetExhausted) {
          act('graduate_episode', 'skipped', 'model-call budget reached — remaining episodes graduate on the next dream', { sessionId })
          break
        }
        act(
          'graduate_episode',
          'failed',
          'episode work failed for this session; nothing partial was left behind (per-write coherence)',
          { sessionId },
          error instanceof Error ? error.message : 'unknown error'
        )
      }
    }
    await flush()

    // ---- Phase 2: regular-session idle sweep (the durable lane, packet §1.2) ----
    for (const session of regularSessions) {
      const sessionId = session.id
      if (getActiveSessionTurn(sessionId)) {
        act('skip_session', 'skipped', 'live turn in progress — dreaming never touches an active session (DL-104-15)', { sessionId })
        continue
      }
      try {
        const outcome = await graduateRegularSessionTail({
          userId: options.userId,
          agent: options.agent,
          sessionId,
          reason: 'idle',
          generateSummary: generate,
          embedder,
          now
        })
        if (outcome.status === 'graduated') {
          act(
            'graduate_regular_tail',
            'done',
            `idle regular session had ${outcome.messageCount} ungraduated messages past the watermark — its tail is now searchable memory (window untouched by design)`,
            { sessionId, segmentId: outcome.segmentId }
          )
        }
        // not_idle / nothing_new / too_small stay quiet — no nightly no-op spam.
      } catch (error) {
        if (error instanceof DreamingModelBudgetExhausted) {
          act('graduate_regular_tail', 'skipped', 'model-call budget reached — remaining sessions sweep on the next dream', { sessionId })
          break
        }
        act(
          'graduate_regular_tail',
          'failed',
          'regular-session graduation failed; the watermark did not advance',
          { sessionId },
          error instanceof Error ? error.message : 'unknown error'
        )
      }
    }
    await flush()

    // ---- Phase 3: embedding refresh (model-drift safety net; before consolidation
    // so KNN sees current-model vectors) ----
    if (embedder.modelId !== indexMeta.embedding_model || embedder.dims !== indexMeta.dims) {
      act(
        'reembed',
        'failed',
        `configured embedder (${embedder.modelId}) does not match the built index (${indexMeta.embedding_model}) — run the explicit memory re-index path; embedding-dependent phases will fail until then`,
        {}
      )
    } else {
      try {
        const memories = await listMemories(agentId)
        const segments = await listMemorySegments(agentId)
        let refreshed = 0
        for (const memory of memories) {
          if (refreshed >= DREAMING_MAX_REEMBEDS) break
          if (memory.embedding_model === indexMeta.embedding_model) continue
          const [embedding] = await embedder.embedDocuments([memory.content])
          const next = {
            ...memory,
            embedding,
            embedding_model: embedder.modelId,
            updated_at: now.toISOString()
          }
          await redis.json.set(memoryKey(agentId, memory.id), '$', next as never)
          refreshed += 1
          act(
            'reembed',
            'done',
            `memory carried a stale embedding model (${memory.embedding_model}) — re-embedded with ${embedder.modelId} so search sees it correctly`,
            { memoryId: memory.id }
          )
        }
        for (const segment of segments) {
          if (refreshed >= DREAMING_MAX_REEMBEDS) break
          if (segment.embedding_model === indexMeta.embedding_model) continue
          const [embedding] = await embedder.embedDocuments([segment.summary])
          const next = { ...segment, embedding, embedding_model: embedder.modelId }
          await redis.json.set(memorySegmentKey(agentId, segment.id), '$', next as never)
          refreshed += 1
          act(
            'reembed',
            'done',
            `segment carried a stale embedding model (${segment.embedding_model}) — re-embedded with ${embedder.modelId}`,
            { segmentId: segment.id }
          )
        }
      } catch (error) {
        act(
          'reembed',
          'failed',
          'embedding refresh failed; affected records keep their previous vectors',
          {},
          error instanceof Error ? error.message : 'unknown error'
        )
      }
    }
    await flush()

    // ---- Phase 4: expiry processing (demote, never erase — DL-104-02) ----
    try {
      const memories = await listMemories(agentId)
      let demoted = 0
      for (const memory of memories) {
        if (demoted >= DREAMING_MAX_EXPIRY_DEMOTIONS) break
        if (!memory.expires_ts || memory.expires_ts > now.getTime()) continue
        if (memory.expired_demoted_to) continue
        if (memory.is_superseded === 'y') continue
        const target: MemoryLane =
          memory.lane === 'awareness'
            ? memory.trigger_terms?.length
              ? 'stm'
              : 'ltm'
            : 'ltm'
        try {
          await markExpiredDemotion(agentId, memory.id, target)
          demoted += 1
          act(
            'expire_demote',
            'done',
            memory.lane === target
              ? `expired ${memory.expires_at} — already ${target}; marked processed so it stays searchable and flagged expired`
              : `expired ${memory.expires_at} — demoted ${memory.lane} → ${target} so it stops ${memory.lane === 'awareness' ? 'compiling into the system prompt' : 'auto-firing on triggers'} but stays searchable (never erased)`,
            { memoryId: memory.id, from: memory.lane, to: target }
          )
        } catch (error) {
          act(
            'expire_demote',
            'failed',
            'expiry demotion failed; the memory keeps its current lane',
            { memoryId: memory.id },
            error instanceof Error ? error.message : 'unknown error'
          )
        }
      }
    } catch (error) {
      act(
        'expire_demote',
        'failed',
        'expiry scan failed; no demotions were performed',
        {},
        error instanceof Error ? error.message : 'unknown error'
      )
    }
    await flush()

    // ---- Phase 5: supersession repair (the pointer is the authority) ----
    try {
      const memories = await listMemories(agentId)
      const byId = new Map(memories.map((memory) => [memory.id, memory]))
      let repairs = 0
      const write = async (memory: MemoryRecord) => {
        memory.updated_at = now.toISOString()
        await redis.json.set(memoryKey(agentId, memory.id), '$', memory as never)
      }
      // The store's supersede/unsupersede own the happy paths; dreaming repairs the
      // broken shapes those functions refuse to touch (crashed half-writes, deletes).
      for (const memory of memories) {
        if (repairs >= DREAMING_MAX_SUPERSESSION_REPAIRS) break
        if (memory.superseded_by) {
          const successor = byId.get(memory.superseded_by)
          if (!successor) {
            memory.superseded_by = null
            memory.is_superseded = 'n'
            await write(memory)
            repairs += 1
            act(
              'supersession_repair',
              'done',
              'superseded_by pointed at a memory that no longer exists (explicit delete) — restored this record to current',
              { memoryId: memory.id }
            )
          } else {
            if (memory.is_superseded !== 'y') {
              memory.is_superseded = 'y'
              await write(memory)
              repairs += 1
              act(
                'supersession_repair',
                'done',
                'flag mismatch: superseded_by is set but the superseded flag was off — reconciled to the pointer (the write-order authority)',
                { memoryId: memory.id, supersededBy: memory.superseded_by }
              )
            }
            if (!successor.supersedes?.includes(memory.id)) {
              successor.supersedes = [...(successor.supersedes ?? []), memory.id]
              await write(successor)
              repairs += 1
              act(
                'supersession_repair',
                'done',
                'completed a crashed supersede: the successor now lists this predecessor in its supersedes chain',
                { memoryId: successor.id, predecessorId: memory.id }
              )
            }
          }
        } else if (memory.is_superseded === 'y') {
          memory.is_superseded = 'n'
          await write(memory)
          repairs += 1
          act(
            'supersession_repair',
            'done',
            'flag mismatch: no superseded_by pointer but the superseded flag was on — restored to current (the pointer is the authority)',
            { memoryId: memory.id }
          )
        }

        if (memory.supersedes?.length && repairs < DREAMING_MAX_SUPERSESSION_REPAIRS) {
          const kept: string[] = []
          for (const predecessorId of memory.supersedes) {
            const predecessor = byId.get(predecessorId)
            if (!predecessor) {
              repairs += 1
              act(
                'supersession_repair',
                'done',
                'supersedes listed a memory that no longer exists (explicit delete) — pruned the dangling pointer',
                { memoryId: memory.id, missingPredecessorId: predecessorId }
              )
              continue
            }
            if (predecessor.superseded_by !== memory.id) {
              repairs += 1
              act(
                'supersession_repair',
                'done',
                predecessor.superseded_by
                  ? `predecessor is recorded as superseded by ${predecessor.superseded_by} — pruned this record's stale claim (the pointer is the authority)`
                  : 'completed a crashed unsupersede: the predecessor is current again, so this record no longer claims it',
                { memoryId: memory.id, predecessorId }
              )
              continue
            }
            kept.push(predecessorId)
          }
          if (kept.length !== memory.supersedes.length) {
            if (kept.length === 0) delete memory.supersedes
            else memory.supersedes = kept
            await write(memory)
          }
        }
      }
    } catch (error) {
      act(
        'supersession_repair',
        'failed',
        'supersession scan failed; no repairs were performed',
        {},
        error instanceof Error ? error.message : 'unknown error'
      )
    }
    await flush()

    // ---- Phase 6: consolidation (near-dup merge with model judgment) ----
    try {
      const memories = await listMemories(agentId)
      const candidates = memories
        .filter((memory) => memory.is_superseded !== 'y')
        .slice(0, DREAMING_MAX_CONSOLIDATION_SCAN)
      const clusters = await buildConsolidationClusters(agentId, candidates)

      for (const clusterIds of clusters.slice(0, DREAMING_MAX_CONSOLIDATION_CLUSTERS)) {
        const members = (
          await fetchMemoriesByKeys(clusterIds.map((id) => memoryKey(agentId, id)))
        ).filter((member) => member.is_superseded !== 'y')
        if (members.length < 2) continue

        // SA-105 P0b: a merge cannot silently orphan owned image memories. Dreaming
        // leaves media-bearing clusters intact until a later packet defines an
        // explicit owned-media merge policy.
        if (members.some((member) => (member.media?.length ?? 0) > 0)) {
          act(
            'consolidation_review',
            'skipped',
            'near-duplicate cluster includes owned memory media — left separate because dreaming has no image merge policy',
            { memoryIds: members.map((member) => member.id) }
          )
          continue
        }

        try {
          const listing = members
            .map((member, index) =>
              [
                `MEMORY ${index + 1} (id ${member.id}, lane ${member.lane}, importance ${member.importance}, saved ${member.saved_at}${member.event_at ? `, event ${member.event_at}` : ''}${member.trigger_terms?.length ? `, triggers: ${member.trigger_terms.join(', ')}` : ''}):`,
                member.content
              ].join('\n')
            )
            .join('\n\n')
          const verdictText = await generate(
            `${DREAMING_CONSOLIDATION_PROMPT}\n\n${listing}`,
            1_000
          )
          const verdict = parseDreamingConsolidationVerdict(verdictText)

          if (!verdict.merge) {
            act(
              'consolidation_review',
              'done',
              `near-duplicates reviewed (cosine ≤ ${MEMORY_NEAR_DUPLICATE_MAX_DISTANCE}) and kept separate — ${verdict.reason}`,
              { memoryIds: members.map((member) => member.id) }
            )
            continue
          }

          const merged = verdict.merged ?? ({} as NonNullable<DreamingConsolidationVerdict['merged']>)
          const triggerTerms = merged.trigger_terms?.length
            ? merged.trigger_terms
            : merged.lane === 'stm'
              ? Array.from(new Set(members.flatMap((member) => member.trigger_terms ?? [])))
              : undefined
          const payload = {
            lane: merged.lane,
            content: merged.content,
            ...(merged.gist ? { gist: merged.gist } : {}),
            ...(triggerTerms?.length ? { trigger_terms: triggerTerms } : {}),
            ...(merged.trigger_synonyms?.length
              ? { trigger_synonyms: merged.trigger_synonyms }
              : {}),
            importance: Math.max(...members.map((member) => member.importance))
          }
          const validation = validateMemorySavePayload(payload)
          if (!validation.ok) {
            act(
              'consolidate_merge',
              'failed',
              'the model\'s merged memory failed the shared save contract — cluster left untouched',
              { memoryIds: members.map((member) => member.id) },
              validation.error
            )
            continue
          }

          const memberIds = new Set(members.map((member) => member.id))
          const links = Array.from(
            new Set(members.flatMap((member) => member.links ?? []))
          ).filter((id) => !memberIds.has(id))
          const eventTimes = members
            .map((member) => (member.event_at ? new Date(member.event_at).getTime() : Number.NaN))
            .filter((ts) => Number.isFinite(ts))
          const eventAt =
            eventTimes.length > 0 ? new Date(Math.min(...eventTimes)).toISOString() : null
          const everyExpires = members.every((member) => member.expires_at)
          const expiresAt = everyExpires
            ? new Date(
                Math.max(...members.map((member) => new Date(member.expires_at as string).getTime()))
              ).toISOString()
            : null
          const provenance = dedupeProvenance(
            members.flatMap((member) => member.provenance ?? [])
          )

          const mergedRecord = await createMemory(
            {
              agent_id: agentId,
              user_id: options.userId,
              lane: validation.value.lane,
              content: validation.value.content,
              gist: validation.value.gist,
              trigger_terms: validation.value.trigger_terms,
              importance: validation.value.importance,
              event_at: eventAt,
              expires_at: expiresAt,
              ...(links.length ? { links } : {}),
              provenance
            },
            { embedder }
          )
          await supersedeMemory(agentId, mergedRecord.id, Array.from(memberIds))
          act(
            'consolidate_merge',
            'done',
            `model judged ${members.length} near-duplicates the same fact — ${verdict.reason}; merged with the full provenance union, originals superseded (never deleted)`,
            { mergedId: mergedRecord.id, memoryIds: Array.from(memberIds) }
          )
        } catch (error) {
          if (error instanceof DreamingModelBudgetExhausted) {
            act('consolidate_merge', 'skipped', 'model-call budget reached — remaining clusters consolidate on the next dream', {
              memoryIds: members.map((member) => member.id)
            })
            break
          }
          act(
            'consolidate_merge',
            'failed',
            'consolidation failed for this cluster; every member is untouched',
            { memoryIds: members.map((member) => member.id) },
            error instanceof Error ? error.message : 'unknown error'
          )
        }
      }
    } catch (error) {
      act(
        'consolidate_merge',
        'failed',
        'consolidation scan failed; no merges were attempted',
        {},
        error instanceof Error ? error.message : 'unknown error'
      )
    }
    await flush()

    // ---- Phase 7: era consolidation (window splice-list aging — packet §1.2/7) ----
    for (const session of fixedSessions) {
      const sessionId = session.id
      if (getActiveSessionTurn(sessionId)) {
        act('skip_session', 'skipped', 'live turn in progress — era consolidation waits (DL-104-15)', { sessionId })
        continue
      }
      try {
        const fresh = await redis.getSession(sessionId)
        if (!fresh) continue
        const events = getFixedSessionGraduationState(fresh.metadata ?? null).events
        if (events.length <= DREAMING_ERA_MIN_EVENTS) continue

        const cutoff = now.getTime() - DREAMING_ERA_MIN_AGE_DAYS * 86_400_000
        const batch: FixedSessionGraduationEvent[] = []
        for (const event of events) {
          if (batch.length >= DREAMING_ERA_BATCH_MAX) break
          const createdTs = new Date(event.createdAt).getTime()
          if (!Number.isFinite(createdTs) || createdTs >= cutoff) break
          batch.push(event)
        }
        if (batch.length < 2) continue

        const budgetSettings = await resolveAgentBudgetSettings(options.agent)
        if (!budgetSettings.contextLimit) {
          act('era_consolidation', 'skipped', 'no model context limit resolvable — era summary budget cannot be computed', { sessionId })
          continue
        }

        const gists = batch
          .map(
            (event, index) =>
              `STRETCH ${index + 1} (graduated ${event.createdAt}, ${event.compactedMessageCount} messages):\n${event.summary}`
          )
          .join('\n\n')
        const inputTokens = countTotalTokens([{ role: 'system', content: gists }])
        const budget = resolveCompactSummaryBudget({
          contextLimit: budgetSettings.contextLimit,
          sourceTokenEstimate: inputTokens
        })
        const eraSummary = await generate(
          [
            DREAMING_ERA_PROMPT,
            '',
            'SUMMARY BUDGET:',
            `Aim for roughly ${budget.softTargetTokens.toLocaleString()} tokens; do not exceed about ${budget.hardMaxTokens.toLocaleString()}.`,
            '',
            'GRADUATED STRETCHES TO DISTILL:',
            gists
          ].join('\n'),
          budget.hardMaxTokens
        )

        const messageIds = Array.from(
          new Set(batch.flatMap((event) => event.sourceMessageIds))
        )
        const segments = await fetchMemorySegmentsByIds(
          agentId,
          batch.map((event) => event.segmentId).filter((id): id is string => Boolean(id))
        )
        const firstTimes = segments.map((segment) => new Date(segment.first_message_at).getTime())
        const lastTimes = segments.map((segment) => new Date(segment.last_message_at).getTime())
        const fallbackTimes = batch.map((event) => new Date(event.createdAt).getTime())
        const firstAt = new Date(
          Math.min(...(firstTimes.length ? firstTimes : fallbackTimes))
        ).toISOString()
        const lastAt = new Date(
          Math.max(...(lastTimes.length ? lastTimes : fallbackTimes))
        ).toISOString()
        const tokenCount = segments.reduce((total, segment) => total + segment.token_count, 0)

        // Retry-safe (the writer's reuse pattern): a crashed earlier era pass may have
        // written the segment but died before the swap.
        const existing = (await listMemorySegments(agentId)).find(
          (segment) =>
            segment.session_id === sessionId &&
            segment.graduated_by === 'dreaming' &&
            (segment.episode_id ?? null) === null &&
            segment.message_ids.join(',') === messageIds.join(',')
        )
        const eraSegment =
          existing ??
          (await createMemorySegment(
            {
              agent_id: agentId,
              user_id: options.userId,
              session_id: sessionId,
              episode_id: null,
              message_ids: messageIds,
              summary: eraSummary,
              first_message_at: firstAt,
              last_message_at: lastAt,
              token_count: tokenCount,
              graduated_by: 'dreaming'
            },
            { embedder }
          ))

        const eraEvent: FixedSessionGraduationEvent = {
          id: `grad_${now.getTime()}_${randomIdSuffix()}`,
          createdAt: now.toISOString(),
          source: 'dreaming',
          episodeId: null,
          segmentId: eraSegment.id,
          sourceMessageIds: messageIds,
          compactedMessageCount: messageIds.length,
          summary: eraSegment.summary,
          summaryTokenEstimate: countTotalTokens([
            { role: 'system', content: eraSegment.summary }
          ])
        }
        await swapGraduationEvents(
          sessionId,
          batch.map((event) => event.id),
          eraEvent
        )
        act(
          'era_consolidation',
          'done',
          `distilled ${batch.length} old graduation gists (oldest ${batch[0].createdAt}) into one era summary — the window now carries one splice instead of ${batch.length}; the per-episode segments and originals remain searchable and untouched`,
          { sessionId, eraEventId: eraEvent.id, eraSegmentId: eraSegment.id, replacedEventIds: batch.map((event) => event.id) }
        )
      } catch (error) {
        if (error instanceof DreamingModelBudgetExhausted) {
          act('era_consolidation', 'skipped', 'model-call budget reached — era consolidation resumes on the next dream', { sessionId })
          break
        }
        act(
          'era_consolidation',
          'failed',
          'era consolidation failed for this session; the graduation event list is unchanged',
          { sessionId },
          error instanceof Error ? error.message : 'unknown error'
        )
      }
    }

    // SA-110 P2 (DL-110-06b): the awareness fold is dreaming's final bounded step —
    // dreaming's idle-gap eligibility means provider caches are already expired, so
    // folding here is free. It runs LAST so the snapshot captures everything this
    // run changed (expiry demotions, supersession repairs, consolidation merges).
    try {
      const fold = await foldAwarenessState({ agentId, reason: 'dreaming', now })
      act(
        'awareness_fold',
        fold.changed ? 'done' : 'skipped',
        fold.changed
          ? 'awareness changes since the last fold now compile in the system-prompt block (idle caches were already expired)'
          : 'awareness unchanged since the last fold — nothing to fold'
      )
    } catch (foldError) {
      act(
        'awareness_fold',
        'failed',
        'the awareness fold failed; the system-prompt block keeps compiling the previous snapshot and pending notes stay visible',
        undefined,
        foldError instanceof Error ? foldError.message : 'unknown error'
      )
    }

    record.finished_at = options.now ? now.toISOString() : new Date().toISOString()
    record.counts = countsFromActions(record.actions, modelCalls)
    record.status = record.counts.failures > 0 ? 'completed_with_errors' : 'completed'
    await writeRun(record)
    return record
  } catch (error) {
    record.finished_at = options.now ? now.toISOString() : new Date().toISOString()
    record.counts = countsFromActions(record.actions, modelCalls)
    record.status = 'failed'
    record.error = error instanceof Error ? error.message : 'Dreaming pass failed.'
    try {
      await writeRun(record)
    } catch (writeError) {
      console.error('[Dreaming] Failed to persist failed run record:', writeError)
    }
    return record
  } finally {
    activeDreamRuns.delete(agentId)
  }
}
