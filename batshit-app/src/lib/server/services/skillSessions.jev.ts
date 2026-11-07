/**
 * Skill-session CLOSE policy. OPEN selection remains P1's advisory skill choice; only a
 * trusted actual read opens a session. This module never reads or writes lifecycle state.
 * The lifecycle owner applies selected snapshots under its lock, rechecking generation,
 * revision, access and strong holds. Both phases use the existing skill_tool_hints judge.
 */
import type { JevJuiceNote, TypesafeCallRecord } from '$lib/types/typesafe'
import { resolveAgentJevSkillSessionsEnabled } from '$lib/utils/jevJuiceControl'
import { runTypesafeJudgment } from './typesafe/typesafeAvailability'
import { buildJevJuiceNote } from './typesafe/typesafeEvidence'
import type { JevNoulQuestion, JevQuestions, TypesafeClient } from './typesafe/typesafeClient'
import type { SkillSessionSnapshot } from '$lib/utils/skillSessions'

export const SKILL_SESSION_CLOSE_FEATURE_ID = 'skill_tool_hints' as const

/** Conservative initial policy, not calibrated quality evidence or a default-ON proposal. */
export const SKILL_SESSION_CLOSE_THRESHOLDS = Object.freeze({
  taskCompletedFloor: 0.85,
  neededAgainCeiling: 0.15
})

export const SKILL_SESSION_CLOSE_LIMITS = Object.freeze({
  // Two independent Nouls per skill fit the shared 64-question provider limit.
  maxCandidates: 32,
  deadlineMs: 2000
})

/** All fields are supplied from server-owned lifecycle/turn facts, never request-body claims. */
export interface SkillSessionCloseCandidate extends SkillSessionSnapshot {
  description: string
  /** The original task for which the skill opened, not just the newest short follow-up. */
  taskRequest: string
  /** Names and ranges of every actual read; no skill-file bodies are attached. */
  readWindows: string[]
  /** Complete accounting of actual windows, not proof the entire file was read. */
  readWindowsComplete: boolean
  automatic: boolean
  hasExplicitHold: boolean
}

export interface SkillSessionCloseEvidence {
  request: string
  reply: string
  recentUserIntent: string[]
  /** False if any relevant request, reply part or actual read-window fact is missing/cut. */
  complete: boolean
  /** Includes unrecovered tool failures, unfinished work, approvals and running delegates. */
  unfinishedWork: boolean
  scope: 'primary' | 'group' | 'delegated'
  origin: 'user' | 'trusted_resume' | 'wake'
  /** True only at the successful whole-reply boundary, after all resumptions. */
  finished: boolean
}

export const SKILL_SESSION_CLOSE_QUESTIONS = Object.freeze({
  completed: (key: string): JevNoulQuestion => ({
    type: 'noul',
    instructions: `Is the task in \`skills.${key}.task\` complete, given the latest \`request\`, \`recent_user_intent\` and the whole finished \`reply\`? Judge the entire task, not just whether one reply or one step finished.`,
    criteria: {
      true: 'The requested task has been completed or explicitly abandoned by the user, with no remaining step or promised follow-up that uses this skill.',
      false: 'Work continues, the reply only completes one step, the user is reviewing or discussing work still in progress, the assistant asks a necessary question, or the evidence is uncertain.'
    }
  }),
  again: (key: string): JevNoulQuestion => ({
    type: 'noul',
    instructions: `Will the assistant likely need the procedure or references of \`skills.${key}\` again in the next few turns, considering its original \`task\`, \`request\`, \`recent_user_intent\` and the whole \`reply\`?`,
    criteria: {
      true: 'The same task, a requested review, testing, discussion, next step, or promised continuation is likely to use the skill again. A short reply or lack of a tool call does not mean the skill is no longer needed.',
      false: 'The task is over and no planned follow-up, review or continuation appears to need this skill. No stated intention to keep using it remains.'
    }
  })
})

export interface SkillSessionCloseRequest {
  state: {
    request: string
    reply: string
    recent_user_intent: string[]
    skills: Record<string, { description: string; task: string; read_windows: string[] }>
  }
  questions: JevQuestions
  candidates: Array<{ key: string; candidate: SkillSessionCloseCandidate }>
  skipped: string[]
}

export function buildSkillSessionCloseRequest(
  evidence: SkillSessionCloseEvidence,
  candidates: SkillSessionCloseCandidate[]
): { request: SkillSessionCloseRequest | null; skipped: string[] } {
  if (evidence.scope !== 'primary' || evidence.origin === 'wake') {
    return { request: null, skipped: ['Skill closure is unavailable for this turn origin or scope.'] }
  }
  if (!evidence.finished || evidence.unfinishedWork || !evidence.complete || !evidence.request.trim() || !evidence.reply.trim()) {
    return { request: null, skipped: ['Skills kept open: the whole task and reply evidence is incomplete or work is unfinished.'] }
  }
  const skipped: string[] = []
  const eligible: SkillSessionCloseCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate.skillId)) {
      // Conflicting snapshots cannot authorize closing either version.
      const index = eligible.findIndex((item) => item.skillId === candidate.skillId)
      if (index >= 0) eligible.splice(index, 1)
      skipped.push(`${candidate.skillId}: conflicting lifecycle snapshots; kept open.`)
      continue
    }
    seen.add(candidate.skillId)
    if (candidate.status !== 'open' || !candidate.automatic || candidate.hasExplicitHold || !candidate.readWindowsComplete || !candidate.taskRequest.trim() || candidate.readWindows.length === 0 || candidate.readWindows.some((window) => !window.trim()) || !candidate.holdFingerprint || !candidate.accessFingerprint || !Number.isSafeInteger(candidate.generation) || candidate.generation < 1 || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
      skipped.push(`${candidate.skillId}: explicit protection or incomplete lifecycle evidence; kept open.`)
      continue
    }
    eligible.push(candidate)
  }
  if (eligible.length > SKILL_SESSION_CLOSE_LIMITS.maxCandidates) skipped.push(`${eligible.length - SKILL_SESSION_CLOSE_LIMITS.maxCandidates} additional skills were not checked and stay open.`)
  const selected = eligible.slice(0, SKILL_SESSION_CLOSE_LIMITS.maxCandidates)
  if (selected.length === 0) return { request: null, skipped }
  const skills: SkillSessionCloseRequest['state']['skills'] = {}
  const questions: JevQuestions = {}
  const mapped = selected.map((candidate, index) => ({ key: `s${index + 1}`, candidate }))
  for (const { key, candidate } of mapped) {
    skills[key] = { description: candidate.description, task: candidate.taskRequest, read_windows: [...candidate.readWindows] }
    questions[`completed_${key}`] = SKILL_SESSION_CLOSE_QUESTIONS.completed(key)
    questions[`again_${key}`] = SKILL_SESSION_CLOSE_QUESTIONS.again(key)
  }
  // No slicing: an over-limit provider refuses the full request instead of deciding on half a task.
  return {
    request: { state: { request: evidence.request, reply: evidence.reply, recent_user_intent: [...evidence.recentUserIntent], skills }, questions, candidates: mapped, skipped },
    skipped
  }
}

function probability(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object') return null
  const { type, noul } = answer as { type?: unknown; noul?: unknown }
  return type === 'noul' && typeof noul === 'number' && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : null
}

export interface SkillSessionCloseDecision {
  close: Array<{ candidate: SkillSessionCloseCandidate; completed: number; again: number }>
  kept: string[]
  summary: string
}

export function decideSkillSessionCloses(answers: Record<string, unknown>, request: SkillSessionCloseRequest): SkillSessionCloseDecision {
  const close: SkillSessionCloseDecision['close'] = []
  const kept = [...request.skipped]
  const readings: string[] = []
  for (const { key, candidate } of request.candidates) {
    const completed = probability(answers[`completed_${key}`])
    const again = probability(answers[`again_${key}`])
    const canClose = completed !== null && again !== null && completed >= SKILL_SESSION_CLOSE_THRESHOLDS.taskCompletedFloor && again <= SKILL_SESSION_CLOSE_THRESHOLDS.neededAgainCeiling
    readings.push(`${key} completed ${completed ?? '?'} / again ${again ?? '?'}: ${canClose ? 'propose close' : 'keep open'}`)
    if (canClose) close.push({ candidate, completed, again })
    else kept.push(`${candidate.skillId}: uncertain, unfinished, or needed again; kept open.`)
  }
  return { close, kept, summary: `skill sessions after whole reply: ${readings.join('; ')}` }
}

export interface SkillSessionCloseOutcome {
  decision: SkillSessionCloseDecision | null
  record: TypesafeCallRecord | null
  note: JevJuiceNote | null
  skipped: string[]
}

export async function computeSkillSessionCloses(input: {
  userId: string
  agent: Record<string, any>
  evidence: SkillSessionCloseEvidence
  candidates: SkillSessionCloseCandidate[]
  signal?: AbortSignal
  client?: TypesafeClient
}): Promise<SkillSessionCloseOutcome> {
  const none: SkillSessionCloseOutcome = { decision: null, record: null, note: null, skipped: [] }
  if (!resolveAgentJevSkillSessionsEnabled(input.agent) || input.candidates.length === 0) return none
  const { request, skipped } = buildSkillSessionCloseRequest(input.evidence, input.candidates)
  if (!request) return { ...none, skipped }
  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: SKILL_SESSION_CLOSE_FEATURE_ID,
    featureEnabled: true,
    state: request.state,
    questions: request.questions,
    deadlineMs: SKILL_SESSION_CLOSE_LIMITS.deadlineMs,
    signal: input.signal,
    client: input.client
  })
  if (!result.response) {
    result.record.decision = 'skill sessions after whole reply: no answer; every skill stays open'
    return { ...none, record: result.record, note: buildJevJuiceNote(result.record), skipped: [...skipped, 'Skill close check unavailable; every skill stays open.'] }
  }
  const decision = decideSkillSessionCloses(result.response.answers, request)
  result.record.decision = decision.summary
  return { decision, record: result.record, note: null, skipped }
}
