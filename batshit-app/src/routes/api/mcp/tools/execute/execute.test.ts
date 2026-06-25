import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadToolsForUser = vi.fn()
const resolveDynamicMcpGatewayScope = vi.fn()

vi.mock('$lib/server/services/mcpGatewayDiscovery', () => ({
  mcpGatewayDiscovery: {
    loadToolsForUser
  }
}))

vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveDynamicMcpGatewayScope
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn().mockResolvedValue(null)
  }
}))

let routeModule: typeof import('./+server')

describe('POST /api/mcp/tools/execute', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resolveDynamicMcpGatewayScope.mockResolvedValue({
      resolvedGateways: ['gw_agent'],
      defaultGateways: ['gw_agent'],
      source: 'agent'
    })
    routeModule = await import('./+server')
  })

  it('executes tools only inside resolved Dynamic MCP scope', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    loadToolsForUser.mockResolvedValue({
      tools: {
        redis_get: { execute }
      },
      metadata: new Map([
        [
          'redis_get',
          {
            gatewayId: 'gw_agent',
            gatewayName: 'Redis Gateway',
            gatewayType: 'custom',
            mcpServerName: 'redis',
            originalToolName: 'redis.get'
          }
        ]
      ])
    })

    const request = new Request('http://localhost/api/mcp/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolName: 'redis_get',
        params: { key: 'foo' },
        agentId: 'agent_1'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(200)
    const body = await response.json()

    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh',
      agentId: 'agent_1',
      selectedGateways: undefined
    })
    expect(loadToolsForUser).toHaveBeenCalledWith(
      'josh',
      ['gw_agent'],
      undefined,
      { skipFiltering: true }
    )
    expect(execute).toHaveBeenCalledWith({ key: 'foo' })
    expect(body.success).toBe(true)
  })

  it('rejects out-of-scope tools even when they exist globally', async () => {
    loadToolsForUser
      .mockResolvedValueOnce({
        tools: {
          redis_get: { execute: vi.fn() }
        },
        metadata: new Map()
      })
      .mockResolvedValueOnce({
        tools: {
          redis_get: { execute: vi.fn() },
          postgres_query: { execute: vi.fn() }
        },
        metadata: new Map()
      })

    const request = new Request('http://localhost/api/mcp/tools/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolName: 'postgres_query',
        agentId: 'agent_1'
      })
    })

    const response = await routeModule.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(String(body.error || '')).toMatch(/outside the active Dynamic MCP scope/i)
  })
})

