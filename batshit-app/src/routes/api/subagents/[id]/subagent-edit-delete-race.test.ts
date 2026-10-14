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
 * (`agentProfileFolderGate.ts`) from the folder removal until the record is gone: a sync waiting
 * for that folder then finds no record and writes nothing.
 *
 * Drives the real route. Real Redis 8 under `npm run test:redis` (the `XX` write is RedisJSON's
 * own); the default lane's fake twin under plain `npm test`.
 */

const syncManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
const deleteManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/cliSubagentProfileSync')>()
  return {
    ...actual,
    syncManagedCliSubagentProfile,
    deleteManagedCliSubagentProfile,
    planManagedCliSubagentProfileDeletion: vi.fn(async () => ({
      profileId: 'batshit_agent_subagent_cli-zcsubag_route', deleted: true, sharedWith: null, sharedWithKind: null
    }))
  }
})
vi.mock('$lib/server/services/codexProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/codexProfileManager')>()
  return { ...actual, syncAgentCodexProfiles: vi.fn(async () => {}) }
})
vi.mock('$lib/server/services/claudeProfileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/claudeProfileManager')>()
  return { ...actual, syncAgentClaudeProfiles: vi.fn(async () => {}) }
})
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

useRedisTestServer()

const USER = 'zcsubag_user'
const SUB = 'zcsubag_route'
const SERVER = 'http://batshit-server.test:5613'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function seedSubagent() {
  await redis.json.set(`subagent:${SUB}`, '$', {
    id: SUB,
    user_id: USER,
    displayName: 'zcsubag route',
    slug: SUB,
    subagentType: 'cli',
    primary_model_provider: 'openai-codex',
    primary_model_name: 'codex-cli',
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
  syncManagedCliSubagentProfile.mockReset()
  syncManagedCliSubagentProfile.mockImplementation(async () => ({ runtime: 'codex', profileId: 'p', written: true }))
  deleteManagedCliSubagentProfile.mockReset()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await redis.del(`subagent:${SUB}`)
  await redis.del(`user:${USER}:subagents`)
})

describe('PUT /api/subagents/[id] racing the delete (BL-753)', () => {
  it('control: an edit of a live Subagent writes the record and syncs its profile', async () => {
    await seedSubagent()

    const { status, body } = await callPut({ description: 'edited' })

    expect(status).toBe(200)
    expect(body.subagent.description).toBe('edited')
    expect(((await redis.json.get(`subagent:${SUB}`)) as any).description).toBe('edited')
    expect(syncManagedCliSubagentProfile).toHaveBeenCalledTimes(1)
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
    expect(syncManagedCliSubagentProfile).not.toHaveBeenCalled()
  })

  it('an edit whose profile sync finds the Subagent deleted answers 404', async () => {
    await seedSubagent()
    syncManagedCliSubagentProfile.mockImplementation(async () => ({ runtime: 'codex', profileId: 'p', written: false }))

    const { status } = await callPut({ description: 'edited' })

    expect(status).toBe(404)
  })
})

describe('DELETE /api/subagents/[id] holds the profile folder until the record is gone (BL-753)', () => {
  it('a folder write waiting behind the folder removal runs only once the record is gone', async () => {
    await seedSubagent()
    const { buildAgentProfileId } = await import('$lib/server/services/codexProfileManager')
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
    // A profile sync's write for this folder, queued after the removal (from the test's own
    // context, not the delete's). What it sees is what a sync's fresh record check would see.
    const write = withAgentProfileFolder(profileId, async () => redis.json.get(`subagent:${SUB}`))

    const response = await deletion
    expect(response.status).toBe(200)
    expect(await write).toBeNull()
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })
})
