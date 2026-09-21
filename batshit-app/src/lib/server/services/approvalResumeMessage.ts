import { redis } from '$lib/server/redis'
import type { ApprovalResumeStart } from '$lib/utils/approvalResumeStream'

export function createApprovalResumeStart(prior: StoredAssistantRecord, now = Date.now()): ApprovalResumeStart {
  const metadata = prior.metadata && typeof prior.metadata === 'object' ? prior.metadata as Record<string, any> : {}
  const previous = Number.isSafeInteger(metadata.approvalResumeVersion) ? metadata.approvalResumeVersion : 0
  const carried: Record<string, any> = {}
  for (const key of ['zipIds', 'zipReferences', 'imageZipIds', 'steers', 'toolApprovals', 'answeredApprovalIds', 'reasoningSummary', 'planSummary', 'planItems']) {
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

/**
 * `redis.saveMessage` merges metadata SHALLOWLY, so every list the resume sets replaces the
 * stored one. The lists that name what the earlier part of the message holds are unioned
 * here: the zip allow-list (a reference missing from `zipIds` is not trusted), the zip
 * references, image zips, and delivered steers. Everything else is the resume's, as before.
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
