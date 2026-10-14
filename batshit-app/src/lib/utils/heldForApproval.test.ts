import { describe, expect, it } from 'vitest'

import {
  APPROVAL_EXPIRED_REASON,
  HELD_CARD_EXPIRED_SENTENCE,
  HELD_REPLY_FAILED_SENTENCE,
  HELD_STOPPED_SENTENCE,
  WAITS_FOR_APPROVAL_SENTENCE,
  approvalSummaryIsPending,
  findHeldMessageAwaitingAnswer,
  isExpiryOnlyAnswer,
  isHeldForApprovalCard,
  readWaitsForApproval,
  resolveHeldMessageReceipt
} from './heldForApproval'
import { buildToolApprovalResponses } from './toolApprovalSubmit'
import { steerBubbleStatusLabel, type SteerBubbleEntry } from '$lib/stores/steerInbox.svelte'

describe('BL-455: the shared reads of a held message', () => {
  it('reads waitsForApproval only when it names a message', () => {
    expect(readWaitsForApproval({ waitsForApproval: { messageId: ' msg-card ' } })).toEqual({ messageId: 'msg-card' })
    expect(readWaitsForApproval({ waitsForApproval: { messageId: '' } })).toBeNull()
    expect(readWaitsForApproval({ waitsForApproval: true })).toBeNull()
    expect(readWaitsForApproval({ steerPromoted: { steerIds: ['a'] } })).toBeNull()
    expect(readWaitsForApproval(null)).toBeNull()
  })

  it('a summary waits while an entry is pending (or has no status yet) and was not sent', () => {
    expect(approvalSummaryIsPending({ approvals: [{ approvalId: 'a', status: 'pending' }] })).toBe(true)
    expect(approvalSummaryIsPending({ approvals: [{ approvalId: 'a' }] })).toBe(true)
    // The older bare-array shape.
    expect(approvalSummaryIsPending([{ approvalId: 'a', status: 'pending' }])).toBe(true)
    // One pending entry among answered ones still waits.
    expect(
      approvalSummaryIsPending({
        approvals: [
          { approvalId: 'a', status: 'approved' },
          { approvalId: 'b', status: 'pending' }
        ]
      })
    ).toBe(true)
  })

  it('an answered, expired, or sent card does not wait', () => {
    for (const status of ['approved', 'denied', 'expired']) {
      expect(approvalSummaryIsPending({ approvals: [{ approvalId: 'a', status }] })).toBe(false)
    }
    // The page marks an entry `submitted` once the server accepted its answer.
    expect(approvalSummaryIsPending({ approvals: [{ approvalId: 'a', status: 'pending', submitted: true }] })).toBe(false)
    expect(approvalSummaryIsPending({ approvals: [] })).toBe(false)
    expect(approvalSummaryIsPending(null)).toBe(false)
    expect(approvalSummaryIsPending({ mode: 'all' })).toBe(false)
  })

  it('a message is held for a card only when it is the user\u2019s and names that card', () => {
    const held = { role: 'user', metadata: { waitsForApproval: { messageId: 'msg-card' } } }
    expect(isHeldForApprovalCard(held, 'msg-card')).toBe(true)
    expect(isHeldForApprovalCard(held, ' msg-card ')).toBe(true)
    expect(isHeldForApprovalCard(held, 'msg-other-card')).toBe(false)
    expect(isHeldForApprovalCard({ ...held, role: 'assistant' }, 'msg-card')).toBe(false)
    expect(isHeldForApprovalCard({ role: 'user', metadata: {} }, 'msg-card')).toBe(false)
    expect(isHeldForApprovalCard(held, null)).toBe(false)
    expect(isHeldForApprovalCard(null, 'msg-card')).toBe(false)
  })
})

const pending = { mode: 'all', approvals: [{ approvalId: 'a', status: 'pending' }], source: 'vercel' }
const card = (metadata: Record<string, unknown> = {}) => ({
  id: 'msg-card',
  role: 'assistant',
  metadata: { toolApprovals: pending, ...metadata }
})
const question = { id: 'msg-user-1', role: 'user', metadata: {} }
const held = { id: 'msg-held', role: 'user', metadata: { waitsForApproval: { messageId: 'msg-card' } } }

describe('BL-455: the page\u2019s reads of a held message', () => {
  it('says the held message waits for the card', () => {
    expect(resolveHeldMessageReceipt({ messages: [question, card(), held], busy: false })).toEqual({
      messageId: 'msg-held',
      state: 'waiting',
      label: WAITS_FOR_APPROVAL_SENTENCE
    })
    expect(WAITS_FOR_APPROVAL_SENTENCE).toBe('Waits for your answer to the approval card.')
  })

  it('says nothing while the resumed reply or its answer runs', () => {
    const answered = card({ toolApprovals: { ...pending, approvals: [{ approvalId: 'a', status: 'approved', submitted: true }] } })
    expect(resolveHeldMessageReceipt({ messages: [question, answered, held], busy: true })).toBeNull()
  })

  it('says it was not sent after the user stopped the resumed reply', () => {
    const stopped = card({ toolApprovals: null, interrupted: true })
    expect(resolveHeldMessageReceipt({ messages: [question, stopped, held], busy: false })).toEqual({
      messageId: 'msg-held',
      state: 'stopped',
      label: HELD_STOPPED_SENTENCE
    })
  })

  it('the stopped line is the kept send\u2019s own words', () => {
    const dropped = { state: 'dropped', dropReason: 'stopped' } as SteerBubbleEntry
    expect(HELD_STOPPED_SENTENCE).toBe(steerBubbleStatusLabel(dropped))
  })

  it('is an ordinary message once the card is answered and nothing stopped', () => {
    expect(resolveHeldMessageReceipt({ messages: [question, card({ toolApprovals: null }), held], busy: false })).toBeNull()
  })

  it('goes away the moment anything is said after it', () => {
    const later = { id: 'msg-reply', role: 'assistant', metadata: {} }
    expect(resolveHeldMessageReceipt({ messages: [question, card(), held, later], busy: false })).toBeNull()
    expect(
      resolveHeldMessageReceipt({ messages: [question, card({ interrupted: true, toolApprovals: null }), held, later], busy: false })
    ).toBeNull()
  })

  it('draws nothing under an ordinary message', () => {
    expect(resolveHeldMessageReceipt({ messages: [question, card(), { id: 'msg-plain', role: 'user', metadata: {} }], busy: false })).toBeNull()
    expect(resolveHeldMessageReceipt({ messages: [], busy: false })).toBeNull()
  })
})

describe('BL-455: only the user\u2019s click releases the held words (Faye, 2026-09-27)', () => {
  it('the page\u2019s own answer to an expired card is an expiry answer, and a click is not', () => {
    const expired = buildToolApprovalResponses([{ approvalId: 'a', status: 'expired' }] as any)
    expect(expired[0].reason).toBe(APPROVAL_EXPIRED_REASON)
    expect(isExpiryOnlyAnswer(expired)).toBe(true)
    for (const status of ['approved', 'denied']) {
      expect(isExpiryOnlyAnswer(buildToolApprovalResponses([{ approvalId: 'a', status }] as any))).toBe(false)
    }
    // One entry clicked beside one that expired: the user clicked.
    expect(
      isExpiryOnlyAnswer(
        buildToolApprovalResponses([
          { approvalId: 'a', status: 'expired' },
          { approvalId: 'b', status: 'approved' }
        ] as any)
      )
    ).toBe(false)
    // An Approve never counts as an expiry, whatever reason it carries.
    expect(isExpiryOnlyAnswer([{ approved: true, reason: APPROVAL_EXPIRED_REASON }])).toBe(false)
    expect(isExpiryOnlyAnswer([])).toBe(false)
    expect(isExpiryOnlyAnswer(null)).toBe(false)
  })

  it('a held message whose card expired says so, with the card answered and even while the resume runs', () => {
    const expiredHeld = { ...held, metadata: { ...held.metadata, approvalCardExpired: true } }
    for (const busy of [false, true]) {
      expect(resolveHeldMessageReceipt({ messages: [question, card({ toolApprovals: null }), expiredHeld], busy })).toEqual({
        messageId: 'msg-held',
        state: 'expired',
        label: HELD_CARD_EXPIRED_SENTENCE
      })
    }
    expect(HELD_CARD_EXPIRED_SENTENCE).toBe('Not sent — the approval card expired')
  })

  it('a failed reply leaves the held message with its receipt, once nothing runs', () => {
    const failed = card({ toolApprovals: null, response_failed: true })
    expect(resolveHeldMessageReceipt({ messages: [question, failed, held], busy: false })).toEqual({
      messageId: 'msg-held',
      state: 'failed',
      label: HELD_REPLY_FAILED_SENTENCE
    })
    // The backstop's own words (`steerBubbleStatusLabel`, unanswered).
    const unanswered = { state: 'dropped', dropReason: 'unanswered' } as SteerBubbleEntry
    expect(HELD_REPLY_FAILED_SENTENCE).toBe(steerBubbleStatusLabel(unanswered))
  })

  it('says nothing about a stop or a failure while a reply still runs', () => {
    for (const metadata of [{ interrupted: true }, { response_failed: true }]) {
      expect(resolveHeldMessageReceipt({ messages: [question, card({ toolApprovals: null, ...metadata }), held], busy: true })).toBeNull()
    }
  })

  it('a send the chat\u2019s line kept at an approval card says it in the held message\u2019s words (BL-713)', () => {
    const approvalWait = { state: 'dropped', dropReason: 'approval_wait' } as SteerBubbleEntry
    expect(steerBubbleStatusLabel(approvalWait)).toBe(
      'Not sent — the approval card is still waiting for your answer. Send it when you are ready.'
    )
    const expired = { state: 'dropped', dropReason: 'approval_expired' } as SteerBubbleEntry
    expect(steerBubbleStatusLabel(expired)).toBe(HELD_CARD_EXPIRED_SENTENCE)
    const waiting = {
      state: 'queued',
      deliver: 'end',
      queuedSend: true,
      heldForApprovalCard: 'msg-card'
    } as SteerBubbleEntry
    expect(steerBubbleStatusLabel(waiting)).toBe(WAITS_FOR_APPROVAL_SENTENCE)
  })
})


/**
 * BL-905 — a send the chat's line keeps at the same card (the 15-minute bound, the page's expiry
 * Deny, a restore, a clean stop, Stop) moves to the end of the chat, after the held message. The
 * held words still wait for the card: no reply follows them. So the reads look past the user
 * messages at the end of the chat that no reply follows, and only a reply ends the held state.
 */
describe('BL-905: held words and a kept send at the same card', () => {
  const kept = { id: 'msg-kept', role: 'user', metadata: {} }
  const keptTwo = { id: 'msg-kept-2', role: 'user', metadata: {} }

  it('finds the held message behind the kept sends that no reply follows', () => {
    expect(findHeldMessageAwaitingAnswer([question, card(), held, kept])).toEqual({ message: held, index: 2 })
    expect(findHeldMessageAwaitingAnswer([question, card(), held, kept, keptTwo], 'msg-card')).toEqual({
      message: held,
      index: 2
    })
    // Today's case: the held message is the chat's last.
    expect(findHeldMessageAwaitingAnswer([question, card(), held], 'msg-card')).toEqual({ message: held, index: 2 })
  })

  it('finds nothing once a reply follows the held words, for another card, or with no held message', () => {
    const reply = { id: 'msg-reply', role: 'assistant', metadata: {} }
    expect(findHeldMessageAwaitingAnswer([question, card(), held, kept, reply])).toBeNull()
    expect(findHeldMessageAwaitingAnswer([question, card(), held, reply, kept])).toBeNull()
    expect(findHeldMessageAwaitingAnswer([question, card(), held, kept], 'msg-other-card')).toBeNull()
    expect(findHeldMessageAwaitingAnswer([question, card(), kept])).toBeNull()
    expect(findHeldMessageAwaitingAnswer([])).toBeNull()
    expect(findHeldMessageAwaitingAnswer(null)).toBeNull()
  })

  it('the held message keeps its receipt and its Send now while a kept send stands after it, in every state', () => {
    expect(resolveHeldMessageReceipt({ messages: [question, card(), held, kept], busy: false })).toEqual({
      messageId: 'msg-held',
      state: 'waiting',
      label: WAITS_FOR_APPROVAL_SENTENCE
    })
    const expiredHeld = { ...held, metadata: { ...held.metadata, approvalCardExpired: true } }
    expect(
      resolveHeldMessageReceipt({ messages: [question, card({ toolApprovals: null }), expiredHeld, kept], busy: false })
    ).toMatchObject({ messageId: 'msg-held', state: 'expired' })
    expect(
      resolveHeldMessageReceipt({
        messages: [question, card({ toolApprovals: null, interrupted: true }), held, kept, keptTwo],
        busy: false
      })
    ).toMatchObject({ messageId: 'msg-held', state: 'stopped' })
  })

  it('a reply after the kept send (its Send now) ends the held receipt: that turn read the held words', () => {
    const keptReply = { id: 'msg-kept-reply', role: 'assistant', metadata: {} }
    expect(resolveHeldMessageReceipt({ messages: [question, card(), held, kept, keptReply], busy: false })).toBeNull()
  })
})
