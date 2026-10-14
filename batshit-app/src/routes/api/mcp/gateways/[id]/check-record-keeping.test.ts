/**
 * BL-550: the MCP Refresh and Test routes write back only what the check learned (the STDIO
 * record keeping: `lastTestStatus`, `lastTestAt`, `lastError`, `toolCount`), never the launch they
 * read before the check. Each case saves a new argument WHILE the check is pending, the way the
 * Gateway Settings autosave does, and asserts the edit is still stored when the route answers.
 *
 * The gateway service is a stand-in with the real one's write shapes: `update` replaces
 * `stdioConfig` whole (as `mcpGatewayService.update` does), and `recordStdioCheckResult` sets only
 * the fields it is given on the record as it is at that moment. The real service's one-step write
 * on real Redis is `check-keeps-launch-edit.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPGateway } from '$lib/types/database'

const store = vi.hoisted(() => ({ gateways: new Map<string, any>() }))
const discovery = vi.hoisted(() => ({
  refreshGateway: vi.fn(),
  healthCheck: vi.fn()
}))
const service = vi.hoisted(() => ({
  get: vi.fn(async (_userId: string, id: string) => {
    const gateway = store.gateways.get(id)
    return gateway ? structuredClone(gateway) : null
  }),
  update: vi.fn(async (_userId: string, id: string, updates: Record<string, unknown>) => {
    const current = store.gateways.get(id)
    if (!current) throw new Error(`Gateway with ID ${id} not found`)
    const next = { ...current, ...structuredClone(updates) }
    store.gateways.set(id, next)
    return structuredClone(next)
  }),
  recordStdioCheckResult: vi.fn(async (_userId: string, id: string, result: Record<string, unknown>) => {
    const current = store.gateways.get(id)
    if (!current) throw new Error(`Gateway with ID ${id} not found`)
    if (current.type !== 'stdio' || !current.stdioConfig) return 'NOT_STDIO'
    for (const [field, value] of Object.entries(result)) {
      if (value !== undefined) current.stdioConfig[field] = structuredClone(value)
    }
    return 'OK'
  })
}))

vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: service }))
vi.mock('$lib/server/services/mcpGatewayDiscovery', () => ({ mcpGatewayDiscovery: discovery }))

import { POST as refresh } from './refresh/+server'
import { POST as test } from './test/+server'

const USER = 'bl550_user'
const ID = 'gw-bl550'
const OLD_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
const NEW_ARGS = ['-y', '@modelcontextprotocol/server-filesystem', '/Users/example/projects']

function seed(stdioExtra: Record<string, unknown> = {}) {
  store.gateways.set(ID, {
    id: ID,
    name: 'Filesystem',
    type: 'stdio',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    stdioConfig: {
      command: 'npx',
      args: [...OLD_ARGS],
      cwdPolicy: 'none',
      startupTimeoutMs: 10000,
      toolCallTimeoutMs: 60000,
      lastTestStatus: 'never',
      ...stdioExtra
    }
  } satisfies MCPGateway)
}

/** The Gateway Settings autosave: it sends the whole launch with the new argument. */
async function userSavesNewArgumentDuringTheCheck() {
  const current = store.gateways.get(ID)
  await service.update(USER, ID, {
    stdioConfig: { ...current.stdioConfig, args: [...NEW_ARGS], cwdPolicy: 'project' }
  })
}

function call(handler: typeof refresh) {
  return handler({ locals: { user: { id: USER } }, params: { id: ID } } as any) as Promise<Response>
}

beforeEach(() => {
  vi.clearAllMocks()
  store.gateways.clear()
  seed()
})

describe('BL-550: Refresh keeps a launch edit saved while discovery runs', () => {
  it('a passing Refresh writes only its result and answers the gateway as stored now', async () => {
    discovery.refreshGateway.mockImplementation(async () => {
      await userSavesNewArgumentDuringTheCheck()
      return { success: true, tools: [{ name: 'read_file' }, { name: 'write_file' }] }
    })

    const response = await call(refresh)
    const body = await response.json()

    expect(response.status).toBe(200)
    const stored = store.gateways.get(ID)
    expect(stored.stdioConfig.args).toEqual(NEW_ARGS)
    expect(stored.stdioConfig.cwdPolicy).toBe('project')
    expect(stored.stdioConfig).toMatchObject({ lastTestStatus: 'passed', lastError: null, toolCount: 2 })
    expect(typeof stored.stdioConfig.lastTestAt).toBe('string')
    expect(body.gateway.stdioConfig.args).toEqual(NEW_ARGS)
    // The route never writes the launch it read before the check.
    expect(service.update).toHaveBeenCalledTimes(1)
    expect(service.recordStdioCheckResult).toHaveBeenCalledWith(USER, ID, {
      lastTestStatus: 'passed',
      lastTestAt: expect.any(String),
      lastError: null,
      toolCount: 2
    })
  })

  it('a failing Refresh writes only failed, the time and the error; the tool count stays', async () => {
    seed({ toolCount: 7 })
    discovery.refreshGateway.mockImplementation(async () => {
      await userSavesNewArgumentDuringTheCheck()
      return { success: false, tools: [], error: 'spawn npx ENOENT' }
    })

    const response = await call(refresh)

    expect(response.status).toBe(500)
    const stored = store.gateways.get(ID)
    expect(stored.stdioConfig.args).toEqual(NEW_ARGS)
    expect(stored.stdioConfig).toMatchObject({
      lastTestStatus: 'failed',
      lastError: 'spawn npx ENOENT',
      toolCount: 7
    })
    expect(service.recordStdioCheckResult.mock.calls[0][2]).not.toHaveProperty('toolCount')
  })

  it('a gateway deleted during the check answers 404, as before', async () => {
    discovery.refreshGateway.mockImplementation(async () => {
      store.gateways.delete(ID)
      return { success: true, tools: [] }
    })

    const response = await call(refresh)

    expect(response.status).toBe(404)
  })
})

describe('BL-550: Test keeps a launch edit saved while the health check runs', () => {
  it('a passing Test writes only its result', async () => {
    discovery.healthCheck.mockImplementation(async () => {
      await userSavesNewArgumentDuringTheCheck()
      return { available: true, toolCount: 4 }
    })

    const response = await call(test)

    expect(response.status).toBe(200)
    const stored = store.gateways.get(ID)
    expect(stored.stdioConfig.args).toEqual(NEW_ARGS)
    expect(stored.stdioConfig.cwdPolicy).toBe('project')
    expect(stored.stdioConfig).toMatchObject({ lastTestStatus: 'passed', lastError: null, toolCount: 4 })
    expect(service.update).toHaveBeenCalledTimes(1)
  })

  it('a failing Test with no tool count keeps the stored count', async () => {
    seed({ toolCount: 9 })
    discovery.healthCheck.mockImplementation(async () => {
      await userSavesNewArgumentDuringTheCheck()
      return { available: false, error: 'STDIO server did not start within 10000 ms' }
    })

    const response = await call(test)

    expect(response.status).toBe(200)
    const stored = store.gateways.get(ID)
    expect(stored.stdioConfig.args).toEqual(NEW_ARGS)
    expect(stored.stdioConfig).toMatchObject({
      lastTestStatus: 'failed',
      lastError: 'STDIO server did not start within 10000 ms',
      toolCount: 9
    })
    expect(service.recordStdioCheckResult.mock.calls[0][2]).not.toHaveProperty('toolCount')
  })

  it('a gateway that is no longer STDIO when the check ends gets nothing written', async () => {
    discovery.healthCheck.mockImplementation(async () => {
      const current = store.gateways.get(ID)
      store.gateways.set(ID, { ...current, type: 'custom', url: 'https://example.com/mcp', stdioConfig: undefined })
      return { available: true, toolCount: 1 }
    })

    const response = await call(test)

    expect(response.status).toBe(200)
    expect(store.gateways.get(ID).stdioConfig).toBeUndefined()
    expect(service.update).not.toHaveBeenCalled()
  })
})
