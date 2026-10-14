import { afterEach, describe, expect, it, vi } from 'vitest'

// BL-1371: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpToolListCache } from '$lib/server/services/mcpToolListCache'

/**
 * BL-1371 on Redis 8 + JSON: the gateway registry's compare-and-set (`redis.json.getRaw`,
 * `setIfUnchanged`, `delIfUnchanged`, one Lua script) and the one interleave the default lane
 * cannot run, the real Lua check (`RECORD_STDIO_CHECK_SCRIPT`) landing between a save's snapshot
 * and its compare-and-set. The primitive checks pin the true RedisJSON shapes the default lane's
 * twin copies (`test-utils/redisJsonCompareAndWriteTwin.test.ts`): raw `$` arrays, `[]` for a path
 * that matches nothing, null for a missing key, and success only when the write reports it.
 *
 * Real-Redis suite (G-0228): it runs only under `npm run test:redis` and reports as skipped in the
 * default lane. The default-lane twin of the service cases is `mcpGatewayService.registryWrites.test.ts`.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'bl1371_real_user'
const KEY = `mcp_gateways:${USER}`
const OTHER_KEY = `mcp_gateways:${USER}_absent`
const OLD_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
const NEW_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example/projects']

function stdioGateway(id: string, name: string) {
  return {
    id,
    name,
    type: 'stdio' as const,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z',
    stdioConfig: { command: 'npx', args: [...OLD_ARGS], cwdPolicy: 'none' as const }
  }
}

function customGateway(id: string, name: string) {
  return {
    id,
    name,
    type: 'custom' as const,
    url: `https://${id}.example.test/mcp`,
    enabled: true,
    created_at: '2026-10-11T00:00:00.000Z'
  }
}

async function seed() {
  await mcpGatewayService.create(USER, stdioGateway('gw-a', 'Alpha'))
  await mcpGatewayService.create(USER, stdioGateway('gw-b', 'Beta'))
  await mcpGatewayService.create(USER, customGateway('gw-c', 'Gamma'))
}

async function stored(id: string) {
  const registry = (await redis.json.get(KEY)) as { gateways: any[] } | null
  return registry?.gateways.find((gateway) => gateway.id === id) ?? null
}

/** Runs `competitor` once, just before the first compare-and-set write of the registry. */
function beforeFirstSetIfUnchanged(competitor: () => Promise<unknown>) {
  const original = redis.json.setIfUnchanged
  let armed = true
  return vi.spyOn(redis.json, 'setIfUnchanged').mockImplementation(async (key, path, expectedRaw, value) => {
    if (armed && key === KEY) {
      armed = false
      await competitor()
    }
    return original(key, path, expectedRaw, value)
  })
}

describe.runIf(REAL_REDIS_LANE)('BL-1371: gateway registry compare-and-set (real Redis)', () => {
  useRedisTestServer()

  afterEach(() => {
    vi.restoreAllMocks()
    mcpToolListCache.clearAll()
  })

  it('a launch save keeps the real check result written between its snapshot and its write', async () => {
    await seed()
    const otherBefore = await stored('gw-a')
    const writes = beforeFirstSetIfUnchanged(() =>
      mcpGatewayService.recordStdioCheckResult(USER, 'gw-b', {
        lastTestStatus: 'passed',
        lastTestAt: '2026-10-11T18:00:00.000Z',
        lastError: null,
        toolCount: 7
      })
    )

    const saved = await mcpGatewayService.update(USER, 'gw-b', {
      stdioConfig: { ...stdioGateway('gw-b', 'Beta').stdioConfig, args: [...NEW_ARGS] }
    })

    const config = (await stored('gw-b')).stdioConfig
    expect(config.args).toEqual(NEW_ARGS)
    expect(config).toMatchObject({
      lastTestStatus: 'passed',
      lastTestAt: '2026-10-11T18:00:00.000Z',
      lastError: null,
      toolCount: 7
    })
    expect(saved.stdioConfig).toEqual(config)
    // The first compare-and-set was refused by the check's write; the second stored.
    expect(writes.mock.calls.filter((call) => call[0] === KEY)).toHaveLength(2)
    expect(await stored('gw-a')).toEqual(otherBefore)
  })

  it('a save lands on its own gateway when a delete shifts the list before its write', async () => {
    await seed()
    const gammaBefore = await stored('gw-c')
    beforeFirstSetIfUnchanged(() => mcpGatewayService.delete(USER, 'gw-a'))

    await mcpGatewayService.update(USER, 'gw-b', { name: 'Beta renamed' })

    expect(await stored('gw-a')).toBeNull()
    expect((await stored('gw-b')).name).toBe('Beta renamed')
    expect(await stored('gw-c')).toEqual(gammaBefore)
  })

  it('compares raw text with non-ASCII characters byte for byte (no refusal from the UTF-8 round trip)', async () => {
    await seed()
    const writes = vi.spyOn(redis.json, 'setIfUnchanged')

    await mcpGatewayService.update(USER, 'gw-b', { name: 'Bêta 🦇 ü' })
    await mcpGatewayService.update(USER, 'gw-b', { enabled: false })

    expect(await stored('gw-b')).toMatchObject({ name: 'Bêta 🦇 ü', enabled: false })
    // One compare-and-set each: the second compared the stored non-ASCII text and matched.
    expect(writes.mock.calls.filter((call) => call[0] === KEY)).toHaveLength(2)
  })

  it('reads the raw RedisJSON shapes: a $ array, [] for a path past the end, null for no key', async () => {
    await seed()
    const root = await redis.json.getRaw(KEY, '$')
    expect(typeof root).toBe('string')
    const rootMatches = JSON.parse(root!)
    expect(Array.isArray(rootMatches) && rootMatches.length).toBe(1)
    expect(rootMatches[0].gateways.map((gateway: any) => gateway.id)).toEqual(['gw-a', 'gw-b', 'gw-c'])

    const element = JSON.parse((await redis.json.getRaw(KEY, '$.gateways[1]'))!)
    expect(element).toHaveLength(1)
    expect(element[0].id).toBe('gw-b')

    expect(await redis.json.getRaw(KEY, '$.gateways[3]')).toBe('[]')
    expect(await redis.json.getRaw(OTHER_KEY, '$')).toBeNull()
  })

  it('setIfUnchanged writes from the exact text and refuses a stale one, writing nothing', async () => {
    await seed()
    const raw = (await redis.json.getRaw(KEY, '$.gateways[1]'))!
    const before = JSON.parse(raw)[0]
    const siblingsBefore = [await redis.json.getRaw(KEY, '$.gateways[0]'), await redis.json.getRaw(KEY, '$.gateways[2]')]

    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[1]', raw, { ...before, name: 'Beta one' })).toBe(true)
    expect((await stored('gw-b')).name).toBe('Beta one')
    expect([await redis.json.getRaw(KEY, '$.gateways[0]'), await redis.json.getRaw(KEY, '$.gateways[2]')]).toEqual(siblingsBefore)

    const registryText = await redis.json.getRaw(KEY, '$')
    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[1]', raw, { ...before, name: 'Beta stale' })).toBe(false)
    expect(await redis.json.getRaw(KEY, '$')).toBe(registryText)
  })

  it('setIfUnchanged creates an absent key only from the empty text, once', async () => {
    expect(await redis.json.setIfUnchanged(OTHER_KEY, '$', '', { gateways: [] })).toBe(true)
    expect(await redis.json.get(OTHER_KEY)).toEqual({ gateways: [] })
    expect(await redis.json.setIfUnchanged(OTHER_KEY, '$', '', { gateways: [{ id: 'late' }] })).toBe(false)
    expect(await redis.json.get(OTHER_KEY)).toEqual({ gateways: [] })
  })

  it('refuses an index that now holds another gateway, and an index whose gateway was deleted', async () => {
    await seed()
    const rawA = (await redis.json.getRaw(KEY, '$.gateways[0]'))!
    const rawB = (await redis.json.getRaw(KEY, '$.gateways[1]'))!
    const rawC = (await redis.json.getRaw(KEY, '$.gateways[2]'))!

    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[0]', rawA)).toBe(true)
    // Index 1 now holds gw-c: the snapshot of gw-b no longer matches.
    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[1]', rawB, { id: 'gw-b', name: 'wrong place' })).toBe(false)
    expect(await redis.json.getRaw(KEY, '$.gateways[1]')).toBe(rawC)
    // Index 2 is past the end now: `[]`, so the old text of gw-c there is refused too.
    expect(await redis.json.setIfUnchanged(KEY, '$.gateways[2]', rawC, { id: 'gw-c', name: 'gone' })).toBe(false)
    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[2]', rawC)).toBe(false)
    expect(((await redis.json.get(KEY)) as any).gateways.map((gateway: any) => gateway.id)).toEqual(['gw-b', 'gw-c'])
  })

  it('delIfUnchanged removes one gateway only and keeps its siblings byte for byte; $ removes the key', async () => {
    await seed()
    const rawA = await redis.json.getRaw(KEY, '$.gateways[0]')
    const rawB = (await redis.json.getRaw(KEY, '$.gateways[1]'))!
    const rawC = await redis.json.getRaw(KEY, '$.gateways[2]')

    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[1]', '[{"id":"gw-b"}]')).toBe(false)
    expect(await redis.json.delIfUnchanged(KEY, '$.gateways[1]', rawB)).toBe(true)
    expect(await redis.json.getRaw(KEY, '$.gateways[0]')).toBe(rawA)
    expect(await redis.json.getRaw(KEY, '$.gateways[1]')).toBe(rawC)

    expect(await redis.json.delIfUnchanged(KEY, '$', (await redis.json.getRaw(KEY, '$'))!)).toBe(true)
    expect(await redis.exists(KEY)).toBe(false)
  })

  it('a compare that passes but cannot write throws and writes nothing, never answers true', async () => {
    await seed()
    const registryText = await redis.json.getRaw(KEY, '$')
    // `$.gateways[5]` matches nothing (`[]`), so the compare passes; RedisJSON cannot create it.
    await expect(redis.json.setIfUnchanged(KEY, '$.gateways[5]', '[]', { id: 'gw-z' })).rejects.toThrow()
    await expect(redis.json.delIfUnchanged(KEY, '$.gateways[5]', '[]')).rejects.toThrow()
    await expect(redis.json.delIfUnchanged(OTHER_KEY, '$', '')).rejects.toThrow()
    expect(await redis.json.getRaw(KEY, '$')).toBe(registryText)
    expect(await redis.exists(OTHER_KEY)).toBe(false)
  })
})
