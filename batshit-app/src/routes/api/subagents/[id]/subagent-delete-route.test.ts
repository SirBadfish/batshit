import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { commitSlashCommandAgentAccess, SlashCommandMutationError } from '$lib/server/services/slashCommandRevision'
import { deleteSubagentPopulation } from '$lib/server/services/subjectPopulation'
import { withSettingsRecordReplacement, withSettingsRestoreFence } from '$lib/server/services/appActions/settings/lifecycle'
import { pinHostCommandOwner, prepareHostCommand } from '$lib/server/services/hostCommandOwnership'
import { ArtifactAccessCleanupUnknownError, removeArtifactAgentReferences } from '$lib/server/services/artifactAgentAccessCleanup'

// The fixed five-path Lua owner is qualified by its actual 13-case Redis suite.
// Here its boundary is held/scripted to test the real deletion caller and custody.
vi.mock('$lib/server/services/artifactAgentAccessCleanup', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).artifactAgentAccessCleanupDouble(await importOriginal()))

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
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))

// Authority sweep has its own actual owner proof; this default route fixture has no Lua client.
vi.mock('$lib/server/services/appActions/settings/authority', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).appActionsAuthorityDouble(await importOriginal()))
// Route ordering/custody only. Physical fixed Lua owners have exclusive real-Redis suites.
// The doubles are shared with the other Subagent delete-route suites.
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).slashCommandRevisionDouble(await importOriginal()))
vi.mock('$lib/server/services/subjectPopulation', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).subjectPopulationDouble(await importOriginal()))

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
  vi.mocked(removeArtifactAgentReferences).mockReset().mockImplementation(async (args, context) => {
    context.checkBeforeIssue()
    // Legacy top-level fixtures retain their prior assertion. The actual five-path
    // transformation is proved in the helper's real suite, not reimplemented here.
    const row = await redis.json.get(`artifact:${args.artifactId}`) as { agent_allowlist?: unknown[] } | null
    const list = row?.agent_allowlist
    if (!Array.isArray(list) || !list.includes(args.agentId)) return { status: 'unchanged' }
    context.checkBeforeIssue()
    await redis.json.set(`artifact:${args.artifactId}`, '$.agent_allowlist', list.filter(id => id !== args.agentId) as never)
    const removed = list.filter(id => id === args.agentId).length
    context.onChanged({ removed, scopePinned: false })
    return { status: 'changed', removed, scopePinned: false, notification: 'recorded' }
  })
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
  vi.mocked(commitSlashCommandAgentAccess).mockClear()
  vi.mocked(deleteSubagentPopulation).mockClear()
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
    expect(deleteSubagentPopulation).toHaveBeenCalledWith(expect.anything(), { userId: USER, subjectId: SUB, expectedCatalogueRevision: null })
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
    await redis.json.set(`slash_command:${USER}:legacy_exact`, '$', { id: 'legacy_exact', enabled_agent_ids: ['odd.id', 'odd_id', 7] } as never)
    await redis.json.set(`skill_source:${USER}:legacy_exact`, '$', { id: 'legacy_exact', enabled_agent_ids: ['odd.id', 'odd_id', []] } as never)

    const response = await callDelete(USER, 'odd.id')

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, PROFILE])
    expect(await redis.json.get('subagent:odd.id')).toBeNull()
    expect(await redis.json.get(`slash_command:${USER}:legacy_exact`)).toMatchObject({ enabled_agent_ids: ['odd_id', 7] })
    expect(await redis.json.get(`skill_source:${USER}:legacy_exact`)).toMatchObject({ enabled_agent_ids: ['odd_id', []] })
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

  // SA-139 R2 (D14): no migration, so a record of a removed n8n Subagent type stays until its
  // owner deletes it; DELETE is the one route that still acts on it, assignments included.
  it('deletes a Subagent of a removed n8n type and its assignments like any other', async () => {
    await seedSubagent({ subagentType: 'n8n-workflow', webhookUrl: 'https://n8n.example/webhook/old' })
    await seedAgent('primary', { assigned_subagent_ids: [SUB, 'keep_me'], assignedSubagents: [SUB] })

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual([])
    expect(await redis.json.get('agent:primary')).toMatchObject({ assigned_subagent_ids: ['keep_me'], assignedSubagents: [] })
  })

  // SA-139 R5 (D14): a leftover CLI Subagent (Claude Code or Codex) is delete-only. Every other
  // route refuses it, so this delete must still act on it: its profile folder, its assignments
  // and its record all go.
  it.each([
    ['Claude Code CLI', { primary_model_provider: 'claude-cli', primary_model_name: 'claude-cli' }],
    ['Codex CLI', { primary_model_provider: 'openai-codex', primary_model_name: 'codex-cli' }]
  ])('deletes a leftover %s Subagent with its profile folder and its assignments', async (_name, fields) => {
    await seedSubagent({ subagentType: 'cli', ...fields })
    await seedAgent('primary', { assigned_subagent_ids: [SUB, 'keep_me'], assignedSubagents: [SUB] })

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(events).toEqual([HEALTH, PROFILE, SWEEP])
    expect(deleteManagedCliSubagentProfile).toHaveBeenCalledWith(USER, expect.objectContaining({ id: SUB, subagentType: 'cli', ...fields }))
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual([])
    expect(await redis.json.get('agent:primary')).toMatchObject({ assigned_subagent_ids: ['keep_me'], assignedSubagents: [] })
  })

  // SA-139 R4 removed the primaries' profile sync that followed this delete.
  it('asks for the profile folder with the stored Subagent', async () => {
    await seedSubagent({ slug: 'custom_slug' })

    const response = await callDelete(USER)

    expect(response.status).toBe(200)
    expect(deleteManagedCliSubagentProfile).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ id: SUB, slug: 'custom_slug' })
    )
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
    // BL-607: fail the exact ordinary-skill scan at its actual client, on both
    // lanes. Earlier plugin scans pass through; call-order drift cannot move
    // this error to another cleanup family.
    const execute = redis.execute
    let reached = false
    ;(redis as any).execute = async (operation: (client: any) => unknown) =>
      execute.call(redis, async (client: any) => operation(new Proxy(Object.create(null), {
        get(_target, property) {
          if (property === 'keys') return async (pattern: string) => {
            if (!reached && pattern === `slash_command:${USER}:*`) {
              reached = true
              throw new Error('Socket closed unexpectedly')
            }
            return client.keys(pattern)
          }
          const value = Reflect.get(client, property, client)
          return typeof value === 'function' ? value.bind(client) : value
        },
        has(_target, property) { return property in client }
      })))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    const refused = await callDelete(USER).finally(() => {
      ;(redis as any).execute = execute
      quiet.mockRestore()
    })
    const body = await refused.json()

    expect(reached).toBe(true)

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


describe('required command/source cleanup outcomes under the actual replacement fence', () => {
  it('finishes metadata cleanup while the subject still exists, before final deletion', async () => {
    await seedSubagent()
    await redis.json.set('artifact:legacy-artifact', '$', { metadata: { assignedAgentIds: [SUB] } })
    await redis.sAdd(`user:${USER}:artifacts`, 'legacy-artifact')
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (args, context) => {
      expect(args).toEqual({ userId: USER, artifactId: 'legacy-artifact', agentId: SUB })
      expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
      context.checkBeforeIssue()
      await redis.json.set('artifact:legacy-artifact', '$.metadata.assignedAgentIds', [])
      context.onChanged({ removed: 1, scopePinned: true })
      return { status: 'changed', removed: 1, scopePinned: true, notification: 'recorded' }
    })
    expect((await callDelete(USER)).status).toBe(200)
    expect(await redis.json.get('artifact:legacy-artifact')).toEqual({ metadata: { assignedAgentIds: [] } })
    expect(vi.mocked(removeArtifactAgentReferences).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deleteSubagentPopulation).mock.invocationCallOrder[0])
  })

  it('accepts only the exact missing-Artifact refusal as confirmed absence', async () => {
    await seedSubagent()
    await redis.sAdd(`user:${USER}:artifacts`, 'already-deleted')
    vi.mocked(removeArtifactAgentReferences).mockResolvedValueOnce({ status: 'refused', reason: 'artifact_missing' })
    expect((await callDelete(USER)).status).toBe(200)
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })

  it.each(['artifact_unreadable', 'conflict', 'read_unavailable'] as const)('retains the subject on %s and settles known refusal custody', async reason => {
    await seedSubagent()
    await redis.sAdd(`user:${USER}:artifacts`, 'unreadable')
    vi.mocked(removeArtifactAgentReferences).mockResolvedValueOnce({ status: 'refused', reason })
    const response = await callDelete(USER)
    expect(response.status).toBe(409)
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
    await expect(withSettingsRecordReplacement(`subagent:${SUB}`, async () => 'settled')).resolves.toBe('settled')
  })

  it('keeps all three untyped families for a legacy same-ID Primary', async () => {
    await seedSubagent()
    await seedAgent(SUB, {})
    await redis.json.set(`slash_command:${USER}:shared`, '$', { enabled_agent_ids: [SUB] })
    await redis.json.set(`skill_source:${USER}:shared`, '$', { enabled_agent_ids: [SUB] })
    await redis.sAdd(`user:${USER}:artifacts`, 'shared')
    expect((await callDelete(USER)).status).toBe(200)
    expect(removeArtifactAgentReferences).not.toHaveBeenCalled()
    expect(await redis.json.get(`slash_command:${USER}:shared`)).toEqual({ enabled_agent_ids: [SUB] })
    expect(await redis.json.get(`skill_source:${USER}:shared`)).toEqual({ enabled_agent_ids: [SUB] })
    expect(await redis.json.get(`agent:${SUB}`)).not.toBeNull()
  })

  it('reports known progress when a later Artifact refuses or notification fails', async () => {
    await seedSubagent()
    await redis.sAdd(`user:${USER}:artifacts`, ['first', 'second'])
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (_args, context) => {
      context.checkBeforeIssue(); context.onChanged({ removed: 3, scopePinned: true })
      return { status: 'changed', removed: 3, scopePinned: true, notification: 'recorded' }
    }).mockResolvedValueOnce({ status: 'changed', removed: 2, scopePinned: false, notification: 'failed' })
    const response = await callDelete(USER)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ outcome: 'progress_unavailable', cleanup: { changedArtifacts: 2, removedReferences: 5 } })
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    await expect(withSettingsRecordReplacement(`subagent:${SUB}`, async () => 'settled')).resolves.toBe('settled')
  })

  it('refuses an original preparation after restore, synchronously before the held helper issues', async () => {
    await seedSubagent()
    await redis.sAdd(`user:${USER}:artifacts`, 'held')
    let entered!: () => void; let release!: () => void
    const atIssue = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let issued = false
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (_args, context) => {
      entered(); await held; context.checkBeforeIssue(); issued = true
      return { status: 'unchanged' }
    })
    const deleting = callDelete(USER)
    await atIssue
    // Restore marks its epoch immediately, then drains the held exact-subject lease.
    const restoring = withSettingsRestoreFence(async () => 'restored')
    release()
    const response = await deleting
    expect(response.status).toBe(409)
    expect(issued).toBe(false)
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    expect(await restoring).toBe('restored')
  })

  it('retains prior confirmed cleanup and exact custody for one later unknown Artifact without replay', async () => {
    const id = `${SUB}_artifact_unknown`
    await seedSubagent({}, id)
    await redis.sAdd(`user:${USER}:artifacts`, ['known', 'unknown'])
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (_args, context) => {
      context.checkBeforeIssue(); context.onChanged({ removed: 2, scopePinned: false })
      return { status: 'changed', removed: 2, scopePinned: false, notification: 'recorded' }
    }).mockRejectedValueOnce(new ArtifactAccessCleanupUnknownError())
    const response = await callDelete(USER, id)
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_UNCONFIRMED', outcome: 'unknown', cleanup: { changedArtifacts: 1, removedReferences: 2 } })
    expect(body.error).not.toMatch(/try again/i)
    expect(removeArtifactAgentReferences).toHaveBeenCalledTimes(2)
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`subagent:${id}`)).not.toBeNull()
    await expect(withSettingsRecordReplacement(`subagent:${id}`, async () => 'must-not-run')).rejects.toThrow('unknown outcome')
    await expect(withSettingsRestoreFence(async () => 'must-not-run')).rejects.toThrow('unknown outcome')
  })

  it('requires the five-path Artifact owner before final deletion and retains an unowned indexed Artifact', async () => {
    await seedSubagent()
    await redis.sAdd(`user:${USER}:artifacts`, 'legacy-artifact')
    vi.mocked(removeArtifactAgentReferences).mockResolvedValueOnce({ status: 'refused', reason: 'artifact_not_owned' })
    const response = await callDelete(USER)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_REFUSED' })
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
  })

  it('retains a confirmed scrub count when the original guard refuses the next issue', async () => {
    await seedSubagent()
    await redis.sAdd(`user:${USER}:artifacts`, ['saved', 'held'])
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (_args, context) => {
      context.checkBeforeIssue(); context.onChanged({ removed: 4, scopePinned: false })
      return { status: 'changed', removed: 4, scopePinned: false, notification: 'recorded' }
    }).mockRejectedValueOnce(new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'Original preparation refused.', 'not_written'))
    const response = await callDelete(USER)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ outcome: 'refused', cleanup: { changedArtifacts: 1, removedReferences: 4 } })
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    await expect(withSettingsRecordReplacement(`subagent:${SUB}`, async () => 'settled')).resolves.toBe('settled')
  })
  it('keeps absent universal lists and source siblings while using the source cleanup owner', async () => {
    await seedSubagent()
    await redis.json.set(`slash_command:${USER}:legacy`, '$', { id: 'legacy', content: 'keep' })
    await redis.json.set(`skill_source:${USER}:owned`, '$', { id: 'owned', enabled_agent_ids: [SUB, 'A-B'], root_path: '/keep' })
    await redis.json.set(`skill_source:${USER}:legacy`, '$', { id: 'legacy', root_path: '/also-keep' })
    expect((await callDelete(USER)).status).toBe(200)
    expect(await redis.json.get(`slash_command:${USER}:legacy`)).toEqual({ id: 'legacy', content: 'keep' })
    expect(await redis.json.get(`skill_source:${USER}:owned`)).toEqual({ id: 'owned', enabled_agent_ids: ['A-B'], root_path: '/keep' })
    expect(await redis.json.get(`skill_source:${USER}:legacy`)).toEqual({ id: 'legacy', root_path: '/also-keep' })
  })

  it('settles a proven no-effect refusal, retains the record, and does not call final deletion', async () => {
    await seedSubagent()
    await redis.json.set(`slash_command:${USER}:reviewer`, '$', { id: 'reviewer', enabled_agent_ids: [SUB] })
    vi.mocked(commitSlashCommandAgentAccess).mockRejectedValueOnce(new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'Access changed during cleanup; earlier profile cleanup may have completed.', 'not_written'))
    const response = await callDelete(USER)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'SLASH_COMMAND_CONFLICT' })
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
    await expect(withSettingsRecordReplacement(`subagent:${SUB}`, async () => 'settled')).resolves.toBe('settled')
  })

  // Final case: this deliberately retains unresolved process-local custody.
  it('holds exact replacement and restore after an issued unknown, with no final delete or retry language', async () => {
    await seedSubagent()
    await redis.json.set(`slash_command:${USER}:reviewer`, '$', { id: 'reviewer', enabled_agent_ids: [SUB] })
    vi.mocked(commitSlashCommandAgentAccess).mockRejectedValueOnce(new SlashCommandMutationError('SLASH_COMMAND_UNCONFIRMED', 'The access write may have reached storage. Do not retry it.', 'unknown'))
    const response = await callDelete(USER)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'SLASH_COMMAND_UNCONFIRMED' })
    expect(deleteSubagentPopulation).not.toHaveBeenCalled()
    expect(commitSlashCommandAgentAccess).toHaveBeenCalledTimes(1)
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()
    await expect(withSettingsRecordReplacement(`subagent:${SUB}`, async () => 'must-not-run')).rejects.toThrow('unknown outcome')
    await expect(withSettingsRestoreFence(async () => 'must-not-run')).rejects.toThrow('unknown outcome')
  })
})
