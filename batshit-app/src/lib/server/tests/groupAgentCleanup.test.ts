import { useOwnedRedisTestServer } from '$lib/test-utils/ownedRedisTestServer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import {
  createSchedule,
  getSchedule
} from '$lib/server/services/schedules/scheduleStore'
import { schedulesIndexKey } from '$lib/server/services/schedules/scheduleKeys'
import {
  agentRunCredentialKey,
  agentRunCredentialsIndexKey
} from '$lib/server/services/agentRunCredentials'
import { createWakeHook, getWakeHook } from '$lib/server/services/dm/wakeHookStore'
import { dmInboxKey, dmKey } from '$lib/server/services/dm/dmKeys'
import { updateAgentWhiteboard, readAgentWhiteboard, whiteboardKey } from '$lib/server/services/whiteboard'
import { resolveApiReasoningRetention } from '$lib/utils/reasoningRetention'
import { __resetStreamAbortRegistryForTests, registerSessionTurn } from '$lib/server/services/streamAbortRegistry'
import { withSettingsRecordReplacement, withSettingsRestoreFence } from '$lib/server/services/appActions/settings/lifecycle'
import { deleteSubagentPopulation } from '$lib/server/services/subjectPopulation'
import { readSlashCommandRevision } from '$lib/server/services/slashCommandRevision'

const savedPoolId = process.env.VITEST_POOL_ID
beforeAll(() => { if (process.env.SA133_REDIS_RUN_ID) process.env.VITEST_POOL_ID = '0' })
afterAll(() => {
  if (savedPoolId === undefined) delete process.env.VITEST_POOL_ID
  else process.env.VITEST_POOL_ID = savedPoolId
})

useOwnedRedisTestServer(redis, { beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
  if (!process.env.SA133_REDIS_RUN_ID) return
  const expectedRun = process.env.SA133_REDIS_RUN_ID
  expect(new URL(resolvedUrl).pathname).toBe('/15')
  for (const client of [adminClient, await redis.execute(async (connection) => connection)]) {
    expect((await client.clientInfo()).db).toBe(15)
    const info = await client.info('server')
    expect(info).toContain('redis_version:8.10.1')
    expect(info).toContain(`run_id:${expectedRun}`)
    expect(await client.sendCommand(['COMMAND', 'INFO', 'JSON.GET'])).toEqual([expect.any(Array)])
  }
} })

const userId = 'group-cleanup-user'

async function seedAgent(id: string, displayName: string, overrides: Record<string, any> = {}) {
  await redis.createAgent({
    id,
    user_id: userId,
    displayName,
    agentType: 'API',
    ...overrides
  })
}

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('SA-133 actual whiteboard persistence and owner deletion', () => {
  const owner = { userId, sessionId: 'wb_s', agentId: 'wb_a' }
  const key = whiteboardKey(owner.sessionId, owner.agentId)
  const context = () => ({ ...owner, messageId: 'wb_reply', actorType: 'in-process',
    whiteboardSettingsSnapshot: resolveApiReasoningRetention({ api_reasoning_retention: 'whiteboard' }) })
  beforeEach(async () => {
    __resetStreamAbortRegistryForTests()
    await seedAgent(owner.agentId, 'Whiteboard Agent', { api_reasoning_retention: 'whiteboard' })
    await redis.createSession({ id: owner.sessionId, user_id: userId, agent_id: owner.agentId, name: 'Whiteboard' })
    expect(registerSessionTurn(owner.sessionId, 'single', 'wb_reply').ok).toBe(true)
  })
  afterEach(() => { __resetStreamAbortRegistryForTests(); vi.restoreAllMocks() })

  async function changeImmediatelyBeforeWrite(change: (client: any) => Promise<void>) {
    const client = await redis.execute(async (connection) => connection)
    const original = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementation(async (script, options) => {
      if (String(script).includes('BATSHIT_WHITEBOARD_WRITE_V1')) {
        spy.mockRestore()
        await change(client)
      }
      return original(script, options)
    })
  }

  it('retired global, display-only and unrelated provider changes cannot govern an admitted write', async () => {
    await redis.json.set(`user:${userId}:settings`, '$', { user_id: userId, global_api_reasoning_retention: { mode: 'neither', whiteboard_budget_tokens: 250 } })
    await changeImmediatelyBeforeWrite(async (client) => {
      await client.json.set(`user:${userId}:settings`, '$.global_api_reasoning_retention', 'retired')
      await client.json.set(`agent:${owner.agentId}`, '$.show_whiteboard', false)
      await client.json.set(`agent:${owner.agentId}`, '$.provider_specific_settings', { temperature: 0.42 })
    })
    expect(await updateAgentWhiteboard(context(), { content: 'x'.repeat(4000), expectedVersion: 0 })).toMatchObject({ success: true, version: 1, estimatedTokens: 1000 })
  })

  it('an agent with no saved retention mode writes under the factory Whiteboard (SA-126 WB-3): absent compares equal in JS and Lua', async () => {
    await redis.execute((client) => client.sendCommand(['JSON.DEL', `agent:${owner.agentId}`, '$.api_reasoning_retention']))
    expect(await redis.json.getRaw(`agent:${owner.agentId}`, '$.api_reasoning_retention')).toBe('[]')
    const factory = { ...context(), whiteboardSettingsSnapshot: resolveApiReasoningRetention({}) }
    expect(factory.whiteboardSettingsSnapshot.whiteboardEnabled).toBe(true)
    expect(await updateAgentWhiteboard(factory, { content: 'Goal: ship the defaults.', expectedVersion: 0 })).toMatchObject({ success: true, version: 1 })
    expect((await readAgentWhiteboard(owner))?.content).toBe('Goal: ship the defaults.')
  })

  it('a chat converted to Group after JS admission is refused inside Redis without a write', async () => {
    await changeImmediatelyBeforeWrite(async (client) => {
      await client.json.set(`session:${owner.sessionId}`, '$.metadata', { group_chat: { group_id: 'group' } })
    })
    await expect(updateAgentWhiteboard(context(), { content: 'bad', expectedVersion: 0 })).rejects.toThrow('GROUP_SESSION')
    expect(await readAgentWhiteboard(owner)).toBeNull()
  })

  it('a Batshit Tools disable after JS admission is refused atomically', async () => {
    await changeImmediatelyBeforeWrite(async (client) => {
      await client.json.set(`agent:${owner.agentId}`, '$.provider_specific_settings', { nativeTools: { batshitToolsEnabled: false } })
    })
    await expect(updateAgentWhiteboard(context(), { content: 'bad', expectedVersion: 0 })).rejects.toThrow('TOOLS_DISABLED')
    expect(await readAgentWhiteboard(owner)).toBeNull()
  })

  it('Stop arriving while the write waits for its client prevents EVAL', async () => {
    const stop = new AbortController()
    const originalRead = redis.json.getRaw.bind(redis.json)
    const originalExecute = redis.execute.bind(redis)
    let waitingForWrite = false
    vi.spyOn(redis.json, 'getRaw').mockImplementation(async (key, path) => {
      const value = await originalRead(key, path)
      if (path === '$.agentType') waitingForWrite = true
      return value
    })
    vi.spyOn(redis, 'execute').mockImplementation((operation) => originalExecute(async (client) => {
      if (waitingForWrite) { waitingForWrite = false; stop.abort() }
      return operation(client)
    }))
    await expect(updateAgentWhiteboard({ ...context(), abortSignal: stop.signal }, { content: 'bad', expectedVersion: 0 })).rejects.toThrow('active')
    expect(await readAgentWhiteboard(owner)).toBeNull()
  })

  it('board reads and writes do not depend on user-settings availability', async () => {
    const read = vi.spyOn(redis, 'getUserSettings').mockRejectedValue(new Error('User settings unavailable'))
    await expect(updateAgentWhiteboard(context(), { content: 'agent-owned', expectedVersion: 0 })).resolves.toMatchObject({ success: true, version: 1 })
    const { GET } = await import('../../../routes/api/sessions/[id]/whiteboard/+server')
    const response = await GET({ params: { id: owner.sessionId }, locals: { user: { id: userId } },
      url: new URL(`http://localhost/api/sessions/${owner.sessionId}/whiteboard?agentId=${owner.agentId}`) } as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ board: { content: 'agent-owned', version: 1 }, settings: { mode: 'whiteboard', whiteboardBudgetTokens: 1500 } })
    expect(read).not.toHaveBeenCalled()
  })

  it('projects out retired global values without mutating raw data and accepts an unrelated full-settings save', async () => {
    const raw = { id: 'settings', user_id: userId, displayName: 'Keep Name', global_zip_settings: { zip_ai_view_mode: 'appended' }, global_api_reasoning_retention: { mode: 'both' } }
    await redis.json.set(`user:${userId}:settings`, '$', raw)
    expect(await redis.getUserSettings(userId)).not.toHaveProperty('global_api_reasoning_retention')
    expect(await redis.json.get(`user:${userId}:settings`)).toEqual(raw)
    const { GET, POST } = await import('../../../routes/api/user/settings/+server')
    const loaded = await GET({ locals: { user: { id: userId } } } as any)
    expect(loaded.status).toBe(200)
    const projected = (await loaded.json()).settings
    expect(projected).not.toHaveProperty('global_api_reasoning_retention')
    const response = await POST({ request: new Request('http://localhost/api/user/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...projected, global_zip_settings: { zip_ai_view_mode: 'inline' } })
    }), locals: { user: { id: userId } } } as any)
    expect(response.status).toBe(200)
    expect(await redis.getUserSettings(userId)).toMatchObject({ displayName: 'Keep Name', global_zip_settings: { zip_ai_view_mode: 'inline' } })
  })

  it.each(['malformed', [], false, 0])('refuses malformed saved settings root %j before projection without writing', async (value) => {
    await redis.json.set(`user:${userId}:settings`, '$', value)
    await expect(redis.getUserSettings(userId)).rejects.toThrow('Invalid saved user settings')
    expect(await redis.json.get(`user:${userId}:settings`)).toEqual(value)
  })

  it.each(['global_api_reasoning_retention', 'global_api_reasoning_retention_patch'])('visibly refuses retired %s operations without writing', async (field) => {
    await redis.updateUserSettings(userId, { displayName: 'Keep Name' })
    const before = await redis.json.get(`user:${userId}:settings`)
    const { POST } = await import('../../../routes/api/user/settings/+server')
    const response = await POST({ request: new Request('http://localhost/api/user/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: { mode: 'both' } })
    }), locals: { user: { id: userId } } } as any)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('per agent')
    expect(await redis.json.get(`user:${userId}:settings`)).toEqual(before)
  })

  it('confirms replacement, versioned clear and multiple checkpoints without a full-board success echo', async () => {
    expect(await readAgentWhiteboard(owner)).toBeNull()
    const first = await updateAgentWhiteboard(context(), { content: 'Current goal: finish.', expectedVersion: 0 })
    expect(first).toMatchObject({ success: true, version: 1 })
    expect(first).not.toHaveProperty('content')
    expect(first).not.toHaveProperty('whiteboard')
    expect((await readAgentWhiteboard(owner))?.content).toBe('Current goal: finish.')
    expect(await updateAgentWhiteboard(context(), { content: null, expectedVersion: 1 })).toMatchObject({ success: true, version: 2 })
    expect(await readAgentWhiteboard(owner)).toMatchObject({ content: null, version: 2 })
    expect(await updateAgentWhiteboard(context(), { content: 'Next task.', expectedVersion: 2 })).toMatchObject({ success: true, version: 3 })
  })

  it('CAS refuses one of two parallel replacements and returns the actual winner for reconciliation', async () => {
    const answers = await Promise.all(['first', 'second'].map((content) => updateAgentWhiteboard(context(), { content, expectedVersion: 0 })))
    expect(answers.filter((answer) => answer.success)).toHaveLength(1)
    const conflict = answers.find((answer) => !answer.success)!
    expect(conflict).toMatchObject({ code: 'WHITEBOARD_CHANGED', current: { version: 1 } })
    expect(conflict.current.content).toBe((await readAgentWhiteboard(owner))?.content)
    expect(conflict.note).toContain('Do not blindly retry')
  })

  it('a stale version0 cannot refill a deliberately cleared board', async () => {
    await updateAgentWhiteboard(context(), { content: null, expectedVersion: 0 })
    expect(await updateAgentWhiteboard(context(), { content: 'stale', expectedVersion: 0 })).toMatchObject({ success: false, current: { content: null, version: 1 } })
  })

  it('refuses oversized replacements and enforces the tighter live and reply-start limits', async () => {
    await updateAgentWhiteboard(context(), { content: 'x'.repeat(1200), expectedVersion: 0 })
    await redis.updateAgent(owner.agentId, { whiteboard_budget_tokens: 250 })
    await expect(updateAgentWhiteboard(context(), { content: 'x'.repeat(1001), expectedVersion: 1 })).rejects.toThrow('limit is 250')
    expect((await readAgentWhiteboard(owner))?.content).toHaveLength(1200)
    await redis.updateAgent(owner.agentId, { whiteboard_budget_tokens: 3000 })
    await expect(updateAgentWhiteboard(context(), { content: 'x'.repeat(6001), expectedVersion: 1 })).rejects.toThrow('limit is 1500')
    await expect(updateAgentWhiteboard(context(), { content: '😀'.repeat(3000), expectedVersion: 1 })).resolves.toMatchObject({ version: 2, estimatedTokens: 1500 })
  })

  it('disable preserves content and blocks writes; re-enable restores the same saved board', async () => {
    await updateAgentWhiteboard(context(), { content: 'keep', expectedVersion: 0 })
    const before = await readAgentWhiteboard(owner)
    await redis.updateAgent(owner.agentId, { api_reasoning_retention: 'neither' })
    await expect(updateAgentWhiteboard(context(), { content: 'bad', expectedVersion: 1 })).rejects.toThrow('disabled')
    expect(await readAgentWhiteboard(owner)).toEqual(before)
    await redis.updateAgent(owner.agentId, { api_reasoning_retention: 'whiteboard' })
    expect(await readAgentWhiteboard(owner)).toEqual(before)
  })

  it('refuses wrong owner, non-agent caller, unregistered reply, stopped reply and group scope', async () => {
    await expect(updateAgentWhiteboard({ ...context(), userId: 'other' }, { content: 'bad', expectedVersion: 0 })).rejects.toThrow('owner')
    await expect(updateAgentWhiteboard({ ...context(), actorType: 'session' }, { content: 'bad', expectedVersion: 0 })).rejects.toThrow('active')
    await expect(updateAgentWhiteboard({ ...context(), messageId: 'other' }, { content: 'bad', expectedVersion: 0 })).rejects.toThrow('active')
    const stop = new AbortController(); stop.abort()
    await expect(updateAgentWhiteboard({ ...context(), abortSignal: stop.signal }, { content: 'bad', expectedVersion: 0 })).rejects.toThrow('active')
    await redis.json.set(`session:${owner.sessionId}`, '$.metadata', { group_chat: { group_id: 'group' } })
    await expect(updateAgentWhiteboard(context(), { content: 'bad', expectedVersion: 0 })).rejects.toThrow('access')
    expect(await readAgentWhiteboard(owner)).toBeNull()
  })

  it('agent deletion atomically removes all its boards while retaining chats and other agents’ boards', async () => {
    await updateAgentWhiteboard(context(), { content: 'first', expectedVersion: 0 })
    const board = (await readAgentWhiteboard(owner))!
    await redis.json.set('whiteboard:kept:wb_a', '$', { ...board, session_id: 'kept' })
    await redis.json.set('whiteboard:wb_s:other', '$', { ...board, agent_id: 'other' })
    await redis.deleteAgent(owner.agentId)
    expect(await redis.json.get(`agent:${owner.agentId}`)).toBeNull()
    expect(await redis.json.get(key)).toBeNull()
    expect(await redis.json.get('whiteboard:kept:wb_a')).toBeNull()
    expect(await redis.json.get('whiteboard:wb_s:other')).toMatchObject({ agent_id: 'other' })
    expect(await redis.getSession(owner.sessionId)).toBeTruthy()
    await expect(updateAgentWhiteboard(context(), { content: 'late', expectedVersion: 0 })).rejects.toThrow('owner')
  })

  it('a bad target refuses before any board/owner deletion and a repaired retry completes', async () => {
    await updateAgentWhiteboard(context(), { content: 'first', expectedVersion: 0 })
    const board = (await readAgentWhiteboard(owner))!
    await redis.json.set('whiteboard:bad:wb_a', '$', { ...board, session_id: 'bad', user_id: 'wrong' })
    await expect(redis.deleteAgent(owner.agentId)).rejects.toThrow('A Whiteboard owner could not be verified. This final subject and Whiteboard deletion step was refused.')
    expect(await redis.json.get(`agent:${owner.agentId}`)).toBeTruthy()
    expect(await redis.json.get(key)).toEqual(board)
    await redis.json.set('whiteboard:bad:wb_a', '$', { ...board, session_id: 'bad' })
    await expect(redis.deleteAgent(owner.agentId)).resolves.toBeTruthy()
    expect(await redis.json.get(key)).toBeNull()
  })

  it('deleting a chat removes its boards without sweeping another chat', async () => {
    await updateAgentWhiteboard(context(), { content: 'first', expectedVersion: 0 })
    const board = (await readAgentWhiteboard(owner))!
    await redis.json.set('whiteboard:wb_s_other:wb_a', '$', { ...board, session_id: 'wb_s_other' })
    __resetStreamAbortRegistryForTests()
    await redis.deleteSession(owner.sessionId)
    expect(await redis.json.get(key)).toBeNull()
    expect(await redis.json.get('whiteboard:wb_s_other:wb_a')).toBeTruthy()
    expect(await redis.json.get(`agent:${owner.agentId}`)).toBeTruthy()
  })
})

describe.runIf(REAL_REDIS_LANE)('group cleanup after agent deletion', () => {
  beforeEach(async () => {
    await seedAgent('agent-a', 'Agent A')
    await seedAgent('agent-b', 'Agent B')
    await seedAgent('agent-c', 'Agent C')
  })

  it('scrubs the deleted agent from skill enable-lists and artifact allow-lists, touching nothing else (2026-09-19)', async () => {
    await redis.json.set(`slash_command:${userId}:batshit-guide`, '$', {
      id: 'batshit-guide',
      user_id: userId,
      enabled_for_all_agents: false,
      enabled_agent_ids: ['agent-a', 'agent-b'],
      is_active: true
    } as never)
    await redis.json.set(`slash_command:${userId}:all-agents`, '$', {
      id: 'all-agents',
      user_id: userId,
      enabled_for_all_agents: true,
      enabled_agent_ids: [],
      is_active: true
    } as never)
    await redis.json.set('artifact:art-1', '$', {
      id: 'art-1',
      user_id: userId,
      name: 'Nano',
      agent_access_scope: 'all',
      agent_allowlist: ['agent-a'],
      agent_use_enabled: true
    } as never)
    await redis.json.set('artifact:art-2', '$', {
      id: 'art-2',
      user_id: userId,
      name: 'Other',
      agent_allowlist: null
    } as never)
    await redis.sAdd(`user:${userId}:artifacts`, ['art-1', 'art-2'])

    await redis.deleteAgent('agent-a')

    expect(await redis.json.get(`slash_command:${userId}:batshit-guide`)).toMatchObject({
      enabled_agent_ids: ['agent-b'],
      enabled_for_all_agents: false,
      is_active: true
    })
    expect(await redis.json.get(`slash_command:${userId}:all-agents`)).toMatchObject({
      enabled_agent_ids: []
    })
    expect(await redis.json.get('artifact:art-1')).toMatchObject({
      agent_allowlist: [],
      agent_use_enabled: true,
      name: 'Nano'
    })
    expect(await redis.json.get('artifact:art-2')).toMatchObject({ agent_allowlist: null })
    expect(await redis.get('agent:agent-b')).toMatchObject({ id: 'agent-b' })
  })

  it('scrubs deleted agents from saved groups and repairs driver fallback', async () => {
    await redis.createGroup({
      id: 'group-cleanup-1',
      user_id: userId,
      name: 'Cleanup Group',
      agent_ids: ['agent-a', 'agent-b', 'agent-c'],
      agent_settings: {
        'agent-a': { speak_policy: 'balanced' },
        'agent-b': { speak_policy: 'quiet' },
        'agent-c': { speak_policy: 'topic_only', speak_topics: ['redis'] }
      },
      driver_mode: true,
      driver_agent_id: 'agent-b'
    })

    await redis.deleteAgent('agent-b')

    const group = await redis.getGroup('group-cleanup-1')

    expect(group).not.toBeNull()
    expect(group?.agent_ids).toEqual(['agent-a', 'agent-c'])
    expect(group?.agent_settings).toEqual({
      'agent-a': { speak_policy: 'balanced' },
      'agent-c': { speak_policy: 'topic_only', speak_topics: ['redis'] }
    })
    expect(group?.driver_agent_id).toBe('agent-a')
  })
})

/**
 * SA-115 P3 (DL-115-12) — the third sweep `deleteAgent` owes.
 *
 * `sweepAgentSchedules` existing is not the same as it being CALLED, and the difference is
 * invisible: an unswept schedule keeps its index member, so `listSchedules` prunes a ghost
 * on every read while the ticker's recipient check quietly fails once a minute forever.
 * This lives here rather than beside the store because the store's own suite runs against
 * the in-memory fake, which has no `deleteAgent` — the claim is about the real method.
 */
describe.runIf(REAL_REDIS_LANE)('schedule cleanup after agent deletion (SA-115)', () => {
  beforeEach(async () => {
    // Both need Agent DMs on: a schedule's recipient must be able to see the DM it writes
    // (DL-115-01, the AMD-113-05 parity rule), so `createSchedule` refuses otherwise.
    await seedAgent('agent-sched-a', 'Sched A', { dms_enabled: true })
    await seedAgent('agent-sched-b', 'Sched B', { dms_enabled: true })
  })

  async function indexMembers(): Promise<string[]> {
    const members = await redis.execute(async (client) =>
      client.sMembers(schedulesIndexKey(userId))
    )
    return (Array.isArray(members) ? (members as string[]) : []).sort()
  }

  it('deletes that agent’s schedules and their index members, and only theirs', async () => {
    const doomed = await createSchedule({
      userId,
      agentId: 'agent-sched-a',
      name: 'Morning check',
      cadence: { type: 'daily', at: '09:00' },
      timeZone: 'America/Chicago',
      message: 'Say good morning.'
    })
    const survivor = await createSchedule({
      userId,
      agentId: 'agent-sched-b',
      name: 'Evening check',
      cadence: { type: 'daily', at: '17:00' },
      timeZone: 'America/Chicago',
      message: 'Say good night.'
    })

    await redis.deleteAgent('agent-sched-a')

    expect(await getSchedule(doomed.id)).toBeNull()
    // The index member goes too — a dangling member is a ghost row on every list read.
    expect(await indexMembers()).toEqual([survivor.id])
    // The other agent's clock keeps ticking.
    expect(await getSchedule(survivor.id)).not.toBeNull()
  })
})

/**
 * SA-117 P1 (DL-117-09) — the fourth sweep `deleteAgent` owes.
 *
 * `sweepAgentRunCredentials` existing is not the same as it being CALLED, and the store's own
 * suite cannot tell the difference: it runs against the in-memory fake, which has no
 * `deleteAgent`. The claim here is about the real method, so it lives beside the other three.
 *
 * What an unswept credential is, plainly: a live secret that authenticates as an agent that no
 * longer exists. Every route that acts on it would then look the agent up and fail, or worse,
 * act on whatever a re-created agent of the same id turns out to be.
 */
describe.runIf(REAL_REDIS_LANE)('run credential cleanup after agent deletion (SA-117)', () => {
  beforeEach(async () => {
    await seedAgent('agent-cred-a', 'Cred A')
    await seedAgent('agent-cred-b', 'Cred B')
  })

  async function credentialIndexMembers(agentId: string): Promise<string[]> {
    const members = await redis.execute(async (client) =>
      client.sMembers(agentRunCredentialsIndexKey(agentId))
    )
    return (Array.isArray(members) ? (members as string[]) : []).sort()
  }

  it('deletes that agent\u2019s run credentials and their index, and only theirs', async () => {
    const doomed = 'arc_retired_doomed'
    const survivor = 'arc_retired_survivor'
    for (const [id, agentId] of [[doomed, 'agent-cred-a'], [survivor, 'agent-cred-b']]) {
      await redis.json.set(agentRunCredentialKey(id), '$', { id, agentId } as never)
      await redis.execute(client => client.sAdd(agentRunCredentialsIndexKey(agentId), [id]))
    }

    await redis.deleteAgent('agent-cred-a')

    expect(await redis.json.get(agentRunCredentialKey(doomed))).toBeNull()
    expect(await credentialIndexMembers('agent-cred-a')).toEqual([])
    expect(await redis.json.get(agentRunCredentialKey(survivor))).not.toBeNull()
    expect(await credentialIndexMembers('agent-cred-b')).toEqual([survivor])
  })
})

/**
 * BL-608 — a failed read of the agent stops its delete.
 *
 * Three sweeps in `deleteAgent` (wake-up webhooks, schedules, zip holds) find the agent's records
 * through `agent.user_id`, and they read it with `redis.get`, which answers a failed read with
 * null, the same answer as "no such agent". So a read error swept nothing and the agent was
 * deleted anyway, leaving a live webhook credential, a ticking schedule, and a hold nobody can
 * release. Now every one of those reads throws, and `deleteAgent` reads the record once before
 * it deletes anything.
 *
 * The error is injected BELOW the facade, at the Redis client's `json.get`, where a real read
 * error arrives: `redis.get` catches it there (that is the bug), `redis.json.get` does not.
 */
describe.runIf(REAL_REDIS_LANE)('a failed read of the agent stops its delete (BL-608)', () => {
  const agentId = 'agent-readfail'
  const sessionId = 'sess-readfail'
  const zipId = 'zip_readfail'
  const dmId = 'dm_readfail'
  let hookId = ''
  let scheduleId = ''

  /** Makes the `nth` client-level JSON read of `key` fail; every other command runs as usual. */
  function failNthRead(key: string, nth: number) {
    const realExecute = redis.execute.bind(redis)
    let reads = 0
    const bind = (owner: any, member: unknown) =>
      typeof member === 'function' ? member.bind(owner) : member
    // The proxies' targets are empty objects: the client's `json` is a read-only data property,
    // and a proxy of the client itself may not answer it with anything else.
    vi.spyOn(redis, 'execute').mockImplementation(((operation: (client: any) => Promise<unknown>) =>
      realExecute((client: any) =>
        operation(
          new Proxy({}, {
            get(_, prop) {
              const value = Reflect.get(client, prop, client)
              if (prop !== 'json') return bind(client, value)
              return new Proxy({}, {
                get(__, jsonProp) {
                  const member = Reflect.get(value, jsonProp, value)
                  if (jsonProp !== 'get') return bind(value, member)
                  return async (readKey: string, ...rest: unknown[]) => {
                    if (readKey === key && ++reads === nth) {
                      throw new Error(`Redis read of ${key} failed (BL-608 test)`)
                    }
                    return member.call(value, readKey, ...rest)
                  }
                }
              })
            }
          })
        )
      )) as any)
  }

  async function holdIsThere(): Promise<boolean> {
    const members = await redis.sMembers(`unzipped:${sessionId}`)
    const item = await redis.json.get(`unzipped_item:${sessionId}:${zipId}`)
    return members.includes(zipId) && Boolean(item)
  }

  beforeEach(async () => {
    await seedAgent(agentId, 'Read Fail', { dms_enabled: true })
    // A DM addressed to it: `sweepAgentDms` runs before any sweep that reads the agent.
    await redis.json.set(dmKey(dmId), '$', { id: dmId, userId, from: { kind: 'user' } } as never)
    await redis.execute(async (client) => client.zAdd(dmInboxKey(agentId), [{ score: 1, value: dmId }]))
    hookId = (await createWakeHook({ userId, agentId, name: 'Read fail hook' })).record.id
    scheduleId = (
      await createSchedule({
        userId,
        agentId,
        name: 'Read fail clock',
        cadence: { type: 'daily', at: '09:00' },
        timeZone: 'America/Chicago',
        message: 'Tick.'
      })
    ).id
    // One of its holds, in a chat of its user.
    await redis.createSession({ id: sessionId, user_id: userId, agent_id: agentId, name: 'Owned hold-release fixture' })
    await redis.sAdd(`unzipped:${sessionId}`, zipId)
    await redis.set(`unzipped_item:${sessionId}:${zipId}`, {
      zipId,
      sessionId,
      source: 'agent',
      agentId,
      permanent: true,
      path: 'src/app.ts',
      unzippedAt: 1
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes everything when every read works (the fixture is sweepable)', async () => {
    failNthRead(`agent:${agentId}`, 99)

    const result = await redis.deleteAgent(agentId)

    expect(result.releasedHolds).toEqual([{ sessionId, zipId }])
    vi.restoreAllMocks()
    expect(await redis.json.get(`agent:${agentId}`)).toBeNull()
    expect(await redis.json.get(dmKey(dmId))).toBeNull()
    expect(await getWakeHook(hookId)).toBeNull()
    expect(await getSchedule(scheduleId)).toBeNull()
    expect(await holdIsThere()).toBe(false)
  })

  it('a read that fails from the start deletes nothing', async () => {
    failNthRead(`agent:${agentId}`, 1)

    await expect(redis.deleteAgent(agentId)).rejects.toThrow(/BL-608 test/)

    vi.restoreAllMocks()
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ id: agentId })
    expect(await redis.json.get(dmKey(dmId))).toMatchObject({ id: dmId })
    expect(await getWakeHook(hookId)).not.toBeNull()
    expect(await getSchedule(scheduleId)).not.toBeNull()
    expect(await holdIsThere()).toBe(true)
  })

  it("the wake-up webhook sweep's failed read keeps the agent and its webhook", async () => {
    failNthRead(`agent:${agentId}`, 2)

    await expect(redis.deleteAgent(agentId)).rejects.toThrow(/BL-608 test/)

    vi.restoreAllMocks()
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ id: agentId })
    expect(await getWakeHook(hookId)).not.toBeNull()
  })

  it("the schedule sweep's failed read keeps the agent and its schedule", async () => {
    failNthRead(`agent:${agentId}`, 3)

    await expect(redis.deleteAgent(agentId)).rejects.toThrow(/BL-608 test/)

    vi.restoreAllMocks()
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ id: agentId })
    expect(await getSchedule(scheduleId)).not.toBeNull()
  })

  it("the hold release's failed read of the agent keeps the agent and its hold", async () => {
    failNthRead(`agent:${agentId}`, 4)

    await expect(redis.deleteAgent(agentId)).rejects.toThrow(/BL-608 test/)

    vi.restoreAllMocks()
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ id: agentId })
    expect(await holdIsThere()).toBe(true)
  })

  it("the hold release's failed read of a hold keeps the agent and that hold", async () => {
    failNthRead(`unzipped_item:${sessionId}:${zipId}`, 1)

    await expect(redis.deleteAgent(agentId)).rejects.toThrow(/BL-608 test/)

    vi.restoreAllMocks()
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ id: agentId })
    expect(await holdIsThere()).toBe(true)
  })
})

describe.runIf(REAL_REDIS_LANE)('required Primary Artifact cleanup with the actual Redis owners (BL1631/392)', () => {
  const id = 'artifact_caller_primary'
  const artifact = 'artifact_caller_primary'
  const key = `artifact:${artifact}`
  beforeEach(async () => {
    await seedAgent(id, 'Artifact deletion owner')
    await redis.json.set(key, '$', { id: artifact, user_id: userId, metadata: { assignedAgentIds: [id], sibling: [] } })
    await redis.sAdd(`user:${userId}:artifacts`, artifact)
  })
  afterEach(() => vi.restoreAllMocks())

  it('scrubs the legacy fallback and keeps selected scope, tolerating an already absent indexed Artifact', async () => {
    await redis.sAdd(`user:${userId}:artifacts`, 'artifact_caller_absent')
    await redis.deleteAgent(id)
    expect(await redis.json.get(`agent:${id}`)).toBeNull()
    expect(await redis.json.get(key)).toEqual({ id: artifact, user_id: userId,
      metadata: { assignedAgentIds: [], sibling: [] }, agent_access_scope: 'selected' })
  })

  it('preserves all untyped lists when a legacy opposite-kind owner exists', async () => {
    await redis.json.set(`subagent:${id}`, '$', { id, user_id: userId })
    await redis.json.set(`slash_command:${userId}:artifact_shared`, '$', { id: 'artifact_shared', user_id: userId, enabled_agent_ids: [id] })
    await redis.json.set(`skill_source:${userId}:artifact_shared`, '$', { id: 'artifact_shared', user_id: userId, enabled_agent_ids: [id] })
    await redis.deleteAgent(id)
    expect(await redis.json.get(`subagent:${id}`)).not.toBeNull()
    expect(await redis.json.get(key)).toMatchObject({ metadata: { assignedAgentIds: [id] } })
    for (const family of ['slash_command', 'skill_source']) expect(await redis.json.get(`${family}:${userId}:artifact_shared`)).toMatchObject({ enabled_agent_ids: [id] })
  })

  it('retains the record on an indexed wrong owner before final population deletion', async () => {
    await redis.json.set(key, '$.user_id', 'another-owner')
    await expect(redis.deleteAgent(id)).rejects.toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_REFUSED', outcome: 'refused' })
    expect(await redis.json.get(`agent:${id}`)).not.toBeNull()
    expect(await redis.sMembers(`user:${userId}:agents`)).toContain(id)
    expect(await redis.json.get(key)).toMatchObject({ metadata: { assignedAgentIds: [id] } })
    await expect(withSettingsRecordReplacement(`agent:${id}`, async () => 'settled')).resolves.toBe('settled')
  })

  it('retains the original catalogue when the opposite deletion settles after EXISTS observed a collision', async () => {
    await redis.json.set(`subagent:${id}`, '$', { id, user_id: userId })
    await redis.sAdd(`user:${userId}:subagents`, id)
    const client = await redis.execute(value => value)
    const exists = client.exists.bind(client)
    let crossed = false
    vi.spyOn(client, 'exists').mockImplementation(async (...args) => {
      const answer = await exists(...args)
      if (args[0] === `subagent:${id}` && !crossed) {
        crossed = true
        const revision = await readSlashCommandRevision(userId)
        await withSettingsRecordReplacement(`subagent:${id}`, () => deleteSubagentPopulation(client, { userId, subjectId: id, expectedCatalogueRevision: revision }))
      }
      return answer
    })
    await expect(redis.deleteAgent(id)).rejects.toMatchObject({ code: 'SUBJECT_POPULATION_CONFLICT' })
    expect(crossed).toBe(true)
    expect(await redis.json.get(`agent:${id}`)).not.toBeNull()
    expect(await redis.json.get(`subagent:${id}`)).toBeNull()
    expect(await redis.json.get(key)).toMatchObject({ metadata: { assignedAgentIds: [id] } })
  })

  // Deliberately holds only this exact subject's ambiguous issued cleanup custody.
  it('keeps actual saved-but-unanswered cleanup unknown, without replay or subject deletion', async () => {
    const client = await redis.execute(value => value)
    const evaluate = client.eval.bind(client)
    let issued = 0
    vi.spyOn(client, 'eval').mockImplementation(async (script, options) => {
      const answer = await evaluate(script, options)
      if (String(script).includes('JSON.ARRPOP') && options?.keys?.[0] === key) { issued++; throw new Error('lost actual cleanup answer') }
      return answer
    })
    await expect(redis.deleteAgent(id)).rejects.toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_UNCONFIRMED', outcome: 'unknown' })
    expect(issued).toBe(1)
    expect(await redis.json.get(`agent:${id}`)).not.toBeNull()
    expect(await redis.json.get(key)).toMatchObject({ metadata: { assignedAgentIds: [] }, agent_access_scope: 'selected' })
    await expect(withSettingsRecordReplacement(`agent:${id}`, async () => 'must-not-run')).rejects.toThrow('unknown outcome')
    await expect(withSettingsRestoreFence(async () => 'must-not-run')).rejects.toThrow('unknown outcome')
  })
})
