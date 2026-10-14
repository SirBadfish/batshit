import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * Two things a Subagent's delete left behind (Faye's bug hunt, 2026-09-27):
 *
 * - BL-391: its per-chat threads, named for its SLUG in every chat it ran in: the stored
 *   exchanges (`subagent_sessions:{chat}:subagent:{slug}`), an n8n Workflow Subagent's thread id
 *   (`subagent_thread:{chat}:{slug}`), and a run lock (`subagent_lock:{chat}:{slug}`). Ids come
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
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: vi.fn(async () => {}) }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles: vi.fn(async () => {}),
  agentClaudeProfileResource: (id: string) => JSON.stringify(['profile', `claude:${id}`])
}))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))

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
    await redis.set(`subagent_thread:${chat}:${slug}`, `thread_${slug}`)
    await redis.set(`subagent_lock:${chat}:${slug}`, 'stale-token')
  }
}

async function threadKeys(slug: string) {
  const keys: string[] = []
  for (const pattern of [`subagent_sessions:*:subagent:${slug}`, `subagent_thread:*:${slug}`, `subagent_lock:*:${slug}`]) {
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
  for (const pattern of ['subagent_sessions:*', 'subagent_thread:*', 'subagent_lock:*', 'subagent:*', 'agent:*', 'skill_source:*']) {
    for (const key of await redis.keys(pattern)) await redis.del(key)
  }
  for (const key of [`user:${USER}:subagents`, `user:${USER}:sessions`, `user:${USER}:agents`]) await redis.del(key)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('a Subagent delete removes its per-chat threads (BL-391)', () => {
  it('deletes its stored exchanges, thread ids, and run locks in every chat, and nobody else’s', async () => {
    await seedSubagent('researcher')
    await seedThreads('researcher')
    await seedThreads('other_helper')

    const response = await callDelete('researcher')

    expect(response.status).toBe(200)
    expect(await threadKeys('researcher')).toEqual([])
    expect(await threadKeys('other_helper')).toHaveLength(6)
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
    expect(await threadKeys('researcher')).toHaveLength(6)
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

    expect((await callDelete('scout')).status).toBe(200)

    expect(((await redis.json.get(`skill_source:${USER}:src_a`)) as any).enabled_agent_ids).toEqual(['scout'])
  })
})
