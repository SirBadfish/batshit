// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedisClientType } from 'redis'
vi.mock('$lib/server/redis', async () => vi.importActual('$lib/server/redis'))
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { AuthService } from '$lib/services/auth.server'
import { BUILTIN_PLUGIN_SKILLS } from '../systemPluginPackage'
import { initializeSystemSlashCommandsAtStartup, initializeSystemSlashCommandsForUser, ensureSystemSlashCommands } from '../systemSlashCommands'
import { getEnabledAgentSlashCapabilities, listAllSlashCapabilities } from '../slashCommandCapabilities'
import { beginSlashCommandWrite, captureSlashCommandWriteBasis, saveSlashCommandRecord, readSlashCommandRevision } from '../slashCommandRevision'
import type { SlashCommandRow } from '$lib/types/database'

const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL)('explicit built-in initialization and read-only capability admission', () => {
  let client: RedisClientType
  let previousPool: string | undefined
  let userId: string
  let serial = 0
  beforeAll(() => { previousPool = process.env.VITEST_POOL_ID; process.env.VITEST_POOL_ID = '0' })
  useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
    expect((await adminClient.clientInfo()).db).toBe(15)
    expect(new URL(resolvedUrl).pathname).toBe('/15')
    const info = await adminClient.info('server')
    expect(info).toContain('redis_version:8.10.1')
    expect(await adminClient.sendCommand(['COMMAND', 'INFO', 'JSON.SET'])).toEqual([expect.any(Array)])
    // Optional local owner receipts qualify the borrowed lane, not a fixed QA port.
    const expected = [process.env.RELEASE_TEST_REDIS_RUN_ID, process.env.RELEASE_TEST_REDIS_PID, process.env.RELEASE_TEST_REDIS_DIR]
    if (expected.some(Boolean)) {
      expect(expected.every(Boolean)).toBe(true)
      expect(info).toContain(`run_id:${expected[0]}`)
      expect(info).toContain(`process_id:${expected[1]}`)
      expect((await adminClient.configGet('dir')).dir).toBe(expected[2])
    }
    client = adminClient
  } })
  beforeEach(async () => {
    vi.restoreAllMocks()
    userId = `release_catalog_${++serial}`
    await client.json.set(`user:${userId}:data`, '$', { id: userId, email: `${userId}@example.invalid` })
    await client.sAdd('users:all', userId)
  })
  afterAll(() => { if (previousPool === undefined) delete process.env.VITEST_POOL_ID; else process.env.VITEST_POOL_ID = previousPool })

  function command(id: string, extra: Partial<SlashCommandRow> = {}): SlashCommandRow {
    return { id, user_id: userId, name: id, displayName: id, description: 'before', type: 'prompt',
      instructions: 'fixture', parameters: [], is_active: true, can_be_invoked_in_chat: true,
      enabled_for_all_agents: true, enabled_agent_ids: [], created_at: 'fixture-created', updated_at: 'fixture-updated', ...extra }
  }
  async function save(record: SlashCommandRow, mode: 'create' | 'update') {
    const basis = await captureSlashCommandWriteBasis(beginSlashCommandWrite(userId), [record.id])
    return saveSlashCommandRecord(userId, { record, mode }, basis)
  }
  async function legacyAccess(ids: string[]) {
    for (const skill of BUILTIN_PLUGIN_SKILLS.slice(0, 6)) {
      await client.json.set(`slash_command:${userId}:${skill.commandId}`, '$', command(skill.commandId, {
        type: 'skill', skill_id: skill.skillId, is_system: true, enabled_for_all_agents: false, enabled_agent_ids: ids
      }) as any)
    }
  }
  function observe(methods: (target: any, key: PropertyKey, value: any) => any) {
    const original = redis.execute.bind(redis)
    vi.spyOn(redis, 'execute').mockImplementation(callback => original(target => callback(new Proxy(target, {
      get(row, key) {
        const value = Reflect.get(row, key, row)
        return methods(row, key, typeof value === 'function' ? value.bind(row) : value)
      }
    }))))
  }

  it('refuses a cold read without seeding, then the actual startup owner makes every fresh skill available', async () => {
    await expect(getEnabledAgentSlashCapabilities(userId, 'actor')).rejects.toMatchObject({ code: 'SYSTEM_SKILLS_UNAVAILABLE' })
    expect(await client.keys(`agent_plugin:${userId}:*`)).toEqual([])
    expect(await client.keys(`slash_command:${userId}:*`)).toEqual([])
    await initializeSystemSlashCommandsAtStartup()
    expect(await getEnabledAgentSlashCapabilities(userId, 'actor')).toHaveLength(8)
    expect(await listAllSlashCapabilities(userId)).toHaveLength(8)
  })

  it.each([{ ids: [] }, { ids: ['Exact.Agent'] }])('preserves the original legacy access $ids through initialization', async ({ ids }) => {
    await legacyAccess(ids)
    const before = await Promise.all(BUILTIN_PLUGIN_SKILLS.slice(0, 6).map(skill => client.json.get(`slash_command:${userId}:${skill.commandId}`)))
    await initializeSystemSlashCommandsForUser(userId)
    const plugin = await client.json.get(`agent_plugin:${userId}:batshit`) as any
    expect(plugin.enabled_for_all_agents).toBe(false)
    expect(plugin.enabled_agent_ids).toEqual(ids)
    expect(await getEnabledAgentSlashCapabilities(userId, 'Exact.Agent')).toHaveLength(ids.length ? 8 : 0)
    expect(await getEnabledAgentSlashCapabilities(userId, 'exact_agent')).toEqual([])
    expect(await Promise.all(BUILTIN_PLUGIN_SKILLS.slice(0, 6).map(skill => client.json.get(`slash_command:${userId}:${skill.commandId}`)))).toEqual(before)
  })

  it('keeps a restored missing group unavailable instead of falling back to legacy grants', async () => {
    await legacyAccess([])
    await initializeSystemSlashCommandsForUser(userId)
    await client.del(`agent_plugin:${userId}:batshit`)
    await expect(getEnabledAgentSlashCapabilities(userId, 'actor')).rejects.toMatchObject({ code: 'SYSTEM_SKILLS_UNAVAILABLE' })
    expect(await client.exists(`agent_plugin:${userId}:batshit`)).toBe(0)
    await initializeSystemSlashCommandsForUser(userId)
    expect(await getEnabledAgentSlashCapabilities(userId, 'actor')).toEqual([])
  })

  it('never publishes an auth session when real saved plugin access is unreadable', async () => {
    await initializeSystemSlashCommandsForUser(userId)
    await client.json.set(`agent_plugin:${userId}:batshit`, '$.enabled_agent_ids', 'unreadable')
    const auth = new AuthService()
    try { await expect(auth.createSession({ id: userId, email: `${userId}@example.invalid`, is_admin: true })).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' }) }
    finally { await auth.disconnect() }
    expect(await client.keys('user_session:*')).toEqual([])
  })

  it('allows an unrelated real command write during capability reads without entering mutation admission', async () => {
    await initializeSystemSlashCommandsForUser(userId)
    await save(command('custom'), 'create')
    let injected = false, evals = 0
    observe((_target, key, value) => {
      if (key === 'eval') return (...args: any[]) => { evals++; return value(...args) }
      if (key === 'keys') return async (pattern: string) => {
        if (pattern === `slash_command:${userId}:*` && !injected) {
          injected = true
          await save(command('custom', { displayName: 'after' }), 'update')
        }
        return value(pattern)
      }
      return value
    })
    const capabilities = await getEnabledAgentSlashCapabilities(userId, 'actor')
    expect(injected).toBe(true)
    expect(capabilities.find(row => row.id === 'custom')?.displayName).toBe('after')
    // Exactly one actual writer's basis + commit; the read issues neither.
    expect(evals).toBe(2)
    const revision = await readSlashCommandRevision(userId)
    await listAllSlashCapabilities(userId)
    expect(evals).toBe(2)
    expect(await readSlashCommandRevision(userId)).toBe(revision)
  })

  it('retains genuine original-owner mutation conflict refusal without retrying it', async () => {
    await initializeSystemSlashCommandsForUser(userId)
    await save(command('custom'), 'create')
    await client.del(`skill:${userId}:${BUILTIN_PLUGIN_SKILLS[0].skillId}`)
    let injected = false
    observe((_target, key, value) => key === 'eval' ? async (script: string, options: any) => {
      if (!injected && script.includes("'CAPTURED'") && options.keys.includes(`slash_command:${userId}:skill-creator`)) {
        injected = true
        const captured = await value(script, options)
        await save(command('custom', { description: 'concurrent write' }), 'update')
        return captured
      }
      return value(script, options)
    } : value)
    await expect(ensureSystemSlashCommands(userId)).rejects.toMatchObject({ code: 'SLASH_COMMAND_CONFLICT' })
    expect(injected).toBe(true)
    expect(await client.json.get(`slash_command:${userId}:custom`)).toMatchObject({ description: 'concurrent write' })
  })
})
