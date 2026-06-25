import { describe, expect, it } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

useRedisTestServer()

describe('message deletion persistence', () => {
  it('removes the message from the session list and clears stale session message cache', async () => {
    const sessionId = 'session-delete-test'
    const userId = 'josh'
    const messageId = 'msg-delete-me'
    const keepMessageId = 'msg-keep-me'

    await redis.createSession({
      id: sessionId,
      user_id: userId,
      name: 'Delete Test Session'
    })

    await redis.saveMessage({
      id: messageId,
      session_id: sessionId,
      user_id: userId,
      role: 'user',
      content: 'delete me'
    })

    await redis.saveMessage({
      id: keepMessageId,
      session_id: sessionId,
      user_id: userId,
      role: 'assistant',
      content: 'keep me'
    })

    await redis.set(`session:${sessionId}:messages`, ['stale-cache'])

    await redis.deleteMessage(messageId, sessionId, userId)

    expect(await redis.exists(`message:${sessionId}:${messageId}`)).toBe(false)
    expect(await redis.exists(`session:${sessionId}:messages`)).toBe(false)

    const remainingMessages = await redis.getMessages(sessionId, 10)
    expect(remainingMessages.map((message) => message.id)).toEqual([keepMessageId])
  })
})
