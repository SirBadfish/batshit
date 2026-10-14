import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { PUT } from './+server'

/**
 * BL-690: the generic update of a chat (`PUT /api/sessions/[id]`) takes only the fields a browser
 * may change, each by path; every other stored block stays (Faye, 2026-09-27).
 *
 * The chat's group selection (`AgentSelector.persistGroupSelection`) sends the TAB's copy of the
 * chat's metadata with `group_chat` added or taken out, and the update wrote that copy over the
 * stored block. A tab that had not seen a later Compact event (another tab, Auto Compact) or a
 * regular chat's graduation mark (written on the server) erased it.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis` (one Lua script there); the
 * default lane's fake twin under plain `npm test`.
 */

useRedisTestServer()

const USER = 'zcyield_user'
const SESSION = 'zcyield_update_session'

const compactEvent = {
  id: 'evt_written_in_another_tab',
  createdAt: '2026-09-27T12:00:00.000Z',
  sourceMessageIds: ['u1', 'a1'],
  summary: 'Summary written after this tab loaded.'
}

async function seed(metadata: Record<string, unknown>) {
  await redis.createSession({
    id: SESSION,
    user_id: USER,
    name: 'Garage',
    created_at: '2026-09-27T09:00:00.000Z',
    last_modified_at: '2026-09-27T09:00:00.000Z',
    metadata
  } as any)
}

async function put(body: unknown) {
  const request = new Request(`http://localhost/api/sessions/${SESSION}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const response = (await (PUT as any)({ request, params: { id: SESSION }, locals: { user: { id: USER } } })) as Response
  return { status: response.status, body: await response.json() }
}

async function stored() {
  return (await redis.getSession(SESSION)) as any
}

beforeEach(async () => {
  await seed({ agent_id: 'zcyield_agent' })
})

afterEach(async () => {
  await redis.del(`session:${SESSION}`)
  await redis.del(`user:${USER}:sessions`)
})

describe('the generic chat update writes only the browser\'s fields (BL-690)', () => {
  it('a stale tab\'s group selection keeps the Compact event and the graduation mark written since', async () => {
    // The tab loaded the chat here: its copy of the metadata has neither of the two below.
    const tabCopy = { ...(await stored()).metadata }
    await redis.updateSession(SESSION, {
      metadata: {
        ...(await stored()).metadata,
        contextCompaction: { version: 1, events: [compactEvent] },
        memoryGraduation: { version: 1, lastGraduatedMessageId: 'a1' }
      }
    } as any)

    const { status } = await put({ metadata: { ...tabCopy, group_chat: { group_id: 'zcyield_group' } } })

    expect(status).toBe(200)
    const metadata = (await stored()).metadata
    expect(metadata.group_chat).toEqual({ group_id: 'zcyield_group' })
    expect(metadata.contextCompaction).toEqual({ version: 1, events: [compactEvent] })
    expect(metadata.memoryGraduation).toEqual({ version: 1, lastGraduatedMessageId: 'a1' })
    expect(metadata.agent_id).toBe('zcyield_agent')
  })

  it('sets the group on a chat record that has no metadata object yet', async () => {
    await redis.json.set(`session:${SESSION}`, '$', { id: SESSION, user_id: USER, name: 'Garage' } as never)

    const { status } = await put({ metadata: { group_chat: { group_id: 'zcyield_group' } } })

    expect(status).toBe(200)
    expect((await stored()).metadata).toEqual({ group_chat: { group_id: 'zcyield_group' } })
  })

  it('taking the group out removes only the group', async () => {
    await seed({ agent_id: 'zcyield_agent', group_chat: { group_id: 'zcyield_group' }, memoryGraduation: { version: 1 } })
    const tabCopy = { agent_id: 'zcyield_agent' }

    const { status } = await put({ metadata: tabCopy })

    expect(status).toBe(200)
    const metadata = (await stored()).metadata
    expect('group_chat' in metadata).toBe(false)
    expect(metadata.memoryGraduation).toEqual({ version: 1 })
  })

  it('other keys of the tab\'s metadata copy are not written', async () => {
    const { status } = await put({ metadata: { agent_id: 'zcyield_other_agent', note: 'from the tab' } })

    expect(status).toBe(200)
    const metadata = (await stored()).metadata
    expect(metadata.agent_id).toBe('zcyield_agent')
    expect('note' in metadata).toBe(false)
  })

  it('a rename, a lock, and an archive write their own fields and stamp the change', async () => {
    expect((await put({ name: 'Garage shelves' })).status).toBe(200)
    expect((await put({ locked: true })).status).toBe(200)
    expect((await put({ archived: true, archived_at: '2026-09-27T13:00:00.000Z' })).status).toBe(200)

    const record = await stored()
    expect(record.name).toBe('Garage shelves')
    expect(record.locked).toBe(true)
    expect(record.archived).toBe(true)
    expect(record.archived_at).toBe('2026-09-27T13:00:00.000Z')
    expect(record.metadata).toEqual({ agent_id: 'zcyield_agent' })
    expect(record.last_modified_at).not.toBe('2026-09-27T09:00:00.000Z')
  })

  it('refuses a field a browser may not change, and writes nothing', async () => {
    const { status, body } = await put({ name: 'Renamed', user_id: 'someone_else' })

    expect(status).toBe(400)
    expect(body.code).toBe('unknown_session_field')
    expect(body.error).toBe('A chat update cannot change: user_id.')
    const record = await stored()
    expect(record.user_id).toBe(USER)
    expect(record.name).toBe('Garage')
  })

  // BL-722: a `metadata` that is not an object answered 500 (null) or the Infinite Session
  // check's 409, never 400.
  it.each([
    ['null', null],
    ['a list', [{ group_chat: { group_id: 'zcmeta_group' } }]],
    ['a string', 'group'],
    ['a number', 7]
  ])('refuses a metadata that is %s with 400, and writes nothing', async (_label, metadata) => {
    await seed({ agent_id: 'zcyield_agent', fixedSession: { version: 1, enabled: true, created_at: '2026-09-27T09:00:00.000Z' } })

    const { status, body } = await put({ name: 'Renamed', metadata })

    expect(status).toBe(400)
    expect(body.code).toBe('invalid_session_metadata')
    expect(body.error).toBe('A chat update\'s metadata must be an object.')
    const record = await stored()
    expect(record.name).toBe('Garage')
    expect(record.metadata.fixedSession).toEqual({ version: 1, enabled: true, created_at: '2026-09-27T09:00:00.000Z' })
  })

  it('still refuses a group for an Infinite Session', async () => {
    await seed({ agent_id: 'zcyield_agent', fixedSession: { version: 1, enabled: true, created_at: '2026-09-27T09:00:00.000Z' } })

    const { status, body } = await put({ metadata: { group_chat: { group_id: 'zcyield_group' } } })

    expect(status).toBe(409)
    expect(body.code).toBe('FIXED_SESSION_IMMUTABLE')
    expect('group_chat' in (await stored()).metadata).toBe(false)
  })
})
