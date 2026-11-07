import { beforeEach, describe, expect, it, vi } from 'vitest'

// BL-544: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

const skillRegistry = vi.hoisted(() => ({
  deleteSkillIfOrphaned: vi.fn(async () => {}),
  getSkill: vi.fn(),
  normalizeSkillId: vi.fn((value: string) => value),
  upsertSkill: vi.fn()
}))
vi.mock('$lib/server/services/skillRegistry', () => skillRegistry)
vi.mock('$lib/server/services/systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn(async () => {}) }))

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET, PUT } from './+server'
import { GET as LIST } from '../+server'

/**
 * BL-544: a skill's per-agent access list (`enabled_agent_ids`) is written by Settings > Agents >
 * Access one agent at a time. The skill routes that rewrite the whole command record (a Skills &
 * Prompts save, and the metadata refresh of the two GET routes) read the record first and wrote
 * that copy back whole, after awaiting the skill files in between; an agent turned on or off in
 * that gap was undone. The accepted P4 original-basis contract now refuses that concurrent
 * change before stale metadata is published. An unchanged basis preserves an omitted access
 * list; an explicit list still replaces it. A conflict never rebases or retries the write.
 *
 * Each case lands the Access change inside the gap (the skill registry mock writes it while the
 * route awaits it). Real Redis 8: it runs only under `npm run test:redis` and reports as skipped in
 * the default lane.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'ssacc_skill_user'
const COMMAND = 'ssacc-notes'
const KEY = `slash_command:${USER}:${COMMAND}`

function skillCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMAND,
    user_id: USER,
    name: COMMAND,
    displayName: 'Ssacc Notes',
    description: 'Probe skill.',
    type: 'skill',
    instructions: '',
    parameters: [],
    skill_id: 'ssacc_notes',
    skill_source: 'custom',
    skill_summary: 'Probe skill.',
    skill_dependencies: [],
    skill_metadata: {},
    skill_allowed_tools: [],
    skill_standards_status: 'full',
    skill_standards_issues: [],
    trust_level: 'untrusted',
    has_scripts: false,
    has_references: false,
    has_assets: false,
    invocation_pattern: '/ssacc-notes',
    can_be_attached_to_agents: true,
    can_be_invoked_in_chat: true,
    enabled_for_all_agents: false,
    enabled_agent_ids: ['ssacc_nova'],
    category: 'skills',
    tags: [],
    usage_count: 0,
    is_active: true,
    is_system: false,
    created_at: '2026-09-28T10:00:00.000Z',
    updated_at: '2026-09-28T10:00:00.000Z',
    ...overrides
  }
}

function skillRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ssacc_notes',
    name: COMMAND,
    displayName: 'Ssacc Notes',
    description: 'Probe skill.',
    source: 'custom',
    source_ref: undefined,
    dependencies: [],
    metadata: {},
    allowed_tools: [],
    standards_status: 'full',
    standards_issues: [],
    trust_level: 'untrusted',
    has_scripts: false,
    has_references: false,
    has_assets: false,
    is_active: true,
    ...overrides
  }
}

/** What Settings > Agents > Access writes while the route awaits the skill files. */
async function accessTurnsOn(agentId: string) {
  const list = ((await redis.json.get(KEY)) as any).enabled_agent_ids as string[]
  await redis.json.set(KEY, '$.enabled_agent_ids', [...list, agentId] as any)
}

async function put(body: Record<string, unknown>) {
  const request = new Request(`http://localhost/api/slash-commands/${COMMAND}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const response = (await (PUT as any)({ params: { id: COMMAND }, request, locals: { user: { id: USER } } })) as Response
  return { status: response.status, body: await response.json() }
}

async function stored() {
  return (await redis.json.get(KEY)) as Record<string, any> | null
}

describe.runIf(REAL_REDIS_LANE)('the skill routes preserve access and refuse a changed original basis (BL-544, P4)', () => {
  useRedisTestServer()
  beforeEach(() => {
    skillRegistry.getSkill.mockReset()
    skillRegistry.upsertSkill.mockReset()
  })

  it('a Trust save refuses a concurrent Access change, retaining the current list and original metadata', async () => {
    await redis.json.set(KEY, '$', skillCommand() as any)
    skillRegistry.upsertSkill.mockImplementationOnce(async () => {
      await accessTurnsOn('ssacc_orla')
      return skillRecord({ trust_level: 'trusted' })
    })

    const { status, body } = await put({ skill: { id: 'ssacc_notes', name: 'Ssacc Notes', trustLevel: 'trusted' } })

    expect(status).toBe(409)
    expect(body.code).toBe('SLASH_COMMAND_CONFLICT')
    const record = await stored()
    expect(record?.trust_level).toBe('untrusted')
    expect(record?.enabled_agent_ids).toEqual(['ssacc_nova', 'ssacc_orla'])
    expect(record?.can_be_attached_to_agents).toBe(true)
    expect(skillRegistry.upsertSkill).toHaveBeenCalledTimes(1)
  })

  it('a save that sends a list still replaces the list (an explicit caller)', async () => {
    await redis.json.set(KEY, '$', skillCommand() as any)

    const { status } = await put({ enabled_agent_ids: ['ssacc_pax'] })

    expect(status).toBe(200)
    expect((await stored())?.enabled_agent_ids).toEqual(['ssacc_pax'])
  })

  it('a save of another field keeps a record with no list at all without one (on for every agent)', async () => {
    const legacy: Record<string, unknown> = skillCommand()
    delete legacy.enabled_agent_ids
    await redis.json.set(KEY, '$', legacy as any)

    const { status } = await put({ is_active: false })

    expect(status).toBe(200)
    const record = await stored()
    expect(record?.is_active).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(record, 'enabled_agent_ids')).toBe(false)
  })

  it('a save whose original command was deleted refuses its stale basis and does not recreate or retry it', async () => {
    await redis.json.set(KEY, '$', skillCommand() as any)
    skillRegistry.upsertSkill.mockImplementationOnce(async () => {
      await redis.del(KEY)
      return skillRecord({ trust_level: 'trusted' })
    })

    const { status, body } = await put({ skill: { id: 'ssacc_notes', name: 'Ssacc Notes', trustLevel: 'trusted' } })

    expect(status).toBe(409)
    expect(body.code).toBe('SLASH_COMMAND_CONFLICT')
    expect(await stored()).toBeNull()
    expect(skillRegistry.upsertSkill).toHaveBeenCalledTimes(1)
  })

  it("the command GET refuses stale metadata after a concurrent Access change without rebasing", async () => {
    await redis.json.set(KEY, '$', skillCommand() as any)
    skillRegistry.getSkill.mockImplementationOnce(async () => {
      await accessTurnsOn('ssacc_orla')
      return skillRecord({ description: 'Probe skill, described again on disk.' })
    })

    const response = (await (GET as any)({ params: { id: COMMAND }, locals: { user: { id: USER } } })) as Response

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('SLASH_COMMAND_CONFLICT')
    const record = await stored()
    expect(record?.skill_summary).toBe('Probe skill.')
    expect(record?.enabled_agent_ids).toEqual(['ssacc_nova', 'ssacc_orla'])
    expect(skillRegistry.getSkill).toHaveBeenCalledTimes(1)
  })

  it("the list GET also refuses stale metadata and keeps current Access without a retry", async () => {
    await redis.json.set(KEY, '$', skillCommand() as any)
    skillRegistry.getSkill.mockImplementationOnce(async () => {
      await accessTurnsOn('ssacc_orla')
      return skillRecord({ description: 'Probe skill, described again on disk.' })
    })

    const response = (await (LIST as any)({ locals: { user: { id: USER } } })) as Response

    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('SLASH_COMMAND_CONFLICT')
    const record = await stored()
    expect(record?.skill_summary).toBe('Probe skill.')
    expect(record?.enabled_agent_ids).toEqual(['ssacc_nova', 'ssacc_orla'])
    expect(skillRegistry.getSkill).toHaveBeenCalledTimes(1)
  })
})
