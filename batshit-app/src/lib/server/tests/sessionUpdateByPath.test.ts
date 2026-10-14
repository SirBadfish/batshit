import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-734: `redis.updateSession` writes only the top-level fields its caller passed, each by path,
 * in one step inside Redis. It used to read the whole chat record and write the whole record
 * back in a second round trip, for every caller (`saveMessage`'s `agent_id` sync and
 * `touchSession` on every message save, `archiveSession`, ...), which erased a Compact event, a
 * graduation mark, a group, or any other block written in between.
 *
 * Real Redis 8 under `npm run test:redis` (a Lua script there); the default lane's fake twin
 * under plain `npm test`. The gap tests need the real client and run on the real lane only.
 */

useRedisTestServer()

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'zcupd_user'
const SESSION = 'zcupd_session'
const KEY = `session:${SESSION}`
const OLD_STAMP = '2026-09-27T09:00:00.000Z'

const compactEvent = {
  id: 'zcupd_evt',
  createdAt: '2026-09-27T12:00:00.000Z',
  sourceMessageIds: ['u1', 'a1'],
  summary: 'Written by a Compact while the update ran.'
}

async function seed(record: Record<string, unknown> = {}) {
  await redis.json.set(KEY, '$', {
    id: SESSION,
    user_id: USER,
    name: 'Shed',
    created_at: OLD_STAMP,
    last_modified_at: OLD_STAMP,
    archived: false,
    locked: false,
    agent_id: 'zcupd_agent_old',
    metadata: { origin: { kind: 'zcupd_origin' } },
    ...record
  } as never)
}

async function stored() {
  return (await redis.getSession(SESSION)) as any
}

afterEach(async () => {
  vi.restoreAllMocks()
  await redis.del(KEY)
  await redis.del(`messages:${SESSION}`)
  for (const id of ['zcupd_msg_1']) await redis.del(`message:${SESSION}:${id}`)
})

describe('updateSession writes only the fields it was given (BL-734)', () => {
  it('writes the named fields and the stamp; every other field and metadata block stays', async () => {
    await seed({ metadata: { origin: { kind: 'zcupd_origin' }, contextCompaction: { version: 1, events: [compactEvent] } } })

    await redis.updateSession(SESSION, { name: 'Barn', locked: true })

    const record = await stored()
    expect(record).toMatchObject({
      id: SESSION,
      user_id: USER,
      name: 'Barn',
      locked: true,
      archived: false,
      agent_id: 'zcupd_agent_old',
      created_at: OLD_STAMP,
      metadata: { origin: { kind: 'zcupd_origin' }, contextCompaction: { version: 1, events: [compactEvent] } }
    })
    expect(record.last_modified_at).not.toBe(OLD_STAMP)
  })

  it('stamps last_modified_at itself, over a value the caller passed, and with no fields at all', async () => {
    await seed()
    await redis.updateSession(SESSION, { last_modified_at: '2000-01-01T00:00:00.000Z' })
    const first = (await stored()).last_modified_at
    expect(first).not.toBe('2000-01-01T00:00:00.000Z')
    expect(first).not.toBe(OLD_STAMP)

    await seed()
    await redis.updateSession(SESSION, {})
    expect((await stored()).last_modified_at).not.toBe(OLD_STAMP)
  })

  it('a caller that passes metadata replaces that one block, and nothing else', async () => {
    await seed({ name: 'Kept', metadata: { origin: { kind: 'zcupd_origin' }, group_chat: { group_id: 'g1' } } })

    await redis.updateSession(SESSION, { metadata: { memoryGraduation: { version: 1 } } })

    const record = await stored()
    expect(record.metadata).toEqual({ memoryGraduation: { version: 1 } })
    expect(record.name).toBe('Kept')
    expect(record.agent_id).toBe('zcupd_agent_old')
  })

  it('skips an undefined field and writes null as null', async () => {
    await seed({ archived: true, archived_at: '2026-09-27T10:00:00.000Z' })

    await redis.updateSession(SESSION, { name: undefined, archived: false, archived_at: null })

    const record = await stored()
    expect(record.name).toBe('Shed')
    expect(record.archived).toBe(false)
    expect('archived_at' in record).toBe(true)
    expect(record.archived_at).toBeNull()
  })

  it('a chat that is gone: throws "Session not found" and does not recreate it', async () => {
    await expect(redis.updateSession(SESSION, { name: 'Ghost' })).rejects.toThrow('Session not found')
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('refuses a field name that is not a chat field name, writing nothing', async () => {
    await seed()
    await expect(redis.updateSession(SESSION, { 'metadata.origin': 1 } as any)).rejects.toThrow(
      'Not a chat field name'
    )
    expect((await stored()).last_modified_at).toBe(OLD_STAMP)
  })
})

/**
 * Wrap the Redis client each `execute` hands out so that "another writer" adds a Compact event
 * and a top-level field inside updateSession: right after its first whole-record read of the
 * chat (the old code's gap between its read and its write), or else right before its script
 * runs. Every whole-record write of the chat is counted.
 */
function interleaveAnotherWriter() {
  const execute = redis.execute.bind(redis)
  let wroteBetween = false
  const wholeRecordWrites: unknown[] = []
  let writeBetween = async () => {}
  vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
    execute(async (client: any) => {
      writeBetween = async () => {
        if (wroteBetween) return
        wroteBetween = true
        await client.json.set(KEY, '$.metadata.contextCompaction', { version: 1, events: [compactEvent] })
        await client.json.set(KEY, '$.zcupd_other_writer', 'kept')
      }
      const target = client.json
      // Empty proxy targets: the client's own properties are read-only, which a proxy may not change.
      const json = new Proxy({}, {
        get(_empty, property) {
          const value = Reflect.get(target, property)
          if (property === 'get') {
            return async (key: string, options?: unknown) => {
              const answer = await value.call(target, key, options)
              if (key === KEY && options === undefined) await writeBetween()
              return answer
            }
          }
          if (property === 'set') {
            return async (key: string, path: string, ...rest: unknown[]) => {
              if (key === KEY && path === '$') wholeRecordWrites.push(rest[0])
              return value.call(target, key, path, ...rest)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      const wrapped = new Proxy({}, {
        get(_empty, property) {
          if (property === 'json') return json
          if (property === 'eval') {
            return async (script: string, options: { keys?: string[] }) => {
              if (options?.keys?.[0] === KEY) await writeBetween()
              return client.eval(script, options)
            }
          }
          const value = Reflect.get(client, property)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })
      return operation(wrapped)
    })) as any)
  return { wholeRecordWrites, wroteBetween: () => wroteBetween }
}

describe.skipIf(!REAL)('a block written while updateSession runs survives (BL-734, real Redis)', () => {
  it('archiveSession keeps a Compact event and a field another writer added meanwhile', async () => {
    await seed()
    const probe = interleaveAnotherWriter()

    await redis.archiveSession(SESSION)

    const record = await stored()
    expect(record.archived).toBe(true)
    expect(typeof record.archived_at).toBe('string')
    expect(record.metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
    expect(record.metadata.origin).toEqual({ kind: 'zcupd_origin' })
    expect(record.zcupd_other_writer).toBe('kept')
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
  })

  it('touchSession (every message save without an agent) keeps them too', async () => {
    await seed()
    const probe = interleaveAnotherWriter()

    await redis.touchSession(SESSION)

    const record = await stored()
    expect(probe.wroteBetween()).toBe(true)
    expect(record.last_modified_at).not.toBe(OLD_STAMP)
    expect(record.metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
    expect(record.zcupd_other_writer).toBe('kept')
    expect(probe.wholeRecordWrites).toEqual([])
  })

  it("saveMessage's agent_id sync writes agent_id and the stamp, and no longer rewrites metadata", async () => {
    await seed()
    const probe = interleaveAnotherWriter()

    await redis.saveMessage({
      id: 'zcupd_msg_1',
      session_id: SESSION,
      user_id: USER,
      role: 'assistant',
      content: 'reply',
      agent_id: 'zcupd_agent_new'
    } as any)

    const record = await stored()
    expect(record.agent_id).toBe('zcupd_agent_new')
    expect(record.last_modified_at).not.toBe(OLD_STAMP)
    expect(record.metadata).toEqual({
      origin: { kind: 'zcupd_origin' },
      contextCompaction: { version: 1, events: [compactEvent] }
    })
    expect(record.zcupd_other_writer).toBe('kept')
    expect(probe.wroteBetween()).toBe(true)
    expect(probe.wholeRecordWrites).toEqual([])
  })
})
