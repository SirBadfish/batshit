import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetStreamAbortRegistryForTests,
  abandonQueuedSessionTurn,
  abortStream,
  beginSessionDelete,
  cancelQueuedSessionTurnsOfDeletedChat,
  claimQueuedSessionTurn,
  clearSessionTurn,
  countQueuedSessionTurns,
  countRunnableQueuedSessionTurns,
  endSessionDelete,
  getActiveSessionTurn,
  hasRunningRequest,
  holdQueueForApprovalClick,
  isAnotherRequestRunning,
  isUserMessageQueued,
  keepAllQueuedSessionTurns,
  keepQueuedSessionTurns,
  listWaitingQueuedSends,
  noteQueuedSendNotice,
  queuedSendNotices,
  queueSessionTurn,
  QUEUED_HANDOVER_REQUEST_WAIT_MS,
  QUEUED_SESSION_TURN_BACKSTOP_MS,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn,
  revealQueuedUserMessage,
  type QueuedSessionTurnOutcome
} from '../services/streamAbortRegistry'
import { isQueuedSendMessageHidden } from '../services/queuedSendHiddenIds'

/**
 * BL-4 — a send that meets another turn waits in the chat's line instead of being refused.
 *
 * The line lives with the lock because it IS the lock's order: who gets the chat next. The
 * lock is handed to the head of the line in the same synchronous step that frees it, so no
 * other request can register in between, and the head claims that registration as its own.
 */
function registerHolder(sessionId = 'chat', messageId = 'msg-a') {
  const registration = registerSessionTurn(sessionId, 'single', messageId)
  if (!registration.ok) throw new Error('expected the holder to register')
  return registration.entry
}

/** Resolve a pending outcome without waiting, or say it has none yet. */
async function settledNow(outcome: Promise<QueuedSessionTurnOutcome>) {
  const pending = Symbol('pending')
  const result = await Promise.race([outcome, Promise.resolve(pending)])
  return result === pending ? null : (result as QueuedSessionTurnOutcome)
}

describe('the waiting line (BL-4)', () => {
  afterEach(() => {
    vi.useRealTimers()
    __resetStreamAbortRegistryForTests()
  })

  it('holds a send behind a running turn and hides its saved message', () => {
    registerHolder()
    const queued = queueSessionTurn('chat', {
      kind: 'single',
      messageId: 'msg-b-reply',
      userMessageId: 'msg-b'
    })

    expect(queued.userMessageId).toBe('msg-b')
    expect(countQueuedSessionTurns('chat')).toBe(1)
    expect(countRunnableQueuedSessionTurns('chat')).toBe(1)
    expect(isUserMessageQueued('chat', 'msg-b')).toBe(true)
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(true)
  })

  it('hands the lock to the head in the same step that frees it, so nobody gets in between', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    const c = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })

    releaseSessionTurn('chat', holder.turnId)

    // Synchronously, before any await: B holds the chat and a direct registration is refused.
    const lock = getActiveSessionTurn('chat')
    expect(lock?.messageId).toBe('msg-b-reply')
    expect(registerSessionTurn('chat', 'single', 'msg-intruder').ok).toBe(false)

    const outcomeB = await b.outcome
    expect(outcomeB.kind).toBe('run')
    if (outcomeB.kind !== 'run') throw new Error('expected run')
    expect(outcomeB.entry).toBe(lock)
    expect(hasRunningRequest('chat')).toBe(true)
    expect(await settledNow(c.outcome)).toBeNull()

    releaseSessionTurn('chat', outcomeB.entry.turnId)
    const outcomeC = await c.outcome
    expect(outcomeC.kind).toBe('run')
    expect(getActiveSessionTurn('chat')?.messageId).toBe('msg-c-reply')
    expect(countQueuedSessionTurns('chat')).toBe(0)
  })

  it('lets the head claim its handed lock through the one registration call, and nobody else', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    releaseSessionTurn('chat', holder.turnId)
    const outcome = await b.outcome
    if (outcome.kind !== 'run') throw new Error('expected run')

    const claimed = registerSessionTurn('chat', 'single', 'msg-b-reply', {}, outcome.entry)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) throw new Error('expected the claim to succeed')
    expect(claimed.entry).toBe(outcome.entry)

    // A stale or foreign entry is no claim at all.
    const stranger = registerSessionTurn('other-chat', 'single', 'msg-x')
    if (!stranger.ok) throw new Error('expected the stranger to register')
    expect(registerSessionTurn('chat', 'single', 'msg-z', {}, stranger.entry).ok).toBe(false)
  })

  it('after a pruned or cleared lock, hands over once that lock’s request has let go (review finding 6)', async () => {
    // A lock is not a request: the orphan rule and the interrupt route's clear of a finishing
    // turn end a LOCK while its request may still be writing. The line waits for the request.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'))
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    // Quiet for longer than the orphan rule allows: the next read prunes the lock.
    vi.setSystemTime(new Date('2026-09-22T12:02:01Z'))
    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toBeNull()
    releaseSessionTurn('chat', holder.turnId)
    expect(getActiveSessionTurn('chat')?.messageId).toBe('msg-b-reply')
    expect((await b.outcome).kind).toBe('run')

    __resetStreamAbortRegistryForTests()
    const finishing = registerHolder('chat-2', 'msg-a')
    const c = queueSessionTurn('chat-2', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })
    clearSessionTurn('chat-2', 'msg-a')
    expect(await settledNow(c.outcome)).toBeNull()
    releaseSessionTurn('chat-2', finishing.turnId)
    expect(getActiveSessionTurn('chat-2')?.messageId).toBe('msg-c-reply')
    expect((await c.outcome).kind).toBe('run')
  })

  it('a handed send keeps the chat across timers until its request comes back for it (second review)', async () => {
    // Its request may still be busy (the steer_queued forward is a real fetch): nothing on a
    // timer may take the chat back from it.
    vi.useFakeTimers()
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    queueSessionTurn('chat', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })
    releaseSessionTurn('chat', holder.turnId)
    await vi.advanceTimersByTimeAsync(5_000)

    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')
    expect(getActiveSessionTurn('chat')).toBe(handover.entry)
    expect(claimQueuedSessionTurn('chat', handover.entry)).toBe(true)
    expect(registerSessionTurn('chat', 'single', 'msg-b-reply', {}, handover.entry).ok).toBe(true)
  })

  it('a request that leaves while its send still waits takes it out of the line (a throw before the handover)', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    const c = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })

    abandonQueuedSessionTurn('chat', b)

    expect(isUserMessageQueued('chat', 'msg-b')).toBe(false)
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(false)
    expect(countQueuedSessionTurns('chat')).toBe(1)
    releaseSessionTurn('chat', holder.turnId)
    expect((await c.outcome).kind).toBe('run')
    expect(await settledNow(b.outcome)).toBeNull()
  })

  it('a request that leaves after its send was handed the chat, before it took it, lets it go (review finding 2)', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    const c = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })
    releaseSessionTurn('chat', holder.turnId)
    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')

    abandonQueuedSessionTurn('chat', b)

    // B's registration is gone, not left running for good (a delete would refuse until restart),
    // its message shows again, and the chat goes on to C.
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(false)
    const outcomeC = await settledNow(c.outcome)
    expect(outcomeC?.kind).toBe('run')
    if (outcomeC?.kind !== 'run') throw new Error('expected C to run')
    expect(claimQueuedSessionTurn('chat', handover.entry)).toBe(false)
    expect(claimQueuedSessionTurn('chat', outcomeC.entry)).toBe(true)
    releaseSessionTurn('chat', outcomeC.entry.turnId)
    expect(hasRunningRequest('chat')).toBe(false)
  })

  it('forcing the lock-mismatch branch: a handed lock that went before the claim is refused and let go', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    releaseSessionTurn('chat', holder.turnId)
    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')
    clearSessionTurn('chat', 'msg-b-reply')

    expect(claimQueuedSessionTurn('chat', handover.entry)).toBe(false)
    abandonQueuedSessionTurn('chat', b)
    expect(hasRunningRequest('chat')).toBe(false)
    expect(registerSessionTurn('chat', 'single', 'msg-next').ok).toBe(true)
  })

  it('leaving after the claim changes nothing: the request lets go of its own lock', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    releaseSessionTurn('chat', holder.turnId)
    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')
    expect(claimQueuedSessionTurn('chat', handover.entry)).toBe(true)

    abandonQueuedSessionTurn('chat', b)

    expect(getActiveSessionTurn('chat')).toBe(handover.entry)
    expect(hasRunningRequest('chat')).toBe(true)
  })

  it('Stop keeps every waiting send: each is handed the lock in order only to be kept, never run', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    const c = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })

    expect(keepQueuedSessionTurns('chat', 'stopped')).toEqual(['msg-b', 'msg-c'])
    expect(countRunnableQueuedSessionTurns('chat')).toBe(0)
    // A send that arrives after the Stop is an ordinary new send, and waits behind the kept ones.
    const d = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-d-reply', userMessageId: 'msg-d' })
    expect(countRunnableQueuedSessionTurns('chat')).toBe(1)

    releaseSessionTurn('chat', holder.turnId)
    const outcomeB = await b.outcome
    expect(outcomeB).toMatchObject({ kind: 'keep', reason: 'stopped' })
    // Kept, it still holds the chat while it moves its message: C waits for it.
    expect(await settledNow(c.outcome)).toBeNull()
    if (outcomeB.kind !== 'keep') throw new Error('expected keep')
    releaseSessionTurn('chat', outcomeB.entry.turnId)

    const outcomeC = await c.outcome
    expect(outcomeC).toMatchObject({ kind: 'keep', reason: 'stopped' })
    if (outcomeC.kind !== 'keep') throw new Error('expected keep')
    releaseSessionTurn('chat', outcomeC.entry.turnId)
    expect((await d.outcome).kind).toBe('run')
  })

  it('keeps every chat’s line at shutdown', () => {
    registerHolder('chat-1', 'msg-a')
    registerHolder('chat-2', 'msg-a')
    queueSessionTurn('chat-1', { kind: 'single', messageId: 'r1', userMessageId: 'u1' })
    queueSessionTurn('chat-2', { kind: 'group', messageId: null, userMessageId: 'u2' })

    expect(keepAllQueuedSessionTurns('shutdown')).toEqual([
      { sessionId: 'chat-1', userMessageIds: ['u1'] },
      { sessionId: 'chat-2', userMessageIds: ['u2'] }
    ])
    expect(countRunnableQueuedSessionTurns('chat-1')).toBe(0)
    expect(countRunnableQueuedSessionTurns('chat-2')).toBe(0)
  })

  it('a send over the cap is kept from the start: in line, hidden, never counted as runnable', () => {
    registerHolder()
    queueSessionTurn('chat', { kind: 'single', messageId: 'r6', userMessageId: 'u6', keep: 'overflow' })
    expect(countQueuedSessionTurns('chat')).toBe(1)
    expect(countRunnableQueuedSessionTurns('chat')).toBe(0)
    expect(isQueuedSendMessageHidden('chat', 'u6')).toBe(true)
  })

  it('a chat being deleted holds its line, hands nothing over, and cancels it only once swept (BL-194)', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })

    beginSessionDelete('chat')
    releaseSessionTurn('chat', holder.turnId)
    expect(await settledNow(b.outcome)).toBeNull()
    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(true)

    cancelQueuedSessionTurnsOfDeletedChat('chat')
    expect(await b.outcome).toEqual({ kind: 'cancelled', reason: 'session_deleting' })
    expect(countQueuedSessionTurns('chat')).toBe(0)
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(false)
    endSessionDelete('chat')
    expect(getActiveSessionTurn('chat')).toBeNull()
  })

  it('a delete that ends without a sweep hands the chat to its line (BL-194)', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    beginSessionDelete('chat')
    releaseSessionTurn('chat', holder.turnId)
    expect(await settledNow(b.outcome)).toBeNull()

    endSessionDelete('chat')
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'run' })
  })

  it('a chat deleted after a send was handed the chat, before its request took it, lets it go', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    releaseSessionTurn('chat', holder.turnId)
    // B has the chat now, but its request resumes from its wait a step later. A delete that
    // lands in between must not wait on a request that will see the delete and never take it.
    beginSessionDelete('chat')

    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(hasRunningRequest('chat')).toBe(false)
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(false)
    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')
    expect(registerSessionTurn('chat', 'single', 'msg-b-reply', {}, handover.entry)).toEqual({
      ok: false,
      reason: 'session_deleting'
    })
  })

  it('a handed send its request has taken is an ordinary running turn: a delete waits for it', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    releaseSessionTurn('chat', holder.turnId)
    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')
    expect(registerSessionTurn('chat', 'single', 'msg-b-reply', {}, handover.entry).ok).toBe(true)

    beginSessionDelete('chat')

    expect(getActiveSessionTurn('chat')).toBe(handover.entry)
    expect(hasRunningRequest('chat')).toBe(true)
    releaseSessionTurn('chat', handover.entry.turnId)
    expect(hasRunningRequest('chat')).toBe(false)
  })

  it('while a line waits, only an approval click may register directly', async () => {
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    // A click on the finishing reply's card holds the line back when the lock goes.
    const releaseClick = holdQueueForApprovalClick('chat')
    releaseSessionTurn('chat', holder.turnId)

    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toBeNull()
    expect(registerSessionTurn('chat', 'single', 'msg-intruder').ok).toBe(false)
    const click = registerSessionTurn('chat', 'single', 'msg-a', { answersApproval: true })
    expect(click.ok).toBe(true)
    releaseClick()
    if (!click.ok) throw new Error('expected the click to register')

    // The line goes on when the click's own turn lets go.
    releaseSessionTurn('chat', click.entry.turnId)
    expect((await b.outcome).kind).toBe('run')
  })

  it('a click that never takes the lock does not strand the line: the backstop hands over', async () => {
    vi.useFakeTimers()
    const holder = registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    // B's request takes the chat the moment it is handed over, as send-routed does.
    void b.outcome.then((handover) => {
      if (handover.kind === 'run') registerSessionTurn('chat', 'single', 'msg-b-reply', {}, handover.entry)
    })
    const releaseClick = holdQueueForApprovalClick('chat')
    releaseSessionTurn('chat', holder.turnId)
    releaseClick()

    expect(getActiveSessionTurn('chat')).toBeNull()
    await vi.advanceTimersByTimeAsync(QUEUED_SESSION_TURN_BACKSTOP_MS)
    expect(getActiveSessionTurn('chat')?.messageId).toBe('msg-b-reply')
    expect((await b.outcome).kind).toBe('run')
    // An empty line leaves no timer behind, once the one-shot check that B was taken has run.
    await vi.advanceTimersByTimeAsync(1)
    expect(getActiveSessionTurn('chat')?.messageId).toBe('msg-b-reply')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lists the sends still waiting to run, oldest first, for a tab that joins now', () => {
    registerHolder()
    queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    queueSessionTurn('chat', { kind: 'single', messageId: null, userMessageId: 'msg-c' })
    queueSessionTurn('chat', { kind: 'single', messageId: 'msg-d-reply', userMessageId: 'msg-d', keep: 'overflow' })

    expect(listWaitingQueuedSends('chat').map(({ userMessageId, assistantMessageId }) => ({
      userMessageId,
      assistantMessageId
    }))).toEqual([
      { userMessageId: 'msg-b', assistantMessageId: 'msg-b-reply' },
      { userMessageId: 'msg-c', assistantMessageId: null }
    ])
    expect(typeof listWaitingQueuedSends('chat')[0]?.queuedAt).toBe('number')
    // A Stop keeps them: none will run, so none is shown as waiting.
    keepQueuedSessionTurns('chat', 'stopped')
    expect(listWaitingQueuedSends('chat')).toEqual([])
    expect(listWaitingQueuedSends('another-chat')).toEqual([])
  })

  it('after a Stop, the line waits for the stopped request to let go, not only for its lock (review finding 6)', async () => {
    vi.useFakeTimers()
    const holder = registerHolder()
    registerStreamAbort('chat', 'msg-a', new AbortController())
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    keepQueuedSessionTurns('chat', 'stopped')
    abortStream('chat', 'user')

    // The aborted-stream grace drops the lock after five seconds; the request still writes.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(getActiveSessionTurn('chat')).toBeNull()
    expect(await settledNow(b.outcome)).toBeNull()
    // It writes the stopped reply and lets go: now the kept message can go after that reply.
    releaseSessionTurn('chat', holder.turnId)
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'keep', reason: 'stopped' })
  })

  it('a stopped request that never lets go does not hold the line for good: it goes on after the wait', async () => {
    // Stop keeps the waiting sends, and each still needs the chat once to move its words to the
    // end. The line's own backstop runs the orphan rules, so no other traffic is needed.
    vi.useFakeTimers()
    registerHolder()
    registerStreamAbort('chat', 'msg-a', new AbortController())
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    keepQueuedSessionTurns('chat', 'stopped')
    abortStream('chat', 'user')

    await vi.advanceTimersByTimeAsync(5_000 + QUEUED_HANDOVER_REQUEST_WAIT_MS - 1_000)
    expect(await settledNow(b.outcome)).toBeNull()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await settledNow(b.outcome)).toMatchObject({ kind: 'keep', reason: 'stopped' })
  })

  it('keeps each waiting send’s "Queued" forward, for a Stop to say "Not sent" only after it (BL-203)', () => {
    registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    const c = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-c-reply', userMessageId: 'msg-c' })
    queueSessionTurn('other', { kind: 'single', messageId: 'msg-d-reply', userMessageId: 'msg-d' })
    const bNotice = new Promise<void>(() => {})
    const cNotice = new Promise<void>(() => {})
    noteQueuedSendNotice('chat', b.queueId, bNotice)
    noteQueuedSendNotice('chat', c.queueId, cNotice)
    noteQueuedSendNotice('chat', 999_999, Promise.resolve())

    expect(queuedSendNotices('chat', ['msg-b', 'msg-c'])).toEqual([bNotice, cNotice])
    expect(queuedSendNotices('chat', ['msg-c'])).toEqual([cNotice])
    expect(queuedSendNotices('chat', ['msg-x'])).toEqual([])
    expect(queuedSendNotices('other', ['msg-b'])).toEqual([])
  })

  it('says when another request of the chat still runs after its lock went (BL-198)', async () => {
    // The line hands the chat on at most 30 s after a lock went, even if that lock's request
    // still runs; the next turn's pre-run sandbox sweep must not remove that request's sandbox.
    vi.useFakeTimers()
    const stuck = registerHolder('chat', 'msg-a')
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    clearSessionTurn('chat', 'msg-a')
    vi.advanceTimersByTime(QUEUED_HANDOVER_REQUEST_WAIT_MS + QUEUED_SESSION_TURN_BACKSTOP_MS)
    const handover = await b.outcome
    if (handover.kind !== 'run') throw new Error('expected B to have been handed the chat')
    expect(claimQueuedSessionTurn('chat', handover.entry)).toBe(true)

    expect(isAnotherRequestRunning('chat', handover.entry.turnId)).toBe(true)
    expect(isAnotherRequestRunning('chat', stuck.turnId)).toBe(true)
    expect(isAnotherRequestRunning('other', handover.entry.turnId)).toBe(false)
    releaseSessionTurn('chat', stuck.turnId)
    expect(isAnotherRequestRunning('chat', handover.entry.turnId)).toBe(false)
  })

  it('the registry reveals a message when its sender says it has been moved', () => {
    registerHolder()
    queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    revealQueuedUserMessage('chat', 'msg-b')
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(false)
  })

  it('the test reset forgets the line and the hidden ids', () => {
    registerHolder()
    queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    __resetStreamAbortRegistryForTests()
    expect(countQueuedSessionTurns('chat')).toBe(0)
    expect(isQueuedSendMessageHidden('chat', 'msg-b')).toBe(false)
  })

  it('the test reset tells a send still waiting that its chat went away, so its request ends (BL-242)', async () => {
    // A request left waiting in a line the reset wiped used to wait forever, and a request a
    // timed-out test left behind then ran on into the next test's mocks.
    registerHolder()
    const b = queueSessionTurn('chat', { kind: 'single', messageId: 'msg-b-reply', userMessageId: 'msg-b' })
    __resetStreamAbortRegistryForTests()
    expect(await settledNow(b.outcome)).toEqual({ kind: 'cancelled', reason: 'session_deleting' })
  })
})
