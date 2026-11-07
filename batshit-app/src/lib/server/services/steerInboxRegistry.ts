/**
 * SA-114 P1 (DL-114-02) — the in-process steer inbox.
 *
 * A "steer" is a message the user sent while the agent was still replying. The server takes
 * the text the moment it accepts it, holds it here, and the running turn's transport hands
 * it to the model at the next tool boundary. Anything still waiting when the reply ends is
 * promoted into the next turn (DL-114-07), so a closed tab can never lose what was typed.
 *
 * Why in-process rather than Redis, matching `wakeRunRegistry.ts` and `workerTurnBudget.ts`:
 * a steer is only ever accepted and consumed inside the one SvelteKit process that is
 * running the turn it belongs to. A module-level map therefore needs no new Redis key in
 * `deleteSession`, no backup-inventory decision, and no cross-process coordination Batshit
 * does not have. It resets on restart — and a restart also kills every turn these entries
 * describe, so the reset is honest rather than a leak.
 *
 * This is a SEPARATE map from `streamAbortRegistry`'s three (DL-114-02): the session-turn
 * lock has no per-turn payload slot, and a steer must never be able to touch it. This
 * module deliberately imports nothing but the shared caps, so it stays leaf-level.
 *
 * What this module must NEVER do, pinned by `steerInboxRegistry.test.ts`: touch
 * `registerSessionTurn`, `consumePostCompileSessionClips`, or `commitMemoryTurnState`. A
 * delivered steer rides inside a turn that has already paid those costs once.
 */

import {
  MAX_PENDING_STEERS,
  STEER_DM_ALREADY_PENDING_REASON,
  type DeliveredSteer,
  type SteerEntry,
  type SteerLane
} from '$lib/utils/steerControl'

/**
 * SA-119 P1 (DL-119-05) — is this entry Queue rather than Steer?
 *
 * ONE predicate for every take at a tool boundary, so a door added later cannot come to
 * disagree about what "held" means. A held entry injected at a boundary is the user's NEXT
 * message arriving inside the answer it was meant to follow. Today the one door is
 * `takePendingSteersForDelivery` (the `prepareStep` hook, which the Claude plan connection
 * runs through too); SA-139 R4 removed the managed CLI's push.
 *
 * Deliberately NOT applied by `takeUndeliveredSteers`: the end of the turn is exactly where
 * a held entry is supposed to be taken, beside every steer that never found a boundary, in
 * acceptance order.
 */
function isHeldForEndOfTurn(entry: SteerEntry): boolean {
  return entry.deliver === 'end'
}

interface SteerInboxState {
  /** Accepted, not yet handed to the model. */
  pending: SteerEntry[]
  /** Reached the model, not yet written into the transcript by send-routed. */
  delivered: DeliveredSteer[]
  updatedAt: number
}

/**
 * P2 (DL-114-06, DL-114-08, DL-114-09) — the running turn, as steering sees it.
 *
 * **Can it be steered, and why not.** `resolveSteerability` answers that once, in
 * send-routed, at the moment the run is registered — it is the only place that knows the
 * agent type and whether this is a group member's run. The steer route reads the answer
 * instead of re-deriving it, because a second derivation is how the route would come to
 * promise a steer the turn cannot carry. It lives in THIS module rather than on the
 * stream-abort entry for the same reason DL-114-02 gave the inbox its own map: the interrupt
 * path and its registry stay byte-identical through this story (DL-114-15), and steering may
 * not grow a field on them.
 *
 * **How to reach it.** The run PULLS: the SDK calls `prepareStep` between steps and the hook
 * takes whatever is waiting (`takePendingSteersForDelivery`). SA-139 R4 removed the managed
 * CLI Primary, the one run the route pushed to.
 */
export interface SteerRunRegistration {
  /** The assistant message id this run is writing. A later turn registers its own. */
  messageId: string
  steerable: boolean
  /** Plain-English "why not", shown in the client's tooltip. Null when steerable. */
  reason: string | null
  lane: SteerLane | null
  /**
   * SA-139 BL-2358: the longest agent DM, in its model wrapper, this run can hand into the reply.
   * The Claude plan connection hands a DM steer to Claude Code as a hook note, which Claude Code
   * passes on whole only up to its limit. Absent or null: no limit.
   */
  dmSteerLimit?: number | null
}

const inboxes = new Map<string, SteerInboxState>()
const runs = new Map<string, SteerRunRegistration>()

/**
 * A turn that dies without unwinding its `finally` would leave entries behind. Every real
 * path clears the inbox; this bound exists only so an unforeseen throw cannot make a
 * session look permanently full. Entries are also pinned to one assistant `messageId`, so a
 * stale entry can never be delivered into a later turn even before this prune runs.
 */
const INBOX_MAX_AGE_MS = 6 * 60 * 60 * 1000

function pruneStaleInboxes(now: number) {
  for (const [sessionId, state] of inboxes) {
    if (now - state.updatedAt > INBOX_MAX_AGE_MS) {
      inboxes.delete(sessionId)
    }
  }
}

function getState(sessionId: string): SteerInboxState | null {
  return inboxes.get(sessionId) ?? null
}

function emptyState(now: number): SteerInboxState {
  return { pending: [], delivered: [], updatedAt: now }
}

export type SteerEnqueueResult =
  | { ok: true; pending: number }
  | { ok: false; code: 'steer_inbox_full' | 'steer_dm_pending'; reason: string }

/**
 * Accept a steer for the turn named by `entry.messageId`.
 *
 * The cap counts steers still WAITING, not steers this turn has seen: one that has already
 * reached the model has freed its slot, and a long tool-heavy reply should not lock the
 * user out after five successful steers. A sixth waiting steer is refused with a reason
 * rather than queued behind the others. SA-119 (DL-119-05): a `deliver: 'end'` entry counts
 * like any other — it is one of the messages waiting for this reply, and it never frees its
 * slot by reaching the model, which is exactly why it must not be exempt.
 *
 * P4 (DL-114-13) adds the second rule, for DM-sourced entries only: **one pending DM steer
 * per recipient turn.** Several agents' notes landing inside one reply would read to the
 * user as a conversation they never saw, and the five slots belong to the person typing.
 * It counts PENDING DM entries, not DM entries this turn has seen, for the same reason the
 * cap above does: one that has already reached the model is part of the reply now, and a
 * long tool-heavy turn should not be limited to a single DM for its whole length.
 */
export function enqueueSteer(
  sessionId: string,
  entry: SteerEntry,
  now = Date.now()
): SteerEnqueueResult {
  pruneStaleInboxes(now)
  const state = inboxes.get(sessionId) ?? emptyState(now)

  // PR #106 review F-10: counted for THIS reply only, like every sibling in this module. In
  // the overlap window `clearSteerInbox`'s `keepMessageId` exists for, a stopped turn's dead
  // entries must not spend the live turn's budget, and the refusal sentence must not name
  // messages that are not in the reply the user is looking at.
  const waiting = state.pending.filter(
    (waitingEntry) => waitingEntry.messageId === entry.messageId
  ).length
  if (waiting >= MAX_PENDING_STEERS) {
    return {
      ok: false,
      code: 'steer_inbox_full',
      reason: `${waiting} messages are already waiting for this reply (Batshit holds ${MAX_PENDING_STEERS}). Wait for the reply to finish.`
    }
  }

  if (entry.source === 'dm') {
    const dmWaiting = state.pending.some(
      (waitingEntry) =>
        waitingEntry.source === 'dm' && waitingEntry.messageId === entry.messageId
    )
    if (dmWaiting) {
      return {
        ok: false,
        code: 'steer_dm_pending',
        reason: STEER_DM_ALREADY_PENDING_REASON
      }
    }
  }

  state.pending = [...state.pending, entry]
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return { ok: true, pending: state.pending.length }
}

/** Read-only snapshot of what is still waiting, for the route's own reporting and tests. */
export function listPendingSteers(sessionId: string): SteerEntry[] {
  return [...(getState(sessionId)?.pending ?? [])]
}

export function countPendingSteers(sessionId: string, messageId?: string): number {
  const waiting = getState(sessionId)?.pending ?? []
  if (!messageId) return waiting.length
  return waiting.filter((entry) => entry.messageId === messageId).length
}

/**
 * Hand every waiting steer for this turn to the model's next step, in acceptance order.
 *
 * Taking and marking delivered are ONE step on purpose. On the API lane the caller is
 * `prepareStep`, and by the time it returns the injected message the SDK will send it — P0
 * measured the injection reaching the model, carrying forward, and never persisting. A
 * two-step take-then-confirm would open a window where a steer is in neither list.
 *
 * Entries are filtered by `messageId` so a leftover from an earlier turn can never be
 * delivered into a later one, including the promoted follow-up turn (DL-114-07), which
 * always carries a new assistant id.
 *
 * SA-119 (DL-119-05): a `deliver: 'end'` entry is skipped and left pending. Queue means the
 * end of the reply, so a boundary is precisely where it must NOT go.
 */
export function takePendingSteersForDelivery(
  sessionId: string,
  messageId: string,
  options: { step: number; lane: SteerLane },
  now = Date.now()
): DeliveredSteer[] {
  const state = getState(sessionId)
  if (!state || state.pending.length === 0) return []

  // DL-119-05: a queued message is skipped here and stays pending for the promotion. The
  // filter is on the ENTRY, not on the message id, so the entries left behind keep their
  // place in the list and their acceptance order.
  const mine = (entry: SteerEntry) =>
    entry.messageId === messageId && !isHeldForEndOfTurn(entry)
  const taken = state.pending.filter(mine)
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => !mine(entry))
  const delivered = taken.map((entry) => ({
    ...entry,
    step: options.step,
    lane: options.lane
  }))
  state.delivered = [...state.delivered, ...delivered]
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return delivered
}

/**
 * Take the steers that reached the model but are not yet in the transcript.
 *
 * send-routed drains this once per stream iteration and writes each one into the streamed
 * content at that exact position (DL-114-04). Draining is what makes the marker land after
 * the tool result's zip placeholder and before the next text chunk.
 *
 * `upToStep` (F-P1-3) is the gate that makes the position deterministic: the SDK runs
 * ahead of send-routed's consumption loop, so a steer delivered after step k can be handed
 * back while the loop is still writing step k's — or an earlier step's — chunks. A steer
 * whose `step` is greater than the number of `finish-step` chunks the loop has consumed is
 * therefore left in place; it is drained once the loop has consumed that step's finish,
 * which is exactly after everything the step produced. Omit the bound to take everything,
 * which is what the finish path does.
 */
export function drainDeliveredSteers(
  sessionId: string,
  messageId: string,
  options: { upToStep?: number } = {},
  now = Date.now()
): DeliveredSteer[] {
  const state = getState(sessionId)
  if (!state || state.delivered.length === 0) return []

  const upToStep =
    typeof options.upToStep === 'number' && Number.isFinite(options.upToStep)
      ? options.upToStep
      : Number.POSITIVE_INFINITY
  const ready = (entry: DeliveredSteer) =>
    entry.messageId === messageId && entry.step <= upToStep

  const drained = state.delivered.filter(ready)
  if (drained.length === 0) return []

  state.delivered = state.delivered.filter((entry) => !ready(entry))
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return drained
}

/**
 * Take everything still waiting when a turn ends — DL-114-07's promotion input.
 *
 * The caller decides whether to promote: an interrupted or Stopped turn must NOT, because
 * Stop means stop and the client still holds what it typed.
 *
 * SA-119 (DL-119-05): queued entries are taken HERE and nowhere else. That is the whole of
 * Queue's server half — the boundary take skips them, this takes them with everything else
 * still waiting, in acceptance order, and `promoteSteersToNextTurn` joins the lot into ONE
 * next user message.
 *
 * P4 (DL-114-13): `source` narrows what is taken, and the promotion loop passes `'user'`.
 * A DM steer is never promoted — an agent's text must not start a user turn — so leaving it
 * here is what lets the end of the request read it and degrade it to `wait`. Taking it and
 * then filtering it out of the promotable list, which is what P1 did, removed the entry
 * from the only place the degrade could have found it.
 */
export function takeUndeliveredSteers(
  sessionId: string,
  messageId: string,
  options: { source?: SteerEntry['source'] } = {},
  now = Date.now()
): SteerEntry[] {
  const state = getState(sessionId)
  if (!state) return []

  const wantedSource = options.source
  const mine = (entry: SteerEntry) =>
    entry.messageId === messageId && (!wantedSource || entry.source === wantedSource)
  const taken = state.pending.filter(mine).sort((a, b) =>
    a.at === b.at ? 0 : a.at < b.at ? -1 : 1
  )
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => !mine(entry))
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return taken
}

/**
 * BL-137 — the reply carries on under a new message id: a context-exhaustion continuation.
 *
 * Every entry is filed under the assistant message it belongs inside, and a continuation is the
 * same reply to the user, written under a fresh id. A steer accepted while the run that ran out
 * of room was going, and never handed to the model there, moves to the continuation as a
 * waiting entry: its boundaries hand it over, and its end promotes what is left. Left
 * behind, it was never delivered, the promotion took the last run's id, and the request's
 * `finally` cleared it: the user saw only an unanswered receipt. Acceptance order is kept, and a
 * delivered entry stays with the run whose transcript it is written into. Returns how many moved.
 */
export function refileUndeliveredSteers(
  sessionId: string,
  fromMessageId: string,
  toMessageId: string,
  now = Date.now()
): number {
  const state = getState(sessionId)
  if (!state || fromMessageId === toMessageId) return 0
  const fromRun = (entry: SteerEntry) => entry.messageId === fromMessageId
  const moving = state.pending.filter(fromRun).sort((a, b) =>
    a.at === b.at ? 0 : a.at < b.at ? -1 : 1
  )
  if (moving.length === 0) return 0
  state.pending = [
    ...state.pending.filter((entry) => !fromRun(entry)),
    ...moving.map((entry) => ({ ...entry, messageId: toMessageId }))
  ]
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return moving.length
}

/**
 * P4 (DL-114-13) — take every DM steer this request is about to throw away.
 *
 * Called from send-routed's `finally` immediately BEFORE `clearSteerInbox`, with the same
 * `keepMessageId`, so it sees exactly the entries that clear is going to delete and nothing
 * that belongs to a live turn somebody else owns. Each one is stamped back to `wait` on its
 * DM record, which is the honest outcome: the reply it was aimed at has ended.
 *
 * Not merged into `clearSteerInbox` even though they always run together: that function is
 * synchronous and leaf-level by design (its only import is `steerControl`), and stamping a
 * DM needs Redis. Keeping the Redis work in the caller is what keeps this module a map.
 */
export function takeMissedDmSteers(
  sessionId: string,
  options: { keepMessageId?: string | null } = {}
): SteerEntry[] {
  const state = getState(sessionId)
  if (!state) return []
  const keep = typeof options.keepMessageId === 'string' ? options.keepMessageId : null
  const missed = (entry: SteerEntry) => entry.source === 'dm' && entry.messageId !== keep

  const taken = state.pending.filter(missed)
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => !missed(entry))
  state.updatedAt = Date.now()
  inboxes.set(sessionId, state)
  return taken
}

/** Exact user entries this request's clear will discard; never another live run's. */
export function takeMissedUserSteers(
  sessionId: string,
  options: { keepMessageId?: string | null } = {}
): SteerEntry[] {
  const state = getState(sessionId)
  if (!state) return []
  const keep = typeof options.keepMessageId === 'string' ? options.keepMessageId : null
  const missed = (entry: SteerEntry) => entry.source === 'user' && entry.messageId !== keep
  const taken = state.pending.filter(missed)
  state.pending = state.pending.filter((entry) => !missed(entry))
  state.updatedAt = Date.now()
  inboxes.set(sessionId, state)
  return taken
}

/**
 * Drop a session's entries. Called from send-routed's `finally`, beside the lock release
 * (`releaseSessionTurn`), so a finished request never leaves entries behind.
 *
 * `keepMessageId` (F-P1-1) is the ownership check the lock release has, in the form this
 * map needs: entries carry the assistant `messageId` they belong to, so a finished request
 * removes every OTHER turn's entries and leaves the live turn's alone. The window is the
 * one SA-113 F-P1-1 closed for the lock — a turn stopped during setup unwinds its
 * `finally` after a retry has registered a new stream and accepted steers for it — and an
 * unscoped clear there would silently drop text the route had already answered 202 for.
 */
export function clearSteerInbox(
  sessionId: string,
  options: { keepMessageId?: string | null } = {}
): void {
  const keep = typeof options.keepMessageId === 'string' ? options.keepMessageId : null
  if (!keep) {
    inboxes.delete(sessionId)
    return
  }
  const state = getState(sessionId)
  if (!state) return
  state.pending = state.pending.filter((entry) => entry.messageId === keep)
  state.delivered = state.delivered.filter((entry) => entry.messageId === keep)
  if (state.pending.length === 0 && state.delivered.length === 0) {
    inboxes.delete(sessionId)
    return
  }
  inboxes.set(sessionId, state)
}

/**
 * P2 — record what the running turn can do about a mid-reply message.
 *
 * Registered by send-routed beside `registerStreamAbort`, cleared in the same `finally`
 * that clears the stream. Checking the message id on the way out is the same ownership rule
 * `clearSteerInbox` uses — a request that unwinds late must not remove a live turn's
 * registration.
 */
export function registerSteerRun(sessionId: string, run: SteerRunRegistration): void {
  runs.set(sessionId, { ...run })
}

export function clearSteerRun(sessionId: string, messageId?: string | null): void {
  const existing = runs.get(sessionId)
  if (!existing) return
  if (messageId && existing.messageId !== messageId) return
  runs.delete(sessionId)
}

export function getSteerRun(sessionId: string): SteerRunRegistration | null {
  return runs.get(sessionId) ?? null
}

/** Test-only reset so one suite's inbox cannot leak into the next. */
export function __resetSteerInboxRegistryForTests(): void {
  inboxes.clear()
  runs.clear()
}
