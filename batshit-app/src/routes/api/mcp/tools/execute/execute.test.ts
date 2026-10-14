import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadToolsForUser = vi.fn()
const resolveDynamicMcpGatewayScope = vi.fn()
const resolveNativeToolUser = vi.fn()

vi.mock('$lib/server/services/nativeToolAuth', () => ({ resolveNativeToolUser }))

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
    resolveNativeToolUser.mockResolvedValue({ userId: 'josh', auth: 'session' })
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

  it('does not discover globally when a tool is absent from the active scope', async () => {
    loadToolsForUser.mockResolvedValue({
      tools: { redis_get: { execute: vi.fn() } }, metadata: new Map()
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

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(String(body.error || '')).toMatch(/not found in the active Dynamic MCP scope/i)
    expect(loadToolsForUser).toHaveBeenCalledTimes(1)
  })

  it('passes the credential gateway ceiling separately from a narrowing body filter', async () => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'agent', agentId: 'agent_1', mcpGatewayScope: ['gw_agent']
    })
    loadToolsForUser.mockResolvedValue({ tools: {}, metadata: new Map() })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/execute', {
        method: 'POST', body: JSON.stringify({
          toolName: 'redis_get', selectedGateways: ['gw_other'], mcpGatewayScope: ['gw_other']
        })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(404)
    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh', agentId: 'agent_1', mcpGatewayScope: ['gw_agent'], selectedGateways: ['gw_other']
    })
    expect(loadToolsForUser).toHaveBeenCalledTimes(1)
  })

  it('refuses an unoffered delegated execution before scope resolution or discovery', async () => {
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'agent', agentId: 'subagent_cli_1', delegated: true,
      delegatedAllowedControlIds: [], mcpGatewayScope: ['gw_agent']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/execute', {
        method: 'POST', body: JSON.stringify({ toolName: 'redis_get' })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('CONTROL_NOT_ALLOWED')
    expect(resolveDynamicMcpGatewayScope).not.toHaveBeenCalled()
    expect(loadToolsForUser).not.toHaveBeenCalled()
  })

  // BL-687: a Portable Skill Token names no agent, so the scope would be every gateway the user
  // enabled. No portable family grants the dynamic MCP controls, so the route refuses it, the
  // way `/api/controls/use` refuses `sys.mcp.dynamic.use` for the same token.
  it('refuses a Portable Skill Token whose families grant no dynamic MCP control', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    loadToolsForUser.mockResolvedValue({
      tools: { redis_get: { execute } },
      metadata: new Map([['redis_get', { gatewayId: 'gw_agent', gatewayName: 'Redis Gateway' }]])
    })
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'portable-skill',
      portableSkillToken: { id: 'pst_1', label: 'zcsec', families: ['artifacts', 'cli-tools'] },
      portableSkillAllowedControlIds: ['sys.artifact.create', 'sys.cli_tool.list']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/execute', {
        method: 'POST', body: JSON.stringify({ toolName: 'redis_get', params: { key: 'foo' } })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.code).toBe('CONTROL_NOT_ALLOWED')
    expect(body.error).toContain('sys.mcp.dynamic.use')
    expect(resolveDynamicMcpGatewayScope).not.toHaveBeenCalled()
    expect(loadToolsForUser).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('serves a Portable Skill Token only when a family grants the use control', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    loadToolsForUser.mockResolvedValue({
      tools: { redis_get: { execute } },
      metadata: new Map([['redis_get', { gatewayId: 'gw_agent', gatewayName: 'Redis Gateway' }]])
    })
    resolveNativeToolUser.mockResolvedValue({
      userId: 'josh', auth: 'portable-skill', portableSkillAllowedControlIds: ['sys.mcp.dynamic.use']
    })
    const response = await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/execute', {
        method: 'POST', body: JSON.stringify({ toolName: 'redis_get', params: { key: 'foo' } })
      }),
      locals: {}
    } as any)
    expect(response.status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('passes an empty ceiling for an older agent credential without a snapshot', async () => {
    resolveNativeToolUser.mockResolvedValue({ userId: 'josh', auth: 'agent', agentId: 'agent_1' })
    loadToolsForUser.mockResolvedValue({ tools: {}, metadata: new Map() })
    await routeModule.POST({
      request: new Request('http://localhost/api/mcp/tools/execute', {
        method: 'POST', body: JSON.stringify({ toolName: 'redis_get', gatewayFilter: ['gw_other'] })
      }),
      locals: {}
    } as any)
    expect(resolveDynamicMcpGatewayScope).toHaveBeenCalledWith({
      userId: 'josh', agentId: 'agent_1', mcpGatewayScope: [], selectedGateways: ['gw_other']
    })
  })
})
