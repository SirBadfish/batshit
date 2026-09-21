/**
 * SA-120 P3 (design record E1) — Jev Juice group speaker selection and follow-up gating.
 *
 * THE constants module for this feature (DL-120-03): every question, criterion, floor,
 * and cap lives here, so a reviewer reads the whole decision surface in one file.
 * Thresholds change in code review, never in a prompt.
 *
 * What it does. A group agent can carry the speaking preset `smart` ("Jev Juice: Smart").
 * When a group event needs a speaker and today's rules do not already decide it (the
 * user named exactly one agent, or a driver is eligible), `send-routed` asks Jev ONCE:
 *   1. a Choice over the eligible candidates plus `nobody` — who is best placed to
 *      respond to this message;
 *   2. a Noul — does the message call for a reply at all;
 *   3. one Noul per candidate — would that agent add something new by replying now.
 * Code then applies the floors below:
 *   - a USER message always gets a speaker (a silent room after the user spoke would read
 *     as broken, and today's cost is one LLM call anyway): the top candidate wins when its
 *     share of the probability among the real candidates clears `speakerFloor`, else
 *     today's rules pick (random) and the Execution Viewer says why;
 *   - on an AGENT (follow-up) event, a `smart` candidate is SKIPPED — no LLM call spent
 *     on a `listening` reply — when the turn's `needs_reply` sits under its floor or that
 *     agent's `adds_value` sits under `addsValueFloor`; agents on the other presets are
 *     never gated here (their own preset rules already ran). When nobody is left, the
 *     follow-up chain ends and the record lands on the previous speaker's snapshot.
 * Explicit beats inferred (DL-120-04): a single addressed agent or a driver is chosen
 * before Jev is asked, and the picked agent is told in its DCM tail (`jev_juice_group`).
 *
 * Runs under the user's In-Chat Wait Limit (DL-120-05/16, 750 ms by default). A miss falls back to today's
 * rules, the send proceeds, and the inline note says so (DL-120-02). Measured basis: the
 * E1 probe in the skill's evidence file (5/5 speakers over four described agents, per-agent
 * `adds_value` 0.74-0.94 on topic versus 0.03-0.33 off topic, `nobody` 0.61 on "lol ok").
 */

import type { GroupChatSpeakPolicy } from '$lib/types/groupChat'
import { GROUP_CHAT_MAX_AGENT_COUNT } from '$lib/types/groupChat'
import type { JevJuiceNote, TypesafeCallRecord } from '$lib/types/typesafe'
import { runTypesafeJudgment } from './typesafe/typesafeAvailability'
import type {
  JevChoiceAnswer,
  JevChoiceQuestion,
  JevNoulAnswer,
  JevNoulQuestion,
  JevQuestions,
  TypesafeClient
} from './typesafe/typesafeClient'
import { buildJevJuiceNote } from './typesafe/typesafeEvidence'

export const GROUP_SPEAKER_FEATURE_ID = 'group_speaker' as const

/** The speaking preset that turns this lane on for an agent (LS-051). Stored in `group:{id}.agent_settings[agentId].speak_policy`. */
export const GROUP_SPEAK_POLICY_SMART = 'smart' as const satisfies GroupChatSpeakPolicy

/** The floors code applies to Jev's probabilities. First guesses tuned on the E1 probe; a labeled set decides any default (DL-120-09). */
export const GROUP_SPEAKER_THRESHOLDS = Object.freeze({
  /**
   * The top candidate's share of the Choice probability among the REAL candidates
   * (after `nobody` and any skipped agents are removed) needed for Jev to pick the
   * speaker. Below it, today's rules pick and the Execution Viewer says "low confidence".
   */
  speakerFloor: 0.5,
  /** Follow-up events only: under this, the message needs no reply and every `smart` candidate is skipped. */
  needsReplyFloor: 0.5,
  /** Follow-up events only: a `smart` candidate under this adds too little to spend an LLM call on. */
  addsValueFloor: 0.6
})

export const GROUP_SPEAKER_LIMITS = Object.freeze({
  /** Group size cap; one Choice option and one Noul per candidate. */
  maxCandidates: GROUP_CHAT_MAX_AGENT_COUNT,
  /** The event message is the state; longer ones are cut here (about 1k tokens). */
  maxMessageChars: 4000,
  /** Earlier replies in this group turn that ride along as context, newest last. */
  maxEarlierReplies: 2,
  maxEarlierReplyChars: 600,
  /** An agent's description (or the first line of its system prompt) is cut here. */
  maxAboutChars: 200
})

/** What Jev reads about each speaking preset, appended to the agent's description. */
export const GROUP_SPEAKER_PRESET_TEXT: Readonly<Record<GroupChatSpeakPolicy, string>> = Object.freeze({
  none: 'no speaking preset',
  balanced: 'speaks when it adds clear value',
  quiet: 'prefers silence unless it adds unique value',
  only_when_asked: 'speaks only when addressed directly',
  topic_only: 'speaks only about its listed topics',
  smart: 'speaks when it has something new to add'
})

/** The exact instructions and criteria sent to Jev. Question ids are for code only. */
export const GROUP_SPEAKER_QUESTIONS = Object.freeze({
  speaker: {
    instructions:
      'In this group chat, which agent in `agents` is best placed to respond next to `message` (spoken by `spoke_last`), given `earlier_this_turn`? Pick by who would add the most new value, not by who spoke last. Pick `nobody` when the message needs no reply.',
    nobody: 'No reply is needed: the message is closure, acknowledgement, or small talk that does not call for a response.'
  },
  needsReply: {
    instructions:
      'Does `message` (spoken by `spoke_last`) call for a reply from one of the agents in `agents` at all?',
    criteria: {
      true: 'The message asks, proposes, reports, or invites something that one of the agents should answer or build on.',
      false: 'The message is closure, acknowledgement, thanks, or small talk, or it fully wraps up the exchange; a reply would add nothing.'
    }
  },
  addsValue: {
    /** Built per candidate; `name` is the agent's display name and `key` its id in `agents`. */
    instructions: (name: string, key: string) =>
      `Would ${name} (\`agents.${key}\`) add something new and useful by replying to \`message\` now, rather than repeating what was already said in \`earlier_this_turn\` or speaking off its own topic?`
  }
})

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface GroupSpeakerCandidate {
  agentId: string
  name: string
  /** What Jev reads: the agent's description, else the first line of its system prompt. `null` when neither exists. */
  about: string | null
  preset: GroupChatSpeakPolicy
  topics?: string[]
}

export interface GroupSpeakerEarlierReply {
  name: string
  content: string
}

export interface GroupSpeakerRequestInput {
  eventType: 'user' | 'agent'
  /** The event text: the user's message, or the source agent's reply on a follow-up. */
  message: string
  /** Who spoke it, as Jev should read it: "the user (Josh)" or "Opie (an agent in this group)". */
  spokeLast: string
  /** Replies already made in this group turn, oldest first. */
  earlierThisTurn: GroupSpeakerEarlierReply[]
  candidates: GroupSpeakerCandidate[]
}

export interface GroupSpeakerKeyedCandidate extends GroupSpeakerCandidate {
  /** The Choice option id and the `agents` key. Derived from the name, unique per request, never `nobody`. */
  key: string
}

export interface GroupSpeakerRequest {
  eventType: 'user' | 'agent'
  state: {
    message: string
    spoke_last: string
    earlier_this_turn?: string[]
    agents: Record<string, string>
  }
  questions: JevQuestions
  candidates: GroupSpeakerKeyedCandidate[]
}

function clip(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine
}

function noul(instructions: string, criteria?: { true: string; false: string }): JevNoulQuestion {
  return { type: 'noul', instructions, ...(criteria ? { criteria } : {}) }
}

function choice(instructions: string, criteria: Record<string, unknown>): JevChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

/** Option keys come from names so the per-agent Nouls read naturally; `nobody` is reserved. */
export function buildGroupSpeakerKeys(candidates: GroupSpeakerCandidate[]): GroupSpeakerKeyedCandidate[] {
  const used = new Set<string>(['nobody'])
  return candidates.map((candidate) => {
    const base = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'agent'
    let key = base
    let suffix = 2
    while (used.has(key)) {
      key = `${base}_${suffix}`
      suffix += 1
    }
    used.add(key)
    return { ...candidate, key }
  })
}

/** How one candidate is described to Jev (the Choice option and the `agents` entry). */
export function describeGroupSpeakerCandidate(candidate: GroupSpeakerCandidate): string {
  const about = clip(candidate.about, GROUP_SPEAKER_LIMITS.maxAboutChars)
  const presetText =
    candidate.preset === 'topic_only' && Array.isArray(candidate.topics) && candidate.topics.length > 0
      ? `speaks only about: ${candidate.topics.join(', ')}`
      : (GROUP_SPEAKER_PRESET_TEXT[candidate.preset] ?? GROUP_SPEAKER_PRESET_TEXT.balanced)
  return `${candidate.name}: ${about ?? 'no description'}; ${presetText}`
}

/** Builds the one request, or `null` when there is nothing to ask (no message or no candidates). */
export function buildGroupSpeakerRequest(input: GroupSpeakerRequestInput): GroupSpeakerRequest | null {
  const message = clip(input.message, GROUP_SPEAKER_LIMITS.maxMessageChars)
  if (!message) return null
  const candidates = buildGroupSpeakerKeys(input.candidates.slice(0, GROUP_SPEAKER_LIMITS.maxCandidates))
  if (candidates.length === 0) return null

  const agents: Record<string, string> = {}
  const speakerCriteria: Record<string, unknown> = {}
  for (const candidate of candidates) {
    const description = describeGroupSpeakerCandidate(candidate)
    agents[candidate.key] = description
    speakerCriteria[candidate.key] = description
  }
  speakerCriteria.nobody = GROUP_SPEAKER_QUESTIONS.speaker.nobody

  const earlier = input.earlierThisTurn
    .slice(-GROUP_SPEAKER_LIMITS.maxEarlierReplies)
    .map((reply) => {
      const content = clip(reply.content, GROUP_SPEAKER_LIMITS.maxEarlierReplyChars)
      return content ? `${reply.name}: ${content}` : null
    })
    .filter((line): line is string => Boolean(line))

  const state: GroupSpeakerRequest['state'] = {
    message,
    spoke_last: input.spokeLast,
    ...(earlier.length > 0 ? { earlier_this_turn: earlier } : {}),
    agents
  }

  const questions: JevQuestions = {
    speaker: choice(GROUP_SPEAKER_QUESTIONS.speaker.instructions, speakerCriteria),
    needs_reply: noul(GROUP_SPEAKER_QUESTIONS.needsReply.instructions, GROUP_SPEAKER_QUESTIONS.needsReply.criteria)
  }
  for (const candidate of candidates) {
    questions[`adds_value_${candidate.key}`] = noul(
      GROUP_SPEAKER_QUESTIONS.addsValue.instructions(candidate.name, candidate.key)
    )
  }

  return { eventType: input.eventType, state, questions, candidates }
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

export interface GroupSpeakerAgentReading {
  agentId: string
  name: string
  key: string
  smart: boolean
  /** The agent's `adds_value` Noul; `null` only if the answer was missing. */
  addsValue: number | null
  /** The agent's raw share of the Choice distribution. */
  probability: number
}

export interface GroupSpeakerPick {
  agentId: string
  name: string
  /** The pick's share of the probability among the remaining real candidates. */
  probability: number
}

export type GroupSpeakerOutcomeKind = 'picked' | 'low_confidence' | 'nobody_left'

export interface GroupSpeakerDecision {
  needsReply: number | null
  /** Raw probability Jev put on `nobody`. Informational; the gates are the two Nouls. */
  nobody: number
  agents: GroupSpeakerAgentReading[]
  /** Follow-up events only: `smart` candidates under a floor, in candidate order. */
  skipped: GroupSpeakerAgentReading[]
  /** Candidates still eligible after gating. */
  remaining: GroupSpeakerAgentReading[]
  picked: GroupSpeakerPick | null
  outcome: GroupSpeakerOutcomeKind
  /** One line for the Execution Viewer: what Jev said and what code did with it. */
  summary: string
}

type GroupSpeakerAnswers = Record<string, JevChoiceAnswer | JevNoulAnswer | undefined> & {
  speaker?: JevChoiceAnswer
  needs_reply?: JevNoulAnswer
}

function readNoul(answer: JevChoiceAnswer | JevNoulAnswer | undefined): number | null {
  return answer && answer.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null
}

function readProbability(answer: JevChoiceAnswer | undefined, key: string): number {
  const value = answer?.probabilities?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const pct = (value: number) => value.toFixed(2)

/** Applies the floors. Pure, so a mutation of any threshold above is caught by its test. */
export function decideGroupSpeaker(answers: GroupSpeakerAnswers, request: GroupSpeakerRequest): GroupSpeakerDecision {
  const needsReply = readNoul(answers.needs_reply)
  const nobody = readProbability(answers.speaker, 'nobody')
  const agents: GroupSpeakerAgentReading[] = request.candidates.map((candidate) => ({
    agentId: candidate.agentId,
    name: candidate.name,
    key: candidate.key,
    smart: candidate.preset === GROUP_SPEAK_POLICY_SMART,
    addsValue: readNoul(answers[`adds_value_${candidate.key}`]),
    probability: readProbability(answers.speaker, candidate.key)
  }))

  const skipped: GroupSpeakerAgentReading[] = []
  if (request.eventType === 'agent') {
    const replyNeeded = needsReply !== null && needsReply >= GROUP_SPEAKER_THRESHOLDS.needsReplyFloor
    for (const reading of agents) {
      if (!reading.smart) continue
      // A missing `adds_value` answer never silences an agent: it is treated as "ask the model", today's cost.
      const addsEnough = reading.addsValue === null || reading.addsValue >= GROUP_SPEAKER_THRESHOLDS.addsValueFloor
      if (!replyNeeded || !addsEnough) skipped.push(reading)
    }
  }
  const skippedIds = new Set(skipped.map((reading) => reading.agentId))
  const remaining = agents.filter((reading) => !skippedIds.has(reading.agentId))

  let picked: GroupSpeakerPick | null = null
  let outcome: GroupSpeakerOutcomeKind
  if (remaining.length === 0) {
    outcome = 'nobody_left'
  } else {
    const total = remaining.reduce((sum, reading) => sum + reading.probability, 0)
    const top = remaining.reduce((best, reading) => (reading.probability > best.probability ? reading : best), remaining[0])
    const share = total > 0 ? top.probability / total : 0
    if (share >= GROUP_SPEAKER_THRESHOLDS.speakerFloor) {
      picked = { agentId: top.agentId, name: top.name, probability: share }
      outcome = 'picked'
    } else {
      outcome = 'low_confidence'
    }
  }

  const parts: string[] = [
    `needs_reply ${needsReply === null ? '?' : pct(needsReply)}`,
    `speaker ${answers.speaker?.choice ?? '?'} (nobody ${pct(nobody)})`,
    `adds ${agents.map((reading) => `${reading.name} ${reading.addsValue === null ? '?' : pct(reading.addsValue)}`).join(', ')}`
  ]
  if (skipped.length > 0) parts.push(`skipped ${skipped.map((reading) => reading.name).join(', ')}`)
  const decided =
    outcome === 'picked' && picked
      ? `picked ${picked.name} ${pct(picked.probability)}`
      : outcome === 'low_confidence'
        ? 'low confidence → usual rules'
        : request.eventType === 'agent'
          ? 'follow-up skipped'
          : 'usual rules'
  const summary = `${parts.join('; ')} → ${decided}`

  return { needsReply, nobody, agents, skipped, remaining, picked, outcome, summary }
}

// ---------------------------------------------------------------------------
// What the picked agent is told (DCM tail, through the P1 provider seam) and what the
// Execution Viewer records
// ---------------------------------------------------------------------------

export const JEV_JUICE_GROUP_HEADING =
  "jev_juice_group (Batshit's judgment model helped choose this turn's speaker; advisory):"

/** The DCM tail lines for the agent that ended up speaking. Empty only when there is nothing to tell it. */
export function buildGroupSpeakerDcmLines(decision: GroupSpeakerDecision, selectedAgentId: string): string[] {
  const lines: string[] = []
  const pickedYou = decision.picked?.agentId === selectedAgentId
  if (pickedYou && decision.picked) {
    const count = decision.remaining.length
    lines.push(
      `- You were picked to speak now (${pct(decision.picked.probability)} among ${count} candidate${count === 1 ? '' : 's'}). If you truly have nothing new to add, answer listening.`
    )
  } else {
    const top = decision.remaining.reduce<GroupSpeakerAgentReading | null>(
      (best, reading) => (!best || reading.probability > best.probability ? reading : best),
      null
    )
    lines.push(
      top
        ? `- Jev Juice was not confident about a speaker (top ${top.name} ${pct(top.probability)}); Batshit picked you by its usual rules.`
        : '- Jev Juice could not pick a speaker; Batshit picked you by its usual rules.'
    )
  }
  if (decision.skipped.length > 0) {
    lines.push(
      `- Skipped this turn for adding little: ${decision.skipped
        .map((reading) => `${reading.name} (${reading.addsValue === null ? '?' : pct(reading.addsValue)})`)
        .join(', ')}.`
    )
  }
  return [JEV_JUICE_GROUP_HEADING, ...lines]
}

/** `streamMetadata.speakerSelection` → `executionMetadata.groupChat.speakerSelection` and the message metadata. */
export interface GroupSpeakerSelectionMetadata {
  by: 'jev' | 'rules'
  reason: GroupSpeakerOutcomeKind | 'unavailable' | 'error'
  /** The pick's share among the remaining candidates, when Jev picked. */
  probability?: number
  needsReply?: number | null
  skipped: Array<{ agentId: string; agentName: string; addsValue: number | null }>
}

export function buildGroupSpeakerSelectionMetadata(
  outcome: GroupSpeakerOutcome,
  selectedAgentId: string
): GroupSpeakerSelectionMetadata {
  const decision = outcome.decision
  if (!decision) {
    return { by: 'rules', reason: outcome.record.status === 'error' ? 'error' : 'unavailable', skipped: [] }
  }
  const pickedYou = decision.picked?.agentId === selectedAgentId
  return {
    by: pickedYou ? 'jev' : 'rules',
    reason: pickedYou ? 'picked' : decision.outcome,
    ...(pickedYou && decision.picked ? { probability: decision.picked.probability } : {}),
    needsReply: decision.needsReply,
    skipped: decision.skipped.map((reading) => ({
      agentId: reading.agentId,
      agentName: reading.name,
      addsValue: reading.addsValue
    }))
  }
}

// ---------------------------------------------------------------------------
// Orchestration (called from send-routed's group scheduler)
// ---------------------------------------------------------------------------

export interface ComputeGroupSpeakerInput {
  userId: string
  request: GroupSpeakerRequest
  signal?: AbortSignal
  /** Test seam. */
  client?: TypesafeClient
}

export interface GroupSpeakerOutcome {
  /** `null` when Jev did not answer: today's rules decide, and `note` says so on the message. */
  decision: GroupSpeakerDecision | null
  record: TypesafeCallRecord
  note: JevJuiceNote | null
}

/** One event's worth of judgment. Never throws; a miss comes back as a record plus a note with no decision. */
export async function computeGroupSpeakerSelection(input: ComputeGroupSpeakerInput): Promise<GroupSpeakerOutcome> {
  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: GROUP_SPEAKER_FEATURE_ID,
    // The switch is the preset itself: the caller only asks when a `smart` candidate exists.
    featureEnabled: true,
    state: input.request.state,
    questions: input.request.questions,
    // The group turn waits on this call, so the user's In-Chat Wait Limit is the budget (P8, LS-059).
    lane: 'in_chat',
    signal: input.signal,
    client: input.client
  })
  const record = result.record
  if (!result.response) {
    return { decision: null, record, note: buildJevJuiceNote(record) }
  }
  const decision = decideGroupSpeaker(result.response.answers as GroupSpeakerAnswers, input.request)
  record.decision = decision.summary
  return { decision, record, note: null }
}
