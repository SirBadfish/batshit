import { beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { createPendingApproval, decideApproval } from '$lib/server/services/controlApprovals'
import { GET } from './+server'

/**
 * SA-116 P2 (DL-116-12) — the Execution Viewer's approval history.
 *
 * The route exists because the message's `toolApprovals` summary is CLEARED on a resume, so
 * approved / denied / expired can never be read from it. Session-scoped and owner-checked
 * like the execution-log route beside it.
 */

useRedisTestServer()

const USER = 'user-ev'
const OTHER = 'user-other'
const SESSION = 'session-ev'

async function seedSession(userId = USER) {
  await redis.createSession({
    id: SESSION,
    user_id: userId,
    name: SESSION,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    metadata: {}
  } as any)
}

const call = (userId: string | null) =>
  GET({
    params: { sessionId: SESSION },
    locals: { user: userId ? { id: userId } : null }
  } as any)

beforeEach(async () => {
  await seedSession()
})

describe('GET /api/sessions/[sessionId]/control-approvals', () => {
  it('lists what happened to each approval, newest first', async () => {
    const first = await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      messageId: 'msg_1',
      controlId: 'sys.memory.delete',
      controlTitle: 'Memory Delete',
      riskLevel: 'confirm',
      lane: 'api',
      input: { memoryId: 'mem_1' },
      now: new Date('2026-09-10T10:00:00.000Z')
    })
    const second = await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      messageId: 'msg_2',
      controlId: 'sys.skill.import',
      controlTitle: 'Skill Import',
      riskLevel: 'restricted',
      lane: 'api',
      input: { source: 'https://example.test' },
      now: new Date('2026-09-10T10:01:00.000Z')
    })
    await decideApproval({ userId: USER, approvalId: first.id, approved: true })
    await decideApproval({ userId: USER, approvalId: second.id, approved: false })

    const payload = await (await call(USER)).json()
    expect(payload.approvals.map((row: any) => [row.controlId, row.status, row.messageId])).toEqual([
      ['sys.skill.import', 'denied', 'msg_2'],
      ['sys.memory.delete', 'approved', 'msg_1']
    ])
    // The input the card showed is deliberately not re-served by a history panel.
    expect(payload.approvals[0].inputSummary).toBeUndefined()
  })

  it('refuses a session the caller does not own', async () => {
    await createPendingApproval({
      userId: USER,
      sessionId: SESSION,
      controlId: 'sys.memory.delete',
      controlTitle: 'Memory Delete',
      riskLevel: 'confirm',
      lane: 'api',
      input: {}
    })
    expect((await call(OTHER)).status).toBe(404)
  })

  it('refuses an unauthenticated read', async () => {
    expect((await call(null)).status).toBe(401)
  })
})
