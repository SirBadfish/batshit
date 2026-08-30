import { afterAll, beforeAll, beforeEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type RedisClientType } from 'redis'

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
 *  - Refuses Batshit's known runtime ports (6379, 5639, 6380, 5649).
 *  - Refuses any instance that already contains a `user:` key.
 *  - Uses a run-unique BATSHIT_MEMORY_INDEX_SUFFIX for index names.
 *  - The RedisService db-0 rewrite stays active for every URL except the one this
 *    harness designates via MEMORY_TEST_REDIS_URL (see isDesignatedMemorySearchTestUrl).
 */

const REFUSED_PORTS = new Set([6379, 5639, 6380, 5649])

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
    if (!REFUSED_PORTS.has(port)) return port
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

    const parsed = new URL(redisUrl)
    const port = Number(parsed.port || '6379')
    if (REFUSED_PORTS.has(port)) {
      throw new Error(
        `Memory-search harness refuses port ${port}: it belongs to a real Batshit Redis lane. ` +
          'Point MEMORY_TEST_REDIS_URL at a dedicated disposable instance.'
      )
    }

    admin = createClient({ url: redisUrl, database: 0 })
    admin.on('error', (error) => console.error('[memory-search harness] Redis error:', error))
    await admin.connect()

    // Belt and suspenders: a real Batshit instance always has user records.
    const userKeys = await admin.keys('user:*')
    if (userKeys.length > 0) {
      throw new Error(
        'Memory-search harness refuses this instance: it contains user:* keys and therefore looks like real Batshit data.'
      )
    }

    setEnv('MEMORY_TEST_REDIS_URL', redisUrl)
    setEnv('REDIS_URL', redisUrl)
    setEnv('BATSHIT_MEMORY_INDEX_SUFFIX', `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`)
    try {
      const envModule = await import('$env/dynamic/private')
      if (envModule?.env) {
        envModule.env.REDIS_URL = redisUrl
      }
    } catch {
      // ignore if env module not available yet
    }
  }, 60000)

  beforeEach(async () => {
    if (!memorySearchLaneActive() || !admin?.isOpen) return
    // The instance is disposable and harness-owned; FLUSHALL also drops FT indexes,
    // giving every test a fully clean slate.
    await admin.flushAll()
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
