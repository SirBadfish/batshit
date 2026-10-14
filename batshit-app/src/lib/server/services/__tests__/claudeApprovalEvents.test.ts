import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dm = vi.hoisted(() => ({
  stampDmNeedsUser: vi.fn(),
  clearDmNeedsUserStamp: vi.fn(),
  listSessionApprovals: vi.fn()
}))

vi.mock('$lib/server/services/controlApprovals', () => ({
  listSessionApprovals: dm.listSessionApprovals
}))

vi.mock('$lib/server/services/dm/dmStore', () => ({
  stampDmNeedsUser: dm.stampDmNeedsUser,
  clearDmNeedsUserStamp: dm.clearDmNeedsUserStamp
}))

import {
  CLAUDE_APPROVAL_EVENT_TOOL_NAME,
  buildClaudeApprovalReplayEvents,
  buildClaudeApprovalSummary,
  endClaudeApprovalRunForReply,
  noteClaudeApprovalEvent
} from '../claudeApprovalEvents'
import {
  __resetClaudeApprovalRegistryForTests,
  hasWaitingClaudeApproval,
  listClaudeApprovals
} from '../claudeApprovalRegistry'
import { __resetWakeRunRegistryForTests, registerWakeRun } from '../wakeRunRegistry'

/**
 * BL-496 — what the server does with the permission helper's events, whether or not a tab
 * watches the chat. The events are the shapes `scripts/claude-permission-mcp.cjs` publishes.
 */

const SESSION = 'session-card'
const REPLY = 'reply-card'

function helperEvents(approvalId: string, messageId = REPLY) {
  const base = { sessionId: SESSION, messageId, toolCallId: approvalId, toolName: CLAUDE_APPROVAL_EVENT_TOOL_NAME }
  const requestedAt = new Date().toISOString()
  return {
    start: { type: 'tool_start', ...base },
    call: {
      type: 'tool-call',
      ...base,
      args: { approvalId, toolName: 'Bash', toolInput: { command: 'touch /tmp/x' }, toolUseId: 'toolu_1' },
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + 600_000).toISOString()
    },
    approved: { type: 'tool-result', ...base, result: { behavior: 'allow' }, approvalStatus: 'approved' },
    expired: {
      type: 'tool-result',
      ...base,
      result: { behavior: 'deny', message: 'Nobody answered' },
      approvalStatus: 'expired',
      expiryReason: 'unanswered'
    }
  }
}

function registerWokenTurn(messageId = REPLY) {
  registerWakeRun({
    sessionId: SESSION,
    agentId: 'agent-1',
    userId: 'user-1',
    origin: { version: 1, kind: 'dm', label: 'Cooper', dmId: 'dm-1', at: new Date().toISOString(), chainDepth: 1 } as any,
    startedAt: Date.now(),
    reservedAt: Date.now() - 5,
    assistantMessageId: messageId,
    controller: new AbortController(),
    timer: setTimeout(() => {}, 60_000)
  })
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  __resetClaudeApprovalRegistryForTests()
  __resetWakeRunRegistryForTests()
  dm.stampDmNeedsUser.mockReset()
  dm.clearDmNeedsUserStamp.mockReset()
  dm.clearDmNeedsUserStamp.mockResolvedValue(true)
  dm.listSessionApprovals.mockReset()
  dm.listSessionApprovals.mockResolvedValue([])
})

afterEach(() => {
  __resetWakeRunRegistryForTests()
})

describe('Claude approval events on the server (BL-496)', () => {
  it('records the card from the helper’s complete event only, and settles it with its answer', () => {
    const events = helperEvents('ap-1')
    expect(noteClaudeApprovalEvent(SESSION, events.start)).toBe(true)
    expect(listClaudeApprovals(SESSION, REPLY)).toEqual([])

    noteClaudeApprovalEvent(SESSION, events.call)
    expect(hasWaitingClaudeApproval(SESSION)).toBe(true)
    expect(listClaudeApprovals(SESSION, REPLY)[0]).toMatchObject({
      toolName: 'Bash',
      input: { command: 'touch /tmp/x' },
      status: 'pending'
    })

    noteClaudeApprovalEvent(SESSION, events.approved)
    expect(hasWaitingClaudeApproval(SESSION)).toBe(false)
    expect(listClaudeApprovals(SESSION, REPLY)[0].status).toBe('approved')
  })

  it('ignores everything that is not the helper’s event', () => {
    expect(noteClaudeApprovalEvent(SESSION, { type: 'tool-call', toolName: 'Bash', args: {} })).toBe(false)
    expect(noteClaudeApprovalEvent(SESSION, { type: 'chunk', content: 'x' })).toBe(false)
    expect(listClaudeApprovals(SESSION, REPLY)).toEqual([])
  })

  it('the reply’s summary says a card nobody answered expired, and why (A1, A6)', () => {
    const events = helperEvents('ap-1')
    noteClaudeApprovalEvent(SESSION, events.call)
    noteClaudeApprovalEvent(SESSION, events.expired)
    expect(buildClaudeApprovalSummary(SESSION, REPLY)).toMatchObject({
      mode: 'all',
      source: 'claude',
      approvals: [
        {
          approvalId: 'ap-1',
          status: 'expired',
          expiryReason: 'unanswered',
          submitted: true,
          toolName: 'Bash',
          input: { command: 'touch /tmp/x' },
          source: 'claude'
        }
      ]
    })
    expect(buildClaudeApprovalSummary(SESSION, 'other-reply')).toBeNull()
  })

  it('replays a card as the helper’s own event shapes, with its answer once it has one', () => {
    const events = helperEvents('ap-1')
    noteClaudeApprovalEvent(SESSION, events.call)
    const [waiting] = listClaudeApprovals(SESSION, REPLY)
    expect(buildClaudeApprovalReplayEvents(waiting)).toEqual([
      {
        type: 'tool-call',
        sessionId: SESSION,
        messageId: REPLY,
        toolCallId: 'ap-1',
        toolName: CLAUDE_APPROVAL_EVENT_TOOL_NAME,
        args: { approvalId: 'ap-1', toolName: 'Bash', toolInput: { command: 'touch /tmp/x' }, toolUseId: 'toolu_1' },
        requestedAt: events.call.requestedAt,
        expiresAt: events.call.expiresAt
      }
    ])
    noteClaudeApprovalEvent(SESSION, events.expired)
    const [expired] = listClaudeApprovals(SESSION, REPLY)
    expect(buildClaudeApprovalReplayEvents(expired)[1]).toMatchObject({
      type: 'tool-result',
      approvalStatus: 'expired',
      expiryReason: 'unanswered'
    })
  })

  it('marks a woken turn’s DM "needs you" at once, and takes back only the mark it set (A4)', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser.mockResolvedValue('2026-09-28T12:00:00.000Z')
    const events = helperEvents('ap-1')

    noteClaudeApprovalEvent(SESSION, events.call)
    await settle()
    expect(dm.stampDmNeedsUser).toHaveBeenCalledTimes(1)
    expect(dm.stampDmNeedsUser.mock.calls[0][0]).toBe('dm-1')
    expect(dm.stampDmNeedsUser.mock.calls[0][1]).toBe('This chat is waiting for you to approve Bash.')

    noteClaudeApprovalEvent(SESSION, events.approved)
    await settle()
    expect(dm.clearDmNeedsUserStamp).toHaveBeenCalledWith('dm-1', '2026-09-28T12:00:00.000Z')
  })

  it('takes back nothing when the DM already carried someone else’s mark', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser.mockResolvedValue(null)
    const events = helperEvents('ap-1')
    noteClaudeApprovalEvent(SESSION, events.call)
    await settle()
    noteClaudeApprovalEvent(SESSION, events.approved)
    await settle()
    expect(dm.clearDmNeedsUserStamp).not.toHaveBeenCalled()
  })

  it('does not mark the DM for a run that is not the woken one in the same chat', async () => {
    registerWokenTurn('the-woken-reply')
    noteClaudeApprovalEvent(SESSION, helperEvents('ap-1', 'a-users-own-reply').call)
    await settle()
    expect(dm.stampDmNeedsUser).not.toHaveBeenCalled()
  })

  it('a run that ends while its card waits ends the card and takes back its mark', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser.mockResolvedValue('2026-09-28T12:00:01.000Z')
    noteClaudeApprovalEvent(SESSION, helperEvents('ap-1').call)
    await endClaudeApprovalRunForReply(SESSION, REPLY)
    expect(dm.clearDmNeedsUserStamp).toHaveBeenCalledWith('dm-1', '2026-09-28T12:00:01.000Z')
    expect(listClaudeApprovals(SESSION, REPLY)[0]).toMatchObject({ status: 'expired', expiryReason: 'run_ended' })
    expect(hasWaitingClaudeApproval(SESSION)).toBe(false)
  })

  /**
   * Review finding 3: `stampDmNeedsUser` keeps the FIRST mark, so a second holdup in the same
   * turn stamps nothing. The card that owns the mark must not clear it while another holdup of
   * that turn still waits.
   */
  it('hands the mark to another card of the turn that still waits, and clears it only after the last', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser.mockResolvedValueOnce('2026-09-28T12:00:00.000Z').mockResolvedValue(null)
    const a = helperEvents('ap-a')
    const b = helperEvents('ap-b')
    noteClaudeApprovalEvent(SESSION, a.call)
    await settle()
    noteClaudeApprovalEvent(SESSION, b.call)
    await settle()

    noteClaudeApprovalEvent(SESSION, a.approved)
    await settle()
    expect(dm.clearDmNeedsUserStamp).not.toHaveBeenCalled()
    expect(listClaudeApprovals(SESSION, REPLY).find((r) => r.approvalId === 'ap-b')?.wakeMark).toMatchObject({
      dmId: 'dm-1',
      at: '2026-09-28T12:00:00.000Z'
    })

    noteClaudeApprovalEvent(SESSION, b.approved)
    await settle()
    expect(dm.clearDmNeedsUserStamp).toHaveBeenCalledWith('dm-1', '2026-09-28T12:00:00.000Z')
  })

  it('keeps the mark while a risky-control pause of the same chat still waits', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser.mockResolvedValue('2026-09-28T12:00:00.000Z')
    noteClaudeApprovalEvent(SESSION, helperEvents('ap-1').call)
    await settle()
    dm.listSessionApprovals.mockResolvedValue([{ approvalId: 'apr_x', status: 'pending' }])
    noteClaudeApprovalEvent(SESSION, helperEvents('ap-1').approved)
    await settle()
    expect(dm.listSessionApprovals).toHaveBeenCalledWith(SESSION, 'user-1')
    expect(dm.clearDmNeedsUserStamp).not.toHaveBeenCalled()
  })

  it('a wait that failed is its own ending, not a deny and not an expiry nobody answered (finding 4)', () => {
    const events = helperEvents('ap-1')
    noteClaudeApprovalEvent(SESSION, events.call)
    noteClaudeApprovalEvent(SESSION, { ...events.expired, expiryReason: 'wait_failed' })
    expect(listClaudeApprovals(SESSION, REPLY)[0]).toMatchObject({ status: 'expired', expiryReason: 'wait_failed' })
  })

  /**
   * Re-review: card A's mark was cleared by a human reply, and card B then stamped its own. When
   * A ends, B keeps its own mark (A's old one must not overwrite it), and B's end clears B's.
   */
  it('an heir that already holds its own mark keeps it', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser
      .mockResolvedValueOnce('2026-09-28T12:00:00.000Z')
      .mockResolvedValueOnce('2026-09-28T12:05:00.000Z')
    const a = helperEvents('ap-a')
    const b = helperEvents('ap-b')
    noteClaudeApprovalEvent(SESSION, a.call)
    await settle()
    noteClaudeApprovalEvent(SESSION, b.call)
    await settle()

    noteClaudeApprovalEvent(SESSION, a.approved)
    await settle()
    expect(listClaudeApprovals(SESSION, REPLY).find((r) => r.approvalId === 'ap-b')?.wakeMark?.at).toBe(
      '2026-09-28T12:05:00.000Z'
    )

    noteClaudeApprovalEvent(SESSION, b.approved)
    await settle()
    expect(dm.clearDmNeedsUserStamp).toHaveBeenCalledWith('dm-1', '2026-09-28T12:05:00.000Z')
  })

  it('keeps the mark when the chat’s control pauses cannot be read', async () => {
    registerWokenTurn()
    dm.stampDmNeedsUser.mockResolvedValue('2026-09-28T12:00:00.000Z')
    noteClaudeApprovalEvent(SESSION, helperEvents('ap-1').call)
    await settle()
    dm.listSessionApprovals.mockRejectedValue(new Error('redis down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    noteClaudeApprovalEvent(SESSION, helperEvents('ap-1').approved)
    await settle()
    warn.mockRestore()
    expect(dm.clearDmNeedsUserStamp).not.toHaveBeenCalled()
  })
})

/**
 * BL-496, BL-775: a reply with a Fabric card and a Claude card keeps both. send-routed's finalize
 * writes the joined list into the record it saves (it moved there from the `/api/sse` end).
 */
describe('joinApprovalSummaries', () => {
  it('joins the reply’s Claude cards to the cards it already carries, by approval id', async () => {
    const { joinApprovalSummaries } = await import('../claudeApprovalEvents')
    const fabric = { approvalId: 'apr_fabric1', status: 'pending', source: 'fabric', toolName: 'native_batshit_tool_use' }
    const olderClaude = { approvalId: 'ap-1', status: 'pending', source: 'claude', toolName: 'Bash' }
    const claude = {
      mode: 'all',
      source: 'claude',
      approvals: [
        { approvalId: 'ap-1', status: 'approved', source: 'claude', toolName: 'Bash' },
        { approvalId: 'ap-2', status: 'expired', source: 'claude', toolName: 'Edit' }
      ]
    } as any
    const joined = joinApprovalSummaries({ mode: 'all', source: 'fabric', approvals: [fabric, olderClaude] }, claude)
    expect(joined.approvals.map((entry: any) => [entry.approvalId, entry.status])).toEqual([
      ['apr_fabric1', 'pending'],
      ['ap-1', 'approved'],
      ['ap-2', 'expired']
    ])
    expect(joinApprovalSummaries(undefined, claude)).toBe(claude)
  })
})

