import { OBSERVED_USAGE_FIELDS as TOKEN_FIELDS, observedCounts, readObservedUsage } from './observedUsage'
export { readObservedUsage } from './observedUsage'
import { redis } from '$lib/server/redis'
import { buildUsageLike, normalizeUsageLike } from '$lib/server/services/apiProviderUsage'
import { mergeDelegatedSummaries } from '$lib/server/services/delegatedRunAccounting'
import type {
  ExecutionConfidenceLevel,
  ExecutionLlmSummary,
  ExecutionResponseSummary,
  ExecutionSnapshot,
  ExecutionTokenStat,
  ExecutionTokenUsage,
  ObservedUsage
} from '$lib/types/executionViewer'
import type { ApprovalResumeStart } from '$lib/utils/approvalResumeStream'

export function createApprovalResumeStart(prior: StoredAssistantRecord, now = Date.now()): ApprovalResumeStart {
  const metadata = prior.metadata && typeof prior.metadata === 'object' ? prior.metadata as Record<string, any> : {}
  // Refuse malformed saved portions before the resumed model can run, rather than discover
  // them only at the save and lose work received during the new half.
  readObservedUsage(metadata.observedUsage)
  const previous = Number.isSafeInteger(metadata.approvalResumeVersion) ? metadata.approvalResumeVersion : 0
  const carried: Record<string, any> = {}
  // The reply-end step's keys ride the start too (SA-129 P2b, BL-350), so `/api/sse`'s `end`
  // joins the same first part `mergeResumedMetadata` keeps in the saved record. So do the first
  // part's numbers (BL-525): the tab saves `end`'s usage over the record, so `end` must carry the
  // sum, not the resume's half.
  for (const key of ['zipIds', 'zipReferences', 'imageZipIds', 'steers', 'toolApprovals', 'answeredApprovalIds', 'reasoningSummary', 'planSummary', 'planItems', 'zipControl', 'memorySaves', 'controlErrors', 'zipHolds', 'usage', 'performance', 'delegated', 'observedUsage']) {
    if (metadata[key] !== undefined) carried[key] = metadata[key]
  }
  return {
    version: Math.max(now, previous + 1),
    prior: {
      content: typeof prior.content === 'string' ? prior.content : '',
      metadata: carried,
      intermediateSteps: Array.isArray(prior.intermediateSteps) ? prior.intermediateSteps : undefined
    }
  }
}

/**
 * An API-lane approval resume CONTINUES the message the card was on.
 *
 * The resume writes into the same assistant id (`messageId = providedMessageId` in
 * send-routed), and its stream starts EMPTY: the AI SDK carries on from the approval, it
 * does not replay the turn. `redis.saveMessage` then REPLACES content and shallow-merges
 * metadata, so saving the resume's own output as the whole message dropped everything the
 * message already held — the words the agent wrote before the card, any tool it ran before
 * asking (its zip reference AND its place in the `zipIds` allow-list), and its steps.
 * Measured live on 2026-09-18, on the code before the reload-loop fix as well as after it:
 * "Checking with the shell now." before the card, gone after the click
 * (`_local/approval-resume-proof/words-before-card*.json`).
 *
 * The rule: what a resume writes is APPENDED to what the message held. A failure adds only
 * the failure facts; it never replaces the words with an error line.
 */

export type StoredAssistantRecord = {
  role?: unknown
  content?: unknown
  metadata?: unknown
  intermediateSteps?: unknown
}

export type ResumedAssistantWrite = {
  content: string
  metadata: Record<string, any>
  intermediateSteps?: any[]
}

/** The message as stored before the resume writes it, or null when there is none. */
export async function readStoredAssistantRecord(
  sessionId: string,
  messageId: string
): Promise<StoredAssistantRecord | null> {
  if (!sessionId || !messageId) return null
  const record = (await redis.execute(async (client) =>
    client.json.get(`message:${sessionId}:${messageId}`)
  )) as StoredAssistantRecord | null
  if (!record || typeof record !== 'object' || record.role !== 'assistant') return null
  return record
}

function storedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The words before the card, then a blank line, then what the resume produced — the same
 * separator `composeToolStreamContent` puts between text and a tool reference.
 */
export function joinResumedContent(prior: unknown, resumed: string): string {
  const before = storedText(prior)
  const after = typeof resumed === 'string' ? resumed : ''
  if (!before) return after
  if (!after.trim()) return before
  // A resume that ever replays the earlier text must not double it.
  if (after.trimStart().startsWith(before)) return after
  return `${before}\n\n${after.replace(/^\s+/, '')}`
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

function objectList(value: unknown): Record<string, any>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, any> => Boolean(entry) && typeof entry === 'object')
    : []
}

function unionStrings(prior: unknown, resumed: unknown): string[] {
  return Array.from(new Set([...stringList(prior), ...stringList(resumed)]))
}

function unionBy(prior: unknown, resumed: unknown, keyOf: (entry: Record<string, any>) => string): Record<string, any>[] {
  const seen = new Set<string>()
  const merged: Record<string, any>[] = []
  for (const entry of [...objectList(prior), ...objectList(resumed)]) {
    const key = keyOf(entry)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    merged.push(entry)
  }
  return merged
}

function concatLists(prior: unknown, resumed: unknown): Record<string, any>[] {
  return [...objectList(prior), ...objectList(resumed)]
}

/**
 * The Tool Notes record (`zipControl`) of a message whose reply-end step ran twice: at the
 * pause and at the resume. Both parts' notes are the same message's notes, earlier first, and
 * both parts' asks (hold, release, the parked zip actions) stay on the record.
 */
function mergeZipControl(prior: unknown, resumed: unknown): Record<string, any> | undefined {
  const before = prior && typeof prior === 'object' ? (prior as Record<string, any>) : null
  const after = resumed && typeof resumed === 'object' ? (resumed as Record<string, any>) : null
  if (!before) return after ?? undefined
  if (!after) return before
  const merged: Record<string, any> = {
    ...before,
    ...after,
    unzip: unionStrings(before.unzip, after.unzip),
    zip: unionStrings(before.zip, after.zip),
    toolResultsSummary: concatLists(before.toolResultsSummary, after.toolResultsSummary)
  }
  for (const key of ['hold', 'release'] as const) {
    const union = unionStrings(before[key], after[key])
    if (union.length > 0) merged[key] = union
    else delete merged[key]
  }
  return merged
}

/** What the reply-end step did (`zipHolds`), at the pause and at the resume, in order. */
function mergeZipHolds(prior: unknown, resumed: unknown): Record<string, any> | undefined {
  const before = prior && typeof prior === 'object' ? (prior as Record<string, any>) : {}
  const after = resumed && typeof resumed === 'object' ? (resumed as Record<string, any>) : {}
  const merged: Record<string, any> = {}
  for (const key of ['held', 'released', 'moved'] as const) {
    const list = concatLists(before[key], after[key])
    if (list.length > 0) merged[key] = list
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

// ---------------------------------------------------------------------------------------------
// BL-525: the numbers of a message written in two halves
//
// An approval resume finishes the message the card was on, and every number it writes (the
// message's `usage`, `performance`, `delegated`; the snapshot's `responseSummary`, `llmSummary`,
// `delegated`, `executionMetadata.typesafeCalls`) used to replace the paused half's, so the Token
// Panel's running cost dropped the first half and its Subagent spend. The rule, per field:
//
// - Tokens (message `usage`, snapshot `responseSummary.usage` and `llmSummary.totalUsage`): the
//   two halves added, field by field. A count only one half reported is unknown for the message
//   (left out of the message's usage, `value: null` in the snapshot), and a half with no usage at
//   all makes the whole message's usage unknown (`null`): a sum of one half would read as the
//   whole reply's, exact. Missing usage is never a zero.
// - Delegated spend: both halves' runs (`mergeDelegatedSummaries`); a half with no Subagent or
//   Worker keeps the other half's runs, never null.
// - Judge Juice calls: the paused half's rows, then the resume's.
// - Performance: each field by its own definition. `timeToFirstOutputMs` is the FIRST model
//   call's, so the paused half's; `outputTokensPerSecond` is the final answer call's, so the
//   resume's; `responseTimeMs` and `modelCalls` are totals over the send, so the two added (unknown
//   when either half lacks one).
// - Reasoning summary: both halves' reasoning, earlier first, a blank line between (the words'
//   rule), because both are the agent's reasoning for this one message; a resume that replays the
//   earlier reasoning is not doubled.

function plainRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** One frozen prefix plus only this half, never a freshly read/already joined ledger. */
export function mergeResumedObservedUsage(
  priorObserved: unknown, priorUsage: unknown, resumedObserved: unknown, resumedUsage: unknown,
): ObservedUsage | undefined {
  const before = readObservedUsage(priorObserved)
  const after = readObservedUsage(resumedObserved)
  const beforeCounts = observedCounts(normalizeUsageLike(priorUsage))
  const afterCounts = observedCounts(normalizeUsageLike(resumedUsage))
  if (!before && !after && Boolean(beforeCounts) === Boolean(afterCounts)) return undefined
  const parts: ObservedUsage['parts'] = [
    ...(before?.parts ?? (beforeCounts ? [{ source: 'run-usage-prefix' as const, counts: beforeCounts }] : [])),
    ...(after?.parts ?? (afterCounts ? [{ source: 'run-usage-prefix' as const, counts: afterCounts }] : [])),
  ]
  return parts.length > 0 ? { completeness: 'partial', parts } : undefined
}

function snapshotCounts(usage: unknown): Record<string, number> | null {
  const record = plainRecord(usage)
  if (!record) return null
  const counts: Record<string, number> = {}
  for (const field of TOKEN_FIELDS) {
    const count = finiteNumber(record[field]?.value)
    if (count !== null) counts[field] = count
  }
  return Object.keys(counts).length > 0 ? counts : null
}

/** The message's `usage` for both halves: a field both reported, added; `null` when either half reported none. */
export function mergeResumedUsage(prior: unknown, resumed: unknown): Record<string, any> | null | undefined {
  const before = normalizeUsageLike(prior)
  const after = normalizeUsageLike(resumed)
  if (!before && !after) {
    // Neither half says anything: leave the key alone, unless one half said "unknown" (null).
    return prior === null || resumed === null ? null : undefined
  }
  if (!before || !after) return null
  const summed: Record<string, number> = {}
  for (const field of TOKEN_FIELDS) {
    const a = finiteNumber(before[field])
    const b = finiteNumber(after[field])
    if (a !== null && b !== null) summed[field] = a + b
  }
  return buildUsageLike(summed) ?? null
}

/** The message's `performance` for both halves, each field by its own definition (see above). */
export function mergeResumedPerformance(prior: unknown, resumed: unknown): Record<string, any> | null | undefined {
  const before = plainRecord(prior)
  const after = plainRecord(resumed)
  if (!before && !after) return prior === null || resumed === null ? null : undefined
  const merged: Record<string, any> = {
    schemaVersion: 1,
    source: after?.source ?? before?.source
  }
  const firstOutput = finiteNumber(before?.timeToFirstOutputMs)
  if (firstOutput !== null) merged.timeToFirstOutputMs = firstOutput
  const finalSpeed = finiteNumber(after?.outputTokensPerSecond)
  if (finalSpeed !== null) merged.outputTokensPerSecond = finalSpeed
  for (const total of ['responseTimeMs', 'modelCalls'] as const) {
    const a = finiteNumber(before?.[total])
    const b = finiteNumber(after?.[total])
    if (a !== null && b !== null) merged[total] = a + b
  }
  const measured = ['timeToFirstOutputMs', 'outputTokensPerSecond', 'responseTimeMs', 'modelCalls'].some(
    (key) => key in merged
  )
  return measured ? merged : null
}

/** Both halves' reasoning, earlier first; the words' own join rule. */
export function mergeResumedReasoning(prior: unknown, resumed: unknown): string | undefined {
  const before = typeof prior === 'string' ? prior : ''
  const after = typeof resumed === 'string' ? resumed : ''
  if (!before.trim() && !after.trim()) return typeof resumed === 'string' ? resumed : typeof prior === 'string' ? prior : undefined
  return joinResumedContent(before, after)
}

const CONFIDENCE_ORDER: ExecutionConfidenceLevel[] = ['exact', 'near', 'estimated', 'speculative']

function weakerConfidence(a: unknown, b: unknown): ExecutionConfidenceLevel {
  const rank = (value: unknown) => {
    const index = CONFIDENCE_ORDER.indexOf(value as ExecutionConfidenceLevel)
    return index === -1 ? CONFIDENCE_ORDER.length - 1 : index
  }
  return CONFIDENCE_ORDER[Math.max(rank(a), rank(b))]
}

function joinSources(a: unknown, b: unknown): string | undefined {
  const left = typeof a === 'string' && a ? a : null
  const right = typeof b === 'string' && b ? b : null
  if (left && right) return left === right ? left : `${left} + ${right}`
  return left ?? right ?? undefined
}

function mergeTokenStat(prior: unknown, resumed: unknown): ExecutionTokenStat | undefined {
  const before = plainRecord(prior)
  const after = plainRecord(resumed)
  if (!before && !after) return undefined
  const a = finiteNumber(before?.value)
  const b = finiteNumber(after?.value)
  const source = joinSources(before?.source, after?.source)
  return {
    value: a !== null && b !== null ? a + b : null,
    confidence: weakerConfidence(before?.confidence ?? 'speculative', after?.confidence ?? 'speculative'),
    ...(source ? { source } : {})
  }
}

/** A snapshot's token usage for both halves: each count added when both halves reported it, else unknown. */
export function mergeResumedTokenUsage(prior: unknown, resumed: unknown): ExecutionTokenUsage | null {
  const before = plainRecord(prior)
  const after = plainRecord(resumed)
  if (!before && !after) return null
  // A half with no usage at all is a half whose every count is unknown: `mergeTokenStat` then
  // answers `value: null` for each count the other half has, and the three totals are always kept.
  const merged: Record<string, ExecutionTokenStat> = {}
  for (const field of TOKEN_FIELDS) {
    const stat = mergeTokenStat(before?.[field] ?? { value: null, confidence: 'estimated' }, after?.[field] ?? { value: null, confidence: 'estimated' })
    const reported = Boolean(before?.[field] || after?.[field])
    if (stat && (reported || field === 'inputTokens' || field === 'outputTokens' || field === 'totalTokens')) {
      merged[field] = stat
    }
  }
  return merged as unknown as ExecutionTokenUsage
}

function mergeResponseSummary(prior: unknown, resumed: unknown): ExecutionResponseSummary | null {
  const before = plainRecord(prior) as ExecutionResponseSummary | null
  const after = plainRecord(resumed) as ExecutionResponseSummary | null
  if (!before && !after) return null
  const observedUsage = mergeResumedObservedUsage(
    before?.observedUsage, snapshotCounts(before?.usage), after?.observedUsage, snapshotCounts(after?.usage),
  )
  const base = after ?? before!
  const joinedUsage = mergeResumedTokenUsage(before?.usage, after?.usage)!
  const usage = observedUsage ? mergeResumedTokenUsage(null, joinedUsage)! : joinedUsage
  if (!before || !after) return {
    ...base,
    usage,
    ...(observedUsage ? { observedUsage } : {}),
  }
  const notes = Array.from(new Set([...(before.notes ?? []), ...(after.notes ?? [])]))
  return {
    ...after,
    content: {
      value: joinResumedContent(before.content?.value, after.content?.value ?? ''),
      confidence: weakerConfidence(before.content?.confidence, after.content?.confidence)
    },
    usage,
    ...(observedUsage ? { observedUsage } : {}),
    toolCallsCount:
      mergeTokenStat(before.toolCallsCount, after.toolCallsCount) ?? after.toolCallsCount,
    ...(notes.length > 0 ? { notes } : {})
  }
}

function mergeLlmSummary(prior: unknown, resumed: unknown): ExecutionLlmSummary | null {
  const before = plainRecord(prior) as ExecutionLlmSummary | null
  const after = plainRecord(resumed) as ExecutionLlmSummary | null
  if (!after) return (resumed as null) ?? null
  // `callsCount` is recounted from the merged call list by `executionViewerService.updateSnapshot`.
  return {
    ...after,
    totalUsage: mergeResumedTokenUsage(before?.totalUsage ?? null, after.totalUsage) as ExecutionTokenUsage,
    breakdownConfidence: before
      ? weakerConfidence(before.breakdownConfidence, after.breakdownConfidence)
      : after.breakdownConfidence
  }
}

/**
 * A snapshot write of an approval resume, continued from the paused half's snapshot (read once,
 * before the resume recorded its own). Every write of the resume passes its patch through this,
 * always against the SAME frozen prior, so writing twice never counts the first half twice.
 * Only the fields the patch carries change: `responseSummary` and `llmSummary` (tokens added,
 * see the rule above), `delegated` (both halves' runs). A patch that names `delegated` as null
 * (this half ran none) keeps the paused half's.
 */
export function continueResumedSnapshotPatch(
  prior: Pick<ExecutionSnapshot, 'responseSummary' | 'llmSummary' | 'delegated'> | null | undefined,
  patch: Partial<ExecutionSnapshot>
): Partial<ExecutionSnapshot> {
  if (!prior) return patch
  const next: Partial<ExecutionSnapshot> = { ...patch }
  if ('responseSummary' in patch) next.responseSummary = mergeResponseSummary(prior.responseSummary, patch.responseSummary)
  if ('llmSummary' in patch) next.llmSummary = mergeLlmSummary(prior.llmSummary, patch.llmSummary)
  if ((next.responseSummary?.observedUsage || prior.responseSummary?.observedUsage) && next.llmSummary) {
    next.llmSummary = { ...next.llmSummary, totalUsage: mergeResumedTokenUsage(null, next.llmSummary.totalUsage)! }
  }
  if ('delegated' in patch) next.delegated = mergeDelegatedSummaries(prior.delegated, patch.delegated)
  return next
}

/** The Judge Juice rows of both halves: the paused half's first (BL-525). */
export function withPriorTypesafeCalls(prior: unknown, own: unknown): unknown[] {
  const rows = (value: unknown) => (Array.isArray(value) ? value : [])
  return [...rows(prior), ...rows(own)]
}

/**
 * `redis.saveMessage` merges metadata SHALLOWLY, so every list the resume sets replaces the
 * stored one. The lists that name what the earlier part of the message holds are unioned
 * here: the zip allow-list (a reference missing from `zipIds` is not trusted), the zip
 * references, image zips, and delivered steers. Everything else is the resume's, as before.
 *
 * SA-129 P2b (BL-350): the reply-end step runs at the pause AND at the resume, and each writes
 * the same four keys. Both parts belong to one message, so the resume keeps the first part's:
 * its Tool Notes (`zipControl`, notes earlier first), its memory saves (`memorySaves`, by id, so
 * the chips show every save), its `controlErrors` (the resume's compile never showed the agent
 * the first part's errors; the next turn's DCM reads this message's list, so a replaced list
 * lost them without a word), and what the step did (`zipHolds`).
 */
export function mergeResumedMetadata(prior: unknown, resumed: Record<string, any>): Record<string, any> {
  const before = prior && typeof prior === 'object' ? (prior as Record<string, any>) : {}
  const merged: Record<string, any> = { ...resumed }

  for (const key of ['zipIds', 'imageZipIds'] as const) {
    const union = unionStrings(before[key], resumed[key])
    if (union.length > 0) merged[key] = union
  }

  const zipReferences = unionBy(before.zipReferences, resumed.zipReferences, (entry) =>
    typeof entry.reference === 'string' ? entry.reference : typeof entry.zipId === 'string' ? entry.zipId : ''
  )
  if (zipReferences.length > 0) merged.zipReferences = zipReferences

  const steers = unionBy(before.steers, resumed.steers, (entry) =>
    typeof entry.steerId === 'string' ? entry.steerId : ''
  )
  if (steers.length > 0) merged.steers = steers

  const zipControl = mergeZipControl(before.zipControl, resumed.zipControl)
  if (zipControl) merged.zipControl = zipControl

  const memorySaves = unionBy(before.memorySaves, resumed.memorySaves, (entry) =>
    typeof entry.id === 'string' ? entry.id : ''
  )
  if (memorySaves.length > 0) merged.memorySaves = memorySaves

  const controlErrors = concatLists(before.controlErrors, resumed.controlErrors)
  if (controlErrors.length > 0) merged.controlErrors = controlErrors

  const zipHolds = mergeZipHolds(before.zipHolds, resumed.zipHolds)
  if (zipHolds) merged.zipHolds = zipHolds

  // BL-525: the message's numbers count both halves (the rule is the BL-525 block above).
  // `null` is written on purpose: `saveMessage` keeps a key the write leaves out, so an unknown
  // sum must be said as `null`, or the paused half's number would stand for the whole message.
  const usage = mergeResumedUsage(before.usage, resumed.usage)
  if (usage !== undefined) merged.usage = usage
  const observedUsage = mergeResumedObservedUsage(before.observedUsage, before.usage, resumed.observedUsage, resumed.usage)
  if (observedUsage) {
    merged.observedUsage = observedUsage
    merged.usage = null // Omission would let a previously known canonical total survive.
  }
  const performance = mergeResumedPerformance(before.performance, resumed.performance)
  if (performance !== undefined) merged.performance = performance
  const reasoningSummary = mergeResumedReasoning(before.reasoningSummary, resumed.reasoningSummary)
  if (reasoningSummary !== undefined) merged.reasoningSummary = reasoningSummary
  const delegated = mergeDelegatedSummaries(before.delegated, resumed.delegated)
  if (delegated) merged.delegated = delegated

  return merged
}

export function mergeResumedSteps(prior: unknown, resumed: unknown): any[] | undefined {
  const steps = [...(Array.isArray(prior) ? prior : []), ...(Array.isArray(resumed) ? resumed : [])]
  return steps.length > 0 ? steps : undefined
}

/** The resume's write, continued from the stored message. */
export function composeInPlaceResumeMessage(
  prior: StoredAssistantRecord,
  resumed: ResumedAssistantWrite
): ResumedAssistantWrite {
  return {
    content: joinResumedContent(prior.content, resumed.content),
    metadata: mergeResumedMetadata(prior.metadata, resumed.metadata),
    intermediateSteps: mergeResumedSteps(prior.intermediateSteps, resumed.intermediateSteps)
  }
}

/**
 * What a failed turn stores as its content. A turn that produced nothing normally stores
 * its error line, so a reload shows the failure instead of a stuck "Thinking...". A resume
 * that failed must keep the words the message already held; the failure travels in the
 * metadata (`response_failed`, `error_message`), which draws the failure banner anyway.
 */
export function resolveFailedTurnContent(input: {
  inPlaceResume: boolean
  errorText: string
  prior: StoredAssistantRecord | null
}): string {
  if (!input.inPlaceResume) return input.errorText
  return storedText(input.prior?.content) || input.errorText
}

/** The same test `handleBatshitAgentStream` applies to decide a send has a user turn. */
export function hasUserTurnContent(content: unknown): boolean {
  return (
    (typeof content === 'string' && content.trim().length > 0) ||
    (Array.isArray(content) && content.length > 0) ||
    (content != null && typeof content !== 'string' && !Array.isArray(content))
  )
}

/**
 * Does this send resume an approval IN PLACE — into the message the card was on? Approval
 * responses and no user turn of its own, exactly `isApprovalResumeWithoutUserTurn` in the
 * stream handler. A managed CLI control resume is a NEW turn with its own ids, so it never is.
 */
export function isInPlaceApprovalResume(input: {
  approvalResponseCount: number
  content: unknown
  controlResumeContent: string | null
}): boolean {
  if (input.controlResumeContent !== null) return false
  if (input.approvalResponseCount <= 0) return false
  return !hasUserTurnContent(input.content)
}
