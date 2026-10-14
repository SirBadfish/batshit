import { describe, expect, it } from 'vitest'
import {
  applyClaudeApprovalCardEvent,
  hasCompleteClaudeApprovalArgs,
  settleClaudeApprovalCard
} from './claudeApprovalCard'
import { describeApprovalExpiry, describeExpiredApprovalClick } from './controlApprovalPresentation'

/**
 * BL-636 — the helper's real event order: `tool_start` with no arguments, THEN `tool-call` with
 * the tool and its input. The page made the card from the first and then skipped the second.
 * The events below are the shapes `scripts/claude-permission-mcp.cjs` publishes.
 */

const HELPER = 'mcp__batshit_gateway_claude-approvals__batshit_permission_prompt'
const toolStart = { type: 'tool_start', sessionId: 's', messageId: 'm', toolCallId: 'ap-1', toolName: HELPER }
const toolCall = {
  type: 'tool-call',
  sessionId: 's',
  messageId: 'm',
  toolCallId: 'ap-1',
  toolName: HELPER,
  args: { approvalId: 'ap-1', toolName: 'Bash', toolInput: { command: 'rm -r build' }, toolUseId: 'toolu_1' },
  requestedAt: '2026-09-28T12:00:00.000Z',
  expiresAt: '2026-09-28T12:10:00.000Z'
}

// What `extractClaudeApprovalDetails` in `+page.svelte` reads off each event.
const startDetails = { approvalId: 'ap-1', toolName: HELPER, input: {}, toolCall: { toolName: HELPER, input: {} } }
const callDetails = {
  approvalId: 'ap-1',
  toolName: 'Bash',
  input: { command: 'rm -r build' },
  toolCall: { toolName: 'Bash', input: { command: 'rm -r build' } }
}
const clock = { requestedAt: toolCall.requestedAt, expiresAt: toolCall.expiresAt }

describe('a Claude approval card from the helper’s events (BL-636)', () => {
  it('the bare tool_start makes no card; the complete tool-call makes the real one', () => {
    expect(hasCompleteClaudeApprovalArgs(toolStart)).toBe(false)
    expect(applyClaudeApprovalCardEvent([], toolStart, startDetails, {})).toBeNull()

    const approvals = applyClaudeApprovalCardEvent([], toolCall, callDetails, clock)
    expect(approvals).toEqual([
      {
        approvalId: 'ap-1',
        status: 'pending',
        submitted: false,
        requestedAt: toolCall.requestedAt,
        expiresAt: toolCall.expiresAt,
        toolName: 'Bash',
        toolCall: callDetails.toolCall,
        input: { command: 'rm -r build' },
        source: 'claude'
      }
    ])
  })

  it('completes a card an older page made from the bare tool_start, keeping its state', () => {
    const incomplete = [
      { approvalId: 'ap-1', status: 'pending', submitted: false, toolName: HELPER, input: {}, source: 'claude' }
    ]
    const approvals = applyClaudeApprovalCardEvent(incomplete, toolCall, callDetails, clock)
    expect(approvals).toHaveLength(1)
    expect(approvals?.[0]).toMatchObject({
      status: 'pending',
      toolName: 'Bash',
      input: { command: 'rm -r build' },
      expiresAt: toolCall.expiresAt
    })
  })

  it('a replayed tool-call does not reopen a card that was already answered', () => {
    const answered = [{ approvalId: 'ap-1', status: 'approved', submitted: true, toolName: 'Bash', source: 'claude' }]
    expect(applyClaudeApprovalCardEvent(answered, toolCall, callDetails, clock)?.[0]).toMatchObject({
      status: 'approved',
      submitted: true
    })
  })
})

describe('the end of a Claude card (BL-496 A6)', () => {
  const card = [{ approvalId: 'ap-1', status: 'pending', submitted: false, toolName: 'Bash', source: 'claude' }]

  it('a card nobody answered ends expired with its reason, not denied', () => {
    const ended = settleClaudeApprovalCard(card, 'ap-1', { approvalStatus: 'expired', expiryReason: 'unanswered' }, false)
    expect(ended[0]).toMatchObject({ status: 'expired', expiryReason: 'unanswered', submitted: true })
    expect(describeApprovalExpiry(ended[0])).toBe('Expired: nobody answered')
  })

  it('a person’s answer is still approved or denied', () => {
    expect(settleClaudeApprovalCard(card, 'ap-1', { approvalStatus: 'denied' }, false)[0].status).toBe('denied')
    expect(settleClaudeApprovalCard(card, 'ap-1', { approvalStatus: 'approved' }, true)[0].status).toBe('approved')
  })

  it('names why each expired card ended', () => {
    expect(describeApprovalExpiry({ expiryReason: 'run_ended' })).toBe('Expired: the reply ended')
    expect(describeApprovalExpiry({ status: 'expired' })).toBe('Expired (3m)')
  })

  it('a wait that failed keeps its own reason and words (review finding 4)', () => {
    const ended = settleClaudeApprovalCard(card, 'ap-1', { approvalStatus: 'expired', expiryReason: 'wait_failed' }, false)
    expect(ended[0]).toMatchObject({ status: 'expired', expiryReason: 'wait_failed' })
    expect(describeApprovalExpiry(ended[0])).toBe('Ended: the answer could not be read')
  })

  it('a click on an expired Claude card never speaks of three minutes (review finding 7)', () => {
    expect(describeExpiredApprovalClick({ source: 'claude', status: 'expired' })).toBe(
      'This approval has expired. Ask the agent to try again.'
    )
    expect(describeExpiredApprovalClick({ source: 'vercel', status: 'expired' })).toBe(
      'This approval already expired after 3 minutes. Ask the agent to run it again.'
    )
  })
})
