import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { withAgentProfileFolder } from '$lib/server/services/agentProfileFolderGate'
import { buildCliSubagentRuntimeId } from '$lib/utils/subagentSlug'

/**
 * BL-753: a Subagent edit racing its delete (Opie, 2026-09-28).
 *
 * The edit (`PUT /api/subagents/[id]`) reads the record, then writes it back whole. A write that
 * lands after the delete's `del` made the Subagent again, outside the user's Subagent list. The
 * edit's write now refuses a record that is gone (`JSON.SET … XX`) and answers 404.
 *
 * The delete removes the profile folder before the record (BL-157), so it holds the folder's turn
 * (`agentProfileFolderGate.ts`) from the folder removal until the record is gone: a write waiting
 * for that folder then finds no record and writes nothing. SA-139 R5: no save writes a profile any
 * more (a leftover CLI Subagent is delete-only), so the edits here are of an API Subagent and only
 * the delete of a leftover still takes the folder's turn.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis` (the `XX` write is RedisJSON's
 * own); the default lane's fake twin under plain `npm test`.
 */

const deleteManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/cliSubagentProfileSync')>()
  return {
    ...actual,
    deleteManagedCliSubagentProfile,
    planManagedCliSubagentProfileDeletion: vi.fn(async () => ({
      profileId: 'batshit_agent_subagent_cli-zcsubag_route', deleted: true, sharedWith: null, sharedWithKind: null
    }))
  }
})
// b34b0e201: the delete captures its slash-command write basis through EVAL first, and reaches
// other fixed Lua owners after it. The default lane's fake has no generic EVAL, so there those
// owners are held by the doubles shared with `subagent-delete-route.test.ts`; the real lane keeps
// the actual owners.
vi.mock('$lib/server/services/appActions/settings/authority', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).appActionsAuthorityDouble(await importOriginal(), 'default'))
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).slashCommandRevisionDouble(await importOriginal(), 'default'))
vi.mock('$lib/server/services/subjectPopulation', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).subjectPopulationDouble(await importOriginal(), 'default'))
vi.mock('$lib/server/services/artifactAgentAccessCleanup', async importOriginal =>
  (await import('$lib/test-utils/subagentDeleteRouteDoubles')).artifactAgentAccessCleanupDouble(await importOriginal(), 'default'))

useRedisTestServer()

const USER = 'zcsubag_user'
const SUB = 'zcsubag_route'
const SERVER = 'http://batshit-server.test:5613'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A live API Subagent, the one an edit can save; the delete's case seeds a leftover CLI one. */
const API_FIELDS = { subagentType: 'api', primary_model_provider: 'openai', primary_model_name: 'gpt-5.5' }
const CLI_LEFTOVER_FIELDS = { subagentType: 'cli', primary_model_provider: 'anthropic-claude-cli', primary_model_name: 'claude-cli' }

async function seedSubagent(fields: Record<string, unknown> = API_FIELDS) {
  await redis.json.set(`subagent:${SUB}`, '$', {
    id: SUB,
    user_id: USER,
    displayName: 'zcsubag route',
    slug: SUB,
    ...fields,
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z'
  })
  await redis.sAdd(`user:${USER}:subagents`, SUB)
}

/** The PUT, with `beforeBody` run where the route awaits the request body (after its read). */
async function callPut(updates: Record<string, unknown>, beforeBody: () => Promise<void> = async () => {}) {
  const { PUT } = await import('./+server')
  const request = {
    json: async () => {
      await beforeBody()
      return updates
    }
  }
  const response = (await PUT({ params: { id: SUB }, request, locals: { user: { id: USER } } } as any)) as Response
  return { status: response.status, body: await response.json() }
}

async function callDelete() {
  const { DELETE } = await import('./+server')
  return (await DELETE({ params: { id: SUB }, locals: { user: { id: USER } } } as any)) as Response
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'zcsubag-route-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === `${SERVER}/health` && method === 'GET') {
        return jsonResponse(200, { ok: true, service: 'batshit-server', checks: { http: true, redis: true } })
      }
      if (url === `${SERVER}/api/upload/avatar` && method === 'DELETE') {
        return jsonResponse(200, { success: true, deletedRecords: [], deletedFiles: [] })
      }
      throw new Error(`unexpected batshit-server call ${method} ${url}`)
    })
  )
  deleteManagedCliSubagentProfile.mockReset()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await redis.del(`subagent:${SUB}`)
  await redis.del(`user:${USER}:subagents`)
})

describe('PUT /api/subagents/[id] racing the delete (BL-753)', () => {
  it('control: an edit of a live Subagent writes the record', async () => {
    await seedSubagent()

    const { status, body } = await callPut({ description: 'edited' })

    expect(status).toBe(200)
    expect(body.subagent.description).toBe('edited')
    expect(((await redis.json.get(`subagent:${SUB}`)) as any).description).toBe('edited')
  })

  it('an edit whose write lands after the delete does not bring the record back, and answers 404', async () => {
    await seedSubagent()

    // The delete's record steps land between the edit's read and its write.
    const { status, body } = await callPut({ description: 'edited' }, async () => {
      await redis.sRem(`user:${USER}:subagents`, SUB)
      await redis.del(`subagent:${SUB}`)
    })

    expect(status).toBe(404)
    expect(body.error).toMatch(/not found|deleted/i)
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual([])
  })
})

describe('DELETE /api/subagents/[id] holds the profile folder until the record is gone (BL-753)', () => {
  it('a folder write waiting behind the folder removal runs only once the record is gone', async () => {
    await seedSubagent(CLI_LEFTOVER_FIELDS)
    const { buildAgentProfileId } = await import('$lib/server/services/managedProfileIdentity')
    const profileId = buildAgentProfileId(buildCliSubagentRuntimeId(SUB))
    let folderRemoved!: () => void
    const removed = new Promise<void>((resolve) => {
      folderRemoved = resolve
    })
    deleteManagedCliSubagentProfile.mockImplementation(async () => {
      folderRemoved()
      // Leave the test time to queue its write for this folder before the delete goes on.
      await sleep(50)
      return { profileId, deleted: true, sharedWith: null, sharedWithKind: null }
    })

    const deletion = callDelete()
    await removed
    // A write for this folder, queued after the removal (from the test's own context, not the
    // delete's). What it sees is what a fresh record check would see.
    const write = withAgentProfileFolder(profileId, async () => redis.json.get(`subagent:${SUB}`))

    const response = await deletion
    expect(response.status).toBe(200)
    expect(await write).toBeNull()
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })
})
