import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { writePostTurnRecord } from '$lib/server/services/postTurnCheckState'
import { GET } from './+server'

/**
 * SA-120 P6 — the read-only route the chat page draws the after-reply chips from: signed-in
 * users only, their own chats only, and every stored record of that chat keyed by message id.
 */

useRedisTestServer()

const USER = 'user-post-turn-route'

async function ownedSession(userId = USER) {
  const sessionId = `post-turn-route-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  await redis.createSession({ id: sessionId, user_id: userId, name: 'after-reply', agent_id: 'agent-1' } as any)
  return sessionId
}

function event(sessionId: string | null, user: { id: string } | null = { id: USER }) {
  const query = sessionId === null ? '' : `?sessionId=${sessionId}`
  return { url: new URL(`http://localhost/api/jev-juice/post-turn${query}`), locals: { user } } as any
}

describe('GET /api/jev-juice/post-turn', () => {
  it('answers with the chat\'s records keyed by message id, and an empty map for a chat with none', async () => {
    const sessionId = await ownedSession()
    expect(await (await GET(event(sessionId))).json()).toEqual({ records: {} })

    const record = {
      messageId: 'msg_1',
      sessionId,
      agentId: 'agent-1',
      at: '2026-09-17T08:00:00.000Z',
      findings: [{ id: 'promised_memory' as const, lane: 'reply_check' as const, source: 'inferred' as const, probability: 0.88 }],
      notes: [],
      toldAgent: false
    }
    await writePostTurnRecord(record)
    const response = await GET(event(sessionId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ records: { msg_1: record } })
  })

  it('refuses a signed-out caller, a missing chat id, an unknown chat, and somebody else\'s chat', async () => {
    const sessionId = await ownedSession()
    expect((await GET(event(sessionId, null))).status).toBe(401)
    expect((await GET(event(null))).status).toBe(400)
    expect((await GET(event('no-such-session'))).status).toBe(404)
    const theirs = await ownedSession('someone-else')
    expect((await GET(event(theirs))).status).toBe(403)
  })
})
