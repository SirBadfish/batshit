import { afterEach, describe, expect, it, vi } from 'vitest'

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import {
  __resetQueuedSendHiddenIdsForTests,
  hideQueuedSendMessage,
  revealQueuedSendMessage
} from '$lib/server/services/queuedSendHiddenIds'

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
    // BL-181: every write issued in one go, in order. node-redis sends commands issued together
    // as one pipeline (so the list keeps this order) instead of one round trip per command.
    const writes: Promise<unknown>[] = []
    for (let index = 1; index <= messageCount; index += 1) {
      const id = `msg-${index}`
      writes.push(
        client.json.set(`message:${SESSION}:${id}`, '$', {
          id,
          session_id: SESSION,
          user_id: USER,
          role: index % 2 === 1 ? 'user' : 'assistant',
          content: `message ${index}`,
          created_at: new Date(index).toISOString()
        }),
        client.rPush(`messages:${SESSION}`, id)
      )
    }
    await Promise.all(writes)
  })
}

// BL-181: the readers below load every record one round trip at a time (2,002 reads), which
// takes seconds on a busy machine; the default 5 s limit timed this test out under load.
const LONG_SESSION_TEST_TIMEOUT_MS = 60_000

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
  }, LONG_SESSION_TEST_TIMEOUT_MS)

  it('both answer with nothing for a session that has no messages', async () => {
    await redis.createSession({ id: `${SESSION}-empty`, user_id: USER, name: 'Empty' })
    expect(await redis.getMessages(`${SESSION}-empty`, 5)).toEqual([])
    expect(await redis.getRecentMessages(`${SESSION}-empty`, 5)).toEqual([])
    expect(await redis.getAllMessages(`${SESSION}-empty`)).toEqual([])
  })
})

/**
 * BL-4 — a saved message whose send waits in the chat's line is not part of the conversation
 * yet, so every list read skips it (`queuedSendHiddenIds.ts`). The readers are POSITIONAL: a
 * window is the first N or the last N list positions, and a hidden id leaves that window shorter
 * rather than pulling a neighbour in, so a window never repeats what the next one returns and
 * never skips a visible message. The list and the record themselves are untouched: the delete
 * sweep and the backup read them raw.
 */
describe('a message waiting in the line (BL-4)', () => {
  afterEach(() => __resetQueuedSendHiddenIdsForTests())

  it('leaves the head window and the tail window shorter, never wider', async () => {
    await seedFiveMessages()
    hideQueuedSendMessage(SESSION, 'msg-2')
    expect((await redis.getMessages(SESSION, 2)).map((m) => m.id)).toEqual(['msg-1'])

    revealQueuedSendMessage(SESSION, 'msg-2')
    hideQueuedSendMessage(SESSION, 'msg-4')
    expect((await redis.getRecentMessages(SESSION, 2)).map((m) => m.id)).toEqual(['msg-5'])
  })

  it('never makes two windows skip or repeat a visible message', async () => {
    await seedFiveMessages()
    hideQueuedSendMessage(SESSION, 'msg-3')

    const head = (await redis.getMessages(SESSION, 3)).map((m) => m.id)
    const tail = (await redis.getRecentMessages(SESSION, 2)).map((m) => m.id)
    expect(head).toEqual(['msg-1', 'msg-2'])
    expect(tail).toEqual(['msg-4', 'msg-5'])
    // Positions 1-3 and 4-5 cover the chat once: every visible message exactly once.
    expect([...head, ...tail]).toEqual(['msg-1', 'msg-2', 'msg-4', 'msg-5'])
  })

  it('leaves it out of the full transcript and the session window too, in place once revealed', async () => {
    await seedFiveMessages()
    hideQueuedSendMessage(SESSION, 'msg-3')
    const visible = ['msg-1', 'msg-2', 'msg-4', 'msg-5']
    expect((await redis.getAllMessages(SESSION)).map((m) => m.id)).toEqual(visible)
    expect((await redis.getSessionMessages(SESSION)).map((m) => m.id)).toEqual(visible)
    expect((await redis.getAllSessionMessages(SESSION)).map((m) => m.id)).toEqual(visible)

    // Raw, it is all still there: the delete sweep and the backup read the list and the record.
    const raw = await redis.execute(async (client) => ({
      ids: await client.lRange(`messages:${SESSION}`, 0, -1),
      record: await client.json.get(`message:${SESSION}:msg-3`)
    }))
    expect(raw.ids).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'])
    expect((raw.record as { id?: string } | null)?.id).toBe('msg-3')

    revealQueuedSendMessage(SESSION, 'msg-3')
    expect((await redis.getAllMessages(SESSION)).map((m) => m.id)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
      'msg-5'
    ])
  })

  it('moves a waiting message to the end of the chat in one step, dated now', async () => {
    await seedFiveMessages()
    const before = await redis.getAllMessages(SESSION)
    const newestBefore = Date.parse(String(before.at(-1)?.created_at))

    const moved = await redis.moveMessageToEnd(SESSION, 'msg-2')
    expect(moved?.id).toBe('msg-2')
    expect(moved?.content).toBe('message 2')
    const after = await redis.getAllMessages(SESSION)
    expect(after.map((m) => m.id)).toEqual(['msg-1', 'msg-3', 'msg-4', 'msg-5', 'msg-2'])
    // Dated when it was moved, so a reader that sorts by time agrees with the list.
    expect(Date.parse(String(after.at(-1)?.created_at))).toBeGreaterThanOrEqual(newestBefore)
    expect(after.at(-1)?.created_at).toBe(moved?.created_at)
    // Still one copy: moved, never written twice.
    const ids = await redis.execute((client) => client.lRange(`messages:${SESSION}`, 0, -1))
    expect(ids.filter((id: string) => id === 'msg-2')).toHaveLength(1)
  })

  it('dates a resent message with the time its tab sent it, when the caller gives one', async () => {
    await seedFiveMessages()
    const sentAt = '2026-09-22T19:00:00.000Z'

    const moved = await redis.moveMessageToEnd(SESSION, 'msg-2', { createdAt: sentAt })
    expect(moved?.created_at).toBe(sentAt)
    const after = await redis.getAllMessages(SESSION)
    expect(after.map((m) => m.id)).toEqual(['msg-1', 'msg-3', 'msg-4', 'msg-5', 'msg-2'])
    expect(after.at(-1)?.created_at).toBe(sentAt)
  })

  it('never fails a move whose message a delete takes in the same moment (BL-195)', async () => {
    await seedFiveMessages()

    // Both lanes: the move is one step, so it lands wholly before or wholly after the delete.
    const [moved, deleted] = await Promise.allSettled([
      redis.moveMessageToEnd(SESSION, 'msg-3'),
      redis.deleteMessage('msg-3', SESSION, USER)
    ])

    expect(moved.status).toBe('fulfilled')
    expect(deleted.status).toBe('fulfilled')
    const ids = await redis.execute((client) => client.lRange(`messages:${SESSION}`, 0, -1))
    expect(ids).toEqual(['msg-1', 'msg-2', 'msg-4', 'msg-5'])
    expect(await redis.json.get(`message:${SESSION}:msg-3`)).toBeNull()
  })

  it('moves nothing for a message or a chat that is gone', async () => {
    await seedFiveMessages()
    expect(await redis.moveMessageToEnd(SESSION, 'msg-missing')).toBeNull()
    expect(await redis.moveMessageToEnd(`${SESSION}-gone`, 'msg-2')).toBeNull()
    expect((await redis.getAllMessages(SESSION)).map((m) => m.id)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
      'msg-5'
    ])
  })
})

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

/**
 * Run `concurrent` inside the NEXT `redis.execute` call, right after the first command naming
 * `key` answers and before that call sends its next command: another request's write landing
 * in exactly that gap, every time. A call that reads and writes the key in ONE atomic command
 * only ever sees `concurrent` after the whole of it.
 */
function landInTheGapAfter(key: string, concurrent: () => Promise<unknown>) {
  const execute = redis.execute.bind(redis)
  const gap = { fired: false }
  // The proxy's own target is an empty object, because the client's `json` is a read-only
  // property a proxy of the client itself may not replace.
  const wrap = <T extends object>(target: T): T =>
    new Proxy(Object.create(target) as T, {
      get(_shadow, property) {
        const value = Reflect.get(target, property, target)
        if (property === 'json') return wrap(value)
        if (typeof value !== 'function') return value
        // `multi()` builds its chain synchronously; the chain's commands go out together.
        if (property === 'multi') return value.bind(target)
        return async (...args: unknown[]) => {
          const reply = await value.apply(target, args)
          if (!gap.fired && JSON.stringify(args).includes(key)) {
            gap.fired = true
            await concurrent()
          }
          return reply
        }
      }
    })
  vi.spyOn(redis, 'execute').mockImplementationOnce((operation: any) =>
    execute((client: any) => operation(wrap(client)))
  )
  return gap
}

/**
 * BL-195 — the move is one step on the server, so nothing can land between its read and its
 * write. It was a read, then a MULTI: a message deleted in that gap left its id on the list
 * with no record behind it, and a save that read the message before the move wrote the old
 * `created_at` back after it, so the chat's order and its dates disagreed again.
 */
describe.runIf(REAL_REDIS_LANE)('moving a waiting message while another request writes it (BL-195)', () => {
  const SENT_AT = '2026-09-25T12:00:00.000Z'

  afterEach(() => vi.restoreAllMocks())

  async function rawChat() {
    return redis.execute(async (client) => {
      const ids = await client.lRange(`messages:${SESSION}`, 0, -1)
      const records = await Promise.all(
        ids.map((id: string) => client.exists(`message:${SESSION}:${id}`))
      )
      return { ids, idsWithoutARecord: ids.filter((_: string, index: number) => !records[index]) }
    })
  }

  it('a message deleted right after the move reads it leaves no id behind', async () => {
    await seedFiveMessages()
    const gap = landInTheGapAfter(`message:${SESSION}:msg-3`, () =>
      redis.deleteMessage('msg-3', SESSION, USER)
    )

    const moved = await redis.moveMessageToEnd(SESSION, 'msg-3').catch((error: Error) => error)

    expect(gap.fired).toBe(true)
    const chat = await rawChat()
    expect(chat.idsWithoutARecord).toEqual([])
    expect(chat.ids).toEqual(['msg-1', 'msg-2', 'msg-4', 'msg-5'])
    // It moved, then the delete took it: the move answers the message it moved.
    expect(moved).not.toBeInstanceOf(Error)
    expect((moved as { id?: string } | null)?.id).toBe('msg-3')
  })

  it('a save that read the message before the move cannot put its old date back', async () => {
    await seedFiveMessages()
    const savedAt = (await redis.getAllMessages(SESSION)).find((m) => m.id === 'msg-3')?.created_at
    expect(savedAt).toBeTruthy()
    const gap = landInTheGapAfter(`message:${SESSION}:msg-3`, () =>
      redis.moveMessageToEnd(SESSION, 'msg-3', { createdAt: SENT_AT })
    )

    // A tab saving its own copy of the message: the save reads the stored record, the move
    // lands, then the save writes.
    await redis.saveMessage({
      id: 'msg-3',
      session_id: SESSION,
      user_id: USER,
      role: 'user',
      content: 'message 3, saved again'
    } as never)

    expect(gap.fired).toBe(true)
    const after = await redis.getAllMessages(SESSION)
    expect(after.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-4', 'msg-5', 'msg-3'])
    expect(after.at(-1)?.created_at).toBe(SENT_AT)
    expect(after.at(-1)?.created_at).not.toBe(savedAt)
    // The save itself still landed: only the date is the move's.
    expect(after.at(-1)?.content).toBe('message 3, saved again')
  })

  it('a save still keeps the first date of a message nobody moved', async () => {
    await seedFiveMessages()
    const savedAt = (await redis.getAllMessages(SESSION)).find((m) => m.id === 'msg-3')?.created_at

    await redis.saveMessage({
      id: 'msg-3',
      session_id: SESSION,
      user_id: USER,
      role: 'user',
      content: 'message 3, saved again',
      created_at: SENT_AT
    } as never)

    const record = (await redis.getAllMessages(SESSION)).find((m) => m.id === 'msg-3')
    expect(record?.created_at).toBe(savedAt)
    expect(record?.content).toBe('message 3, saved again')
  })
})
