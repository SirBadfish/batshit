import { afterEach, describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import {
  __resetStreamAbortRegistryForTests,
  beginSessionDelete
} from '$lib/server/services/streamAbortRegistry'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { POST } from './+server'

/**
 * Bug sweep #20 (2026-09-18): this route handed any `sessionId` to `generateMessageId`, whose
 * `INCR message_counter:<id>` creates the key for any string. A send into a deleted chat put
 * the counter back after the delete had swept it (nothing sweeps it again), and a caller could
 * bump another user's counter. The route now answers only for the caller's own chat, and not
 * while that chat is being deleted, which is when the message save refuses it too.
 */

useRedisTestServer()

const USER = 'user-generate-id'

async function chatOf(userId: string) {
  const sessionId = `generate-id-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  await redis.createSession({ id: sessionId, user_id: userId, name: 'ids' } as any)
  return sessionId
}

async function generateId(sessionId: unknown, user: { id: string } | null = { id: USER }) {
  const response = await POST({
    request: new Request('http://localhost/api/messages/generate-id', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    }),
    locals: { user }
  } as any)
  return { status: response.status, payload: await response.json() }
}

describe('POST /api/messages/generate-id', () => {
  afterEach(() => {
    __resetStreamAbortRegistryForTests()
  })

  it('gives the caller’s own chat the next id from its counter', async () => {
    const sessionId = await chatOf(USER)

    const first = await generateId(sessionId)
    expect(first.status).toBe(200)
    expect(first.payload.id).toMatch(/^msg_\d{8}-\d{6}_0001$/)
    expect((await generateId(sessionId)).payload.id).toMatch(/^msg_\d{8}-\d{6}_0002$/)
  })

  it('refuses a chat that does not exist, and creates no counter for it', async () => {
    expect(await generateId('no-such-chat')).toEqual({
      status: 404,
      payload: { error: 'Session not found' }
    })
    expect(await redis.exists('message_counter:no-such-chat')).toBe(false)
  })

  it('refuses somebody else’s chat, and leaves its counter alone', async () => {
    const theirs = await chatOf('someone-else')

    expect(await generateId(theirs)).toEqual({ status: 403, payload: { error: 'Forbidden' } })
    expect(await redis.exists(`message_counter:${theirs}`)).toBe(false)
  })

  it('refuses a chat that is being deleted, as the message save does', async () => {
    const sessionId = await chatOf(USER)
    beginSessionDelete(sessionId)

    expect(await generateId(sessionId)).toEqual({
      status: 404,
      payload: { error: 'Session not found' }
    })
    expect(await redis.exists(`message_counter:${sessionId}`)).toBe(false)
  })

  it('refuses a signed-out caller and a request without a chat id', async () => {
    expect((await generateId('no-such-chat', null)).status).toBe(401)
    expect((await generateId(undefined)).status).toBe(400)
    expect(await redis.exists('message_counter:no-such-chat')).toBe(false)
  })
})
