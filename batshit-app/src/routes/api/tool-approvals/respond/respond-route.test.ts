import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  rPush: vi.fn(),
  expire: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: mocks.get,
    execute: async (fn: any) => fn({ rPush: mocks.rPush, expire: mocks.expire })
  }
}))

import { POST } from './+server'
import {
  __resetClaudeApprovalRegistryForTests,
  recordClaudeApprovalCard
} from '$lib/server/services/claudeApprovalRegistry'

/**
 * BL-496 (A7) — the Claude card's answer route knows the card. It used to push any id it was
 * sent into Redis, where nothing would ever read it.
 */

const SESSION = 'session-respond'

function post(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/tool-approvals/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user: { id: 'user-1' } }
  } as any)
}

function waitingCard(approvalId: string, expiresInMs = 600_000) {
  const now = Date.now()
  recordClaudeApprovalCard({
    sessionId: SESSION,
    messageId: 'reply-1',
    approvalId,
    toolName: 'Bash',
    input: { command: 'echo hi' },
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInMs).toISOString()
  })
}

beforeEach(() => {
  __resetClaudeApprovalRegistryForTests()
  mocks.get.mockReset()
  mocks.rPush.mockReset()
  mocks.expire.mockReset()
  mocks.get.mockResolvedValue({ id: SESSION, user_id: 'user-1' })
  mocks.rPush.mockResolvedValue(1)
  mocks.expire.mockResolvedValue(1)
})

describe('POST /api/tool-approvals/respond (BL-496 A7)', () => {
  it('refuses a card the server is not waiting on and writes nothing', async () => {
    const response = await post({ sessionId: SESSION, approvalId: 'never-asked', approved: true })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'approval_not_waiting' })
    expect(mocks.rPush).not.toHaveBeenCalled()
  })

  it('writes the answer for a waiting card once, and refuses a second answer', async () => {
    waitingCard('ap-1')
    const first = await post({ sessionId: SESSION, approvalId: 'ap-1', approved: true, reason: 'User approved' })
    expect(first.status).toBe(200)
    expect(mocks.rPush).toHaveBeenCalledWith(
      `toolApprovalResponse:${SESSION}:ap-1`,
      JSON.stringify({ approved: true, reason: 'User approved' })
    )

    const second = await post({ sessionId: SESSION, approvalId: 'ap-1', approved: false })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ code: 'approval_already_answered' })
    expect(mocks.rPush).toHaveBeenCalledTimes(1)
  })

  it('refuses a card whose time is up', async () => {
    waitingCard('ap-late', -1)
    const response = await post({ sessionId: SESSION, approvalId: 'ap-late', approved: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'approval_expired' })
    expect(mocks.rPush).not.toHaveBeenCalled()
  })

  it('a failed write lets the card be answered again', async () => {
    waitingCard('ap-2')
    mocks.rPush.mockRejectedValueOnce(new Error('connection lost'))
    const failed = await post({ sessionId: SESSION, approvalId: 'ap-2', approved: true })
    expect(failed.status).toBe(500)

    const retried = await post({ sessionId: SESSION, approvalId: 'ap-2', approved: true })
    expect(retried.status).toBe(200)
  })

  it('still refuses another user’s chat before it looks at the card', async () => {
    waitingCard('ap-3')
    mocks.get.mockResolvedValue({ id: SESSION, user_id: 'someone-else' })
    const response = await post({ sessionId: SESSION, approvalId: 'ap-3', approved: true })
    expect(response.status).toBe(403)
    expect(mocks.rPush).not.toHaveBeenCalled()
  })
})
