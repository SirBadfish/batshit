import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { answerApprovalsOnce } from '../approvalAnswerRecord'
import { ANSWERED_APPROVAL_IDS_KEY } from '../toolApprovalState'

/**
 * An approval click is answered ONCE (bug sweep, 2026-09-18).
 *
 * Read from the code on 2026-09-18: on the API lane a Bash card's stored entry stayed `pending`
 * until its resumed run SUCCEEDED, and nothing recorded that a click had used it. A resume that
 * failed after the approved command ran (the next model call failed, or Stop mid-command)
 * brought the buttons back, and a second Approve rebuilt the same continuation: the AI SDK runs
 * an approved call again unless the last tool message already holds its result. send-routed now
 * calls `answerApprovalsOnce` under the click's lock, before the run starts.
 *
 * The saves at the end are about `redis.saveMessage`, whose metadata merge only the REAL client
 * has (the default lane's fake replaces the record), so they run on the real-Redis lane only;
 * this file is on CI's real-Redis list.
 */

useRedisTestServer()

const USER = 'user-answer-once'
const SESSION = 'session-answer-once'
const CARD = 'msg_card'
const realRedis = process.env.VITEST_USE_REAL_REDIS === 'true'

const pendingBash = (approvalId: string) => ({
  approvalId,
  status: 'pending',
  requestedAt: '2026-09-18T17:59:00.000Z',
  toolName: 'native_bash_execute',
  input: { command: 'echo once >> /tmp/answer-once.txt' },
  source: 'vercel'
})

async function seedCard(extraMetadata: Record<string, any> = {}) {
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    name: SESSION,
    created_at: new Date().toISOString(),
    last_modified_at: new Date().toISOString(),
    metadata: {}
  } as any)
  await redis.saveMessage({
    id: CARD,
    session_id: SESSION,
    user_id: USER,
    agent_id: 'agent-1',
    role: 'assistant',
    content: 'I will run it once you approve.',
    metadata: {
      toolApprovals: { mode: 'all', source: 'vercel', approvals: [pendingBash('aitxt-1')] },
      zipIds: ['zip_a'],
      ...extraMetadata
    }
  } as any)
}

async function storedCard(): Promise<any> {
  return redis.execute(async (client) => client.json.get(`message:${SESSION}:${CARD}`))
}

const now = () => new Date('2026-09-18T18:00:00.000Z')

describe('answerApprovalsOnce', () => {
  it('records the first click on the card before anything runs, and keeps the rest of the message', async () => {
    await seedCard()

    const outcome = await answerApprovalsOnce({
      userId: USER,
      sessionId: SESSION,
      messageId: CARD,
      responses: [{ approvalId: 'aitxt-1', approved: true }],
      now
    })

    expect(outcome).toEqual({ ok: true, recorded: true })
    const stored = await storedCard()
    expect(stored.metadata[ANSWERED_APPROVAL_IDS_KEY]).toEqual(['aitxt-1'])
    expect(stored.metadata.zipIds).toEqual(['zip_a'])
    expect(stored.metadata.toolApprovals.approvals[0]).toMatchObject({
      approvalId: 'aitxt-1',
      status: 'approved',
      submitted: true,
      decidedAt: '2026-09-18T18:00:00.000Z'
    })
    expect(stored.content).toBe('I will run it once you approve.')
  })

  it('refuses a second click on the same approval and writes nothing', async () => {
    await seedCard()
    await answerApprovalsOnce({
      userId: USER,
      sessionId: SESSION,
      messageId: CARD,
      responses: [{ approvalId: 'aitxt-1', approved: true }],
      now
    })
    const before = JSON.stringify(await storedCard())

    const second = await answerApprovalsOnce({
      userId: USER,
      sessionId: SESSION,
      messageId: CARD,
      responses: [{ approvalId: 'aitxt-1', approved: true }],
      now: () => new Date('2026-09-18T18:05:00.000Z')
    })

    expect(second).toEqual({ ok: false, reason: 'already_answered', approvalIds: ['aitxt-1'] })
    expect(JSON.stringify(await storedCard())).toBe(before)
  })

  it('refuses a Deny after an Approve too: an answered approval takes no second answer', async () => {
    await seedCard()
    await answerApprovalsOnce({
      userId: USER,
      sessionId: SESSION,
      messageId: CARD,
      responses: [{ approvalId: 'aitxt-1', approved: true }],
      now
    })

    const deny = await answerApprovalsOnce({
      userId: USER,
      sessionId: SESSION,
      messageId: CARD,
      responses: [{ approvalId: 'aitxt-1', approved: false }],
      now
    })

    expect(deny).toMatchObject({ ok: false, reason: 'already_answered' })
    expect((await storedCard()).metadata.toolApprovals.approvals[0].status).toBe('approved')
  })

  it('records nothing when there is no card message or no answer', async () => {
    await seedCard()
    expect(
      await answerApprovalsOnce({
        userId: USER,
        sessionId: SESSION,
        messageId: 'msg_not_there',
        responses: [{ approvalId: 'aitxt-1', approved: true }]
      })
    ).toEqual({ ok: true, recorded: false })
    expect(
      await answerApprovalsOnce({ userId: USER, sessionId: SESSION, messageId: CARD, responses: [] })
    ).toEqual({ ok: true, recorded: false })
    expect((await storedCard()).metadata[ANSWERED_APPROVAL_IDS_KEY]).toBeUndefined()
  })

  it('fails closed when the record cannot be written', async () => {
    await seedCard()

    // Another user's click: the real `updateMessage` refuses to write into a chat it does not own.
    const outcome = await answerApprovalsOnce({
      userId: 'someone-else',
      sessionId: SESSION,
      messageId: CARD,
      responses: [{ approvalId: 'aitxt-1', approved: true }]
    })

    expect(outcome).toMatchObject({ ok: false, reason: 'record_failed' })
    expect((await storedCard()).metadata[ANSWERED_APPROVAL_IDS_KEY]).toBeUndefined()
  })

  describe.runIf(realRedis)('a tab saving its older copy afterwards (real Redis)', () => {
    it('cannot put the card back to pending or drop the record', async () => {
      await seedCard()
      await answerApprovalsOnce({
        userId: USER,
        sessionId: SESSION,
        messageId: CARD,
        responses: [{ approvalId: 'aitxt-1', approved: true }],
        now
      })

      // A second tab loaded the card before the click and saves it at the reply's end or error.
      await redis.saveMessage({
        id: CARD,
        session_id: SESSION,
        user_id: USER,
        agent_id: 'agent-1',
        role: 'assistant',
        content: 'I will run it once you approve.',
        status: 'error',
        metadata: {
          toolApprovals: { mode: 'all', source: 'vercel', approvals: [pendingBash('aitxt-1')] },
          zipIds: ['zip_a']
        }
      } as any)

      const stored = await storedCard()
      expect(stored.metadata[ANSWERED_APPROVAL_IDS_KEY]).toEqual(['aitxt-1'])
      expect(stored.metadata.toolApprovals.approvals[0]).toMatchObject({ status: 'approved', submitted: true })
      expect(
        await answerApprovalsOnce({
          userId: USER,
          sessionId: SESSION,
          messageId: CARD,
          responses: [{ approvalId: 'aitxt-1', approved: true }]
        })
      ).toMatchObject({ ok: false, reason: 'already_answered' })
    })

    it('keeps the union when a tab saves a shorter list than the server has', async () => {
      await seedCard({ [ANSWERED_APPROVAL_IDS_KEY]: ['aitxt-0'] })
      await answerApprovalsOnce({
        userId: USER,
        sessionId: SESSION,
        messageId: CARD,
        responses: [{ approvalId: 'aitxt-1', approved: true }],
        now
      })

      await redis.saveMessage({
        id: CARD,
        session_id: SESSION,
        user_id: USER,
        role: 'assistant',
        content: 'I will run it once you approve.',
        metadata: { [ANSWERED_APPROVAL_IDS_KEY]: ['aitxt-0'] }
      } as any)

      expect((await storedCard()).metadata[ANSWERED_APPROVAL_IDS_KEY]).toEqual(['aitxt-0', 'aitxt-1'])
    })
  })
})
