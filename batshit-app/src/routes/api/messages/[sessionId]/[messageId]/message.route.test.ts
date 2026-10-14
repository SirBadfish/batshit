import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { DELETE, PUT } from './+server'
import { withZipStateLock } from '$lib/server/services/zipStateLock'
import { __resetDeletedMessagesForTests, wasMessageDeleted } from '$lib/server/services/deletedMessageRegistry'
import {
  __resetStreamAbortRegistryForTests,
  registerSessionTurn,
  registerStreamAbort,
  releaseSessionTurn,
  clearStreamAbort,
  clearSessionTurn
} from '$lib/server/services/streamAbortRegistry'

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

async function storedMessage(role: 'assistant' | 'user' = 'assistant') {
  const sessionId = `message-route-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  const messageId = `${sessionId}_m1`
  await redis.createSession({ id: sessionId, user_id: USER, name: 'chat', agent_id: 'agent-1' } as any)
  await redis.saveMessage({
    id: messageId,
    session_id: sessionId,
    user_id: USER,
    agent_id: 'agent-1',
    role,
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
    __resetStreamAbortRegistryForTests()
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

  it('remembers the deleted id, so a late server save cannot bring it back (BL-776)', async () => {
    __resetDeletedMessagesForTests()
    const { sessionId, messageId } = await storedMessage()
    expect(wasMessageDeleted(sessionId, messageId)).toBe(false)
    expect((await DELETE(event(sessionId, messageId))).status).toBe(200)
    expect(wasMessageDeleted(sessionId, messageId)).toBe(true)
  })

  it('does not remember an id whose delete was refused (BL-776)', async () => {
    __resetDeletedMessagesForTests()
    const { sessionId, messageId } = await storedMessage()
    expect((await DELETE(event(sessionId, messageId, { id: 'someone-else' }))).status).not.toBe(200)
    expect(wasMessageDeleted(sessionId, messageId)).toBe(false)
  })

  it('refuses 409 while a running turn of that chat names the message, and deletes nothing (BL-381)', async () => {
    const { sessionId, messageId } = await storedMessage()
    const registration = registerSessionTurn(sessionId, 'single', messageId)
    if (!registration.ok) throw new Error('registration failed')

    const refused = await DELETE(event(sessionId, messageId))
    expect(refused.status).toBe(409)
    const body = await refused.json()
    expect(body.code).toBe('message_still_running')
    expect(typeof body.error).toBe('string')
    expect(await redis.get(`message:${sessionId}:${messageId}`)).toBeTruthy()
    expect(publishedUserEvents).toEqual([])

    // The lock can go while the request still writes (a Stop's grace, the orphan rule):
    // the refusal follows the REQUEST, not the lock.
    clearSessionTurn(sessionId, messageId)
    expect((await DELETE(event(sessionId, messageId))).status).toBe(409)

    releaseSessionTurn(sessionId, registration.entry.turnId)
    expect((await DELETE(event(sessionId, messageId))).status).toBe(200)
    expect(await redis.get(`message:${sessionId}:${messageId}`)).toBeFalsy()
  })

  it('refuses a reply whose stream runs under another message id of the same request (BL-381)', async () => {
    // A context continuation or a promoted turn streams a new message id under the first
    // request's registration.
    const { sessionId, messageId } = await storedMessage()
    const registration = registerSessionTurn(sessionId, 'single', `${sessionId}_first`)
    if (!registration.ok) throw new Error('registration failed')
    registerStreamAbort(sessionId, messageId, new AbortController())

    expect((await DELETE(event(sessionId, messageId))).status).toBe(409)

    clearStreamAbort(sessionId, messageId)
    expect((await DELETE(event(sessionId, messageId))).status).toBe(200)
    releaseSessionTurn(sessionId, registration.entry.turnId)
  })

  it('refuses 409 when a turn on the message starts after the route checked, before the write (BL-381)', async () => {
    const { sessionId, messageId } = await storedMessage()
    let letGo!: () => void
    const held = withZipStateLock(sessionId, () => new Promise<void>((resolve) => { letGo = resolve }))

    const deleting = DELETE(event(sessionId, messageId))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const registration = registerSessionTurn(sessionId, 'single', messageId)
    if (!registration.ok) throw new Error('registration failed')
    letGo()
    await held

    const response = await deleting
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('message_still_running')
    expect(await redis.get(`message:${sessionId}:${messageId}`)).toBeTruthy()
    expect(publishedUserEvents).toEqual([])
    releaseSessionTurn(sessionId, registration.entry.turnId)
  })

  it('deletes another message of a chat whose reply is running', async () => {
    const { sessionId, messageId } = await storedMessage()
    const registration = registerSessionTurn(sessionId, 'single', `${sessionId}_running`)
    if (!registration.ok) throw new Error('registration failed')

    expect((await DELETE(event(sessionId, messageId))).status).toBe(200)
    releaseSessionTurn(sessionId, registration.entry.turnId)
  })

  it('says nothing to a signed-out caller', async () => {
    const { sessionId, messageId } = await storedMessage()

    const response = await DELETE(event(sessionId, messageId, null))

    expect(response.status).toBe(401)
    expect(publishedUserEvents).toEqual([])
  })

  it('does not announce an edit, which the acting tab already has', async () => {
    const { sessionId, messageId } = await storedMessage('user')

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

  /**
   * BL-775, BL-776: the server owns an agent's reply, so a tab can neither rewrite one nor turn
   * another message into one. No page calls this route today; it is scoped like the save route.
   */
  it('refuses to change a stored assistant reply, and leaves it as it was', async () => {
    const { sessionId, messageId } = await storedMessage('assistant')
    const response = await PUT({
      ...event(sessionId, messageId),
      request: new Request('http://localhost/api/messages', {
        method: 'PUT',
        body: JSON.stringify({ content: 'A shorter copy.' })
      })
    } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('reply_saved_by_server')
    const stored = (await redis.execute((client: any) => client.json.get(`message:${sessionId}:${messageId}`))) as any
    expect(stored.content).toBe('Hello')
  })

  it('refuses an edit that would make a user message an assistant reply', async () => {
    const { sessionId, messageId } = await storedMessage('user')
    const response = await PUT({
      ...event(sessionId, messageId),
      request: new Request('http://localhost/api/messages', {
        method: 'PUT',
        body: JSON.stringify({ role: 'assistant', content: 'Now a reply.' })
      })
    } as any)
    expect(response.status).toBe(403)
    const stored = (await redis.execute((client: any) => client.json.get(`message:${sessionId}:${messageId}`))) as any
    expect(stored.role).toBe('user')
    expect(stored.content).toBe('Hello')
  })

  it('refuses an edit in a chat of another user before it reads the message', async () => {
    const { sessionId, messageId } = await storedMessage('assistant')
    const response = await PUT({
      ...event(sessionId, messageId, { id: 'someone-else' }),
      request: new Request('http://localhost/api/messages', { method: 'PUT', body: JSON.stringify({ content: 'x' }) })
    } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBeUndefined()
  })
})


describe('browser PUT protects exact server steer metadata (BL-1302)', () => {
  async function put(sessionId: string, messageId: string, updates: unknown) {
    return PUT({ ...event(sessionId, messageId), request: new Request('http://localhost/api/messages', {
      method: 'PUT', body: JSON.stringify(updates) }) } as any)
  }
  it('cannot mint markers on an ordinary user record, and preserves unrelated Clip/setting metadata', async () => {
    const { sessionId, messageId } = await storedMessage('user')
    expect((await put(sessionId, messageId, { content: 'Edited', metadata: { tts: false, clipIds: ['clip-user'],
      steerPromoted: { steerIds: ['forged'] }, waitsForApproval: { messageId: 'forged' }, approvalCardExpired: true } })).status).toBe(200)
    const saved = await redis.get(`message:${sessionId}:${messageId}`) as any
    expect(saved.metadata).toEqual({ tts: false, clipIds: ['clip-user'] })
    expect(saved.content).toBe('Edited')
  })
  it('legitimate text/metadata edits and null metadata preserve actual server markers without restoring other user fields', async () => {
    const { sessionId, messageId } = await storedMessage('user')
    const markers = { steerPromoted: { steerIds: ['actual'], disposition: 'unanswered', reason: 'stopped' },
      waitsForApproval: { messageId: 'actual-card' }, approvalCardExpired: false }
    await redis.updateMessage(messageId, sessionId, { metadata: { ...markers, oldSetting: 'old' } }, USER)
    expect((await put(sessionId, messageId, { content: 'Edited', metadata: { steerPromoted: { steerIds: ['forged'] },
      waitsForApproval: null, approvalCardExpired: true, tts: true } })).status).toBe(200)
    let saved = await redis.get(`message:${sessionId}:${messageId}`) as any
    expect(saved.metadata).toEqual({ ...markers, tts: true })
    expect(saved.content).toBe('Edited')
    expect((await put(sessionId, messageId, { metadata: null })).status).toBe(200)
    saved = await redis.get(`message:${sessionId}:${messageId}`) as any
    expect(saved.metadata).toEqual(markers)
  })
  it('failed and mismatched stored reads visibly refuse instead of writing request markers', async () => {
    const { sessionId, messageId } = await storedMessage('user')
    const read = vi.spyOn(redis, 'execute').mockRejectedValueOnce(new Error('message read unavailable'))
    const update = vi.spyOn(redis, 'updateMessage').mockClear()
    expect((await put(sessionId, messageId, { metadata: {} })).status).toBe(500)
    expect(update).not.toHaveBeenCalled()
    read.mockResolvedValueOnce({ role: 'user', user_id: 'another-user' })
    expect((await put(sessionId, messageId, { metadata: {} })).status).toBe(403)
    expect(update).not.toHaveBeenCalled()
    read.mockRestore(); update.mockRestore()
  })
})
