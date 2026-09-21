/**
 * SA-120 P5 (design record B3) — Jev Juice smart zip.
 *
 * THE constants module for this feature (DL-120-03): the question, its criteria, both
 * floors, and every cap live here, so a reviewer reads the whole decision surface in one
 * file. Thresholds change in code review, never in a prompt.
 *
 * PRE-TURN (steps 1 and 2). Today an agent that wants an earlier tool result back has to
 * guess which compressed reference matters from its one-line description, and an unzip it
 * asks for only lands on the NEXT turn. With "Jev Juice: Smart Zip" ON, each accepted user
 * turn on a PRIMARY API or managed CLI lane:
 *   1. the canonical compiler reports every zip it left compressed for this agent
 *      (`ZipCompression`) — the lane never re-derives zip activation;
 *   2. ONE Jev request asks one Noul per zipped tool result (the newest `maxCandidates`):
 *      would the assistant have to read it again to do what the message asks;
 *   3. code sorts the answers into two tiers — `likelyFloor` and over, and the band from
 *      `relatedFloor` up to it;
 *   4. the best of the likely tier are OPENED for this very message (`SMART_ZIP_OPEN_LIMITS`:
 *      at most two results and about ten thousand tokens), as a temporary unzip stored with
 *      `source: 'inferred'` that the ordinary countdown closes again. Never an oversized
 *      safety row (an unzip cannot expand it) and never a result the user or the agent zipped
 *      by hand: explicit beats inferred (DL-120-04). Pins, user locks, and recovery holds are
 *      never compressed, so they are never candidates at all;
 *   5. the agent is told exactly what Batshit did: which results it opened, which it only
 *      names, and why a likely one was not opened — at most `maxLikely` + `maxRelated` lines
 *      closing the DCM.
 * The compile stays read-only: the compiler expands the opened results through an in-memory
 * overlay, and `send-routed` writes the state at the accepted-send boundary, where the memory
 * commit lives (`zipStateInferred.ts`). Josh said yes to Batshit acting on 2026-09-17
 * (design-record decision 2).
 *
 * POST-TURN (step 3). The Normal lanes (Read File, Skill Read, Bash…) keep a result expanded
 * for a few replies, which is right when the agent is still working from it and a waste when
 * it read a file, took two facts, and moved on. Once a reply is finished, ONE Jev request asks
 * two Nouls about each tool result that would otherwise stay open into the next turn — is the
 * agent done with it, and will it need it again soon — and code zips the ones that clear BOTH
 * rules (`SMART_ZIP_POST_TURN_THRESHOLDS`), the way agent zip control's `zip` action does,
 * with `source: 'inferred'`. Never a result the user or the agent holds open, a recovery hold,
 * or an Off lane. It runs after the reply is complete, so it never delays the user; the agent
 * is told on its next turn (`jev_juice_zips_closed`). Measured basis: the post-turn wording
 * probe (ten replies, nineteen results: every finished result done 0.74-0.96 / again
 * 0.09-0.30; every result still in use again 0.51-0.89).
 *
 * Runs under the user's In-Chat Wait Limit (DL-120-05/16, 750 ms by default). A miss omits the lines, the send
 * proceeds, and the inline note says so (DL-120-02). Never an LLM stand-in. Measured basis:
 * the P5 wording probe in the skill's evidence file (22 messages over 32 synthetic zipped
 * results: true matches 0.52-0.88, small talk and new topics never over 0.15; 96 Nouls
 * answer as fast as 16). What leaves the machine: the user's message and the one-line
 * description of each zipped tool result (tool, file path or command, status, size) — never
 * a result's content, and never a real zip id.
 */

import type { ZipCompression, ZipExposed } from '$lib/services/messageCompiler'
import type { JevJuiceNote, TypesafeCallRecord } from '$lib/types/typesafe'
import { resolveBrokerToolToggles } from '$lib/utils/brokerAvailability'
import { resolveJevSmartZipEnabled } from '$lib/utils/jevJuiceControl'
import { runTypesafeJudgment } from './typesafe/typesafeAvailability'
import type { JevNoulAnswer, JevNoulQuestion, JevQuestions, TypesafeClient } from './typesafe/typesafeClient'
import { buildJevJuiceNote } from './typesafe/typesafeEvidence'

export const SMART_ZIP_FEATURE_ID = 'smart_zip' as const

/** The floors and caps code applies to Jev's probabilities. First guesses from the wording probe; a labeled set decides any default (DL-120-09). */
export const SMART_ZIP_THRESHOLDS = Object.freeze({
  /** At or over this, a zipped result is named as likely needed for this message. */
  likelyFloor: 0.6,
  /** From here up to `likelyFloor`, a zipped result is only mentioned as possibly related. */
  relatedFloor: 0.3,
  /** At most this many "likely needed" lines, best first. */
  maxLikely: 3,
  /** At most this many "possibly related" lines, best first. */
  maxRelated: 3
})

/** What Batshit may open by itself per message. First guesses; opening costs tokens by design, and the switch copy says so. */
export const SMART_ZIP_OPEN_LIMITS = Object.freeze({
  /** At most this many results are opened per message, best first. */
  maxOpen: 2,
  /** The opened results' prompt-facing tokens may not add up to more than this. */
  maxOpenTokens: 10_000,
  /** How many messages an opened result stays open before the ordinary countdown closes it. */
  durationMessages: 2
})

/** The after-reply rule: a result is zipped only when BOTH hold. First guesses from the post-turn probe. */
export const SMART_ZIP_POST_TURN_THRESHOLDS = Object.freeze({
  /** "The agent already took what it needed" must be at or over this. */
  doneFloor: 0.7,
  /** "It will need the full content again soon" must be at or under this. */
  againCeiling: 0.35,
  /** At most this many results are zipped after one reply, the most finished first. */
  maxRezips: 4
})

export const SMART_ZIP_POST_TURN_LIMITS = Object.freeze({
  /** Two Nouls per candidate, newest first when more are open. */
  maxCandidates: 12,
  /** The user's request and the finished reply are the evidence; both are clipped. */
  maxRequestChars: 1500,
  maxReplyChars: 3000,
  /** The reply is already on screen, so this is not a compile lane: the vendor attempt window plus the one retry. */
  deadlineMs: 2000
})

export const SMART_ZIP_LIMITS = Object.freeze({
  /** One Noul per candidate, newest first when a session holds more (measured: 96 answer in about 250 ms). */
  maxCandidates: 64,
  /** The user message is half of the state; longer turns are cut here (about 500 tokens). */
  maxMessageChars: 2000,
  /** Zip descriptions are already compact one-liners; this only bounds a pathological one. */
  maxDescriptionChars: 200
})

/** The exact instructions and criteria sent to Jev. Question ids are for code only. */
export const SMART_ZIP_QUESTIONS = Object.freeze({
  done: {
    instructions: (key: string) =>
      `Looking at \`reply\`, has the assistant already taken what it needed from the tool result \`results.${key}\`, so its full content is no longer needed?`,
    criteria: {
      true: 'The reply already gives the answer, the summary, or the finished change that the result was fetched for.',
      false: 'The reply says work on it continues, plans next steps that depend on it, or has not used it yet.'
    }
  },
  again: {
    instructions: (key: string) =>
      `Is the assistant likely to need the full content of the tool result \`results.${key}\` again in the next few turns of this conversation?`,
    criteria: {
      true: 'The task is ongoing or a discussion about it was just opened, and the next steps depend on the exact content.',
      false: 'The task it served is finished, or a one-line summary of it would be enough from here.'
    }
  },
  needed: {
    /** Built per candidate; `key` is the result's id in `zipped`. */
    instructions: (key: string) =>
      `To do what \`message\` asks, would the assistant have to read the full content of the earlier tool result \`zipped.${key}\` again?`,
    criteria: {
      true: 'The message is about that file, command output, search, page, or report; or it names that material as something to follow or match; or the work it asks for changes or depends on its exact content.',
      false:
        'The result is about something else, only shares a folder or a word with the request, or the request can be handled without reopening it.'
    }
  }
})

// ---------------------------------------------------------------------------
// Candidates (from the compiler's own record of what it left compressed)
// ---------------------------------------------------------------------------

export interface SmartZipCandidate {
  zipId: string
  /** The `zipped` key and the question suffix. Real zip ids stay home. */
  key: string
  description: string
  tokens: number
  /** A safety row stays compressed even when unzipped, so its line says to fetch it instead. */
  forceCompress: boolean
  /** Whose hand-made rezip this is, if any. Only Jev's own (`inferred`) may be reopened by Jev. */
  rezippedBy: ZipCompression['rezippedBy']
}

function clip(value: string | null | undefined, max: number): string {
  const oneLine = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine
}

function isFetchZipResult(item: ZipCompression): boolean {
  return item.operationKind === 'fetch_zip' || item.toolName === 'fetch_zip'
}

/**
 * Built-in file and shell lanes whose one-line description is only as good as its target:
 * `bash - 9 lines` or `read_file - 1 line` tells Jev nothing, and any probability it returns
 * for one is noise (measured live: two such results sat at 0.36-0.39 as "possibly related";
 * both were copies a brokered zip fetch had stored under the inner tool's name, F-P5-2).
 * Other lanes keep a target-less result, because their LABEL is the information
 * (`mcp_google_calendar_list_events - 12 events`).
 */
const TARGET_REQUIRED_KINDS = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'list_files', 'skill_read'])

function namesNoTarget(item: ZipCompression): boolean {
  return TARGET_REQUIRED_KINDS.has(item.operationKind ?? '') && !item.descriptionParts?.target
}

/**
 * The same tool call on the same target with the same outcome (`bash: git log - error`,
 * a file read twice) reads the same to Jev, so among such repeats only the NEWEST is a
 * candidate: a re-run replaces the run before it, and "the output you just got" is never the
 * old one. A different outcome is a different result (`exit 1` then `exit 0`: "why did it
 * fail the first time?" needs the older one), and a result with no stored target is never
 * folded. Measured need: the live API proof put an older failed `git log` at 0.84 over the
 * newer one at 0.40, and an age suffix did not teach Jev recency (wording probe).
 */
function repeatKey(item: ZipCompression): string | null {
  const parts = item.descriptionParts
  if (!parts || !parts.label || !parts.target) return null
  return `${parts.label}|${parts.target}|${parts.status ?? ''}`
}

/**
 * Tool results only, described, naming what they are about, de-duplicated, older repeats
 * folded, in chat order; the newest `maxCandidates` when there are more. A `fetch_zip`
 * result is a peek at another zip, so hinting at it would be circular. A group agent's
 * unshared tools never reach here (no provider on group turns), and are dropped anyway:
 * that content is not this agent's to open.
 */
export function selectSmartZipCandidates(items: ZipCompression[]): {
  candidates: SmartZipCandidate[]
  eligible: number
  foldedRepeats: number
} {
  const seen = new Set<string>()
  const described: ZipCompression[] = []
  for (const item of items) {
    if (!item || item.zipType !== 'cool_tool' || item.groupUnshared || isFetchZipResult(item)) continue
    if (namesNoTarget(item)) continue
    if (!item.zipId || seen.has(item.zipId)) continue
    if (!clip(item.description, SMART_ZIP_LIMITS.maxDescriptionChars)) continue
    seen.add(item.zipId)
    described.push(item)
  }
  const lastIndexByRepeatKey = new Map<string, number>()
  described.forEach((item, index) => {
    const key = repeatKey(item)
    if (key) lastIndexByRepeatKey.set(key, index)
  })
  const eligible = described.filter((item, index) => {
    const key = repeatKey(item)
    return !key || lastIndexByRepeatKey.get(key) === index
  })
  const newest = eligible.slice(-SMART_ZIP_LIMITS.maxCandidates)
  return {
    eligible: eligible.length,
    foldedRepeats: described.length - eligible.length,
    candidates: newest.map((item, index) => ({
      zipId: item.zipId,
      key: `z${index + 1}`,
      description: clip(item.description, SMART_ZIP_LIMITS.maxDescriptionChars),
      tokens: Number.isFinite(item.tokens) ? Math.max(0, Math.round(item.tokens)) : 0,
      forceCompress: item.forceCompress === true,
      // A rezip whose owner the compile did not load reads as the user's: never reopened.
      rezippedBy: item.rezipped ? (item.rezippedBy ?? 'user') : null
    }))
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface SmartZipRequest {
  state: { message: string; zipped: Record<string, string> }
  questions: JevQuestions
  candidates: SmartZipCandidate[]
  /** Zipped tool results this agent holds in all; more than `candidates.length` means the oldest were left out. */
  eligible: number
  /** Older repeats of the same tool call, target, and outcome that were folded into their newest run. */
  foldedRepeats: number
}

export function clipSmartZipMessage(message: string): string {
  return clip(message, SMART_ZIP_LIMITS.maxMessageChars)
}

/** Builds the one request, or `null` when there is nothing to ask (no message or nothing zipped). */
export function buildSmartZipRequest(message: string, items: ZipCompression[]): SmartZipRequest | null {
  const clipped = clipSmartZipMessage(message)
  if (!clipped) return null
  const { candidates, eligible, foldedRepeats } = selectSmartZipCandidates(items)
  if (candidates.length === 0) return null

  const zipped: Record<string, string> = {}
  const questions: JevQuestions = {}
  for (const candidate of candidates) {
    zipped[candidate.key] = candidate.description
    const question: JevNoulQuestion = {
      type: 'noul',
      instructions: SMART_ZIP_QUESTIONS.needed.instructions(candidate.key),
      criteria: SMART_ZIP_QUESTIONS.needed.criteria
    }
    questions[`need_${candidate.key}`] = question
  }
  return { state: { message: clipped, zipped }, questions, candidates, eligible, foldedRepeats }
}

// ---------------------------------------------------------------------------
// Decision (pure)
// ---------------------------------------------------------------------------

export interface SmartZipReading {
  candidate: SmartZipCandidate
  /** `null` only when the answer was missing or unreadable; such a result is never hinted. */
  probability: number | null
}

export type SmartZipHint = { candidate: SmartZipCandidate; probability: number }

/** Why a likely-needed result was named but not opened. */
export type SmartZipNotOpenedReason = 'oversized' | 'zipped_by_hand' | 'open_cap' | 'over_budget'

export interface SmartZipDecision {
  readings: SmartZipReading[]
  /** At or over `likelyFloor`, best first, capped: `opened` plus `notOpened`. */
  likely: SmartZipHint[]
  /** The likely results Batshit opens for this message (`SMART_ZIP_OPEN_LIMITS`). */
  opened: SmartZipHint[]
  /** The likely results it only names, each with the reason. */
  notOpened: Array<SmartZipHint & { reason: SmartZipNotOpenedReason }>
  /** From `relatedFloor` up to `likelyFloor`, best first, capped. */
  related: SmartZipHint[]
  /** One line for the Execution Viewer: what Jev said and what code did with it. */
  summary: string
}

const pct = (value: number) => value.toFixed(2)

/**
 * Which likely results Batshit opens itself. Best first; explicit beats inferred, so a result
 * the user or the agent zipped by hand is never reopened (Jev's own earlier rezip may be), and
 * an oversized safety row is skipped because an unzip cannot expand it. Pure.
 */
export function decideSmartZipOpens(likely: SmartZipHint[]): Pick<SmartZipDecision, 'opened' | 'notOpened'> {
  const opened: SmartZipHint[] = []
  const notOpened: SmartZipDecision['notOpened'] = []
  let openedTokens = 0
  for (const hint of likely) {
    const { candidate } = hint
    if (candidate.forceCompress) {
      notOpened.push({ ...hint, reason: 'oversized' })
    } else if (candidate.rezippedBy !== null && candidate.rezippedBy !== 'inferred') {
      notOpened.push({ ...hint, reason: 'zipped_by_hand' })
    } else if (opened.length >= SMART_ZIP_OPEN_LIMITS.maxOpen) {
      notOpened.push({ ...hint, reason: 'open_cap' })
    } else if (openedTokens + candidate.tokens > SMART_ZIP_OPEN_LIMITS.maxOpenTokens) {
      notOpened.push({ ...hint, reason: 'over_budget' })
    } else {
      opened.push(hint)
      openedTokens += candidate.tokens
    }
  }
  return { opened, notOpened }
}

/** Applies both floors, both caps, and the open limits. Pure, so a mutation of any of them is caught by its test. */
export function decideSmartZipHints(answers: Record<string, unknown>, request: SmartZipRequest): SmartZipDecision {
  const readings: SmartZipReading[] = request.candidates.map((candidate) => {
    const answer = answers[`need_${candidate.key}`] as JevNoulAnswer | undefined
    const value = answer && answer.type === 'noul' ? answer.noul : Number.NaN
    return { candidate, probability: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null }
  })
  const ranked = readings
    .filter((reading): reading is SmartZipReading & { probability: number } => reading.probability !== null)
    // Stable: equal probabilities keep chat order.
    .sort((a, b) => b.probability - a.probability)
  const over = ranked.filter((reading) => reading.probability >= SMART_ZIP_THRESHOLDS.likelyFloor)
  const band = ranked.filter(
    (reading) =>
      reading.probability >= SMART_ZIP_THRESHOLDS.relatedFloor && reading.probability < SMART_ZIP_THRESHOLDS.likelyFloor
  )
  const likely = over.slice(0, SMART_ZIP_THRESHOLDS.maxLikely)
  const related = band.slice(0, SMART_ZIP_THRESHOLDS.maxRelated)
  const { opened, notOpened } = decideSmartZipOpens(likely)

  const top = ranked.slice(0, 3).map((reading) => `${reading.candidate.zipId} ${pct(reading.probability)}`)
  const parts = [
    request.eligible > request.candidates.length
      ? `judged the newest ${readings.length} of ${request.eligible} zipped results`
      : `judged ${readings.length} zipped results`,
    top.length > 0 ? `top ${top.join(', ')}` : 'top ?'
  ]
  const unread = readings.length - ranked.length
  if (unread > 0) parts.push(`${unread} unreadable`)
  if (over.length > likely.length) parts.push(`${over.length} likely, cap ${SMART_ZIP_THRESHOLDS.maxLikely}`)
  if (band.length > related.length) parts.push(`${band.length} related, cap ${SMART_ZIP_THRESHOLDS.maxRelated}`)
  const floors = `floors ${pct(SMART_ZIP_THRESHOLDS.likelyFloor)} / ${pct(SMART_ZIP_THRESHOLDS.relatedFloor)}`
  const openedTokens = opened.reduce((sum, hint) => sum + hint.candidate.tokens, 0)
  const held = notOpened.map((hint) => `${hint.candidate.zipId} ${hint.reason}`).join(', ')
  const decided =
    likely.length + related.length > 0
      ? [
          opened.length > 0
            ? `opened ${opened.length} for ${SMART_ZIP_OPEN_LIMITS.durationMessages} messages (about ${openedTokens} tokens, source inferred)`
            : 'opened none',
          notOpened.length > 0 ? `named ${notOpened.length} likely without opening (${held})` : null,
          `named ${related.length} related`,
          floors
        ]
          .filter(Boolean)
          .join('; ')
      : `none at or over ${pct(SMART_ZIP_THRESHOLDS.relatedFloor)} → no hint, nothing opened`
  return { readings, likely, opened, notOpened, related, summary: `${parts.join('; ')} → ${decided}` }
}

// ---------------------------------------------------------------------------
// DCM lines (the agent is told exactly what Batshit did on its behalf, DL-120-04)
// ---------------------------------------------------------------------------

const JEV_JUICE_ZIPS_LEAD = 'jev_juice_zips (a fast judgment model guessed which zipped tool results this message needs;'

/** The heading of a turn in which Batshit opened nothing. */
export const JEV_JUICE_ZIPS_HEADING = `${JEV_JUICE_ZIPS_LEAD} Batshit unzipped nothing; ignore any that do not fit):`

/** The heading of a turn in which Batshit opened results itself. The count is part of what the agent is told. */
export function jevJuiceZipsOpenedHeading(openedCount: number): string {
  return `${JEV_JUICE_ZIPS_LEAD} Batshit unzipped ${openedCount} of them for you and changed nothing else; ignore any that do not fit):`
}

const NOT_OPENED_REASON_TEXT: Record<SmartZipNotOpenedReason, string> = {
  oversized: 'oversized: it stays zipped even if unzipped, so fetch it',
  zipped_by_hand: 'you or the user zipped it by hand, and Batshit does not undo that',
  open_cap: `Batshit opens at most ${SMART_ZIP_OPEN_LIMITS.maxOpen} results per message`,
  over_budget: `opening it would pass the ${SMART_ZIP_OPEN_LIMITS.maxOpenTokens}-token limit for what Batshit opens per message`
}

function describeHint(hint: SmartZipHint): string {
  const size = hint.candidate.tokens > 0 ? ` | about ${hint.candidate.tokens} tokens` : ''
  return `${hint.candidate.zipId} | ${hint.candidate.description}${size} | ${pct(hint.probability)}`
}

/** The DCM tail lines. Empty when nothing cleared the lower floor, so a quiet turn costs no bytes. */
export function buildSmartZipDcmLines(decision: SmartZipDecision, options: { fetchZipEnabled: boolean }): string[] {
  if (decision.likely.length === 0 && decision.related.length === 0) return []
  const lines: string[] = [
    decision.opened.length > 0 ? jevJuiceZipsOpenedHeading(decision.opened.length) : JEV_JUICE_ZIPS_HEADING
  ]
  for (const hint of decision.opened) {
    lines.push(
      `- Unzipped for you (inferred): ${describeHint(hint)} | its full content is in this prompt, and it zips again by itself after ${SMART_ZIP_OPEN_LIMITS.durationMessages} messages (zip control, when you have it, closes it sooner)`
    )
  }
  for (const hint of decision.notOpened) {
    lines.push(`- Likely needed, not unzipped (${NOT_OPENED_REASON_TEXT[hint.reason]}): ${describeHint(hint)}`)
  }
  for (const hint of decision.related) {
    lines.push(`- Possibly related: ${describeHint(hint)}`)
  }
  if (decision.notOpened.length > 0 || decision.related.length > 0) {
    lines.push(
      options.fetchZipEnabled
        ? '- To read one that is still zipped, fetch it by its zip ID (a peek; zip state stays as it is). Zip control, when you have it, keeps one open for later turns.'
        : '- Fetch Zip is off for you, so you cannot open the zipped ones yourself. If one is needed, say so plainly or run the tool again; zip control, when you have it, opens one for the next turn.'
    )
  }
  return lines
}

/** The heading of the notice that tells the agent what Batshit zipped after its last reply (DL-120-04). */
export const JEV_JUICE_ZIPS_CLOSED_HEADING =
  'jev_juice_zips_closed (after your last reply Batshit zipped these tool results because you seemed done with them; fetch or unzip one if that was wrong):'

/** One line per inferred rezip the agent has not been told about yet. Empty when there is none. */
export function buildSmartZipClosedDcmLines(
  markers: Array<{ zipId: string; description: string; done: number }>
): string[] {
  if (markers.length === 0) return []
  return [
    JEV_JUICE_ZIPS_CLOSED_HEADING,
    ...markers.map(
      (marker) => `- Zipped for you (inferred): ${marker.zipId}${marker.description ? ` | ${marker.description}` : ''} | done with it ${pct(marker.done)}`
    )
  ]
}

// ---------------------------------------------------------------------------
// Orchestration (called ONCE per send from the route's smart zip turn, `jevJuiceTurn.ts`)
// ---------------------------------------------------------------------------

export interface ComputeSmartZipHintsInput {
  userId: string
  /** The freshly read agent record (only its Fetch Zip toggle is read; the switch is global). */
  agent: Record<string, any>
  /** The user's `global_zip_settings`; the ONE switch lives there. */
  globalZipSettings: Record<string, any> | null | undefined
  message: string
  /** What the first history compile left compressed (`JevJuiceSmartZipContext.zippedItems`). */
  zippedItems: ZipCompression[]
  /** Test seam. */
  client?: TypesafeClient
}

/** One result Batshit opens for this message: what the compiler overlays and the route later stores. */
export interface SmartZipOpen {
  zipId: string
  description: string
  tokens: number
  probability: number
  durationMessages: number
}

export interface SmartZipHintsOutcome {
  lines: string[]
  /** The results to open for this message; empty on a miss, a quiet turn, or when none qualified. */
  opens: SmartZipOpen[]
  /** `null` when nothing was attempted: the switch is off, or nothing is zipped yet. */
  record: TypesafeCallRecord | null
  note: JevJuiceNote | null
  decision: SmartZipDecision | null
}

/** One send's worth of zip hints. Never throws; a miss comes back as `record` + `note` with no lines. */
export async function computeSmartZipHints(input: ComputeSmartZipHintsInput): Promise<SmartZipHintsOutcome> {
  const none: SmartZipHintsOutcome = { lines: [], opens: [], record: null, note: null, decision: null }
  // OFF means nothing is asked, nothing is opened, and no record is written.
  if (!resolveJevSmartZipEnabled(input.globalZipSettings)) return none

  const request = buildSmartZipRequest(input.message, input.zippedItems)
  // Nothing zipped yet (a young chat), or no message: nothing to judge.
  if (!request) return none

  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: SMART_ZIP_FEATURE_ID,
    featureEnabled: true,
    state: request.state,
    questions: request.questions,
    // The send waits on this call, so the user's In-Chat Wait Limit is the budget (P8, LS-059).
    lane: 'in_chat',
    client: input.client
  })
  const record = result.record
  const details: string[] = record.detail ? [record.detail] : []
  if (request.eligible > request.candidates.length) {
    details.push(
      `the oldest ${request.eligible - request.candidates.length} zipped results were not judged (cap ${SMART_ZIP_LIMITS.maxCandidates})`
    )
  }
  if (request.foldedRepeats > 0) {
    details.push(`${request.foldedRepeats} older repeat${request.foldedRepeats === 1 ? '' : 's'} of the same tool call folded into the newest run`)
  }
  if (details.length > 0) record.detail = details.join('; ')
  if (!result.response) {
    // A miss opens nothing: today's zip rules stand, and the inline note says Jev did not run.
    return { lines: [], opens: [], record, note: buildJevJuiceNote(record), decision: null }
  }

  const decision = decideSmartZipHints(result.response.answers as Record<string, unknown>, request)
  record.decision = decision.summary
  // The same shared rule tool registration reads, so the line never names a tool the agent lacks.
  const toggles = resolveBrokerToolToggles(
    input.agent?.provider_specific_settings ?? input.agent?.providerSpecificSettings ?? null
  )
  return {
    lines: buildSmartZipDcmLines(decision, { fetchZipEnabled: toggles.fetchZipEnabled }),
    opens: decision.opened.map((hint) => ({
      zipId: hint.candidate.zipId,
      description: hint.candidate.description,
      tokens: hint.candidate.tokens,
      probability: hint.probability,
      durationMessages: SMART_ZIP_OPEN_LIMITS.durationMessages
    })),
    record,
    note: null,
    decision
  }
}

// ---------------------------------------------------------------------------
// After the reply (step 3): which still-open results is the agent done with?
// ---------------------------------------------------------------------------

/**
 * A tool result created during the reply that just finished. No compile has seen it yet, so
 * the route says whether today's zip rules would leave it expanded on the next turn (the one
 * activation function, asked about a result zero replies old).
 */
export interface SmartZipNewResult {
  zipId: string
  zipType: string
  description: string
  descriptionParts?: { label: string; target: string; status: string }
  tokens: number
  operationKind?: string
  toolName?: string
  expandedNextTurn: boolean
}

export interface SmartZipPostTurnCandidate {
  zipId: string
  /** The `results` key and the question suffix. Real zip ids stay home. */
  key: string
  description: string
  tokens: number
  /** Why it would stay open: today's buffer rules, or Jev's own temporary unzip. */
  openedBy: 'buffer' | 'inferred'
}

function isJudgeableResult(item: {
  zipType: string
  description: string
  operationKind?: string
  toolName?: string
  descriptionParts?: { target: string }
}): boolean {
  if (item.zipType !== 'cool_tool') return false
  if (item.operationKind === 'fetch_zip' || item.toolName === 'fetch_zip') return false
  if (TARGET_REQUIRED_KINDS.has(item.operationKind ?? '') && !item.descriptionParts?.target) return false
  return Boolean(clip(item.description, SMART_ZIP_LIMITS.maxDescriptionChars))
}

/**
 * The tool results that would stay expanded into the next turn, and that Jev may close:
 * expanded only by buffer rules with at least one more reply of buffer left, held open by
 * Jev's own temporary unzip, or created by this reply on a lane that does not zip at once.
 * NEVER one the user or the agent holds open (a pin, a lock, an agent's explicit choice), a
 * recovery hold, or an Off lane. Newest `maxCandidates`, in chat order.
 */
export function selectSmartZipPostTurnCandidates(
  exposed: ZipExposed[],
  newResults: SmartZipNewResult[]
): SmartZipPostTurnCandidate[] {
  const seen = new Set<string>()
  const open: Array<Omit<SmartZipPostTurnCandidate, 'key'>> = []
  for (const item of exposed) {
    if (!item || seen.has(item.zipId) || !isJudgeableResult(item)) continue
    if (item.recoveryHold || item.zipDisabled) continue
    if (item.unzippedBy === 'user' || item.unzippedBy === 'agent') continue
    // Buffer-expanded: only worth asking when it would STILL be open after one more reply.
    if (item.unzippedBy === null && item.messagesFromEnd + 1 >= item.bufferSize) continue
    seen.add(item.zipId)
    open.push({
      zipId: item.zipId,
      description: clip(item.description, SMART_ZIP_LIMITS.maxDescriptionChars),
      tokens: Number.isFinite(item.tokens) ? Math.max(0, Math.round(item.tokens)) : 0,
      openedBy: item.unzippedBy === 'inferred' ? 'inferred' : 'buffer'
    })
  }
  for (const item of newResults) {
    if (!item || seen.has(item.zipId) || !item.expandedNextTurn || !isJudgeableResult(item)) continue
    seen.add(item.zipId)
    open.push({
      zipId: item.zipId,
      description: clip(item.description, SMART_ZIP_LIMITS.maxDescriptionChars),
      tokens: Number.isFinite(item.tokens) ? Math.max(0, Math.round(item.tokens)) : 0,
      openedBy: 'buffer'
    })
  }
  return open
    .slice(-SMART_ZIP_POST_TURN_LIMITS.maxCandidates)
    .map((candidate, index) => ({ ...candidate, key: `r${index + 1}` }))
}

export interface SmartZipPostTurnRequest {
  state: { request: string; reply: string; results: Record<string, string> }
  questions: JevQuestions
  candidates: SmartZipPostTurnCandidate[]
}

/** Builds the one after-reply request, or `null` when there is no reply or nothing would stay open. */
export function buildSmartZipPostTurnRequest(
  userRequest: string,
  reply: string,
  candidates: SmartZipPostTurnCandidate[]
): SmartZipPostTurnRequest | null {
  const clippedReply = clip(reply, SMART_ZIP_POST_TURN_LIMITS.maxReplyChars)
  if (!clippedReply || candidates.length === 0) return null
  const results: Record<string, string> = {}
  const questions: JevQuestions = {}
  for (const candidate of candidates) {
    results[candidate.key] = candidate.description
    const done: JevNoulQuestion = {
      type: 'noul',
      instructions: SMART_ZIP_QUESTIONS.done.instructions(candidate.key),
      criteria: SMART_ZIP_QUESTIONS.done.criteria
    }
    const again: JevNoulQuestion = {
      type: 'noul',
      instructions: SMART_ZIP_QUESTIONS.again.instructions(candidate.key),
      criteria: SMART_ZIP_QUESTIONS.again.criteria
    }
    questions[`done_${candidate.key}`] = done
    questions[`again_${candidate.key}`] = again
  }
  return {
    state: { request: clip(userRequest, SMART_ZIP_POST_TURN_LIMITS.maxRequestChars), reply: clippedReply, results },
    questions,
    candidates
  }
}

export interface SmartZipRezip {
  zipId: string
  description: string
  tokens: number
  done: number
  again: number
}

export interface SmartZipPostTurnDecision {
  /** Both answers per candidate; `null` when one was missing or unreadable (such a result is never zipped). */
  readings: Array<{ candidate: SmartZipPostTurnCandidate; done: number | null; again: number | null }>
  rezips: SmartZipRezip[]
  summary: string
}

function readNoul(answers: Record<string, unknown>, id: string): number | null {
  const answer = answers[id] as JevNoulAnswer | undefined
  const value = answer && answer.type === 'noul' ? answer.noul : Number.NaN
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null
}

/** Applies BOTH rules and the cap. Pure, so a mutation of any of the three is caught by its test. */
export function decideSmartZipRezips(
  answers: Record<string, unknown>,
  request: SmartZipPostTurnRequest
): SmartZipPostTurnDecision {
  const readings = request.candidates.map((candidate) => ({
    candidate,
    done: readNoul(answers, `done_${candidate.key}`),
    again: readNoul(answers, `again_${candidate.key}`)
  }))
  const finished = readings
    .filter(
      (reading): reading is { candidate: SmartZipPostTurnCandidate; done: number; again: number } =>
        reading.done !== null &&
        reading.again !== null &&
        reading.done >= SMART_ZIP_POST_TURN_THRESHOLDS.doneFloor &&
        reading.again <= SMART_ZIP_POST_TURN_THRESHOLDS.againCeiling
    )
    // The most finished first; stable, so equal answers keep chat order.
    .sort((a, b) => b.done - a.done)
  const rezips = finished.slice(0, SMART_ZIP_POST_TURN_THRESHOLDS.maxRezips).map((reading) => ({
    zipId: reading.candidate.zipId,
    description: reading.candidate.description,
    tokens: reading.candidate.tokens,
    done: reading.done,
    again: reading.again
  }))

  const shown = readings
    .slice(0, 4)
    .map(
      (reading) =>
        `${reading.candidate.zipId} done ${reading.done === null ? '?' : pct(reading.done)} / again ${reading.again === null ? '?' : pct(reading.again)}`
    )
  const rules = `rules done ≥ ${pct(SMART_ZIP_POST_TURN_THRESHOLDS.doneFloor)} and again ≤ ${pct(SMART_ZIP_POST_TURN_THRESHOLDS.againCeiling)}`
  const savedTokens = rezips.reduce((sum, rezip) => sum + rezip.tokens, 0)
  const parts = [`after the reply: judged ${readings.length} open results`, shown.join(', ')]
  if (finished.length > rezips.length) parts.push(`${finished.length} finished, cap ${SMART_ZIP_POST_TURN_THRESHOLDS.maxRezips}`)
  const decided =
    rezips.length > 0
      ? `zipped ${rezips.length} (about ${savedTokens} tokens off the next prompt, source inferred); kept ${readings.length - rezips.length} open; ${rules}`
      : `zipped none; ${rules}`
  return { readings, rezips, summary: `${parts.join('; ')} → ${decided}` }
}

export interface ComputeSmartZipRezipsInput {
  userId: string
  globalZipSettings: Record<string, any> | null | undefined
  /** The user message this reply answered. */
  userRequest: string
  /** The finished reply, as the user sees it. */
  reply: string
  /** What the send's final history pass left expanded. */
  exposed: ZipExposed[]
  /** The tool results this reply created. */
  newResults: SmartZipNewResult[]
  /** Test seam. */
  client?: TypesafeClient
}

export interface SmartZipRezipsOutcome {
  rezips: SmartZipRezip[]
  /** `null` when nothing was attempted: the switch is off, or nothing would stay open. */
  record: TypesafeCallRecord | null
  decision: SmartZipPostTurnDecision | null
}

/** One reply's worth of after-the-fact rezips. Never throws; a miss zips nothing and today's buffer rules stand. */
export async function computeSmartZipRezips(input: ComputeSmartZipRezipsInput): Promise<SmartZipRezipsOutcome> {
  const none: SmartZipRezipsOutcome = { rezips: [], record: null, decision: null }
  if (!resolveJevSmartZipEnabled(input.globalZipSettings)) return none
  const request = buildSmartZipPostTurnRequest(
    input.userRequest,
    input.reply,
    selectSmartZipPostTurnCandidates(input.exposed, input.newResults)
  )
  if (!request) return none

  const result = await runTypesafeJudgment({
    userId: input.userId,
    featureId: SMART_ZIP_FEATURE_ID,
    featureEnabled: true,
    state: request.state,
    questions: request.questions,
    deadlineMs: SMART_ZIP_POST_TURN_LIMITS.deadlineMs,
    client: input.client
  })
  const record = result.record
  if (!result.response) {
    record.decision = 'after the reply: no answer, so nothing was zipped and the usual buffer rules stand'
    return { rezips: [], record, decision: null }
  }
  const decision = decideSmartZipRezips(result.response.answers as Record<string, unknown>, request)
  record.decision = decision.summary
  return { rezips: decision.rezips, record, decision }
}
