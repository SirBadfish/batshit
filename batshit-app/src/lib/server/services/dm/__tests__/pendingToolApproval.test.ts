import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { hasPendingToolApproval } from '../pendingToolApproval'

/**
 * SA-113 — "is this chat's last turn sitting on a tool approval?"
 *
 * Two callers act on the answer: `sys.dm.agents` reports `waiting_approval` instead of
 * `running`, and F-SEC-1b stamps a woken DM "needs you" when its turn ENDED that way. Both
 * are read by other agents deciding whether to hand this one more work, so a false yes is
 * not cosmetic — it takes an idle agent out of the roster.
 *
 * The shape is the reason this file exists. `metadata.toolApprovals` is a
 * `ToolApprovalSummary` object — `{ mode, approvals[], source }` — and reading it as a bare
 * array fell through to `Boolean(approvals)`, which is true for every summary a message has
 * ever carried. A turn that ended on an approval the user let lapse then reported
 * `waiting_approval` for as long as it stayed the newest assistant message.
 */

useRedisTestServer()

const SESSION = 'sess-pending-approval'
const USER = 'user-pending-approval'

let sequence = 0

async function save(role: 'user' | 'assistant', metadata: Record<string, any> = {}) {
  sequence += 1
  await redis.saveMessage({
    id: `msg-${String(sequence).padStart(4, '0')}`,
    session_id: SESSION,
    user_id: USER,
    agent_id: 'agent-cooper',
    role,
    status: 'complete',
    content: `${role} ${sequence}`,
    created_at: new Date(Date.parse('2026-09-08T09:00:00.000Z') + sequence * 1000).toISOString(),
    metadata
  } as any)
}

beforeEach(async () => {
  sequence = 0
  await redis.del(`messages:${SESSION}`)
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    agent_id: 'agent-cooper',
    title: 'Pending approval'
  } as any)
})

describe('hasPendingToolApproval', () => {
  it('is true while a summary still holds a pending entry', async () => {
    await save('user')
    await save('assistant', {
      toolApprovals: {
        mode: 'all',
        source: 'vercel',
        approvals: [{ approvalId: 'a1', status: 'pending' }]
      }
    })

    expect(await hasPendingToolApproval(SESSION)).toBe(true)
  })

  it('is FALSE once every entry in the summary is resolved', async () => {
    await save('user')
    // This is exactly what send-routed writes back on expiry:
    // `toolApprovals: { ...summary, approvals: nextApprovals }`.
    await save('assistant', {
      toolApprovals: {
        mode: 'all',
        source: 'vercel',
        approvals: [
          { approvalId: 'a1', status: 'expired' },
          { approvalId: 'a2', status: 'approved' },
          { approvalId: 'a3', status: 'denied' }
        ]
      }
    })

    expect(await hasPendingToolApproval(SESSION)).toBe(false)
  })

  it('is false for a message with no approvals at all', async () => {
    await save('user')
    await save('assistant')

    expect(await hasPendingToolApproval(SESSION)).toBe(false)
  })

  it('still reads the older bare-array shape', async () => {
    await save('user')
    await save('assistant', { toolApprovals: [{ approvalId: 'a1', status: 'pending' }] })

    expect(await hasPendingToolApproval(SESSION)).toBe(true)
  })

  it('reads the newest assistant message, not an older one', async () => {
    await save('user')
    await save('assistant', {
      toolApprovals: { mode: 'all', approvals: [{ approvalId: 'a1', status: 'pending' }] }
    })
    await save('assistant')

    expect(await hasPendingToolApproval(SESSION)).toBe(false)
  })
})
