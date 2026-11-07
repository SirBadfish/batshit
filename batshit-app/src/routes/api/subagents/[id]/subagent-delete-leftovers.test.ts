import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { withSettingsRecordReplacement, withSettingsRestoreFence } from '$lib/server/services/appActions/settings/lifecycle'

/**
 * Two things a Subagent's delete left behind (Faye's bug hunt, 2026-09-27):
 *
 * - BL-391: its per-chat threads, named for its SLUG in every chat it ran in: the stored
 *   exchanges (`subagent_sessions:{chat}:subagent:{slug}`) and a run lock
 *   (`subagent_lock:{chat}:{slug}`). (The n8n Workflow Subagent's `subagent_thread:` ids went with
 *   that type in SA-139 R2; a leftover one ends on its own TTL.) Ids come
 *   from display names, so a new "Researcher" in an old chat said `thread: resumable` and a
 *   `resume` handed it the deleted one's exchanges. They go before the record, unless another of
 *   the user's Subagents has the same slug (the threads are its too).
 * - BL-392 (the Subagent half): its id in a skill SOURCE's `enabled_agent_ids`
 *   (`skill_source:{user}:{source}`), which each rescan copies back onto every skill that source
 *   provides, so a same-name Subagent got those skills back. Scrubbed like the skills' own lists,
 *   and left alone while a Primary Agent has the same id.
 */

vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => null),
  // BL-753: the delete holds its profile folder's turn; not what this suite tests.
  holdManagedCliSubagentProfileFolder: async (_subagent: unknown, action: () => Promise<unknown>) => action(),
  deleteManagedCliSubagentProfile: vi.fn(async () => ({
    profileId: 'x',
    deleted: true,
    sharedWith: null,
    sharedWithKind: null
  })),
  planManagedCliSubagentProfileDeletion: vi.fn(async () => ({
    profileId: 'batshit_agent_subagent_cli_leftovers', deleted: true, sharedWith: null, sharedWithKind: null
  }))
}))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
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

const USER = 'user-subagent-delete-leftovers'
const SERVER = 'http://batshit-server.test:5613'
const CHATS = ['zc_chat_1', 'zc_chat_2']

async function seedSubagent(id: string, fields: Record<string, unknown> = {}) {
  await redis.json.set(`subagent:${id}`, '$', { id, user_id: USER, displayName: id, subagentType: 'api', ...fields })
  await redis.sAdd(`user:${USER}:subagents`, id)
}

async function seedThreads(slug: string, chats = CHATS) {
  for (const chat of chats) {
    await redis.sAdd(`user:${USER}:sessions`, chat)
    await redis.json.set(`subagent_sessions:${chat}:subagent:${slug}`, '$', [
      { role: 'user', content: `asked ${slug}` },
      { role: 'assistant', content: `${slug} answered` }
    ])
    await redis.set(`subagent_lock:${chat}:${slug}`, 'stale-token')
  }
}

async function threadKeys(slug: string) {
  const keys: string[] = []
  for (const pattern of [`subagent_sessions:*:subagent:${slug}`, `subagent_lock:*:${slug}`]) {
    keys.push(...(await redis.keys(pattern)))
  }
  return keys.sort()
}

async function callDelete(id: string) {
  const { DELETE } = await import('./+server')
  return DELETE({ params: { id }, locals: { user: { id: USER } } } as any)
}

beforeEach(async () => {
  vi.stubEnv('BATSHIT_SERVER_URL', SERVER)
  vi.stubEnv('BATSHIT_TOKEN', 'route-test-token')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === `${SERVER}/health`
        ? Response.json({ ok: true, checks: { http: true, redis: true } })
        : Response.json({ success: true, deletedRecords: [], deletedFiles: [] })
    )
  )
  for (const pattern of ['subagent_sessions:*', 'subagent_lock:*', 'subagent:*', 'agent:*', 'skill_source:*']) {
    for (const key of await redis.keys(pattern)) await redis.del(key)
  }
  for (const key of [`user:${USER}:subagents`, `user:${USER}:sessions`, `user:${USER}:agents`]) await redis.del(key)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('a Subagent delete removes its per-chat threads (BL-391)', () => {
  it('deletes its stored exchanges and run locks in every chat, and nobody else’s', async () => {
    await seedSubagent('researcher')
    await seedThreads('researcher')
    await seedThreads('other_helper')

    const response = await callDelete('researcher')

    expect(response.status).toBe(200)
    expect(await threadKeys('researcher')).toEqual([])
    expect(await threadKeys('other_helper')).toHaveLength(4)
    expect(await redis.json.get('subagent:researcher')).toBeNull()
  })

  it('a stored slug names the threads, not the id', async () => {
    await seedSubagent('researcher_2', { slug: 'Researcher' })
    await seedThreads('researcher')

    expect((await callDelete('researcher_2')).status).toBe(200)
    expect(await threadKeys('researcher')).toEqual([])
  })

  it('leaves them when another of the user’s Subagents has the same slug (they are its threads too)', async () => {
    await seedSubagent('researcher_2', { slug: 'researcher' })
    await seedSubagent('researcher')
    await seedThreads('researcher')

    expect((await callDelete('researcher_2')).status).toBe(200)
    expect(await threadKeys('researcher')).toHaveLength(4)
    expect(await redis.json.get('subagent:researcher_2')).toBeNull()
  })
})

describe('a Subagent delete scrubs its id from skill sources (BL-392, the Subagent half)', () => {
  it('removes the id from every skill source’s enabled_agent_ids, and only the id', async () => {
    await seedSubagent('scout')
    await redis.json.set(`skill_source:${USER}:src_a`, '$', {
      id: 'src_a',
      user_id: USER,
      enabled_agent_ids: ['cody', 'scout']
    })
    await redis.json.set(`skill_source:${USER}:src_b`, '$', { id: 'src_b', user_id: USER, enabled_agent_ids: ['cody'] })

    expect((await callDelete('scout')).status).toBe(200)

    expect(((await redis.json.get(`skill_source:${USER}:src_a`)) as any).enabled_agent_ids).toEqual(['cody'])
    expect(((await redis.json.get(`skill_source:${USER}:src_b`)) as any).enabled_agent_ids).toEqual(['cody'])
  })

  it('leaves skill sources alone while a Primary Agent has the same id', async () => {
    await seedSubagent('scout')
    await redis.json.set('agent:scout', '$', { id: 'scout', user_id: USER })
    await redis.json.set(`skill_source:${USER}:src_a`, '$', { id: 'src_a', user_id: USER, enabled_agent_ids: ['scout'] })
    await redis.json.set(`slash_command:${USER}:shared`, '$', { id: 'shared', user_id: USER, enabled_agent_ids: ['scout'] })
    await redis.json.set('artifact:subagent_shared', '$', { id: 'subagent_shared', user_id: USER, metadata: { agentAllowlist: ['scout'] } })
    await redis.sAdd(`user:${USER}:artifacts`, 'subagent_shared')

    expect((await callDelete('scout')).status).toBe(200)

    expect(((await redis.json.get(`skill_source:${USER}:src_a`)) as any).enabled_agent_ids).toEqual(['scout'])
    expect(await redis.json.get(`slash_command:${USER}:shared`)).toMatchObject({ enabled_agent_ids: ['scout'] })
    expect(await redis.json.get('artifact:subagent_shared')).toMatchObject({ metadata: { agentAllowlist: ['scout'] } })
  })
})

describe.runIf(process.env.VITEST_USE_REAL_REDIS === 'true')('actual Subagent Artifact cleanup owners (BL1631)', () => {
  const id = 'artifact_caller_subagent'
  const key = 'artifact:artifact_caller_subagent'
  beforeEach(async () => {
    await seedSubagent(id)
    await redis.json.set(key, '$', { id, user_id: USER, metadata: { agentAllowlist: [id], sibling: [] } })
    await redis.sAdd(`user:${USER}:artifacts`, id)
  })
  afterEach(() => vi.restoreAllMocks())

  it('cleans metadata before final deletion, keeps selected scope, and tolerates a missing indexed Artifact', async () => {
    await redis.sAdd(`user:${USER}:artifacts`, 'artifact_caller_absent')
    expect((await callDelete(id)).status).toBe(200)
    expect(await redis.json.get(`subagent:${id}`)).toBeNull()
    expect(await redis.json.get(key)).toEqual({ id, user_id: USER,
      metadata: { agentAllowlist: [], sibling: [] }, agent_access_scope: 'selected' })
  })

  it('retains the Subagent and raw references when an indexed Artifact is unowned', async () => {
    await redis.json.set(key, '$.user_id', 'another-owner')
    const response = await callDelete(id)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_REFUSED', subjectRetained: true })
    expect(await redis.json.get(`subagent:${id}`)).not.toBeNull()
    expect(await redis.json.get(key)).toMatchObject({ metadata: { agentAllowlist: [id] } })
    await expect(withSettingsRecordReplacement(`subagent:${id}`, async () => 'settled')).resolves.toBe('settled')
  })

  it('retains exact custody after an actual saved cleanup loses its answer, without replay', async () => {
    const client = await redis.execute(value => value)
    const evaluate = client.eval.bind(client)
    let issued = 0
    vi.spyOn(client, 'eval').mockImplementation(async (script, options) => {
      const answer = await evaluate(script, options)
      if (String(script).includes('JSON.ARRPOP') && options?.keys?.[0] === key) { issued++; throw new Error('lost actual cleanup answer') }
      return answer
    })
    const response = await callDelete(id)
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ code: 'AGENT_ARTIFACT_CLEANUP_UNCONFIRMED', outcome: 'unknown' })
    expect(body.error).not.toMatch(/try again/i)
    expect(issued).toBe(1)
    expect(await redis.json.get(`subagent:${id}`)).not.toBeNull()
    expect(await redis.json.get(key)).toMatchObject({ metadata: { agentAllowlist: [] } })
    await expect(withSettingsRecordReplacement(`subagent:${id}`, async () => 'must-not-run')).rejects.toThrow('unknown outcome')
    await expect(withSettingsRestoreFence(async () => 'must-not-run')).rejects.toThrow('unknown outcome')
  })
})
