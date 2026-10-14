import { beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, type RedisClientType } from 'redis'

/**
 * Lightweight real-Redis test harness.
 *
 * Lane-aware (G-0228): under the default test lane (`npm test`), the code under test
 * reads the in-memory RedisJSON fake from vitest-setup.ts, so this harness does NOT
 * touch real Redis at all — it only resets the fake between tests. That keeps plain
 * `npm test` runnable on machines with no Redis (CI runners, fresh clones).
 *
 * Under the real lane (`npm run test:redis`, which sets VITEST_USE_REAL_REDIS=true),
 * we attach to an already running Redis 8 instance and isolate tests by using a
 * dedicated database (defaults to DB 15, spread across DB 15..1 per worker).
 *
 * The instance must provide the JSON module — Batshit stores every record as RedisJSON.
 * Redis 8 bundles it; the retired Redis Stack product is no longer used.
 *
 * Known constraint: RediSearch's FT.CREATE only works on database 0, and this harness
 * never uses DB 0 (it refuses, to protect real data). Search-index tests therefore
 * cannot run under this harness and need a dedicated instance or db-0 prefix isolation.
 *
 * Never FLUSHDB or FLUSHALL here (BL-135): either one drops every search index on the
 * whole SERVER, so a flush of DB 15 deleted the Native lane's memory indexes on DB 0.
 * Each test starts from `clearRedisTestDatabase`, which deletes this database's keys only.
 *
 * Configure the real lane with either:
 *   - BATSHIT_REDIS_TEST_URL
 *   - VITEST_REDIS_URL
 *   - REDIS_URL (will be overridden during the test run)
 */
/**
 * BL-135: empty ONE test database, and nothing else on the server.
 *
 * FLUSHDB is not database-local for Redis Search: flushing any database drops every search
 * index on the server (measured on Redis 8.10.1), including DB 0's `batshit_memory_idx` and
 * `batshit_memseg_idx` on a developer's native Redis. SCAN + UNLINK deletes this database's
 * keys and leaves every index alone. Refuses database 0, read from the connection itself, so
 * a client created without its `database` option cannot empty real data. Answers the number
 * of keys it deleted.
 */
export async function clearRedisTestDatabase(client: RedisClientType): Promise<number> {
  const { db } = await client.clientInfo()
  if (db === 0) {
    throw new Error('clearRedisTestDatabase refuses database 0: it holds real Batshit data.')
  }
  let cursor = '0'
  let removed = 0
  do {
    const batch = await client.scan(cursor, { COUNT: 1000 })
    cursor = String(batch.cursor)
    if (batch.keys.length > 0) removed += await client.unlink(batch.keys)
  } while (cursor !== '0')
  return removed
}

export interface RedisTestServerOptions {
  /** Read-only, awaited admission of this existing client before any database cleanup. */
  beforeCleanupAdmission?: (connection: { adminClient: RedisClientType; resolvedUrl: string }) => Promise<void>
}

export function useRedisTestServer(options: RedisTestServerOptions = {}) {
  const useRealRedis = process.env.VITEST_USE_REAL_REDIS === 'true'
  let adminClient: RedisClientType
  let redisUrl: string
  let previousRedisUrl: string | undefined
  let environmentCaptured = false
  let admitted = false
  let closed = false
  const admission = {
    isAdmitted: () => admitted && !closed,
    requireAdmission() {
      if (!admission.isAdmitted()) throw new Error('Redis test connection has not completed admission.')
    }
  }

  async function restoreEnvironment() {
    if (!environmentCaptured) return
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = previousRedisUrl
    try {
      const envModule = await import('$env/dynamic/private')
      if (envModule?.env) {
        const mutableEnv = envModule.env as Record<string, string | undefined>
        if (previousRedisUrl === undefined) delete mutableEnv.REDIS_URL
        else mutableEnv.REDIS_URL = previousRedisUrl
      }
    } catch {
      // Preserve the existing optional env-module behavior.
    }
    // Keep the snapshot: late lazy app acquisition can resynchronize env after teardown.
  }

  beforeAll(async () => {
    if (!useRealRedis) return
    if (closed) throw new Error('Redis test admission started after teardown.')

    // SA-101 renamed REDIS_STACK_TEST_URL. Fail loudly rather than silently ignoring a
    // stale export and pointing the suite at the wrong instance.
    if (process.env.REDIS_STACK_TEST_URL) {
      throw new Error(
        'REDIS_STACK_TEST_URL is no longer read. Rename it to BATSHIT_REDIS_TEST_URL.'
      )
    }

    redisUrl =
      process.env.BATSHIT_REDIS_TEST_URL ||
      process.env.VITEST_REDIS_URL ||
      process.env.REDIS_URL ||
      'redis://127.0.0.1:6379/15'

    const urlObj = new URL(redisUrl)
    let dbSegment = urlObj.pathname.replace('/', '')

    // If no DB is provided, default to 15 for tests.
    if (!dbSegment) {
      dbSegment = '15'
      urlObj.pathname = `/${dbSegment}`
      redisUrl = urlObj.toString()
    }

    // Avoid cross-test interference when Vitest runs files in parallel by spreading workers across DBs.
    // Only apply this when we're using the default DB 15 so explicit overrides remain respected.
    if (dbSegment === '15') {
      const workerRaw =
        process.env.VITEST_POOL_ID ||
        process.env.VITEST_WORKER_ID ||
        process.env.VITEST_THREAD_ID ||
        process.env.VITEST_SHARD_ID ||
        '0'

      const workerId = Number.parseInt(workerRaw, 10)
      const offset = Number.isFinite(workerId) ? workerId % 15 : 0
      const derivedDb = 15 - offset

      if (derivedDb !== 15) {
        dbSegment = String(derivedDb)
        urlObj.pathname = `/${dbSegment}`
        redisUrl = urlObj.toString()
      }
    }

    // Safety: never allow the harness to point at DB0 (protect user data)
    if (dbSegment === '0') {
      throw new Error(`redis-memory harness refuses to run on DB0. Set VITEST_REDIS_URL to a test DB (e.g. /15). Current url: ${redisUrl}`)
    }

    const database = Number(dbSegment)

    previousRedisUrl = process.env.REDIS_URL
    process.env.REDIS_URL = redisUrl
    environmentCaptured = true

    try {
      const envModule = await import('$env/dynamic/private')
      if (envModule?.env && !closed) {
        envModule.env.REDIS_URL = redisUrl
      }
    } catch {
      // ignore if env module not available yet
    }

    try {
      if (closed) throw new Error('Redis test admission continued after teardown.')
      adminClient = createClient({ url: redisUrl, database })
      try {
        await adminClient.connect()
        await adminClient.ping()
      } catch (error) {
        throw new Error(
          `Failed to connect to Redis at ${redisUrl}. ` +
            'Start a local Redis 8 that provides the JSON module, or set BATSHIT_REDIS_TEST_URL ' +
            'to an accessible instance. Docker users can run: docker run -p 6379:6379 redis:8-alpine',
          { cause: error }
        )
      }
      if (closed) throw new Error('Redis test admission continued after teardown.')
      if (options.beforeCleanupAdmission) {
        await options.beforeCleanupAdmission({ adminClient, resolvedUrl: redisUrl })
      }
      if (closed) throw new Error('Redis test admission finished after teardown.')
      admitted = true
    } catch (error) {
      admitted = false
      try {
        // Disconnect settles this owned connection without acquiring another one or deleting keys.
        if (adminClient?.isOpen) await adminClient.disconnect()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Redis test admission and connection cleanup failed.')
      } finally {
        await restoreEnvironment()
      }
      throw error
    }
  }, 30000)

  beforeEach(async () => {
    if (useRealRedis && options.beforeCleanupAdmission) admission.requireAdmission()
    if (useRealRedis && adminClient?.isOpen) {
      await clearRedisTestDatabase(adminClient)
    }

    try {
      const redisModule = await import('$lib/server/redis')
      await (redisModule.redis as any).__resetTestStore?.()
    } catch {
      // Some suites use the real Redis module or their own mocks.
    }
  })

  afterAll(async () => {
    const wasAdmitted = admitted
    closed = true
    admitted = false
    if (!useRealRedis) return
    try {
      if (adminClient?.isOpen) {
        if (wasAdmitted) await adminClient.quit()
        else await adminClient.disconnect()
      }
    } finally {
      await restoreEnvironment()
    }
  })
  return admission
}
