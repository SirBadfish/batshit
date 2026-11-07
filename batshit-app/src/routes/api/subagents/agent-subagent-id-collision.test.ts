import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('$lib/server/services/claudeProfileManager', () => ({ syncAgentClaudeProfiles: vi.fn(async () => {}) }))

// The default fake deliberately has no EVAL. Route ID/ownership tests keep
// those checks real and stub only the physical population boundary; actual
// record/index/nonce/cross-kind Lua is proved by subjectPopulation.redis.test.ts.
vi.mock('$lib/server/services/subjectPopulation', async importOriginal => {
  const original = await importOriginal<typeof import('$lib/server/services/subjectPopulation')>()
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return original
  return { ...original, createSubjectPopulation: vi.fn(async (client: any, subject: { userId: string; subjectId: string; kind: 'primary' | 'subagent'; record: unknown }) => {
    await client.json.set(`${subject.kind === 'primary' ? 'agent' : 'subagent'}:${subject.subjectId}`, '$', subject.record)
    await client.sAdd(`user:${subject.userId}:${subject.kind === 'primary' ? 'agents' : 'subagents'}`, subject.subjectId)
    return { status: 'CREATED', record: subject.record }
  }) }
})

useRedisTestServer()

const USER = 'user-id-collision'
const locals = { user: { id: USER } }

const retiredRows = { buffer_size_skill_read: 99, auto_zip_skill_reference: false,
  buffer_size_read_file: 3, custom_tool_settings: [{ tool_name: 'skill_read', buffer_size: 9 },
    { tool_name: 'skill_reference', zip_disabled: true }, { tool_name: 'custom_keep', marker: { exact: 'kept' } }] }
async function expectRetiredRemoved(key: string) {
  const saved = await redis.json.get(key) as any
  expect(saved).not.toHaveProperty('buffer_size_skill_read')
  expect(saved).not.toHaveProperty('auto_zip_skill_reference')
  expect(saved.buffer_size_read_file).toBe(3)
  expect(saved.custom_tool_settings).toEqual([retiredRows.custom_tool_settings[2]])
}

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

describe('Skill Read retirement stays removed through actual create/duplicate routes', () => {
  let restoreCreate: (() => void) | undefined
  beforeEach(async () => {
    // Keep the production create projection (including retirement) real. The default fake's
    // createAgent is a standalone storage stand-in; only its existing physical client is used.
    if (process.env.VITEST_USE_REAL_REDIS === 'true') return
    const { RedisService } = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
    const spy = vi.spyOn(redis, 'createAgent').mockImplementation((agent) => RedisService.prototype.createAgent.call(redis, agent))
    restoreCreate = () => spy.mockRestore()
  })
  afterEach(() => { restoreCreate?.(); restoreCreate = undefined })
  it('scrubs a Primary create while preserving other tool rows and unknown row siblings', async () => {
    const response = await createAgent({ displayName: 'Retired Primary', agentType: 'api', ...retiredRows })
    expect(response.status).toBe(200)
    const body = await response.json()
    await expectRetiredRemoved(`agent:${body.id}`)
  })

  it('scrubs a human duplicate payload without changing its legacy source record', async () => {
    const source = { id: 'legacy-source', user_id: USER, displayName: 'Legacy source', agentType: 'api', ...retiredRows }
    await redis.json.set('agent:legacy-source', '$', source)
    const response = await createAgent({ ...source, id: 'retired-duplicate', displayName: 'Retired Duplicate' })
    expect(response.status).toBe(200)
    const body = await response.json()
    await expectRetiredRemoved(`agent:${body.id}`)
    expect(await redis.json.get('agent:legacy-source')).toEqual(source)
  })

  it('scrubs the raw Subagent create body through its existing route owner', async () => {
    const response = await createSubagent({ displayName: 'Retired Subagent', subagentType: 'api', ...retiredRows })
    expect(response.status).toBe(200)
    const body = await response.json()
    await expectRetiredRemoved(`subagent:${body.subagent.id}`)
  })
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
