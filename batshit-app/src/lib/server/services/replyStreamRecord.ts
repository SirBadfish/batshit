/**
 * A running reply's recorded stream events, and the one rebuild of its text (BL-775).
 *
 * The server owns an assistant reply's saved record. A reply's text has ONE maker: the stream path,
 * where `/api/sse` runs each chunk through the zip detector and records the result here. At the
 * reply's end send-routed's finalize runs three steps in this order: `flushHeldReplyText` (the words
 * the detector still holds join the record while the reply is open), `closeReplyRecord` (a late
 * event is refused from now on), and the rebuild (`rebuildRecordedReply`). It saves the rebuild,
 * and only then publishes `end`, so every reader that acts on `end` finds the record, and
 * the stored reply, each tab's text, and the next prompt are the same bytes. Until BL-775 `/api/sse`
 * kept this state itself, recorded nothing for a chat with no listener, rebuilt the text inside its
 * `end` case, and every tab saved that rebuild back over the server's own save.
 *
 * What lives here, per chat (in process, no Redis key, like `wakeRunRegistry.ts`):
 * - the replay buffer: a JOINING AID for a tab that subscribes mid-reply, capped at
 *   `MAX_REPLAY_EVENTS`, each message-scoped event stamped with a stable `sseEventId`;
 * - the reconstruction: per message, its start (pinned, so a capped buffer never loses the owner of
 *   its tail) and every content and tool event, adjacent text chunks joined, never capped, which is
 *   what the rebuild reads;
 * - the terminal cleanup timers (a finished message's entries go 5 s after its terminal event);
 * - the zip detector the stream path uses (`replyZipDetection`), because the flush takes the
 *   words it still holds, settled (a block that never closed, a lone start of its tag, a pair held
 *   after a stray backtick, zipped then: BL-779), and the rebuild takes the stream-made zip
 *   references from it.
 *
 * The rebuild's rules are the `/api/sse` `end` case's, moved unchanged, plus the edits the chat page
 * used to make before it saved (`replyEndContent.ts`).
 */
import { logger } from '$lib/utils/logger'
import { readApprovalResumeStart } from '$lib/utils/approvalResumeStream'
import { mergeResumedSteps } from '$lib/server/services/approvalResumeMessage'
import { buildEndStreamingContent } from '$lib/server/services/sseEndContentBuilder'
import { stripLeadingSubagentEchoText } from '$lib/server/services/finalAssistantTextSanitizer'
import { sanitizeAssistantContent } from '$lib/server/services/sseEndContentSanitizer'
import { ZipDetectionService } from '$lib/server/services/zipDetection'
import { finalizeAllZipBlocks } from '$lib/server/zipService'
import { redis } from '$lib/server/redis'
import type { ZipReference } from '$lib/server/zipService'
import {
  collectTrustedZipIdsFromMetadata,
  extractZipIdFromReference,
  neutralizeAllClipReferenceSyntax,
  neutralizeUntrustedZipReferenceSyntax,
  scanZipReferences
} from '$lib/utils/zipReferenceSafety'
import { replaceBracedTokens } from '$lib/utils/braceScan'
import { stripReplyControlBlocks } from '$lib/utils/replyControl'
import { finishReplyEndContent, replyEndZipIds } from '$lib/utils/replyEndContent'
import { stripGroupChatPresentationControls } from '$lib/server/services/groupChatUtils'
import { beginP5CanonicalWrite, failP5CanonicalCustody, p5CanonicalWriteOwner, p5CanonicalWriteUnknown, observeP5CanonicalReceipt,
  type P5CanonicalWrite, type P5OriginalPreparation, type P5OriginalRequest, type P5ApiReplyPart } from './appActions/mcp/originalTask'

const p5CanonicalSaves = new WeakMap<object, { write: P5CanonicalWrite; owner: P5OriginalRequest }>()
/** The canonical/failure writers use this SAME save, never a readback or saved flag.
 * Ordinary callers have no original custody and retain the existing single await. */
export async function persistCanonicalReply(message: Parameters<typeof redis.saveMessage>[0], preparation?: P5OriginalPreparation, apiPart?: P5ApiReplyPart): Promise<void> {
  let write: P5CanonicalWrite | undefined
  let custodyFailure: unknown
  let custodyFailed = false
  const retainCustodyFailure = () => {
    // Bookkeeping can never prevent the mandatory write or replace its error.
    try { failP5CanonicalCustody(preparation) } catch { /* Keep the original failure and no positive receipt. */ }
  }
  try { write = beginP5CanonicalWrite(preparation, message, apiPart) }
  catch (error) { custodyFailed = true; custodyFailure = error; retainCustodyFailure() }
  try { await redis.saveMessage(message) }
  catch (error) {
    if (write) { try { p5CanonicalWriteUnknown(write) } catch { /* retain original save failure and restrictive receipt */ } }
    throw error
  }
  if (custodyFailed) {
    // The save is KNOWN. Throwing a bookkeeping-only error here would make
    // ordinary finalizers replay their save/failure writer and misreport loss.
    logger.error('[P5] Canonical reply was saved; original request custody remains unavailable.', custodyFailure)
  } else if (write) {
    // Actual known acknowledgement is captured BEFORE any subsequent await or end.
    const receipt = Object.freeze({})
    try {
      p5CanonicalSaves.set(receipt, Object.freeze({ write, owner: p5CanonicalWriteOwner(write) }))
      observeP5CanonicalReceipt(write, receipt)
    } catch (error) {
      p5CanonicalSaves.delete(receipt)
      retainCustodyFailure()
      logger.error('[P5] Canonical reply was saved; original request acknowledgement custody remains unavailable.', error)
    }
  }
}
export function readP5CanonicalSaveReceipt(receipt: object): Readonly<{ write: P5CanonicalWrite; owner: P5OriginalRequest }> {
  const saved = p5CanonicalSaves.get(receipt)
  if (!saved) throw new Error('The actual canonical save receipt is unavailable.')
  return saved
}

export type RecordedStreamEvent = {
  type: string
  messageId?: string
  sseEventId?: string
  [key: string]: any
}

type ReplyReconstruction = {
  start: RecordedStreamEvent | null
  events: RecordedStreamEvent[]
  /**
   * The stream-made zip references, taken from the detector at the first rebuild. Kept here,
   * because taking them empties the detector and a second finalize of the same reply (its first
   * save threw, BL-353) rebuilds again.
   */
  streamZipReferences?: ZipReference[]
  /**
   * BL-759: a retract of this reply could not be taken back exactly (`superseded`), so its record
   * is not trusted (send-routed saves its own copy). Every later retract is refused as well, so no
   * tab is sent a `content_reset` built from a record that still holds the first fragment.
   */
  retractSuperseded?: boolean
}

type ChatStreamRecord = {
  events: RecordedStreamEvent[]
  reconstructionByMessage: Map<string, ReplyReconstruction>
}

/**
 * The replay buffer is a joining aid, not a transcript, so it keeps the newest slice. A woken
 * turn may run for four hours and three may run at once; the rebuild reads the uncapped
 * reconstruction, so this cap can never shorten a stored reply.
 */
export const MAX_REPLAY_EVENTS = 2000

/** How long a finished message's entries stay after its terminal event, for a tab that joins late. */
export const FINISHED_REPLY_RECORD_TTL_MS = 5000

const RECONSTRUCTION_EVENT_TYPES = new Set([
  'chunk',
  'tool_start',
  'tool-call',
  'tool_call',
  'tool-result',
  'tool_result'
])

/**
 * How long one forwarded event may take (BL-775). The rebuild itself is an in-process call and
 * needs no forward, but each event reaches the record through one, and forwards go one after
 * another. A forward under this limit is waited for, in order: SvelteKit's in-process fetch runs
 * `/api/sse`'s handler to the end, so a slow forward still records its event. A forward past it
 * makes the reply a gap at once (the finalize saves its own copy, with the notice), and later
 * events, the terminal ones included, go on without waiting for it. A setting object so a test
 * can shorten it.
 */
export const REPLY_EVENT_FORWARD_LIMIT = { ms: 10_000 }

/** How long a finished reply stays closed to late forwards (an approval resume's `start` reopens it). */
export const CLOSED_REPLY_TTL_MS = 10 * 60_000

/**
 * BL-871 (d): the events of a reply that reach `/api/sse` even while it stalls, strictly in order
 * (each is sent only once the one before it has answered), so `complete` never overtakes `end`: the
 * terminal events, and `steer_delivered`, which no tab can rebuild from `end` (a steer the model
 * read but a tab never heard of is marked "Not sent" when the reply ends, with a Send now that would
 * send it twice). Every other event is live only: `end` carries what it showed.
 */
export const REPLY_ORDERED_EVENT_TYPES: ReadonlySet<string> = new Set(['steer_delivered', 'end', 'error', 'complete'])

/**
 * BL-871 (d): how long an ordered event waits for the ordered event before it to answer. Past it,
 * it is not sent at all (logged), and neither is any later ordered event of the reply, so the order
 * still holds. The closed mark's lifetime: past it the reply no longer refuses late forwards either.
 * A setting object so a test can shorten it.
 */
export const REPLY_ORDERED_FORWARD_GIVE_UP = { ms: CLOSED_REPLY_TTL_MS }

/**
 * Whether `promise` settles within `ms`. The timer is cleared either way; the promise itself is
 * never cancelled (a forward left running still records, or is refused as late). `unref` keeps a
 * long wait from holding the process open (BL-871 d: the terminal events' bounded tail).
 */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
  options: { unref?: boolean } = {}
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = promise.then(
    () => true,
    () => true
  )
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    if (options.unref) (timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([settled, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * BL-759: a managed lane takes back a segment of the reply (a message the removed Codex CLI lane
 * dropped and started again). Not recorded as an event: it removes the segment's chunks from the record.
 */
export const TEXT_RETRACT_EVENT_TYPE = 'text_retract'

/**
 * Every event type the rebuild reads: a reply's `start` and its content and tool events, and a
 * retract, which changes what the rebuild reads. A forward of one of these that fails or passes its
 * limit is a gap (BL-775).
 */
export const REPLY_RECORDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'start',
  ...RECONSTRUCTION_EVENT_TYPES,
  TEXT_RETRACT_EVENT_TYPE
])

/**
 * The top-level metadata key of a reply the finalize saved from its own copy because the record
 * could not be had (a forward of the reply was not recorded, or there was no record). The chat
 * shows a plain notice for it; condition 3 of the BL-775 plan.
 */
export const REPLY_SAVED_FROM_OWN_COPY_KEY = 'replySavedFromOwnCopy'

const records = new Map<string, ChatStreamRecord>()
/**
 * One counter for the whole process: an event's `sseEventId` is unique without a per-chat entry,
 * so stamping an event that is only forwarded (never recorded) keeps nothing in memory.
 */
let nextEventIndex = 0
const cleanupTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
/**
 * A reply whose finalize has rebuilt (or given up on) the record: the approval resume version of
 * the part that finalize ended (0 for a reply's first part) and the mark's expiry timer.
 */
type ClosedReply = { version: number; timer: ReturnType<typeof setTimeout> }
/**
 * Replies whose finalize has rebuilt (or given up on) the record, per chat. A content or tool event
 * for one of them is late: `/api/sse` refuses it before its zip detection, so a forward that answers
 * after the finalize can neither close an `<error>` block into a zip no reply names nor bring back a
 * record the cleanup removed. A `start` for one of them is late too unless it opens a NEWER part
 * (BL-871 a): only an approval resume with a newer version reopens a closed reply.
 */
const closedReplies = new Map<string, Map<string, ClosedReply>>()

/** The zip detector of the stream path. One per process: its scan state is keyed by chat and message. */
export const replyZipDetection = new ZipDetectionService()

function recordFor(sessionId: string): ChatStreamRecord {
  let record = records.get(sessionId)
  if (!record) {
    record = {
      events: [],
      reconstructionByMessage: new Map()
    }
    records.set(sessionId, record)
  }
  return record
}

/** Gives a message-scoped event its stable `sseEventId`, once; a replayed event keeps it. */
export function stampReplyEventId<T extends RecordedStreamEvent>(sessionId: string, event: T): T {
  if (!event?.messageId) return event
  if (typeof event.sseEventId === 'string' && event.sseEventId.trim().length > 0) return event
  nextEventIndex += 1
  event.sseEventId = `${event.messageId}:${nextEventIndex}`
  return event
}

function pushReplayEvent(record: ChatStreamRecord, event: RecordedStreamEvent) {
  record.events.push(event)
  if (record.events.length > MAX_REPLAY_EVENTS) {
    record.events.splice(0, record.events.length - MAX_REPLAY_EVENTS)
  }
}

function appendReconstructionEvent(record: ChatStreamRecord, event: RecordedStreamEvent) {
  const messageId = event.messageId
  if (!messageId || !RECONSTRUCTION_EVENT_TYPES.has(event.type)) return

  let reconstruction = record.reconstructionByMessage.get(messageId)
  if (!reconstruction) {
    reconstruction = { start: null, events: [] }
    record.reconstructionByMessage.set(messageId, reconstruction)
  }

  const last = reconstruction.events[reconstruction.events.length - 1]
  if (
    event.type === 'chunk' &&
    last?.type === 'chunk' &&
    typeof last.content === 'string' &&
    typeof event.content === 'string' &&
    // BL-759: a segment can be taken back by its name, so its text is never joined to another's.
    last.segmentId === event.segmentId
  ) {
    // The rebuild needs the whole text, not one object per provider delta.
    last.content += event.content
    return
  }

  reconstruction.events.push({ ...event })
}

/**
 * A reply's `start`. An approval resume reuses its message id on purpose: the earlier run's replay
 * and reconstruction must not bleed into the continuation (its terminal cleanup waits 5 s).
 * Answers false, and changes nothing, for a late start of a closed reply (BL-871 a,
 * `isLateReplyStart`): checked here again, right before the write, as `recordReplyEvent` does.
 */
export function startReplyRecord(sessionId: string, startEvent: RecordedStreamEvent): boolean {
  if (isLateReplyStart(sessionId, startEvent)) {
    logger.warn('[ReplyRecord] BL-871: refused a late start of a reply already saved', {
      sessionId,
      messageId: startEvent.messageId
    })
    return false
  }
  stampReplyEventId(sessionId, startEvent)
  if (startEvent.messageId) {
    clearReplyRecordCleanup(sessionId, startEvent.messageId)
    reopenReplyRecord(sessionId, startEvent.messageId)
  }
  const record = recordFor(sessionId)
  if (startEvent.messageId) {
    record.events = record.events.filter((entry) => entry.messageId !== startEvent.messageId)
    record.reconstructionByMessage.set(startEvent.messageId, { start: { ...startEvent }, events: [] })
  }
  pushReplayEvent(record, startEvent)
  return true
}

/** Any other message-scoped event. Answers false for an event that names no message (not recorded). */
export function recordReplyEvent(sessionId: string, event: RecordedStreamEvent): boolean {
  if (!event.messageId) {
    logger.debug('[ReplyRecord] Skipping a messageId-less event', { sessionId, eventType: event.type })
    return false
  }
  // Checked again here, right before the write: a forward can pass `/api/sse`'s arrival check and
  // reach this point after the finalize closed the reply.
  if (isLateReplyEvent(sessionId, event)) {
    logger.warn('[ReplyRecord] BL-775: refused a late event of a reply already saved', {
      sessionId,
      messageId: event.messageId,
      eventType: event.type
    })
    return false
  }
  stampReplyEventId(sessionId, event)
  const record = recordFor(sessionId)
  appendReconstructionEvent(record, event)
  pushReplayEvent(record, event)
  return true
}

/**
 * An event a joining tab must see in order but the rebuild never reads (a Claude approval card's
 * events, BL-496: the card lives in the reply's `metadata.toolApprovals`, not in its text).
 */
export function recordReplayOnlyEvent(sessionId: string, event: RecordedStreamEvent): boolean {
  if (!event.messageId) return false
  stampReplyEventId(sessionId, event)
  pushReplayEvent(recordFor(sessionId), event)
  return true
}

/**
 * The finalize is about to rebuild this reply (every forward it waited for has answered, or the
 * wait ran out): from now on a content or tool event for it is late and is refused. The finalize
 * calls `flushHeldReplyText` first: the words the zip detector still holds are a content event too.
 * `approvalResumeVersion` names the part this finalize ended (0 for the reply's first part, an
 * approval resume's own version for its continuation): from now on a `start` is late as well
 * unless it carries a newer version (BL-871 a). The mark keeps the newest version it was given.
 */
export function closeReplyRecord(sessionId: string, messageId: string, approvalResumeVersion = 0) {
  const closed = closedReplies.get(sessionId) ?? new Map<string, ClosedReply>()
  const existing = closed.get(messageId)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => reopenReplyRecord(sessionId, messageId), CLOSED_REPLY_TTL_MS)
  // A closed mark must never hold the process open.
  ;(timer as { unref?: () => void }).unref?.()
  const version = Math.max(existing?.version ?? 0, partVersion(approvalResumeVersion))
  closed.set(messageId, { version, timer })
  closedReplies.set(sessionId, closed)
}

function reopenReplyRecord(sessionId: string, messageId: string) {
  const closed = closedReplies.get(sessionId)
  const mark = closed?.get(messageId)
  if (!closed || !mark) return
  clearTimeout(mark.timer)
  closed.delete(messageId)
  if (closed.size === 0) closedReplies.delete(sessionId)
}

/** A part's approval resume version: a positive safe integer, or 0 for a reply's first part. */
function partVersion(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0
}

/** The approval resume version a `start` opens (`approvalResume.version`), 0 for a first part. */
function startedPartVersion(event: { metadata?: unknown }): number {
  const metadata = event.metadata && typeof event.metadata === 'object' ? (event.metadata as Record<string, any>) : null
  return readApprovalResumeStart(metadata)?.version ?? 0
}

/**
 * BL-871 (a): whether a `start` of this reply is late. A start for a reply the finalize closed is
 * late unless it opens a NEWER part: an approval resume whose version is above the version the
 * reply was closed with. A start never answered within its forward's limit can finish after the
 * finalize; refused, it can no longer reopen the saved reply and replace its record with an empty
 * one (it looked like an approval resume's start, which was never refused).
 */
export function isLateReplyStart(sessionId: string, event: { messageId?: unknown; metadata?: unknown }): boolean {
  if (typeof event.messageId !== 'string') return false
  const mark = closedReplies.get(sessionId)?.get(event.messageId)
  if (!mark) return false
  return startedPartVersion(event) <= mark.version
}

/**
 * Whether `/api/sse` must refuse this event as late: a content or tool event of a reply whose
 * finalize already rebuilt it, or a `start` of one that does not open a newer approval resume part
 * (`isLateReplyStart`, BL-871 a). The terminal events are never refused.
 */
export function isLateReplyEvent(
  sessionId: string,
  event: { type?: unknown; messageId?: unknown; metadata?: unknown }
): boolean {
  if (typeof event.messageId !== 'string' || typeof event.type !== 'string') return false
  if (event.type === 'start' || event.type === 'begin') return isLateReplyStart(sessionId, event)
  if (!RECONSTRUCTION_EVENT_TYPES.has(event.type) && event.type !== TEXT_RETRACT_EVENT_TYPE) return false
  return isReplyClosed(sessionId, event.messageId)
}

/** Whether the finalize closed this reply (`closeReplyRecord`) and no `start` has reopened it. */
export function isReplyClosed(sessionId: string, messageId: string): boolean {
  return Boolean(closedReplies.get(sessionId)?.has(messageId))
}

export type RetractedReplySegment =
  | {
      /**
       * The zip detector rewound the segment (`rewound`), or never read it (`unknown`): the segment
       * is out of the record, and the record can still be trusted.
       */
      detector: 'rewound' | 'unknown'
      /** The segment's recorded text, which the rebuild and a joining tab no longer read. */
      removedText: string
      /** The ids of the zips made from the segment's words that were removed. */
      removedZipIds: string[]
      /** The reply's text so far as it now reads (an approval resume's earlier part first), for the tabs. */
      content: string
    }
  | {
      /**
       * Other words were read after the segment, or it was read in two runs: its words cannot be
       * taken out of the zip detector exactly, so nothing was changed and the record must NOT be
       * trusted. The caller answers the retract's forward without success, so send-routed marks the
       * reply a gap and its finalize saves its own copy (taken back by segment) with the notice, and
       * removes the stream-made zips no message names (the fragment's among them).
       */
      detector: 'superseded'
    }

/**
 * BL-759 — a managed lane took back a segment of a running reply (a message the removed Codex CLI
 * lane dropped and started again), by its name. When the zip detector can rewind it (the segment is
 * the last run it read, read in one run, which the Codex adapter made sure of), the segment's
 * chunks leave the rebuild's reconstruction and a joining tab's replay, the detector is as it was
 * before the segment (a block the segment opened is forgotten, a block it closed is open again),
 * and a zip made from the segment's words is removed. Text with no segment, and every other
 * segment, stays. Answers the reply's text as it now reads, for the tabs' `content_reset`. Answers
 * `superseded` (and changes nothing) when the detector cannot; null when there is nothing to take
 * back from (no record) or the reply is already closed (a late retract of a saved reply is
 * refused, like a late chunk).
 */
export async function retractReplySegment(
  sessionId: string,
  messageId: string,
  segmentId: string
): Promise<RetractedReplySegment | null> {
  if (isLateReplyEvent(sessionId, { type: TEXT_RETRACT_EVENT_TYPE, messageId })) {
    logger.warn('[ReplyRecord] BL-759: refused a late retract of a reply already saved', {
      sessionId,
      messageId,
      segmentId
    })
    return null
  }
  const record = records.get(sessionId)
  const reconstruction = record?.reconstructionByMessage.get(messageId)
  if (!record || !reconstruction || !segmentId) return null

  if (reconstruction.retractSuperseded) {
    logger.error('[ReplyRecord] BL-759: a retract of a reply whose record is no longer trusted was refused', {
      sessionId,
      messageId,
      segmentId
    })
    return { detector: 'superseded' }
  }
  const discarded = replyZipDetection.discardSegment(sessionId, messageId, segmentId)
  if (discarded.outcome === 'superseded') {
    reconstruction.retractSuperseded = true
    logger.error('[ReplyRecord] BL-759: a segment was taken back after other words; the record is not trusted', {
      sessionId,
      messageId,
      segmentId
    })
    return { detector: 'superseded' }
  }

  const isSegmentChunk = (event: RecordedStreamEvent) => event.type === 'chunk' && event.segmentId === segmentId
  const removedText = reconstruction.events
    .filter(isSegmentChunk)
    .map((event) => (typeof event.content === 'string' ? event.content : ''))
    .join('')
  reconstruction.events = reconstruction.events.filter((event) => !isSegmentChunk(event))
  record.events = record.events.filter((event) => event.messageId !== messageId || !isSegmentChunk(event))

  let removedZipIds: string[] = []
  const zipIds = discarded.zipReferences
    .map((ref) => ref.zipId || extractZipIdFromReference(ref.reference))
    .filter((id): id is string => Boolean(id))
  if (zipIds.length > 0) {
    try {
      removedZipIds = await redis.removeUnclaimedZipsMadeByMessage(sessionId, messageId, zipIds)
    } catch (error) {
      logger.error('[ReplyRecord] BL-759: a zip made from a segment taken back could not be removed', {
        sessionId,
        messageId,
        segmentId,
        zipIds,
        error
      })
    }
  }

  const approvalResume = readApprovalResumeStart(reconstruction.start?.metadata)
  const content = buildEndStreamingContent({
    priorContent: approvalResume?.prior.content,
    streamEvents: reconstruction.events as any,
    inlineCapable: true,
    toolZipRefs: [],
    allZipRefs: []
  }).content

  return { detector: discarded.outcome, removedText, removedZipIds, content }
}

/** Whether this reply has a record to rebuild from (its start or a content or tool event). */
export function hasReplyRecord(sessionId: string, messageId: string): boolean {
  return Boolean(records.get(sessionId)?.reconstructionByMessage.has(messageId))
}

/**
 * What a tab that subscribes now is sent: each recorded start the capped buffer has already
 * evicted (so the tail always has its owner, an approval resume's prefix included), then the buffer.
 */
export function listReplayEvents(sessionId: string): RecordedStreamEvent[] {
  const record = records.get(sessionId)
  if (!record || record.events.length === 0) return []
  const replay: RecordedStreamEvent[] = []
  for (const [messageId, reconstruction] of record.reconstructionByMessage) {
    const start = reconstruction.start
    if (!start) continue
    const startStillBuffered = record.events.some(
      (event) => event.messageId === messageId && event.type === 'start'
    )
    if (!startStillBuffered) replay.push(start)
  }
  replay.push(...record.events)
  return replay
}

/** Whether the chat has anything recorded at all. */
export function hasChatReplyRecords(sessionId: string): boolean {
  const record = records.get(sessionId)
  return Boolean(record && record.events.length > 0)
}

export function clearReplyRecordCleanup(sessionId: string, messageId?: string) {
  if (!messageId) return
  const timers = cleanupTimers.get(sessionId)
  const timer = timers?.get(messageId)
  if (!timer) return
  clearTimeout(timer)
  timers!.delete(messageId)
  if (timers!.size === 0) cleanupTimers.delete(sessionId)
}

/**
 * A message reached its terminal event: its entries go after `delayMs`. `onChatEmpty` runs when the
 * chat has nothing left recorded (the route gives back a woken turn's zip settings there).
 */
export function scheduleReplyRecordCleanup(
  sessionId: string,
  messageId: string | undefined,
  options: { delayMs?: number; onChatEmpty?: () => void; onMessageCleared?: () => void } = {}
) {
  if (!messageId) return
  clearReplyRecordCleanup(sessionId, messageId)
  const timers = cleanupTimers.get(sessionId) ?? new Map<string, ReturnType<typeof setTimeout>>()
  const timer = setTimeout(() => {
    const record = records.get(sessionId)
    if (record) {
      record.events = record.events.filter((event) => event.messageId !== messageId)
      record.reconstructionByMessage.delete(messageId)
      if (record.events.length === 0) {
        records.delete(sessionId)
        options.onChatEmpty?.()
      }
    } else {
      options.onChatEmpty?.()
    }
    options.onMessageCleared?.()
    const existing = cleanupTimers.get(sessionId)
    if (existing) {
      existing.delete(messageId)
      if (existing.size === 0) cleanupTimers.delete(sessionId)
    }
    logger.debug('[ReplyRecord] Finished message record cleared', { sessionId, messageId })
  }, options.delayMs ?? FINISHED_REPLY_RECORD_TTL_MS)
  timers.set(messageId, timer)
  cleanupTimers.set(sessionId, timers)
}

/** Shutdown: every record and timer goes. */
export function clearAllReplyRecords() {
  for (const timers of cleanupTimers.values()) {
    for (const timer of timers.values()) clearTimeout(timer)
  }
  cleanupTimers.clear()
  records.clear()
  for (const closed of closedReplies.values()) {
    for (const mark of closed.values()) clearTimeout(mark.timer)
  }
  closedReplies.clear()
}

/**
 * What else holds per-chat state beside the record (`/api/sse`'s adapter and caches), by owner
 * name: a chat's delete drops it too. Keyed so a module that loads again replaces its hook.
 */
const chatForgetHooks = new Map<string, (sessionId: string) => void>()

export function setChatForgetHook(owner: string, hook: (sessionId: string) => void) {
  chatForgetHooks.set(owner, hook)
}

/**
 * A deleted chat's records, timers, and zip detector state go with it (the session delete sweep,
 * `sessionDeleteTurnStop.ts`), so nothing of a chat outlives it in memory.
 */
export function forgetChatReplyRecords(sessionId: string) {
  for (const [owner, hook] of chatForgetHooks) {
    try {
      hook(sessionId)
    } catch (error) {
      logger.error('[ReplyRecord] A chat forget hook failed', { owner, sessionId, error })
    }
  }
  const timers = cleanupTimers.get(sessionId)
  if (timers) {
    for (const timer of timers.values()) clearTimeout(timer)
    cleanupTimers.delete(sessionId)
  }
  records.delete(sessionId)
  const closed = closedReplies.get(sessionId)
  if (closed) {
    for (const mark of closed.values()) clearTimeout(mark.timer)
    closedReplies.delete(sessionId)
  }
  replyZipDetection.deleteSessionBuffers(sessionId)
  replyZipDetection.clearSessionReferences(sessionId)
}

/** How many chats hold a record (tests: stamping alone must create none). */
export function __countReplyRecordChatsForTests(): number {
  return records.size
}

export function __resetReplyRecordsForTests() {
  clearAllReplyRecords()
  nextEventIndex = 0
}

function dedupeZipReferences(refs: ZipReference[]): ZipReference[] {
  if (!refs || refs.length === 0) return []
  const unique: ZipReference[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (!ref?.reference) continue
    if (!seen.has(ref.reference)) {
      const zipId = ref.zipId || extractZipIdFromReference(ref.reference) || undefined
      unique.push(zipId ? { ...ref, zipId } : ref)
      seen.add(ref.reference)
    }
  }
  return unique
}

function isCoolToolReference(ref: unknown): boolean {
  return typeof (ref as ZipReference | null)?.reference === 'string' &&
    (ref as ZipReference).reference.includes('batshit-zip:cool_tool_')
}

export type RecordedReplyEnd = {
  /** The text as it is stored and as `end` carries it. */
  content: string
  /** Every zip reference of the reply (an approval resume's earlier part included), deduplicated. */
  zipReferences: ZipReference[]
  /** The reply's `zipIds` allow-list for `content` and `zipReferences`. */
  zipIds: string[]
  /** This run's tool steps, as the end event carries them (an approval resume's earlier steps first). */
  intermediateSteps: any[]
  /** This run's tool steps alone. */
  ownIntermediateSteps: any[]
  /** True when the recorded start continued an earlier part (an approval resume). */
  continuesEarlierPart: boolean
}

export type RecordedReplyEndInput = {
  /** The recorded reconstruction of the reply (its start and its content and tool events). */
  reconstruction: ReplyReconstruction
  /** The zip references the server made for the reply (tool zips, image zips, batch zips). */
  incomingZipReferences?: ZipReference[] | null
  /** The server's tool steps for the reply, when it has any. */
  intermediateSteps?: any[] | null
  /** The server's own full text of the reply, used only when the recorded text is empty. */
  endContent?: string | null
  /** Stream-made zip references (the detector's blocks, and temp blocks finalized now). */
  streamingZipReferences?: ZipReference[]
  /** Whether a managed agent (API or CLI) made the reply: its tool cards are placed inline. */
  inlineCapable: boolean
  /** The reply-end step applied and removed the reply's control blocks. */
  replyControlFinalized: boolean
  /**
   * A group chat speaker's reply: its Goon cues, emote tags, and stage directions are removed, as
   * send-routed's own copy of a group reply is (`stripGroupChatPresentationControls`).
   */
  groupChat?: boolean
}

/**
 * The rebuild, as a pure function of the recorded events: the `/api/sse` `end` case's rules (moved
 * unchanged, BL-775), then the edits the chat page made before it saved (`replyEndContent.ts`).
 */
export function buildRecordedReplyEnd(input: RecordedReplyEndInput): RecordedReplyEnd {
  const incomingZipReferences: ZipReference[] = Array.isArray(input.incomingZipReferences)
    ? input.incomingZipReferences
    : []
  const upstreamSteps = Array.isArray(input.intermediateSteps) ? input.intermediateSteps : []
  const streamingRefs = Array.isArray(input.streamingZipReferences) ? input.streamingZipReferences : []

  const hasIncomingCoolToolZips = incomingZipReferences.some(isCoolToolReference)
  const hasUpstreamIntermediateSteps = upstreamSteps.length > 0

  const approvalResume = readApprovalResumeStart(input.reconstruction.start?.metadata)
  const priorZipReferences: ZipReference[] = Array.isArray(approvalResume?.prior.metadata.zipReferences)
    ? approvalResume!.prior.metadata.zipReferences
    : []

  const streamEvents = input.reconstruction.events
  const ownIntermediateSteps = hasUpstreamIntermediateSteps
    ? upstreamSteps
    : streamEvents
        .filter((event) => event.type === 'tool-result' || event.type === 'tool_result')
        .map((event) => ({
          tool: event.toolName,
          toolName: event.toolName,
          toolArgs: event.args,
          toolResult: event.result,
          action: { tool: event.toolName, toolInput: event.args },
          observation: event.result,
          metadata: event.metadata
        }))

  const allZipRefs = dedupeZipReferences([
    ...priorZipReferences,
    ...incomingZipReferences,
    ...streamingRefs
  ])
  const replayToolZipRefs = dedupeZipReferences(incomingZipReferences).filter(isCoolToolReference)

  const streamingContent = buildEndStreamingContent({
    priorContent: approvalResume?.prior.content,
    streamEvents: streamEvents as any,
    inlineCapable: input.inlineCapable,
    toolZipRefs: replayToolZipRefs,
    allZipRefs
  }).content

  const replacePlaceholders = (content: string): string => {
    let output = content
    for (const ref of allZipRefs) {
      if (ref.placeholder) output = output.replaceAll(ref.placeholder, ref.reference)
    }
    return output
  }

  let workingContent = replaceBracedTokens(streamingContent, '{{TOOL_LOADING_PLACEHOLDER:', () => '')
  workingContent = replacePlaceholders(workingContent)

  // SA-129 P2 (DL-08): the chunks still carry the reply's control blocks; the reply-end step
  // applied and removed them, so the rebuild drops the same blocks with the same function. Only
  // then: nothing else may lose a block nobody applied.
  if (input.replyControlFinalized) {
    workingContent = stripReplyControlBlocks(workingContent)
  }

  const hasToolArtifacts = hasUpstreamIntermediateSteps || hasIncomingCoolToolZips
  const sanitizedEndContent = replacePlaceholders(
    sanitizeAssistantContent(input.endContent || '', hasToolArtifacts)
  )
  if (workingContent.trim().length === 0 && sanitizedEndContent) {
    workingContent = sanitizedEndContent
  }

  const finalSanitizedContent = sanitizeAssistantContent(workingContent, hasToolArtifacts)
  const finalContent =
    finalSanitizedContent && finalSanitizedContent.trim().length > 0
      ? finalSanitizedContent
      : sanitizedEndContent || allZipRefs.map((ref) => ref.reference).join('\n\n')
  const subagentSanitizedContent = stripLeadingSubagentEchoText(finalContent, ownIntermediateSteps)

  // One reference per zip (`braceScan.ts`, the rule `saveMessage` uses; BL-707).
  const seenZips = new Set<string>()
  let content = replaceBracedTokens(subagentSanitizedContent, '{{batshit-zip:', (match) => {
    if (seenZips.has(match)) return ''
    seenZips.add(match)
    return match
  })
  const trustedFinalZipIds = Array.from(new Set([
    ...collectTrustedZipIdsFromMetadata(approvalResume?.prior.metadata),
    ...allZipRefs
      .map((ref) => extractZipIdFromReference(ref.reference))
      .filter((id): id is string => Boolean(id))
  ]))
  content = neutralizeUntrustedZipReferenceSyntax(content, { trustedZipIds: trustedFinalZipIds })
  content = neutralizeAllClipReferenceSyntax(content)
  content = content.replace(/\n{3,}/g, '\n\n').trim()

  // The edits the chat page used to make before its save (BL-775).
  content = finishReplyEndContent(content, allZipRefs)
  if (input.groupChat) content = stripGroupChatPresentationControls(content)

  return {
    content,
    zipReferences: allZipRefs,
    zipIds: replyEndZipIds(content, allZipRefs),
    intermediateSteps: approvalResume
      ? mergeResumedSteps(approvalResume.prior.intermediateSteps, ownIntermediateSteps) || []
      : ownIntermediateSteps,
    ownIntermediateSteps,
    continuesEarlierPart: Boolean(approvalResume)
  }
}

/**
 * The words the zip detector still holds for this reply, settled, as the chunk that puts them where
 * they were written: an `<error>` block that never closed (BL-489), a lone start of the tag (`<`,
 * `<e`, ... `<erro`) the reply ended on, and a pair held while a stray backtick before it might
 * still make it code, zipped now (BL-779 a: no more words come, so its reading is decided). Takes
 * them, so the detector holds nothing afterwards. The trusted zip ids are read after the take, so
 * the reference of a pair it zipped is kept.
 */
async function takeHeldReplyTextEvent(sessionId: string, messageId: string): Promise<RecordedStreamEvent | null> {
  const unclosed = await replyZipDetection.takeHeldText(sessionId, messageId)
  if (!unclosed) return null
  const knownStreamingZipIds = replyZipDetection
    .getMessageReferences(sessionId, messageId)
    .map((ref) => extractZipIdFromReference(ref.reference))
    .filter((id): id is string => Boolean(id))
  return {
    type: 'chunk',
    sessionId,
    messageId,
    content: neutralizeAllClipReferenceSyntax(
      neutralizeUntrustedZipReferenceSyntax(unclosed, { trustedZipIds: knownStreamingZipIds })
    )
  }
}

/**
 * The finalize's first step, BEFORE `closeReplyRecord` (BL-775 deep read): the words the zip
 * detector still holds join the record as a chunk while the reply is still open. Once the reply is
 * closed it refuses every content event, so words written after the close are lost from the saved
 * reply and from `end`. The words are settled first (BL-779 a): a pair held after a stray backtick
 * is zipped, the zip written before its reference is recorded, so the rebuild after the close takes
 * the zip with the reply's other stream-made zips (or, for a gap, the own-copy sweep removes it when
 * no message names it). That zip is the only await; the caller closes the reply right after.
 * Answers whether it wrote anything. Words for a reply with no record stay held, unzipped (the
 * finalize then saves its own copy, whose sweep lets go of them), and words for a reply already
 * closed stay held for the rebuild, which reports them.
 */
export async function flushHeldReplyText(sessionId: string, messageId: string): Promise<boolean> {
  if (!hasReplyRecord(sessionId, messageId)) return false
  if (isReplyClosed(sessionId, messageId)) return false
  const held = await takeHeldReplyTextEvent(sessionId, messageId)
  if (!held) return false
  // `recordReplyEvent` refuses it, as late, if the reply was closed while the zip was written. The
  // detector no longer holds the words then, so they and the zips they name are in no saved reply:
  // said loudly, with what was lost.
  const recorded = recordReplyEvent(sessionId, held)
  if (!recorded) {
    const content = typeof held.content === 'string' ? held.content : ''
    logger.error('[ReplyRecord] BL-779: the reply refused the held words its finalize took; they are not in the saved reply', {
      sessionId,
      messageId,
      droppedCharacters: content.length,
      zipIds: scanZipReferences(content).map((reference) => reference.id)
    })
  }
  return recorded
}

/** `events` with `chunk` after them, as `appendReconstructionEvent` joins it, on a copy: nothing is written to the record. */
function eventsWithChunk(events: RecordedStreamEvent[], chunk: RecordedStreamEvent): RecordedStreamEvent[] {
  const last = events[events.length - 1]
  if (last?.type === 'chunk' && typeof last.content === 'string' && typeof chunk.content === 'string') {
    return [...events.slice(0, -1), { ...last, content: last.content + chunk.content }]
  }
  return [...events, { ...chunk }]
}

/**
 * The finalize's rebuild of a reply: the stream-made zip references are taken and the text is
 * rebuilt from the record. The words the zip detector holds were already flushed into the record
 * (`flushHeldReplyText`, before the close). Words still held at a rebuild of an OPEN reply are
 * recorded as a chunk here, as before. Words still held at a rebuild of a CLOSED reply mean the
 * caller closed without flushing: that is logged as an error with the chat and message ids, and
 * the words are still kept in THIS rebuild's text (built on a copy of the events), never written
 * to the closed record. Null when the reply has no record: the caller then saves its own copy and
 * says so (condition 3 of the BL-775 plan). A thrown error is the caller's.
 */
export async function rebuildRecordedReply(input: {
  sessionId: string
  messageId: string
  incomingZipReferences?: ZipReference[] | null
  intermediateSteps?: any[] | null
  endContent?: string | null
  inlineCapable: boolean
  replyControlFinalized: boolean
  groupChat?: boolean
}): Promise<RecordedReplyEnd | null> {
  const { sessionId, messageId } = input
  if (!hasReplyRecord(sessionId, messageId)) return null

  let heldOnClosedReply: RecordedStreamEvent | null = null
  const held = await takeHeldReplyTextEvent(sessionId, messageId)
  if (held) {
    if (isReplyClosed(sessionId, messageId)) {
      logger.error(
        '[ReplyRecord] BL-775: the zip detector still held words of a reply already closed; they are kept in this rebuild only. The finalize must call flushHeldReplyText before closeReplyRecord',
        { sessionId, messageId, heldCharacters: String(held.content ?? '').length }
      )
      heldOnClosedReply = held
    } else {
      recordReplyEvent(sessionId, held)
    }
  }

  const tempBlockRefs = await finalizeAllZipBlocks(sessionId, messageId)
  const detectorRefs = await replyZipDetection.finalizeOpenBlocks(sessionId, messageId)
  const reconstruction = records.get(sessionId)?.reconstructionByMessage.get(messageId)
  if (!reconstruction) return null
  reconstruction.streamZipReferences = dedupeZipReferences([
    ...(reconstruction.streamZipReferences ?? []),
    ...detectorRefs,
    ...tempBlockRefs
  ])

  return buildRecordedReplyEnd({
    reconstruction: heldOnClosedReply
      ? { ...reconstruction, events: eventsWithChunk(reconstruction.events, heldOnClosedReply) }
      : reconstruction,
    incomingZipReferences: input.incomingZipReferences,
    intermediateSteps: input.intermediateSteps,
    endContent: input.endContent,
    streamingZipReferences: reconstruction.streamZipReferences,
    inlineCapable: input.inlineCapable,
    replyControlFinalized: input.replyControlFinalized,
    groupChat: input.groupChat
  })
}

/**
 * The zip references the stream path made for a reply: those a rebuild already took, and what the
 * detector still holds (taken now). A reply the finalize saves from its own copy does not name
 * them, so the finalize removes the ones no message names (`redis.removeUnclaimedZipsMadeByMessage`).
 */
export async function takeStreamMadeZipReferences(sessionId: string, messageId: string): Promise<ZipReference[]> {
  const detectorRefs = await replyZipDetection.finalizeOpenBlocks(sessionId, messageId)
  const reconstruction = records.get(sessionId)?.reconstructionByMessage.get(messageId)
  const all = dedupeZipReferences([...(reconstruction?.streamZipReferences ?? []), ...detectorRefs])
  if (reconstruction) reconstruction.streamZipReferences = all
  return all
}
