import { describe, expect, it } from 'vitest'
import {
  approvalAnswerWasRecorded,
  buildToolApprovalResponses,
  collectUnsentApprovalDecisions,
  markApprovalDecisionsSent,
  returnRefusedApprovalDecisions
} from './toolApprovalSubmit'

/**
 * What an approval click leaves on the card once the server has answered (2026-09-18).
 *
 * A click marks its entry at once so the card stops offering the buttons while the answer is
 * on its way. The card keeps that mark only for an answer the server ACCEPTED: a refused
 * answer, or one that never arrived, used to leave "Approved" with no buttons and nothing
 * sent, until a reload. `ChatMessageApprovalSubmit.test.ts` drives the real component.
 */

type Entry = Record<string, any>

const entry = (approvalId: string, status: string, extra: Entry = {}): Entry => ({
  approvalId,
  status,
  toolName: 'native_bash_execute',
  ...extra
})

describe('collectUnsentApprovalDecisions', () => {
  it('takes every decided entry not sent yet, in card order', () => {
    const approvals = [
      entry('a', 'approved'),
      entry('b', 'pending'),
      entry('c', 'denied'),
      entry('d', 'expired'),
      entry('e', 'approved', { submitted: true })
    ]
    expect(collectUnsentApprovalDecisions(approvals).map((item) => item.approvalId)).toEqual(['a', 'c', 'd'])
  })
})

describe('buildToolApprovalResponses', () => {
  it('says approve, deny, or expired, the way send-routed reads them', () => {
    expect(
      buildToolApprovalResponses([entry('a', 'approved'), entry('c', 'denied'), entry('d', 'expired')])
    ).toEqual([
      { type: 'tool-approval-response', approvalId: 'a', approved: true, reason: 'User approved' },
      { type: 'tool-approval-response', approvalId: 'c', approved: false, reason: 'User denied' },
      {
        type: 'tool-approval-response',
        approvalId: 'd',
        approved: false,
        reason: 'Approval expired after 3 minutes'
      }
    ])
  })
})

describe('markApprovalDecisionsSent (the server accepted the answer)', () => {
  it('marks each sent entry with the decision it carried, and leaves the rest alone', () => {
    const sent = [entry('a', 'approved')]
    const next = markApprovalDecisionsSent([entry('a', 'approved'), entry('b', 'pending')], sent)
    expect(next).toEqual([entry('a', 'approved', { submitted: true }), entry('b', 'pending')])
  })

  it('keeps the decision even if the card was re-read from the server while the answer was out', () => {
    // A chat reload during the answer puts the stored copy (still pending) back on screen.
    const next = markApprovalDecisionsSent([entry('a', 'pending')], [entry('a', 'approved')])
    expect(next).toEqual([entry('a', 'approved', { submitted: true })])
  })
})

describe('returnRefusedApprovalDecisions (the server refused, or the answer never arrived)', () => {
  it('puts every Approve and Deny it carried back to pending, so the buttons come back', () => {
    const sent = [entry('a', 'approved'), entry('c', 'denied')]
    const next = returnRefusedApprovalDecisions(
      [entry('a', 'approved'), entry('b', 'pending'), entry('c', 'denied')],
      sent
    )
    expect(next).toEqual([
      entry('a', 'pending', { submitted: false }),
      entry('b', 'pending'),
      entry('c', 'pending', { submitted: false })
    ])
  })

  it('leaves an expired entry expired: its clock ran out whatever the server said', () => {
    const next = returnRefusedApprovalDecisions([entry('d', 'expired')], [entry('d', 'expired')])
    expect(next).toEqual([entry('d', 'expired', { submitted: false })])
  })

  it('touches only what this answer carried', () => {
    const next = returnRefusedApprovalDecisions(
      [entry('a', 'approved'), entry('z', 'approved', { submitted: true })],
      [entry('a', 'approved')]
    )
    expect(next).toEqual([entry('a', 'pending', { submitted: false }), entry('z', 'approved', { submitted: true })])
  })
})

describe('approvalAnswerWasRecorded (does the card keep its marks?)', () => {
  it('keeps them for a turn that succeeded', () => {
    expect(approvalAnswerWasRecorded({ accepted: true, ok: true })).toBe(true)
    // A server without respond-async answers the whole turn at once.
    expect(approvalAnswerWasRecorded({ accepted: false, ok: true })).toBe(true)
  })

  it('gives the buttons back when the server never took the answer', () => {
    expect(approvalAnswerWasRecorded({ accepted: false, ok: false, code: 'session_turn_in_progress' })).toBe(false)
    expect(approvalAnswerWasRecorded({ accepted: false, ok: false })).toBe(false)
  })

  it('keeps them when an accepted answer’s run failed or was stopped: the server recorded it first', () => {
    expect(approvalAnswerWasRecorded({ accepted: true, ok: false, code: null })).toBe(true)
    expect(approvalAnswerWasRecorded({ accepted: true, ok: false, code: 'PROVIDER_ERROR' })).toBe(true)
    expect(approvalAnswerWasRecorded({ accepted: true, ok: false, code: 'approval_already_answered' })).toBe(true)
  })

  it('gives the buttons back when the server says it could not record the answer', () => {
    expect(approvalAnswerWasRecorded({ accepted: true, ok: false, code: 'approval_record_failed' })).toBe(false)
  })
})

