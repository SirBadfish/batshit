/**
 * SA-120 P2 (design record H1) — `sys.judge.ask`, the agent-callable judgment tool.
 *
 * THE constants module for this feature (DL-120-03): limits, the model rule, the input
 * contract, and the one operation behind the Fabric control. The agent supplies `state`
 * and typed `questions`; Batshit forwards them to TypeSafe's Jev on the user's key and
 * returns the typed answers plus usage. Jev never writes text, and this control never
 * decides anything on the agent's behalf: the agent reads the probabilities and applies
 * its own thresholds (the "sub-agent that does 200 things in one second" framing).
 *
 * Scope (DL-120-06): PRIMARY actors only, per-agent switch `jev_juice_judge_tool` (OFF),
 * opened through `BROKER_FABRIC_JUDGE_CONTROL_IDS` at the same registration sites as the
 * DM family and passed explicit false from every subagent and Worker scope. The master
 * switch and the key are re-checked inside `runTypesafeJudgment` on every call. The
 * control is `safe` and `actsAsAgent: false` — it reads nothing the agent owns; it only
 * checks the agent's switch — so it never touches `decideRiskGate` (DL-120-12).
 */

import type { TypesafeCallRecord } from '$lib/types/typesafe'
import { describeTypesafeReason } from '$lib/utils/jevJuice'
import { resolveAgentJevJudgeToolEnabled } from '$lib/utils/jevJuiceControl'
import { redis } from '$lib/server/redis'
import { TYPESAFE_PINNED_MODEL_ID_PATTERN } from './typesafe/typesafe.constants'
import { runTypesafeJudgment } from './typesafe/typesafeAvailability'
import type { JevQuestion, JevQuestions, TypesafeClient } from './typesafe/typesafeClient'
import { getTypesafeConfig } from './typesafe/typesafeConfig'
import { attachTypesafeRecordToActiveStream } from './typesafe/typesafeRunEvidence'

export const JUDGE_ASK_FEATURE_ID = 'judge_ask' as const

export const JUDGE_ASK_LIMITS = Object.freeze({
  /** The vendor budget is about 32k tokens shared by state and questions; this is a conservative char guard (about 30k tokens). */
  maxRequestChars: 120_000,
  /** Questions per call. Parallel, so many is fine; this only bounds a runaway. */
  maxQuestions: 64,
  /** Vendor Choice cap (reliable to about 240). */
  maxChoiceOptions: 255,
  minChoiceOptions: 2,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  /** A tool call is not a compile lane: the agent is waiting, so the budget is the vendor's own attempt window plus the one retry. */
  deadlineMs: 15_000
})

export class JudgeAskError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'JudgeAskError'
  }
}

export interface JudgeAskContext {
  userId: string
  agentId: string
  sessionId?: string | null
  /** Test seam. */
  client?: TypesafeClient
}

export interface JudgeAskInput {
  state: unknown
  questions: Record<string, unknown>
  model?: unknown
}

export interface JudgeAskResult {
  model: string
  answers: Record<string, unknown>
  usage: { input_tokens: number; output_tokens: number } | null
  latency_ms: number
  request_chars: number
  question_count: number
}

/**
 * Server-side enablement gate, mirroring `requireDmEnabledAgent`: the control runs only
 * for an existing, user-owned agent whose judgment-tool switch is ON. The broker allowlist
 * should already have stopped anything else; this makes that true rather than assumed.
 */
export async function requireJudgeEnabledAgent(
  userId: string,
  agentId: string | null | undefined
): Promise<Record<string, any>> {
  const normalized = typeof agentId === 'string' ? agentId.trim() : ''
  if (!normalized) {
    throw new JudgeAskError('sys.judge.ask needs an agent context (agentId missing).')
  }
  const agent = (await redis.get(`agent:${normalized}`)) as Record<string, any> | null
  if (!agent || agent.user_id !== userId) {
    throw new JudgeAskError(`Agent ${normalized} was not found for this user.`)
  }
  if (!resolveAgentJevJudgeToolEnabled(agent)) {
    throw new JudgeAskError(
      'Jev Juice: Judgment Tool is off for this agent.',
      'The user can turn it on in Settings → Agents → this agent → Jev Juice: Judgment Tool.'
    )
  }
  return agent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Validates one question against the v1 contract; returns the typed question or throws a readable error. */
export function validateJudgeQuestion(id: string, raw: unknown): JevQuestion {
  if (!isRecord(raw)) throw new JudgeAskError(`questions.${id} must be an object with type and instructions.`)
  const type = raw.type
  const instructions = raw.instructions
  if (instructions === undefined || instructions === null || instructions === '') {
    throw new JudgeAskError(`questions.${id}.instructions is required — the id is never shown to the model.`)
  }
  if (type === 'noul') {
    const criteria = raw.criteria
    if (criteria !== undefined && !isRecord(criteria)) {
      throw new JudgeAskError(`questions.${id}.criteria for a noul must be {true: ..., false: ...} when present.`)
    }
    return { type: 'noul', instructions, ...(criteria ? { criteria: criteria as { true?: unknown; false?: unknown } } : {}) }
  }
  if (type === 'choice') {
    const criteria = raw.criteria
    if (!isRecord(criteria)) throw new JudgeAskError(`questions.${id}.criteria must be an object of option → description for a choice.`)
    const count = Object.keys(criteria).length
    if (count < JUDGE_ASK_LIMITS.minChoiceOptions || count > JUDGE_ASK_LIMITS.maxChoiceOptions) {
      throw new JudgeAskError(
        `questions.${id} has ${count} options; a choice needs ${JUDGE_ASK_LIMITS.minChoiceOptions}-${JUDGE_ASK_LIMITS.maxChoiceOptions}.`,
        'For more options, split into a coarse choice first and a fine one over the winner\'s group.'
      )
    }
    return { type: 'choice', instructions, criteria }
  }
  if (type === 'score') {
    const criteria = raw.criteria
    if (!Array.isArray(criteria) || criteria.length < JUDGE_ASK_LIMITS.minScoreLevels || criteria.length > JUDGE_ASK_LIMITS.maxScoreLevels) {
      throw new JudgeAskError(
        `questions.${id}.criteria for a score must be an array of ${JUDGE_ASK_LIMITS.minScoreLevels}-${JUDGE_ASK_LIMITS.maxScoreLevels} level descriptions, low to high.`
      )
    }
    return { type: 'score', instructions, criteria }
  }
  throw new JudgeAskError(`questions.${id}.type must be noul, choice, or score.`)
}

export function validateJudgeAskInput(input: unknown): { state: unknown; questions: JevQuestions; model: string | null } {
  if (!isRecord(input)) throw new JudgeAskError('sys.judge.ask needs an input object with state and questions.')
  if (input.state === undefined) throw new JudgeAskError('state is required: the text or JSON every question is judged against.')
  if (!isRecord(input.questions)) throw new JudgeAskError('questions must be an object keyed by ids you choose.')
  const ids = Object.keys(input.questions)
  if (ids.length === 0) throw new JudgeAskError('questions must hold at least one question.')
  if (ids.length > JUDGE_ASK_LIMITS.maxQuestions) {
    throw new JudgeAskError(`questions holds ${ids.length}; the cap is ${JUDGE_ASK_LIMITS.maxQuestions} per call.`)
  }
  const questions: JevQuestions = {}
  for (const id of ids) questions[id] = validateJudgeQuestion(id, input.questions[id])
  let model: string | null = null
  if (input.model !== undefined && input.model !== null && input.model !== '') {
    if (typeof input.model !== 'string' || !TYPESAFE_PINNED_MODEL_ID_PATTERN.test(input.model.trim())) {
      throw new JudgeAskError('model must be a pinned Jev id such as jev-1.13.0, or omitted for the configured one. jev-latest is not allowed.')
    }
    model = input.model.trim()
  }
  return { state: input.state, questions, model }
}

/** The one operation behind `sys.judge.ask`. */
export async function judgeAskOp(context: JudgeAskContext, rawInput: unknown): Promise<JudgeAskResult> {
  await requireJudgeEnabledAgent(context.userId, context.agentId)
  const { state, questions, model } = validateJudgeAskInput(rawInput)

  const requestChars = JSON.stringify({ state, questions }).length
  if (requestChars > JUDGE_ASK_LIMITS.maxRequestChars) {
    throw new JudgeAskError(
      `This request is ${requestChars.toLocaleString()} characters; the cap is ${JUDGE_ASK_LIMITS.maxRequestChars.toLocaleString()} (about 30k tokens shared by state and questions).`,
      'Send less state, or split the items into several calls.'
    )
  }

  if (model) {
    const config = await getTypesafeConfig()
    if (model !== config.modelId) {
      throw new JudgeAskError(
        `model ${model} is not the configured Jev model (${config.modelId}).`,
        'Omit model to use the configured one; the user can change it in Settings → Admin → Jev Juice.'
      )
    }
  }

  const result = await runTypesafeJudgment({
    userId: context.userId,
    featureId: JUDGE_ASK_FEATURE_ID,
    featureEnabled: true,
    state,
    questions,
    deadlineMs: JUDGE_ASK_LIMITS.deadlineMs,
    client: context.client
  })

  const record: TypesafeCallRecord = result.record
  if (result.response) {
    record.decision = `answered ${Object.keys(questions).length} question${Object.keys(questions).length === 1 ? '' : 's'} for the agent`
  }
  // Mid-run call: the row goes on the running assistant message's snapshot (DL-120-07).
  await attachTypesafeRecordToActiveStream(context.sessionId ?? null, record, 'sys.judge.ask')

  if (!result.response) {
    const reason = result.record.reason ?? 'unavailable'
    throw new JudgeAskError(
      `${describeTypesafeReason(reason)}${result.record.detail ? ` (${result.record.detail})` : ''}`,
      reason === 'master_off'
        ? 'The user can turn Jev Juice on in Settings → Admin → Jev Juice.'
        : reason === 'no_key'
          ? 'The user can save a TypeSafe key in Settings → API Keys.'
          : reason === 'deadline' || reason === 'timeout' || reason === 'rate_limited'
            ? 'Try again with less state or fewer options; do not loop on it.'
            : undefined
    )
  }

  return {
    model: result.response.model,
    answers: result.response.answers as Record<string, unknown>,
    usage: result.response.usage
      ? { input_tokens: result.response.usage.inputTokens, output_tokens: result.response.usage.outputTokens }
      : null,
    latency_ms: result.outcome?.latencyMs ?? 0,
    request_chars: requestChars,
    question_count: Object.keys(questions).length
  }
}
