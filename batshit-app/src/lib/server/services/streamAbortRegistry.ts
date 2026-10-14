import {
  __resetQueuedSendHiddenIdsForTests,
  hideQueuedSendMessage,
  revealQueuedSendMessage
} from './queuedSendHiddenIds'
import { clearToolModelRetentionBudgetsForSession } from './toolModelRetentionTurnBudget'

type StreamAbortEntry = {
  messageId: string
  controller: AbortController
  startedAt: number
  abortedAt?: number | null
}

type GroupAbortEntry = {
  controller: AbortController
  startedAt: number
  abortedAt?: number | null
}

type SessionTurnKind = 'single' | 'group'

export type SessionTurnEntry = {
  /**
   * This registration's own id. The request that registered the lock releases it by this id
   * (`releaseSessionTurn`), because a message id cannot tell two registrations apart: an
   * Approve click resumes in place, into the card's own message id.
   */
  turnId: number
  kind: SessionTurnKind
  startedAt: number
  /**
   * When this turn was last seen doing something: its registration, or the end of the last
   * stream or group run registered under it. The orphan clock runs from here.
   */
  quietSince: number
  /**
   * A stream or group run registered under this lock has ended. With nothing running under
   * it now, the turn is FINISHING (`isSessionTurnFinishing`): its reply is over and its
   * request is doing its after-reply work.
   */
  runEnded: boolean
  messageId?: string | null
  /**
   * This turn answers approval cards (an Approve or Deny click). A click on a card waits for
   * the reply that raised it (`approvalClickWait.ts`), but never for a turn that is itself
   * answering one: that is another click on the same card, and waiting it out would spend
   * the approval twice.
   */
  answersApproval: boolean
  /**
   * Stops THIS registration's request wherever it is, including its setup, before anything is
   * registered to abort (2026-09-18). send-routed forwards it into every run it starts; a Stop
   * during setup (`stopSessionTurn`) and a chat delete (`stopRunningRequests`) abort it.
   */
  stop: AbortController
  /**
   * When a Stop reached this turn through `stopSessionTurn`. A request that has not let go of
   * its lock `ABORTED_TURN_RELEASE_MS` later is stuck, and the lock goes, as it does that long
   * after a stream's abort.
   */
  stoppedAt?: number
  /**
   * BL-4: this lock was handed to a send that waited in the chat's line, and this is the id of
   * the message that send saved. It is hidden from every message read while it waits
   * (`queuedSendHiddenIds.ts`); the sender reveals it once the message is moved to the end of
   * the chat, and the lock's end reveals it too, so no path can leave it hidden for good.
   */
  queuedUserMessageId?: string
}

export type SessionTurnRegistration =
  | {
      ok: true
      entry: SessionTurnEntry
      /**
       * BL-713: this approval click answers the card the chat's line was holding for, and the
       * hold ended with its registration (the tabs are told the send waits for this reply now).
       */
      endedCardHold?: boolean
    }
  | { ok: false; reason: 'turn_in_progress'; existing: SessionTurnEntry }
  | { ok: false; reason: 'session_deleting' }
  /** BL-4: the chat is free for a moment but sends are waiting in its line; they go first. */
  | { ok: false; reason: 'queued_turns_waiting' }

/**
 * BL-4 — why a send in the line will never run. It is handed the chat anyway, in its turn, only
 * to move its saved message to the end of the chat and leave it there unanswered.
 *
 * - `stopped`: a Stop stops everything, a waiting message included (AMD-119-04).
 * - `overflow`: the line already held `QUEUED_SEND_CAP` sends that will run; the sixth got
 *   today's refusal, and its words still end up after the replies it was sent behind.
 * - `shutdown`: Batshit is stopping (or a backup restore is starting, BL-713).
 * - `approval_wait` (BL-713): the line held for an approval card for `QUEUE_CARD_HOLD_LIMIT_MS`
 *   and nobody answered it.
 * - `approval_expired` (BL-713): the only answer the card got was the page's own Deny of an
 *   expired card, which answers no waiting words (BL-455's decision).
 */
export type QueuedSendKeepReason =
  | 'stopped'
  | 'overflow'
  | 'shutdown'
  | 'approval_wait'
  | 'approval_expired'
  /** BL-965: the send's agent was deleted (or could not be read) while it waited. */
  | 'agent_deleted'

/**
 * BL-713 — how a request that lets go of its lock ended, where the chat's line needs to know.
 *
 * - `approvalCardMessageId`: its last run stopped at a pending approval card on this message
 *   (the run's own finish says so, `awaitsApproval`; never read back from Redis).
 * - `answeredApproval`: an approval click whose answer was recorded; `expiryOnly` when the only
 *   answer was the page's own Deny of an expired card.
 */
export type SessionTurnEnd = {
  approvalCardMessageId?: string | null
  answeredApproval?: { expiryOnly: boolean } | null
}

/** BL-713 — the chat's line waits for the user's answer to this card, since this time. */
export type QueueCardHold = { messageId: string; since: number }

/** What the line hands a waiting send when its turn comes (BL-4). */
export type QueuedSessionTurnOutcome =
  | { kind: 'run'; entry: SessionTurnEntry }
  | { kind: 'keep'; entry: SessionTurnEntry; reason: QueuedSendKeepReason }
  | { kind: 'cancelled'; reason: 'session_deleting' }

type QueuedSessionTurnEntry = {
  queueId: number
  kind: SessionTurnKind
  /** The assistant message id the send will register its lock under (`null` for a group send). */
  messageId: string | null
  /** The message the page saved before it posted. Hidden while this entry waits. */
  userMessageId: string
  queuedAt: number
  keep: QueuedSendKeepReason | null
  /**
   * The send's "Queued" forward to every tab (`noteQueuedSendNotice`). A Stop's "Not sent" notice
   * goes out only after it (BL-203): arriving first, it named a bubble no tab had yet, and the
   * late "Queued" then showed a waiting bubble for a send the Stop had kept.
   */
  notice?: Promise<unknown>
  settle: (outcome: QueuedSessionTurnOutcome) => void
}

/** A send waiting in a chat's line, as its request holds it. */
export type QueuedSessionTurn = {
  queueId: number
  userMessageId: string
  outcome: Promise<QueuedSessionTurnOutcome>
  /**
   * BL-713: the line was holding for an approval card with no turn running, and this send, the
   * user's new message, ended the hold (the tabs are told the sends go now).
   */
  endedCardHold: boolean
}

const activeStreams = new Map<string, StreamAbortEntry>()
const activeGroupTurns = new Map<string, GroupAbortEntry>()
const activeSessionTurns = new Map<string, SessionTurnEntry>()
/**
 * Every registration whose request has not released it yet, by chat (2026-09-18).
 *
 * The LOCK above decides who may START a turn, and it can end without its request: a Stop's
 * stale-turn release, the aborted-stream grace, the quiet orphan rule. None of those stop the
 * request, which may still be writing. A delete needs the other fact, "is a request of this chat
 * still running?", and only that request's own `releaseSessionTurn` answers no.
 */
const runningRequests = new Map<string, Map<number, SessionTurnEntry>>()
/**
 * Chats being deleted right now (2026-09-18). A delete stops the chat's running requests and
 * sweeps the chat only once they are done (`sessionDeleteTurnStop.ts`); meanwhile the chat
 * takes no new turn.
 */
const deletingSessions = new Set<string>()
/**
 * BL-549 / BL-622: the turn id (`lastSessionTurnId`, which only grows) of each chat's last turn. A
 * background job in a chat (a nap, a Compact) takes no lock: it reads `lastTurnStartOf` when it
 * begins and asks `hasTurnStartedAfter` before each step that writes, and ends early when a turn
 * started since. A turn that started AND ended during the job leaves no lock and no running
 * request behind, so this is its trace. An id, not a clock: a wall clock can step back. One entry
 * per chat; it leaves when the chat's delete has swept it (`cancelQueuedSessionTurnsOfDeletedChat`).
 */
const lastTurnIdByChat = new Map<string, number>()
const SESSION_TURN_STALE_MS = 6 * 60 * 60 * 1000
const ABORTED_TURN_RELEASE_MS = 5 * 1000
const ORPHANED_TURN_RELEASE_MS = 2 * 60 * 1000
let lastSessionTurnId = 0

/**
 * BL-4 — the sends waiting for each chat, oldest first.
 *
 * A send that meets another turn in its chat used to be refused (`session_turn_in_progress`)
 * after the page had already saved its words, so the words sat in the chat unanswered. Now it
 * waits here, and the chat's lock is handed to the head of the line in the SAME synchronous step
 * that frees it (`dropSessionTurnLock`), so no other request can register in between: the head
 * claims that registration through `registerSessionTurn`'s `claim`. A line is only ever waiting
 * behind a held lock, except for the moment an approval click on the finishing reply's card
 * holds it back (`holdQueueForApprovalClick`); the backstop timer covers that moment and any path
 * that frees a lock without handing it over.
 */
const queuedSessionTurns = new Map<string, QueuedSessionTurnEntry[]>()
/** Approval clicks waiting for the reply that raised their card, by chat. They go first. */
const approvalClickHolds = new Map<string, number>()
/**
 * BL-713 — chats whose line waits for the user's answer to an approval card.
 *
 * A reply that stops at a card has not ended (BL-455): it waits for the user. The request whose
 * last run stopped at the card sets this in the same step that frees its lock, when sends are
 * waiting, so the line hands the chat to nobody: a waiting send would otherwise run a turn beside
 * the card. Only the user lets it go: a click on that card (the hold ends with the click's
 * registration, and the click's reply goes first), a new message, Send now on a waiting send. The
 * backstop keeps the sends once the hold is `QUEUE_CARD_HOLD_LIMIT_MS` old. In the process, like
 * the line: no Redis key.
 */
const queueCardHolds = new Map<string, QueueCardHold>()
/** The hold a click's registration ended, so the click's end can put it back if nothing was answered. */
let cardHoldsEndedByClick = new WeakMap<SessionTurnEntry, QueueCardHold>()
const queueBackstops = new Map<string, ReturnType<typeof setInterval>>()
/**
 * Locks the line handed to a send that will run, whose request has not taken it yet: the request
 * resumes from its wait a step after the handover. A delete that lands in that step lets such a
 * lock go (`beginSessionDelete`), because its request will see the delete and never take it.
 */
let unclaimedHandovers = new WeakSet<SessionTurnEntry>()
/**
 * When each registration's lock went. A lock that went while its request still runs (the grace
 * after a Stop or an aborted stream, the quiet-orphan rule, the interrupt route's clear of a
 * finishing turn) is not a request that has let go: "a lock is not a request".
 */
let lockDroppedAt = new WeakMap<SessionTurnEntry, number>()
let lastQueueId = 0
/** How often a waiting line checks, as a backstop, whether its chat has come free. */
export const QUEUED_SESSION_TURN_BACKSTOP_MS = 250
/**
 * How long a line waits, after a lock went, for that lock's request to let go before the chat
 * goes on anyway: the same bound a chat delete waits for a running request.
 */
export const QUEUED_HANDOVER_REQUEST_WAIT_MS = 30 * 1000
/**
 * BL-713 — how long the line waits for the user's answer to an approval card before it keeps its
 * sends (moved to the end of the chat, unanswered, with Send now in the sending tab). The same
 * fifteen minutes the page's own queue waited before this, now on the server.
 */
export const QUEUE_CARD_HOLD_LIMIT_MS = 15 * 60 * 1000

function createSessionTurnEntry(
  sessionId: string,
  kind: SessionTurnKind,
  messageId: string | null,
  answersApproval: boolean,
  queuedUserMessageId?: string
): SessionTurnEntry {
  const now = Date.now()
  lastSessionTurnId += 1
  const entry: SessionTurnEntry = {
    turnId: lastSessionTurnId,
    kind,
    startedAt: now,
    quietSince: now,
    runEnded: false,
    messageId,
    answersApproval,
    stop: new AbortController(),
    ...(queuedUserMessageId ? { queuedUserMessageId } : {})
  }
  activeSessionTurns.set(sessionId, entry)
  lastTurnIdByChat.set(sessionId, entry.turnId)
  const running = runningRequests.get(sessionId) ?? new Map<number, SessionTurnEntry>()
  running.set(entry.turnId, entry)
  runningRequests.set(sessionId, running)
  return entry
}

/**
 * The ONE way a chat's lock goes. Reveals a waiting send's message the lock was holding (the
 * sender normally has already), then hands the chat to the head of its line, synchronously.
 * `handOver: false` is for the orphan prune, which hands over after its loop so it never adds a
 * lock to the map it is walking.
 */
function dropSessionTurnLock(
  sessionId: string,
  entry: SessionTurnEntry,
  options: { handOver?: boolean } = {}
) {
  activeSessionTurns.delete(sessionId)
  lockDroppedAt.set(entry, Date.now())
  if (entry.queuedUserMessageId) revealQueuedSendMessage(sessionId, entry.queuedUserMessageId)
  if (options.handOver !== false) handOffSessionTurn(sessionId)
}

/** Does a request whose lock went less than `QUEUED_HANDOVER_REQUEST_WAIT_MS` ago still run? */
function isDroppedRequestStillWriting(sessionId: string, now = Date.now()): boolean {
  for (const entry of runningRequests.get(sessionId)?.values() ?? []) {
    const droppedAt = lockDroppedAt.get(entry)
    if (droppedAt !== undefined && now - droppedAt < QUEUED_HANDOVER_REQUEST_WAIT_MS) return true
  }
  return false
}

/** The registration the line handed each waiting send, by its place in the line, until taken. */
const handedByQueueId = new Map<number, { sessionId: string; entry: SessionTurnEntry }>()

function stopQueueBackstop(sessionId: string) {
  const timer = queueBackstops.get(sessionId)
  if (!timer) return
  clearInterval(timer)
  queueBackstops.delete(sessionId)
}

function ensureQueueBackstop(sessionId: string) {
  if (queueBackstops.has(sessionId)) return
  // The orphan rules run too: they free a lock whose request is stuck (after a Stop, or quiet
  // too long), and until now they ran only when some request looked at the lock. A line must
  // not depend on that traffic: its sends, kept ones included, need the chat once each.
  const timer = setInterval(() => {
    pruneStaleSessionTurns()
    keepSendsOfExpiredCardHold(sessionId)
    handOffSessionTurn(sessionId)
  }, QUEUED_SESSION_TURN_BACKSTOP_MS)
  // A waiting send must never hold the process open.
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref()
  queueBackstops.set(sessionId, timer)
}

/**
 * BL-713 — the line held for an approval card for `QUEUE_CARD_HOLD_LIMIT_MS` and nobody answered:
 * its sends are kept (moved to the end of the chat, unanswered, with Send now in the sending tab),
 * the ceiling the page's own queue had before, now on the server. Run by the line's backstop.
 */
function keepSendsOfExpiredCardHold(sessionId: string, now = Date.now()) {
  const hold = queueCardHolds.get(sessionId)
  if (!hold || now - hold.since < QUEUE_CARD_HOLD_LIMIT_MS) return
  keepQueuedSessionTurns(sessionId, 'approval_wait')
}

function cancelQueuedSessionTurns(sessionId: string) {
  const line = queuedSessionTurns.get(sessionId)
  queuedSessionTurns.delete(sessionId)
  queueCardHolds.delete(sessionId)
  stopQueueBackstop(sessionId)
  for (const queued of line ?? []) {
    revealQueuedSendMessage(sessionId, queued.userMessageId)
    queued.settle({ kind: 'cancelled', reason: 'session_deleting' })
  }
}

/**
 * Give the chat to the head of its line, if the chat is free. Synchronous on purpose: it runs in
 * the same step that freed the lock, so nothing can register in between. While the chat is being
 * deleted the line holds: the delete may yet be refused (BL-194), and it cancels the line only
 * once it has swept (`cancelQueuedSessionTurnsOfDeletedChat`). An approval click on the finishing
 * reply's card is let through first (the backstop comes back for the line if the click does not
 * take the chat). While the line holds for an approval card (BL-713), nobody gets the chat until
 * the user lets it go.
 */
function handOffSessionTurn(sessionId: string) {
  const line = queuedSessionTurns.get(sessionId)
  if (!line || line.length === 0) {
    queuedSessionTurns.delete(sessionId)
    queueCardHolds.delete(sessionId)
    stopQueueBackstop(sessionId)
    return
  }
  if (activeSessionTurns.has(sessionId)) return
  if (deletingSessions.has(sessionId)) return
  if ((approvalClickHolds.get(sessionId) ?? 0) > 0) return
  if (queueCardHolds.has(sessionId)) return
  // The chat goes on once the request whose lock went has let go, not merely its lock.
  if (isDroppedRequestStillWriting(sessionId)) return

  const head = line.shift() as QueuedSessionTurnEntry
  if (line.length === 0) {
    queuedSessionTurns.delete(sessionId)
    queueCardHolds.delete(sessionId)
    stopQueueBackstop(sessionId)
  }
  const entry = createSessionTurnEntry(sessionId, head.kind, head.messageId, false, head.userMessageId)
  // Its request may still be busy (it forwards the bubble before it waits): it takes the chat
  // when it comes back for it (`claimQueuedSessionTurn`), or lets it go if it leaves first
  // (`abandonQueuedSessionTurn`). Nothing on a timer takes it back.
  if (!head.keep) unclaimedHandovers.add(entry)
  handedByQueueId.set(head.queueId, { sessionId, entry })
  head.settle(head.keep ? { kind: 'keep', entry, reason: head.keep } : { kind: 'run', entry })
}

/**
 * A stream or group run under this session's lock just ended, so the request that holds the
 * lock is still alive: restart its orphan clock, and note that it has run. Called only when an
 * entry was really removed, so a clear that found nothing is not a sign of life.
 */
function markSessionTurnRunEnded(sessionId: string) {
  const turn = activeSessionTurns.get(sessionId)
  if (!turn) return
  turn.quietSince = Date.now()
  turn.runEnded = true
}

function pruneStaleSessionTurns(now = Date.now()) {
  for (const [sessionId, stream] of activeStreams.entries()) {
    if (now - stream.startedAt > SESSION_TURN_STALE_MS) {
      activeStreams.delete(sessionId)
    }
  }

  for (const [sessionId, group] of activeGroupTurns.entries()) {
    if (now - group.startedAt > SESSION_TURN_STALE_MS) {
      activeGroupTurns.delete(sessionId)
    }
  }

  // BL-4: a freed lock goes to its chat's line AFTER this walk, never inside it.
  const freed: string[] = []
  for (const [sessionId, turn] of activeSessionTurns.entries()) {
    if (now - turn.startedAt > SESSION_TURN_STALE_MS) {
      dropSessionTurnLock(sessionId, turn, { handOver: false })
      freed.push(sessionId)
      continue
    }

    const activeStream = activeStreams.get(sessionId)
    const activeGroup = activeGroupTurns.get(sessionId)
    if (turn.kind === 'single' && activeStream) {
      if (
        typeof activeStream.abortedAt === 'number' &&
        now - activeStream.abortedAt > ABORTED_TURN_RELEASE_MS
      ) {
        activeStreams.delete(sessionId)
        dropSessionTurnLock(sessionId, turn, { handOver: false })
        freed.push(sessionId)
      }
      continue
    }
    if (turn.kind === 'group' && activeGroup) {
      if (
        typeof activeGroup.abortedAt === 'number' &&
        now - activeGroup.abortedAt > ABORTED_TURN_RELEASE_MS
      ) {
        activeGroupTurns.delete(sessionId)
        dropSessionTurnLock(sessionId, turn, { handOver: false })
        freed.push(sessionId)
      }
      continue
    }

    // A Stop reached this turn while nothing was registered to abort. Its request lets go of the
    // lock when the setup checkpoint ends it; one that has not within the aborted-stream grace is
    // stuck, and keeping its lock would block the chat. The request itself may still run, which
    // is what `runningRequests` is for.
    if (typeof turn.stoppedAt === 'number' && now - turn.stoppedAt > ABORTED_TURN_RELEASE_MS) {
      dropSessionTurnLock(sessionId, turn, { handOver: false })
      freed.push(sessionId)
      continue
    }

    // Nothing is running under this lock, so it may be stale: keeping a dead turn's lock
    // blocks the chat while there is nothing left to interrupt. But a live request spends
    // time here too — setting up before its stream exists, and finishing after it ends —
    // so a lock is an orphan only once it has been QUIET that long (`quietSince`), not once
    // it is that OLD. Measured from registration, a reply that ran past two minutes lost
    // its lock the moment its stream ended, while its request was still doing its
    // after-reply work, and the next turn started beside it (2026-09-18, measured live).
    if (now - turn.quietSince <= ORPHANED_TURN_RELEASE_MS) continue
    dropSessionTurnLock(sessionId, turn, { handOver: false })
    freed.push(sessionId)
  }
  for (const sessionId of freed) handOffSessionTurn(sessionId)
}

export function registerStreamAbort(
  sessionId: string,
  messageId: string,
  controller: AbortController
) {
  activeStreams.set(sessionId, {
    messageId,
    controller,
    startedAt: Date.now(),
    abortedAt: null
  })
}

export function clearStreamAbort(sessionId: string, messageId?: string) {
  const entry = activeStreams.get(sessionId)
  if (!entry) return
  if (messageId && entry.messageId !== messageId) return
  activeStreams.delete(sessionId)
  markSessionTurnRunEnded(sessionId)
}

export function abortStream(sessionId: string, reason?: string) {
  pruneStaleSessionTurns()
  const entry = activeStreams.get(sessionId)
  if (!entry) {
    return { ok: false, messageId: null as string | null }
  }

  entry.abortedAt = Date.now()
  try {
    entry.controller.abort(reason ?? 'user')
  } catch {
    // Ignore abort errors (already aborted)
  }

  return { ok: true, messageId: entry.messageId }
}

export function getActiveStream(sessionId: string) {
  pruneStaleSessionTurns()
  return activeStreams.get(sessionId) ?? null
}

/**
 * The Stop of the reply running in this chat, for a helper call that runs a command for it
 * (2026-09-18). A managed CLI reply's helper, and an n8n Workflow Subagent, reach Batshit over
 * HTTP, and that request cannot carry a Stop: SvelteKit aborts `request.signal` only when the
 * caller leaves before the body is read. The reply's registered stream controller is what a Stop,
 * a voice barge-in, and a chat delete abort. `undefined` when no reply runs in the chat: the call
 * keeps its own time limit. The caller passes the session its lane is bound to.
 */
export function getRunningReplyStopSignal(sessionId: string | null | undefined): AbortSignal | undefined {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return undefined
  return getActiveStream(id)?.controller.signal
}

/**
 * BL-1314 — the Stop of ONE reply: the running reply of this chat, only while it is the reply
 * `messageId` names. `getRunningReplyStopSignal` answers with whichever reply runs in the chat
 * now, which is right for ending a command but cannot prove who is calling: a run credential of
 * an earlier reply stays valid until its bridge revokes it, and during that window a newer reply
 * can already run in the same chat. A Settings write admits only its own run, so its caller
 * passes the session AND the message its run credential was minted for. `undefined` when either
 * is missing, when nothing runs, or when another reply runs; an aborted reply gives its aborted
 * signal. Never pass a body field: only the credential's own ids.
 */
export function getOriginatingReplyStopSignal(
  sessionId: string | null | undefined,
  messageId: string | null | undefined
): AbortSignal | undefined {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  const message = typeof messageId === 'string' ? messageId.trim() : ''
  if (!id || !message) return undefined
  const entry = getActiveStream(id)
  return entry && entry.messageId === message ? entry.controller.signal : undefined
}

/** BL-1321: the reason on the Stop a retired run's call gets (see `getRunCredentialStopSignal`). */
export const RETIRED_REPLY_STOP_REASON = 'retired_reply'

/**
 * BL-1321 — the Stop a managed run's helper call hears, from its run credential's own ids
 * (`boundRunCredential`, never a body field). A primary run hears ONLY its own reply: while that
 * reply is the chat's running reply, its Stop; once that reply has ended or a newer reply
 * replaced it, an already-aborted signal, because the run's Stop has in effect fired and its late
 * calls must not run under a successor's Stop (or, after the chat's entry is cleared, with no
 * Stop at all). A Subagent or Worker run (`delegated`) has no reply of its own (its credential
 * names its run id), so it keeps the chat's running reply: its parent's. So does a credential
 * that names no reply. No bound chat: `undefined`, as before.
 */
export function getRunCredentialStopSignal(run: {
  sessionId?: string | null
  messageId?: string | null
  delegated?: boolean | null
}): AbortSignal | undefined {
  const id = typeof run.sessionId === 'string' ? run.sessionId.trim() : ''
  if (!id) return undefined
  const message = typeof run.messageId === 'string' ? run.messageId.trim() : ''
  if (run.delegated === true || !message) return getRunningReplyStopSignal(id)
  return getOriginatingReplyStopSignal(id, message) ?? AbortSignal.abort(RETIRED_REPLY_STOP_REASON)
}

/**
 * Take the chat's turn lock, or say why not.
 *
 * `claim` (BL-4) is the registration the line already handed this very request: a send that
 * waited in the line was given the lock in the same step that freed it, and it takes that lock
 * here, through the same call every send makes, rather than asking for a new one. Any other
 * registration is refused while sends are waiting in the chat's line, even in the moment the
 * chat is free, so nothing jumps the line; only an approval click may, because it answers the
 * card of the reply that just finished and goes before anything sent after it.
 */
export function registerSessionTurn(
  sessionId: string,
  kind: SessionTurnKind,
  messageId?: string | null,
  options: { answersApproval?: boolean } = {},
  claim: SessionTurnEntry | null = null
): SessionTurnRegistration {
  pruneStaleSessionTurns()
  // A chat being deleted takes no new turn: its delete sweeps the chat once the requests it
  // stopped are done, and a turn started now would write into a chat that is about to vanish.
  if (deletingSessions.has(sessionId)) {
    return { ok: false, reason: 'session_deleting' }
  }
  const existing = activeSessionTurns.get(sessionId)
  if (claim) {
    if (existing === claim) {
      unclaimedHandovers.delete(claim)
      return { ok: true, entry: claim }
    }
    return existing
      ? { ok: false, reason: 'turn_in_progress', existing }
      : { ok: false, reason: 'queued_turns_waiting' }
  }
  if (existing) {
    return { ok: false, reason: 'turn_in_progress', existing }
  }
  if (countQueuedSessionTurns(sessionId) > 0 && options.answersApproval !== true) {
    return { ok: false, reason: 'queued_turns_waiting' }
  }

  const entry = createSessionTurnEntry(sessionId, kind, messageId ?? null, options.answersApproval === true)
  // BL-713: the user answered the card the line was holding for. The hold ends here (the line now
  // waits for this click's reply, as behind any running turn), and the click's end decides what
  // comes next (`settleQueueCardHoldAtRelease`).
  const hold = queueCardHolds.get(sessionId)
  if (options.answersApproval === true && hold && hold.messageId === (messageId ?? null)) {
    queueCardHolds.delete(sessionId)
    cardHoldsEndedByClick.set(entry, hold)
    return { ok: true, entry, endedCardHold: true }
  }
  return { ok: true, entry, ...(options.answersApproval === true ? { endedCardHold: false } : {}) }
}

/**
 * BL-4 — wait in the chat's line for the lock another turn holds.
 *
 * The saved message is hidden from every message read from now until its turn (see
 * `queuedSendHiddenIds.ts`). The outcome settles once: `run` with the lock already registered
 * for this send (claim it with `registerSessionTurn(..., claim)`), `keep` with the lock too but
 * only to move the message to the end of the chat unanswered and let go, or `cancelled` because
 * the chat is being deleted. `keep: 'overflow'` enters a send that will never run, so its words
 * still land after the replies ahead of it.
 */
export function queueSessionTurn(
  sessionId: string,
  options: {
    kind: SessionTurnKind
    messageId: string | null
    userMessageId: string
    keep?: QueuedSendKeepReason
  }
): QueuedSessionTurn {
  lastQueueId += 1
  const queueId = lastQueueId
  let settle: (outcome: QueuedSessionTurnOutcome) => void = () => {}
  const outcome = new Promise<QueuedSessionTurnOutcome>((resolve) => {
    let settled = false
    settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  if (deletingSessions.has(sessionId)) {
    settle({ kind: 'cancelled', reason: 'session_deleting' })
    return { queueId, userMessageId: options.userMessageId, outcome, endedCardHold: false }
  }
  const line = queuedSessionTurns.get(sessionId) ?? []
  line.push({
    queueId,
    kind: options.kind,
    messageId: options.messageId,
    userMessageId: options.userMessageId,
    queuedAt: Date.now(),
    keep: options.keep ?? null,
    settle
  })
  queuedSessionTurns.set(sessionId, line)
  hideQueuedSendMessage(sessionId, options.userMessageId)
  ensureQueueBackstop(sessionId)
  // BL-713: the line holds for an approval card and no turn runs: this is the user's new message,
  // their own choice not to wait for the card (as in BL-455). The hold ends and the line runs in
  // the order it was sent. A message sent while a turn runs (a click's reply) was typed during
  // that reply and waits behind it like any other.
  // A send over the cap is kept from the start (it will never run), so it is not the user choosing
  // to go on: it leaves the hold as it is.
  const endedCardHold =
    !options.keep && !activeSessionTurns.has(sessionId) && queueCardHolds.delete(sessionId)
  // A line only waits behind a held lock; if the chat is free this very moment, it goes now.
  handOffSessionTurn(sessionId)
  return { queueId, userMessageId: options.userMessageId, outcome, endedCardHold }
}

/**
 * BL-713 — Send now on a send that waits in the chat's line. It adds no second entry: the send's
 * own request is waiting and runs the turn. If the line holds for an approval card, the hold
 * ends (the user chose not to wait for the card, as in BL-455) and the line runs in order.
 * `waiting: false` when the message is not waiting (it ran already, or was kept): the caller
 * does nothing, so a second press can never answer it twice.
 */
export function sendWaitingSendNow(
  sessionId: string,
  userMessageId: string
): { waiting: boolean; endedCardHold: boolean } {
  const waiting = (queuedSessionTurns.get(sessionId) ?? []).some(
    (queued) => queued.userMessageId === userMessageId && queued.keep === null
  )
  if (!waiting) return { waiting: false, endedCardHold: false }
  const endedCardHold = !activeSessionTurns.has(sessionId) && queueCardHolds.delete(sessionId)
  handOffSessionTurn(sessionId)
  return { waiting: true, endedCardHold }
}

/** BL-713 — the approval card the chat's line waits for, if it holds. A pure read. */
export function getQueueCardHold(sessionId: string): QueueCardHold | null {
  const hold = queueCardHolds.get(sessionId)
  return hold ? { ...hold } : null
}

/**
 * BL-713 — a backup restore starts to drain: it never waits for an approval card. Every line
 * that holds for one (no turn runs in its chat) is kept like a shutdown's, so each send moves
 * its message to the end, unanswered, and lets go of the restore gate at once. A line behind a
 * running reply is left to that reply, as before. Returns the kept messages' ids by chat.
 */
export function keepQueuedSessionTurnsHeldAtApprovalCards(
  reason: QueuedSendKeepReason
): Array<{ sessionId: string; userMessageIds: string[] }> {
  const held = [...queueCardHolds.keys()].filter((sessionId) => !activeSessionTurns.has(sessionId))
  return held.map((sessionId) => ({
    sessionId,
    userMessageIds: keepQueuedSessionTurns(sessionId, reason)
  }))
}

/**
 * BL-713 — what the end of this request means for a line that waits at an approval card. Runs in
 * the same synchronous step that frees the lock, before the handover.
 *
 * - The page's own Deny of an expired card, on the card the line held for: the waiting sends are
 *   kept (`approval_expired`); only the user's own click answers waiting words (BL-455).
 * - A run that stopped at a pending card (the request's own last run, or a click's reply that
 *   raised a new card): the line holds for that card, when sends that will run are waiting.
 * - A click that ended the hold but whose answer was never recorded (refused): the card still
 *   waits, so the hold comes back as it was, again only while a send can still run.
 * - Anything else: nothing; the line goes on.
 */
function settleQueueCardHoldAtRelease(sessionId: string, entry: SessionTurnEntry, end: SessionTurnEnd) {
  const endedByThisClick = cardHoldsEndedByClick.get(entry)
  // Only a send that will still run needs the hold: kept sends (a Stop in the gap before this
  // lock went, the cap) must move at once, and a hold would hide them for fifteen minutes.
  const waiting = countRunnableQueuedSessionTurns(sessionId) > 0
  if (endedByThisClick && end.answeredApproval?.expiryOnly === true) {
    keepQueuedSessionTurns(sessionId, 'approval_expired')
    return
  }
  const cardMessageId =
    typeof end.approvalCardMessageId === 'string' ? end.approvalCardMessageId.trim() : ''
  if (cardMessageId) {
    if (waiting) queueCardHolds.set(sessionId, { messageId: cardMessageId, since: Date.now() })
    return
  }
  if (endedByThisClick && !end.answeredApproval && waiting && !queueCardHolds.has(sessionId)) {
    queueCardHolds.set(sessionId, endedByThisClick)
  }
}

/**
 * BL-4 — the send's request takes the chat the line handed it. `false` when it cannot: the lock
 * went since (dropped or cleared), or the chat is being deleted. A `keep` handover is taken by
 * handing its registration to `keepQueuedSendAtEnd`, which lets it go itself.
 */
export function claimQueuedSessionTurn(sessionId: string, entry: SessionTurnEntry): boolean {
  if (deletingSessions.has(sessionId)) return false
  if (activeSessionTurns.get(sessionId) !== entry) return false
  unclaimedHandovers.delete(entry)
  for (const [queueId, handed] of handedByQueueId) {
    if (handed.entry === entry) handedByQueueId.delete(queueId)
  }
  return true
}

/**
 * BL-4 — a queued send's request is leaving without taking the chat: an early return or a throw
 * anywhere between joining the line and its claim. Still waiting, it leaves the line and its
 * message shows again. Handed and not taken, its registration is let go, so the chat goes on and
 * a delete does not wait on a request that is gone. Taken, there is nothing to do: the request
 * lets go of its own lock.
 */
export function abandonQueuedSessionTurn(sessionId: string, queued: Pick<QueuedSessionTurn, 'queueId'>): void {
  const line = queuedSessionTurns.get(sessionId)
  const index = line?.findIndex((waiting) => waiting.queueId === queued.queueId) ?? -1
  if (line && index >= 0) {
    const [waiting] = line.splice(index, 1)
    revealQueuedSendMessage(sessionId, waiting.userMessageId)
    if (line.length === 0) {
      queuedSessionTurns.delete(sessionId)
      queueCardHolds.delete(sessionId)
      stopQueueBackstop(sessionId)
    }
    return
  }
  const handed = handedByQueueId.get(queued.queueId)
  if (!handed || handed.sessionId !== sessionId) return
  handedByQueueId.delete(queued.queueId)
  unclaimedHandovers.delete(handed.entry)
  releaseSessionTurn(sessionId, handed.entry.turnId)
}

/** Every send waiting in the chat's line, kept ones included. */
export function countQueuedSessionTurns(sessionId: string): number {
  return queuedSessionTurns.get(sessionId)?.length ?? 0
}

/** The sends in the chat's line that will still run: what the cap of five counts. */
export function countRunnableQueuedSessionTurns(sessionId: string): number {
  return (queuedSessionTurns.get(sessionId) ?? []).filter((queued) => queued.keep === null).length
}

/**
 * The sends in the chat's line that will still run, oldest first: what a tab that joins the chat
 * now is shown as "Queued" (the `/api/sse` subscription replays them from here). A kept send is
 * not waiting to run, so it is not listed.
 */
export function listWaitingQueuedSends(
  sessionId: string
): Array<{ userMessageId: string; assistantMessageId: string | null; queuedAt: number }> {
  return (queuedSessionTurns.get(sessionId) ?? [])
    .filter((queued) => queued.keep === null)
    .map((queued) => ({
      userMessageId: queued.userMessageId,
      assistantMessageId: queued.messageId,
      queuedAt: queued.queuedAt
    }))
}

/**
 * BL-203 — the send's request fired its "Queued" forward to every tab, right after it joined the
 * line (nothing awaited between). Kept on its place in the line for `queuedSendNotices`.
 */
export function noteQueuedSendNotice(
  sessionId: string,
  queueId: number,
  notice: Promise<unknown>
): void {
  const queued = queuedSessionTurns.get(sessionId)?.find((waiting) => waiting.queueId === queueId)
  if (queued) queued.notice = notice
}

/**
 * BL-203 — the "Queued" forwards of these waiting sends, for a notice about them that must reach
 * the tabs after their bubbles did. Read at once, while they are still in the line.
 */
export function queuedSendNotices(sessionId: string, userMessageIds: string[]): Promise<unknown>[] {
  const named = new Set(userMessageIds)
  return (queuedSessionTurns.get(sessionId) ?? [])
    .filter((queued) => named.has(queued.userMessageId) && queued.notice)
    .map((queued) => queued.notice as Promise<unknown>)
}

/** Is this saved message waiting in the chat's line? */
export function isUserMessageQueued(sessionId: string, userMessageId: string): boolean {
  return (queuedSessionTurns.get(sessionId) ?? []).some(
    (queued) => queued.userMessageId === userMessageId
  )
}

/**
 * A Stop stops everything, a waiting message included (AMD-119-04): every send in the chat's line
 * is kept. Each still gets the chat in its turn, only to move its message to the end and let go,
 * so the words land after the stopped reply, in the order they were sent. Returns the kept
 * messages' ids.
 */
export function keepQueuedSessionTurns(sessionId: string, reason: QueuedSendKeepReason): string[] {
  const line = queuedSessionTurns.get(sessionId) ?? []
  for (const queued of line) queued.keep ??= reason
  // BL-713: nothing in the line will run now, so an approval-card hold has nothing to hold: each
  // kept send takes the chat in its turn (the backstop hands over within a tick when no turn runs).
  queueCardHolds.delete(sessionId)
  return line.map((queued) => queued.userMessageId)
}

/** Shutdown: keep every chat's line (`keepQueuedSessionTurns` for each). */
export function keepAllQueuedSessionTurns(
  reason: QueuedSendKeepReason
): Array<{ sessionId: string; userMessageIds: string[] }> {
  return [...queuedSessionTurns.keys()].map((sessionId) => ({
    sessionId,
    userMessageIds: keepQueuedSessionTurns(sessionId, reason)
  }))
}

/** The sender moved its message to the end of the chat: show it again. */
export function revealQueuedUserMessage(sessionId: string, userMessageId: string): void {
  revealQueuedSendMessage(sessionId, userMessageId)
}

/**
 * An approval click waits for the reply that raised its card, and that reply's lock going must
 * not hand the chat to a send that arrived after the card did. Held for the length of the
 * click's wait. Letting go hands nothing over by itself: the click's own registration follows in
 * the same step, and the backstop comes back for the line if it does not happen.
 */
export function holdQueueForApprovalClick(sessionId: string): () => void {
  approvalClickHolds.set(sessionId, (approvalClickHolds.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (approvalClickHolds.get(sessionId) ?? 1) - 1
    if (remaining > 0) approvalClickHolds.set(sessionId, remaining)
    else approvalClickHolds.delete(sessionId)
  }
}

/**
 * Stop the chat's current turn wherever it is, with `reason` (2026-09-18). For a turn still
 * SETTING UP, which has no stream or group run registered to abort: measured in a real page, a
 * Stop 150 ms after the send found only the lock, cleared it, and the reply ran `sleep 20` to a
 * full answer (`_local/stopfix-proof/before-page-same-150b.json`). send-routed forwards this into
 * the run, and the setup checkpoint ends it. Stopping is not releasing: the request lets go of
 * its own lock when it is done, or loses it once it has not for `ABORTED_TURN_RELEASE_MS`
 * (`stoppedAt`). `false` when nothing holds the chat.
 */
export function stopSessionTurn(sessionId: string, reason: string): boolean {
  const turn = activeSessionTurns.get(sessionId)
  if (!turn) return false
  // A second Stop does not restart the grace.
  turn.stoppedAt ??= Date.now()
  turn.stop.abort(reason)
  return true
}

/**
 * Stop EVERY running request of the chat, whatever became of its lock, for a delete
 * (`sessionDeleteTurnStop.ts`). Returns how many there were.
 */
export function stopRunningRequests(sessionId: string, reason: string): number {
  const running = runningRequests.get(sessionId)
  if (!running) return 0
  for (const entry of running.values()) entry.stop.abort(reason)
  return running.size
}

/**
 * Mark a chat as being deleted (2026-09-18). `false` when another delete of it is running.
 *
 * The delete stops the chat's running requests and sweeps the chat only once each has released
 * its own registration (`sessionDeleteTurnStop.ts`). Measured before
 * (`_local/deletemid-proof/`): a chat deleted while its reply ran was swept at once, and the
 * reply's request went on writing its message, message list, zip, zip set, and Execution Viewer
 * log into a chat that no longer existed, where nothing sweeps them. While marked, the chat
 * takes no new turn (`registerSessionTurn`).
 */
export function beginSessionDelete(sessionId: string): boolean {
  if (deletingSessions.has(sessionId)) return false
  deletingSessions.add(sessionId)
  // BL-4: sends waiting for this chat stay in its line while it is being deleted: the line holds
  // (`handOffSessionTurn`), and the delete tells them the chat is gone only once it has swept
  // (BL-194). Cancelled here, each answered "This chat was deleted." even when the delete was
  // then refused and the chat, with their words in it, stayed.
  // A send the line has just handed the chat to, whose request has not taken it yet, never will:
  // it sees this delete first. Its lock goes now, so the delete does not wait on it.
  const handed = activeSessionTurns.get(sessionId)
  if (handed && unclaimedHandovers.has(handed)) {
    unclaimedHandovers.delete(handed)
    releaseSessionTurn(sessionId, handed.turnId)
  }
  return true
}

/**
 * BL-194 — the delete has swept the chat: every send still waiting in its line is told the chat
 * was deleted (`cancelled`), and its saved message went with the chat. Called only after a sweep
 * that finished; a refused or failed delete leaves the line to go on (`endSessionDelete`).
 */
export function cancelQueuedSessionTurnsOfDeletedChat(sessionId: string): void {
  cancelQueuedSessionTurns(sessionId)
  lastTurnIdByChat.delete(sessionId)
}

/**
 * The delete is over (swept, or refused): the chat takes turns again. A line still waiting (the
 * delete was refused, or its sweep failed) goes on: each send reads the chat again under its own
 * lock, so one whose chat did go answers "deleted" there.
 */
export function endSessionDelete(sessionId: string): void {
  deletingSessions.delete(sessionId)
  handOffSessionTurn(sessionId)
}

export function isSessionDeleting(sessionId: string): boolean {
  return deletingSessions.has(sessionId)
}

/**
 * BL-549 / BL-622: the id of this chat's last turn start (0 when none is known). A nap or a Compact
 * reads it when it begins, then asks `hasTurnStartedAfter` with it. A pure read.
 */
export function lastTurnStartOf(sessionId: string): number {
  return lastTurnIdByChat.get(sessionId) ?? 0
}

/**
 * BL-549 / BL-622: has a turn of this chat started after the one `seenTurnId` names (from
 * `lastTurnStartOf`)? Also true once that turn has ended. A pure read: it never prunes.
 */
export function hasTurnStartedAfter(sessionId: string, seenTurnId: number): boolean {
  return lastTurnStartOf(sessionId) > seenTurnId
}

/** For tests: how many chats have a turn-start trace. */
export function __turnStartTraceCountForTests(): number {
  return lastTurnIdByChat.size
}

/**
 * Is a request of this chat still running: registered, and not yet released by ITSELF?
 *
 * Not the same question as "is the chat locked". A Stop's stale-turn release, the aborted-stream
 * grace, and the quiet orphan rule all end a LOCK while its request may still be writing; after
 * a Stop on the API lane the request ran on for 22 s behind a running command (measured,
 * `_local/deletemid-proof/stoptime-api-1.json`), and its lock went after five. A pure read.
 */
export function hasRunningRequest(sessionId: string): boolean {
  return (runningRequests.get(sessionId)?.size ?? 0) > 0
}

/**
 * Is this message a reply that a running request of its chat is still writing (BL-381)? A pure
 * read, for the message delete route.
 *
 * Two facts, both from this registry: a request not yet released by ITSELF whose registration
 * names the message (`runningRequests`, the fact `hasRunningRequest` reads: the lock can go while
 * the request still writes, and its finalize saves the reply before it lets go), and the stream
 * running now (a context continuation or a promoted turn streams a new message id under the first
 * request's registration). A delete of such a reply used to be undone: the next chunk re-created
 * it in the tab, and the finalize's `saveMessage` put it back on the chat's list.
 */
export function isMessageOfRunningRequest(sessionId: string, messageId: string): boolean {
  if (!messageId) return false
  for (const entry of runningRequests.get(sessionId)?.values() ?? []) {
    if (entry.messageId === messageId) return true
  }
  return activeStreams.get(sessionId)?.messageId === messageId
}

/**
 * Clear a chat's lock on behalf of the user: the interrupt route's stale-turn branch, which
 * finds a lock with no stream or group run under it.
 *
 * Naming the `messageId` of the reply being stopped clears that reply's lock. It is NOT how
 * a request releases its own lock — that is `releaseSessionTurn`, by registration — because
 * a message id cannot tell two registrations apart: an Approve click resumes in place, into
 * the card's own message id.
 *
 * A release with no id used to delete whatever it found, which let any caller that simply
 * omitted the field — the DM drawer's Stop on a stale row, the artifact auto-followup —
 * wipe a live turn's lock, after which the 409 interlock in `send-routed` is blind and a
 * second turn can start in the same chat. So an unowned release honours the rule
 * `pruneStaleSessionTurns` applies: a turn that HAS a message id and has not been quiet for
 * `ORPHANED_TURN_RELEASE_MS` is still alive (setting up, or finishing), not an orphan, and is
 * left alone. The group lane (message id `null`) is released by registration like any turn.
 */
export function clearSessionTurn(sessionId: string, messageId?: string | null) {
  const entry = activeSessionTurns.get(sessionId)
  if (!entry) return

  if (messageId) {
    if (entry.messageId && entry.messageId !== messageId) return
    dropSessionTurnLock(sessionId, entry)
    return
  }

  if (entry.messageId && Date.now() - entry.quietSince <= ORPHANED_TURN_RELEASE_MS) return
  dropSessionTurnLock(sessionId, entry)
}

/**
 * Release the lock THIS request registered, and only that one (2026-09-18).
 *
 * send-routed used to release with `clearSessionTurn(sessionId, requestedMessageId)`. That
 * is an owned release only while message ids are unique per turn, and they are not: an
 * Approve click resumes in place, into the card's own message id. Measured live
 * (`_local/lock-prune-proof/before-sim.json`): the reply that raised the card was still
 * finishing, a click took the chat, and the reply's `finally` then deleted the CLICK's lock
 * by that shared id — so a second tab's click on the same card ran the approved command a
 * second time. The registration's own id cannot collide.
 *
 * BL-713: `end` says how the request ended where the chat's line needs to know (its last run
 * stopped at an approval card; a click's answer was recorded). It is read in the same step that
 * frees the lock (`settleQueueCardHoldAtRelease`), while this request still holds it, or (BL-906 a)
 * when its lock went first and nothing has taken the chat since: the line waited for this request
 * all the same ("a lock is not a request"), so its end decides, exactly as if it still held it.
 */
export function releaseSessionTurn(
  sessionId: string,
  turnId: number,
  end: SessionTurnEnd = {}
): boolean {
  // The request is done, whatever became of its lock (`hasRunningRequest`).
  const running = runningRequests.get(sessionId)
  const ownEntry = running?.get(turnId)
  if (running?.delete(turnId) && running.size === 0) {
    runningRequests.delete(sessionId)
    // Group replies have no single lock message id, and an approval resume may share one.
    // Clear only after the last request, never while a newer overlapping turn can still write.
    clearToolModelRetentionBudgetsForSession(sessionId)
  }

  const entry = activeSessionTurns.get(sessionId)
  if (!entry || entry.turnId !== turnId) {
    // Its lock went earlier while it still ran (the interrupt route's clear of a finishing turn,
    // the quiet-orphan rule, the six-hour rule). BL-906 (a): if no registration came since, the
    // chat is still this request's to settle, so a card it stopped at holds the line as it would
    // have with the lock; a later turn, or a click, settled the chat already.
    if (!entry && ownEntry && lastTurnIdByChat.get(sessionId) === turnId) {
      settleQueueCardHoldAtRelease(sessionId, ownEntry, end)
    }
    // A line waiting on it goes on now (or holds for the card).
    handOffSessionTurn(sessionId)
    return false
  }
  settleQueueCardHoldAtRelease(sessionId, entry, end)
  dropSessionTurnLock(sessionId, entry)
  return true
}

/**
 * Does another registration hold this chat's lock now?
 *
 * A request's run-end sandbox sweep removes the chat's sandboxes even while a command runs
 * in one, because it assumes the chat's run is over. That holds while the request still has
 * the chat, or nobody does; once another turn holds it — its lock was taken as an orphan, or
 * cleared by a Stop — the sweep would kill that turn's commands, and the newer turn already
 * swept on its way in. A pure read: it never prunes.
 */
export function isSessionTurnHeldByAnother(sessionId: string, turnId: number): boolean {
  const entry = activeSessionTurns.get(sessionId)
  return entry != null && entry.turnId !== turnId
}

/**
 * Does a request of this chat other than `turnId` still run (BL-198)? A pure read.
 *
 * The lock can go while its request still runs (the grace after a Stop or an aborted stream, the
 * quiet-orphan rule, the interrupt route's clear), and the line hands the chat on at most
 * `QUEUED_HANDOVER_REQUEST_WAIT_MS` later even if that request never lets go. The next turn then
 * holds the lock itself, so `isSessionTurnHeldByAnother` is no help to its PRE-run sandbox sweep,
 * which removes the chat's sandboxes even mid-command: that sweep asks this instead.
 */
export function isAnotherRequestRunning(sessionId: string, turnId: number): boolean {
  for (const runningTurnId of runningRequests.get(sessionId)?.keys() ?? []) {
    if (runningTurnId !== turnId) return true
  }
  return false
}

export function getActiveSessionTurn(sessionId: string) {
  pruneStaleSessionTurns()
  return activeSessionTurns.get(sessionId) ?? null
}

/**
 * Is this chat's turn only FINISHING (2026-09-18)?
 *
 * Its lock is held, a stream or group run under it has ended, and nothing runs under it now:
 * the reply is over (the browser already has `end`) and the request is doing its after-reply
 * work — the Execution Viewer snapshot, the Judge Juice after-reply steps, the run-end sandbox
 * sweep. A group turn runs until its group run ends, even between two speakers. A request
 * that starts another run under its lock (a context-exhaustion continuation, or a queued
 * message the server promotes into the next turn) is running again, not finishing. Prunes
 * first, so an orphan is not finishing.
 */
export function isSessionTurnFinishing(sessionId: string): boolean {
  pruneStaleSessionTurns()
  const turn = activeSessionTurns.get(sessionId)
  if (!turn || !turn.runEnded) return false
  return turn.kind === 'group' ? !activeGroupTurns.has(sessionId) : !activeStreams.has(sessionId)
}

/**
 * SA-113 P2 (DL-113-16) — every session with a turn in flight right now.
 *
 * `sys.dm.agents` maps these to agents through each session's `agent_id`, so a sender can
 * see "Cooper is mid-task" before choosing wait or wake. No polling and no new store: the
 * server already knows, this just lets presence read it.
 */
export function listActiveSessionTurns(): Array<
  { sessionId: string } & SessionTurnEntry
> {
  pruneStaleSessionTurns()
  return [...activeSessionTurns.entries()].map(([sessionId, entry]) => ({
    sessionId,
    ...entry
  }))
}

export function registerGroupAbort(sessionId: string, controller: AbortController) {
  activeGroupTurns.set(sessionId, {
    controller,
    startedAt: Date.now(),
    abortedAt: null
  })
}

export function clearGroupAbort(sessionId: string) {
  if (activeGroupTurns.delete(sessionId)) markSessionTurnRunEnded(sessionId)
}

export function abortGroupChat(sessionId: string, reason?: string) {
  pruneStaleSessionTurns()
  const entry = activeGroupTurns.get(sessionId)
  if (!entry) {
    return { ok: false }
  }

  entry.abortedAt = Date.now()
  try {
    entry.controller.abort(reason ?? 'user')
  } catch {
    // Ignore abort errors (already aborted)
  }

  return { ok: true }
}

export function getActiveGroupAbort(sessionId: string) {
  pruneStaleSessionTurns()
  return activeGroupTurns.get(sessionId) ?? null
}

/**
 * Test-only hard reset, so one suite's locks cannot leak into the next.
 *
 * Teardown used to call `clearSessionTurn(sessionId)` for this, which worked only because
 * an id-less release deleted unconditionally — the very behaviour that let a stale Stop
 * cancel a live turn. Precedent: `__resetWakeRunRegistryForTests`.
 *
 * A send still waiting in a line is told its chat went away (BL-242): a request left waiting on
 * a line the reset wiped used to wait forever, and one a timed-out test left behind ran on into
 * the next test instead of ending.
 */
export function __resetStreamAbortRegistryForTests(): void {
  const waiting = [...queuedSessionTurns.values()].flat()
  activeStreams.clear()
  activeGroupTurns.clear()
  activeSessionTurns.clear()
  runningRequests.clear()
  deletingSessions.clear()
  lastTurnIdByChat.clear()
  queuedSessionTurns.clear()
  approvalClickHolds.clear()
  queueCardHolds.clear()
  cardHoldsEndedByClick = new WeakMap()
  for (const timer of queueBackstops.values()) clearInterval(timer)
  queueBackstops.clear()
  unclaimedHandovers = new WeakSet()
  handedByQueueId.clear()
  lockDroppedAt = new WeakMap()
  __resetQueuedSendHiddenIdsForTests()
  for (const queued of waiting) queued.settle({ kind: 'cancelled', reason: 'session_deleting' })
}
