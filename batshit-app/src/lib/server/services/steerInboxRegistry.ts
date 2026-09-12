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
  buildSteerSendPayload,
  type DeliveredSteer,
  type SteerEntry,
  type SteerLane,
  type SteerSendPayload
} from '$lib/utils/steerControl'

interface SteerInboxState {
  /** Accepted, not yet handed to any transport. */
  pending: SteerEntry[]
  /**
   * P2 — written to a managed CLI's wire, not yet echoed back by it.
   *
   * The API lane has no such state: `prepareStep` returning the injected message IS the
   * delivery, so `takePendingSteersForDelivery` moves straight from `pending` to
   * `delivered`. Both CLI lanes are asynchronous — Codex accepts a `turn/steer` and emits
   * its own `userMessage` item for it (AMD-114-02), Claude reads a stdin line and replays
   * it only when it hands it to the model (AMD-114-01) — so between the write and the echo
   * a steer has left Batshit but has NOT reached the model. It waits here.
   *
   * An entry that is still in flight when the turn ends was never read, so it is promoted
   * exactly like one that never left (`takeUndeliveredSteers`). That is AMD-114-01's rule:
   * every unechoed steer is promoted.
   */
  inFlight: SteerEntry[]
  /** Reached the model, not yet written into the transcript by send-routed. */
  delivered: DeliveredSteer[]
  updatedAt: number
}

/**
 * P2 (DL-114-06, DL-114-08, DL-114-09) — the running turn, as steering sees it.
 *
 * Two facts live here, registered together because they are decided together.
 *
 * **Can it be steered, and why not.** `resolveSteerability` answers that once, in
 * send-routed, at the moment the run is registered — it is the only place that knows the
 * agent type, whether this is a group member's run, and which transport lane a `cli`
 * primary is about to take. The steer route reads the answer instead of re-deriving it,
 * because a second derivation is how the route would come to promise a steer the turn
 * cannot carry. It lives in THIS module rather than on the stream-abort entry for the same
 * reason DL-114-02 gave the inbox its own map: the interrupt path and its registry stay
 * byte-identical through this story (DL-114-15), and steering may not grow a field on them.
 *
 * **How to reach it.** The API lane PULLS: the SDK calls `prepareStep` between steps and
 * the hook takes whatever is waiting, so it registers no `send` at all. Neither CLI lane
 * has such a callback, and waiting for the next tool boundary to push would be worse than
 * useless on Claude — a line written after a boundary is consumed at the NEXT one, and a
 * reply with a single tool call would never deliver. So the route PUSHES: it enqueues, then
 * hands the text straight to the running transport, which holds it until its own next
 * boundary exactly as both vendors document. `send` is attached separately from the verdict
 * because the child process does not exist until `streamNativeMode` resolves, a few
 * seconds after the run is registered.
 */
export interface SteerRunRegistration {
  /** The assistant message id this run is writing. A later turn registers its own. */
  messageId: string
  steerable: boolean
  /** Plain-English "why not", shown in the client's tooltip. Null when steerable. */
  reason: string | null
  lane: SteerLane | null
  /**
   * Managed CLI runs only. Resolves `true` when the transport ACCEPTED the write, which is
   * not the same as the model having read it — that is the echo, and it arrives later as a
   * synthetic `steer` chunk in the same stream.
   */
  send?: ((payload: SteerSendPayload) => Promise<boolean>) | null
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
  return { pending: [], inFlight: [], delivered: [], updatedAt: now }
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
 * rather than queued behind the others.
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

  // P2: in-flight entries count too. A steer written to a managed CLI's wire but not yet
  // echoed has not reached the model, so it is still one of the messages "waiting for this
  // reply" the refusal sentence talks about.
  const waiting = state.pending.length + state.inFlight.length
  if (waiting >= MAX_PENDING_STEERS) {
    return {
      ok: false,
      code: 'steer_inbox_full',
      reason: `${waiting} messages are already waiting for this reply (Batshit holds ${MAX_PENDING_STEERS}). Wait for the reply to finish.`
    }
  }

  if (entry.source === 'dm') {
    const dmWaiting = [...state.pending, ...state.inFlight].some(
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
  return { ok: true, pending: state.pending.length + state.inFlight.length }
}

/** Read-only snapshot of what is still waiting, for the route's own reporting and tests. */
export function listPendingSteers(sessionId: string): SteerEntry[] {
  return [...(getState(sessionId)?.pending ?? [])]
}

export function countPendingSteers(sessionId: string, messageId?: string): number {
  const state = getState(sessionId)
  const waiting = [...(state?.pending ?? []), ...(state?.inFlight ?? [])]
  if (!messageId) return waiting.length
  return waiting.filter((entry) => entry.messageId === messageId).length
}

/** Read-only snapshot of what has been written to a CLI wire but not echoed back. */
export function listInFlightSteers(sessionId: string): SteerEntry[] {
  return [...(getState(sessionId)?.inFlight ?? [])]
}

/**
 * Hand every waiting steer for this turn to the transport, in acceptance order.
 *
 * Taking and marking delivered are ONE step on purpose. On the API lane the caller is
 * `prepareStep`, and by the time it returns the injected message the SDK will send it — P0
 * measured the injection reaching the model, carrying forward, and never persisting. A
 * two-step take-then-confirm would open a window where a steer is in neither list.
 *
 * Entries are filtered by `messageId` so a leftover from an earlier turn can never be
 * delivered into a later one, including the promoted follow-up turn (DL-114-07), which
 * always carries a new assistant id.
 */
export function takePendingSteersForDelivery(
  sessionId: string,
  messageId: string,
  options: { step: number; lane: SteerLane },
  now = Date.now()
): DeliveredSteer[] {
  const state = getState(sessionId)
  if (!state || state.pending.length === 0) return []

  const taken = state.pending.filter((entry) => entry.messageId === messageId)
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => entry.messageId !== messageId)
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
 * P2 (AMD-114-01): in-flight entries are taken too, and in acceptance order beside the
 * pending ones. A steer written to a managed CLI's wire that the CLI never echoed was never
 * handed to the model — on Claude it is the exact line that would otherwise start a SECOND
 * turn inside the same process, which is why the bridge kills the child rather than letting
 * it run. "Written" is not "read", so it is promoted like any other undelivered steer.
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
  const taken = [...state.pending.filter(mine), ...state.inFlight.filter(mine)].sort((a, b) =>
    a.at === b.at ? 0 : a.at < b.at ? -1 : 1
  )
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => !mine(entry))
  state.inFlight = state.inFlight.filter((entry) => !mine(entry))
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return taken
}

/**
 * P2 — move this turn's waiting steers onto a managed CLI's wire.
 *
 * The move happens BEFORE the write, not after it: the route can be called twice in quick
 * succession, and two flushes reading the same `pending` list would send the same words to
 * the model twice. `returnSteersToPending` puts them back when the write is refused, which
 * is what makes a `-32600` refusal or a dead pipe end in promotion rather than in silence.
 */
export function takePendingSteersForTransport(
  sessionId: string,
  messageId: string,
  now = Date.now()
): SteerEntry[] {
  const state = getState(sessionId)
  if (!state || state.pending.length === 0) return []

  const taken = state.pending.filter((entry) => entry.messageId === messageId)
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => entry.messageId !== messageId)
  state.inFlight = [...state.inFlight, ...taken]
  state.updatedAt = now
  inboxes.set(sessionId, state)
  return taken
}

/** Undo a `takePendingSteersForTransport` whose write was refused or threw. */
export function returnSteersToPending(
  sessionId: string,
  entries: SteerEntry[],
  now = Date.now()
): void {
  if (entries.length === 0) return
  const state = inboxes.get(sessionId) ?? emptyState(now)
  const returning = new Set(entries.map((entry) => entry.steerId))
  state.inFlight = state.inFlight.filter((entry) => !returning.has(entry.steerId))
  // Acceptance order, not arrival-back order: these were the OLDEST waiting entries, and a
  // second steer accepted while the write was in flight must still read after them.
  state.pending = [...entries, ...state.pending]
  state.updatedAt = now
  inboxes.set(sessionId, state)
}

/**
 * P2 — the CLI transport echoed these back, so the model has them (AMD-114-01, AMD-114-02).
 *
 * Called from send-routed's own `case` for the synthetic `steer` chunk, never from an event
 * adapter. That is F-P1-3's rule turned around for a stream with no steps: the API lane's
 * marker waits for a consumed `finish-step` because the SDK runs ahead of the loop, and a
 * CLI stream has no such count for the gate to consume — so its marker's position IS the
 * chunk's position in the stream, which is exactly where the echo arrived. Marking here and
 * draining unbounded puts it there.
 */
export function confirmSteerDelivery(
  sessionId: string,
  messageId: string,
  options: { steerIds: string[]; step: number; lane: SteerLane },
  now = Date.now()
): DeliveredSteer[] {
  const state = getState(sessionId)
  if (!state || state.inFlight.length === 0) return []

  const wanted = new Set(options.steerIds)
  const confirmed = state.inFlight.filter(
    (entry) => entry.messageId === messageId && wanted.has(entry.steerId)
  )
  if (confirmed.length === 0) return []

  const confirmedIds = new Set(confirmed.map((entry) => entry.steerId))
  state.inFlight = state.inFlight.filter((entry) => !confirmedIds.has(entry.steerId))
  const delivered = confirmed.map((entry) => ({
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

  const taken = [...state.pending.filter(missed), ...state.inFlight.filter(missed)]
  if (taken.length === 0) return []

  state.pending = state.pending.filter((entry) => !missed(entry))
  state.inFlight = state.inFlight.filter((entry) => !missed(entry))
  state.updatedAt = Date.now()
  inboxes.set(sessionId, state)
  return taken
}

/**
 * Drop a session's entries. Called from send-routed's `finally`, beside `clearSessionTurn`,
 * so a finished request never leaves entries behind.
 *
 * `keepMessageId` (F-P1-1) is the ownership check `clearSessionTurn` has, in the form this
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
  state.inFlight = state.inFlight.filter((entry) => entry.messageId === keep)
  state.delivered = state.delivered.filter((entry) => entry.messageId === keep)
  if (
    state.pending.length === 0 &&
    state.inFlight.length === 0 &&
    state.delivered.length === 0
  ) {
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
 * `clearSteerInbox` and `clearSessionTurn` use — a request that unwinds late must not
 * remove a live turn's registration.
 */
export function registerSteerRun(sessionId: string, run: SteerRunRegistration): void {
  runs.set(sessionId, { ...run, send: run.send ?? null })
}

/**
 * Attach a managed CLI's steer channel once its child process exists.
 *
 * Separate from the registration above because `streamNativeMode` can take seconds to
 * resolve on a CLI lane, and the verdict has to be readable for that whole window: a steer
 * arriving before the child is up is accepted and waits in the inbox rather than being
 * refused.
 *
 * Attaching also PUSHES whatever is already waiting (F-P2-1). The route's own flush runs at
 * accept time and finds no transport during that window, and nothing else would run a
 * second one — so the user's earliest correction, typed right after sending, sat in the
 * inbox until the reply ended and arrived as the next turn instead of at the first boundary.
 */
export function attachSteerTransport(
  sessionId: string,
  messageId: string,
  lane: SteerLane,
  send: (payload: SteerSendPayload) => Promise<boolean>
): boolean {
  const existing = runs.get(sessionId)
  if (!existing || existing.messageId !== messageId) return false
  runs.set(sessionId, { ...existing, lane, send })
  void flushPendingSteersToTransport(sessionId, messageId)
  return true
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

export type SteerFlushResult =
  | { flushed: 0; reason: 'no_transport' | 'nothing_pending' | 'stale_transport' }
  | { flushed: number; reason: 'sent' }
  | { flushed: 0; reason: 'refused'; error?: string }

/**
 * P2 — push this turn's waiting steers to its managed CLI, if it has one.
 *
 * The API lane has no transport registered and returns `no_transport`: its hook pulls at
 * the next step instead. A refusal (Codex's three `-32600` cases, a dead pipe) returns the
 * entries to `pending`, where the end of the turn promotes them (DL-114-07) — which is the
 * whole point of failing loudly here rather than swallowing it: the user's words survive a
 * transport that would not take them.
 */
export async function flushPendingSteersToTransport(
  sessionId: string,
  messageId: string
): Promise<SteerFlushResult> {
  const run = getSteerRun(sessionId)
  if (!run || typeof run.send !== 'function') return { flushed: 0, reason: 'no_transport' }
  if (run.messageId !== messageId) return { flushed: 0, reason: 'stale_transport' }
  const send = run.send

  const taken = takePendingSteersForTransport(sessionId, messageId)
  if (taken.length === 0) return { flushed: 0, reason: 'nothing_pending' }

  try {
    const accepted = await send(buildSteerSendPayload(taken))
    if (!accepted) {
      returnSteersToPending(sessionId, taken)
      return { flushed: 0, reason: 'refused' }
    }
    return { flushed: taken.length, reason: 'sent' }
  } catch (error) {
    returnSteersToPending(sessionId, taken)
    return {
      flushed: 0,
      reason: 'refused',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Test-only reset so one suite's inbox cannot leak into the next. */
export function __resetSteerInboxRegistryForTests(): void {
  inboxes.clear()
  runs.clear()
}
