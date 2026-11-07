import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import { redis } from '$lib/server/redis'
import { clearRedisTestDatabase, useRedisTestServer } from '$lib/test-utils/redis-memory'
import { assertRedisCiServiceOwner, type RedisCiServiceOwner } from '$lib/test-utils/settingsRedisAdmission'
import { SKILL_SESSION_COMMIT_SCRIPT, type PreparedSkillSessionCommit } from '$lib/server/services/skillSessionCommit'

/** One owner's finite default-lane semantic twin. This is not Lua/Redis atomicity proof. */
export async function runSkillSessionCommitTwin(client: any, keys: string[], args: string[]): Promise<string[]> {
  const guards = JSON.parse(args[0]) as PreparedSkillSessionCommit['guards']
  const writes = JSON.parse(args[1]) as PreparedSkillSessionCommit['writes']
  for (const guard of guards) {
    const key = keys[guard.key - 1]
    if (!key) return ['INVALID', 'guard_key']
    const kind = await client.type(key)
    if (guard.kind === 'list') {
      if (kind !== 'none' && kind !== 'list') return ['CHANGED', 'source_type']
      const current = kind === 'none' ? [] : await client.lRange(key, 0, -1)
      if (JSON.stringify(current) !== JSON.stringify(guard.values)) return ['CHANGED', 'message_list']
    } else if (guard.raw === null) {
      if (kind !== 'none') return ['CHANGED', 'source_presence']
    } else {
      if (kind !== (guard.kind === 'json' ? 'ReJSON-RL' : 'string')) return ['CHANGED', 'source_type']
      const raw = guard.kind === 'json' ? await client.json.getRaw(key, '$') : await client.get(key)
      if (raw !== guard.raw) return ['CHANGED', 'source_value']
    }
  }
  for (const write of writes) {
    const key = keys[write.key - 1]
    if (!key) return ['INVALID', 'write_key']
    const kind = await client.type(key)
    if (write.command === 'SADD' || write.command === 'SREM') {
      if (kind !== 'none' && kind !== 'set') return ['INVALID', 'set_type']
      if (typeof write.member !== 'string') return ['INVALID', 'set_member']
    } else if (write.command === 'JSON.SET') {
      if (kind !== 'none' && kind !== 'ReJSON-RL') return ['INVALID', 'json_type']
      if (write.path !== '$' && write.path !== '$.metadata.skillSessionAdmission') return ['INVALID', 'json_path']
      let value: unknown
      try { value = JSON.parse(write.value!) } catch { return ['INVALID', 'json_value'] }
      if (!value || typeof value !== 'object') return ['INVALID', 'json_value']
      if (write.path !== '$') {
        if (kind !== 'ReJSON-RL') return ['INVALID', 'missing_zip']
        const stored = await client.json.get(key)
        if (!stored?.metadata || typeof stored.metadata !== 'object' || Array.isArray(stored.metadata)) return ['INVALID', 'zip_metadata']
      }
    } else if (write.command === 'DEL') {
      if (kind !== 'none' && kind !== 'ReJSON-RL') return ['INVALID', 'delete_type']
    } else return ['INVALID', 'write_command']
  }
  let confirmed = 0
  for (const write of writes) {
    const key = keys[write.key - 1]
    let result: unknown
    try {
      if (write.command === 'JSON.SET') result = await client.json.set(key, write.path, JSON.parse(write.value!))
      else if (write.command === 'DEL') result = await client.del(key)
      else if (write.command === 'SADD') {
        // The shared fake reports set size, not Redis's added-member count. Normalize only
        // this owner's finite command; production and every other fake command stay intact.
        const existed = await client.type(key) === 'set' && (await client.sMembers(key)).includes(write.member)
        await client.sAdd(key, write.member)
        result = existed ? 0 : 1
      }
      else if (await client.type(key) === 'none') result = 0
      else {
        result = await client.sRem(key, write.member)
        if ((await client.sMembers(key)).length === 0) await client.del(key)
      }
    } catch { return ['PARTIAL', String(confirmed), 'command_error'] }
    const good = write.command === 'JSON.SET' ? result === 'OK' : result === 0 || result === 1
    if (!good) return ['PARTIAL', String(confirmed), 'unconfirmed_command']
    confirmed += 1
  }
  return ['APPLIED', String(confirmed)]
}

/** Call once at suite module scope. The real-Redis lane always executes the actual Lua. */
export function useSkillSessionCommitTwin(): void {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return
  let restore: (() => void) | undefined
  beforeEach(() => {
    const original = redis.execute
    ;(redis as any).execute = async (operation: (client: any) => unknown) =>
      original.call(redis, async (client: any) => operation(new Proxy(Object.create(null), {
        get(_target, property) {
          if (property === 'eval') return (script: string, options: { keys: string[]; arguments: string[] }) => {
            if (script === SKILL_SESSION_COMMIT_SCRIPT) return runSkillSessionCommitTwin(client, options.keys, options.arguments)
            if (typeof client.eval !== 'function') throw new Error('The skill-session twin does not implement another owner\'s script.')
            return client.eval(script, options)
          }
          const value = Reflect.get(client, property, client)
          return typeof value === 'function' ? value.bind(client) : value
        }
      })))
    restore = () => { (redis as any).execute = original }
  })
  afterEach(() => { restore?.(); restore = undefined })
}

/** Reuse the one coordinator-owned isolated DB15 allocation; no server/config/controller is created. */
export function useSkillSessionRedisTestServer() {
  const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
  const previousPoolId = process.env.VITEST_POOL_ID
  let admittedClient: any
  let admittedRunId: string | undefined
  let closed = false
  let appTouched = false
  let appAdmission: Promise<unknown> | undefined
  let appAdmissionSettled = true
  let appClosure: Promise<void> | undefined
  function closeAppClient(): Promise<void> {
    if (appClosure) return appClosure
    if (!appTouched) return Promise.resolve()
    appClosure = (async () => {
      const errors: unknown[] = []
      if (!appAdmissionSettled) {
        try { await redis.disconnect() } catch (error) { errors.push(error) }
        try { await appAdmission } catch { /* Admission retains its original failure. */ }
      }
      try { await redis.disconnect() } catch (error) { errors.push(error) }
      appTouched = false
      if (errors.length) throw new AggregateError(errors, 'Skill-session Redis app connection close failed.')
    })().finally(() => { appClosure = undefined })
    return appClosure
  }
  beforeAll(() => { if (REAL) process.env.VITEST_POOL_ID = '0' })
  const admission = useRedisTestServer({ beforeCleanupAdmission: async ({ adminClient, resolvedUrl }) => {
    if (closed) throw new Error('Skill-session Redis admission continued after teardown.')
    const raw = process.env.BATSHIT_SKILL_COMMIT_REDIS_ADMISSION
    if (!raw) throw new Error('The isolated skill-commit Redis allocation must be supplied before cleanup.')
    const allocation = JSON.parse(raw) as { port: number; pid: number; runId: string; directory: string; ciOwner?: RedisCiServiceOwner }
    const ciOwner = allocation.ciOwner === undefined ? undefined : assertRedisCiServiceOwner(allocation.ciOwner)
    if (!Number.isInteger(allocation.port) || (ciOwner ? allocation.port !== 6379 : [6379, 6380, 5639, 5649].includes(allocation.port)) ||
        !Number.isInteger(allocation.pid) || !/^[a-f0-9]{40}$/.test(allocation.runId) || (typeof allocation.directory !== 'string' || !allocation.directory.startsWith('/'))) throw new Error('Invalid isolated skill-commit allocation.')
    const url = new URL(resolvedUrl)
    expect(url.hostname).toBe('127.0.0.1'); expect(Number(url.port)).toBe(allocation.port); expect(url.pathname).toBe('/15')
    const admit = async (client: any) => {
      const connection = await client.clientInfo()
      expect(connection.db).toBe(15)
      if (ciOwner) expect(connection.laddr).toBe(ciOwner.localAddress)
      const info = await client.info('server') as string
      const field = (key: string) => info.match(new RegExp(`^${key}:([^\\r\\n]+)`, 'm'))?.[1]
      expect(field('redis_version')).toBe('8.10.1'); expect(field('run_id')).toBe(allocation.runId)
      expect(Number(field('process_id'))).toBe(allocation.pid)
      expect((await client.configGet('dir')).dir).toBe(allocation.directory)
      const modules = await client.sendCommand(['MODULE', 'LIST']) as any[]
      const versions = new Map(modules.map(row => {
        const fields = new Map<string, unknown>()
        for (let index = 0; index < row.length; index += 2) fields.set(String(row[index]), row[index + 1])
        return [String(fields.get('name')).toLowerCase(), Number(fields.get('ver'))] as const
      }))
      expect(versions.get('rejson')).toBe(81000); expect(versions.get('search')).toBe(81000)
    }
    await admit(adminClient)
    try {
      appTouched = true
      appAdmissionSettled = false
      appAdmission = redis.execute(async client => {
        if (closed) {
          if (client.isOpen) await client.disconnect()
          throw new Error('Skill-session Redis client was acquired after teardown.')
        }
        await admit(client)
        if (closed) throw new Error('Skill-session Redis admission continued after teardown.')
        admittedClient = client; admittedRunId = allocation.runId
      })
      try { await appAdmission } finally { appAdmissionSettled = true }
      if (closed) throw new Error('Skill-session Redis admission continued after teardown.')
    } catch (error) {
      try { await closeAppClient() } catch (closeError) {
        throw new AggregateError([error, closeError], 'Skill-session Redis admission and app close failed.')
      }
      throw error
    }
  } })
  afterAll(async () => {
    closed = true
    // This dedicated test allocation remains exclusively assigned until the coordinator is told.
    // Reuse the existing DB15-only cleanup; never clean a replaced/restarted connection.
    try {
      if (REAL && admittedClient) {
        expect((await admittedClient.clientInfo()).db).toBe(15)
        expect((await admittedClient.info('server') as string).match(/^run_id:([^\r\n]+)/m)?.[1]).toBe(admittedRunId)
        await clearRedisTestDatabase(admittedClient)
      }
    } finally {
      try { await closeAppClient() } finally {
        if (previousPoolId === undefined) delete process.env.VITEST_POOL_ID
        else process.env.VITEST_POOL_ID = previousPoolId
      }
    }
  })
  return admission
}
