import { beforeEach, describe, expect, it, vi } from 'vitest'

const mcpGatewayService = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn()
}

const workflowDiscovery = {
  discoverDirectMCPClients: vi.fn().mockResolvedValue([])
}

const redis = {
  execute: vi.fn().mockResolvedValue([])
}

const apiKeyService = {
  store: vi.fn()
}

const syncAgentCodexProfiles = vi.fn()
const syncAgentClaudeProfiles = vi.fn()
const writeDockerMcpProfileEnv = vi.fn()

vi.mock('$lib/server/services/mcpGatewayService', () => ({
  mcpGatewayService
}))

vi.mock('$lib/server/services/workflowDiscovery', () => ({
  workflowDiscovery
}))

vi.mock('$lib/server/redis', () => ({
  redis
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService
}))

vi.mock('$lib/server/services/codexProfileManager', () => ({
  syncAgentCodexProfiles
}))

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles
}))

vi.mock('$lib/server/services/dockerGatewayProfileConfig', () => ({
  getActiveDockerMcpProfile: vi.fn(() => 'default'),
  normalizeDockerMcpProfile: vi.fn((profile: string) => profile.trim() || 'default'),
  writeDockerMcpProfileEnv
}))

describe('/api/mcp/gateways profile sync hooks', () => {
  let collectionRoute: typeof import('./+server')
  let itemRoute: typeof import('./[id]/+server')

  beforeEach(async () => {
    vi.clearAllMocks()

    mcpGatewayService.list.mockResolvedValue([])
    mcpGatewayService.get.mockResolvedValue({
      id: 'gw_1',
      name: 'Gateway 1',
      type: 'custom',
      url: 'http://localhost:8080/mcp',
      enabled: true,
      metadata: {}
    })
    mcpGatewayService.create.mockResolvedValue(undefined)
    mcpGatewayService.update.mockResolvedValue(undefined)
    mcpGatewayService.delete.mockResolvedValue(undefined)

    collectionRoute = await import('./+server')
    itemRoute = await import('./[id]/+server')
  })

  it('POST syncs both Codex and Claude managed profiles', async () => {
    const request = new Request('http://localhost/api/mcp/gateways', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gateway 1',
        type: 'custom',
        url: 'http://localhost:8080/mcp',
        enabled: true
      })
    })

    const response = await collectionRoute.POST({
      request,
      locals: { user: { id: 'josh' } }
    } as any)

    expect(response.status).toBe(201)
    expect(syncAgentCodexProfiles).toHaveBeenCalledWith('josh')
    expect(syncAgentClaudeProfiles).toHaveBeenCalledWith('josh')
  })

  it('PUT and DELETE sync both Codex and Claude managed profiles', async () => {
    const putRequest = new Request('http://localhost/api/mcp/gateways/gw_1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    })

    const putResponse = await itemRoute.PUT({
      request: putRequest,
      locals: { user: { id: 'josh' } },
      params: { id: 'gw_1' }
    } as any)

    expect(putResponse.status).toBe(200)
    expect(syncAgentCodexProfiles).toHaveBeenCalledWith('josh')
    expect(syncAgentClaudeProfiles).toHaveBeenCalledWith('josh')

    const deleteResponse = await itemRoute.DELETE({
      locals: { user: { id: 'josh' } },
      params: { id: 'gw_1' }
    } as any)

    expect(deleteResponse.status).toBe(200)
    expect(syncAgentCodexProfiles).toHaveBeenCalledTimes(2)
    expect(syncAgentClaudeProfiles).toHaveBeenCalledTimes(2)
  })

  it('clears stale Docker MCP tools when the selected profile changes', async () => {
    mcpGatewayService.get
      .mockResolvedValueOnce({
        id: 'gw_1',
        name: 'Docker MCP Gateway',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true,
        discoveredTools: ['mcp-add', 'mcp-find', 'mcp-remove'],
        lastDiscovery: 1780168986795,
        metadata: { dockerProfile: 'default' }
      })
      .mockResolvedValueOnce({
        id: 'gw_1',
        name: 'Docker MCP Gateway',
        type: 'docker-catalog',
        url: 'http://localhost:8080/mcp',
        enabled: true,
        discoveredTools: [],
        lastDiscovery: 0,
        metadata: { dockerProfile: 'batshit' }
      })

    const putRequest = new Request('http://localhost/api/mcp/gateways/gw_1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { dockerProfile: 'batshit' } })
    })

    const response = await itemRoute.PUT({
      request: putRequest,
      locals: { user: { id: 'josh' } },
      params: { id: 'gw_1' }
    } as any)

    expect(response.status).toBe(200)
    expect(writeDockerMcpProfileEnv).toHaveBeenCalledWith('batshit')
    expect(mcpGatewayService.update).toHaveBeenCalledWith(
      'josh',
      'gw_1',
      expect.objectContaining({
        discoveredTools: [],
        lastDiscovery: 0,
        metadata: expect.objectContaining({ dockerProfile: 'batshit' })
      })
    )
  })
})
