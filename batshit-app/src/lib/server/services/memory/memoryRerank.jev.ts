/**
 * SA-120 P4a (design record A1) — Jev Juice memory search rerank.
 *
 * THE constants module for this feature (DL-120-03): the question, its criteria, the
 * weight, and every cap live here, so a reviewer reads the whole decision surface in one
 * file. The weight changes in code review, never in a prompt.
 *
 * What it does. When an agent with "Jev Juice: Rerank Memory Search" ON calls
 * `sys.memory.search`, the usual search runs exactly as always, and then a second hybrid
 * search fetches a WIDER shortlist than the agent asked for (more candidates per leg, so
 * Redis's default of ten vector neighbours does not cap it). Jev answers one Noul per
 * shortlisted memory ("does this memory bear on the query?") in ONE request, and that
 * probability joins the ranking as a fourth term:
 *
 *   score = 0.55 relevance + 0.25 recency + 0.20 importance   (today's blend, unchanged)
 *         + jevRelevance weight x Jev's Noul                    (this module)
 *
 * The blend itself stays in `blendMemoryRanking` (memoryRecall.ts), the one ranking
 * authority; this module only supplies the extra term. The shortlist is then cut back to
 * the limit the agent asked for, so a memory the hybrid search ranked 15th can reach the
 * page when Jev is sure it answers the query. Superseded results stay demoted to the
 * tail, exactly as today.
 *
 * Switch OFF: `searchMemoriesOp` never enters this module and never runs the wider search;
 * it returns today's bytes (pinned in memoryRerankSearch.test.ts).
 * Jev unavailable, slow, or answering badly: the usual search's own result (it already
 * ran, untouched), an Execution Viewer row with the reason, and one honest sentence in the
 * tool result so the agent knows the order is the usual one (DL-120-02/04). Never an LLM
 * stand-in.
 *
 * A tool lane, not a compile lane: the agent asked for a search and is waiting on it, so
 * the budget is `deadlineMs` below, not the user's In-Chat Wait Limit. Measured basis:
 * the A1 probe in the skill's evidence file (ten memories: the right one 0.97, every other
 * under 0.11). What leaves the machine: the search query and the text of each shortlisted
 * memory, clipped.
 */

import type { TypesafeCallRecord } from '$lib/types/typesafe'
import { resolveAgentJevMemoryRerankEnabled } from '$lib/utils/jevJuiceControl'
import { runTypesafeJudgment } from '../typesafe/typesafeAvailability'
import type { JevNoulAnswer, JevNoulQuestion, JevQuestions, TypesafeClient } from '../typesafe/typesafeClient'
import { blendMemoryRanking } from './memoryRecall'
import type { MemoryRecord } from './memoryTypes'

export const MEMORY_RERANK_FEATURE_ID = 'memory_rerank' as const

/**
 * The fourth blend term. Today's three terms sum to at most 1.0; at 1.0 a decisive Jev
 * answer (0.97 against 0.05) outvotes hybrid rank, recency, and importance together,
 * while a flat one (every candidate near the same value) leaves today's order standing —
 * a calibrated probability's spread is its confidence. First guess; a labeled set of real
 * memories decides the shipped value and any default (DL-120-09).
 */
export const MEMORY_RERANK_WEIGHTS = Object.freeze({
  jevRelevance: 1.0
})

export const MEMORY_RERANK_LIMITS = Object.freeze({
  /** The wider search fetches at least this many (and asks each leg for as many), then the rerank cuts back to the asked limit. */
  shortlistSize: 20,
  /** One Noul per candidate; matches the search tool's own maximum limit. */
  maxCandidates: 25,
  /** What Jev reads of one memory (about 150 tokens). */
  maxMemoryChars: 600,
  /** The agent's search query is the other half of the state. */
  maxQueryChars: 500,
  /** Total budget for the one call, retry included. The search answers with today's ranking when it is missed. */
  deadlineMs: 2000
})

/** The exact instructions and criteria sent to Jev. Question ids are for code only. */
export const MEMORY_RERANK_QUESTIONS = Object.freeze({
  relevance: {
    /** Built per candidate; `key` is the memory's id in `memories`. */
    instructions: (key: string) =>
      `Does the memory \`memories.${key}\` answer \`query\`, or state something a careful assistant would want in hand in order to answer it?`,
    criteria: {
      true: 'The memory states a fact, preference, decision, event, or instruction that answers the query or directly bears on the answer.',
      false:
        'The memory only shares a word or a broad topic with the query, is about something else, or would not change the answer.'
    }
  }
})

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface MemoryRerankCandidate {
  memoryId: string
  /** The `memories` key and the question suffix. Short on purpose: Jev points at it. */
  key: string
  text: string
}

export interface MemoryRerankRequest {
  state: { query: string; memories: Record<string, string> }
  questions: JevQuestions
  candidates: MemoryRerankCandidate[]
}

function clip(value: string | null | undefined, max: number): string {
  const oneLine = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!oneLine) return ''
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine
}

/** What Jev reads for one memory: its content, led by the agent's own gist when the content had to be cut. */
export function describeMemoryForJev(record: Pick<MemoryRecord, 'content' | 'gist'>): string {
  const content = clip(record.content, MEMORY_RERANK_LIMITS.maxMemoryChars)
  const gist = clip(record.gist, 200)
  const wasCut = content.endsWith('…')
  return gist && wasCut ? clip(`${gist} | ${content}`, MEMORY_RERANK_LIMITS.maxMemoryChars) : content
}

/** How many hits the hybrid search fetches for an agent whose switch is ON. `searchMaxLimit` is the tool's own ceiling. */
export function resolveMemoryRerankShortlistSize(requestedLimit: number, searchMaxLimit: number): number {
  return Math.min(Math.max(requestedLimit, MEMORY_RERANK_LIMITS.shortlistSize), searchMaxLimit, MEMORY_RERANK_LIMITS.maxCandidates)
}

/**
 * The candidate pool, as Redis keys in judging order: the wider search's hits, then any hit
 * of the usual search the wider fusion pushed off its page. The pool ALWAYS covers the
 * usual result, so a rerank can promote or demote but never silently lose a usual hit;
 * when the cap bites, only wide-only keys are dropped, from the end.
 */
export function buildMemoryRerankPool(wideKeys: string[], usualKeys: string[]): string[] {
  const pool = Array.from(new Set([...wideKeys, ...usualKeys]))
  const usual = new Set(usualKeys)
  for (let index = pool.length - 1; index >= 0 && pool.length > MEMORY_RERANK_LIMITS.maxCandidates; index--) {
    if (!usual.has(pool[index])) pool.splice(index, 1)
  }
  return pool
}

/** Builds the one request, or `null` when there is nothing worth asking (no query, fewer than two candidates). */
export function buildMemoryRerankRequest(query: string, records: MemoryRecord[]): MemoryRerankRequest | null {
  const clippedQuery = clip(query, MEMORY_RERANK_LIMITS.maxQueryChars)
  if (!clippedQuery) return null
  const candidates: MemoryRerankCandidate[] = []
  for (const record of records.slice(0, MEMORY_RERANK_LIMITS.maxCandidates)) {
    const text = describeMemoryForJev(record)
    if (!text) continue
    candidates.push({ memoryId: record.id, key: `m${candidates.length + 1}`, text })
  }
  // One candidate has nothing to be ranked against.
  if (candidates.length < 2) return null

  const memories: Record<string, string> = {}
  const questions: JevQuestions = {}
  for (const candidate of candidates) {
    memories[candidate.key] = candidate.text
    const question: JevNoulQuestion = {
      type: 'noul',
      instructions: MEMORY_RERANK_QUESTIONS.relevance.instructions(candidate.key),
      criteria: MEMORY_RERANK_QUESTIONS.relevance.criteria
    }
    questions[`rel_${candidate.key}`] = question
  }
  return { state: { query: clippedQuery, memories }, questions, candidates }
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

/**
 * Reads one probability per candidate. Returns `null` when ANY answer is missing or not a
 * finite number: a half-read answer set is never partly trusted, today's ranking stands.
 */
export function readMemoryRerankAnswers(
  answers: Record<string, unknown>,
  request: MemoryRerankRequest
): Map<string, number> | null {
  const relevanceById = new Map<string, number>()
  for (const candidate of request.candidates) {
    const answer = answers[`rel_${candidate.key}`] as JevNoulAnswer | undefined
    const value = answer && answer.type === 'noul' ? answer.noul : Number.NaN
    if (!Number.isFinite(value)) return null
    relevanceById.set(candidate.memoryId, Math.min(1, Math.max(0, value)))
  }
  return relevanceById
}

export interface MemoryRerankRanking {
  /** Final order, already cut to `limit`: current memories first, superseded ones at the tail. */
  ranked: MemoryRecord[]
  /** Returned memories that the usual search did not return at all. */
  promotedIds: string[]
  /** True when the returned ids or their order differ from today's ranking over today's shortlist. */
  changed: boolean
}

/**
 * The rerank: today's blend over the whole shortlist plus the Jev term, cut to `limit`,
 * then superseded results moved to the tail in the same relative order (DL-104-09).
 */
export function rankMemoriesWithJevRelevance(input: {
  /** The whole candidate pool, in judging order. */
  records: MemoryRecord[]
  /** Memory id → position in the pool (the wider search's hit order). */
  hitOrder: Map<string, number>
  relevanceById: ReadonlyMap<string, number>
  limit: number
  nowTs: number
  /** The usual search's own ranked result (`searchMemoriesOp` computed it first), to say what moved. */
  usualRanking: MemoryRecord[]
}): MemoryRerankRanking {
  const pooled = blendMemoryRanking(input.records, input.hitOrder, input.nowTs, {
    weight: MEMORY_RERANK_WEIGHTS.jevRelevance,
    scoreById: input.relevanceById
  }).slice(0, input.limit)
  const ranked = [
    ...pooled.filter((record) => record.is_superseded !== 'y'),
    ...pooled.filter((record) => record.is_superseded === 'y')
  ]
  const usual = input.usualRanking
  const usualIds = new Set(usual.map((record) => record.id))
  const promotedIds = ranked.filter((record) => !usualIds.has(record.id)).map((record) => record.id)
  const changed =
    usual.length !== ranked.length || usual.some((record, index) => record.id !== ranked[index].id)
  return { ranked, promotedIds, changed }
}

const pct = (value: number) => value.toFixed(2)

/** One line for the Execution Viewer: what Jev said and what code did with it. */
export function summarizeMemoryRerank(
  request: MemoryRerankRequest,
  relevanceById: ReadonlyMap<string, number>,
  ranking: MemoryRerankRanking,
  limit: number
): string {
  let top: { id: string; value: number } | null = null
  for (const [id, value] of relevanceById) {
    if (!top || value > top.value) top = { id, value }
  }
  const parts = [
    `judged ${request.candidates.length}, returned ${ranking.ranked.length} (asked ${limit})`,
    top ? `top ${top.id} ${pct(top.value)}` : 'top ?',
    `promoted ${ranking.promotedIds.length} the usual search did not return`
  ]
  return `${parts.join('; ')} → ${ranking.changed ? 'order changed' : 'same order as the usual ranking'}`
}

// ---------------------------------------------------------------------------
// Orchestration (called from `searchMemoriesOp`)
// ---------------------------------------------------------------------------

export interface ComputeMemoryRerankInput {
  userId: string
  /** The freshly read agent record; its switch is the feature switch. */
  agent: Record<string, any>
  query: string
  /** The fetched shortlist, in hybrid hit order. */
  records: MemoryRecord[]
  /** Test seam. */
  client?: TypesafeClient
}

export interface MemoryRerankOutcome {
  /** `null` = today's ranking decides (switch off, nothing to ask, or Jev did not answer). */
  relevanceById: Map<string, number> | null
  request: MemoryRerankRequest | null
  /** `null` when no judgment was attempted: the switch is off or there was nothing to ask. */
  record: TypesafeCallRecord | null
}

/** One search's worth of judgment. Never throws; a miss comes back as a record with no relevance map. */
export async function computeMemoryRerank(input: ComputeMemoryRerankInput): Promise<MemoryRerankOutcome> {
  const none: MemoryRerankOutcome = { relevanceById: null, request: null, record: null }
  // OFF means no request is built and no record is written: the agent pays nothing.
  if (!resolveAgentJevMemoryRerankEnabled(input.agent)) return none
  const request = buildMemoryRerankRequest(input.query, input.records)
  if (!request) return none

  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: MEMORY_RERANK_FEATURE_ID,
    featureEnabled: true,
    state: request.state,
    questions: request.questions,
    deadlineMs: MEMORY_RERANK_LIMITS.deadlineMs,
    client: input.client
  })
  const record = result.record
  if (!result.response) return { relevanceById: null, request, record }

  const relevanceById = readMemoryRerankAnswers(result.response.answers as Record<string, unknown>, request)
  if (!relevanceById) {
    record.decision = 'an answer was missing → usual ranking'
    return { relevanceById: null, request, record }
  }
  return { relevanceById, request, record }
}
