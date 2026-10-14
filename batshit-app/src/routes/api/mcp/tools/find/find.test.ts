import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadToolsForUser = vi.fn()
const resolveDynamicMcpGatewayScope = vi.fn()
const resolveNativeToolUser = vi.fn()
const redisGet = vi.fn()

vi.mock('$lib/server/services/nativeToolAuth', () => ({ resolveNativeToolUser }))

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
    get: redisGet,
    getUserSettings: vi.fn().mockResolvedValue(null)
  }
}))

vi.mock('$lib/server/services/dynamicMcpIndex', async () => {
  const visibility = await vi.importActual<typeof import('$lib/server/services/dynamicMcpVisibility')>(
    '$lib/server/services/dynamicMcpVisibility'
  )
  const display = await vi.importActual<typeof import('$lib/utils/dcmDisplaySettings')>(
    '$lib/utils/dcmDisplaySettings'
  )
  return {
    buildCompositeKey: visibility.buildCompositeKey,
    createDefaultGatewayDcmDisplaySettings: display.createDefaultGatewayDcmDisplaySettings,
    resolveAgentDcmDisplaySettings: visibility.resolveAgentDcmDisplaySettings,
    resolveGatewayDisplayDefaults: vi.fn().mockResolvedValue(new Map()),
    resolveMcpToolDcmVisibility: visibility.resolveMcpToolDcmVisibility
  }
})

let routeModule: typeof import('./+server')

describe('POST /api/mcp/tools/find', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    redisGet.mockResolvedValue(null)
    resolveNativeToolUser.mockResolvedValue({ userId: 'josh', auth: 'session' })
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

  it('passes the credential gateway ceiling separately from a narrowing body filter', async () => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'agent', agentId: 'agent_1', mcpGatewayScope: ['gw_agent']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST',
        body: JSON.stringify({ query: 'postgres', selectedGateways: ['gw_other'], mcpGatewayScope: ['gw_other'] })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(200)
    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh', agentId: 'agent_1', mcpGatewayScope: ['gw_agent'], selectedGateways: ['gw_other']
    })
  })

  it('refuses an unoffered delegated find before scope resolution or discovery', async () => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'agent', agentId: 'subagent_cli_1', delegated: true,
      delegatedAllowedControlIds: [], mcpGatewayScope: ['gw_agent']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres', selectedGateways: ['gw_agent'] })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('CONTROL_NOT_ALLOWED')
    expect(resolveDynamicMcpGatewayScope).not.toHaveBeenCalled()
    expect(loadToolsForUser).not.toHaveBeenCalled()
  })

  // BL-687: see the matching execute test.
  it('refuses a Portable Skill Token whose families grant no dynamic MCP control', async () => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'portable-skill',
      portableSkillToken: { id: 'pst_1', label: 'zcsec', families: ['artifacts'] },
      portableSkillAllowedControlIds: ['sys.artifact.create']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres', agentId: 'agent_1' })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.code).toBe('CONTROL_NOT_ALLOWED')
    expect(body.error).toContain('sys.mcp.dynamic.find')
    expect(resolveDynamicMcpGatewayScope).not.toHaveBeenCalled()
    expect(loadToolsForUser).not.toHaveBeenCalled()
  })

  it('serves a Portable Skill Token only when a family grants the find control', async () => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'portable-skill', portableSkillAllowedControlIds: ['sys.mcp.dynamic.find']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres' })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(200)
    expect(loadToolsForUser).toHaveBeenCalledTimes(1)
  })

  it('leaves service calls without an agent on the resolver default and treats body agentId as only a hint', async () => {
    resolveNativeToolUser.mockResolvedValue({ userId: 'josh', auth: 'service' })
    await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres' })
      }),
      locals: {}
    } as any)
    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh', agentId: null, selectedGateways: undefined
    })
    resolveDynamicMcpGatewayScope.mockClear()
    await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres', agentId: 'agent_1' })
      }),
      locals: {}
    } as any)
    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh', agentId: 'agent_1', selectedGateways: undefined
    })
  })

  it('passes an empty ceiling for an older agent credential without a snapshot', async () => {
    resolveNativeToolUser.mockResolvedValue({ userId: 'josh', auth: 'agent', agentId: 'agent_1' })
    await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres', selectedGateways: ['gw_other'] })
      }),
      locals: {}
    } as any)
    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh', agentId: 'agent_1', mcpGatewayScope: [], selectedGateways: ['gw_other']
    })
  })

  it.each([
    ['group', { groups: { 'gw_agent::database': 'hidden' }, tools: {} }],
    ['tool', { groups: {}, tools: { 'gw_agent::postgres.query': 'hidden' } }]
  ])('keeps the stored hidden %s undiscoverable when an agent forges display settings', async (_kind, hidden) => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'agent', agentId: 'agent_1', mcpGatewayScope: ['gw_agent']
    })
    redisGet.mockResolvedValue({ dcmDisplaySettings: { version: 1, ...hidden } })
    const post = async (dcmDisplaySettings?: object) => {
      const response = await routeModule.POST({
        request: new Request('http://localhost/api/mcp/tools/find', {
          method: 'POST', body: JSON.stringify({ query: 'postgres', ...(dcmDisplaySettings ? { dcmDisplaySettings } : {}) })
        }),
        locals: {}
      } as any)
      expect(response.status).toBe(200)
      return await response.json()
    }
    expect((await post()).results).toEqual([])
    expect((await post({ version: 1, groups: {}, tools: {} })).results).toEqual([])
    expect(redisGet).toHaveBeenCalledWith('agent:agent_1')

    redisGet.mockResolvedValue({ dcmDisplaySettings: { version: 1, groups: {}, tools: {} } })
    expect((await post()).results.map((item: any) => item.toolName)).toContain('postgres_query')
  })

  it('still accepts a signed-in settings preview display override', async () => {
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/find', {
        method: 'POST', body: JSON.stringify({ query: 'postgres', agentId: 'agent_1',
          dcmDisplaySettings: { version: 1, groups: { 'gw_agent::database': 'hidden' }, tools: {} } })
      }),
      locals: { user: { id: 'josh' } }
    } as any)
    expect(response.status).toBe(200)
    expect((await response.json()).results).toEqual([])
    expect(redisGet).not.toHaveBeenCalled()
  })
})
