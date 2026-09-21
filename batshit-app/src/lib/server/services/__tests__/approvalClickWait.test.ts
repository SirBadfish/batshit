import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStreamAbortRegistryForTests,
  clearSessionTurn,
  clearStreamAbort,
  getActiveSessionTurn,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn
} from '$lib/server/services/streamAbortRegistry'
import {
  APPROVAL_CLICK_WAIT_MS,
  approvalClickWaitsForTurn,
  isApprovalClick,
  waitForCardReplyToFinish
} from '$lib/server/services/approvalClickWait'

/**
 * An approval click belongs to the reply that raised its card.
 *
 * Measured live on 2026-09-18 (`_local/approval-early-click-proof/before-fix.json`): the card
 * appeared, Approve was clicked at once, and send-routed refused it 66 ms later with
 * `session_turn_in_progress` — the reply that raised the card was still doing its after-reply
 * work under the chat's turn lock, and its own request finished 118 ms after the card
 * appeared. These drive the REAL lock registry.
 */

const SESSION = 'session-approval-click'
const CARD = 'msg_assistant_card'

beforeEach(() => {
  __resetStreamAbortRegistryForTests()
})

afterEach(() => {
  vi.useRealTimers()
  __resetStreamAbortRegistryForTests()
})

describe('isApprovalClick', () => {
  it('is an answer to approval cards with no user turn of its own', () => {
    expect(isApprovalClick({ approvalResponseCount: 1, content: '' })).toBe(true)
    expect(isApprovalClick({ approvalResponseCount: 2, content: '   ' })).toBe(true)
    expect(isApprovalClick({ approvalResponseCount: 1, content: null })).toBe(true)
  })

  it('is not a send: no approval answers, or words of its own', () => {
    expect(isApprovalClick({ approvalResponseCount: 0, content: '' })).toBe(false)
    // send-routed ignores a stale approval payload that arrives with real text.
    expect(isApprovalClick({ approvalResponseCount: 1, content: 'and also do this' })).toBe(false)
    expect(isApprovalClick({ approvalResponseCount: 1, content: [{ type: 'text', text: 'hi' }] })).toBe(false)
  })
})

describe('the lock remembers whether it answers an approval', () => {
  it('records it, and a plain turn does not', () => {
    registerSessionTurn(SESSION, 'single', CARD, { answersApproval: true })
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: CARD, answersApproval: true })

    clearSessionTurn(SESSION, CARD)
    registerSessionTurn(SESSION, 'single', CARD)
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: CARD, answersApproval: false })
  })
})

describe('approvalClickWaitsForTurn', () => {
  it('waits for the reply that raised the card: the lock names the card, and answers nothing', () => {
    expect(
      approvalClickWaitsForTurn({ kind: 'single', messageId: CARD, answersApproval: false }, CARD)
    ).toBe(true)
  })

  it('never waits behind another click on the same card: that would spend the approval twice', () => {
    expect(
      approvalClickWaitsForTurn({ kind: 'single', messageId: CARD, answersApproval: true }, CARD)
    ).toBe(false)
  })

  it('does not wait for a turn that is not the card’s own reply', () => {
    expect(
      approvalClickWaitsForTurn({ kind: 'single', messageId: 'msg_other_reply', answersApproval: false }, CARD)
    ).toBe(false)
    expect(approvalClickWaitsForTurn({ kind: 'group', messageId: null, answersApproval: false }, CARD)).toBe(false)
    // A group turn holds the lock for every speaker in it, so its card is left as it was.
    expect(approvalClickWaitsForTurn({ kind: 'group', messageId: CARD, answersApproval: false }, CARD)).toBe(false)
    expect(approvalClickWaitsForTurn(null, CARD)).toBe(false)
    expect(
      approvalClickWaitsForTurn({ kind: 'single', messageId: CARD, answersApproval: false }, '')
    ).toBe(false)
    expect(
      approvalClickWaitsForTurn({ kind: 'single', messageId: null, answersApproval: false }, CARD)
    ).toBe(false)
  })
})

describe('waitForCardReplyToFinish', () => {
  it('waits while the card’s own reply holds the lock, and ends as soon as it lets go', async () => {
    registerSessionTurn(SESSION, 'single', CARD)
    setTimeout(() => clearSessionTurn(SESSION, CARD), 150)

    const started = Date.now()
    const outcome = await waitForCardReplyToFinish(SESSION, CARD)

    expect(outcome).toBe('released')
    expect(getActiveSessionTurn(SESSION)).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not wait behind a lock that is already answering an approval', async () => {
    registerSessionTurn(SESSION, 'single', CARD, { answersApproval: true })
    const started = Date.now()
    expect(await waitForCardReplyToFinish(SESSION, CARD)).toBe('no_wait')
    expect(Date.now() - started).toBeLessThan(50)
    // The other click's lock is untouched.
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: CARD, answersApproval: true })
  })

  it('does not wait for another reply, or when nothing is running', async () => {
    registerSessionTurn(SESSION, 'single', 'msg_other_reply')
    expect(await waitForCardReplyToFinish(SESSION, CARD)).toBe('no_wait')
    __resetStreamAbortRegistryForTests()
    expect(await waitForCardReplyToFinish(SESSION, CARD)).toBe('no_wait')
  })

  it('stops waiting when the lock passes to a click on the same card mid-wait', async () => {
    registerSessionTurn(SESSION, 'single', CARD)
    setTimeout(() => {
      // The reply lets go and another tab's click takes the lock before this one looks again.
      clearSessionTurn(SESSION, CARD)
      registerSessionTurn(SESSION, 'single', CARD, { answersApproval: true })
    }, 150)

    expect(await waitForCardReplyToFinish(SESSION, CARD)).toBe('released')
    // It is the caller's lock check that refuses this click; the wait never takes a lock.
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ answersApproval: true })
  })

  it('waits through the after-reply work of a reply that ran past two minutes', async () => {
    // Measured live (`_local/lock-prune-proof/before-real.json`): a 139-second reply raised
    // the card, its stream ended, and a click 277 ms later found the lock pruned as an orphan
    // while the reply's request was still in its `finally`. The click ran beside it, and the
    // old request's release then deleted the click's lock.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))
    const reply = registerSessionTurn(SESSION, 'single', CARD)
    if (!reply.ok) throw new Error('registration refused')
    registerStreamAbort(SESSION, CARD, new AbortController())
    vi.advanceTimersByTime(139_000)
    clearStreamAbort(SESSION, CARD)

    let outcome: string | null = null
    void waitForCardReplyToFinish(SESSION, CARD).then((value) => {
      outcome = value
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(outcome).toBeNull()
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: CARD, answersApproval: false })

    releaseSessionTurn(SESSION, reply.entry.turnId)
    await vi.advanceTimersByTimeAsync(150)
    expect(outcome).toBe('released')
  })

  it('gives up at the bound, fifteen seconds, and leaves the lock alone', async () => {
    vi.useFakeTimers()
    registerSessionTurn(SESSION, 'single', CARD)

    let outcome: string | null = null
    void waitForCardReplyToFinish(SESSION, CARD).then((value) => {
      outcome = value
    })

    await vi.advanceTimersByTimeAsync(14_800)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(400)
    expect(outcome).toBe('timed_out')
    expect(APPROVAL_CLICK_WAIT_MS).toBe(15_000)
    expect(getActiveSessionTurn(SESSION)).toMatchObject({ messageId: CARD })
  })
})
