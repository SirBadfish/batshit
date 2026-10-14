import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetStreamAbortRegistryForTests,
  beginSessionDelete,
  cancelQueuedSessionTurnsOfDeletedChat,
  clearSessionTurn,
  countQueuedSessionTurns,
  getActiveSessionTurn,
  getQueueCardHold,
  isUserMessageQueued,
  keepQueuedSessionTurns,
  keepQueuedSessionTurnsHeldAtApprovalCards,
  listWaitingQueuedSends,
  QUEUE_CARD_HOLD_LIMIT_MS,
  QUEUED_SESSION_TURN_BACKSTOP_MS,
  queueSessionTurn,
  registerSessionTurn,
  releaseSessionTurn,
  sendWaitingSendNow,
  type QueuedSessionTurnOutcome
} from '../services/streamAbortRegistry'

/**
 * BL-713 — the chat's line waits at an approval card.
 *
 * A message the page used to hold in the tab (a Clip, an `@file`, a group chat, a lane that
 * cannot take a steer) now waits in the chat's line (BL-4) from the moment it is sent. A reply
 * that stops at an approval card has not ended (BL-455), so the line must not hand the chat to
 * that message beside the waiting card: the request whose last run stopped at the card sets a
 * hold in the same step that frees its lock, and only the user lets it go (the click, a new
 * message, Send now), or the 15-minute bound, which keeps the words unanswered.
 */
function registerHolder(sessionId = 'chat', messageId = 'msg-card') {
  const registration = registerSessionTurn(sessionId, 'single', messageId)
  if (!registration.ok) throw new Error('expected the holder to register')
  return registration.entry
}

function queue(userMessageId: string, sessionId = 'chat') {
  return queueSessionTurn(sessionId, {
    kind: 'single',
    messageId: `${userMessageId}-reply`,
    userMessageId
  })
}

/** Resolve a pending outcome without waiting, or say it has none yet. */
async function settledNow(outcome: Promise<QueuedSessionTurnOutcome>) {
  const pending = Symbol('pending')
  const result = await Promise.race([outcome, Promise.resolve(pending)])
  return result === pending ? null : (result as QueuedSessionTurnOutcome)
}

/** The reply that raised the card lets go of the chat, its last run stopped at the card. */
function stopAtCard(holder: { turnId: number }, cardMessageId = 'msg-card', sessionId = 'chat') {
  releaseSessionTurn(sessionId, holder.turnId, { approvalCardMessageId: cardMessageId })
}

function registerClick(cardMessageId = 'msg-card', sessionId = 'chat') {
  const click = registerSessionTurn(sessionId, 'single', cardMessageId, { answersApproval: true })
  if (!click.ok) throw new Error('expected the click to register')
  return click
}

describe('the chat’s line at an approval card (BL-713)', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetStreamAbortRegistryForTests()
  })

  it('holds: a reply that stops at a card hands the chat to nobody while a send waits', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')

    stopAtCard(holder)

    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toBeNull()
    expect(isUserMessageQueued('chat', 'msg-b')).toBe(true)
    expect(getQueueCardHold('chat')).toMatchObject({ messageId: 'msg-card' })
  })

  it('control: a reply that ends with no card hands the chat on at once', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    releaseSessionTurn('chat', holder.turnId)
    expect((await settledNow(b.outcome))?.kind).toBe('run')
    expect(getQueueCardHold('chat')).toBeNull()
  })

  it('sets no hold when nothing waits: a message sent later is the user’s new message and runs', () => {
    const holder = registerHolder()
    stopAtCard(holder)
    expect(getQueueCardHold('chat')).toBeNull()
    expect(registerSessionTurn('chat', 'single', 'msg-c-reply').ok).toBe(true)
  })

  it('the click goes first; when its reply ends with no new card, the line goes on', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    const click = registerClick()
    expect(click.endedCardHold).toBe(true)
    expect(getQueueCardHold('chat')).toBeNull()
    // While the click's reply runs, the send waits behind it.
    expect(await settledNow(b.outcome)).toBeNull()

    releaseSessionTurn('chat', click.entry.turnId, { answeredApproval: { expiryOnly: false } })
    expect((await settledNow(b.outcome))?.kind).toBe('run')
  })

  it('a new card from the click’s reply renews the hold, with its own card and its own time', async () => {
    vi.useFakeTimers()
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)
    const firstSince = getQueueCardHold('chat')?.since ?? 0

    await vi.advanceTimersByTimeAsync(60_000)
    const click = registerClick()
    releaseSessionTurn('chat', click.entry.turnId, {
      approvalCardMessageId: 'msg-second-card',
      answeredApproval: { expiryOnly: false }
    })

    expect(await settledNow(b.outcome)).toBeNull()
    const renewed = getQueueCardHold('chat')
    expect(renewed?.messageId).toBe('msg-second-card')
    expect((renewed?.since ?? 0) - firstSince).toBeGreaterThanOrEqual(60_000)
  })

  it('a click whose answer was never recorded (refused) leaves the card waiting, and the hold with it', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)
    const since = getQueueCardHold('chat')?.since

    const click = registerClick()
    releaseSessionTurn('chat', click.entry.turnId)

    expect(await settledNow(b.outcome)).toBeNull()
    expect(getQueueCardHold('chat')).toEqual({ messageId: 'msg-card', since })
  })

  it('a click on another card leaves the hold as it is', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    const click = registerClick('msg-older-card')
    expect(click.endedCardHold).toBe(false)
    releaseSessionTurn('chat', click.entry.turnId, { answeredApproval: { expiryOnly: false } })

    expect(await settledNow(b.outcome)).toBeNull()
    expect(getQueueCardHold('chat')?.messageId).toBe('msg-card')
  })

  it('the page’s own Deny of an expired card keeps the waiting sends: unanswered, never run', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    const c = queue('msg-c')
    stopAtCard(holder)

    const click = registerClick()
    releaseSessionTurn('chat', click.entry.turnId, { answeredApproval: { expiryOnly: true } })

    const outcomeB = await b.outcome
    expect(outcomeB).toMatchObject({ kind: 'keep', reason: 'approval_expired' })
    if (outcomeB.kind !== 'keep') throw new Error('expected keep')
    releaseSessionTurn('chat', outcomeB.entry.turnId)
    expect(await c.outcome).toMatchObject({ kind: 'keep', reason: 'approval_expired' })
    expect(getQueueCardHold('chat')).toBeNull()
  })

  it('a new message while the line holds ends the hold: the line runs in the order it was sent', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    const c = queue('msg-c')
    expect(c.endedCardHold).toBe(true)
    expect(getQueueCardHold('chat')).toBeNull()
    const outcomeB = await b.outcome
    expect(outcomeB.kind).toBe('run')
    expect(await settledNow(c.outcome)).toBeNull()
    if (outcomeB.kind !== 'run') throw new Error('expected run')
    expect(registerSessionTurn('chat', 'single', 'msg-b-reply', {}, outcomeB.entry).ok).toBe(true)
    releaseSessionTurn('chat', outcomeB.entry.turnId)
    expect((await c.outcome).kind).toBe('run')
  })

  it('a message sent while another turn holds the chat does not end a hold (it is typed during that reply)', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)
    // A click on an older card runs a turn; the hold for this card stays through it.
    const click = registerClick('msg-older-card')

    const c = queue('msg-c')
    expect(c.endedCardHold).toBe(false)
    expect(getQueueCardHold('chat')?.messageId).toBe('msg-card')
    releaseSessionTurn('chat', click.entry.turnId, { answeredApproval: { expiryOnly: false } })
    expect(await settledNow(b.outcome)).toBeNull()
  })

  it('Send now of a waiting send adds no second entry and ends the hold; the line runs it once', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    expect(sendWaitingSendNow('chat', 'msg-b')).toEqual({ waiting: true, endedCardHold: true })
    expect(countQueuedSessionTurns('chat') + (getActiveSessionTurn('chat') ? 1 : 0)).toBe(1)
    expect((await b.outcome).kind).toBe('run')
    expect(getQueueCardHold('chat')).toBeNull()
  })

  it('Send now of a message that is not waiting does nothing (a second press after it ran)', () => {
    registerHolder()
    expect(sendWaitingSendNow('chat', 'msg-gone')).toEqual({ waiting: false, endedCardHold: false })
    expect(countQueuedSessionTurns('chat')).toBe(0)
  })

  it('the bound: a hold older than its limit keeps the waiting sends (the backstop checks it)', async () => {
    vi.useFakeTimers()
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    await vi.advanceTimersByTimeAsync(QUEUE_CARD_HOLD_LIMIT_MS - QUEUED_SESSION_TURN_BACKSTOP_MS)
    expect(await settledNow(b.outcome)).toBeNull()
    await vi.advanceTimersByTimeAsync(QUEUED_SESSION_TURN_BACKSTOP_MS * 2)
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'keep', reason: 'approval_wait' })
    expect(getQueueCardHold('chat')).toBeNull()
  })

  it('a chat delete clears the hold with the line', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    beginSessionDelete('chat')
    cancelQueuedSessionTurnsOfDeletedChat('chat')

    expect(await b.outcome).toEqual({ kind: 'cancelled', reason: 'session_deleting' })
    expect(getQueueCardHold('chat')).toBeNull()
  })

  it('a restore never waits for a hold: held lines are kept like a shutdown’s, a line behind a running reply is not', async () => {
    vi.useFakeTimers()
    const holder = registerHolder('held-chat')
    const held = queue('msg-held', 'held-chat')
    stopAtCard(holder, 'msg-card', 'held-chat')
    registerHolder('busy-chat', 'msg-running')
    const behindReply = queue('msg-behind', 'busy-chat')

    expect(keepQueuedSessionTurnsHeldAtApprovalCards('shutdown')).toEqual([
      { sessionId: 'held-chat', userMessageIds: ['msg-held'] }
    ])
    await vi.advanceTimersByTimeAsync(QUEUED_SESSION_TURN_BACKSTOP_MS)
    expect(await settledNow(held.outcome)).toMatchObject({ kind: 'keep', reason: 'shutdown' })
    expect(getQueueCardHold('held-chat')).toBeNull()
    expect(await settledNow(behindReply.outcome)).toBeNull()
    expect(listWaitingQueuedSends('busy-chat')).toHaveLength(1)
  })

  it('sets no hold when only kept sends wait: a Stop in the gap before the lock goes lets them move at once (review)', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    // The Stop lands after the card, before the reply's request lets go of its lock.
    keepQueuedSessionTurns('chat', 'stopped')
    stopAtCard(holder)

    expect(getQueueCardHold('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'keep', reason: 'stopped' })
  })

  it('a refused click puts the hold back only while a send can still run (review)', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)
    const click = registerClick()
    keepQueuedSessionTurns('chat', 'stopped')
    releaseSessionTurn('chat', click.entry.turnId)

    expect(getQueueCardHold('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'keep', reason: 'stopped' })
  })

  it('a send over the cap never ends a hold: it is kept, not the user choosing to go on (review)', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    stopAtCard(holder)

    const overflow = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-f-reply', userMessageId: 'msg-f', keep: 'overflow' })
    expect(overflow.endedCardHold).toBe(false)
    expect(getQueueCardHold('chat')?.messageId).toBe('msg-card')
    expect(await settledNow(b.outcome)).toBeNull()
  })

  // BL-906 (a): the lock can go before its request lets go (the interrupt route's clear of a
  // finishing turn, the two-minute quiet rule, the six-hour rule). The line waits for that
  // request anyway ("a lock is not a request"), so its own end still decides the card hold,
  // as long as nothing else took the chat in between.
  it('a request whose lock went first still holds the line at its card when it lets go (BL-906 a)', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    clearSessionTurn('chat', 'msg-card')
    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toBeNull()

    stopAtCard(holder)

    expect(getQueueCardHold('chat')).toMatchObject({ messageId: 'msg-card' })
    expect(await settledNow(b.outcome)).toBeNull()
    expect(isUserMessageQueued('chat', 'msg-b')).toBe(true)
  })

  it('the same after the quiet-orphan rule took the lock (BL-906 a)', async () => {
    vi.useFakeTimers()
    const holder = registerHolder()
    const b = queue('msg-b')
    vi.advanceTimersByTime(2 * 60 * 1000 + 5 * QUEUED_SESSION_TURN_BACKSTOP_MS)
    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toBeNull()

    stopAtCard(holder)

    expect(getQueueCardHold('chat')).toMatchObject({ messageId: 'msg-card' })
    expect(await settledNow(b.outcome)).toBeNull()
  })

  it('sets no hold from a late end once another turn took the chat since (BL-906 a)', async () => {
    const holder = registerHolder()
    const b = queue('msg-b')
    clearSessionTurn('chat', 'msg-card')
    // The user answered the card meanwhile, and that click's reply ended with no new card.
    const click = registerClick()
    releaseSessionTurn('chat', click.entry.turnId, { answeredApproval: { expiryOnly: false } })

    stopAtCard(holder)

    expect(getQueueCardHold('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'run' })
  })

  it('the test reset forgets every hold', () => {
    const holder = registerHolder()
    queue('msg-b')
    stopAtCard(holder)
    __resetStreamAbortRegistryForTests()
    expect(getQueueCardHold('chat')).toBeNull()
  })
})
