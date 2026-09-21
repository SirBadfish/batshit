import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { DELETE, PUT } from './+server'

/**
 * Deleting a message is the one chat change a second tab cannot hear: nothing streams, and
 * the acting tab drops the bubble by itself. Until 2026-09-18 the chat page re-fetched the
 * open chat about ten times a second, which is the only reason the other tab ever caught up.
 */

const publishedUserEvents: Array<{ userId: string; event: Record<string, any> }> = []
vi.mock('$lib/server/ssePublisher', () => ({
  publishUserEvent: vi.fn(async (userId: string, event: Record<string, any>) => {
    publishedUserEvents.push({ userId, event })
  })
}))

useRedisTestServer()

const USER = 'user-message-route'

async function storedMessage() {
  const sessionId = `message-route-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  const messageId = `${sessionId}_m1`
  await redis.createSession({ id: sessionId, user_id: USER, name: 'chat', agent_id: 'agent-1' } as any)
  await redis.saveMessage({
    id: messageId,
    session_id: sessionId,
    user_id: USER,
    agent_id: 'agent-1',
    role: 'assistant',
    content: 'Hello',
    created_at: new Date().toISOString(),
    metadata: {}
  } as any)
  return { sessionId, messageId }
}

function event(sessionId: string, messageId: string, user: { id: string } | null = { id: USER }) {
  return { params: { sessionId, messageId }, locals: { user } } as any
}

describe('DELETE /api/messages/[sessionId]/[messageId]', () => {
  beforeEach(() => {
    publishedUserEvents.length = 0
  })

  it('tells every tab showing that chat to re-read it', async () => {
    const { sessionId, messageId } = await storedMessage()

    const response = await DELETE(event(sessionId, messageId))

    expect(response.status).toBe(200)
    expect(publishedUserEvents).toEqual([
      {
        userId: USER,
        event: { type: 'session_messages_changed', sessionId, reason: 'message_deleted' }
      }
    ])
  })

  it('says nothing to a signed-out caller', async () => {
    const { sessionId, messageId } = await storedMessage()

    const response = await DELETE(event(sessionId, messageId, null))

    expect(response.status).toBe(401)
    expect(publishedUserEvents).toEqual([])
  })

  it('does not announce an edit, which the acting tab already has', async () => {
    const { sessionId, messageId } = await storedMessage()

    const response = await PUT({
      ...event(sessionId, messageId),
      request: new Request('http://localhost/api/messages', {
        method: 'PUT',
        body: JSON.stringify({ content: 'Edited' })
      })
    } as any)

    expect(response.status).toBe(200)
    expect(publishedUserEvents).toEqual([])
  })
})
