import { afterAll, beforeAll, beforeEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type RedisClientType } from 'redis'
import { BATSHIT_RUNTIME_REDIS_PORTS } from '$lib/server/redisRuntimePorts'

/**
 * SA-104 memory-search test harness (testing-architecture.md §3, DL-104-14).
 *
 * Memory/search-index suites need FT.CREATE, which only works on db 0, and the normal
 * real-Redis harness hard-refuses db 0 to protect live data. This harness therefore
 * provides a DEDICATED DISPOSABLE Redis instance whose db 0 belongs to the suite run:
 *
 *  - CI: honors a pre-set MEMORY_TEST_REDIS_URL (a dedicated service container).
 *  - Local: spawns the pinned Batshit Redis 8 runtime (same resolution order the
 *    launchers use: prepared managed runtime assets first, host install with a
 *    detected module dir second) on a random port with a temp dir, and tears it
 *    down completely afterwards.
 *
 * Guards, layered:
 *  - Runs only under the memory lane (VITEST_MEMORY_SEARCH=true + VITEST_USE_REAL_REDIS=true).
 *  - Refuses Batshit's runtime Redis ports (`BATSHIT_RUNTIME_REDIS_PORTS`: 6379, 5639, 5659,
 *    6380, 5649; the same list `redis.ts` keeps its memory-search escape off).
 *  - Refuses a URL that names a database other than 0 (BL-1824): FT.CREATE needs db 0, and the
 *    harness flushes the WHOLE instance, so a URL naming db 15 points at an instance that may
 *    hold other data (`memorySearchTestUrlRefusal`).
 *  - Refuses, before any flush, an instance it has not claimed that holds ANY key in any database
 *    (BL-1824; `memorySearchTestInstanceRefusal`); before, only `user:*` keys in db 0 refused it,
 *    so a test Redis with data only in db 14 or 15 was flushed whole. The claim expires an hour
 *    after the last flush (`HARNESS_CLAIM_TTL_SECONDS`), so a long-lived configured instance
 *    that something else has written to since must be empty again before it is flushed.
 *  - On the spawned path, refuses a server that is not the one it spawned (a port collision).
 *  - Uses a run-unique BATSHIT_MEMORY_INDEX_SUFFIX for index names.
 *  - The RedisService db-0 rewrite stays active for every URL except the one this
 *    harness designates via MEMORY_TEST_REDIS_URL (see isDesignatedMemorySearchTestUrl).
 */


/**
 * BL-1824: why `url` may not be used, or null. The harness runs FLUSHALL, which empties every
 * database of the instance, so it may only point at db 0 of an instance it owns: a URL naming
 * another database (db 15, say) names an instance other data may live on.
 */
export function memorySearchTestUrlRefusal(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `Memory-search harness refuses MEMORY_TEST_REDIS_URL ${JSON.stringify(url)}: it is not a Redis URL.`
  }
  const port = Number(parsed.port || '6379')
  if (BATSHIT_RUNTIME_REDIS_PORTS.has(port)) {
    return (
      `Memory-search harness refuses port ${port}: it belongs to a real Batshit Redis lane. ` +
      'Point MEMORY_TEST_REDIS_URL at a dedicated disposable instance.'
    )
  }
  const db = parsed.pathname.replace(/^\//, '')
  if (db !== '' && db !== '0') {
    return (
      `Memory-search harness refuses ${parsed.host}/${db}: it flushes the WHOLE instance (every database), ` +
      'and search indexes need db 0, so the URL must name db 0 of a dedicated disposable Redis, never another database of a shared one.'
    )
  }
  return null
}

/**
 * BL-1824: why the instance may not be flushed, or null. `claimed` is whether this harness's
 * claim key is already there (its own leftovers from an earlier suite file); `keyspace` is the
 * `INFO keyspace` text (`db0:keys=3,...`). An instance it has not claimed must be EMPTY in every
 * database: anything else may be someone's data, and FLUSHALL would take all of it.
 */
export function memorySearchTestInstanceRefusal(input: { claimed: boolean; keyspace: string }): string | null {
  if (input.claimed) return null
  const filled = [...input.keyspace.matchAll(/^(db\d+):keys=(\d+)/gm)]
    .filter((match) => Number(match[2]) > 0)
    .map((match) => `${match[1]} holds ${match[2]} ${match[2] === '1' ? 'key' : 'keys'}`)
  if (filled.length === 0) return null
  return (
    `Memory-search harness refuses this instance: it has not claimed it, and ${filled.join(', ')}. ` +
    'It flushes the WHOLE instance, so it only uses an empty instance of its own. Point MEMORY_TEST_REDIS_URL at a dedicated disposable Redis.'
  )
}

export function memorySearchLaneActive(): boolean {
  return (
    process.env.VITEST_MEMORY_SEARCH === 'true' && process.env.VITEST_USE_REAL_REDIS === 'true'
  )
}

interface ResolvedRedisRuntime {
  serverBin: string
  moduleDir: string
}

function moduleDirFor(base: string): string | null {
  for (const candidate of [path.join(base, 'lib'), path.join(base, 'lib', 'redis', 'modules')]) {
    if (existsSync(path.join(candidate, 'rejson.so')) && existsSync(path.join(candidate, 'redisearch.so'))) {
      return candidate
    }
  }
  return null
}

function resolveRedisRuntime(): ResolvedRedisRuntime {
  // Vitest runs from batshit-app; the prepared runtime lives at the repo root.
  const prepared =
    process.env.BATSHIT_MAC_REDIS_DIST_DIR ||
    path.resolve(process.cwd(), '..', '_local', 'mac-managed-runtimes', 'assets', 'redis')
  const preparedBin = path.join(prepared, 'bin', 'redis-server')
  if (existsSync(preparedBin)) {
    const moduleDir = moduleDirFor(prepared)
    if (moduleDir) return { serverBin: preparedBin, moduleDir }
  }

  const which = spawnSync('which', ['redis-server'], { encoding: 'utf8' })
  const hostBin = which.status === 0 ? which.stdout.trim() : ''
  if (hostBin) {
    const base = path.resolve(path.dirname(hostBin), '..')
    const moduleDir = moduleDirFor(base)
    if (moduleDir) return { serverBin: hostBin, moduleDir }
  }

  throw new Error(
    'No usable Redis 8 runtime for the memory-search test lane. Prepare the app-owned runtime ' +
      '(cd batshit-mac && node scripts/prepare-managed-runtime-assets.mjs --only redis) or install ' +
      'the Redis 8 cask (brew tap redis/redis && brew install --cask redis).'
  )
}

function randomPort(): number {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 40000)
    if (!BATSHIT_RUNTIME_REDIS_PORTS.has(port)) return port
  }
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    const probe: RedisClientType = createClient({ url, database: 0 })
    try {
      probe.on('error', () => undefined)
      await probe.connect()
      await probe.ping()
      await probe.quit()
      return
    } catch (error) {
      lastError = error
      try {
        await probe.disconnect()
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Memory-search test Redis did not become ready: ${String(lastError)}`)
}

export interface MemorySearchTestContext {
  url(): string
  adminClient(): RedisClientType
}

/** Stamped into the disposable instance so later suite files know it is harness-owned. */
const HARNESS_CLAIM_KEY = 'batshit:memory_test_harness_claim'
/**
 * BL-1824: the claim lasts an hour after the last flush. Every test re-stamps it (beforeEach),
 * so the suite files of one run stay claimed; an instance left alone longer must be empty again.
 */
const HARNESS_CLAIM_TTL_SECONDS = 3600

export function useMemorySearchTestServer(): MemorySearchTestContext {
  let child: ChildProcess | null = null
  let dataDir: string | null = null
  let admin: RedisClientType | null = null
  let redisUrl = ''
  const previousEnv = new Map<string, string | undefined>()

  const setEnv = (key: string, value: string) => {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key])
    process.env[key] = value
  }

  /** Full clean slate (FLUSHALL drops keys AND FT indexes), then re-stamp the claim. */
  const claimAndFlush = async () => {
    if (!admin) return
    await admin.flushAll()
    await admin.set(HARNESS_CLAIM_KEY, new Date().toISOString(), { EX: HARNESS_CLAIM_TTL_SECONDS })
  }

  beforeAll(async () => {
    if (!memorySearchLaneActive()) return

    const configuredUrl = process.env.MEMORY_TEST_REDIS_URL?.trim()
    if (configuredUrl) {
      redisUrl = configuredUrl
    } else {
      const runtime = resolveRedisRuntime()
      const port = randomPort()
      dataDir = await mkdtemp(path.join(tmpdir(), 'batshit-memory-test-redis-'))
      child = spawn(
        runtime.serverBin,
        [
          '--port', String(port),
          '--bind', '127.0.0.1', '-::1',
          '--save', '',
          '--appendonly', 'no',
          '--dir', dataDir,
          '--loadmodule', path.join(runtime.moduleDir, 'rejson.so'),
          '--loadmodule', path.join(runtime.moduleDir, 'redisearch.so'),
          '--search-max-search-results', '10000',
          '--search-max-aggregate-results', '10000'
        ],
        { stdio: 'ignore' }
      )
      redisUrl = `redis://127.0.0.1:${port}/0`
      await waitForReady(redisUrl, 15000)
    }

    const urlRefusal = memorySearchTestUrlRefusal(redisUrl)
    if (urlRefusal) throw new Error(urlRefusal)

    // `admin` is set only after every check passes, so no hook can flush a refused instance.
    const candidate: RedisClientType = createClient({ url: redisUrl, database: 0 })
    candidate.on('error', (error) => console.error('[memory-search harness] Redis error:', error))
    await candidate.connect()

    // FLUSHALL below empties EVERY database of the instance, so an instance this harness has
    // not claimed must be empty in all of them (BL-1824; before, only user:* keys in db 0
    // refused it). The claim marker distinguishes THIS harness's own leftovers from real data:
    // in CI every suite file shares one service container, and earlier files legitimately
    // write fixtures (user:* in db 0, and db 15 in realRedisLaneCleanup) — without the marker,
    // file two's guard mistook those leftovers for live data and refused (found on the job's
    // first flight, 2026-08-29).
    try {
      let refusal: string | null = null
      if (child) {
        const processId = /^process_id:(\d+)/m.exec(await candidate.info('server'))?.[1]
        if (Number(processId) !== child.pid) {
          refusal =
            `Memory-search harness refuses ${redisUrl}: another Redis (process ${processId ?? 'unknown'}) ` +
            `already listens on the port it spawned process ${child.pid} for.`
        }
      }
      refusal ??= memorySearchTestInstanceRefusal({
        claimed: (await candidate.exists(HARNESS_CLAIM_KEY)) > 0,
        keyspace: await candidate.info('keyspace')
      })
      if (refusal) throw new Error(refusal)
      admin = candidate
    } finally {
      // A refusal, or a check that failed, closes the client nothing else holds.
      if (admin !== candidate) await candidate.disconnect().catch(() => undefined)
    }
    await claimAndFlush()

    setEnv('MEMORY_TEST_REDIS_URL', redisUrl)
    setEnv('REDIS_URL', redisUrl)
    setEnv('BATSHIT_MEMORY_INDEX_SUFFIX', `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`)
    try {
      const envModule = await import('$env/dynamic/private')
      if (envModule?.env) {
        // Only Vitest's mutable env-mock alias is updated; the real Kit namespace is readonly.
        Object.assign(envModule.env, { REDIS_URL: redisUrl })
      }
    } catch {
      // ignore if env module not available yet
    }
  }, 60000)

  beforeEach(async () => {
    if (!memorySearchLaneActive() || !admin?.isOpen) return
    // The instance is disposable and harness-owned; FLUSHALL also drops FT indexes,
    // giving every test a fully clean slate. Re-stamping the claim keeps the next
    // suite file's guard aware the instance is harness-owned (shared CI container).
    await claimAndFlush()
  })

  afterAll(async () => {
    if (!memorySearchLaneActive()) return

    try {
      const redisModule = await import('$lib/server/redis')
      await redisModule.disconnectAllRedisServices()
    } catch {
      // ignore
    }

    if (admin?.isOpen) {
      await admin.quit().catch(() => undefined)
    }

    if (child) {
      child.kill('SIGKILL')
      child = null
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      dataDir = null
    }

    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  return {
    url: () => redisUrl,
    adminClient: () => {
      if (!admin) throw new Error('Memory-search harness has no admin client (lane inactive?)')
      return admin
    }
  }
}
