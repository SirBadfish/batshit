import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { SERVER_REPLAY_FIELDS, withoutServerReplayFields } from './serverReplayFields'

/** SA-137 (D7, R1): a paused reply's replay fields never leave the server through a message list. */
describe('withoutServerReplayFields', () => {
  it('drops both replay fields and keeps everything else', () => {
    const record = { id: 'm', role: 'assistant', metadata: { zipIds: ['z'], whiteboardContextSnapshot: { a: 1 }, liveFileReadSnapshot: { b: 2 }, toolApprovals: { pending: true } } }
    expect(withoutServerReplayFields(record)).toEqual({ id: 'm', role: 'assistant', metadata: { zipIds: ['z'], toolApprovals: { pending: true } } })
    expect(record.metadata.liveFileReadSnapshot).toEqual({ b: 2 })
  })
  it('returns the same object when there is nothing to drop', () => {
    const record = { id: 'm', metadata: { zipIds: [] } }
    expect(withoutServerReplayFields(record)).toBe(record)
    expect(withoutServerReplayFields(null)).toBeNull()
    expect(SERVER_REPLAY_FIELDS).toEqual(['whiteboardContextSnapshot', 'liveFileReadSnapshot'])
  })
})

/**
 * The strip belongs at the doors, never in the shared list readers: server writers (the approval
 * update, a session rename, steer promotion) read records through these lists and write them back
 * whole, and a stripped read would erase a paused reply's replay.
 */
describe('the shared message list readers keep the replay fields', () => {
  it('getMessages, getRecentMessages and getAllMessages return them as stored', async () => {
    const sessionId = 'sa137-list-readers'
    const metadata = { whiteboardContextSnapshot: { dcmLines: ['board'] }, liveFileReadSnapshot: { schema_version: 1, pauseId: 'p' } }
    await redis.createSession({ id: sessionId, user_id: 'u', title: 'SA-137 list readers' } as any)
    await redis.saveMessage({ id: 'msg-paused', session_id: sessionId, user_id: 'u', role: 'assistant', content: 'May I?',
      created_at: '2026-10-21T01:00:00.000Z', metadata } as any)
    for (const rows of [await redis.getMessages(sessionId, 10), await redis.getRecentMessages(sessionId, 10), await redis.getAllMessages(sessionId)]) {
      expect((rows as any[])[0].metadata).toMatchObject(metadata)
    }
  })
})
