import { randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { TOOL_APPROVAL_TIMEOUT_MS } from './toolApprovalState'
import { sealLiveFileReadReplay, verifyLiveFileReadReplaySeal } from './fileReadProofSeal'
import { canRefreshReadTranscript, refreshedReadTranscript, refreshedTypedReadTranscript } from '$lib/server/coolToolZipAdapter'
import { emulateFileReadView, type FileReadView } from '$lib/utils/shellReadSplit'
import { readFileReadSource, type FileReadSource } from '$lib/utils/fileReadSource'
import { classifyToolResultSize } from '$lib/utils/toolResultSizeGuard'
import type { CoolToolAiContentPart } from '$lib/utils/coolToolAiContent'
import { assertSandboxMountRootsSafe } from './sandboxHomeMounts'
import { isToolSharedForGroup } from '$lib/services/messageCompiler'
import {
  LiveFileReadStoppedError,
  admitLiveFileReads,
  liveReadSourceRefusal,
  readLiveFiles,
  type LiveReadAdmission,
  type LiveReadReaderOpener,
  type LiveReadStaticReason
} from './liveFileReadSnapshot.server'

/**
 * SA-137 (Refreshed File Reads; internal key `live_file_reads`), the compile half: one frozen
 * snapshot per actual API turn (D2, D6).
 *
 * The canonical compile asks once, with its provisional candidates (every Read File copy the turn
 * could show, `collectLiveReadCandidates`); the first ask reads the files (`readLiveFiles`) and
 * freezes the result, and every later ask in the same turn (the second Smart Zip pass, the group
 * speaker's compile) gets the same object without touching a file. A refreshed copy carries the
 * transcript a fresh read of today's file would show (`refreshedReadTranscript` for a Bash read,
 * `refreshedTypedReadTranscript` for SA-136's typed read_file), its token count and its label at the
 * top; every other copy is static with its reason.
 *
 * Strict freshness (Round 2, Josh 2026-10-22: "Freshness overrides everything with this feature"):
 * while `strict`, the compile shows a Read File copy from an earlier message only when this snapshot
 * refreshed it; any other copy stays zipped for this turn whatever its Zip Buffer, Zip Hold or Off
 * says, and the Zip Index says why. Nothing about the Hold or the copy's clocks changes, and a
 * later turn tries again. The turn's own reply is never touched (nothing zips while the agent works).
 * An approval resume builds the snapshot from the paused record's replay instead (D7): the same
 * bytes and decisions, no file access.
 */

/** The paused record's replay field is at most this many serialized UTF-8 bytes (R1). */
export const LIVE_READ_REPLAY_MAX_BYTES = 1_048_576
/** The refreshed text one compile may hold (D6), in UTF-16 bytes. */
export const LIVE_READ_COMPILE_MAX_BYTES = 8 * 1024 * 1024
/** At most this many copies are read for one turn; the rest stay as printed. */
export const LIVE_READ_MAX_CANDIDATES = 64

export type LiveCopyStaticReason =
  | LiveReadStaticReason
  | 'inline-layout'
  | 'too-many-copies'
  | 'emulation-failed'
  | 'refresh-memory'
  | 'replay-capacity'
  | 'not-in-replay'
  | 'stopped'
  /** Read while live file reads were off for its agent (or before the setting was recorded). */
  | 'read-while-off'
  /** A copy whose transcript cannot be rebuilt (no proof of its file and form, another tool or form). */
  | 'not-refreshable'
  /** Another member's copy whose sharing ended (or reader went) during this turn's reads (R2-4). */
  | 'sharing-changed'
  /** A sandbox read whose project folder overlaps a folder Batshit keeps out of sandboxes. */
  | 'protected-root'
  | LiveReplayUnavailableReason

/**
 * Why an approval resume runs without the paused call's file snapshot (P2 settle S2/S3): the paused
 * record holds none (`replay-missing`: written null because the pause kept none, or cleared by its
 * expiry timer, the lazy expiry update or a terminal writer; the value cannot say which), its sealed
 * replay is past its expiry (`replay-expired`), or was sealed by an earlier app process
 * (`replay-unverifiable`). Metadata only: the resume reads nothing and no bytes are used.
 */
export type LiveReplayUnavailableReason = 'replay-missing' | 'replay-expired' | 'replay-unverifiable'

export type LiveCopyOutcome =
  | { status: 'refreshed'; text: string; parts: CoolToolAiContentPart[]; promptTokens: number }
  | { status: 'static'; reason: LiveCopyStaticReason }

/**
 * What one compile may refresh: a stored Read File copy the turn could show, with its descriptor
 * (null: no proof of its file and form, so it cannot refresh) and payload.
 */
export interface LiveReadCandidate {
  /** The zip id as the message names it. */
  rawZipId: string
  /** Its state id (`normalizeId`), how the compile keys zip state. */
  zipId: string
  source: FileReadSource | null
  payload: Record<string, any>
  metadata: Record<string, any>
  /** The names group sharing tests for this zip (the compile's own list, `isToolSharedForGroup`). */
  toolCandidates?: Array<string | undefined>
}

/**
 * Round 2 (R2-4): the other readers a turn may refresh under, as Redis says now. Each allowed reader
 * carries its current execution backend (a sandboxed reader's copy refreshes only where its sandbox
 * could mount the folder). `sharedTools` is the group's sharing (each copy is tested with the
 * compile's own rule), or null outside a group chat.
 */
export interface LiveReadOtherReaders {
  readers: ReadonlyMap<string, { backend: string }>
  sharedTools: readonly string[] | null
}

export interface LiveFileReadSnapshot {
  version: 1
  /** One turn's compile (an approval resume keeps the paused compile's id). */
  compileId: string
  copies: ReadonlyMap<string, LiveCopyOutcome>
  /** The copies that show today's file (a summary of `copies`; no compile rule reads it since D3 was amended, 2026-11-04). */
  refreshed: ReadonlySet<string>
  /**
   * Strict freshness is on: a Read File copy of an earlier message is shown only when refreshed.
   * False only for a layout that refreshes nothing (inline), where every copy keeps today's rules.
   */
  strict: boolean
  /** The turn's own reply: its results are never touched (nothing zips while the agent works). */
  replyMessageId: string
  /** Built from a paused call's replay: a copy it does not name was not shown at the pause. */
  replayed: boolean
}

/** The label at the top of a refreshed copy: the file, its exact range, and when it was read. */
export function liveReadLabel(locator: string, view: FileReadView): string {
  return `REFRESHED: ${locator}, ${liveReadRange(view)} (at the start of this turn)`
}

function liveReadRange(view: FileReadView): string {
  switch (view.kind) {
    case 'whole':
      return view.numbering === 'none' ? 'whole file' : view.numbering === 'all' ? 'whole file, every line numbered' : 'whole file, non-blank lines numbered'
    case 'lines':
      return `lines ${view.script.replace(/;$/, '').split(';').map((part) => part.replace(/p$/, '').replace(',', '-').replace('$', 'end')).join(', ')}`
    case 'head':
    case 'tail':
      return `${view.kind === 'head' ? 'first' : 'last'} ${view.lines} line${view.lines === 1 ? '' : 's'}`
    case 'typed':
      return view.endLine === null ? `from line ${view.startLine} to the end` : `lines ${view.startLine}-${view.endLine}`
    default: {
      const unknownView: never = view
      throw new Error(`No live-read label for ${JSON.stringify(unknownView)}`)
    }
  }
}

function frozen(compileId: string, copies: Map<string, LiveCopyOutcome>, replyMessageId: string, strict = true, replayed = false): LiveFileReadSnapshot {
  const refreshed = new Set<string>()
  for (const [zipId, outcome] of copies) if (outcome.status === 'refreshed') refreshed.add(zipId)
  return Object.freeze({ version: 1 as const, compileId, copies, refreshed, strict, replyMessageId, replayed })
}

// ---------------------------------------------------------------------------------------------
// The replay a paused approval keeps (D7, P0 settle 2026-10-21: outcome and exact bytes per copy;
// the resume recomputes activation by today's rules).

export interface LiveFileReadReplay {
  schema_version: 1
  userId: string
  sessionId: string
  agentId: string
  messageId: string
  compileId: string
  /** This pause (a resumed reply can pause again with the same snapshot): what expiry clears. */
  pauseId: string
  /**
   * The approvals this pause waits on (pending when it paused). The lazy expiry clears the field
   * only when it closes all of them, so an older card's entry on the same record never does.
   */
  approvalIds: string[]
  /** No later than the approval card's expiry, at most 24 hours after the pause. */
  expiresAt: string
  /** Sealed in this process (`sealLiveFileReadReplay`); any other replay is refused. */
  seal: string
  /**
   * Round 2: the reply's parts when it paused (a context continuation is the same reply under a new
   * id), so the resume never zips the reply's own earlier results. Absent on older replays.
   */
  replyMessageIds?: string[]
  copies: Array<
    /** The transcript is its `parts` joined; they are left out for a copy too large to open (25,000 tokens or more). */
    | { zipId: string; status: 'refreshed'; parts?: CoolToolAiContentPart[]; promptTokens: number }
    | { zipId: string; status: 'static'; reason: LiveCopyStaticReason }
  >
}

export const LIVE_READ_REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** A pause's approval ids, bounded so the compile can reserve their room in the 1 MiB field. */
export const LIVE_READ_REPLAY_MAX_APPROVALS = 32
const APPROVAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/
/** At most this many parts of one reply (its continuations) ride a replay. */
export const LIVE_READ_REPLAY_MAX_REPLY_PARTS = 16

function isReplyPartList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= LIVE_READ_REPLAY_MAX_REPLY_PARTS &&
    value.every((id) => typeof id === 'string' && APPROVAL_ID.test(id))
}

function isReplayApprovalIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= LIVE_READ_REPLAY_MAX_APPROVALS &&
    value.every((id) => typeof id === 'string' && APPROVAL_ID.test(id)) && new Set(value).size === value.length
}

/**
 * The approvals a pausing reply waits on, from its card summary; null when the card names none, or
 * more or longer ids than a replay holds. Then the pause keeps no replay and its resume runs without
 * live reads, as a pause past the cap does.
 */
export function liveReadReplayApprovalIds(toolApprovals: unknown): string[] | null {
  const approvals = (toolApprovals as { approvals?: unknown } | null)?.approvals
  if (!Array.isArray(approvals)) return null
  const ids = approvals
    .filter((entry: any) => entry?.status === 'pending')
    .map((entry: any) => entry?.approvalId)
  return isReplayApprovalIdList(ids) ? ids : null
}

/**
 * The sealed replay a pausing reply keeps, at most `LIVE_READ_REPLAY_MAX_BYTES` serialized. Round 2
 * (review M2): when the exact bytes do not fit, the largest refreshed copies leave the replay first
 * (static `replay-capacity` in the replay only; the paused turn itself showed them), so a resume
 * still shows the rest. Null when even an all-static replay would not fit (the pause keeps none).
 */
export function buildLiveFileReadReplay(
  snapshot: LiveFileReadSnapshot,
  owner: { userId: string; sessionId: string; agentId: string; messageId: string },
  expiresAt: Date,
  approvalIds: readonly string[],
  pauseId: string = randomUUID(),
  replyMessageIds?: readonly string[]
): LiveFileReadReplay | null {
  if (!isReplayApprovalIdList([...approvalIds])) throw new Error('A live-file-read replay needs its pause\'s approval ids.')
  const parts = replyMessageIds && isReplyPartList([...replyMessageIds]) ? [...replyMessageIds] : undefined
  if (replyMessageIds && !parts) {
    console.warn(`[SA-137] A paused reply has ${replyMessageIds.length} parts, more than a file snapshot keeps (${LIVE_READ_REPLAY_MAX_REPLY_PARTS}); its resume zips the earlier parts' unrefreshed file reads with their reason.`)
  }
  const copies: LiveFileReadReplay['copies'] = [...snapshot.copies].map(([zipId, outcome]) =>
    outcome.status !== 'refreshed'
      ? { zipId, status: 'static' as const, reason: outcome.reason }
      : classifyToolResultSize(outcome.promptTokens) === 'too_large'
        // Always compressed by its size, so only its size is kept.
        ? { zipId, status: 'refreshed' as const, promptTokens: outcome.promptTokens }
        : { zipId, status: 'refreshed' as const, parts: outcome.parts, promptTokens: outcome.promptTokens })
  const seal = () => sealLiveFileReadReplay({
    schema_version: 1 as const,
    ...owner,
    compileId: snapshot.compileId,
    pauseId,
    approvalIds: [...approvalIds],
    expiresAt: expiresAt.toISOString(),
    ...(parts ? { replyMessageIds: parts } : {}),
    copies
  })
  let replay = seal()
  if (liveFileReadReplayBytes(replay) <= LIVE_READ_REPLAY_MAX_BYTES) return replay
  const bySize = copies
    .map((copy, index) => ({ index, bytes: copy.status === 'refreshed' && copy.parts ? Buffer.byteLength(JSON.stringify(copy.parts), 'utf8') : 0 }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
  for (const { index } of bySize) {
    copies[index] = { zipId: copies[index].zipId, status: 'static', reason: 'replay-capacity' }
    replay = seal()
    if (liveFileReadReplayBytes(replay) <= LIVE_READ_REPLAY_MAX_BYTES) return replay
  }
  return null
}

/** The serialized size of the replay field, as the record stores it. */
export function liveFileReadReplayBytes(replay: LiveFileReadReplay): number {
  return Buffer.byteLength(JSON.stringify(replay), 'utf8')
}

export class LiveFileReadReplayError extends Error {
  readonly code = 'APPROVAL_RESUME_CONTEXT_MISSING'
  readonly status = 409
  constructor() {
    super('This approval has no valid saved file snapshot. It did not run. Ask the agent again.')
    this.name = 'LiveFileReadReplayError'
  }
}

/**
 * Round 2 follow-up (R2-4, Ashe 2026-10-22): the last check before the turn's first model request
 * found that another reader's refreshed copy may no longer be shown here (group sharing off, the
 * reader gone or changed, or no answer). The request is not sent, so those bytes never leave.
 */
export class LiveFileReadSharingChangedError extends Error {
  readonly code = 'LIVE_FILE_READ_SHARING_CHANGED'
  readonly status = 409
  constructor() {
    super('File sharing, or the agent that read a shared file, changed while this turn was starting, so Batshit sent nothing to the model. Send your message again.')
    this.name = 'LiveFileReadSharingChangedError'
  }
}

/**
 * Only the authoritative paused assistant record supplies a replay (D7, P2 settle 2026-10-21, Faye):
 * a wrong shape or owner refuses the continuation before inference (409). A replay whose seal this
 * process cannot verify (written before an app restart; changed since) is null, and so is one past
 * its `expiresAt`: the resume runs without live reads and reads nothing, so its bytes are never
 * used. That is the result the expiry timer or the lazy expiry gives a moment later, so a click at
 * the card's last moment, or after a restart, is never refused for it.
 */
export function readLiveFileReadReplay(
  value: unknown,
  owner: { userId: string; sessionId: string; agentId: string; messageId: string },
  now = new Date()
): LiveFileReadReplay | null {
  const checked = checkLiveFileReadReplay(value, owner, now)
  return 'replay' in checked ? checked.replay : null
}

/**
 * `readLiveFileReadReplay` with the reason a usable-shaped replay is not used. A field written null
 * is `replay-missing` (`LiveReplayUnavailableReason`). The caller passes only a field that is present
 * on the paused record: absent means the paused call had no live file reads at all.
 */
export function checkLiveFileReadReplay(
  value: unknown,
  owner: { userId: string; sessionId: string; agentId: string; messageId: string },
  now = new Date()
): { replay: LiveFileReadReplay } | { unavailable: LiveReplayUnavailableReason } {
  if (value === null) return { unavailable: 'replay-missing' }
  const fail = () => { throw new LiveFileReadReplayError() }
  const row = value as LiveFileReadReplay | null
  if (!row || typeof row !== 'object' || row.schema_version !== 1) return fail()
  for (const key of ['userId', 'sessionId', 'agentId', 'messageId'] as const) if (row[key] !== owner[key]) return fail()
  if (typeof row.compileId !== 'string' || !row.compileId || typeof row.pauseId !== 'string' || !row.pauseId) return fail()
  if (!isReplayApprovalIdList(row.approvalIds)) return fail()
  if (row.replyMessageIds !== undefined && !isReplyPartList(row.replyMessageIds)) return fail()
  const expires = Date.parse(row.expiresAt)
  if (!Number.isFinite(expires)) return fail()
  if (!Array.isArray(row.copies)) return fail()
  for (const copy of row.copies) {
    if (!copy || typeof copy.zipId !== 'string' || !copy.zipId) return fail()
    if (copy.status === 'refreshed') {
      if (!Number.isSafeInteger(copy.promptTokens) || copy.promptTokens < 0) return fail()
      if (copy.parts === undefined) {
        if (classifyToolResultSize(copy.promptTokens) !== 'too_large') return fail()
      } else if (!Array.isArray(copy.parts) || copy.parts.some((part) =>
          !part || typeof part.text !== 'string' || (part.source !== 'agent_words' && part.source !== 'tool_result'))) {
        return fail()
      }
    } else if (copy.status !== 'static' || typeof copy.reason !== 'string') {
      return fail()
    }
  }
  if (liveFileReadReplayBytes(row) > LIVE_READ_REPLAY_MAX_BYTES) return fail()
  if (!verifyLiveFileReadReplaySeal(row as unknown as Record<string, unknown>)) return { unavailable: 'replay-unverifiable' }
  return expires <= now.getTime() ? { unavailable: 'replay-expired' } : { replay: row }
}

// ---------------------------------------------------------------------------------------------
// One turn

export interface LiveFileReadTurnInput {
  userId: string
  agentId: string
  sessionId: string
  /** The reply this turn writes (the paused record, if it pauses). */
  messageId: string
  /**
   * The agent's execution backend now (`resolveNativeToolSettings`). The route creates a turn only
   * where Refreshed File Reads is available (`refreshedFileReadsUnavailableReason`); every read is
   * the host's anchored read of the shared workspace, whichever backend ran the original read.
   */
  executionBackend: string
  /**
   * The project path the turn's Bash tool gets. Absent, the compile's own resolved project path
   * (the path its dead-copy ledger reads against) is used.
   */
  projectPath?: string | null
  /** The turn's Stop. */
  signal?: AbortSignal
  /** An approval resume's replay, already validated (`checkLiveFileReadReplay`). */
  replay?: LiveFileReadReplay | null
  /**
   * An approval resume whose paused call kept a snapshot that cannot be used (`checkLiveFileReadReplay`):
   * every candidate is static with this reason and nothing is read, so the turn can say so.
   */
  replayUnavailable?: LiveReplayUnavailableReason
  /**
   * Round 2 (R2-4): which other readers' copies this turn may still refresh, asked before the reads
   * and again after them (a deleted reader, or group sharing turned off meanwhile, never sends new
   * bytes). Absent, no other reader's copy refreshes.
   */
  otherReaders?: (agentIds: readonly string[]) => Promise<LiveReadOtherReaders>
  openReader?: LiveReadReaderOpener
}

/**
 * One actual turn's live reads. Created by the route for an API Primary turn with the setting on,
 * never by a preview; the compile asks for the snapshot, the pause saves it.
 */
export class LiveFileReadTurn {
  private pending: Promise<LiveFileReadSnapshot> | null = null
  private settled: LiveFileReadSnapshot | null = null
  private stoppedDuringRead = false
  /** The reply's parts: this turn's own id, a resumed replay's earlier parts, and its continuations. */
  private readonly replyParts: Set<string>
  /** Other readers' copies this snapshot refreshed, for the last check before the first model request. */
  private readonly othersShown: Array<{ reader: string; toolCandidates?: Array<string | undefined>; backend: string | undefined }> = []
  /** A request that passed that check was sent: it carried those bytes (a later one sends nothing new). */
  private dispatchCleared = false

  constructor(private readonly input: LiveFileReadTurnInput) {
    this.replyParts = new Set([input.messageId, ...(input.replay?.replyMessageIds ?? [])])
  }

  /** The frozen snapshot, once the compile has asked for it. */
  get snapshot(): LiveFileReadSnapshot | null {
    return this.settled
  }

  /** Why this resume has no usable replay of its paused snapshot, if that is the case. */
  get replayUnavailable(): LiveReplayUnavailableReason | null {
    return this.input.replayUnavailable ?? null
  }

  /**
   * A Stop ended the read phase (the reader closed first). The snapshot then refreshes nothing, and
   * the turn stops at the route's own setup-stopped check before any model call (D5): the static
   * compile is never sent.
   */
  get stopped(): boolean {
    return this.stoppedDuringRead
  }

  /** The turn's own reply, whose results the compile never zips early. */
  get replyMessageId(): string {
    return this.input.messageId
  }

  /**
   * Every part of the reply this turn serves (review M1): a context continuation is the same reply
   * under a new id, so it reuses this turn's frozen snapshot (no read, no new candidates) and none of
   * the reply's earlier parts is zipped early.
   */
  get replyMessageIds(): ReadonlySet<string> {
    return this.replyParts
  }

  /** The route continues this reply under a new id (a context continuation). */
  continueAs(messageId: string): void {
    this.replyParts.add(messageId)
  }

  /**
   * Whether the turn's model request must pass `beforeDispatch` first: this turn's own reads refreshed
   * another reader's copy, and no request has carried it yet. A replay fills nothing here: its bytes
   * are the ones the paused call already sent.
   */
  get dispatchCheckPending(): boolean {
    return !this.dispatchCleared && this.othersShown.length > 0
  }

  /**
   * Round 2 follow-up (R2-4, Ashe 2026-10-22: the cutoff is the final pre-dispatch validation, not an
   * earlier check followed by awaited setup). Called right before each model request leaves (the
   * innermost model middleware, after the compile's Judge Juice calls and the route's and the tools'
   * setup): until a request that passed it was sent (`dispatchSent`), it asks the other readers once
   * more, and throws `LiveFileReadSharingChangedError` if any refreshed copy of theirs may no longer
   * be shown here (sharing off, the reader gone, its backend changed, or no answer), so the request
   * is never sent. An attempt the SDK retries after a failed send is asked again. It reads no file
   * and changes no snapshot; a later request of the same reply (a tool step, a context continuation)
   * sends nothing new, and an approval resume replays bytes already sent.
   */
  async beforeDispatch(): Promise<void> {
    if (!this.dispatchCheckPending) return
    const answer = await this.askOtherReaders([...new Set(this.othersShown.map((copy) => copy.reader))])
    const revoked = this.othersShown.some((copy) =>
      !otherReaderAllows(answer, this.input.agentId, copy.reader, copy.toolCandidates) ||
      answer.readers.get(copy.reader)?.backend !== copy.backend)
    if (revoked) throw new LiveFileReadSharingChangedError()
  }

  /** A model request that passed `beforeDispatch` was sent (its `doStream` resolved). */
  dispatchSent(): void {
    this.dispatchCleared = true
  }

  private async askOtherReaders(agentIds: readonly string[]): Promise<LiveReadOtherReaders> {
    return agentIds.length > 0 && this.input.otherReaders
      ? await this.input.otherReaders(agentIds)
      : { readers: new Map(), sharedTools: [] }
  }

  /**
   * The turn's snapshot: built on the first ask from that ask's candidates, then the same object.
   * `layout` other than `appended` refreshes nothing and is not strict (the route never creates a
   * turn for it; a resume after a switch to inline keeps today's rules).
   */
  async snapshotFor(
    layout: 'inline' | 'appended',
    candidates: () => Promise<LiveReadCandidate[]>,
    compileProjectPath: string | null = null
  ): Promise<LiveFileReadSnapshot> {
    if (!this.pending) {
      this.pending = this.build(layout, candidates, compileProjectPath).then((snapshot) => {
        this.settled = snapshot
        return snapshot
      })
    }
    return this.pending
  }

  private async build(
    layout: 'inline' | 'appended',
    candidates: () => Promise<LiveReadCandidate[]>,
    compileProjectPath: string | null
  ): Promise<LiveFileReadSnapshot> {
    const replyMessageId = this.input.messageId
    const replay = this.input.replay
    if (replay) {
      // The paused call's own bytes and decisions: no candidate is read again (D7). A copy the
      // replay does not name was not shown at the pause, so it is not shown now either.
      const copies = new Map<string, LiveCopyOutcome>()
      for (const copy of replay.copies) {
        copies.set(copy.zipId, copy.status === 'refreshed'
          ? { status: 'refreshed', text: (copy.parts ?? []).map((part) => part.text).join(''), parts: copy.parts ?? [], promptTokens: copy.promptTokens }
          : { status: 'static', reason: copy.reason })
      }
      return frozen(replay.compileId, copies, replyMessageId, layout === 'appended', true)
    }

    const compileId = randomUUID()
    const described = await candidates()
    const copies = new Map<string, LiveCopyOutcome>()
    if (layout !== 'appended') {
      for (const candidate of described) copies.set(candidate.zipId, { status: 'static', reason: 'inline-layout' })
      return frozen(compileId, copies, replyMessageId, false)
    }
    const unavailable = this.input.replayUnavailable
    if (unavailable) {
      // The paused call's snapshot is gone or unverifiable: the resume reads nothing (P2 settle
      // S2/S3), and no copy is shown as it was first read (Round 2, R2-8): each stays zipped, with why.
      for (const candidate of described) copies.set(candidate.zipId, { status: 'static', reason: unavailable })
      return frozen(compileId, copies, replyMessageId)
    }
    // Before any admission or read: a copy with no proof, one read while live file reads were off
    // (Faye, 2026-10-21: an OFF read stays unrefreshed after a later enable), and one whose
    // transcript cannot be rebuilt cost no read.
    const list: Array<LiveReadCandidate & { source: FileReadSource }> = []
    for (const candidate of described) {
      const source = candidate.source
      if (!source || !canRefreshReadTranscript(candidate.payload, source.view)) copies.set(candidate.zipId, { status: 'static', reason: 'not-refreshable' })
      else if (source.liveReadsOn !== true) copies.set(candidate.zipId, { status: 'static', reason: 'read-while-off' })
      else list.push({ ...candidate, source })
    }
    const allStatic = (reason: LiveCopyStaticReason) => {
      for (const candidate of list) copies.set(candidate.zipId, { status: 'static', reason })
      return frozen(compileId, copies, replyMessageId)
    }
    if (list.length === 0) return frozen(compileId, copies, replyMessageId)

    // Another member's copy refreshes under its original reader (R2-4): that reader must still exist
    // with its file access, and sharing must still show this copy here, asked now, again after the
    // reads, and once more right before the first model request (`beforeDispatch`). No answer allows
    // no one.
    const otherReaderIds = [...new Set(list.map((candidate) => candidate.source.owner.agentId).filter((id) => id !== this.input.agentId))]
    const askOthers = () => this.askOtherReaders(otherReaderIds)
    const allowedBy = (others: LiveReadOtherReaders, candidate: LiveReadCandidate & { source: FileReadSource }) =>
      otherReaderAllows(others, this.input.agentId, candidate.source.owner.agentId, candidate.toolCandidates)
    const allowedOthers = await askOthers()

    const admitted = await admitLiveFileReads({
      userId: this.input.userId,
      agentId: this.input.agentId,
      sessionId: this.input.sessionId,
      executionBackend: this.input.executionBackend,
      projectPath: this.input.projectPath !== undefined ? this.input.projectPath : compileProjectPath
    })
    if (!admitted.admitted) return allStatic(admitted.reason)
    const admission: LiveReadAdmission = admitted.admission

    // A refresh through the host stays inside what a sandbox could read: whenever a sandbox is in play
    // (this turn's backend, the copy's original backend, or its original reader's backend now), the
    // folder must pass the same strict guard that sandbox's mount uses (security review M1, S1).
    let sandboxRootSafe: boolean | null = null
    const sandboxRootIsSafe = async () => {
      if (sandboxRootSafe === null) {
        try {
          await assertSandboxMountRootsSafe([admission.root])
          sandboxRootSafe = true
        } catch {
          sandboxRootSafe = false
        }
      }
      return sandboxRootSafe
    }

    // The newest copies first, within the per-turn bound; older ones stay unrefreshed.
    const reading: Array<LiveReadCandidate & { source: FileReadSource }> = []
    for (const candidate of [...list].reverse()) {
      const reader = candidate.source.owner.agentId
      const refusal = liveReadSourceRefusal(candidate.source, admission, allowedBy(allowedOthers, candidate))
      const sandboxed = this.input.executionBackend !== 'local' || candidate.source.backend !== 'local' ||
        (reader !== this.input.agentId && allowedOthers.readers.get(reader)?.backend !== 'local')
      if (refusal) copies.set(candidate.zipId, { status: 'static', reason: refusal })
      else if (sandboxed && !(await sandboxRootIsSafe())) copies.set(candidate.zipId, { status: 'static', reason: 'protected-root' })
      else if (reading.length >= LIVE_READ_MAX_CANDIDATES) copies.set(candidate.zipId, { status: 'static', reason: 'too-many-copies' })
      else reading.push(candidate)
    }

    let outcomes: Awaited<ReturnType<typeof readLiveFiles>>
    try {
      outcomes = await readLiveFiles(admission, reading.map((candidate) => candidate.source.locator), {
        signal: this.input.signal,
        ...(this.input.openReader ? { openReader: this.input.openReader } : {})
      })
    } catch (error) {
      // An unconfirmed reader end (`LiveFileReadCleanupError`) fails setup loudly; a Stop does not
      // become a refresh or a silent success: nothing refreshes and the turn stops before sending.
      if (!(error instanceof LiveFileReadStoppedError)) throw error
      this.stoppedDuringRead = true
      for (const candidate of reading) copies.set(candidate.zipId, { status: 'static', reason: 'stopped' })
      return frozen(compileId, copies, replyMessageId)
    }

    // Asked again after the awaited reads: a reader deleted, its access ended or sharing turned off
    // meanwhile. A reader whose backend changed to a sandbox since the first ask is refused here
    // rather than guarded again (the guard ran for the first answer only).
    const stillAllowedOthers = reading.some((candidate) => candidate.source.owner.agentId !== this.input.agentId)
      ? await askOthers()
      : allowedOthers

    let held = 0
    for (const candidate of reading) {
      const reader = candidate.source.owner.agentId
      const backendThen = allowedOthers.readers.get(reader)?.backend
      if (reader !== this.input.agentId &&
          (!allowedBy(stillAllowedOthers, candidate) || stillAllowedOthers.readers.get(reader)?.backend !== backendThen)) {
        copies.set(candidate.zipId, { status: 'static', reason: 'sharing-changed' })
        continue
      }
      const outcome = outcomes.get(candidate.source.locator)
      if (!outcome || outcome.status !== 'read') {
        copies.set(candidate.zipId, { status: 'static', reason: outcome?.status === 'static' ? outcome.reason : 'reader-unavailable' })
        continue
      }
      const transcript = refreshedTranscriptOf(candidate, outcome.text)
      if (!transcript) {
        copies.set(candidate.zipId, { status: 'static', reason: 'emulation-failed' })
        continue
      }
      // Round 2 (Josh): the label goes at the top of the copy, short, with the real range.
      const label = `${liveReadLabel(candidate.source.locator, candidate.source.view)}\n`
      const text = label + transcript.text
      const parts: CoolToolAiContentPart[] = [{ source: 'agent_words', text: label }, ...transcript.parts]
      held += text.length * 2
      if (held > LIVE_READ_COMPILE_MAX_BYTES) {
        copies.set(candidate.zipId, { status: 'static', reason: 'refresh-memory' })
        continue
      }
      copies.set(candidate.zipId, { status: 'refreshed', text, parts, promptTokens: transcript.promptTokens })
      if (reader !== this.input.agentId) {
        this.othersShown.push({ reader, toolCandidates: candidate.toolCandidates, backend: backendThen })
      }
    }

    // Round 2 (review M2): the 1 MiB replay cap no longer changes this turn. A pause fits its replay
    // copy by copy (`buildLiveFileReadReplay`), so strict freshness never hides a turn's copies only
    // because an approval might come.
    return frozen(compileId, copies, replyMessageId)
  }
}

/** Whether `others` lets the compiling agent see this reader's copy (its own copies always). */
function otherReaderAllows(
  others: LiveReadOtherReaders,
  compilingAgentId: string,
  reader: string,
  toolCandidates: Array<string | undefined> | undefined
): boolean {
  if (reader === compilingAgentId) return true
  if (!others.readers.has(reader)) return false
  return others.sharedTools === null ||
    isToolSharedForGroup({ zipType: 'cool_tool', toolCandidates: toolCandidates ?? [] }, [...others.sharedTools])
}

/**
 * A candidate's transcript for today's whole file text: a typed `read_file` by the tool's own result
 * builder over the call's arguments; a Bash read by its view's printout, through the stored pipeline.
 */
function refreshedTranscriptOf(candidate: LiveReadCandidate & { source: FileReadSource }, fileText: string) {
  if (candidate.source.view.kind === 'typed') {
    return refreshedTypedReadTranscript(candidate.rawZipId, candidate.payload, candidate.metadata, fileText, candidate.source.view)
  }
  const printed = emulateFileReadView(candidate.source.view, fileText)
  return printed === null ? null : refreshedReadTranscript(candidate.rawZipId, candidate.payload, candidate.metadata, printed)
}

/** A stored zip's `fileReadSource`, if it validates (the compile's one reader of the field). */
export function liveReadSourceOf(zipData: { metadata?: Record<string, any> } | null | undefined): FileReadSource | null {
  return readFileReadSource(zipData?.metadata?.fileReadSource)
}

// ---------------------------------------------------------------------------------------------
// Expiry (D7, P0 settle 2026-10-21: no startup pass; no index of paused API cards exists)

/** When a paused reply's replay expires: its card's latest expiry, at most 24 hours from now. */
export function liveFileReadReplayExpiry(toolApprovals: unknown, now = new Date()): Date {
  const approvals = Array.isArray((toolApprovals as any)?.approvals) ? (toolApprovals as any).approvals : []
  // The pause's own card: its pending approvals (an answered older one never sets this pause's end).
  const ends = approvals
    .filter((entry: any) => entry?.status === 'pending')
    .map((entry: any) => Date.parse(String(entry?.expiresAt ?? '')))
    .filter((time: number) => Number.isFinite(time))
  const cardEnd = ends.length > 0 ? Math.max(...ends) : now.getTime() + TOOL_APPROVAL_TIMEOUT_MS
  return new Date(Math.min(cardEnd, now.getTime() + LIVE_READ_REPLAY_MAX_AGE_MS))
}

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * One in-process timer per paused record: at expiry it clears the field, only while it is still the
 * same pause (`retireLiveFileReadReplay`). A process that stops loses its timers; an expired field is
 * inert (the resume refuses it) and goes with the chat's next lazy expiry update or its deletion.
 */
export function scheduleLiveFileReadReplayExpiry(replay: Pick<LiveFileReadReplay, 'sessionId' | 'messageId' | 'pauseId' | 'expiresAt'>): void {
  // Only these strings live in the timer, never the replay itself (up to 1 MiB).
  const { sessionId, messageId, pauseId, expiresAt } = replay
  const key = `${sessionId}\u0000${messageId}`
  const previous = expiryTimers.get(key)
  if (previous) clearTimeout(previous)
  const delay = Math.min(Math.max(0, Date.parse(expiresAt) - Date.now()), LIVE_READ_REPLAY_MAX_AGE_MS)
  const timer = setTimeout(() => {
    expiryTimers.delete(key)
    void redis.retireLiveFileReadReplay(sessionId, messageId, pauseId).catch(() => {
      console.warn('[SA-137] A paused reply\'s file snapshot could not be cleared at its expiry; it is never used again, and goes at the chat\'s next send (an unanswered card) or with the message or chat.')
    })
  }, delay)
  timer.unref?.()
  expiryTimers.set(key, timer)
}

/** Test-only: the number of live expiry timers. */
export function liveFileReadReplayTimersForTests(): number {
  return expiryTimers.size
}
