import { describe, expect, it, vi } from 'vitest'

// BL-550: the real RedisService, even if other suites mocked the module earlier.
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

const discovery = vi.hoisted(() => ({ refreshGateway: vi.fn(), healthCheck: vi.fn() }))
vi.mock('$lib/server/services/mcpGatewayDiscovery', () => ({ mcpGatewayDiscovery: discovery }))

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpToolListCache } from '$lib/server/services/mcpToolListCache'
import { POST as refresh } from './refresh/+server'
import { POST as test } from './test/+server'

/**
 * BL-550: a Refresh or a Test writes back only what it learned, into the gateway as it is when
 * the check ends, so an argument saved while the check ran stays saved. Drives the real routes and
 * the real `mcpGatewayService` (its Lua write and its `update`) on Redis 8 + JSON; only the check
 * itself (`mcpGatewayDiscovery`) is a stand-in, and it saves the edit while it is pending. No MCP
 * server is started.
 *
 * Real-Redis suite (G-0228): it runs only under `npm run test:redis` and reports as skipped in the
 * default lane, whose Redis fake has no EVAL. The route-level twin with a stand-in service is
 * `check-record-keeping.test.ts`.
 */

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'bl550_real_user'
const KEY = `mcp_gateways:${USER}`
const OLD_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
const NEW_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example/projects']

function stdioGateway(id: string, name: string) {
  return {
    id,
    name,
    type: 'stdio' as const,
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    stdioConfig: {
      command: 'npx',
      args: [...OLD_ARGS],
      cwdPolicy: 'none' as const,
      lastTestStatus: 'never' as const
    }
  }
}

async function seed() {
  await mcpGatewayService.create(USER, stdioGateway('gw-first', 'First'))
  await mcpGatewayService.create(USER, stdioGateway('gw-target', 'Target'))
  await mcpGatewayService.create(USER, {
    id: 'gw-http',
    name: 'Remote',
    type: 'custom',
    url: 'https://example.com/mcp',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z'
  })
}

async function stored(id: string) {
  const registry = (await redis.json.get(KEY)) as { gateways: any[] } | null
  return registry?.gateways.find((gateway) => gateway.id === id) ?? null
}

/** The Gateway Settings autosave: the whole launch with the new argument, and its old result. */
async function userSavesNewArgument(id: string) {
  const current = await stored(id)
  await mcpGatewayService.update(USER, id, {
    stdioConfig: { ...current.stdioConfig, args: [...NEW_ARGS] }
  })
}

function call(handler: typeof refresh, id: string) {
  return handler({ locals: { user: { id: USER } }, params: { id } } as any) as Promise<Response>
}

describe.runIf(REAL_REDIS_LANE)('BL-550: a check keeps a launch edit saved while it ran (real Redis)', () => {
  useRedisTestServer()

  it('Refresh: the edit stays, the result is written, the other gateways are untouched', async () => {
    await seed()
    const firstBefore = await stored('gw-first')
    discovery.refreshGateway.mockImplementationOnce(async () => {
      await userSavesNewArgument('gw-target')
      return { success: true, tools: [{ name: 'read_file' }, { name: 'write_file' }] }
    })

    const response = await call(refresh, 'gw-target')
    const body = await response.json()

    expect(response.status).toBe(200)
    const target = await stored('gw-target')
    expect(target.stdioConfig.args).toEqual(NEW_ARGS)
    expect(target.stdioConfig).toMatchObject({ lastTestStatus: 'passed', lastError: null, toolCount: 2 })
    expect(typeof target.stdioConfig.lastTestAt).toBe('string')
    expect(body.gateway.stdioConfig.args).toEqual(NEW_ARGS)
    expect(await stored('gw-first')).toEqual(firstBefore)
  })

  it('Test: a failure keeps the edit and the stored tool count', async () => {
    await seed()
    await mcpGatewayService.recordStdioCheckResult(USER, 'gw-target', { toolCount: 6 })
    discovery.healthCheck.mockImplementationOnce(async () => {
      await userSavesNewArgument('gw-target')
      return { available: false, error: 'STDIO server did not start within 10000 ms' }
    })

    const response = await call(test, 'gw-target')

    expect(response.status).toBe(200)
    const target = await stored('gw-target')
    expect(target.stdioConfig.args).toEqual(NEW_ARGS)
    expect(target.stdioConfig).toMatchObject({
      lastTestStatus: 'failed',
      lastError: 'STDIO server did not start within 10000 ms',
      toolCount: 6
    })
  })

  it('finds the gateway by id after another gateway is deleted during the check', async () => {
    await seed()
    discovery.healthCheck.mockImplementationOnce(async () => {
      await mcpGatewayService.delete(USER, 'gw-first')
      return { available: true, toolCount: 3 }
    })

    await call(test, 'gw-target')

    expect(await stored('gw-first')).toBeNull()
    expect((await stored('gw-target')).stdioConfig).toMatchObject({ lastTestStatus: 'passed', toolCount: 3 })
    expect((await stored('gw-http')).stdioConfig).toBeUndefined()
  })

  it('a settings save built before the check answered keeps the check result', async () => {
    await seed()
    const staleCopy = await stored('gw-target')
    await mcpGatewayService.recordStdioCheckResult(USER, 'gw-target', {
      lastTestStatus: 'passed',
      lastTestAt: '2026-10-11T15:00:00.000Z',
      lastError: null,
      toolCount: 11
    })

    await mcpGatewayService.update(USER, 'gw-target', {
      stdioConfig: { ...staleCopy.stdioConfig, args: [...NEW_ARGS] }
    })

    expect((await stored('gw-target')).stdioConfig).toMatchObject({
      args: NEW_ARGS,
      lastTestStatus: 'passed',
      lastTestAt: '2026-10-11T15:00:00.000Z',
      lastError: null,
      toolCount: 11
    })
  })

  it('answers not found for a deleted gateway and writes nothing to a non-STDIO one', async () => {
    await seed()
    await expect(
      mcpGatewayService.recordStdioCheckResult(USER, 'gw-gone', { lastTestStatus: 'passed' })
    ).rejects.toThrow('Gateway with ID gw-gone not found')
    const httpBefore = await stored('gw-http')

    await expect(
      mcpGatewayService.recordStdioCheckResult(USER, 'gw-http', { lastTestStatus: 'passed' })
    ).resolves.toBe('NOT_STDIO')

    expect(await stored('gw-http')).toEqual(httpBefore)
  })

  it('keeps the saved tool list: a check result is record keeping, not a settings change', async () => {
    await seed()
    await mcpToolListCache.read(
      { userId: USER, gatewayId: 'gw-target', inputs: { probe: true } },
      async () => ({ ok: true, tools: [] })
    )

    await mcpGatewayService.recordStdioCheckResult(USER, 'gw-target', { lastTestStatus: 'passed', toolCount: 1 })

    const lookup = vi.fn(async () => ({ ok: true as const, tools: [] }))
    await mcpToolListCache.read({ userId: USER, gatewayId: 'gw-target', inputs: { probe: true } }, lookup)
    expect(lookup).not.toHaveBeenCalled()
  })
})
