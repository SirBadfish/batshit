import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-723: deleting a Group takes the Group out of each of its chats by writing only that chat's
 * `metadata.group_chat`, by path. The route used to read every chat first and then write each
 * chat's whole metadata from that copy, which erased a Compact event (or any other block) written
 * after the read.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis` (the Lua script of
 * `updateSessionFields`); the default lane's fake twin under plain `npm test`.
 */

useRedisTestServer()

const USER = 'zcmeta_group_user'
const GROUP = 'zcmeta_group'
const IN_GROUP = 'zcmeta_group_chat_in'
const OTHER_GROUP = 'zcmeta_group_chat_other'
const SERVER = 'http://batshit-server.test:5613'

const compactEvent = {
  id: 'zcmeta_group_evt',
  createdAt: '2026-09-27T12:00:00.000Z',
  sourceMessageIds: ['u1', 'a1'],
  summary: 'Written after the delete read the chats.'
}

async function seedChat(id: string, metadata: Record<string, unknown>) {
  await redis.createSession({
    id,
    user_id: USER,
    name: id,
    created_at: '2026-09-27T09:00:00.000Z',
    last_modified_at: '2026-09-27T09:00:00.000Z',
    metadata
  } as any)
}

async function callDelete() {
  const { DELETE } = await import('./+server')
  return DELETE({ params: { id: GROUP }, locals: { user: { id: USER } } } as any) as Promise<Response>
}

beforeEach(() => {
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'route-test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, success: true }), { status: 200 }))
  )
  // The default lane's Redis fake has no Group methods.
  ;(redis as any).getGroup = vi.fn(async (id: string) =>
    id === GROUP ? { id: GROUP, user_id: USER, name: 'Crew', agent_ids: ['a', 'b'] } : null
  )
  ;(redis as any).deleteGroup = vi.fn(async () => {})
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  delete (redis as any).getGroup
  delete (redis as any).deleteGroup
  for (const id of [IN_GROUP, OTHER_GROUP]) await redis.del(`session:${id}`)
  await redis.del(`user:${USER}:sessions`)
})

describe('deleting a Group writes only each chat\'s group field (BL-723)', () => {
  it('a Compact event written after the chats were read survives, and only the Group\'s chats lose it', async () => {
    await seedChat(IN_GROUP, { agent_id: 'zcmeta_agent', group_chat: { group_id: GROUP } })
    await seedChat(OTHER_GROUP, { group_chat: { group_id: 'zcmeta_group_other' } })

    // Another writer right after the route read the chats.
    const readSessions = redis.getSessions
    ;(redis as any).getSessions = async (...args: Parameters<typeof redis.getSessions>) => {
      const sessions = await readSessions.apply(redis, args)
      const written = await redis.appendContextCompactionEvent(IN_GROUP, compactEvent, null)
      expect(written.ok).toBe(true)
      return sessions
    }

    let response: Response
    try {
      response = await callDelete()
    } finally {
      ;(redis as any).getSessions = readSessions
    }
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.clearedSessionIds).toEqual([IN_GROUP])
    const cleared = ((await redis.getSession(IN_GROUP)) as any).metadata
    expect(cleared).toEqual({
      agent_id: 'zcmeta_agent',
      contextCompaction: { version: 1, events: [compactEvent] }
    })
    const untouched = ((await redis.getSession(OTHER_GROUP)) as any).metadata
    expect(untouched).toEqual({ group_chat: { group_id: 'zcmeta_group_other' } })
  })

  // BL-738: a chat can be deleted (by the user, in another tab) between the delete route's read
  // of every chat and its per-chat write. `updateSessionFields` answers `false` for a chat that
  // is gone; that chat is skipped, and the Group's delete still succeeds for the others.
  it('a chat deleted during the delete is skipped, and the delete still succeeds', async () => {
    await seedChat(IN_GROUP, { agent_id: 'zcmeta_agent', group_chat: { group_id: GROUP } })
    await seedChat(OTHER_GROUP, { group_chat: { group_id: GROUP } })

    const readSessions = redis.getSessions
    ;(redis as any).getSessions = async (...args: Parameters<typeof redis.getSessions>) => {
      const sessions = await readSessions.apply(redis, args)
      await redis.del(`session:${IN_GROUP}`)
      return sessions
    }

    let response: Response
    try {
      response = await callDelete()
    } finally {
      ;(redis as any).getSessions = readSessions
    }
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    // Only the chat that still existed at write time is reported as cleared.
    expect(body.clearedSessionIds).toEqual([OTHER_GROUP])
    expect(await redis.exists(`session:${IN_GROUP}`)).toBe(false)
    const untouched = ((await redis.getSession(OTHER_GROUP)) as any).metadata
    expect('group_chat' in untouched).toBe(false)
  })

  // BL-736: a chat can be MOVED to a different Group (by the user, in another tab) between the
  // delete route's read of every chat and its per-chat write. The old, unconditional removal
  // cleared `metadata.group_chat` regardless, taking the chat out of its NEW Group too, even
  // though that Group was never being deleted. `clearGroupChatIfMatches` re-checks the live value
  // right before writing, so the move survives.
  it('a chat moved to a different Group during the delete keeps its new Group', async () => {
    const MOVED_TO_GROUP = 'zcmeta_group_moved_to'
    await seedChat(IN_GROUP, { agent_id: 'zcmeta_agent', group_chat: { group_id: GROUP } })

    const readSessions = redis.getSessions
    ;(redis as any).getSessions = async (...args: Parameters<typeof redis.getSessions>) => {
      const sessions = await readSessions.apply(redis, args)
      // Another tab moves the chat to a different Group right after the delete read it.
      const moved = await redis.updateSessionFields(IN_GROUP, {}, { group_id: MOVED_TO_GROUP })
      expect(moved).toBe(true)
      return sessions
    }

    let response: Response
    try {
      response = await callDelete()
    } finally {
      ;(redis as any).getSessions = readSessions
    }
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    // The chat no longer named the deleted Group by the time the write ran, so it is not reported.
    expect(body.clearedSessionIds).toEqual([])
    const stillMoved = ((await redis.getSession(IN_GROUP)) as any).metadata
    expect(stillMoved.group_chat).toEqual({ group_id: MOVED_TO_GROUP })
  })
})
