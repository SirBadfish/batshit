import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { failRedisJsonGets, stopFailingRedisJsonGets } from '$lib/test-utils/failRedisJsonGets'
import { randomUUID } from 'node:crypto'
import { pinHostCommandOwner, prepareHostCommand } from '$lib/server/services/hostCommandOwnership'
import { readHostBootIdentity } from '$lib/server/services/hostProcessIdentity'
import { removeArtifactAgentReferences, ArtifactAccessCleanupUnknownError } from '$lib/server/services/artifactAgentAccessCleanup'
import { deletePrimaryPopulation, SubjectPopulationError } from '$lib/server/services/subjectPopulation'
import { captureSlashCommandWriteBasis } from '$lib/server/services/slashCommandRevision'
import { slashCommandPreparationState } from '$lib/server/services/slashCommandRevisionProtocol'
import { withSettingsRecordReplacement, withSettingsRestoreFence } from '$lib/server/services/appActions/settings/lifecycle'

vi.mock('$lib/server/services/artifactAgentAccessCleanup', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/artifactAgentAccessCleanup')>(),
  removeArtifactAgentReferences: vi.fn(async (_args, context) => { context.checkBeforeIssue(); return { status: 'unchanged' } })
}))
vi.mock('$lib/server/services/slashCommandRevision', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/slashCommandRevision')>(),
  captureSlashCommandWriteBasis: vi.fn(async preparation => {
    const state = slashCommandPreparationState(preparation)
    if (state.revision === undefined) state.revision = null
    return Object.freeze({})
  }),
  captureSkillSourceWriteBasis: vi.fn(async () => Object.freeze({})),
  removeExplicitSkillSourceAgentAccess: vi.fn(async () => false)
}))
vi.mock('$lib/server/services/agentAccessLists', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/agentAccessLists')>(),
  removeExplicitSlashCommandAgentAccess: vi.fn(async () => false)
}))
vi.mock('$lib/server/services/subjectPopulation', async importOriginal => ({
  ...await importOriginal<typeof import('$lib/server/services/subjectPopulation')>(),
  deletePrimaryPopulation: vi.fn(async (client, subject) => {
    await client.sRem(`user:${subject.userId}:agents`, subject.subjectId)
    await client.del(`agent:${subject.subjectId}`)
    return 'DELETED'
  })
}))

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
vi.mock('$lib/server/services/managedProfileFolderDelete', () => ({
  deleteManagedProfileFolder: vi.fn(async () => {})
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

let reasoningProofPoolId: string | undefined
beforeAll(() => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') return
  reasoningProofPoolId = process.env.VITEST_POOL_ID
  process.env.VITEST_POOL_ID = '0'
})
afterAll(() => {
  if (process.env.VITEST_USE_REAL_REDIS !== 'true') return
  if (reasoningProofPoolId === undefined) delete process.env.VITEST_POOL_ID
  else process.env.VITEST_POOL_ID = reasoningProofPoolId
})
useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  expect(new URL(resolvedUrl).pathname).toBe('/15')
  expect((await adminClient.clientInfo()).db).toBe(15)
} })

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
  stopFailingRedisJsonGets()
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
    // A `codex` run record left by the retired Codex CLI lane, as that app saved it: nothing
    // writes one any more, but its deletion still reads and retires it.
    pin.store.prepare({
      version: 1, runId: randomUUID(), kind: 'codex', resources: pin.resources,
      ...await readHostBootIdentity(), instanceId: 'previous-app', lane: 'mac',
      owner: pin.owner, profileId: pin.profileId, sessionId: null, messageId: null, program: 'codex',
      phase: 'running', processes: [{ pid: 999999999, parent: 1, group: 999999999, started: 'old-birth', state: 'S', program: 'old-codex' }]
    }, pin.generations)

    const response = await callDelete(USER, '', agentId)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.notice).toMatch(/each program it recorded for the old run has ended/)
    expect(await redis.get(`agent:${agentId}`)).toBeNull()
  })

  it('checks batshit-server, then asks it to delete the avatars, BEFORE the agent record goes', async () => {
    const { reasoningOverrideKey } = await import('$lib/utils/modelReasoningControls')
    const reasoningKey = reasoningOverrideKey({ presetId: 'fixture', connection: { type: 'direct', id: 'direct:openai', service: 'openai' }, effectiveModelId: 'gpt-6.1-sol' }, 'effort')
    await seedAgent({ model_reasoning_overrides: { [reasoningKey]: { mode: 'value', value: 'max' } } })

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

  describe('SA-139 (D10): the agent\'s Claude plan runs', () => {
    const claudePlanRun = (agentId: string, settlement: 'exited' | 'unknown' = 'exited') => {
      let settle!: (value: 'exited' | 'unknown') => void
      const run = {
        owner: { userId: USER, sessionId: 'some-chat', agentId, kind: 'primary' as const },
        settled: new Promise<'exited' | 'unknown'>(resolve => { settle = resolve }),
        exited: new Promise<void>(() => {}),
        isEnded: false,
        // The exit comes later than the stop, so a delete that did not wait for it would be caught.
        stop: vi.fn(() => { events.push(`run stopped ${agentId}`); run.isEnded = true; setTimeout(() => { events.push(`run exited ${agentId}`); settle(settlement) }, 30) })
      }
      return run
    }
    afterEach(async () => {
      const { resetClaudePlanRunRegistryForTests } = await import('$lib/server/services/claudePlanRunRegistry')
      resetClaudePlanRunRegistryForTests()
    })

    it('end and settle before the chats and the agent go; another agent\'s run is left alone', async () => {
      const { registerClaudePlanRun } = await import('$lib/server/services/claudePlanRunRegistry')
      await seedAgent()
      const mine = claudePlanRun(AGENT)
      const other = claudePlanRun('another_agent')
      registerClaudePlanRun(mine as any)
      registerClaudePlanRun(other as any)
      deleteAgentChats.mockImplementation(async () => { events.push('chats'); return { deleted: [], keptLocked: [] } })

      const response = await callDelete(USER, '?chats=1')

      expect(response.status).toBe(200)
      expect(events.indexOf(`run stopped ${AGENT}`)).toBeGreaterThan(-1)
      expect(events.indexOf(`run exited ${AGENT}`)).toBeGreaterThan(events.indexOf(`run stopped ${AGENT}`))
      expect(events.indexOf(`run exited ${AGENT}`)).toBeLessThan(events.indexOf('chats'))
      expect(other.stop).not.toHaveBeenCalled()
    })

    it('keep the agent and its chats (409) while a Claude Code exit cannot be confirmed', async () => {
      const { registerClaudePlanRun } = await import('$lib/server/services/claudePlanRunRegistry')
      await seedAgent()
      registerClaudePlanRun(claudePlanRun(AGENT, 'unknown') as any)

      const response = await callDelete(USER, '?chats=1')
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body.code).toBe('claude_plan_run_still_stopping')
      expect(deleteAgentChats).not.toHaveBeenCalled()
      expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
    })
  })

  // BL-642: `redis.get` answers null for a failed read (the same answer as a missing key), so the
  // route's first read said "Agent not found" for a Redis error. It reads with `redis.json.get`,
  // which throws, so the failure is answered as one and nothing is deleted.
  async function expectReadFailureAnswered(inject: () => { failures?: number; stop: () => void }) {
    await seedAgent()
    const failing = inject()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await callDelete(USER, '?chats=1')
    const body = await response.json()
    failing.stop()
    errorLog.mockRestore()

    expect(response.status).toBe(500)
    expect(body.error).not.toMatch(/not found/i)
    expect(body.error).toMatch(/Failed to delete agent/)
    // Nothing was asked of batshit-server and nothing was deleted, chats included.
    expect(events).toEqual([])
    expect(deleteAgentChats).not.toHaveBeenCalled()
    expect(await redis.get(`agent:${AGENT}`)).not.toBeNull()
    return failing
  }

  it('a failed read of the agent answers the error, not "Agent not found", and deletes nothing (BL-642)', async () => {
    const spy = vi.spyOn(redis.json, 'get').mockImplementation(async (key: string) => {
      if (key === `agent:${AGENT}`) throw new Error('Redis read failed (injected by the test)')
      return null
    })
    let readKeys: unknown[] = []
    await expectReadFailureAnswered(() => ({
      stop: () => {
        readKeys = spy.mock.calls.map(([key]) => key)
        spy.mockRestore()
      }
    }))
    expect(readKeys).toContain(`agent:${AGENT}`)
  })

  // The faithful reproduction needs the real facade, whose `redis.get` swallows a read error; the
  // default lane's fake does not. Run it with `npm run test:redis`-style env on a scratch Redis.
  it.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('a failed JSON.GET inside the real read answers the error (BL-642, real Redis)', async () => {
    const failing = await expectReadFailureAnswered(() => failRedisJsonGets((key) => key === `agent:${AGENT}`))
    expect(failing.failures).toBeGreaterThan(0)
  })

  it('a missing agent still answers 404 Agent not found (BL-642 keeps the real answer)', async () => {
    const response = await callDelete(USER, '', `${AGENT}_missing`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Agent not found' })
    expect(events).toEqual([])
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

// The real deletion method runs on the existing default client. Its fixed Lua
// dependencies retain their separate Redis proof; this is caller/custody proof.
describe('actual Primary deletion required reference cleanup (BL1631/392)', () => {
  let restoreExecute: (() => void) | undefined
  beforeEach(async () => {
    vi.mocked(removeArtifactAgentReferences).mockReset().mockImplementation(async (_args, context) => {
      context.checkBeforeIssue(); return { status: 'unchanged' }
    })
    vi.mocked(captureSlashCommandWriteBasis).mockClear()
    vi.mocked(deletePrimaryPopulation).mockClear()
    const authority = await import('$lib/server/services/appActions/settings/authority')
    vi.spyOn(authority, 'sweepAppActionsSubjectReferences').mockResolvedValue(undefined)
    const media = await import('$lib/server/services/memory/memoryMedia')
    vi.spyOn(media, 'sweepAgentMemoryMedia').mockResolvedValue(0)
    const dms = await import('$lib/server/services/dm/dmStore')
    vi.spyOn(dms, 'sweepAgentDms').mockResolvedValue(0)
    const hooks = await import('$lib/server/services/dm/wakeHookStore')
    vi.spyOn(hooks, 'sweepAgentWakeHooks').mockResolvedValue(0)
    const schedules = await import('$lib/server/services/schedules/scheduleStore')
    vi.spyOn(schedules, 'sweepAgentSchedules').mockResolvedValue(0)
    const credentials = await import('$lib/server/services/agentRunCredentials')
    vi.spyOn(credentials, 'sweepAgentRunCredentials').mockResolvedValue(0)
    const holds = await import('$lib/server/services/zipHolds')
    vi.spyOn(holds, 'releaseDeletedAgentHolds').mockResolvedValue([])
    const { RedisService } = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
    ;(redis as any).deleteAgent = (id: string) => RedisService.prototype.deleteAgent.call(redis, id)
  })
  afterEach(() => { restoreExecute?.(); restoreExecute = undefined; vi.restoreAllMocks() })

  it('returns the real lifecycle refusal when another indexed Primary is being replaced (BL-2058)', async () => {
    await seedAgent()
    const peer = `${AGENT}_peer`
    await seedAgent({ id: peer })
    const authority = await import('$lib/server/services/appActions/settings/authority')
    vi.mocked(authority.sweepAppActionsSubjectReferences).mockRestore()
    const media = await import('$lib/server/services/memory/memoryMedia')

    await withSettingsRecordReplacement(`agent:${peer}`, async () => {
      const response = await callDelete(USER)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        error: 'Settings identity changed or is being replaced. Reload before continuing.',
        code: 'SETTINGS_LIFECYCLE_CHANGED'
      })
      expect(await redis.json.get(`agent:${AGENT}`)).not.toBeNull()
      expect(await redis.json.get(`agent:${peer}`)).not.toBeNull()
      expect(media.sweepAgentMemoryMedia).not.toHaveBeenCalled()
      expect(deletePrimaryPopulation).not.toHaveBeenCalled()
      expect(deleteAgentWorkerProfiles).not.toHaveBeenCalled()
      expect(publishUserEvent).not.toHaveBeenCalled()
      // The route already swept avatars before entering the record owner.
      expect(events).toEqual([HEALTH, SWEEP])
    })
  })

  it('keeps an unexpected reference-sweep failure a 500 and retains the agent (BL-2058)', async () => {
    await seedAgent()
    const authority = await import('$lib/server/services/appActions/settings/authority')
    vi.mocked(authority.sweepAppActionsSubjectReferences).mockRejectedValueOnce(new Error('storage unavailable'))
    const response = await callDelete(USER)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to delete agent' })
    expect(await redis.json.get(`agent:${AGENT}`)).not.toBeNull()
    expect(deletePrimaryPopulation).not.toHaveBeenCalled()
  })

  it('captures the original catalogue before the opposite-kind read and preserves all shared lists', async () => {
    await seedAgent()
    await redis.json.set(`subagent:${AGENT}`, '$', { id: AGENT, user_id: USER })
    await redis.json.set(`slash_command:${USER}:shared`, '$', { enabled_agent_ids: [AGENT] })
    await redis.json.set(`skill_source:${USER}:shared`, '$', { enabled_agent_ids: [AGENT] })
    await redis.sAdd(`user:${USER}:artifacts`, 'shared')
    const execute = redis.execute
    let checked = false
    ;(redis as any).execute = (operation: (client: any) => Promise<unknown>) => execute.call(redis, client => operation(new Proxy(client, {
      get(target, property) {
        if (property === 'exists') return async (key: string) => {
          if (key === `subagent:${AGENT}`) {
            checked = true
            expect(captureSlashCommandWriteBasis).toHaveBeenCalledWith(expect.anything(), [])
          }
          return target.exists(key)
        }
        return Reflect.get(target, property)
      }
    })))
    restoreExecute = () => { redis.execute = execute }
    await redis.deleteAgent(AGENT)
    expect(checked).toBe(true)
    expect(removeArtifactAgentReferences).not.toHaveBeenCalled()
    expect(await redis.json.get(`slash_command:${USER}:shared`)).toEqual({ enabled_agent_ids: [AGENT] })
    expect(await redis.json.get(`skill_source:${USER}:shared`)).toEqual({ enabled_agent_ids: [AGENT] })
    expect(await redis.json.get(`subagent:${AGENT}`)).not.toBeNull()
  })

  it('completes the required metadata owner before removing the Primary record', async () => {
    await seedAgent()
    await redis.sAdd(`user:${USER}:artifacts`, 'legacy')
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (args, context) => {
      expect(args).toEqual({ userId: USER, agentId: AGENT, artifactId: 'legacy' })
      expect(await redis.json.get(`agent:${AGENT}`)).not.toBeNull()
      context.checkBeforeIssue(); context.onChanged({ removed: 2, scopePinned: true })
      return { status: 'changed', removed: 2, scopePinned: true, notification: 'recorded' }
    })
    await redis.deleteAgent(AGENT)
    expect(removeArtifactAgentReferences).toHaveBeenCalledTimes(1)
    expect(deletePrimaryPopulation).toHaveBeenCalledOnce()
    expect(vi.mocked(removeArtifactAgentReferences).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deletePrimaryPopulation).mock.invocationCallOrder[0])
    expect(await redis.json.get(`agent:${AGENT}`)).toBeNull()
  })

  it('retains the Primary on an indexed unreadable Artifact and settles known refusal', async () => {
    await seedAgent()
    await redis.sAdd(`user:${USER}:artifacts`, 'unreadable')
    vi.mocked(removeArtifactAgentReferences).mockResolvedValueOnce({ status: 'refused', reason: 'artifact_unreadable' })
    await expect(redis.deleteAgent(AGENT)).rejects.toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_REFUSED', subjectRetained: true })
    expect(deletePrimaryPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`agent:${AGENT}`)).not.toBeNull()
    await expect(withSettingsRecordReplacement(`agent:${AGENT}`, async () => 'settled')).resolves.toBe('settled')
  })

  it('keeps the original final catalogue expectation on concurrent population conflict', async () => {
    await seedAgent()
    vi.mocked(deletePrimaryPopulation).mockRejectedValueOnce(new SubjectPopulationError('The original catalogue changed.', false, true))
    await expect(redis.deleteAgent(AGENT)).rejects.toMatchObject({ code: 'SUBJECT_POPULATION_CONFLICT' })
    expect(captureSlashCommandWriteBasis).toHaveBeenCalledTimes(1)
    expect(deletePrimaryPopulation).toHaveBeenCalledWith(expect.anything(), { subjectId: AGENT, userId: USER, expectedCatalogueRevision: null })
    expect(await redis.json.get(`agent:${AGENT}`)).not.toBeNull()
  })

  // Distinct identity: deliberately retains an unresolved exact-subject lease.
  it('maps the actual Primary retained-record unknown with confirmed cleanup counts to503', async () => {
    const id = `${AGENT}_route_unknown`
    await seedAgent({ id })
    await redis.sAdd(`user:${USER}:artifacts`, ['saved', 'unknown'])
    vi.mocked(removeArtifactAgentReferences).mockImplementationOnce(async (_args, context) => {
      context.checkBeforeIssue(); context.onChanged({ removed: 2, scopePinned: true })
      return { status: 'changed', removed: 2, scopePinned: true, notification: 'recorded' }
    }).mockRejectedValueOnce(new ArtifactAccessCleanupUnknownError())
    const response = await callDelete(USER, '', id)
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_UNCONFIRMED', outcome: 'unknown', subjectRetained: true,
      cleanup: { changedArtifacts: 1, removedReferences: 2 } })
    expect(body.error).not.toMatch(/try again/i)
    expect(removeArtifactAgentReferences).toHaveBeenCalledTimes(2)
    expect(deletePrimaryPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`agent:${id}`)).not.toBeNull()
  })

  it('does not remove or replay a Primary after one issued unknown Artifact scrub', async () => {
    const id = `${AGENT}_artifact_unknown`
    await seedAgent({ id })
    await redis.sAdd(`user:${USER}:artifacts`, 'unknown')
    vi.mocked(removeArtifactAgentReferences).mockRejectedValueOnce(new ArtifactAccessCleanupUnknownError())
    await expect(redis.deleteAgent(id)).rejects.toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_UNCONFIRMED', outcome: 'unknown' })
    expect(removeArtifactAgentReferences).toHaveBeenCalledOnce()
    expect(deletePrimaryPopulation).not.toHaveBeenCalled()
    expect(await redis.json.get(`agent:${id}`)).not.toBeNull()
    await expect(withSettingsRecordReplacement(`agent:${id}`, async () => 'must-not-run')).rejects.toThrow('unknown outcome')
    await expect(withSettingsRestoreFence(async () => 'must-not-run')).rejects.toThrow('unknown outcome')
  })
})
