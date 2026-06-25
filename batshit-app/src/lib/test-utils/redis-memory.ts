import { beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, type RedisClientType } from 'redis'

/**
 * Lightweight Redis Stack test harness.
 *
 * Lane-aware (G-0228): under the default test lane (`npm test`), the code under test
 * reads the in-memory RedisJSON fake from vitest-setup.ts, so this harness does NOT
 * touch real Redis at all — it only resets the fake between tests. That keeps plain
 * `npm test` runnable on machines with no Redis (CI runners, fresh clones).
 *
 * Under the real lane (`npm run test:redis`, which sets VITEST_USE_REAL_REDIS=true),
 * we attach to an already running Redis Stack instance and isolate tests by using a
 * dedicated database (defaults to DB 15, spread across DB 15..1 per worker).
 *
 * Configure the real lane with either:
 *   - REDIS_STACK_TEST_URL
 *   - VITEST_REDIS_URL
 *   - REDIS_URL (will be overridden during the test run)
 */
export function useRedisTestServer() {
  const useRealRedis = process.env.VITEST_USE_REAL_REDIS === 'true'
  let adminClient: RedisClientType
  let redisUrl: string
  let previousRedisUrl: string | undefined

  beforeAll(async () => {
    if (!useRealRedis) return

    redisUrl =
      process.env.REDIS_STACK_TEST_URL ||
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

    try {
      const envModule = await import('$env/dynamic/private')
      if (envModule?.env) {
        envModule.env.REDIS_URL = redisUrl
      }
    } catch {
      // ignore if env module not available yet
    }

    adminClient = createClient({ url: redisUrl, database })

    try {
      await adminClient.connect()
      await adminClient.ping()
    } catch (error) {
      throw new Error(
        `Failed to connect to Redis Stack at ${redisUrl}. ` +
          'Make sure Redis Stack is running locally ' +
          'or set REDIS_STACK_TEST_URL to an accessible instance.'
      )
    }
  }, 30000)

  beforeEach(async () => {
    if (useRealRedis && adminClient?.isOpen) {
      await adminClient.flushDb()
    }

    try {
      const redisModule = await import('$lib/server/redis')
      await (redisModule.redis as any).__resetTestStore?.()
    } catch {
      // Some suites use the real Redis module or their own mocks.
    }
  })

  afterAll(async () => {
    if (!useRealRedis) return

    if (adminClient?.isOpen) {
      await adminClient.quit()
    }

    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL
    } else {
      process.env.REDIS_URL = previousRedisUrl
    }

    try {
      const envModule = await import('$env/dynamic/private')
      if (envModule?.env) {
        const mutableEnv = envModule.env as Record<string, string | undefined>

        if (previousRedisUrl === undefined) {
          delete mutableEnv.REDIS_URL
        } else {
          mutableEnv.REDIS_URL = previousRedisUrl
        }
      }
    } catch {
      // ignore
    }
  })
}
