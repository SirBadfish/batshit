import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { failNextRedisCommand } from '$lib/test-utils/redis-command-failure'
import { redis } from '$lib/server/redis'
import { pinHostCommandOwner, prepareHostCommand } from '$lib/server/services/hostCommandOwnership'

/**
 * `DELETE /api/subagents/[id]` deletes everything that is the Subagent's (2026-09-25):
 *
 * - BL-139: its avatar pictures. They are batshit-server's, so the route checks batshit-server
 *   first (nothing is deleted when it cannot answer) and asks for the sweep BEFORE the record
 *   goes, like the agent delete (BL-41).
 * - BL-157: its managed CLI profile folder (`~/.batshit/agents/batshit_agent_subagent_cli_<slug>`,
 *   config plus `logs_2.sqlite` with its prompts), also before the record, so a failure keeps
 *   the Subagent for a retry; and its id in BOTH assignment lists (`assigned_subagent_ids` and
 *   `assignedSubagents`, which the profile managers read), as path-scoped writes.
 * - BL-187: its id in the access lists that are not its own records (a skill's
 *   `enabled_agent_ids`, an artifact's `agent_allowlist`), exactly as `deleteAgent` scrubs a
 *   primary's, so a later agent or Subagent created with the same id does not inherit them.
 */

const events: string[] = []

const deleteManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => null),
  // BL-753: the delete holds its profile folder's turn; not what this suite tests.
  holdManagedCliSubagentProfileFolder: async (_subagent: unknown, action: () => Promise<unknown>) => action(),
  deleteManagedCliSubagentProfile,
  planManagedCliSubagentProfileDeletion: vi.fn(async () => ({
    profileId: 'batshit_agent_subagent_cli_route_probe', deleted: true, sharedWith: null, sharedWithKind: null
  }))
}))
const syncAgentCodexProfiles = vi.hoisted(() => vi.fn(async () => {}))
const syncAgentClaudeProfiles = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles,
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'user-subagent-delete-route'
const SUB = 'zb_route_sub'
const SERVER = 'http://batshit-server.test:5613'
const HEALTH = `batshit-server GET ${SERVER}/health`
const SWEEP = `batshit-server DELETE ${SERVER}/api/upload/avatar`
const PROFILE = 'deleteManagedCliSubagentProfile'

async function seedSubagent(overrides: Record<string, unknown> = {}, id = SUB) {
  await redis.json.set(`subagent:${id}`, '$', {
    id,
    user_id: USER,
    displayName: 'Route probe',
    subagentType: 'cli',
    avatar: `/uploads/avatars/subagent_${id}_1790000000000.jpg`,
    ...overrides
  })
  await redis.sAdd(`user:${USER}:subagents`, id)
}

async function seedAgent(id: string, fields: Record<string, unknown>) {
  await redis.json.set(`agent:${id}`, '$', { id, user_id: USER, displayName: id, ...fields })
  await redis.sAdd(`user:${USER}:agents`, id)
}

async function callDelete(userId: string | null, id = SUB) {
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
  deleteManagedCliSubagentProfile.mockReset()
  deleteManagedCliSubagentProfile.mockImplementation(async () => {
    events.push(PROFILE)
    return { profileId: `batshit_agent_subagent_cli_${SUB}`, deleted: true, sharedWith: null }
  })
  syncAgentCodexProfiles.mockClear()
  syncAgentClaudeProfiles.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('DELETE /api/subagents/[id]: avatar pictures (BL-139)', () => {
  it('refuses unresolved host cleanup before deleting the profile, pictures, or record', async () => {
    await seedSubagent()
    const pin = pinHostCommandOwner({ userId: USER, kind: 'subagent', id: SUB })
    const lease = await prepareHostCommand(pin, { kind: 'guardian', program: '/bin/sh' })
    try {
      const response = await callDelete(USER)
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('host_command_cleanup_unverified')
      expect(events).toEqual([HEALTH])
      expect(deleteManagedCliSubagentProfile).not.toHaveBeenCalled()
      expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
    } finally {
      lease.complete()
    }
  })

  it('checks batshit-server, removes the profile folder, sweeps the pictures, THEN deletes the record', async () => {
    await seedSubagent()

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, PROFILE, SWEEP])
    const sweepInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(sweepInit.headers).toMatchObject({ 'x-batshit-service-token': 'route-test-token' })
    expect(JSON.parse(String(sweepInit.body))).toEqual({ entityType: 'subagent', entityId: SUB, legacyFilenames: [] })
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual([])
  })

  it('batshit-server down: 503, and NOTHING is deleted (record, folder, assignments)', async () => {
    await seedSubagent()
    await seedAgent('primary', { assigned_subagent_ids: [SUB], assignedSubagents: [SUB] })
    health = refused
    sweep = refused

    const response = await callDelete(USER)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('batshit_server_unavailable')
    expect(body.error).toMatch(/batshit-server did not answer \(connect ECONNREFUSED/)
    expect(body.error).toMatch(/nothing was deleted: the Subagent is still there\. Try again once batshit-server is running\./)
    expect(events).toEqual([HEALTH])
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
    expect(await redis.json.get('agent:primary')).toMatchObject({ assigned_subagent_ids: [SUB], assignedSubagents: [SUB] })
  })

  it('batshit-server refuses the sweep: 502 with its reason, and the Subagent kept', async () => {
    await seedSubagent()
    sweep = async () => jsonResponse(500, { error: 'Avatar delete failed', details: 'EACCES: permission denied' })

    const response = await callDelete(USER)
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.error).toMatch(/Could not delete this Subagent's avatar pictures: batshit-server answered 500/)
    expect(body.error).toMatch(/EACCES/)
    expect(body.error).toMatch(/The Subagent was not deleted\./)
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
  })

  it('an id outside the owner id rule (no picture can be stored for it) skips the sweep and still deletes', async () => {
    await seedSubagent({}, 'odd.id')

    const response = await callDelete(USER, 'odd.id')

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, PROFILE])
    expect(await redis.json.get('subagent:odd.id')).toBeNull()
  })

  it('another user’s Subagent: 403 before anything is asked of batshit-server', async () => {
    await seedSubagent({ user_id: 'someone-else' })

    const response = await callDelete(USER)

    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(deleteManagedCliSubagentProfile).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/subagents/[id]: managed profile and assignments (BL-157)', () => {
  it('removes the id from both assignment lists and the assignment set, leaving other ids and fields alone', async () => {
    await seedSubagent()
    await seedAgent('primary', {
      assigned_subagent_ids: ['keep_me', SUB],
      assignedSubagents: [SUB, 'keep_me'],
      system_prompt: 'unchanged'
    })
    await seedAgent('legacy_only', { assignedSubagents: [SUB] })
    await seedAgent('untouched', { assigned_subagent_ids: ['keep_me'], assignedSubagents: ['keep_me'] })
    await redis.sAdd(`agent:primary:subagents`, SUB)
    await redis.sAdd(`agent:primary:subagents`, 'keep_me')

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(await redis.json.get('agent:primary')).toMatchObject({
      assigned_subagent_ids: ['keep_me'],
      assignedSubagents: ['keep_me'],
      system_prompt: 'unchanged'
    })
    expect(await redis.json.get('agent:legacy_only')).toMatchObject({ assignedSubagents: [] })
    expect(await redis.json.get('agent:untouched')).toMatchObject({
      assigned_subagent_ids: ['keep_me'],
      assignedSubagents: ['keep_me']
    })
    expect(await redis.sMembers('agent:primary:subagents')).toEqual(['keep_me'])
  })

  it('asks for the profile folder with the stored Subagent, then syncs the primaries’ managed profiles', async () => {
    await seedSubagent({ slug: 'custom_slug' })

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(deleteManagedCliSubagentProfile).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ id: SUB, slug: 'custom_slug' })
    )
    expect(syncAgentCodexProfiles).toHaveBeenCalledWith(USER)
    expect(syncAgentClaudeProfiles).toHaveBeenCalledWith(USER)
  })

  it('a profile folder that cannot be removed keeps the Subagent (and its pictures) for a retry', async () => {
    await seedSubagent()
    deleteManagedCliSubagentProfile.mockImplementation(async () => {
      events.push(PROFILE)
      throw new Error('EACCES: permission denied, rmdir /x/batshit_agent_subagent_cli_zb_route_sub')
    })

    const response = await callDelete(USER)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toMatch(/Could not delete this Subagent's managed CLI profile folder: EACCES/)
    expect(body.error).toMatch(/The Subagent was not deleted\./)
    expect(events).toEqual([HEALTH, PROFILE])
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
  })
})

describe('DELETE /api/subagents/[id]: a same-id Primary Agent and a failed scrub (review of BL-187)', () => {
  async function seedAccessLists() {
    await redis.json.set(`slash_command:${USER}:reviewer`, '$', { id: 'reviewer', enabled_agent_ids: [SUB, 'other'] })
    await redis.json.set('artifact:art1', '$', { id: 'art1', agent_allowlist: [SUB] })
    await redis.sAdd(`user:${USER}:artifacts`, 'art1')
  }

  it('a Primary Agent with the same id keeps its skill and artifact access (the lists cannot tell the two apart)', async () => {
    await seedSubagent()
    // A collision made before BL-187 refused them: a primary `zb_route_sub` beside the Subagent.
    await seedAgent(SUB, { assigned_subagent_ids: [], assignedSubagents: [] })
    await seedAgent('primary', { assigned_subagent_ids: [SUB], assignedSubagents: [SUB] })
    await seedAccessLists()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await callDelete(USER)
    const warned = warn.mock.calls.map(([line]) => String(line))
    warn.mockRestore()

    expect(response.status).toBe(200)
    expect(await redis.json.get(`slash_command:${USER}:reviewer`)).toMatchObject({ enabled_agent_ids: [SUB, 'other'] })
    expect(await redis.json.get('artifact:art1')).toMatchObject({ agent_allowlist: [SUB] })
    expect(warned.some((line) => line.includes(`Primary Agent ${SUB}`))).toBe(true)
    // Assignments name Subagents only, so they still go; the record goes too.
    expect(await redis.json.get('agent:primary')).toMatchObject({ assigned_subagent_ids: [], assignedSubagents: [] })
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
    expect(await redis.json.get(`agent:${SUB}`)).not.toBeNull()
  })

  it('a Redis error in one scrub keeps the Subagent, names the step, and a retry finishes the job', async () => {
    await seedSubagent()
    await seedAgent('primary', { assigned_subagent_ids: [SUB], assignedSubagents: [SUB] })
    await seedAccessLists()
    // BL-607: failed at the client the route's steps read through, so it fails on real Redis too.
    const failure = failNextRedisCommand('keys', new Error('Socket closed unexpectedly'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    const refused = await callDelete(USER).finally(failure.restore)
    const body = await refused.json()
    quiet.mockRestore()

    expect(failure.failed()).toBe(true)

    expect(refused.status).toBe(500)
    expect(body.code).toBe('subagent_references_not_removed')
    expect(body.error).toMatch(/skill access lists \(Socket closed unexpectedly\)/)
    expect(body.error).toMatch(/The Subagent was not deleted/)
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual([SUB])
    // The other steps still ran; each is safe to run again.
    expect(await redis.json.get('agent:primary')).toMatchObject({ assigned_subagent_ids: [], assignedSubagents: [] })
    expect(await redis.json.get('artifact:art1')).toMatchObject({ agent_allowlist: [] })
    expect(await redis.json.get(`slash_command:${USER}:reviewer`)).toMatchObject({ enabled_agent_ids: [SUB, 'other'] })

    const retried = await callDelete(USER)

    expect(retried.status).toBe(200)
    expect(await redis.json.get(`slash_command:${USER}:reviewer`)).toMatchObject({ enabled_agent_ids: ['other'] })
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })
})

describe('DELETE /api/subagents/[id]: access lists (BL-187)', () => {
  it('scrubs the id from skill enable-lists and artifact allow-lists, as path-scoped writes', async () => {
    await seedSubagent()
    await redis.json.set(`slash_command:${USER}:reviewer`, '$', {
      id: 'reviewer',
      enabled_agent_ids: [SUB, 'primary'],
      content: 'unchanged'
    })
    await redis.json.set(`slash_command:${USER}:other`, '$', { id: 'other', enabled_agent_ids: ['primary'] })
    await redis.json.set('artifact:art1', '$', { id: 'art1', agent_allowlist: [SUB], title: 'unchanged' })
    await redis.sAdd(`user:${USER}:artifacts`, 'art1')

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(await redis.json.get(`slash_command:${USER}:reviewer`)).toEqual({
      id: 'reviewer',
      enabled_agent_ids: ['primary'],
      content: 'unchanged'
    })
    expect(await redis.json.get(`slash_command:${USER}:other`)).toEqual({ id: 'other', enabled_agent_ids: ['primary'] })
    expect(await redis.json.get('artifact:art1')).toEqual({ id: 'art1', agent_allowlist: [], title: 'unchanged' })
  })
})
