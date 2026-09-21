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

type SessionTurnEntry = {
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
}

export type SessionTurnRegistration =
  | { ok: true; entry: SessionTurnEntry }
  | { ok: false; reason: 'turn_in_progress'; existing: SessionTurnEntry }
  | { ok: false; reason: 'session_deleting' }

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
const SESSION_TURN_STALE_MS = 6 * 60 * 60 * 1000
const ABORTED_TURN_RELEASE_MS = 5 * 1000
const ORPHANED_TURN_RELEASE_MS = 2 * 60 * 1000
let lastSessionTurnId = 0

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

  for (const [sessionId, turn] of activeSessionTurns.entries()) {
    if (now - turn.startedAt > SESSION_TURN_STALE_MS) {
      activeSessionTurns.delete(sessionId)
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
        activeSessionTurns.delete(sessionId)
      }
      continue
    }
    if (turn.kind === 'group' && activeGroup) {
      if (
        typeof activeGroup.abortedAt === 'number' &&
        now - activeGroup.abortedAt > ABORTED_TURN_RELEASE_MS
      ) {
        activeGroupTurns.delete(sessionId)
        activeSessionTurns.delete(sessionId)
      }
      continue
    }

    // A Stop reached this turn while nothing was registered to abort. Its request lets go of the
    // lock when the setup checkpoint ends it; one that has not within the aborted-stream grace is
    // stuck, and keeping its lock would block the chat. The request itself may still run, which
    // is what `runningRequests` is for.
    if (typeof turn.stoppedAt === 'number' && now - turn.stoppedAt > ABORTED_TURN_RELEASE_MS) {
      activeSessionTurns.delete(sessionId)
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
    activeSessionTurns.delete(sessionId)
  }
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

export function registerSessionTurn(
  sessionId: string,
  kind: SessionTurnKind,
  messageId?: string | null,
  options: { answersApproval?: boolean } = {}
): SessionTurnRegistration {
  pruneStaleSessionTurns()
  // A chat being deleted takes no new turn: its delete sweeps the chat once the requests it
  // stopped are done, and a turn started now would write into a chat that is about to vanish.
  if (deletingSessions.has(sessionId)) {
    return { ok: false, reason: 'session_deleting' }
  }
  const existing = activeSessionTurns.get(sessionId)
  if (existing) {
    return { ok: false, reason: 'turn_in_progress', existing }
  }

  const now = Date.now()
  lastSessionTurnId += 1
  const entry: SessionTurnEntry = {
    turnId: lastSessionTurnId,
    kind,
    startedAt: now,
    quietSince: now,
    runEnded: false,
    messageId: messageId ?? null,
    answersApproval: options.answersApproval === true,
    stop: new AbortController()
  }
  activeSessionTurns.set(sessionId, entry)
  const running = runningRequests.get(sessionId) ?? new Map<number, SessionTurnEntry>()
  running.set(entry.turnId, entry)
  runningRequests.set(sessionId, running)
  return { ok: true, entry }
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
  return true
}

/** The delete is over (swept, or refused): the chat takes turns again. */
export function endSessionDelete(sessionId: string): void {
  deletingSessions.delete(sessionId)
}

export function isSessionDeleting(sessionId: string): boolean {
  return deletingSessions.has(sessionId)
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
    activeSessionTurns.delete(sessionId)
    return
  }

  if (entry.messageId && Date.now() - entry.quietSince <= ORPHANED_TURN_RELEASE_MS) return
  activeSessionTurns.delete(sessionId)
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
 */
export function releaseSessionTurn(sessionId: string, turnId: number): boolean {
  // The request is done, whatever became of its lock (`hasRunningRequest`).
  const running = runningRequests.get(sessionId)
  if (running?.delete(turnId) && running.size === 0) runningRequests.delete(sessionId)

  const entry = activeSessionTurns.get(sessionId)
  if (!entry || entry.turnId !== turnId) return false
  activeSessionTurns.delete(sessionId)
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

export function getActiveSessionTurn(sessionId: string) {
  pruneStaleSessionTurns()
  return activeSessionTurns.get(sessionId) ?? null
}

/**
 * Is this chat's turn only FINISHING (2026-09-18)?
 *
 * Its lock is held, a stream or group run under it has ended, and nothing runs under it now:
 * the reply is over (the browser already has `end`) and the request is doing its after-reply
 * work — the Execution Viewer snapshot, the Jev Juice after-reply steps, the run-end sandbox
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
 */
export function __resetStreamAbortRegistryForTests(): void {
  activeStreams.clear()
  activeGroupTurns.clear()
  activeSessionTurns.clear()
  runningRequests.clear()
  deletingSessions.clear()
}
