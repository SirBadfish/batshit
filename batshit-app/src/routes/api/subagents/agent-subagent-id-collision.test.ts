import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-187 (2026-09-25): access lists name ids with no kind. A skill's `enabled_agent_ids` and an
 * artifact's `agent_allowlist` hold primary AND Subagent ids side by side, so turning a skill on
 * for Subagent `cooper` also turned it on for a primary `cooper`. Both kinds took their id from
 * `sanitizeId(displayName)` and checked it only in their own key space. Creation now refuses an
 * id the other kind already uses, both ways round; deletes scrub the id from those lists (the
 * primary's in `redis.deleteAgent`, the Subagent's in its delete route), so a later owner of a
 * freed id starts clean.
 */

vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => null)
}))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: vi.fn(async () => {}) }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: vi.fn(async () => {}) }))

useRedisTestServer()

const USER = 'user-id-collision'
const locals = { user: { id: USER } }

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function createSubagent(body: Record<string, unknown>) {
  const { POST } = await import('./+server')
  return POST({ request: jsonRequest('http://localhost/api/subagents', body), locals } as any)
}

async function createAgent(body: Record<string, unknown>) {
  const { POST } = await import('../agents/+server')
  return POST({ request: jsonRequest('http://localhost/api/agents', body), locals } as any)
}

beforeEach(async () => {
  await redis.del('agent:cooper')
  await redis.del('subagent:cooper')
})

describe('an id one kind already uses is refused for the other kind (BL-187)', () => {
  it('a Subagent named like an existing Primary Agent is refused, and nothing is stored', async () => {
    await redis.json.set('agent:cooper', '$', { id: 'cooper', user_id: USER, displayName: 'Cooper' })

    const response = await createSubagent({ displayName: 'Cooper', subagentType: 'api' })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatch(/A Primary Agent already uses the id 'cooper'/)
    expect(await redis.json.get('subagent:cooper')).toBeNull()
    expect(await redis.sMembers(`user:${USER}:subagents`)).toEqual([])
  })

  it('an explicit Subagent id that a Primary Agent uses is refused too', async () => {
    await redis.json.set('agent:cooper', '$', { id: 'cooper', user_id: USER })

    const response = await createSubagent({ id: 'cooper', displayName: 'Someone else', subagentType: 'api' })

    expect(response.status).toBe(400)
    expect(await redis.json.get('subagent:cooper')).toBeNull()
  })

  it('a Primary Agent named like an existing Subagent is refused, and nothing is stored', async () => {
    await redis.json.set('subagent:cooper', '$', { id: 'cooper', user_id: USER, displayName: 'Cooper' })

    const response = await createAgent({ displayName: 'Cooper', agentType: 'api' })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toMatch(/A Subagent already uses the id 'cooper'/)
    expect(await redis.json.get('agent:cooper')).toBeNull()
  })

  it('ids the other kind does not use are still created', async () => {
    await redis.json.set('agent:cooper', '$', { id: 'cooper', user_id: USER })

    const subagent = await createSubagent({ displayName: 'Cooper Helper', subagentType: 'api' })
    expect(subagent.status).toBe(200)
    expect((await subagent.json()).subagent.id).toBe('cooper_helper')

    const agent = await createAgent({ displayName: 'Opie', agentType: 'api' })
    expect(agent.status).toBe(200)
    expect((await agent.json()).id).toBe('opie')
  })
})
