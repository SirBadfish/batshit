import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'

/**
 * BL-283 (2026-09-27): a Primary Agent or Subagent id outside `[A-Za-z0-9_-]+` could be created
 * but never deleted (`redis.deleteAgent` and the avatar owner sweep refuse it) and could have
 * no avatar picture. A name with no letter or digit made the empty id (stored as `agent:` or
 * `subagent:`), and a non-text id crashed the route. BL-285: a Primary Agent id starting with
 * `subagent_cli` would share a CLI Subagent's or Worker's managed profile folder.
 */

vi.mock('$lib/server/services/cliSubagentProfileSync', () => ({
  syncManagedCliSubagentProfile: vi.fn(async () => null)
}))
vi.mock('$lib/server/services/n8nParameterCompatibility', () => ({ runTrackedN8nCompatibilitySync: vi.fn() }))
vi.mock('$lib/server/services/codexProfileManager', () => ({ syncAgentCodexProfiles: vi.fn(async () => {}) }))
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: vi.fn(async () => {}) }))

useRedisTestServer()

const USER = 'user-id-rule'
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

async function storedIds() {
  return {
    agents: await redis.sMembers(`user:${USER}:agents`),
    subagents: await redis.sMembers(`user:${USER}:subagents`)
  }
}

const BAD_IDS = ['bob/../x', 'bob*', 'bob.jpg', 'two words', 'café', 'a:b']

beforeEach(async () => {
  for (const key of await redis.keys('agent:*')) await redis.del(key)
  for (const key of await redis.keys('subagent:*')) await redis.del(key)
  await redis.del(`user:${USER}:agents`)
  await redis.del(`user:${USER}:subagents`)
})

describe('a new Primary Agent or Subagent id meets the delete rule (BL-283)', () => {
  it.each(BAD_IDS)('a Subagent id %j is refused with 400, and nothing is stored', async (id) => {
    const response = await createSubagent({ id, displayName: 'Helper', subagentType: 'api' })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('agent_id_invalid')
    expect(body.error).toContain('may use only letters, digits, "_" and "-"')
    expect(await redis.json.get(`subagent:${id}`)).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it.each(BAD_IDS)('an agent id %j is refused with 400, and nothing is stored', async (id) => {
    const response = await createAgent({ id, displayName: 'Helper', agentType: 'api' })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.code).toBe('agent_id_invalid')
    expect(await redis.json.get(`agent:${id}`)).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it('a name with no letter or digit is refused instead of storing the empty id', async () => {
    const subagent = await createSubagent({ displayName: '!!!', subagentType: 'api' })
    expect(subagent.status).toBe(400)
    expect((await subagent.json()).error).toContain('needs an id')

    const agent = await createAgent({ displayName: '???', agentType: 'api' })
    expect(agent.status).toBe(400)
    expect((await agent.json()).error).toContain('needs an id')

    expect(await redis.json.get('subagent:')).toBeNull()
    expect(await redis.json.get('agent:')).toBeNull()
    expect(await storedIds()).toEqual({ agents: [], subagents: [] })
  })

  it('an id that is not text is a 400, not a crash', async () => {
    const subagent = await createSubagent({ id: 42, displayName: 'Helper', subagentType: 'api' })
    expect(subagent.status).toBe(400)
    expect((await subagent.json()).error).toBe('The Subagent id must be text.')

    const agent = await createAgent({ id: { nested: true }, displayName: 'Helper', agentType: 'api' })
    expect(agent.status).toBe(400)
    expect((await agent.json()).error).toBe('The agent id must be text.')
  })

  it('ids that meet the rule are still created, as given or from the name', async () => {
    const subagent = await createSubagent({ id: 'Helper-2', displayName: 'Helper', subagentType: 'api' })
    expect(subagent.status).toBe(200)
    expect((await subagent.json()).subagent.id).toBe('Helper-2')

    const agent = await createAgent({ displayName: 'Opie Two', agentType: 'api' })
    expect(agent.status).toBe(200)
    expect((await agent.json()).id).toBe('opie_two')
  })
})

describe('a Primary Agent id may not start with subagent_cli (BL-285)', () => {
  it.each(['subagent_cli_helper', 'Subagent_CLI_helper', 'subagent_cli-worker_cooper_1', 'subagent_cli'])(
    'agent id %j is refused, and nothing is stored',
    async (id) => {
      const response = await createAgent({ id, displayName: 'Helper', agentType: 'api' })
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.code).toBe('agent_id_reserved')
      expect(body.error).toContain('kept for CLI Subagent and Worker runs')
      expect(await storedIds()).toEqual({ agents: [], subagents: [] })
    }
  )

  it('a name that slugs to that prefix is refused too', async () => {
    const response = await createAgent({ displayName: 'Subagent CLI Helper', agentType: 'api' })
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('agent_id_reserved')
  })

  it('a Subagent may still carry such a name (its folder is subagent_cli_<slug> anyway)', async () => {
    const response = await createSubagent({ displayName: 'Subagent CLI Helper', subagentType: 'api' })
    expect(response.status).toBe(200)
    expect((await response.json()).subagent.id).toBe('subagent_cli_helper')
  })
})
