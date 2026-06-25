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

vi.mock('$lib/server/redis', () => ({
  redis: {
    getUserSettings: vi.fn().mockResolvedValue(null)
  }
}))

vi.mock('$lib/server/services/dynamicMcpIndex', () => ({
  buildCompositeKey: (gatewayId: string, groupName: string) => `${gatewayId}::${groupName}`,
  createDefaultGatewayDcmDisplaySettings: () => ({ version: 1, groups: {}, tools: {} }),
  mapGroupModeToVisibility: () => 'group+tools',
  resolveAgentDcmDisplaySettings: vi
    .fn()
    .mockResolvedValue({ version: 1, groups: {}, tools: {} }),
  resolveEffectiveGroupMode: () => 'group+tools+hints',
  resolveEffectiveToolVisibility: () => 'name+hint',
  resolveGatewayDisplayDefaults: vi.fn().mockResolvedValue(new Map()),
  resolveMcpToolDcmVisibility: () => ({
    agentGroupMode: undefined,
    effectiveGroupMode: 'group+tools+hints',
    groupVisibility: 'group+tools',
    toolVisibility: 'name+hint',
    isGroupVisible: true,
    isToolVisibleInDcm: true,
    isToolDiscoverable: true
  })
}))

let routeModule: typeof import('./+server')

describe('POST /api/mcp/tools/find', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resolveDynamicMcpGatewayScope.mockResolvedValue({
      resolvedGateways: ['gw_agent'],
      defaultGateways: ['gw_agent'],
      source: 'agent'
    })
    loadToolsForUser.mockResolvedValue({
      tools: {
        postgres_query: {
          description: 'Query postgres'
        }
      },
      metadata: new Map([
        [
          'postgres_query',
          {
            gatewayId: 'gw_agent',
            gatewayName: 'Postgres Gateway',
            gatewayType: 'custom',
            mcpServerName: 'database',
            originalToolName: 'postgres.query'
          }
        ]
      ])
    })

    routeModule = await import('./+server')
  })

  it('resolves scope through shared precedence helper and searches scoped tools', async () => {
    const request = new Request('http://localhost/api/mcp/tools/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'postgres',
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
    expect(body.totalMatches).toBe(1)
    expect(body.results?.[0]?.toolName).toBe('postgres_query')
  })
})
