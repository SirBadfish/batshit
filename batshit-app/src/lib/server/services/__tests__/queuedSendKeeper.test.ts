import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const publishUserEvent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent }))

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  __resetStreamAbortRegistryForTests,
  getActiveSessionTurn,
  queueSessionTurn,
  registerSessionTurn,
  releaseSessionTurn
} from '../streamAbortRegistry'
import { isQueuedSendMessageHidden } from '../queuedSendHiddenIds'
import { keepQueuedSendAtEnd } from '../queuedSendKeeper'

/**
 * BL-4 — a queued send that will not run keeps its words: moved to the end of the chat,
 * unanswered, shown again, every tab told, and the chat passed on. Never deleted.
 */
useRedisTestServer()

const SESSION = 'chat-kept'
const USER = 'user-kept'

async function seed() {
  await redis.createSession({ id: SESSION, user_id: USER, name: 'Kept' })
  for (const [id, role, content] of [
    ['a', 'user', 'FIRST'],
    ['b', 'user', 'SECOND'],
    ['a-reply', 'assistant', 'FIRST, stopped']
  ] as const) {
    await redis.saveMessage({ id, session_id: SESSION, user_id: USER, role, content } as never)
  }
}

async function keptEntry(userMessageId = 'b') {
  const holder = registerSessionTurn(SESSION, 'single', 'a-reply')
  if (!holder.ok) throw new Error('expected the holder to register')
  const queued = queueSessionTurn(SESSION, {
    kind: 'single',
    messageId: `${userMessageId}-reply`,
    userMessageId,
    keep: 'overflow'
  })
  releaseSessionTurn(SESSION, holder.entry.turnId)
  const outcome = await queued.outcome
  if (outcome.kind !== 'keep') throw new Error('expected keep')
  return outcome.entry
}

describe('keepQueuedSendAtEnd', () => {
  beforeEach(() => publishUserEvent.mockClear())
  afterEach(() => __resetStreamAbortRegistryForTests())

  it('moves the message after the reply it waited for, shows it, tells the tabs, and lets go', async () => {
    await seed()
    const entry = await keptEntry()
    expect(isQueuedSendMessageHidden(SESSION, 'b')).toBe(true)
    const forwardSessionEvent = vi.fn(async () => {})

    await keepQueuedSendAtEnd({ sessionId: SESSION, userId: USER, userMessageId: 'b', entry, forwardSessionEvent })

    expect((await redis.getAllMessages(SESSION)).map((m) => m.id)).toEqual(['a', 'a-reply', 'b'])
    expect(isQueuedSendMessageHidden(SESSION, 'b')).toBe(false)
    expect(forwardSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_message', sessionId: SESSION, message: expect.objectContaining({ id: 'b', content: 'SECOND' }) })
    )
    expect(publishUserEvent).toHaveBeenCalledWith(USER, {
      type: 'session_messages_changed',
      sessionId: SESSION,
      reason: 'queued_send_kept'
    })
    expect(getActiveSessionTurn(SESSION)).toBeNull()
  })

  it('never deletes the words, and still lets go when the message is already gone', async () => {
    await seed()
    const entry = await keptEntry('missing')
    const forwardSessionEvent = vi.fn(async () => {})

    await keepQueuedSendAtEnd({ sessionId: SESSION, userId: USER, userMessageId: 'missing', entry, forwardSessionEvent })

    expect((await redis.getAllMessages(SESSION)).map((m) => m.id)).toEqual(['a', 'b', 'a-reply'])
    expect(forwardSessionEvent).not.toHaveBeenCalled()
    expect(getActiveSessionTurn(SESSION)).toBeNull()
  })

  it('tells the tabs only after the send’s "Queued" forward has reached them (second review)', async () => {
    await seed()
    const entry = await keptEntry()
    let noticeDone!: () => void
    const after = new Promise<void>((resolve) => {
      noticeDone = resolve
    })
    const forwardSessionEvent = vi.fn(async () => {})

    const keeping = keepQueuedSendAtEnd({
      sessionId: SESSION,
      userId: USER,
      userMessageId: 'b',
      entry,
      forwardSessionEvent,
      after
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(forwardSessionEvent).not.toHaveBeenCalled()
    expect(getActiveSessionTurn(SESSION)).toBe(entry)

    noticeDone()
    await keeping
    expect(forwardSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_message' }))
    expect(getActiveSessionTurn(SESSION)).toBeNull()
  })

  it('shows the message again and lets go even when the move fails', async () => {
    await seed()
    const entry = await keptEntry()
    const move = vi.spyOn(redis, 'moveMessageToEnd').mockRejectedValueOnce(new Error('redis down'))

    await keepQueuedSendAtEnd({
      sessionId: SESSION,
      userId: USER,
      userMessageId: 'b',
      entry,
      forwardSessionEvent: vi.fn(async () => {})
    })

    expect(move).toHaveBeenCalled()
    expect(isQueuedSendMessageHidden(SESSION, 'b')).toBe(false)
    expect(getActiveSessionTurn(SESSION)).toBeNull()
    move.mockRestore()
  })
})
