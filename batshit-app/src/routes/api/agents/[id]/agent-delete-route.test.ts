import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { pinHostCommandOwner, prepareHostCommand } from '$lib/server/services/hostCommandOwnership'

/**
 * BL-41 (2026-09-22): `DELETE /api/agents/[id]` deletes the agent's avatar pictures.
 *
 * The pictures are batshit-server's, so the route asks it (server to server, service token)
 * and does so BEFORE `redis.deleteAgent`, like the agent's memory media: when batshit-server
 * cannot delete them, the agent is NOT deleted and the user gets a clear error, so a retry
 * finishes the job. Deleting the record first is how Bob's three pictures were left behind
 * with nothing pointing at them.
 *
 * Before ANYTHING is deleted, the route checks that batshit-server answers and its Redis is
 * ready (`GET /health`): "Also delete its chats" is on by default, and without the check a
 * stopped batshit-server let the chats go while the agent stayed. The chats still go before
 * the sweep (a chat still stopping refuses 409 and must leave the agent AND its avatar
 * untouched), so a failure between the two is still possible and says how many chats went.
 */

const events: string[] = []

const deleteAgentChats = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/agentChatDeletion', () => ({ deleteAgentChats }))
const publishUserEvent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent }))
vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles: vi.fn(async () => {}),
  deleteAgentCodexConfig: vi.fn(async () => {}),
  buildAgentProfileId: (id: string) => `batshit_agent_${id}`
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  deleteAgentClaudeConfig: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
const deleteAgentWorkerProfiles = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  deleteAgentWorkerProfiles,
  planAgentWorkerProfileDeletion: vi.fn(async () => ({ deletable: [], kept: [] }))
}))

useRedisTestServer()

const USER = 'user-agent-delete-route'
const AGENT = 'zb_route_agent'
const SERVER = 'http://batshit-server.test:5613'
const HEALTH = `batshit-server GET ${SERVER}/health`
const SWEEP = `batshit-server DELETE ${SERVER}/api/upload/avatar`

async function seedAgent(overrides: Record<string, unknown> = {}) {
  await redis.createAgent({
    id: AGENT,
    user_id: USER,
    displayName: 'Route probe',
    agentType: 'api',
    avatar: `/uploads/avatars/agent_${AGENT}_1790000000000.jpg`,
    avatar_url: `/uploads/avatars/agent_${AGENT}_1790000000000.jpg`,
    ...overrides
  } as any)
}

async function callDelete(userId: string | null, query = '', agentId = AGENT) {
  const { DELETE } = await import('./+server')
  return DELETE({
    params: { id: agentId },
    locals: userId ? { user: { id: userId } } : {},
    url: new URL(`http://127.0.0.1:5200/api/agents/${agentId}${query}`)
  } as any)
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The holds `redis.deleteAgent` released (BL-539); each test sets what it is about.
let releasedHolds: Array<{ sessionId: string; zipId: string }> = []

// What batshit-server answers, per endpoint. Each test changes only what it is about.
let health: () => Promise<Response>
let sweep: () => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn>

const refused = async (): Promise<Response> => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:5613') })
}

beforeEach(() => {
  events.length = 0
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
  deleteAgentWorkerProfiles.mockReset()
  deleteAgentWorkerProfiles.mockImplementation(async (_userId: string, id: string) => {
    events.push(`deleteAgentWorkerProfiles ${id}`)
    return { deleted: [], kept: [] }
  })
  deleteAgentChats.mockReset()
  deleteAgentChats.mockImplementation(async () => {
    events.push('deleteAgentChats')
    return { deleted: ['chat-1', 'chat-2'], keptLocked: [] }
  })
  // The default lane's Redis fake has no `deleteAgent`; this stands in for the real sweep
  // and records WHEN it ran relative to the avatar request.
  releasedHolds = []
  publishUserEvent.mockClear()
  ;(redis as any).deleteAgent = vi.fn(async (id: string) => {
    events.push('redis.deleteAgent')
    await redis.del(`agent:${id}`)
    await redis.sRem(`user:${USER}:agents`, id)
    return { releasedHolds }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  delete (redis as any).deleteAgent
})

describe('DELETE /api/agents/[id] and the agent’s avatar pictures (BL-41)', () => {
  it('refuses an unresolved host command before touching chats, pictures, or the agent', async () => {
    const agentId = `${AGENT}_guarded`
    await seedAgent({ id: agentId })
    const pin = pinHostCommandOwner({ userId: USER, kind: 'agent', id: agentId })
    const lease = await prepareHostCommand(pin, { kind: 'guardian', program: '/bin/sh' })
    try {
      const response = await callDelete(USER, '?chats=1', agentId)
      const body = await response.json()
      expect(response.status).toBe(409)
      expect(body.code).toBe('host_command_cleanup_unverified')
      expect(events).toEqual([])
      expect(await redis.get(`agent:${agentId}`)).not.toBeNull()
    } finally {
      lease.complete()
    }
  })

  it('returns the durable recovery notice after an old recorded program has ended', async () => {
    const agentId = `${AGENT}_recovered`
    await seedAgent({ id: agentId })
    const pin = pinHostCommandOwner({ userId: USER, kind: 'agent', id: agentId })
    const lease = await prepareHostCommand(pin, { kind: 'codex', program: '/bin/codex' })
    lease.observe([{ pid: 999999999, parent: 1, group: 999999999, started: 'old-birth', state: 'S', program: 'old-codex' }])

    const response = await callDelete(USER, '', agentId)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.notice).toMatch(/each program it recorded for the old run has ended/)
    expect(await redis.get(`agent:${agentId}`)).toBeNull()
  })

  it('checks batshit-server, then asks it to delete the avatars, BEFORE the agent record goes', async () => {
    await seedAgent()

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    // BL-393: its Worker slot folders go after the record, like its own folder.
    expect(events).toEqual([HEALTH, SWEEP, 'redis.deleteAgent', `deleteAgentWorkerProfiles ${AGENT}`])
    expect(deleteAgentWorkerProfiles).toHaveBeenCalledWith(USER, AGENT)
    const init = fetchMock.mock.calls[1][1] as RequestInit
    expect(init.headers).toMatchObject({ 'x-batshit-service-token': 'route-test-token' })
    expect(JSON.parse(String(init.body))).toEqual({ entityType: 'agent', entityId: AGENT, legacyFilenames: [] })
    expect(await redis.get(`agent:${AGENT}`)).toBeNull()
  })

  it('with "Also delete its chats": the check, then the chats, then the avatars, then the agent', async () => {
    await seedAgent()

    const response = await callDelete(USER, '?chats=1')

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, 'deleteAgentChats', SWEEP, 'redis.deleteAgent', `deleteAgentWorkerProfiles ${AGENT}`])
    expect(await response.json()).toEqual({ success: true, chats: { deleted: 2, keptLocked: 0 } })
  })

  it('batshit-server down with "Also delete its chats": 503, and NOTHING is deleted, chats included', async () => {
    await seedAgent()
    health = refused
    sweep = refused

    const response = await callDelete(USER, '?chats=1')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('batshit_server_unavailable')
    expect(body.error).toMatch(/batshit-server did not answer \(connect ECONNREFUSED/)
    expect(body.error).toMatch(/nothing was deleted: the agent and its chats are still there/)
    expect(body.error).toMatch(/Try again once batshit-server is running\./)
    expect(events).toEqual([HEALTH])
    expect(deleteAgentChats).not.toHaveBeenCalled()
    expect(await redis.get(`agent:${AGENT}`)).toMatchObject({
      id: AGENT,
      avatar: `/uploads/avatars/agent_${AGENT}_1790000000000.jpg`
    })
  })

  it('batshit-server up but its Redis not ready (health 503): refused before the chats', async () => {
    await seedAgent()
    health = async () => jsonResponse(503, { ok: false, service: 'batshit-server', checks: { http: true, redis: false } })

    const response = await callDelete(USER, '?chats=1')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toMatch(/its Redis is not ready/)
    expect(deleteAgentChats).not.toHaveBeenCalled()
    expect(events).toEqual([HEALTH])
    expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
  })

  it('batshit-server down without the chats box: 503, and the agent (with its avatar) is still there', async () => {
    await seedAgent()
    health = refused
    sweep = refused

    const response = await callDelete(USER)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toMatch(/batshit-server did not answer/)
    expect(body.error).toMatch(/nothing was deleted: the agent is still there/)
    expect(events).not.toContain('redis.deleteAgent')
    expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
  })

  it('batshit-server stops between the check and the sweep: the chats already went, the agent stays, and the error says so', async () => {
    await seedAgent()
    sweep = refused

    const response = await callDelete(USER, '?chats=1')
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('agent_avatar_delete_failed')
    expect(body.error).toMatch(/Could not delete this agent's avatar pictures: batshit-server did not answer/)
    expect(body.error).toMatch(/The agent was not deleted\. Its 2 chats were already deleted\./)
    expect(body.chats).toEqual({ deleted: 2, keptLocked: 0 })
    expect(events).toEqual([HEALTH, 'deleteAgentChats', SWEEP])
    expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
  })

  it('batshit-server refuses the sweep: 502 with its reason, and the agent kept', async () => {
    await seedAgent()
    sweep = async () =>
      jsonResponse(500, { error: 'Avatar delete failed', details: 'EACCES: permission denied' })

    const response = await callDelete(USER, '?chats=1')
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.error).toMatch(/EACCES/)
    expect(body.error).toMatch(/The agent was not deleted\. Its 2 chats were already deleted\./)
    expect(events).not.toContain('redis.deleteAgent')
    expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
  })

  it('a chat that is still stopping refuses first: 409, and the sweep is never asked for', async () => {
    const { SessionDeleteRefusedError } = await import('$lib/server/services/sessionDeleteTurnStop')
    await seedAgent()
    deleteAgentChats.mockImplementation(async () => {
      throw new SessionDeleteRefusedError('session_turn_still_stopping')
    })

    const response = await callDelete(USER, '?chats=1')

    expect(response.status).toBe(409)
    expect(events).toEqual([HEALTH])
    expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
  })

  it('another user’s agent: 403 before anything is asked of batshit-server', async () => {
    await seedAgent({ user_id: 'someone-else' })

    const response = await callDelete(USER)

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})

/**
 * BL-539: deleting an agent releases its holds in every chat (`redis.deleteAgent`), and an open
 * tab showed "Held by" the deleted agent until a reload because nobody told it. The route tells
 * every tab once per chat whose zip state changed, as the reply-end step does.
 */
describe('DELETE /api/agents/[id] tells open tabs about the holds it released (BL-539)', () => {
  it('publishes one zip_state_changed per chat whose holds were released', async () => {
    await seedAgent()
    releasedHolds = [
      { sessionId: 'chat-a', zipId: 'zip_1' },
      { sessionId: 'chat-a', zipId: 'zip_2' },
      { sessionId: 'chat-b', zipId: 'zip_3' }
    ]

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(publishUserEvent.mock.calls).toEqual([
      [USER, { type: 'zip_state_changed', sessionId: 'chat-a', source: 'agent', opened: [], rezipped: [] }],
      [USER, { type: 'zip_state_changed', sessionId: 'chat-b', source: 'agent', opened: [], rezipped: [] }]
    ])
  })

  it('publishes nothing when the agent held nothing', async () => {
    await seedAgent()
    const response = await callDelete(USER)
    expect(response.status).toBe(200)
    expect(publishUserEvent).not.toHaveBeenCalled()
  })
})
