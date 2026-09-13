/**
 * SA-114 P3 (DL-114-14) — the browser's view of the steers it can see.
 *
 * The SERVER owns a steer from the moment it answers 202; this store owns nothing but how
 * it LOOKS. It exists for two jobs a message record cannot do on its own:
 *
 * 1. **The bubble's state.** A steer has no message record of its own until it is either
 *    delivered (it lives inside the assistant record) or promoted (the server writes a user
 *    message). In between there is an optimistic bubble, and this is where its state lives.
 * 2. **The live inset's text.** `steer_delivered` carries no text (AMD-114-04) and the
 *    stored `{{batshit-steer:id}}` marker has no text until finalise, so the words have to
 *    come from `steer_queued` — which a tab opened mid-reply also receives, because the
 *    steer events ride the session replay buffer.
 *
 * Ordering is NOT assumed. `steer_delivered` can arrive before `steer_queued` (the route
 * publishes `queued` after enqueueing, and the API lane can deliver inside that window), so
 * every writer here merges into whatever is already there rather than requiring a `queued`
 * entry to exist first.
 */

import { WAIT_SEND_SENTENCE, type SteerLane, type SteerSource } from '$lib/utils/steerControl'

/**
 * Where a steer is, from the browser's side.
 *
 * - `queued` — the server has it and the turn has not handed it to the model yet. On a
 *   managed CLI lane this is the NORMAL state for several seconds (Codex reads a steer at
 *   its next model call, Claude at its next tool boundary), so it is not a failure.
 * - `waiting` — not sent at all yet: the send carried files, which are never steered
 *   (DL-114-10), so the browser is holding it until the reply finishes.
 * - `delivered` — the model read it mid-reply. It now belongs inside the assistant record.
 * - `promoted` — the reply ended before it could land, so the server sent it as the user's
 *   next message (DL-114-07).
 * - `dropped` — the turn ended without either. Today that means the user pressed Stop,
 *   which does not promote: Stop means stop.
 */
export type SteerBubbleState = 'queued' | 'waiting' | 'delivered' | 'promoted' | 'dropped'

/**
 * Why a steer was dropped (F-P3-4). `stopped` is the user's own Stop; `unanswered` is the
 * backstop — the chat went quiet with the steer still waiting, so the server never wrote
 * the promotion. Only the first may say "you stopped the reply".
 */
export type SteerDropReason = 'stopped' | 'unanswered'

export interface SteerBubbleEntry {
  steerId: string
  sessionId: string
  /** The ASSISTANT message this steer belongs inside. */
  messageId: string
  text: string
  state: SteerBubbleState
  source: SteerSource
  /** DM source only: the sender's display name, frozen at send time. */
  label?: string
  lane?: SteerLane | null
  dropReason?: SteerDropReason
  updatedAt: number
}

let steerBySteerId = $state<Record<string, SteerBubbleEntry>>({})

/**
 * F-P2-1 (SA-118) — steers this tab has already cleared, so nothing can put them back.
 *
 * The session replay buffer keeps a turn's `steer_queued` for a while after the turn ends,
 * and re-sends it whenever a tab (re)subscribes to that session — which is how a tab opened
 * mid-reply learns the words, and is deliberate. Leaving a chat and coming back
 * resubscribes. So `clearDroppedSteersForSession` removing a `dropped` entry was not enough
 * on its own: the replay rebuilt the same steer from scratch, with no earlier state to
 * merge into, and `upsert`'s default put it back as **queued** — a bubble saying "Queued
 * for the agent's next step" about a reply the user stopped a minute ago. Measured live on
 * BSMS, which is the only place it shows.
 *
 * A steer id is minted once and never reused, so an id this tab has settled and cleared can
 * only ever be that same dead steer arriving again. The set holds those ids for the life of
 * the tab; it gains one short string per stopped-and-cleared steer, which is a handful.
 *
 * It is deliberately NOT a fix for the wider case: a tab that never saw the steer — a fresh
 * tab, or a spectator joining late — still gets the replayed `queued` bubble for an ended
 * turn. That is older than this story and belongs to the replay buffer, not to this store.
 */
let clearedSteerIds = new Set<string>()

function normalize(value?: string | null) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function write(entry: SteerBubbleEntry) {
  steerBySteerId = { ...steerBySteerId, [entry.steerId]: { ...entry, updatedAt: Date.now() } }
}

/**
 * Merge what we just learned into whatever we already had.
 *
 * A later event never blanks a field an earlier one filled: `steer_delivered` has no text,
 * and if it arrives first its entry must not overwrite the text `steer_queued` brings a
 * moment later. That is why `text` is only replaced by a non-empty value.
 */
function upsert(
  steerId: string,
  patch: Partial<SteerBubbleEntry> & { sessionId: string; messageId: string }
) {
  const id = normalize(steerId)
  if (!id) return
  const existing = steerBySteerId[id]
  // F-P2-1: a cleared steer stays cleared. Only a REBUILD is refused — an entry that is
  // still here goes on being updated normally, so a live reply's bubble is untouched.
  if (!existing && clearedSteerIds.has(id)) return
  write({
    steerId: id,
    sessionId: patch.sessionId,
    messageId: patch.messageId,
    text: normalize(patch.text) ?? existing?.text ?? '',
    state: patch.state ?? existing?.state ?? 'queued',
    source: patch.source ?? existing?.source ?? 'user',
    label: normalize(patch.label) ?? existing?.label,
    lane: patch.lane ?? existing?.lane ?? null,
    // PR #106 review F-19b: the reason a drop was made travels with the state. Rebuilding
    // the entry without it left `state: 'dropped'` with no reason, and the label's fallback
    // accuses the user of a Stop they never pressed (AMD-114-08).
    dropReason: patch.dropReason ?? existing?.dropReason,
    updatedAt: Date.now()
  })
}

/** The browser's own send, before the route has answered. */
export function noteLocalSteer(params: {
  steerId: string
  sessionId: string
  messageId: string
  text: string
  state?: SteerBubbleState
}) {
  upsert(params.steerId, {
    sessionId: params.sessionId,
    messageId: params.messageId,
    text: params.text,
    state: params.state ?? 'queued',
    source: 'user'
  })
}

/** `steer_queued` — also how a tab that did NOT send learns the words. */
export function applySteerQueued(event: {
  sessionId: string
  messageId: string
  steerId: string
  text?: string
}) {
  if (!normalize(event.sessionId) || !normalize(event.messageId)) return
  upsert(event.steerId, {
    sessionId: event.sessionId,
    messageId: event.messageId,
    text: event.text ?? '',
    source: 'user'
  })
}

/** `steer_delivered` — the model read it. Carries no text (AMD-114-04), by design. */
export function applySteerDelivered(event: {
  sessionId: string
  messageId: string
  steerId: string
  lane?: SteerLane
  source?: SteerSource
}) {
  if (!normalize(event.sessionId) || !normalize(event.messageId)) return
  upsert(event.steerId, {
    sessionId: event.sessionId,
    messageId: event.messageId,
    state: 'delivered',
    lane: event.lane ?? null,
    source: event.source ?? 'user'
  })
}

/** `steer_promoted` — several steers can share one promoted message id (AMD-114-04). */
export function applySteerPromoted(event: { steerIds?: string[]; messageId?: string }) {
  const ids = Array.isArray(event.steerIds) ? event.steerIds : []
  for (const rawId of ids) {
    const id = normalize(rawId)
    if (!id) continue
    const existing = steerBySteerId[id]
    if (!existing) continue
    write({ ...existing, state: 'promoted' })
  }
}

/**
 * The turn is over and this steer neither landed nor was promoted.
 *
 * Only the Stop path reaches here today, and the bubble says so rather than quietly
 * re-sending: "Stop means stop" (DL-114-07) would be a lie if the words went out anyway.
 */
export function markSteerDropped(steerId: string, reason: SteerDropReason = 'stopped') {
  const existing = steerBySteerId[normalize(steerId) ?? '']
  if (!existing) return
  if (existing.state !== 'queued' && existing.state !== 'waiting') return
  write({ ...existing, state: 'dropped', dropReason: reason })
}

/** The one sentence under a bubble, decided in one place so the bubble and its tests agree. */
export function steerBubbleStatusLabel(entry: SteerBubbleEntry): string {
  switch (entry.state) {
    case 'waiting':
      // DL-118-09: the send button's tooltip says this too, from the same constant.
      return WAIT_SEND_SENTENCE
    case 'dropped':
      return entry.dropReason === 'unanswered'
        ? 'Not sent — the reply ended before it could land. Send it again.'
        : 'Not sent — you stopped the reply'
    default:
      return 'Queued for the agent’s next step'
  }
}

export function getSteer(steerId?: string | null): SteerBubbleEntry | null {
  const id = normalize(steerId)
  return id ? (steerBySteerId[id] ?? null) : null
}

/** Every steer attached to one assistant reply, oldest first. */
export function getSteersForMessage(
  sessionId?: string | null,
  messageId?: string | null
): SteerBubbleEntry[] {
  const session = normalize(sessionId)
  const message = normalize(messageId)
  if (!session || !message) return []
  return Object.values(steerBySteerId)
    .filter((entry) => entry.sessionId === session && entry.messageId === message)
    .sort((a, b) => a.updatedAt - b.updatedAt)
}

/** The bubbles a chat should draw for itself: everything not yet folded into a record. */
export function getPendingSteersForSession(sessionId?: string | null): SteerBubbleEntry[] {
  const session = normalize(sessionId)
  if (!session) return []
  return Object.values(steerBySteerId)
    .filter((entry) => entry.sessionId === session)
    .sort((a, b) => a.updatedAt - b.updatedAt)
}

/** Drop the optimistic bubbles a finalised reply now renders inline instead. */
export function clearDeliveredSteersForMessage(sessionId: string, messageId: string) {
  const session = normalize(sessionId)
  const message = normalize(messageId)
  if (!session || !message) return
  const next = { ...steerBySteerId }
  let changed = false
  for (const entry of Object.values(steerBySteerId)) {
    if (entry.sessionId !== session || entry.messageId !== message) continue
    if (entry.state !== 'delivered') continue
    delete next[entry.steerId]
    changed = true
  }
  if (changed) steerBySteerId = next
}

/** A promoted steer becomes a real user message; its bubble is that message now. */
export function forgetSteer(steerId: string) {
  const id = normalize(steerId)
  if (!id || !steerBySteerId[id]) return
  const next = { ...steerBySteerId }
  delete next[id]
  steerBySteerId = next
}

/**
 * SA-118 (DL-118-08) — a bubble that has said its piece goes away.
 *
 * `dropped` is the only state cleared here, and the exclusion is the point. A `dropped`
 * bubble ("Not sent — you stopped the reply") is a receipt: it had no caller in production
 * at all before this, so it sat under every later exchange in that chat and came back each
 * time the chat was reopened (PR #106 review F-24). `queued` and `waiting` are the
 * opposite — they belong to a reply that is still running, and they are the only feedback
 * the user has that a steer is pending, so navigating away must not touch them. `delivered`
 * is folded into the finished record by `clearDeliveredSteersForMessage`, and `promoted`
 * becomes a real message through `forgetSteer`; neither is this function's business.
 *
 * Called on the next send in that session, and when the user leaves it.
 *
 * This replaces `clearSteersForSession`, which cleared every state and never ran outside
 * its own test.
 */
export function clearDroppedSteersForSession(sessionId?: string | null) {
  const session = normalize(sessionId)
  if (!session) return
  const next = { ...steerBySteerId }
  let changed = false
  for (const entry of Object.values(steerBySteerId)) {
    if (entry.sessionId !== session) continue
    if (entry.state !== 'dropped') continue
    delete next[entry.steerId]
    // F-P2-1: remember it, or the session replay rebuilds it as `queued` on the way back in.
    clearedSteerIds.add(entry.steerId)
    changed = true
  }
  if (changed) steerBySteerId = next
}

export function clearSteerInboxForTest() {
  if (typeof process !== 'undefined' && process.env.VITEST !== 'true') return
  steerBySteerId = {}
  clearedSteerIds = new Set()
}
