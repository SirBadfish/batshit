import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { POST } from './+server'

/**
 * BL-735: `POST /api/sessions/[id]/fixed` writes the chat's whole metadata block from a copy it
 * read before the transition, so a block another writer added meanwhile (a Compact event, a
 * regular graduation mark) is erased. Fix: write only the fields this route owns
 * (`metadata.fixedSession` and `locked`), by path.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis`.
 */

useRedisTestServer()

const USER = 'zcsmall_user'
const SESSION = 'zcsmall_fixed_session'

async function seed(metadata: Record<string, unknown> = {}) {
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    name: 'Garage',
    created_at: '2026-09-27T09:00:00.000Z',
    last_modified_at: '2026-09-27T09:00:00.000Z',
    metadata
  } as any)
}

async function fixIt() {
  const response = (await (POST as any)({
    params: { id: SESSION },
    locals: { user: { id: USER } }
  })) as Response
  return { status: response.status, body: await response.json() }
}

async function stored() {
  return (await redis.getSession(SESSION)) as any
}

beforeEach(async () => {
  await seed({ agent_id: 'zcsmall_agent' })
})

afterEach(async () => {
  await redis.del(`session:${SESSION}`)
  await redis.del(`user:${USER}:sessions`)
  // BL-740: seed() goes through createSession, which can create a default folder for USER
  // (`folder:<user>:<id>`, `folder:<user>:<id>:sessions`, `user:<user>:folders`,
  // `user:<user>:default_folder`) the first time it runs. Sweep every key under this test's
  // probe prefix rather than naming each one, so a future field this route or createSession
  // starts writing does not silently leak again.
  await redis.execute(async (client) => {
    const keys = await client.keys('*zcsmall*')
    if (keys.length > 0) await client.unlink(keys)
  })
})

describe('the Infinite Session transition writes only its own fields (BL-735)', () => {
  it('a Compact event appended between the route\'s read and its write survives the transition', async () => {
    // The route reads the session inside requireOwnedSession, then later awaits
    // `redis.getMessages` before it writes. Land another writer's event (a Compact) inside that
    // gap: this is the exact window the whole-metadata write erased.
    const compactEvent = {
      id: 'evt_written_during_transition',
      createdAt: '2026-09-27T12:00:00.000Z',
      sourceMessageIds: ['u1'],
      summary: 'Written while the transition was in flight.'
    }
    const getMessagesSpy = vi.spyOn(redis, 'getMessages').mockImplementationOnce(async (...args) => {
      const before = await stored()
      await redis.updateSession(SESSION, {
        metadata: {
          ...before.metadata,
          contextCompaction: { version: 1, events: [compactEvent] }
        }
      } as any)
      return []
    })

    const { status, body } = await fixIt()

    getMessagesSpy.mockRestore()
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    const record = await stored()
    expect(record.metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
    expect(record.metadata.agent_id).toBe('zcsmall_agent')
    expect(record.metadata.fixedSession).toMatchObject({ version: 1, enabled: true })
    expect(record.locked).toBe(true)
  })

  it('is idempotent when the session is already fixed', async () => {
    await seed({ agent_id: 'zcsmall_agent', fixedSession: { version: 1, enabled: true, created_at: '2026-09-27T09:00:00.000Z' } })

    const { status, body } = await fixIt()

    expect(status).toBe(200)
    expect(body.alreadyFixed).toBe(true)
  })
})
