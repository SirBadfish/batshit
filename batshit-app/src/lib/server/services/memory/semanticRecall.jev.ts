/**
 * SA-120 P4b (design record A2) — Jev Juice recall by meaning.
 *
 * THE constants module for this feature (DL-120-03): the question, its criteria, the floor,
 * and every cap live here, so a reviewer reads the whole decision surface in one file.
 * Thresholds change in code review, never in a prompt.
 *
 * What it does. Today a long-term (LTM) memory reaches the agent only when the agent spends
 * a tool call to search and recall it; trigger-word (STM) memories fire on exact words. With
 * "Jev Juice: Recall by Meaning" ON, each accepted user turn:
 *   1. a hybrid pre-filter (the memory index, the message as the query, any-word lexical
 *      leg) shortlists up to `maxCandidates` current LTM memories that are not already in
 *      this turn's context;
 *   2. ONE Jev request asks one Noul per candidate: would knowing this memory change or
 *      improve the reply to this message;
 *   3. code keeps candidates at or over `relevanceFloor`, best first, at most `maxInserts`.
 * The winners enter the recall engine's ordinary selection as `recalled (inferred 0.91)`
 * entries of the DCM `Memory context:` section — the single channel (DL-104-17) — so they
 * share the recalled-lane budget, the normal recall linger, the owned-image lane, the
 * Execution Viewer's Memory Context, and the "memories surfaced" chip. Every explicit
 * candidate (a deliberate recall, a trigger hit, anything lingering) outranks every inferred
 * one for budget, and the section closes with one line telling the agent that Batshit, not
 * the agent, brought those entries in (DL-120-04).
 *
 * Where the call lives (F-P1-2): never inside the compiler or the recall engine. The route
 * builds a provider closure around `computeSemanticRecall`; the engine calls it with the ids
 * already in context, and the route hands the same answer to `commitMemoryTurnState`, so
 * compile and commit still select identically and the commit boundary is untouched.
 *
 * Runs under the user's In-Chat Wait Limit (DL-120-05/16, 750 ms by default) for pre-filter AND call together.
 * A miss inserts nothing, the send proceeds, and the inline note says so (DL-120-02). Never
 * an LLM stand-in. Measured basis: the P4b wording probe in the skill's evidence file (eight
 * messages over twenty synthetic memories: true matches 0.66-0.94, the best wrong one 0.53,
 * small talk never over 0.22). What leaves the machine: the user's message and the text of
 * each shortlisted memory, clipped.
 */

import type { JevJuiceNote, TypesafeCallRecord } from '$lib/types/typesafe'
import { resolveAgentJevMemoryRecallEnabled } from '$lib/utils/jevJuiceControl'
import { resolveTypesafeAccess, runTypesafeJudgment } from '../typesafe/typesafeAvailability'
import type { JevNoulAnswer, JevNoulQuestion, JevQuestions, TypesafeClient } from '../typesafe/typesafeClient'
import { buildJevJuiceNote, createTypesafeCallRecord } from '../typesafe/typesafeEvidence'
import { createMemoryEmbedderAsync } from './memoryEmbedder'
import { getMemoryConfig, hybridSearchMemories } from './memoryIndex'
import type { MemoryInferredRecall } from './memoryRecall'
import { describeMemoryForJev } from './memoryRerank.jev'
import { fetchMemoriesByKeys } from './memoryStore'
import type { MemoryRecord } from './memoryTypes'

export const SEMANTIC_RECALL_FEATURE_ID = 'memory_recall' as const

/** The floors and caps code applies to Jev's probabilities. First guesses from the wording probe; a labeled set decides any default (DL-120-09). */
export const SEMANTIC_RECALL_THRESHOLDS = Object.freeze({
  /** A memory under this does not enter the agent's context. */
  relevanceFloor: 0.6,
  /** At most this many memories are brought in per message, best first. */
  maxInserts: 3
})

export const SEMANTIC_RECALL_LIMITS = Object.freeze({
  /** Shortlist size: one Noul per candidate. */
  maxCandidates: 20,
  /** The pre-filter over-fetches by this much so ids already in context can be dropped without starving the shortlist. */
  prefilterSlack: 10,
  /** The user message is the query and half of the state; longer turns are cut here (about 500 tokens). */
  maxMessageChars: 2000,
  /** Pre-filter and call share the In-Chat Wait Limit; with less than this left for Jev, the call is not made. */
  minCallBudgetMs: 200
})

/** The exact instructions and criteria sent to Jev. Question ids are for code only. */
export const SEMANTIC_RECALL_QUESTIONS = Object.freeze({
  relevance: {
    /** Built per candidate; `key` is the memory's id in `memories`. */
    instructions: (key: string) =>
      `Would knowing the memory \`memories.${key}\` change or improve how the assistant should respond to \`message\`?`,
    criteria: {
      true: 'The memory holds a fact, preference, decision, or past event about the user or their work that the message refers to, asks about, or that a good reply must take into account.',
      false:
        'The memory is about something else, only shares a topic word with the message, or the reply would be the same without it.'
    }
  }
})

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface SemanticRecallCandidate {
  memoryId: string
  /** The `memories` key and the question suffix. Real ids stay home. */
  key: string
  text: string
}

export interface SemanticRecallRequest {
  state: { message: string; memories: Record<string, string> }
  questions: JevQuestions
  candidates: SemanticRecallCandidate[]
}

export function clipSemanticRecallMessage(message: string): string {
  const oneLine = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : ''
  return oneLine.length > SEMANTIC_RECALL_LIMITS.maxMessageChars
    ? `${oneLine.slice(0, SEMANTIC_RECALL_LIMITS.maxMessageChars - 1).trimEnd()}…`
    : oneLine
}

/** Builds the one request, or `null` when there is nothing to ask (no message or no candidate). */
export function buildSemanticRecallRequest(message: string, records: MemoryRecord[]): SemanticRecallRequest | null {
  const clipped = clipSemanticRecallMessage(message)
  if (!clipped) return null
  const candidates: SemanticRecallCandidate[] = []
  for (const record of records.slice(0, SEMANTIC_RECALL_LIMITS.maxCandidates)) {
    const text = describeMemoryForJev(record)
    if (!text) continue
    candidates.push({ memoryId: record.id, key: `m${candidates.length + 1}`, text })
  }
  if (candidates.length === 0) return null

  const memories: Record<string, string> = {}
  const questions: JevQuestions = {}
  for (const candidate of candidates) {
    memories[candidate.key] = candidate.text
    const question: JevNoulQuestion = {
      type: 'noul',
      instructions: SEMANTIC_RECALL_QUESTIONS.relevance.instructions(candidate.key),
      criteria: SEMANTIC_RECALL_QUESTIONS.relevance.criteria
    }
    questions[`rel_${candidate.key}`] = question
  }
  return { state: { message: clipped, memories }, questions, candidates }
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

export interface SemanticRecallReading {
  memoryId: string
  key: string
  /** `null` only when the answer was missing or unreadable; such a candidate is never inserted. */
  probability: number | null
}

export interface SemanticRecallDecision {
  readings: SemanticRecallReading[]
  /** What the recall engine receives: at or over the floor, best first, capped. */
  recalls: MemoryInferredRecall[]
  /** One line for the Execution Viewer: what Jev said and what code did with it. */
  summary: string
}

const pct = (value: number) => value.toFixed(2)

/** Applies the floor and the cap. Pure, so a mutation of either threshold is caught by its test. */
export function decideSemanticRecall(
  answers: Record<string, unknown>,
  request: SemanticRecallRequest
): SemanticRecallDecision {
  const readings: SemanticRecallReading[] = request.candidates.map((candidate) => {
    const answer = answers[`rel_${candidate.key}`] as JevNoulAnswer | undefined
    const value = answer && answer.type === 'noul' ? answer.noul : Number.NaN
    return {
      memoryId: candidate.memoryId,
      key: candidate.key,
      probability: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null
    }
  })
  const ranked = readings
    .filter((reading): reading is SemanticRecallReading & { probability: number } => reading.probability !== null)
    // Stable: equal probabilities keep the pre-filter's order.
    .sort((a, b) => b.probability - a.probability)
  const over = ranked.filter((reading) => reading.probability >= SEMANTIC_RECALL_THRESHOLDS.relevanceFloor)
  const recalls = over
    .slice(0, SEMANTIC_RECALL_THRESHOLDS.maxInserts)
    .map((reading) => ({ id: reading.memoryId, probability: reading.probability }))

  const top = ranked.slice(0, 3).map((reading) => `${reading.memoryId} ${pct(reading.probability)}`)
  const parts = [`judged ${readings.length}`, top.length > 0 ? `top ${top.join(', ')}` : 'top ?']
  if (over.length > recalls.length) parts.push(`${over.length} over the floor, cap ${SEMANTIC_RECALL_THRESHOLDS.maxInserts}`)
  const decided =
    recalls.length > 0
      ? `brought in ${recalls.length} (floor ${pct(SEMANTIC_RECALL_THRESHOLDS.relevanceFloor)})`
      : `none at or over ${pct(SEMANTIC_RECALL_THRESHOLDS.relevanceFloor)} → nothing brought in`
  return { readings, recalls, summary: `${parts.join('; ')} → ${decided}` }
}

// ---------------------------------------------------------------------------
// Pre-filter (the memory index; no TypeSafe traffic)
// ---------------------------------------------------------------------------

export interface SemanticRecallPrefilterInput {
  userId: string
  agentId: string
  message: string
  excludeIds: string[]
  now?: () => number
}

/** Current, unexpired LTM memories near the message, minus what is already in context, in index order. */
export async function prefilterSemanticRecallCandidates(input: SemanticRecallPrefilterInput): Promise<MemoryRecord[]> {
  const query = clipSemanticRecallMessage(input.message)
  if (!query) return []
  const embedder = await createMemoryEmbedderAsync((await getMemoryConfig()).embedding, { userId: input.userId })
  const vector = await embedder.embedQuery(query)
  const fetchLimit = SEMANTIC_RECALL_LIMITS.maxCandidates + SEMANTIC_RECALL_LIMITS.prefilterSlack
  const hits = await hybridSearchMemories({
    agentId: input.agentId,
    query,
    vector,
    limit: fetchLimit,
    filters: { lane: 'ltm', superseded: 'n' },
    candidatesPerLeg: fetchLimit,
    lexicalMode: 'any'
  })
  const exclude = new Set(input.excludeIds)
  const keys = hits
    .map((hit) => hit.key)
    .filter((key) => !exclude.has(key.split(':').pop() as string))
    .slice(0, SEMANTIC_RECALL_LIMITS.maxCandidates)
  if (keys.length === 0) return []
  const order = new Map(keys.map((key, index) => [key.split(':').pop() as string, index]))
  const nowTs = (input.now ?? Date.now)()
  return (await fetchMemoriesByKeys(keys))
    .filter(
      (record) =>
        record.lane === 'ltm' &&
        record.is_superseded !== 'y' &&
        !(typeof record.expires_ts === 'number' && record.expires_ts <= nowTs)
    )
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

// ---------------------------------------------------------------------------
// Orchestration (called from the route's provider closure)
// ---------------------------------------------------------------------------

export interface ComputeSemanticRecallInput {
  userId: string
  /** The freshly read agent record; its switch is the feature switch. */
  agent: Record<string, any>
  message: string
  /** Memory ids already in this turn's context, from the recall engine. */
  excludeIds: string[]
  /** Test seams. */
  client?: TypesafeClient
  prefilter?: (input: SemanticRecallPrefilterInput) => Promise<MemoryRecord[]>
  now?: () => number
}

export interface SemanticRecallOutcome {
  recalls: MemoryInferredRecall[]
  /** `null` when nothing was attempted: the switch is off or there was no candidate to ask about. */
  record: TypesafeCallRecord | null
  note: JevJuiceNote | null
  decision: SemanticRecallDecision | null
}

function localRecord(
  model: string | null,
  startedAt: number,
  now: () => number,
  fields: Pick<TypesafeCallRecord, 'status' | 'reason' | 'deadlineHit' | 'detail'>
): TypesafeCallRecord {
  return {
    feature: SEMANTIC_RECALL_FEATURE_ID,
    model,
    latencyMs: Math.max(0, now() - startedAt),
    usage: null,
    questionCount: 0,
    at: new Date().toISOString(),
    ...fields
  }
}

/** One send's worth of inferred recalls. Never throws; every miss comes back as a record plus a note with no recalls. */
export async function computeSemanticRecall(input: ComputeSemanticRecallInput): Promise<SemanticRecallOutcome> {
  const none: SemanticRecallOutcome = { recalls: [], record: null, note: null, decision: null }
  // OFF means nothing is searched, nothing is asked, and no record is written.
  if (!resolveAgentJevMemoryRecallEnabled(input.agent)) return none
  const agentId = String(input.agent?.id ?? '')
  if (!agentId || !clipSemanticRecallMessage(input.message)) return none

  const now = input.now ?? Date.now
  const startedAt = now()

  // The access rule first: with the master switch off or no key, not even the pre-filter
  // runs (an embedding preset can itself be a cloud call). `runTypesafeJudgment` applies
  // the same rule again in front of the one call below.
  const access = await resolveTypesafeAccess({
    userId: input.userId,
    featureId: SEMANTIC_RECALL_FEATURE_ID,
    featureEnabled: true
  })
  if (!access.allowed) {
    const record = createTypesafeCallRecord({
      featureId: SEMANTIC_RECALL_FEATURE_ID,
      requestedModel: access.config.modelId,
      questionCount: 0,
      outcome: null,
      deniedReason: access.reason
    })
    return { recalls: [], record, note: buildJevJuiceNote(record), decision: null }
  }

  let candidates: MemoryRecord[]
  try {
    candidates = await (input.prefilter ?? prefilterSemanticRecallCandidates)({
      userId: input.userId,
      agentId,
      message: input.message,
      excludeIds: input.excludeIds,
      now
    })
  } catch (error) {
    // The memory index or the embedder failed. Saves and searches fail loudly on their own;
    // here the send proceeds without inferred recalls and the miss is visible.
    console.error('[Jev Juice] recall by meaning: the memory pre-filter failed:', error)
    const record = localRecord(access.model, startedAt, now, {
      status: 'error',
      reason: 'local_error',
      deadlineHit: false,
      detail: `memory pre-filter failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    })
    return { recalls: [], record, note: buildJevJuiceNote(record), decision: null }
  }

  const request = buildSemanticRecallRequest(input.message, candidates)
  // No LTM memory near the message (or every one is already in context): nothing to ask.
  if (!request) return none

  // The pre-filter and the call share the user's In-Chat Wait Limit (P8, LS-059): the call gets
  // what the pre-filter left, read from the same record the access rule just read.
  const prefilterMs = Math.max(0, now() - startedAt)
  const waitLimitMs = access.config.inChatWaitMs
  const remainingMs = waitLimitMs - prefilterMs
  if (remainingMs < SEMANTIC_RECALL_LIMITS.minCallBudgetMs) {
    const record = localRecord(access.model, startedAt, now, {
      status: 'unavailable',
      reason: 'deadline',
      deadlineHit: true,
      detail: `the memory pre-filter took ${prefilterMs} ms of the ${waitLimitMs} ms In-Chat Wait Limit; no call was made`
    })
    return { recalls: [], record, note: buildJevJuiceNote(record), decision: null }
  }

  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: SEMANTIC_RECALL_FEATURE_ID,
    featureEnabled: true,
    state: request.state,
    questions: request.questions,
    deadlineMs: remainingMs,
    lane: 'in_chat',
    client: input.client
  })
  const record = result.record
  record.detail = `${record.detail ? `${record.detail}; ` : ''}pre-filter ${prefilterMs} ms, ${request.candidates.length} candidates`
  if (!result.response) {
    return { recalls: [], record, note: buildJevJuiceNote(record), decision: null }
  }

  const decision = decideSemanticRecall(result.response.answers as Record<string, unknown>, request)
  record.decision = decision.summary
  return { recalls: decision.recalls, record, note: null, decision }
}
