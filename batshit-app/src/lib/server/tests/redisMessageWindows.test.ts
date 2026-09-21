import { describe, expect, it } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * SA-113 F-P3-3 — the two message-window readers, pinned on REAL Redis.
 *
 * `getMessages(id, n)` is `lRange(key, 0, n - 1)`: the FIRST n, oldest first.
 * `getRecentMessages(id, n)` is the negative-index range: the LAST n, still oldest first.
 * `getAllMessages(id)` is the unbounded full transcript, oldest first.
 *
 * This suite is on the curated real-Redis lane on purpose. The bug it guards (F-P2-1) was
 * five callers meaning "recent" and reading the beginning of the chat, and the reason no
 * test caught it is that the in-memory fake returned the LAST n from `getMessages` — so
 * both readers looked at the right end under test and the wrong end in production. A fake
 * that disagrees with the client is worse than no test, and the only way this stays honest
 * is to assert the ordering against the real thing.
 */

useRedisTestServer()

const SESSION = 'session-message-windows'
const USER = 'user-message-windows'

async function seedFiveMessages() {
  await redis.createSession({ id: SESSION, user_id: USER, name: 'Message windows' })
  for (let index = 1; index <= 5; index += 1) {
    await redis.saveMessage({
      id: `msg-${index}`,
      session_id: SESSION,
      user_id: USER,
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `message ${index}`
    } as never)
  }
}

async function seedLongSession(messageCount: number) {
  await redis.createSession({ id: SESSION, user_id: USER, name: 'Long message window' })
  await redis.execute(async (client) => {
    for (let index = 1; index <= messageCount; index += 1) {
      const id = `msg-${index}`
      await client.json.set(`message:${SESSION}:${id}`, '$', {
        id,
        session_id: SESSION,
        user_id: USER,
        role: index % 2 === 1 ? 'user' : 'assistant',
        content: `message ${index}`,
        created_at: new Date(index).toISOString()
      })
      await client.rPush(`messages:${SESSION}`, id)
    }
  })
}

describe('message window readers (F-P3-3)', () => {
  it('getMessages takes the OLDEST two, and getRecentMessages the NEWEST two', async () => {
    await seedFiveMessages()

    const head = await redis.getMessages(SESSION, 2)
    expect(head.map((message) => message.id)).toEqual(['msg-1', 'msg-2'])

    const tail = await redis.getRecentMessages(SESSION, 2)
    // Newest two, but still in conversation order — a turn compiled from these must read
    // forwards, not backwards.
    expect(tail.map((message) => message.id)).toEqual(['msg-4', 'msg-5'])
  })

  it('both return the whole chat, oldest first, when the window is bigger than the chat', async () => {
    await seedFiveMessages()

    const all = ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']
    expect((await redis.getMessages(SESSION, 50)).map((m) => m.id)).toEqual(all)
    expect((await redis.getRecentMessages(SESSION, 50)).map((m) => m.id)).toEqual(all)
    expect((await redis.getAllMessages(SESSION)).map((m) => m.id)).toEqual(all)
  })

  it('the session context window takes the newest messages while the transcript reader takes all', async () => {
    await seedLongSession(1002)

    const currentWindow = await redis.getSessionMessages(SESSION)
    expect(currentWindow).toHaveLength(1000)
    expect(currentWindow[0]?.id).toBe('msg-3')
    expect(currentWindow.at(-1)?.id).toBe('msg-1002')

    const fullTranscript = await redis.getAllSessionMessages(SESSION)
    expect(fullTranscript).toHaveLength(1002)
    expect(fullTranscript[0]?.id).toBe('msg-1')
    expect(fullTranscript.at(-1)?.id).toBe('msg-1002')
  })

  it('both answer with nothing for a session that has no messages', async () => {
    await redis.createSession({ id: `${SESSION}-empty`, user_id: USER, name: 'Empty' })
    expect(await redis.getMessages(`${SESSION}-empty`, 5)).toEqual([])
    expect(await redis.getRecentMessages(`${SESSION}-empty`, 5)).toEqual([])
    expect(await redis.getAllMessages(`${SESSION}-empty`)).toEqual([])
  })
})
