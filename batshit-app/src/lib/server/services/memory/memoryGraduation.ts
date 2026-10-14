/**
 * SA-104 P6 — the graduation writer and the nap (DL-104-02 / -07 / -12 / -15 / -16).
 *
 * One writer serves every graduation source: nap step 1 (closed episodes), nap step 3
 * (open-episode narrative compaction with whiteboard extraction), regular-session
 * close/idle graduation, and P7's dreaming. Graduation never destroys anything: the
 * originals stay in their message keys, a `memseg:` record preserves ids + summary +
 * embedding for search, and (Infinite Sessions only) a graduation event on
 * `metadata.fixedSession.graduation` splices the gist into the live window.
 *
 * The nap's relief order is locked (DL-104-07): (1) graduate closed episodes,
 * (2) force-compress stale zips through the existing manual-rezip state,
 * (3) compact the open episode's older narrative WITH whiteboard extraction — each
 * step runs only while the re-estimated window still sits at/over the nap threshold.
 * Manual unzips and active clips are pins; recovery-held messages (trailing
 * failed/interrupted runs) never graduate; the floor-protected recent tail is never
 * eaten. Failures are loud and leave the window untouched (per-write coherence is
 * documented on each step).
 *
 * Deterministic tests inject `generateSummary`, `estimateTokens`, `embedder`, and
 * `now` — live model calls never run in the test lane (P2 seam pattern).
 */

import { redis } from '$lib/server/redis'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import {
  hasTurnStartedAfter,
  isSessionDeleting,
  lastTurnStartOf
} from '$lib/server/services/streamAbortRegistry'
import { resolveCompiledSpeakerView } from '$lib/server/services/compiledSpeakerView'
import type { Message } from '$lib/stores/messages.svelte'
import { countMessageTokens, countTotalTokens } from '$lib/utils/tokenCounter'
import {
  applyContextCompactionToMessages,
  buildCompactionTranscript,
  getContextCompactionState,
  resolveCompactSummaryBudget,
  resolveEffectiveAutoCompactSettings
} from '$lib/utils/contextCompaction'
import {
  applyFixedSessionGraduationToMessages,
  getFixedSessionGraduationState,
  getGraduatedMessageIds,
  FIXED_SESSION_NAP_HISTORY_LIMIT,
  type FixedSessionGraduationEvent,
  type FixedSessionGraduationSource,
  type FixedSessionNapRecord
} from '$lib/utils/fixedSessionGraduation'
import { isFixedSession } from '$lib/utils/fixedSession'
import {
  resolveAgentMemoryEnabled,
  resolveEffectiveMemoryWindow,
  resolveMemoryIdleGapHours,
  resolveMemoryWindowSettings,
  type EffectiveMemoryWindow
} from '$lib/utils/memoryControl'
import { isMessageProtectedFromManualTrim } from '$lib/utils/tokenPanel'
import { calculateRecoveryHoldByIndex } from '$lib/utils/zipMessageAge'
import {
  estimateCurrentContextTokens,
  loadContextProtections,
  normalizeMessages,
  resolveAgentBudgetSettings,
  type ContextProtections
} from '$lib/server/services/contextTokenPreview'
import {
  generateModelSummary,
  type SummaryModelChoice
} from '$lib/server/services/summaryGeneration'
import {
  createMemorySegment,
  deleteMemorySegment,
  listMemorySegments
} from './memoryStore'
import { createMemoryEmbedderAsync, type MemoryEmbedder } from './memoryEmbedder'
import { getMemoryConfig } from './memoryIndex'
import { foldAwarenessState } from './memoryRecall'
import {
  EpisodeNotOpenError,
  EpisodeWhiteboardChangedError,
  getOpenEpisode,
  listEpisodes,
  markEpisodeGraduated,
  readWhiteboard,
  updateEpisodeWhiteboard,
  whiteboardAuthor,
  type EpisodeRecord
} from './memoryEpisodes'

type AgentRecord = Record<string, any>

/** Injectable summary seam: returns the summary text for a prepared prompt. */
export type SummaryGenerator = (prompt: string, hardMaxTokens: number) => Promise<string>

const MIN_GRADUATION_MESSAGES = 4
const NAP_STEP3_MIN_MESSAGES = 4

export const GRADUATION_SUMMARY_PROMPT = [
  'You are graduating a completed stretch of a Batshit conversation into the agent\'s long-term memory.',
  '',
  'Write a dense, factual summary of the conversation segment below. Preserve the facts, decisions, user preferences, task outcomes, names, dates, numbers, file paths, and unresolved items that the agent may need to recall later. This summary becomes both the searchable memory of this stretch and the gist that remains in the live conversation window, so it must stand on its own.',
  '',
  'Treat Tool Results Summary / Tool Notes lines as high-signal notes; keep the ones with lasting value.',
  'Be explicit about uncertainty. Never invent results or hidden state.',
  'Write plain prose with short labeled sections only when useful. No preamble, no closing remarks — return only the summary.'
].join('\n')

export const NAP_COMPACTION_PROMPT = [
  'You are performing a Batshit "nap": mid-conversation memory relief for a long-running session. The older part of the CURRENT open work episode below will be replaced in the live window by your summary, while the originals move to searchable long-term memory. The recent conversation stays fully live.',
  '',
  'Return EXACTLY two sections with these exact headers, each on its own line:',
  '',
  'SUMMARY:',
  'A dense, factual summary of the conversation segment below — facts, decisions, user preferences, task state, constraints, blockers, file paths, commands, results, and next steps that still matter. It becomes the searchable memory of this stretch and the gist left in the window.',
  '',
  'WHITEBOARD:',
  'The complete refreshed episode whiteboard: the load-bearing WORKING FACTS the ongoing work still depends on right now (current goal, key decisions, live state, open items, exact values). Start from the current whiteboard when one is provided, keep what still matters, drop what lapsed, add what the summarized stretch established. Compact bullet lines. This stays in front of the agent until the episode closes.',
  '',
  'Be explicit about uncertainty. Never invent results or hidden state.'
].join('\n')

/**
 * 2026-09-19 (Josh): the agent owns its whiteboard. When the agent wrote the board, the nap
 * asks the summary model for the SUMMARY only and shows the board as read-only context, so
 * the summary does not repeat what the agent already keeps in front of itself.
 */
export const NAP_COMPACTION_SUMMARY_ONLY_PROMPT = [
  'You are performing a Batshit "nap": mid-conversation memory relief for a long-running session. The older part of the CURRENT open work episode below will be replaced in the live window by your summary, while the originals move to searchable long-term memory. The recent conversation stays fully live.',
  '',
  'Return EXACTLY one section with this exact header on its own line:',
  '',
  'SUMMARY:',
  'A dense, factual summary of the conversation segment below — facts, decisions, user preferences, task state, constraints, blockers, file paths, commands, results, and next steps that still matter. It becomes the searchable memory of this stretch and the gist left in the window.',
  '',
  'The agent keeps its own episode whiteboard (shown below as context). It is the agent\'s to maintain and is NOT part of your output; do not return a WHITEBOARD section.',
  '',
  'Be explicit about uncertainty. Never invent results or hidden state.'
].join('\n')

/**
 * The explicit summary-model choice (story: "configured model, cheap default,
 * explicit"). 'inherit' (default) resolves the agent's effective Auto Compact model
 * choice — the AgentAutoCompactSettings precedent — so agents whose compaction
 * already works get graduation working with zero extra setup.
 */
export function resolveMemorySummaryModelChoice(
  agent: AgentRecord,
  globalAutoCompactSettings: unknown
): SummaryModelChoice {
  const window = resolveMemoryWindowSettings(agent)
  if (window.summaryModelMode === 'current') {
    return { modelMode: 'current', modelPresetId: null }
  }
  if (window.summaryModelMode === 'preset') {
    if (!window.summaryModelPresetId) {
      throw new Error(
        'Memory summary model is set to "preset" but no preset is selected. Pick one in Agent Settings → Memory, or switch back to inherit.'
      )
    }
    return { modelMode: 'preset', modelPresetId: window.summaryModelPresetId }
  }
  const effective = resolveEffectiveAutoCompactSettings({
    global: globalAutoCompactSettings,
    agent: agent.auto_compact_settings
  })
  return { modelMode: effective.modelMode, modelPresetId: effective.modelPresetId }
}

/** Default generator: the shared compact-generation ladder with the resolved choice. */
export function buildDefaultSummaryGenerator(params: {
  userId: string
  agent: AgentRecord
  choice: SummaryModelChoice
}): SummaryGenerator {
  return async (prompt, hardMaxTokens) => {
    const result = await generateModelSummary({
      userId: params.userId,
      agent: params.agent as never,
      choice: params.choice,
      prompt,
      summaryHardMaxTokens: hardMaxTokens
    })
    return result.summary
  }
}

/**
 * BL-549 (N1, N2): why a nap, or dreaming in one chat, ended before its next writing step. A
 * turn started in the chat since the job began (`turn_started`: the user's message goes first),
 * or the chat is being deleted or is gone (`chat_deleted`, BL-623: nothing more is written).
 */
export type BackgroundJobEndedEarlyReason = 'turn_started' | 'chat_deleted'

/** BL-549 (N2): what a nap record and a dreaming action say when a turn ended the job early. */
export const ENDED_EARLY_MESSAGE_ARRIVED = 'ended early: a message arrived'

/** The look a background job asks before each step that writes. */
export type BackgroundJobLook = () => Promise<BackgroundJobEndedEarlyReason | null>

/**
 * BL-549 (N1): the look a nap (or dreaming, in one chat) asks before each step that writes. It
 * reads the chat's last turn start NOW, when the job begins, so call it before the job's first
 * await: the nap route's "no turn running" check and this read are then one synchronous step,
 * and no turn can start between them unseen. The look answers `chat_deleted` while the chat is
 * being deleted or once its record is gone (a delete's sweep also forgets the chat's turn trace,
 * so this is asked first), then `turn_started` when a turn of this chat started since
 * (`hasTurnStartedAfter`, the registry of this process: a turn that started AND ended since
 * counts too). A job takes no lock, so a look is not atomic with the write after it: a write that
 * can still meet a turn is made safe on its own (by path, N4; conditional, N3).
 */
export function createBackgroundJobLook(sessionId: string): BackgroundJobLook {
  const seenTurnId = lastTurnStartOf(sessionId)
  return async () => {
    if (isSessionDeleting(sessionId)) return 'chat_deleted'
    if (!(await redis.exists(`session:${sessionId}`))) return 'chat_deleted'
    if (isSessionDeleting(sessionId)) return 'chat_deleted'
    if (hasTurnStartedAfter(sessionId, seenTurnId)) return 'turn_started'
    return null
  }
}

function randomIdSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

function messageTimestampMs(message: Message): number {
  const raw = message.created_at || message.timestamp
  const parsed = raw ? new Date(raw).getTime() : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function isWindowSummaryMessage(message: Message): boolean {
  return Boolean(
    message.metadata?.contextCompactSummary ||
      message.metadata?.fixedSessionGraduation ||
      message.metadata?.manualContextTrim
  )
}

async function loadOrderedSessionMessages(sessionId: string): Promise<Message[]> {
  const raw = await redis.getAllSessionMessages(sessionId)
  return normalizeMessages(raw)
}

/**
 * The floor-protected tail: ids of live-window messages inside the most recent
 * `floorTokens` of context. Graduation and nap compaction never eat into these
 * (DL-104-07: the floor is guaranteed).
 */
export function computeFloorProtectedIds(
  liveWindowMessages: Message[],
  floorTokens: number
): Set<string> {
  const protectedIds = new Set<string>()
  let accumulated = 0
  for (let index = liveWindowMessages.length - 1; index >= 0; index -= 1) {
    const message = liveWindowMessages[index]
    protectedIds.add(message.id)
    accumulated += countMessageTokens(message)
    if (accumulated >= floorTokens) break
  }
  return protectedIds
}

function buildLiveWindow(messages: Message[], session: Record<string, any> | null): Message[] {
  const compacted = applyContextCompactionToMessages(
    messages,
    getContextCompactionState(session?.metadata ?? null).events
  )
  return applyFixedSessionGraduationToMessages(compacted, session)
}

interface GraduationWriteResult {
  ok: true
  segmentId: string
  eventId: string
  summary: string
  summaryTokenEstimate: number
  /** `false` when this call's `createMemorySegment` made a brand-new segment record. */
  reused: boolean
}

/**
 * BL-751: `createMemorySegment` embeds before it writes, so a chat deleted during that call is
 * still there when the segment write lands, but gone by the time the window event write runs
 * right after. The event write then answers `missing`; the caller ends early as `chat_deleted`
 * instead of failing, and the segment this call just created (never wired into any window) is
 * removed rather than left as an orphan with no event.
 */
interface GraduationWriteChatDeleted {
  ok: false
  reason: 'chat_deleted'
}

/**
 * The atomic-ish write ladder for one graduated range (packet doc §1.4): memseg first
 * (reusing an existing same-range segment so retries never duplicate summaries), then
 * the metadata event (the window exclusion + splice). Callers mark episodes graduated
 * AFTER this returns. Every intermediate failure leaves a coherent whole.
 */
async function writeGraduationForMessages(options: {
  userId: string
  agentId: string
  sessionId: string
  episodeId: string | null
  source: FixedSessionGraduationSource
  sourceMessages: Message[]
  summary: string
  topics?: string[]
  embedder?: MemoryEmbedder
  /** Regular sessions write no window event (DL-104-12) — memseg only. */
  writeWindowEvent: boolean
  now: Date
}): Promise<GraduationWriteResult | GraduationWriteChatDeleted> {
  const sourceIds = options.sourceMessages.map((message) => message.id)
  const first = options.sourceMessages[0]
  const last = options.sourceMessages[options.sourceMessages.length - 1]
  const tokenCount = options.sourceMessages.reduce(
    (total, message) => total + countMessageTokens(message),
    0
  )

  // Retry-safe: an earlier attempt may have written the segment but died before the
  // event. Reuse a same-range segment for this episode/source instead of duplicating.
  const existingSegments = await listMemorySegments(options.agentId)
  const sourceKey = sourceIds.join(',')
  const reusable = existingSegments.find(
    (segment) =>
      segment.session_id === options.sessionId &&
      (segment.episode_id ?? null) === options.episodeId &&
      segment.message_ids.join(',') === sourceKey
  )

  const segment =
    reusable ??
    (await createMemorySegment(
      {
        agent_id: options.agentId,
        user_id: options.userId,
        session_id: options.sessionId,
        episode_id: options.episodeId,
        message_ids: sourceIds,
        summary: options.summary,
        topics: options.topics,
        first_message_at: first.created_at || first.timestamp,
        last_message_at: last.created_at || last.timestamp,
        token_count: tokenCount,
        graduated_by:
          options.source === 'session_close'
            ? 'session_close'
            : options.source === 'idle'
              ? 'idle'
              : options.source === 'dreaming'
                ? 'dreaming'
                : 'nap'
      },
      options.embedder ? { embedder: options.embedder } : undefined
    ))

  const summaryTokenEstimate = countTotalTokens([{ role: 'system', content: segment.summary }])
  const event: FixedSessionGraduationEvent = {
    id: `grad_${options.now.getTime()}_${randomIdSuffix()}`,
    createdAt: options.now.toISOString(),
    source: options.source,
    episodeId: options.episodeId,
    segmentId: segment.id,
    sourceMessageIds: sourceIds,
    compactedMessageCount: sourceIds.length,
    summary: segment.summary,
    summaryTokenEstimate
  }

  if (options.writeWindowEvent) {
    const written = await appendGraduationEvent(options.sessionId, event)
    if (written === 'chat_deleted') {
      // BL-751: only a segment THIS call just created is an orphan — a reused one was already
      // linked (or is owned by whatever attempt reused it) and is left alone.
      if (!reusable) await deleteMemorySegment(options.agentId, segment.id).catch(() => {})
      return { ok: false, reason: 'chat_deleted' }
    }
  }

  return {
    ok: true,
    segmentId: segment.id,
    eventId: event.id,
    summary: segment.summary,
    summaryTokenEstimate,
    reused: Boolean(reusable)
  }
}

/**
 * BL-549 (N4): the event is added at its own path, in one step inside Redis. It used to read the
 * chat and write that copy's whole metadata back, erasing what another writer (a turn's Compact,
 * a second graduation) added in between. BL-751: a chat gone by the time this runs answers
 * `chat_deleted`, not an error — the segment it belonged to embedded before this write and can
 * still find the chat deleted underneath it.
 */
async function appendGraduationEvent(
  sessionId: string,
  event: FixedSessionGraduationEvent
): Promise<'ok' | 'chat_deleted'> {
  const written = await redis.appendFixedSessionGraduationEvent(sessionId, { ...event })
  if (written === 'missing') return 'chat_deleted'
  if (written === 'not_fixed') {
    throw new Error(`Session ${sessionId} is not an Infinite Session; graduation events require one.`)
  }
  return 'ok'
}

/**
 * SA-104 P7 — era consolidation's atomic event swap (packet doc §1.2 phase 7): replace
 * a set of old graduation events with ONE coarser era event, inserted at the position
 * of the first removed event. Refuses when any removed id is no longer present (a
 * concurrent write changed the list — the caller logs the skip and a later pass
 * retries). The underlying memsegs and original messages are untouched by design
 * (DL-104-02: era consolidation thins the window's splice list, never the archive).
 */
/**
 * BL-751: `chat_deleted` when the chat went away underneath the swap (the era memseg's own embed
 * call is the last gap left open before this write) — the caller ends early instead of failing,
 * and removes the era memseg it just created rather than leave an orphan with no event.
 */
export async function swapGraduationEvents(
  sessionId: string,
  removeEventIds: string[],
  eraEvent: FixedSessionGraduationEvent
): Promise<'ok' | 'chat_deleted'> {
  if (removeEventIds.length === 0) {
    throw new Error('swapGraduationEvents requires at least one event id to replace.')
  }
  // BL-549 (N4): one step inside Redis, at the event list's own path, only while every replaced
  // event is still stored. Events and blocks another writer added meanwhile stay.
  const swapped = await redis.swapFixedSessionGraduationEvents(sessionId, removeEventIds, { ...eraEvent })
  if (swapped.ok) return 'ok'
  if (swapped.reason === 'changed') {
    throw new Error(
      `Era consolidation aborted: graduation event(s) ${swapped.missing.join(', ')} changed underneath the pass.`
    )
  }
  if (swapped.reason === 'missing') return 'chat_deleted'
  throw new Error(`Session ${sessionId} is not an Infinite Session; graduation events require one.`)
}

/**
 * BL-549 (N4): the nap's record is added at its own path (the last 20 kept), in one step inside
 * Redis. Answers the chat's metadata as stored after the write, or `null` for a chat that is gone.
 */
async function appendNapRecord(
  sessionId: string,
  record: FixedSessionNapRecord
): Promise<Record<string, any> | null> {
  return redis.appendFixedSessionNapRecord(
    sessionId,
    { ...record },
    FIXED_SESSION_NAP_HISTORY_LIMIT
  )
}

// ---------------------------------------------------------------------------
// Nap step 3 section parsing (loud on failure — DL-104-05 posture)
// ---------------------------------------------------------------------------

const SECTION_HEADER_REGEX = /^\s*#{0,4}\s*(SUMMARY|WHITEBOARD)\s*:?\s*$/im

export function parseNapCompactionSections(
  text: string,
  options: { whiteboard?: boolean } = {}
): { summary: string; whiteboard: string | null } {
  // `whiteboard: false` is the summary-only call made when the agent wrote the board: only
  // SUMMARY is required, and a WHITEBOARD section the model returns anyway is dropped.
  const expectWhiteboard = options.whiteboard !== false
  const lines = text.split('\n')
  let current: 'summary' | 'whiteboard' | null = null
  const buckets: Record<'summary' | 'whiteboard', string[]> = { summary: [], whiteboard: [] }
  for (const line of lines) {
    const match = SECTION_HEADER_REGEX.exec(line)
    SECTION_HEADER_REGEX.lastIndex = 0
    if (match) {
      current = match[1].toLowerCase() as 'summary' | 'whiteboard'
      continue
    }
    // Tolerate inline "SUMMARY: text" openings.
    const inline = /^\s*#{0,4}\s*(SUMMARY|WHITEBOARD)\s*:\s*(.+)$/i.exec(line)
    if (inline) {
      current = inline[1].toLowerCase() as 'summary' | 'whiteboard'
      buckets[current].push(inline[2])
      continue
    }
    if (current) buckets[current].push(line)
  }
  const summary = buckets.summary.join('\n').trim()
  const whiteboard = buckets.whiteboard.join('\n').trim()
  if (!expectWhiteboard) {
    if (!summary) {
      throw new Error(
        'Nap compaction model output was missing the required SUMMARY section; the window was left untouched.'
      )
    }
    return { summary, whiteboard: null }
  }
  if (!summary || !whiteboard) {
    throw new Error(
      'Nap compaction model output was missing the required SUMMARY/WHITEBOARD sections; the window was left untouched.'
    )
  }
  return { summary, whiteboard }
}

// ---------------------------------------------------------------------------
// Episode source selection
// ---------------------------------------------------------------------------

interface EpisodeSourceSelection {
  sourceMessages: Message[]
  excludedProtectedCount: number
  excludedRecoveryHoldCount: number
  intersectsFloor: boolean
}

function selectEpisodeSourceMessages(options: {
  messages: Message[]
  episode: EpisodeRecord
  graduatedIds: Set<string>
  protections: ContextProtections
  recoveryHoldIds: Set<string>
  floorProtectedIds: Set<string>
}): EpisodeSourceSelection {
  const boundaryTs = options.episode.closed_at
    ? new Date(options.episode.closed_at).getTime()
    : Number.NaN
  if (!Number.isFinite(boundaryTs)) {
    return {
      sourceMessages: [],
      excludedProtectedCount: 0,
      excludedRecoveryHoldCount: 0,
      intersectsFloor: false
    }
  }

  const sourceMessages: Message[] = []
  let excludedProtectedCount = 0
  let excludedRecoveryHoldCount = 0
  let intersectsFloor = false
  for (const message of options.messages) {
    if (messageTimestampMs(message) > boundaryTs) continue
    if (options.graduatedIds.has(message.id)) continue
    if (isWindowSummaryMessage(message)) continue
    if (options.floorProtectedIds.has(message.id)) {
      intersectsFloor = true
      continue
    }
    if (isMessageProtectedFromManualTrim(message, options.protections)) {
      excludedProtectedCount += 1
      continue
    }
    if (options.recoveryHoldIds.has(message.id)) {
      excludedRecoveryHoldCount += 1
      continue
    }
    sourceMessages.push(message)
  }

  return { sourceMessages, excludedProtectedCount, excludedRecoveryHoldCount, intersectsFloor }
}

/**
 * BL-224: every graduation transcript is read for the agent whose memory it becomes, with the
 * compiler's speaker view: that agent is `<assistant>`, any other agent in the segment is named.
 */
async function buildAgentTranscript(agentId: string, messages: Message[]): Promise<string> {
  const speakers = await resolveCompiledSpeakerView({ messages, selfAgentId: agentId })
  return buildCompactionTranscript(messages, speakers)
}

async function buildEpisodeTranscript(
  agentId: string,
  episode: EpisodeRecord,
  sourceMessages: Message[]
): Promise<string> {
  const whiteboardBlock = episode.whiteboard?.content?.trim()
    ? `EPISODE WHITEBOARD AT CLOSE (working facts the agent kept in front of itself):\n${episode.whiteboard.content.trim()}\n\n`
    : ''
  return `${whiteboardBlock}${await buildAgentTranscript(agentId, sourceMessages)}`
}

// ---------------------------------------------------------------------------
// Closed-episode graduation — shared by nap step 1 and dreaming phase 1 (P7)
// ---------------------------------------------------------------------------

export interface ClosedEpisodeGraduationResult {
  /** One entry per graduated episode; segmentId is null on the mark-only recovery path. */
  graduated: Array<{ episodeId: string; segmentId: string | null }>
  skippedEpisodes: Array<{ episodeId: string; reason: string }>
  /** BL-549 (N2): set when the look stopped the pass before an episode's write. */
  endedEarly?: BackgroundJobEndedEarlyReason
}

/**
 * Graduate every closed episode of an Infinite Session (oldest first) through the
 * retry-safe memseg → event → mark ladder, honoring the floor-protected tail, pins
 * (manual unzips / active clips), and recovery holds. Extracted verbatim from the
 * nap's step 1 in P7 so dreaming reuses the same proven selection and write order
 * (p7 packet doc §1.2) — the nap passes `source: 'nap'`, dreaming `'dreaming'`.
 */
export async function graduateClosedEpisodesForSession(options: {
  userId: string
  agentId: string
  sessionId: string
  source: 'nap' | 'dreaming'
  window: EffectiveMemoryWindow
  messages: Message[]
  protections: ContextProtections
  recoveryHoldIds: Set<string>
  generateSummary: SummaryGenerator
  embedder?: MemoryEmbedder
  /** Nap-only lazy setup: resolve before an eligible summary, then look again. */
  resolveEmbedder?: () => Promise<MemoryEmbedder>
  now: Date
  /** Optional per-pass bound (dreaming); the nap graduates every closed episode. */
  maxEpisodes?: number
  /**
   * BL-549 (N1): asked before each episode's writes (its summary call, then its memseg, event
   * and mark). An answer ends the pass: episodes already graduated stay, no other one starts.
   */
  look?: BackgroundJobLook
}): Promise<ClosedEpisodeGraduationResult> {
  const { sessionId, window, messages, protections, recoveryHoldIds, now } = options
  const graduated: Array<{ episodeId: string; segmentId: string | null }> = []
  const skippedEpisodes: Array<{ episodeId: string; reason: string }> = []

  const episodes = await listEpisodes(sessionId)
  const closedEpisodes = episodes
    .filter((episode) => episode.state === 'closed')
    .sort((a, b) => new Date(a.closed_at ?? 0).getTime() - new Date(b.closed_at ?? 0).getTime())
  const limited =
    typeof options.maxEpisodes === 'number'
      ? closedEpisodes.slice(0, Math.max(0, options.maxEpisodes))
      : closedEpisodes

  for (const episode of limited) {
    const stopBefore = options.look ? await options.look() : null
    if (stopBefore) return { graduated, skippedEpisodes, endedEarly: stopBefore }
    const currentSession = await redis.getSession(sessionId)
    const graduatedIds = new Set(
      getGraduatedMessageIds(
        getFixedSessionGraduationState(currentSession?.metadata ?? null).events
      )
    )
    const liveWindow = buildLiveWindow(messages, currentSession)
    const floorProtectedIds = computeFloorProtectedIds(liveWindow, window.floorTokens)
    const selection = selectEpisodeSourceMessages({
      messages,
      episode,
      graduatedIds,
      protections,
      recoveryHoldIds,
      floorProtectedIds
    })

    if (selection.intersectsFloor) {
      skippedEpisodes.push({
        episodeId: episode.id,
        reason: 'floor-protected recent conversation'
      })
      continue
    }
    if (selection.sourceMessages.length === 0) {
      // Recovery path: an earlier run may have written the event but died before
      // marking the episode. Finish the mark; otherwise there is nothing to do.
      const alreadyExcluded = getFixedSessionGraduationState(
        currentSession?.metadata ?? null
      ).events.some((event) => event.episodeId === episode.id)
      if (alreadyExcluded) {
        await markEpisodeGraduated(sessionId, episode.id)
        graduated.push({ episodeId: episode.id, segmentId: null })
      } else {
        skippedEpisodes.push({
          episodeId: episode.id,
          reason:
            selection.excludedRecoveryHoldCount > 0
              ? 'recovery-held in-flight work'
              : 'no graduatable messages'
        })
      }
      continue
    }

    const sourceTokens = selection.sourceMessages.reduce(
      (total, message) => total + countMessageTokens(message),
      0
    )
    const budget = resolveCompactSummaryBudget({
      contextLimit: window.contextLimit,
      sourceTokenEstimate: sourceTokens
    })
    const prompt = [
      GRADUATION_SUMMARY_PROMPT,
      '',
      'SUMMARY BUDGET:',
      `Aim for roughly ${budget.softTargetTokens.toLocaleString()} tokens; do not exceed about ${budget.hardMaxTokens.toLocaleString()}.`,
      '',
      'CONVERSATION SEGMENT TO GRADUATE:',
      await buildEpisodeTranscript(options.agentId, episode, selection.sourceMessages)
    ].join('\n')
    let embedder = options.embedder
    if (options.resolveEmbedder) {
      try {
        embedder = await options.resolveEmbedder()
      } catch (error) {
        const stop = options.look ? await options.look() : null
        if (stop) return { graduated, skippedEpisodes, endedEarly: stop }
        throw error
      }
      const stopAfterSetup = options.look ? await options.look() : null
      if (stopAfterSetup) return { graduated, skippedEpisodes, endedEarly: stopAfterSetup }
    }
    const summary = await options.generateSummary(prompt, budget.hardMaxTokens)
    // The summary call is the long wait: look again before this episode's writes. BL-549 option A
    // (Faye, 2026-09-27): a closed episode does not change when a message arrives, so a summary
    // whose call finished is written when a turn started (by path, no lock a turn waits for),
    // and the pass ends after it. A deleted chat gets nothing.
    const stopAfterCall = options.look ? await options.look() : null
    if (stopAfterCall === 'chat_deleted') {
      return { graduated, skippedEpisodes, endedEarly: stopAfterCall }
    }

    const written = await writeGraduationForMessages({
      userId: options.userId,
      agentId: options.agentId,
      sessionId,
      episodeId: episode.id,
      source: options.source,
      sourceMessages: selection.sourceMessages,
      summary,
      embedder,
      writeWindowEvent: true,
      now
    })
    // BL-751: the chat went away between the summary call above and the event write inside
    // `writeGraduationForMessages` (its embed call is the last gap left open). No episode mark:
    // the chat's records are gone.
    if (!written.ok) return { graduated, skippedEpisodes, endedEarly: 'chat_deleted' }
    await markEpisodeGraduated(sessionId, episode.id)
    graduated.push({ episodeId: episode.id, segmentId: written.segmentId })
    if (stopAfterCall) return { graduated, skippedEpisodes, endedEarly: stopAfterCall }
  }

  return { graduated, skippedEpisodes }
}

// ---------------------------------------------------------------------------
// The nap (DL-104-07 / DL-104-15)
// ---------------------------------------------------------------------------

export interface FixedSessionNapOutcome {
  /**
   * `ended_early` (BL-549 N2): a turn started in the chat, or the chat was deleted, before one of
   * the nap's writing steps; `endedEarly` says which. The finished steps stay.
   */
  status: 'completed' | 'not_needed' | 'failed' | 'ended_early'
  endedEarly?: BackgroundJobEndedEarlyReason
  record: FixedSessionNapRecord | null
  /** Fresh session metadata after the nap's writes (for the client store). */
  metadata: Record<string, any> | null
  window: EffectiveMemoryWindow | null
  tokensBefore: number | null
  tokensAfter: number | null
  error?: string
}

export async function runFixedSessionNap(options: {
  userId: string
  agent: AgentRecord
  sessionId: string
  trigger: 'threshold' | 'manual'
  eventFetch: typeof fetch
  /** Test seams (P2 pattern): summary generator, token estimator, embedder, clock. */
  generateSummary?: SummaryGenerator
  estimateTokens?: () => Promise<number>
  embedder?: MemoryEmbedder
  now?: Date
}): Promise<FixedSessionNapOutcome> {
  const now = options.now ?? new Date()
  const sessionId = options.sessionId
  // BL-549 (N1): read the chat's last turn start before the first await, in the same synchronous
  // step as the route's "no turn running" check.
  const look = createBackgroundJobLook(sessionId)
  const agentId = String(options.agent?.id ?? '')
  if (!agentId) throw new Error('Nap requires an agent id.')
  if (!resolveAgentMemoryEnabled(options.agent)) {
    throw new Error('Naps require agent memory to be enabled.')
  }

  const session = await redis.getSession(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found.`)
  if (!isFixedSession(session)) throw new Error('Naps only run in Infinite Sessions.')

  const windowSettings = resolveMemoryWindowSettings(options.agent)
  const budgetSettings = await resolveAgentBudgetSettings(options.agent, sessionId)
  const window = resolveEffectiveMemoryWindow(windowSettings, budgetSettings.contextLimit)
  if (!window) {
    throw new Error(
      'Batshit could not resolve a model context limit for this agent, so the nap threshold cannot be computed. Set a model preset with a known context window.'
    )
  }

  const estimate =
    options.estimateTokens ??
    (async () => {
      const result = await estimateCurrentContextTokens({
        sessionId,
        messages: await loadOrderedSessionMessages(sessionId),
        agent: options.agent,
        userId: options.userId,
        eventFetch: options.eventFetch
      })
      return result.tokens
    })

  const tokensBefore = await estimate()
  if (options.trigger === 'threshold' && tokensBefore < window.napAtTokens) {
    return {
      status: 'not_needed',
      record: null,
      metadata: null,
      window,
      tokensBefore,
      tokensAfter: tokensBefore
    }
  }

  let generateSummary = options.generateSummary
  if (!generateSummary) {
    const userSettings = await redis.getUserSettings(options.userId).catch(() => null)
    const summaryChoice = resolveMemorySummaryModelChoice(
      options.agent,
      userSettings?.global_auto_compact_settings
    )
    generateSummary = buildDefaultSummaryGenerator({
      userId: options.userId,
      agent: options.agent,
      choice: summaryChoice
    })
  }

  const napId = `nap_${now.getTime()}_${randomIdSuffix()}`
  const graduatedEpisodeIds: string[] = []
  const segmentIds: string[] = []
  const skippedEpisodes: Array<{ episodeId: string; reason: string }> = []
  let rezippedZipCount = 0
  let compaction: FixedSessionNapRecord['compaction'] = null

  const finish = async (
    status: 'completed' | 'failed' | 'ended_early',
    tokensAfter: number | null,
    error?: string
  ): Promise<FixedSessionNapOutcome> => {
    // SA-110 P2 (DL-110-06a): the awareness fold rides every nap that actually ran
    // — the nap already resets the provider cache (or runs between turns anyway),
    // so the fold is free here. A failed fold never fails the nap: the SP keeps
    // compiling the previous snapshot and the pending notes stay honest.
    // BL-549 (N2): a nap that a message ended early starts no further step, the fold included;
    // the next nap folds.
    let awarenessFold: string
    if (status === 'ended_early') {
      awarenessFold = 'skipped'
    } else {
      try {
        const fold = await foldAwarenessState({ agentId, reason: 'nap', now })
        awarenessFold = fold.changed ? 'folded' : 'unchanged'
      } catch (foldError) {
        awarenessFold = `failed: ${foldError instanceof Error ? foldError.message : 'unknown error'}`
        console.error('[memoryGraduation] Awareness fold during the nap failed:', foldError)
      }
    }
    const record: FixedSessionNapRecord = {
      id: napId,
      at: now.toISOString(),
      trigger: options.trigger,
      status,
      tokensBefore,
      tokensAfter,
      napAtTokens: window.napAtTokens,
      graduatedEpisodeIds,
      segmentIds,
      skippedEpisodes,
      rezippedZipCount,
      compaction,
      awarenessFold,
      // Both facts (option A): a message ended it, and how many closed episodes it wrote.
      ...(status === 'ended_early'
        ? {
            endedEarly: `${ENDED_EARLY_MESSAGE_ARRIVED}; ${graduatedEpisodeIds.length} closed episode${graduatedEpisodeIds.length === 1 ? '' : 's'} written`
          }
        : {}),
      ...(error ? { error } : {})
    }
    const metadata = await appendNapRecord(sessionId, record)
    return {
      status,
      ...(status === 'ended_early' ? { endedEarly: 'turn_started' as const } : {}),
      record,
      metadata,
      window,
      tokensBefore,
      tokensAfter,
      ...(error ? { error } : {})
    }
  }

  // BL-549 (N2): a turn ends the nap with its record (the finished steps stay); a deleted chat
  // ends it with no further write at all (BL-623): no record, no fold.
  const endEarly = async (
    reason: BackgroundJobEndedEarlyReason,
    tokensAfter: number | null
  ): Promise<FixedSessionNapOutcome> => {
    if (reason === 'turn_started') return finish('ended_early', tokensAfter)
    return {
      status: 'ended_early',
      endedEarly: 'chat_deleted',
      record: null,
      metadata: null,
      window,
      tokensBefore,
      tokensAfter
    }
  }

  try {
    // BL-436: one embedder for every segment this nap writes, built for the signed-in user as
    // dreaming builds it. A Model Manager preset on a local runtime, or an API key saved in
    // Settings, resolves only with a user; the store's no-user default failed every such nap.
    // BL-790: step 2 needs no embedder. Resolve only before an eligible step-1/3 summary,
    // still before spending its model call, and reuse the exact instance for every write.
    let embedderPromise: Promise<MemoryEmbedder> | undefined
    const resolveEmbedder = () => {
      embedderPromise ??= options.embedder
        ? Promise.resolve(options.embedder)
        : getMemoryConfig().then((config) =>
            createMemoryEmbedderAsync(config.embedding, { userId: options.userId })
          )
      return embedderPromise
    }
    const messages = await loadOrderedSessionMessages(sessionId)
    const protections = await loadContextProtections(sessionId)
    const recoveryHold = calculateRecoveryHoldByIndex(messages)
    const recoveryHoldIds = new Set(
      messages.filter((_, index) => recoveryHold[index]).map((message) => message.id)
    )

    // ---- Step 1: graduate closed episodes (all of them — they are done) ----
    const stepOne = await graduateClosedEpisodesForSession({
      userId: options.userId,
      agentId,
      sessionId,
      source: 'nap',
      window,
      messages,
      protections,
      recoveryHoldIds,
      generateSummary,
      resolveEmbedder,
      now,
      look
    })
    graduatedEpisodeIds.push(...stepOne.graduated.map((entry) => entry.episodeId))
    segmentIds.push(
      ...stepOne.graduated.flatMap((entry) => (entry.segmentId ? [entry.segmentId] : []))
    )
    skippedEpisodes.push(...stepOne.skippedEpisodes)
    if (stepOne.endedEarly) return await endEarly(stepOne.endedEarly, null)

    let tokensAfter = await estimate()
    if (tokensAfter < window.napAtTokens) {
      return await finish('completed', tokensAfter)
    }

    // ---- Step 2: force-compress stale zips (existing manual-rezip state) ----
    {
      const currentSession = await redis.getSession(sessionId)
      const liveWindow = buildLiveWindow(messages, currentSession)
      const floorProtectedIds = computeFloorProtectedIds(liveWindow, window.floorTokens)
      // The held set is read and the markers written under the chat's zip state lock (SA-129
      // P2b, BL-352), so a Hold the user clicks meanwhile is never compressed over.
      const stepTwoStop = await withZipStateLock(sessionId, async () => {
        // BL-549 (N1) / BL-623: the look comes inside the lock, right before the writes. A delete
        // that landed during the estimate above used to leave `rezipped:{id}` behind.
        const stop = await look()
        if (stop) return stop
        const unzippedIds = new Set(
          ((await redis.sMembers(`unzipped:${sessionId}`).catch(() => [])) ?? []).filter(
            (id): id is string => typeof id === 'string' && id.trim().length > 0
          )
        )
        const rezippedIds = new Set(
          ((await redis.sMembers(`rezipped:${sessionId}`).catch(() => [])) ?? []).filter(
            (id): id is string => typeof id === 'string' && id.trim().length > 0
          )
        )

        for (const message of liveWindow) {
          if (floorProtectedIds.has(message.id)) continue
          if (isWindowSummaryMessage(message)) continue
          if (recoveryHoldIds.has(message.id)) continue
          if (isMessageProtectedFromManualTrim(message, protections)) continue
          const zipIds = Array.isArray(message.metadata?.zipIds) ? message.metadata.zipIds : []
          for (const zipId of zipIds) {
            if (typeof zipId !== 'string' || !zipId.trim()) continue
            if (unzippedIds.has(zipId)) continue // manual unzips are pins
            if (rezippedIds.has(zipId)) continue
            // BL-749: this loop can span several Redis round trips, and the delete does not take
            // this lock, so a delete can start in the gap between two of them. A synchronous check
            // right before each write catches it the same way `look()` does above.
            if (isSessionDeleting(sessionId)) return 'chat_deleted'
            await redis.sAdd(`rezipped:${sessionId}`, zipId)
            if (isSessionDeleting(sessionId)) return 'chat_deleted'
            await redis.set(`rezipped_item:${sessionId}:${zipId}`, {
              zipId,
              sessionId,
              source: 'agent',
              reason: 'nap',
              napId,
              at: now.toISOString()
            })
            rezippedIds.add(zipId)
            rezippedZipCount += 1
          }
        }
        return null
      })
      if (stepTwoStop) return await endEarly(stepTwoStop, tokensAfter)
    }

    tokensAfter = await estimate()
    if (tokensAfter < window.napAtTokens) {
      return await finish('completed', tokensAfter)
    }

    // ---- Step 3: open-episode narrative compaction + whiteboard extraction ----
    {
      const stepThreeStop = await look()
      if (stepThreeStop) return await endEarly(stepThreeStop, tokensAfter)
      const currentSession = await redis.getSession(sessionId)
      const graduatedIds = new Set(
        getGraduatedMessageIds(
          getFixedSessionGraduationState(currentSession?.metadata ?? null).events
        )
      )
      const liveWindow = buildLiveWindow(messages, currentSession)
      const floorProtectedIds = computeFloorProtectedIds(liveWindow, window.floorTokens)
      const openEpisode = await getOpenEpisode(sessionId)

      const candidates = messages.filter(
        (message) =>
          !graduatedIds.has(message.id) &&
          !isWindowSummaryMessage(message) &&
          !floorProtectedIds.has(message.id) &&
          !recoveryHoldIds.has(message.id) &&
          !isMessageProtectedFromManualTrim(message, protections)
      )

      if (candidates.length < NAP_STEP3_MIN_MESSAGES) {
        return await finish('completed', tokensAfter)
      }

      const sourceTokens = candidates.reduce(
        (total, message) => total + countMessageTokens(message),
        0
      )
      const budget = resolveCompactSummaryBudget({
        contextLimit: window.contextLimit,
        sourceTokenEstimate: sourceTokens
      })
      // 2026-09-19 (Josh): the agent owns its whiteboard. The nap writes the board only
      // when it is EMPTY (fills it) or when a nap wrote it last (refreshes it); a board the
      // agent wrote is never rewritten — the summary model then gets a summary-only call
      // with the agent's board as read-only context.
      const currentWhiteboard = openEpisode?.whiteboard?.content?.trim()
      const boardAuthor = currentWhiteboard ? whiteboardAuthor(openEpisode?.whiteboard) : null
      const napWritesBoard = Boolean(openEpisode) && boardAuthor !== 'agent'
      const whiteboardOutcome: NonNullable<FixedSessionNapRecord['compaction']>['whiteboard'] =
        !openEpisode ? 'none' : !napWritesBoard ? 'kept' : currentWhiteboard ? 'refreshed' : 'filled'
      const prompt = [
        napWritesBoard ? NAP_COMPACTION_PROMPT : NAP_COMPACTION_SUMMARY_ONLY_PROMPT,
        '',
        'SUMMARY BUDGET:',
        `Aim for roughly ${budget.softTargetTokens.toLocaleString()} tokens for the SUMMARY section; do not exceed about ${budget.hardMaxTokens.toLocaleString()}.`,
        '',
        napWritesBoard
          ? currentWhiteboard
            ? `CURRENT EPISODE WHITEBOARD:\n${currentWhiteboard}`
            : 'CURRENT EPISODE WHITEBOARD: (empty — build it from the segment below)'
          : `CURRENT EPISODE WHITEBOARD (kept by the agent; context only, not yours to change):\n${currentWhiteboard}`,
        '',
        'OLDER OPEN-EPISODE SEGMENT TO COMPACT:',
        await buildAgentTranscript(agentId, candidates)
      ].join('\n')

      let embedder: MemoryEmbedder
      try {
        embedder = await resolveEmbedder()
      } catch (error) {
        const stop = await look()
        if (stop) return await endEarly(stop, tokensAfter)
        throw error
      }
      const afterSetupStop = await look()
      if (afterSetupStop) return await endEarly(afterSetupStop, tokensAfter)
      const generated = await generateSummary(prompt, budget.hardMaxTokens)
      // The summary call is the long wait: a message sent meanwhile goes first, and this step's
      // summary, event and board are not written.
      const afterCallStop = await look()
      if (afterCallStop) return await endEarly(afterCallStop, tokensAfter)
      const sections = parseNapCompactionSections(generated, { whiteboard: napWritesBoard })

      const written = await writeGraduationForMessages({
        userId: options.userId,
        agentId,
        sessionId,
        episodeId: openEpisode?.id ?? null,
        source: 'nap',
        sourceMessages: candidates,
        summary: sections.summary,
        embedder,
        writeWindowEvent: true,
        now
      })
      // BL-751: the chat went away between the summary call above and this write's own embed
      // call. No board write follows: the episode's records are gone.
      if (!written.ok) return await endEarly('chat_deleted', tokensAfter)
      segmentIds.push(written.segmentId)
      compaction = {
        segmentId: written.segmentId,
        eventId: written.eventId,
        compactedMessageCount: candidates.length,
        whiteboard: whiteboardOutcome
      }
      if (openEpisode && napWritesBoard && sections.whiteboard) {
        // BL-549: the board is written only if it is still the board read above, before the
        // summary call. A turn sent during that call can have the agent write its board (that
        // board is the agent's, and it stays) or close the episode (its board stays on the closed
        // episode). Either way the summary and event above are complete, and the nap is too.
        try {
          await updateEpisodeWhiteboard(sessionId, openEpisode.id, sections.whiteboard, 'nap', {
            onlyIf: readWhiteboard(openEpisode.whiteboard)
          })
        } catch (error) {
          if (!(error instanceof EpisodeWhiteboardChangedError) && !(error instanceof EpisodeNotOpenError)) {
            throw error
          }
          compaction.whiteboard = 'kept'
        }
      }
    }

    tokensAfter = await estimate()
    return await finish('completed', tokensAfter)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nap failed.'
    const outcome = await finish('failed', null, message)
    return outcome
  }
}

// ---------------------------------------------------------------------------
// Regular-session graduation (DL-104-12 / DL-104-16 — additive, watermark-driven)
// ---------------------------------------------------------------------------

export interface RegularSessionGraduationOutcome {
  status: 'graduated' | 'not_idle' | 'too_small' | 'nothing_new' | 'superseded' | 'chat_deleted'
  segmentId?: string
  messageCount?: number
}

export async function graduateRegularSessionTail(options: {
  userId: string
  agent: AgentRecord
  sessionId: string
  reason: 'idle' | 'close'
  generateSummary?: SummaryGenerator
  embedder?: MemoryEmbedder
  now?: Date
}): Promise<RegularSessionGraduationOutcome> {
  const now = options.now ?? new Date()
  const agentId = String(options.agent?.id ?? '')
  if (!agentId) throw new Error('Graduation requires an agent id.')
  if (!resolveAgentMemoryEnabled(options.agent)) {
    throw new Error('Graduation requires agent memory to be enabled.')
  }

  const session = await redis.getSession(options.sessionId)
  if (!session) throw new Error(`Session ${options.sessionId} not found.`)
  if (isFixedSession(session)) {
    throw new Error('Infinite Sessions graduate through naps and dreaming, not session close.')
  }
  if ((session.metadata as Record<string, any> | undefined)?.group_chat) {
    throw new Error('Group sessions do not graduate in v1 (memory is inert in groups).')
  }

  const messages = await loadOrderedSessionMessages(options.sessionId)
  const watermark = (session.metadata as Record<string, any> | undefined)?.memoryGraduation as
    | Record<string, any>
    | undefined
  // BL-737 review: an empty-string stored id is "no mark", the same as a missing/absent one —
  // never a real message id to search for or to CAS against.
  const lastGraduatedId =
    typeof watermark?.lastGraduatedMessageId === 'string' && watermark.lastGraduatedMessageId !== ''
      ? watermark.lastGraduatedMessageId
      : null

  let tailStart = 0
  if (lastGraduatedId) {
    const index = messages.findIndex((message) => message.id === lastGraduatedId)
    if (index >= 0) tailStart = index + 1
  }
  const tail = messages
    .slice(tailStart)
    .filter((message) => !isWindowSummaryMessage(message))

  if (tail.length === 0) return { status: 'nothing_new' }

  if (options.reason === 'idle') {
    const idleGapMs = resolveMemoryIdleGapHours(options.agent) * 3_600_000
    const lastTs = messageTimestampMs(tail[tail.length - 1])
    if (!Number.isFinite(lastTs) || now.getTime() - lastTs < idleGapMs) {
      return { status: 'not_idle' }
    }
  }

  if (tail.length < MIN_GRADUATION_MESSAGES) return { status: 'too_small' }

  let generateSummary = options.generateSummary
  if (!generateSummary) {
    const userSettings = await redis.getUserSettings(options.userId).catch(() => null)
    const summaryChoice = resolveMemorySummaryModelChoice(
      options.agent,
      userSettings?.global_auto_compact_settings
    )
    generateSummary = buildDefaultSummaryGenerator({
      userId: options.userId,
      agent: options.agent,
      choice: summaryChoice
    })
  }

  // BL-436: the signed-in user's embedder, as dreaming builds it (a local-runtime preset or a key
  // saved in Settings resolves only with a user). Built before the summary call, so a broken
  // embedder setup fails before a model call is spent.
  const embedder =
    options.embedder ??
    (await createMemoryEmbedderAsync((await getMemoryConfig()).embedding, {
      userId: options.userId
    }))

  const budgetSettings = await resolveAgentBudgetSettings(options.agent, options.sessionId)
  const sourceTokens = tail.reduce((total, message) => total + countMessageTokens(message), 0)
  const budget = resolveCompactSummaryBudget({
    contextLimit: budgetSettings.contextLimit,
    sourceTokenEstimate: sourceTokens
  })
  const prompt = [
    GRADUATION_SUMMARY_PROMPT,
    '',
    'SUMMARY BUDGET:',
    `Aim for roughly ${budget.softTargetTokens.toLocaleString()} tokens; do not exceed about ${budget.hardMaxTokens.toLocaleString()}.`,
    '',
    'CONVERSATION SEGMENT TO GRADUATE:',
    await buildAgentTranscript(agentId, tail)
  ].join('\n')
  const summary = await generateSummary(prompt, budget.hardMaxTokens)

  const written = await writeGraduationForMessages({
    userId: options.userId,
    agentId,
    sessionId: options.sessionId,
    episodeId: null,
    source: options.reason === 'close' ? 'session_close' : 'idle',
    sourceMessages: tail,
    summary,
    embedder,
    writeWindowEvent: false,
    now
  })
  // `writeWindowEvent` is false above, so `appendGraduationEvent` never runs and this call can
  // only ever answer `ok` here (BL-751's race is specific to that write; the equivalent gap for a
  // regular session — the chat deleted during THIS call's own embed, inside `createMemorySegment`
  // — surfaces below, at the mark write, since there is no window event here to catch it first).
  if (!written.ok) {
    throw new Error(`Unreachable: regular graduation of session ${options.sessionId} answered chat_deleted.`)
  }

  // Advance the watermark (regular sessions: memseg only, window untouched). BL-723: only the
  // mark, at its own path; the segment joins the stored list. Writing back a copy of the whole
  // metadata erased a Compact event or any other block written since that copy was read. BL-737:
  // the write is a compare-and-set on `lastGraduatedId` — the id THIS graduation read as its
  // starting mark (`tailStart` above is really keyed on that id's position in the message list,
  // never on any message's timestamp) — so two overlapping graduations settle by whichever CAS
  // lands first, and a graduation that resumes after its old mark's message was deleted always
  // reads and matches the current stored id instead of getting stuck. `superseded`: another
  // graduation's write landed first — this call's segment already duplicates ground the winner
  // covers, so it is discarded (a reused segment is left alone; something else still needs it).
  // `missing`: the chat was deleted during this call's own embed (BL-751's regular-session
  // counterpart) — same discard, reported honestly instead of as `graduated`. `superseded_linked`
  // (BL-737 review): the winner already reused THIS call's own segment and linked it into the
  // mark it wrote — deleting it here would leave the mark naming a segment that no longer exists.
  const markWrite = await redis.writeRegularGraduationMark(
    options.sessionId,
    {
      lastGraduatedMessageId: tail[tail.length - 1].id,
      lastGraduatedAt: now.toISOString(),
      segmentId: written.segmentId
    },
    lastGraduatedId
  )

  if (markWrite !== 'ok') {
    if (!written.reused && markWrite !== 'superseded_linked') {
      await deleteMemorySegment(agentId, written.segmentId).catch(() => {})
    }
    return { status: markWrite === 'missing' ? 'chat_deleted' : 'superseded' }
  }

  return { status: 'graduated', segmentId: written.segmentId, messageCount: tail.length }
}
