import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RESP_TYPES, type RedisClientType } from 'redis'

const fixture = vi.hoisted(() => ({ clients: [] as any[] }))
// The auth service owns a raw node-redis client, outside the shared facade's
// fake/URL guards. Verify EVERY actual connection before its caller can write.
vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>()
  return {
    ...actual,
    createClient: (options: Parameters<typeof actual.createClient>[0]) => {
      const client = actual.createClient(options)
      const connect = client.connect.bind(client)
      Object.defineProperty(client, 'connect', { value: async () => {
        await connect()
        const info = await client.clientInfo()
        if (info.db !== 15 || options?.database !== 15) {
          await client.disconnect()
          throw new Error('First-admin proof refuses any connection except explicitly selected DB15.')
        }
        return client
      } })
      fixture.clients.push(client)
      return client
    }
  }
})

import { AuthService, authService, CREATE_INITIAL_ADMIN_SCRIPT, resolveAuthRedisDatabase } from './auth.server'
import { actions } from '../../routes/setup/+page.server'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { listCoreSystemPrompts } from '$lib/server/services/systemPromptRegistry'
import { MEMORY_MEDIA_MIGRATION_KEY } from '$lib/server/services/memory/memoryKeys'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const PASSWORD = 'test-etic-first-admin-password'

/** Real Redis only. This sequential suite pins its harness worker offset to
 * zero so it selects DB15; raw auth connections are verified independently. No
 * Redis fake evaluates this script, and no auth credential/file leaves the suite. */
describe.runIf(REAL_REDIS_LANE)('BL-1482 first-admin admission (real Redis, DB15)', () => {
  let client: RedisClientType
  const services = new Set<AuthService>()
  let previousPoolId: string | undefined
  beforeAll(() => {
    previousPoolId = process.env.VITEST_POOL_ID
    process.env.VITEST_POOL_ID = '0'
  })
  afterAll(() => {
    if (previousPoolId === undefined) delete process.env.VITEST_POOL_ID
    else process.env.VITEST_POOL_ID = previousPoolId
  })
  useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
    expect(resolveAuthRedisDatabase(resolvedUrl)).toBe(15)
    expect((await adminClient.clientInfo()).db).toBe(15)
    expect(await adminClient.info('server')).toContain('redis_version:8.10.1')
    expect(await adminClient.sendCommand(['COMMAND', 'INFO', 'JSON.SET'])).toEqual([expect.any(Array)])
    client = adminClient
  } })
  beforeAll(() => { services.add(authService) })
  afterEach(async () => {
    for (const service of services) await service.disconnect()
    for (const connection of fixture.clients) if (connection.isOpen && connection !== client) await connection.disconnect()
    fixture.clients.length = 0
  })

  function service() {
    const instance = new AuthService()
    services.add(instance)
    return instance
  }
  function setup(name: string, email = `${name.toLowerCase()}@example.invalid`) {
    const form = new FormData()
    for (const [key, value] of Object.entries({ email, password: PASSWORD, confirmPassword: PASSWORD, displayName: name })) form.set(key, value)
    return { request: { formData: async () => form }, cookies: { set: vi.fn() } } as any
  }
  async function snapshot() {
    expect((await client.clientInfo()).db).toBe(15)
    const keys = (await client.keys('*')).sort()
    const binary = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
    return Promise.all(keys.map(async (key) => [key, (await binary.dump(key))?.toString('base64')]))
  }
  function scriptInput(id = 'fixture') {
    return {
      keys: [`user:${id}:data`, `user:${id}:settings`, `email:${id}@example.invalid`, 'users:all', 'user:admin'],
      arguments: [id, `${id}@example.invalid`, JSON.stringify({ id, email: `${id}@example.invalid`, password: 'synthetic-hash', is_admin: true }), JSON.stringify({ user_id: id })]
    }
  }

  it('normal setup succeeds after actual prompt startup seeding and preserves unrelated system state, login and session TTL', async () => {
    const prompts = await listCoreSystemPrompts()
    expect(prompts.length).toBeGreaterThan(0)
    await client.sAdd('user:system:clips', 'retained-system-helper')
    await client.json.set(MEMORY_MEDIA_MIGRATION_KEY, '$', { status: 'migrated', records: 0, media: 0, unresolved: 0 })
    const before = await snapshot()
    const input = setup('FirstAdmin')
    await expect(actions.setup(input)).rejects.toMatchObject({ status: 303, location: '/' })
    const user = await authService.authenticate('firstadmin@example.invalid', PASSWORD)
    expect(user).toMatchObject({ id: 'firstadmin', is_admin: true })
    expect(await authService.authenticate('firstadmin@example.invalid', 'wrong-password')).toBeNull()
    const [cookieName, token, cookieOptions] = input.cookies.set.mock.calls[0]
    expect(cookieName).toBeTruthy()
    expect(cookieOptions).toMatchObject({ httpOnly: true, sameSite: 'lax', maxAge: undefined })
    expect((await authService.validateSession(token))?.user).toEqual(user)
    expect(await client.ttl(`user_session:${token}`)).toBeGreaterThan(86_300)
    const after = await snapshot()
    for (const entry of before) expect(after).toContainEqual(entry)
    expect(await client.get('user:admin')).toBe('firstadmin')
    expect(await client.sMembers('users:all')).toEqual(['firstadmin'])
    expect(await authService.hasUsers()).toBe(true)
    await authService.deleteSession(token)
    expect(await authService.validateSession(token)).toBeNull()
    const remembered = await authService.createSession(user!, true)
    expect(await client.ttl(`user_session:${remembered.token}`)).toBeGreaterThan(30 * 86_400 - 100)
    expect((await authService.validateSession(remembered.token))?.user).toEqual(user)
    await authService.deleteSession(remembered.token)
  })

  it('a direct repeat POST with a different name/email refuses without replacing any saved bytes or creating another session', async () => {
    await expect(actions.setup(setup('Original'))).rejects.toMatchObject({ status: 303 })
    const before = await snapshot()
    const input = setup('Replacement')
    expect(await actions.setup(input)).toMatchObject({ status: 409 })
    expect(input.cookies.set).not.toHaveBeenCalled()
    expect(await snapshot()).toEqual(before)
    expect((await authService.authenticate('original@example.invalid', PASSWORD))?.is_admin).toBe(true)
  })

  it.each([false, true])('two independent service connections publish exactly one admin (same email: %s)', async (sameEmail) => {
    const a = service(), b = service()
    const results = await Promise.all([
      a.createAdminUser('a@example.invalid', PASSWORD, 'Alpha'),
      b.createAdminUser(sameEmail ? 'a@example.invalid' : 'b@example.invalid', PASSWORD, 'Beta')
    ])
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => result.status === 409)).toHaveLength(1)
    const winner = results.find(result => result.success)!.user!
    const loser = winner.id === 'alpha' ? 'beta' : 'alpha'
    expect(await client.get('user:admin')).toBe(winner.id)
    expect(await client.sMembers('users:all')).toEqual([winner.id])
    expect(await client.get(`email:${winner.email}`)).toBe(winner.id)
    expect(await client.exists([`user:${loser}:data`, `user:${loser}:settings`])).toBe(0)
    expect(await client.keys('email:*')).toHaveLength(1)
    expect(await client.keys('user_session:*')).toHaveLength(0)
  })

  it.each([
    ['users:all', 'set'], ['users:all', 'wrong-type'], ['user:admin', 'string'], ['user:admin', 'json'],
    ['user:old:data', 'json'], ['user:old:settings', 'json'], ['user:old:agents', 'set'],
    ['email:old@example.invalid', 'string'], ['user_session:old-token', 'json'], ['user:system:data', 'json']
  ])('refuses existing/partial state %s (%s) with every byte preserved', async (key, type) => {
    if (type === 'set') await client.sAdd(key, 'old-user')
    else if (type === 'json') await client.json.set(key, '$', { retained: true })
    else await client.set(key, 'retained-original')
    const before = await snapshot()
    expect(await service().createAdminUser('new@example.invalid', PASSWORD, 'NewAdmin')).toMatchObject({ success: false, status: 409 })
    expect(await snapshot()).toEqual(before)
  })

  it('refuses invalid service inputs before connecting or writing', async () => {
    const instance = service()
    const before = await snapshot()
    expect(await instance.createAdminUser('fixture@example.invalid', 'short', 'Fixture')).toMatchObject({ status: 400 })
    expect(await instance.createAdminUser('fixture@example.invalid', PASSWORD, '!!!')).toMatchObject({ status: 400 })
    expect(await snapshot()).toEqual(before)
  })

  it('a failed admission read writes nothing', async () => {
    const before = await snapshot()
    const injected = CREATE_INITIAL_ADMIN_SCRIPT.replace("redis.call('SCAN',", "redis.call('BL1482_FAILED_READ',")
    expect(injected).not.toBe(CREATE_INITIAL_ADMIN_SCRIPT)
    await expect(client.eval(injected, scriptInput())).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('validates both JSON inputs before writing any account key', async () => {
    const before = await snapshot()
    const input = scriptInput()
    input.arguments[3] = '{malformed-json'
    await expect(client.eval(CREATE_INITIAL_ADMIN_SCRIPT, input)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it.each([2, 3, 4, 5])('a command failure at account write %s removes only this invocation\'s new keys', async (index) => {
    await client.set('batshit:fixture-preserved', 'original')
    const before = await snapshot()
    const lines = CREATE_INITIAL_ADMIN_SCRIPT.split('\n')
    const writes = lines.map((line, lineIndex) => ({ line, lineIndex })).filter(({ line }) => /^    \{'/.test(line))
    expect(writes).toHaveLength(5)
    lines[writes[index - 1].lineIndex] = writes[index - 1].line.replace(/\{'[^']+'/, "{'BL1482_FAILED_WRITE'")
    expect(await client.eval(lines.join('\n'), scriptInput())).toBe('WRITE_FAILED')
    expect(await snapshot()).toEqual(before)
    expect((await service().createAdminUser('retry@example.invalid', PASSWORD, 'RetryAdmin')).success).toBe(true)
  })

  it('a failed rollback is reported PARTIAL and its retained account state blocks another setup', async () => {
    const injected = CREATE_INITIAL_ADMIN_SCRIPT
      .replace("{'SET', KEYS[5]", "{'BL1482_FAILED_WRITE', KEYS[5]")
      .replace("redis.pcall('DEL',", "redis.pcall('BL1482_FAILED_ROLLBACK',")
    expect(await client.eval(injected, scriptInput())).toBe('PARTIAL')
    const before = await snapshot()
    expect(await service().createAdminUser('retry@example.invalid', PASSWORD, 'Retry')).toMatchObject({ success: false, status: 409 })
    expect(await snapshot()).toEqual(before)
  })
})
