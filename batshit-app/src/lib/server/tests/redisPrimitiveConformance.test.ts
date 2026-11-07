/**
 * SA-101 — Redis primitive conformance matrix.
 *
 * Batshit's storage layer is unusual: RedisJSON for nearly every record, raw `sendCommand`
 * for the Execution Viewer's array operations, seven Lua scripts that call module commands
 * inside `redis.call`, and two places that read `INFO` field names. A datastore upgrade can
 * break any of those without breaking a generic PING-and-set smoke test.
 *
 * This suite executes every command in the source-derived inventory against the real Redis
 * the lane is pointed at, and asserts the exact reply shapes Batshit depends on. It is the
 * gate that a datastore change must pass before it is called safe.
 *
 * It is deliberately inventory-driven: `EXPECTED_COMMAND_SURFACE` is the declared list, and
 * the final test fails if any declared command was never exercised. Adding a command to the
 * app without adding it here is caught by review; removing coverage here without removing
 * the command is caught by that test.
 *
 * Real-Redis lane only (`npm run test:redis`). Skipped under the in-memory fake, which
 * simulates RedisJSON rather than running it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Other suites mock $lib/server/redis; this one must exercise the real module's contract.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { createClient, type RedisClientType } from 'redis'
import { clearRedisTestDatabase } from '$lib/test-utils/redis-memory'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { BATSHIT_RUNTIME_REDIS_PORTS } from '$lib/server/redisRuntimePorts'

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

/**
 * Every Redis command Batshit issues, derived from source. Keep this in step with the
 * app: it is the contract this suite proves, and the last test fails on any gap.
 */
const EXPECTED_COMMAND_SURFACE = [
  // keys / strings
  'GET', 'SET', 'SET EX', 'DEL', 'EXISTS', 'TYPE', 'KEYS', 'SCAN', 'EXPIRE', 'TTL', 'PTTL', 'INCR',
  // sets
  'SADD', 'SMEMBERS', 'SREM', 'SCARD', 'SISMEMBER',
  // lists
  'LPUSH', 'RPUSH', 'LRANGE', 'LREM', 'LTRIM',
  // backup/restore typed records
  'HSET', 'HGETALL', 'ZADD', 'ZRANGE WITHSCORES',
  // RedisJSON
  'JSON.SET', 'JSON.GET', 'JSON.DEL', 'JSON.STRLEN', 'JSON.ARRAPPEND', 'JSON.ARRTRIM',
  // Lua
  'EVAL', 'EVAL redis.call', 'EVAL redis.pcall', 'EVAL redis.error_reply', 'EVAL cjson',
  // transport / admin
  'PUBLISH', 'PING', 'INFO server', 'INFO persistence', 'CONFIG SET', 'BGREWRITEAOF'
] as const

const exercised = new Set<string>()
const mark = (command: (typeof EXPECTED_COMMAND_SURFACE)[number]) => exercised.add(command)

const K = 'sa101:conformance'

type PrimitiveAllocation = Readonly<{
  schemaVersion: 1
  purpose: 'redis-primitive-conformance'
  allocationId: string
  createdAt: string
  host: '127.0.0.1'
  port: number
  database: 15
  version: '8.10.1'
  runId: string
  directory: string
  localAddress: string
  emptyAtAllocation: true
  owner: Readonly<{
    kind: 'local-supervised'; pid: number; startIdentity: string; tty: string
    directoryDevice: string; directoryInode: string
  }> | Readonly<{
    kind: 'github-actions-service'; serviceId: string; githubRunId: string; githubRunAttempt: string
  }>
  allocationPath: string
}>

function refusal(reason: string): never {
  throw new Error(`Redis primitive admin admission refused: ${reason}`)
}
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, fields: string[]): value is Record<string, any> {
  return record(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value)
}

// This private allocation comes from the held local foreground process or the
// workflow's actual job-owned container capture. It is not derived from a target
// URL here. Same-user malicious file/environment forgery is outside this guard.
async function readPrimitiveAllocation(): Promise<PrimitiveAllocation> {
  const path = process.env.BATSHIT_REDIS_ADMIN_ALLOCATION
  if (!path || !isAbsolute(path) || basename(path) !== 'redis-primitive-allocation.json') refusal('an explicit private allocation file is required.')
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.mode) & 0o077 ||
      Number(stat.uid) !== process.getuid?.() || stat.size > 65536n || await realpath(path) !== path) refusal('allocation file ownership or shape is invalid.')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!exact(value, ['schemaVersion', 'purpose', 'allocationId', 'createdAt', 'host', 'port', 'database',
    'version', 'runId', 'directory', 'localAddress', 'emptyAtAllocation', 'owner']) ||
    value.schemaVersion !== 1 || value.purpose !== 'redis-primitive-conformance' ||
    typeof value.allocationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.allocationId) ||
    value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || value.database !== 15 ||
    value.version !== '8.10.1' || typeof value.runId !== 'string' || !/^[a-f0-9]{40}$/.test(value.runId) ||
    !text(value.directory, 4096) || !isAbsolute(value.directory) || !text(value.localAddress, 128) ||
    value.emptyAtAllocation !== true || typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
    Date.now() < Date.parse(value.createdAt)) refusal('allocation is malformed or from the future.')
  if (value.owner?.kind === 'local-supervised') {
    if (!exact(value.owner, ['kind', 'pid', 'startIdentity', 'tty', 'directoryDevice', 'directoryInode']) ||
      !['darwin', 'linux'].includes(process.platform) || value.port < 49152 || BATSHIT_RUNTIME_REDIS_PORTS.has(value.port) ||
      Date.now() - Date.parse(value.createdAt) > 30 * 60_000 ||
      !Number.isSafeInteger(value.owner.pid) || value.owner.pid <= 1 || !text(value.owner.startIdentity, 128) ||
      !text(value.owner.tty, 128) || value.owner.tty.includes('?') ||
      typeof value.owner.directoryDevice !== 'string' || typeof value.owner.directoryInode !== 'string' ||
      !/^[0-9]+$/.test(value.owner.directoryDevice) || !/^[1-9][0-9]*$/.test(value.owner.directoryInode) ||
      value.directory !== join(dirname(path), 'redis') || value.localAddress !== `${value.host}:${value.port}`) refusal('local foreground allocation is invalid or stale.')
    const parent = await lstat(dirname(path), { bigint: true })
    if (!parent.isDirectory() || parent.isSymbolicLink() || Number(parent.uid) !== process.getuid?.() || Number(parent.mode) & 0o077 ||
        await realpath(dirname(path)) !== dirname(path)) refusal('local allocation directory is not private.')
  } else if (value.owner?.kind === 'github-actions-service') {
    // Current-job/run-attempt binding owns CI lifetime; a fixed local TTL must
    // not expire a valid retained service halfway through a long CI job.
    if (!exact(value.owner, ['kind', 'serviceId', 'githubRunId', 'githubRunAttempt']) ||
      process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' ||
      typeof value.owner.serviceId !== 'string' || typeof value.owner.githubRunId !== 'string' || typeof value.owner.githubRunAttempt !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.owner.serviceId) || !/^[1-9][0-9]*$/.test(value.owner.githubRunId) || !/^[1-9][0-9]*$/.test(value.owner.githubRunAttempt) ||
      value.owner.serviceId !== process.env.BATSHIT_REDIS_CI_SERVICE_ID ||
      value.owner.githubRunId !== process.env.GITHUB_RUN_ID || value.owner.githubRunAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
      !process.env.RUNNER_TEMP || await realpath(dirname(path)) !== await realpath(process.env.RUNNER_TEMP)) refusal('allocation does not belong to this Actions service/run attempt.')
  } else refusal('no supported dedicated-instance owner.')
  for (const name of ['BATSHIT_REDIS_TEST_URL', 'VITEST_REDIS_URL', 'REDIS_URL']) {
    const raw = process.env[name]
    if (!raw) refusal('all three explicit Redis URLs are required.')
    const url = new URL(raw)
    if (url.protocol !== 'redis:' || url.username || url.password || url.search || url.hash ||
        url.hostname !== value.host || url.port !== String(value.port) || url.pathname !== '/15') refusal('effective Redis URLs disagree with the owned endpoint/DB15.')
  }
  return Object.freeze({ ...value, owner: Object.freeze(value.owner), allocationPath: path }) as PrimitiveAllocation
}

function infoField(info: string, name: string): string {
  const matches = info.split(/\r?\n/).filter(line => line.startsWith(`${name}:`))
  if (matches.length !== 1) refusal('malformed server identity reply.')
  return matches[0].slice(name.length + 1)
}
async function assertPrimitiveInstance(client: RedisClientType, allocation: PrimitiveAllocation, initial = false) {
  if (!client.isOpen || !client.isReady) refusal('client is not ready.')
  const connection = await client.clientInfo()
  const server = await client.info('server')
  const directory = await client.sendCommand(['CONFIG', 'GET', 'dir'])
  const capabilities = await client.sendCommand(['COMMAND', 'INFO', 'JSON.GET', 'FT.SEARCH'])
  if (connection.db !== 15 || connection.laddr !== allocation.localAddress ||
      infoField(server, 'redis_version') !== allocation.version || infoField(server, 'run_id') !== allocation.runId ||
      !Array.isArray(directory) || directory.length !== 2 || directory[0] !== 'dir' || directory[1] !== allocation.directory ||
      !Array.isArray(capabilities) || capabilities.length !== 2 || capabilities.some((value, index) =>
        !Array.isArray(value) || typeof value[0] !== 'string' || value[0].toLowerCase() !== ['json.get', 'ft.search'][index])) refusal('actual connection/server/directory/capability differs from allocation.')
  if (allocation.owner.kind === 'local-supervised') {
    const owner = allocation.owner
    const stat = await lstat(allocation.directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.uid) !== process.getuid?.() || Number(stat.mode) & 0o077 ||
      stat.dev.toString() !== owner.directoryDevice || stat.ino.toString() !== owner.directoryInode ||
      await realpath(allocation.directory) !== allocation.directory || Number(infoField(server, 'process_id')) !== owner.pid ||
      execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim() !== owner.startIdentity ||
      execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'tty='], { encoding: 'utf8', timeout: 1000 }).trim() !== owner.tty) refusal('held foreground process or persistence directory changed.')
    if (initial && [...(await client.info('keyspace')).matchAll(/^db\d+:keys=(\d+)/gm)].some(match => Number(match[1]) > 0)) refusal('local instance is not empty in every database.')
  }
  if (!client.isOpen || !client.isReady) refusal('connection ended during admission.')
}

async function closePrimitiveClient(client: RedisClientType | undefined) {
  // All work has settled. Close directly: node-redis marks QUIT closed before
  // awaiting its reply, so a failed QUIT can hide a still-ready socket.
  if (client?.isOpen) await client.disconnect()
  if (client?.isOpen || client?.isReady) refusal('client close could not be confirmed.')
}

describe.skipIf(!REAL_REDIS_LANE)('Redis primitive conformance (SA-101)', () => {
  let client: RedisClientType
  let allocation: PrimitiveAllocation
  let admitted = false
  let closed = false
  let connection: Promise<unknown> | undefined
  let closure: Promise<void> | undefined

  function closeClient() {
    return closure ??= (async () => {
      // connect() marks isOpen before awaiting socket creation. Wait for that
      // existing attempt before disconnecting, including an early afterAll.
      try { await connection } catch { /* beforeAll retains the connect failure. */ }
      await closePrimitiveClient(client)
    })()
  }

  beforeAll(async () => {
    if (closed) refusal('suite already ended.')
    allocation = await readPrimitiveAllocation()
    if (closed) refusal('suite ended while reading allocation.')
    const candidate = client = createClient({ url: process.env.BATSHIT_REDIS_TEST_URL, database: 15,
      disableOfflineQueue: true, socket: { reconnectStrategy: false } }) as RedisClientType
    candidate.on('error', () => {}) // The awaited command/connect keeps the real failure.
    try {
      connection = candidate.connect()
      await connection
      if (closed) refusal('suite ended while connecting.')
      await assertPrimitiveInstance(candidate, allocation, true)
      if (closed) refusal('suite ended during admission.')
      await clearRedisTestDatabase(candidate)
      admitted = true
    } catch (error) {
      try { await closeClient() }
      catch (closeError) { throw new AggregateError([error, closeError], 'Primitive Redis admission and close failed.') }
      throw error
    }
  }, 30000)

  afterAll(async () => {
    closed = true
    try {
      if (admitted && client?.isOpen) {
        await assertPrimitiveInstance(client, allocation)
        await clearRedisTestDatabase(client)
      }
    } finally { admitted = false; await closeClient() }
  })

  async function adminClient() {
    if (!admitted || closed) refusal('admin work has no live admission.')
    await assertPrimitiveInstance(client, allocation)
    if (!admitted || closed) refusal('suite ended during admin assertion.')
    return client
  }

  it('handles keys, strings, expiry and cursor scanning', async () => {
    expect(await client.set(`${K}:s`, 'hello')).toBe('OK'); mark('SET')
    expect(await client.get(`${K}:s`)).toBe('hello'); mark('GET')
    expect(await client.exists(`${K}:s`)).toBe(1); mark('EXISTS')
    expect(await client.type(`${K}:s`)).toBe('string'); mark('TYPE')

    await client.set(`${K}:n`, '5')
    expect(await client.incr(`${K}:n`)).toBe(6); mark('INCR')

    expect(await client.expire(`${K}:s`, 100)).toBeTruthy(); mark('EXPIRE')
    expect(await client.ttl(`${K}:s`)).toBeGreaterThan(90); mark('TTL')
    const pttl = await client.pTTL(`${K}:s`)
    expect(pttl).toBeGreaterThan(90_000)
    expect(pttl).toBeLessThanOrEqual(100_000); mark('PTTL')

    // A key with no expiry must report -1, and a missing key -2. Backup/restore and the
    // session cleanup paths both branch on those exact sentinels.
    expect(await client.ttl(`${K}:n`)).toBe(-1)
    expect(await client.ttl(`${K}:absent`)).toBe(-2)

    await client.set(`${K}:ex`, 'v', { EX: 60 })
    expect(await client.ttl(`${K}:ex`)).toBeGreaterThan(50); mark('SET EX')

    expect((await client.keys(`${K}:*`)).length).toBeGreaterThanOrEqual(3); mark('KEYS')

    const scanned: string[] = []
    for await (const key of client.scanIterator({ MATCH: `${K}:*`, COUNT: 10 })) {
      scanned.push(...(Array.isArray(key) ? key : [key]))
    }
    expect(scanned.length).toBeGreaterThanOrEqual(3); mark('SCAN')

    expect(await client.del(`${K}:n`)).toBe(1); mark('DEL')
  })

  it('handles sets and lists', async () => {
    await client.sAdd(`${K}:set`, ['a', 'b', 'c']); mark('SADD')
    expect(await client.sCard(`${K}:set`)).toBe(3); mark('SCARD')
    expect((await client.sMembers(`${K}:set`)).sort()).toEqual(['a', 'b', 'c']); mark('SMEMBERS')
    expect(await client.sIsMember(`${K}:set`, 'b')).toBeTruthy(); mark('SISMEMBER')
    expect(await client.sRem(`${K}:set`, 'b')).toBe(1); mark('SREM')

    await client.rPush(`${K}:list`, ['x', 'y', 'z']); mark('RPUSH')
    await client.lPush(`${K}:list`, 'w'); mark('LPUSH')
    expect(await client.lRange(`${K}:list`, 0, -1)).toEqual(['w', 'x', 'y', 'z']); mark('LRANGE')
    expect(await client.lRem(`${K}:list`, 1, 'y')).toBe(1); mark('LREM')
    expect(await client.lTrim(`${K}:list`, 0, 1)).toBe('OK'); mark('LTRIM')
    expect(await client.lRange(`${K}:list`, 0, -1)).toEqual(['w', 'x'])
  })

  it('round-trips the typed hash and sorted-set records backup/restore writes', async () => {
    await client.hSet(`${K}:h`, { f1: 'v1', f2: 'v2' }); mark('HSET')
    expect(await client.hGetAll(`${K}:h`)).toEqual({ f1: 'v1', f2: 'v2' }); mark('HGETALL')

    await client.zAdd(`${K}:z`, [
      { score: 1, value: 'one' },
      { score: 2, value: 'two' }
    ]); mark('ZADD')
    expect(await client.zRangeWithScores(`${K}:z`, 0, -1)).toEqual([
      { score: 1, value: 'one' },
      { score: 2, value: 'two' }
    ]); mark('ZRANGE WITHSCORES')
  })

  it('handles RedisJSON reads, writes and the type reply the dual-access layer sniffs', async () => {
    expect(await client.json.set(`${K}:j`, '$', { a: 1, arr: [1, 2], s: 'hi' })).toBe('OK')
    mark('JSON.SET')
    expect(await client.json.get(`${K}:j`, { path: '$' })).toEqual([{ a: 1, arr: [1, 2], s: 'hi' }])
    mark('JSON.GET')

    // databaseRedis / redisService branch on this exact reply to choose the JSON read path.
    // If it ever changes, JSON keys silently fall through to GET and reads return null.
    expect(await client.type(`${K}:j`)).toBe('ReJSON-RL')

    expect(await client.json.strLen(`${K}:j`, { path: '$.s' })).toEqual([2]); mark('JSON.STRLEN')
    expect(await client.json.del(`${K}:j`, { path: '$.s' })).toBe(1); mark('JSON.DEL')
  })

  it('handles the Execution Viewer raw sendCommand array operations', async () => {
    await client.json.set(`${K}:ev`, '$', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])

    // executionViewerService.ts issues these as raw commands, so wrapper-only coverage
    // would miss them entirely.
    const ids = await client.sendCommand(['JSON.GET', `${K}:ev`, '$[*].id'])
    expect(JSON.parse(String(ids))).toEqual(['a', 'b', 'c'])

    const one = await client.sendCommand(['JSON.GET', `${K}:ev`, '$[1]'])
    expect(JSON.parse(String(one))).toEqual([{ id: 'b' }])

    expect(
      await client.sendCommand(['JSON.SET', `${K}:ev`, '$[1]', JSON.stringify({ id: 'B' })])
    ).toBe('OK')

    expect(
      await client.sendCommand(['JSON.ARRAPPEND', `${K}:ev`, '$', JSON.stringify({ id: 'd' })])
    ).toEqual([4]); mark('JSON.ARRAPPEND')

    // Negative indices matter: the Execution Viewer trims to the newest N entries.
    expect(await client.sendCommand(['JSON.ARRTRIM', `${K}:ev`, '$', '-2', '-1'])).toEqual([2])
    mark('JSON.ARRTRIM')

    const trimmed = await client.sendCommand(['JSON.GET', `${K}:ev`, '$'])
    expect(JSON.parse(String(trimmed))).toEqual([[{ id: 'c' }, { id: 'd' }]])
  })

  it('reports a missing JSON path in a form the artifacts classifier recognises', async () => {
    await client.json.set(`${K}:paths`, '$', { a: 1 })

    // JSONPath syntax returns an empty array rather than erroring, on every Redis version.
    expect(await client.json.get(`${K}:paths`, { path: '$.nope' })).toEqual([])

    // Legacy dot-notation paths — which artifactsService's list projection uses — do error,
    // and the message text differs between Redis Stack 7.4 and Redis 8. Whatever this Redis
    // says, it must match the classifier, or artifacts silently vanish from the user's list.
    const { isRedisJsonMissingPathError } = await import(
      '$lib/server/artifacts/artifactsService'
    )
    await expect(async () => {
      await client.json.get(`${K}:paths`, { path: '.nope' })
    }).rejects.toSatisfy((error: unknown) => {
      expect(isRedisJsonMissingPathError(error)).toBe(true)
      return true
    })
  })

  it('runs the Lua constructs the seven script-owning repositories rely on', async () => {
    expect(
      await client.eval("return redis.call('SET', KEYS[1], ARGV[1])", {
        keys: [`${K}:lua`],
        arguments: ['luaval']
      })
    ).toBe('OK'); mark('EVAL'); mark('EVAL redis.call')
    expect(await client.get(`${K}:lua`)).toBe('luaval')

    // Module commands called from inside Lua — the pattern every Goon/Hair repository uses.
    expect(
      await client.eval("return redis.call('JSON.SET', KEYS[1], '$', ARGV[1])", {
        keys: [`${K}:luaj`],
        arguments: [JSON.stringify({ k: 1 })]
      })
    ).toBe('OK')
    expect(
      await client.eval("return redis.call('JSON.GET', KEYS[1], '$')", { keys: [`${K}:luaj`] })
    ).toBe('[{"k":1}]')

    // pcall must surface a table with an `err` field, which four repositories introspect.
    const pcallResult = await client.eval(
      "local ok, e = pcall(function() return redis.call('JSON.GET', KEYS[1], '.nope') end)\n" +
        "if ok then return 'noerr' end\n" +
        "if type(e) == 'table' and e['err'] then return 'err-table' end\n" +
        "return 'other'",
      { keys: [`${K}:luaj`] }
    )
    expect(['err-table', 'other']).toContain(pcallResult); mark('EVAL redis.pcall')

    await expect(client.eval("return redis.error_reply('custom failure')")).rejects.toThrow(
      /custom failure/
    ); mark('EVAL redis.error_reply')

    expect(
      await client.eval('return cjson.encode(cjson.decode(ARGV[1]))', {
        arguments: [JSON.stringify({ z: 9 })]
      })
    ).toBe('{"z":9}'); mark('EVAL cjson')
  })

  it('raises WRONGTYPE with the stable RESP prefix', async () => {
    await client.set(`${K}:str`, 'v')
    await expect(client.lPush(`${K}:str`, 'bad')).rejects.toThrow(/^WRONGTYPE/)
  })

  it('supports pub/sub and the admin reads the supervisor and upload service depend on', async () => {
    await adminClient()
    expect(await client.publish(`${K}:chan`, 'hello')).toBe(0); mark('PUBLISH')
    expect(await client.ping()).toBe('PONG'); mark('PING')

    // fileBackedUploadService reads run_id from INFO server to detect a Redis restart.
    const server = await client.info('server')
    expect(server).toMatch(/^run_id:/m); mark('INFO server')
    expect(server).toMatch(/^redis_version:/m)

    // Both the upload service's AOF-rewrite marker and the Mac supervisor's shutdown-mode
    // decision read these exact field names. A rename would silently disable either.
    const persistence = await client.info('persistence')
    for (const field of [
      'loading',
      'aof_enabled',
      'aof_rewrites',
      'aof_rewrite_in_progress',
      'aof_last_write_status',
      'aof_last_bgrewrite_status',
      'rdb_last_bgsave_status',
      'rdb_bgsave_in_progress'
    ]) {
      expect(persistence, `INFO persistence must still report ${field}`).toMatch(
        new RegExp(`^${field}:`, 'm')
      )
    }
    mark('INFO persistence')

    // visualIndicatorService turns on keyspace notifications at runtime.
    expect(await (await adminClient()).configSet('notify-keyspace-events', 'KEA')).toBe('OK'); mark('CONFIG SET')

    expect(await (await adminClient()).bgRewriteAof()).toMatch(/rewriting started|scheduled/i)
    mark('BGREWRITEAOF')
  })

  it('exercised every command in the declared inventory', () => {
    const missing = EXPECTED_COMMAND_SURFACE.filter((command) => !exercised.has(command))
    expect(
      missing,
      `These declared commands were never exercised. Either the covering test was removed ` +
        `or it failed before reaching them: ${missing.join(', ')}`
    ).toEqual([])
  })
})
