import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-140 (2026-09-25): `DELETE /api/groups/[id]` deletes the Group's avatar pictures. They
 * are batshit-server's, so the route checks batshit-server before anything is deleted and asks
 * for the sweep BEFORE `redis.deleteGroup` (the order of the agent delete, BL-41): when
 * batshit-server cannot, the Group stays and a retry finishes the job.
 */

const events: string[] = []

useRedisTestServer()

const USER = 'user-group-delete-route'
const GROUP = 'new_group'
const SERVER = 'http://batshit-server.test:5613'
const HEALTH = `batshit-server GET ${SERVER}/health`
const SWEEP = `batshit-server DELETE ${SERVER}/api/upload/avatar`

let groups: Map<string, Record<string, any>>

function seedGroup(overrides: Record<string, unknown> = {}, id = GROUP) {
  groups.set(id, {
    id,
    user_id: USER,
    name: 'Crew',
    agent_ids: ['a', 'b'],
    avatar_url: `/uploads/avatars/group_${id}_1775792747492.jpg`,
    ...overrides
  })
}

async function callDelete(userId: string | null, id = GROUP) {
  const { DELETE } = await import('./+server')
  return DELETE({ params: { id }, locals: userId ? { user: { id: userId } } : {} } as any)
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

let health: () => Promise<Response>
let sweep: () => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn>

const refused = async (): Promise<Response> => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:5613') })
}

beforeEach(() => {
  events.length = 0
  groups = new Map()
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'route-test-token')
  health = async () => jsonResponse(200, { ok: true, service: 'batshit-server', checks: { http: true, redis: true } })
  sweep = async () => jsonResponse(200, { success: true, deletedRecords: [], deletedFiles: [] })
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    events.push(`batshit-server ${method} ${url}`)
    if (url === `${SERVER}/health` && method === 'GET') return health()
    if (url === `${SERVER}/api/upload/avatar` && method === 'DELETE') return sweep()
    throw new Error(`unexpected batshit-server call ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  // The default lane's Redis fake has no Group methods; these stand in for the real ones and
  // record WHEN the delete ran relative to the avatar request.
  ;(redis as any).getGroup = vi.fn(async (id: string) => groups.get(id) ?? null)
  ;(redis as any).deleteGroup = vi.fn(async (id: string) => {
    events.push('redis.deleteGroup')
    groups.delete(id)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  delete (redis as any).getGroup
  delete (redis as any).deleteGroup
})

describe('DELETE /api/groups/[id] and the Group’s avatar pictures (BL-140)', () => {
  it('checks batshit-server, then asks it to delete the pictures, BEFORE the Group goes', async () => {
    seedGroup()

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, SWEEP, 'redis.deleteGroup'])
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.headers).toMatchObject({ 'x-batshit-service-token': 'route-test-token' })
    expect(JSON.parse(String(init.body))).toEqual({ entityType: 'group', entityId: GROUP, legacyFilenames: [] })
    expect(groups.has(GROUP)).toBe(false)
  })

  it('batshit-server down: 503, and the Group is still there', async () => {
    seedGroup()
    health = refused
    sweep = refused

    const response = await callDelete(USER)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('batshit_server_unavailable')
    expect(body.error).toMatch(/nothing was deleted: the Group is still there\. Try again once batshit-server is running\./)
    expect(events).toEqual([HEALTH])
    expect(groups.has(GROUP)).toBe(true)
  })

  it('batshit-server refuses the sweep: 502 with its reason, and the Group kept', async () => {
    seedGroup()
    sweep = async () => jsonResponse(500, { error: 'Avatar delete failed', details: 'EACCES: permission denied' })

    const response = await callDelete(USER)
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.error).toMatch(/Could not delete this Group's avatar pictures: batshit-server answered 500/)
    expect(body.error).toMatch(/The Group was not deleted\./)
    expect(events).not.toContain('redis.deleteGroup')
    expect(groups.has(GROUP)).toBe(true)
  })

  it('an id outside the owner id rule (no picture can be stored for it) skips the sweep and still deletes', async () => {
    seedGroup({}, 'odd group')

    const response = await callDelete(USER, 'odd group')

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, 'redis.deleteGroup'])
  })

  it('another user’s Group: 403 before anything is asked of batshit-server', async () => {
    seedGroup({ user_id: 'someone-else' })

    const response = await callDelete(USER)

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(groups.has(GROUP)).toBe(true)
  })
})
