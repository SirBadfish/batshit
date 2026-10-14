import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_APPROVAL_RETAIN_AFTER_RUN_MS,
  __resetClaudeApprovalRegistryForTests,
  claimClaudeApproval,
  endClaudeApprovalRun,
  forgetClaudeApprovals,
  hasWaitingClaudeApproval,
  listClaudeApprovals,
  recordClaudeApprovalCard,
  releaseClaudeApprovalClaim,
  settleClaudeApproval
} from '../claudeApprovalRegistry'

/**
 * BL-496 — the server's record of a Claude approval card, which lives as long as its run.
 */

const T0 = Date.parse('2026-09-28T12:00:00.000Z')

function card(approvalId: string, overrides: Record<string, any> = {}) {
  return {
    sessionId: 'session-a',
    messageId: 'reply-a',
    approvalId,
    toolName: 'Bash',
    input: { command: 'echo hi' },
    toolUseId: 'toolu_1',
    requestedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 600_000).toISOString(),
    ...overrides
  }
}

beforeEach(() => {
  __resetClaudeApprovalRegistryForTests()
})

describe('the Claude approval card registry (BL-496)', () => {
  it('a recorded card waits until its answer settles it, and a repeat of it changes nothing', () => {
    expect(recordClaudeApprovalCard(card('ap-1'), T0).created).toBe(true)
    expect(recordClaudeApprovalCard(card('ap-1', { toolName: 'Other' }), T0).created).toBe(false)
    expect(hasWaitingClaudeApproval('session-a', T0 + 1000)).toBe(true)
    expect(hasWaitingClaudeApproval('session-b', T0 + 1000)).toBe(false)

    const settled = settleClaudeApproval('session-a', 'ap-1', { status: 'approved' })
    expect(settled).toMatchObject({ status: 'approved', toolName: 'Bash' })
    expect(hasWaitingClaudeApproval('session-a', T0 + 1000)).toBe(false)
    // The record stays for the reply's end and its save.
    expect(listClaudeApprovals('session-a', 'reply-a')).toHaveLength(1)
  })

  it('a card past its own clock is not waiting (A5: one clock)', () => {
    recordClaudeApprovalCard(card('ap-1'), T0)
    expect(hasWaitingClaudeApproval('session-a', T0 + 599_999)).toBe(true)
    expect(hasWaitingClaudeApproval('session-a', T0 + 600_000)).toBe(false)
  })

  it('an expiry from the helper is typed and keeps its reason (A6)', () => {
    recordClaudeApprovalCard(card('ap-1'), T0)
    expect(settleClaudeApproval('session-a', 'ap-1', { status: 'expired', expiryReason: 'unanswered' }))
      .toMatchObject({ status: 'expired', expiryReason: 'unanswered' })
    // A late second result does not rewrite the first.
    expect(settleClaudeApproval('session-a', 'ap-1', { status: 'approved' })).toMatchObject({ status: 'expired' })
  })

  it('an answer claims a live card once; a failed write lets go; a card of another chat is unknown (A7)', () => {
    recordClaudeApprovalCard(card('ap-1'), T0)
    expect(claimClaudeApproval('session-b', 'ap-1', T0)).toEqual({ ok: false, reason: 'not_found' })
    expect(claimClaudeApproval('session-a', 'nope', T0)).toEqual({ ok: false, reason: 'not_found' })
    expect(claimClaudeApproval('session-a', 'ap-1', T0).ok).toBe(true)
    expect(claimClaudeApproval('session-a', 'ap-1', T0)).toEqual({ ok: false, reason: 'answered' })
    releaseClaudeApprovalClaim('session-a', 'ap-1')
    expect(claimClaudeApproval('session-a', 'ap-1', T0).ok).toBe(true)
  })

  it('refuses an answer after the card’s time, and after its answer', () => {
    recordClaudeApprovalCard(card('ap-1'), T0)
    expect(claimClaudeApproval('session-a', 'ap-1', T0 + 600_000)).toEqual({ ok: false, reason: 'ended' })
    recordClaudeApprovalCard(card('ap-2'), T0)
    settleClaudeApproval('session-a', 'ap-2', { status: 'denied' })
    expect(claimClaudeApproval('session-a', 'ap-2', T0)).toEqual({ ok: false, reason: 'answered' })
  })

  it('a run that ends ends its waiting cards, and they can no longer be answered', () => {
    recordClaudeApprovalCard(card('ap-1'), T0)
    recordClaudeApprovalCard(card('ap-2', { requestedAt: new Date(T0 + 5).toISOString() }), T0)
    settleClaudeApproval('session-a', 'ap-2', { status: 'approved' })
    const ended = endClaudeApprovalRun('session-a', 'reply-a', T0 + 10)
    expect(ended.map((record) => [record.approvalId, record.status, record.expiryReason])).toEqual([
      ['ap-1', 'expired', 'run_ended'],
      ['ap-2', 'approved', undefined]
    ])
    expect(hasWaitingClaudeApproval('session-a', T0 + 10)).toBe(false)
    expect(claimClaudeApproval('session-a', 'ap-1', T0 + 10)).toEqual({ ok: false, reason: 'answered' })
  })

  it('a reply’s cards are forgotten after its end, and an ended run’s are dropped after the bound', () => {
    recordClaudeApprovalCard(card('ap-1'), T0)
    recordClaudeApprovalCard(card('ap-2', { messageId: 'reply-b' }), T0)
    forgetClaudeApprovals('session-a', 'reply-a')
    expect(listClaudeApprovals('session-a', 'reply-a')).toEqual([])
    expect(listClaudeApprovals('session-a', 'reply-b')).toHaveLength(1)

    endClaudeApprovalRun('session-a', 'reply-b', T0)
    recordClaudeApprovalCard(card('ap-3', { messageId: 'reply-c' }), T0 + CLAUDE_APPROVAL_RETAIN_AFTER_RUN_MS + 1)
    expect(listClaudeApprovals('session-a', 'reply-b')).toEqual([])
    expect(listClaudeApprovals('session-a', 'reply-c')).toHaveLength(1)
  })
})
