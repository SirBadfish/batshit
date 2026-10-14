import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { pinHostCommandOwner, prepareHostCommand } from '$lib/server/services/hostCommandOwnership'
import {
  SUBAGENT_DELETED_ABORT_REASON,
  beginSubagentRun,
  hasRunningSubagentRun,
  isSubagentDeletedError
} from '$lib/server/services/subagentRunRegistry'

/**
 * BL-287 (2026-09-27): deleting a Subagent stops its delegated runs first and waits until each
 * has ended (its CLI too), BEFORE its managed profile folder goes. Before, the delete removed
 * the folder while the Subagent's CLI still ran, and the CLI wrote into it again. Only that
 * Subagent's runs are stopped: another Subagent's run is never touched.
 */

const events: string[] = []

const deleteManagedCliSubagentProfile = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => null),
  // BL-753: the delete holds its profile folder's turn; not what this suite tests.
  holdManagedCliSubagentProfileFolder: async (_subagent: unknown, action: () => Promise<unknown>) => action(),
  deleteManagedCliSubagentProfile,
  planManagedCliSubagentProfileDeletion: vi.fn(async () => ({
    profileId: 'batshit_agent_subagent_cli_run_probe', deleted: true, sharedWith: null, sharedWithKind: null
  }))
}))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: vi.fn(async () => {}) }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))
// The route's 30 s bound, shortened per test; everything else is the real registry.
const stopBound = vi.hoisted(() => ({ ms: 30_000 }))
vi.mock('$lib/server/services/subagentRunRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/subagentRunRegistry')>()
  return {
    ...actual,
    stopSubagentRunsForDelete: (userId: string, subagentId: string, options = {}) =>
      actual.stopSubagentRunsForDelete(userId, subagentId, { ...options, timeoutMs: stopBound.ms })
  }
})

useRedisTestServer()

const USER = 'user-subagent-delete-run-stop'
const SUB = 'zc_run_sub'
const OTHER = 'zc_run_other'
const SERVER = 'http://batshit-server.test:5613'

async function seedSubagent(id: string) {
  await redis.json.set(`subagent:${id}`, '$', { id, user_id: USER, displayName: id, subagentType: 'cli' })
  await redis.sAdd(`user:${USER}:subagents`, id)
}

async function callDelete(id = SUB) {
  const { DELETE } = await import('./+server')
  return DELETE({ params: { id }, locals: { user: { id: USER } } } as any)
}

/**
 * A run the way the runner holds one: its signal stops the "CLI", which takes `shutdownMs` to
 * exit after the stop (the lane's work settles only then; `null` never exits on its own), and
 * the call itself ends at once.
 */
async function startRun(id: string, shutdownMs: number | null) {
  const handle = await beginSubagentRun({ userId: USER, subagentId: id, label: id })
  let exit!: () => void
  const cli = new Promise<void>((resolve) => {
    exit = () => {
      events.push(`${id} CLI exited`)
      resolve()
    }
  })
  handle.signal.addEventListener(
    'abort',
    () => {
      events.push(`${id} stopped (${String(handle.signal.reason)})`)
      if (shutdownMs !== null) setTimeout(exit, shutdownMs)
    },
    { once: true }
  )
  handle.track(cli)
  handle.end()
  return { handle, exit }
}

beforeEach(() => {
  events.length = 0
  stopBound.ms = 30_000
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'route-test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${SERVER}/health`) {
        return Response.json({ ok: true, checks: { http: true, redis: true } })
      }
      if (url === `${SERVER}/api/upload/avatar` && init?.method === 'DELETE') {
        events.push('avatar sweep')
        return Response.json({ success: true, deletedRecords: [], deletedFiles: [] })
      }
      throw new Error(`unexpected call ${url}`)
    })
  )
  deleteManagedCliSubagentProfile.mockReset()
  deleteManagedCliSubagentProfile.mockImplementation(async (_userId: string, subagent: { id: string }) => {
    events.push(`profile folder deleted (${subagent.id} running: ${hasRunningSubagentRun(USER, subagent.id)})`)
    return { profileId: `batshit_agent_subagent_cli_${subagent.id}`, deleted: true, sharedWith: null, sharedWithKind: null }
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('DELETE /api/subagents/[id] stops the Subagent’s own runs first (BL-287)', () => {
  it('stops a preparing run before checking its durable pre-spawn record', async () => {
    await seedSubagent(SUB)
    const run = await beginSubagentRun({ userId: USER, subagentId: SUB, label: SUB })
    const pin = pinHostCommandOwner({ userId: USER, kind: 'subagent', id: SUB })
    const lease = await prepareHostCommand(pin, { kind: 'codex', program: '/bin/codex' })
    run.signal.addEventListener('abort', () => {
      events.push('preparing run stopped')
      lease.abortBeforeSpawn()
      run.end()
    }, { once: true })

    const response = await callDelete()

    expect(response.status).toBe(200)
    expect(run.signal.reason).toBe(SUBAGENT_DELETED_ABORT_REASON)
    expect(events).toEqual([
      'preparing run stopped',
      `profile folder deleted (${SUB} running: false)`,
      'avatar sweep'
    ])
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })

  it('stops the run, waits for its CLI to exit, and only then deletes the profile folder', async () => {
    await seedSubagent(SUB)
    const run = await startRun(SUB, 150)

    const response = await callDelete()

    expect(response.status).toBe(200)
    expect(run.handle.signal.reason).toBe(SUBAGENT_DELETED_ABORT_REASON)
    expect(run.handle.stoppedForDelete()).toBe(true)
    expect(events).toEqual([
      `${SUB} stopped (subagent_deleted)`,
      `${SUB} CLI exited`,
      `profile folder deleted (${SUB} running: false)`,
      'avatar sweep'
    ])
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })

  it('never touches another Subagent’s run', async () => {
    await seedSubagent(SUB)
    await seedSubagent(OTHER)
    const other = await startRun(OTHER, 10)

    const response = await callDelete()

    expect(response.status).toBe(200)
    expect(other.handle.signal.aborted).toBe(false)
    expect(hasRunningSubagentRun(USER, OTHER)).toBe(true)
    other.exit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hasRunningSubagentRun(USER, OTHER)).toBe(false)
    await redis.del(`subagent:${OTHER}`)
  })

  it('a run that starts while the delete runs is refused, and so is one after it', async () => {
    await seedSubagent(SUB)
    let during: unknown = null
    deleteManagedCliSubagentProfile.mockImplementationOnce(async () => {
      during = await beginSubagentRun({ userId: USER, subagentId: SUB, label: 'Route probe' }).catch((error) => error)
      return { profileId: 'x', deleted: true, sharedWith: null, sharedWithKind: null }
    })

    expect((await callDelete()).status).toBe(200)

    expect(isSubagentDeletedError(during)).toBe(true)
    // A turn that loaded the Subagent before its delete and calls it afterwards.
    const after = await beginSubagentRun({ userId: USER, subagentId: SUB, label: 'Route probe' }).catch((error) => error)
    expect(isSubagentDeletedError(after)).toBe(true)
    expect(hasRunningSubagentRun(USER, SUB)).toBe(false)
  })

  it('a run still stopping at the bound: 409 and nothing deleted; a retry once it ended deletes', async () => {
    await seedSubagent(SUB)
    const stuck = await startRun(SUB, null)
    stopBound.ms = 200

    const refused = await callDelete()
    const body = await refused.json()

    expect(refused.status).toBe(409)
    expect(body.code).toBe('subagent_run_still_stopping')
    expect(body.error).toContain('nothing was deleted')
    expect(deleteManagedCliSubagentProfile).not.toHaveBeenCalled()
    expect(await redis.json.get(`subagent:${SUB}`)).not.toBeNull()

    stuck.exit()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const retried = await callDelete()

    expect(retried.status).toBe(200)
    expect(await redis.json.get(`subagent:${SUB}`)).toBeNull()
  })

  it('a second delete while one runs is refused with 409', async () => {
    await seedSubagent(SUB)
    const run = await startRun(SUB, 200)

    const [first, second] = await Promise.all([callDelete(), callDelete()])
    const statuses = [first.status, second.status].sort()

    expect(statuses).toEqual([200, 409])
    const refused = first.status === 409 ? first : second
    expect((await refused.json()).code).toBe('subagent_delete_in_progress')
    expect(run.handle.stoppedForDelete()).toBe(true)
  })
})
