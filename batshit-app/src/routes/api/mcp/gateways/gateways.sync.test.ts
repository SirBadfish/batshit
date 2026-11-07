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

const syncAgentClaudeProfiles = vi.fn()
const writeDockerMcpProfileEnv = vi.fn()

vi.mock('$lib/server/services/mcpGatewayService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/mcpGatewayService')>()),
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

vi.mock('$lib/server/services/claudeProfileManager', () => ({
  syncAgentClaudeProfiles
}))

vi.mock('$lib/server/services/dockerGatewayProfileConfig', () => ({
  getActiveDockerMcpProfile: vi.fn(() => 'default'),
  normalizeDockerMcpProfile: vi.fn((profile: string) => profile.trim() || 'default'),
  // BL-1386: the routes check the runtime before the save and write the file after it, through
  // the one-at-a-time runner (here it just runs the write).
  assertDockerMcpProfileWritable: vi.fn(),
  runDockerMcpProfileWrite: vi.fn((write: () => Promise<void>) => write()),
  DOCKER_PROFILE_FILE_NOT_FINISHED: 'profile file not finished',
  writeDockerMcpProfileEnv
}))

describe('/api/mcp/gateways profile sync hooks', () => {
  let collectionRoute: typeof import('./+server')
  let itemRoute: typeof import('./[id]/+server')

  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset implementations and queued answers as well as calls; each route owns its fixture.
    for (const mock of [
      ...Object.values(mcpGatewayService),
      workflowDiscovery.discoverDirectMCPClients,
      redis.execute,
      apiKeyService.store,
      syncAgentClaudeProfiles,
      writeDockerMcpProfileEnv
    ]) mock.mockReset()
    workflowDiscovery.discoverDirectMCPClients.mockResolvedValue([])
    redis.execute.mockResolvedValue([])

    mcpGatewayService.list.mockResolvedValue([])
    mcpGatewayService.get.mockResolvedValue({
      id: 'gw_1',
      name: 'Gateway 1',
      type: 'custom',
      url: 'http://localhost:8080/mcp',
      enabled: true,
      metadata: {}
    })
    // As the real service: create answers the gateway it stored (POST names its id, BL-1411).
    mcpGatewayService.create.mockImplementation(async (_userId: string, gateway: unknown) => gateway)
    mcpGatewayService.update.mockResolvedValue(undefined)
    mcpGatewayService.delete.mockResolvedValue(undefined)

    collectionRoute = await import('./+server')
    itemRoute = await import('./[id]/+server')
  })

  // SA-139 R4 removed the Primary profile sync after a gateway POST, PUT and DELETE, and the two
  // cases that pinned it.

  it('clears stale Docker MCP tools when the selected profile changes', async () => {
    const firstRead = {
      id: 'gw_1',
      name: 'Docker MCP Gateway',
      type: 'docker-catalog',
      url: 'http://localhost:8080/mcp',
      enabled: true,
      discoveredTools: ['mcp-add', 'mcp-find', 'mcp-remove'],
      lastDiscovery: 1780168986795,
      metadata: { dockerProfile: 'default', serverNote: 'before the save' }
    }
    // Another writer's metadata lands after the route's first read. The service applies the
    // merge to THIS stored copy, not the earlier one; unrelated metadata must survive.
    let stored = {
      ...structuredClone(firstRead),
      metadata: { dockerProfile: 'current-profile', serverNote: 'newer stored note' }
    }
    mcpGatewayService.get
      .mockResolvedValueOnce(firstRead)
      .mockImplementation(async () => structuredClone(stored))
    const { assertHumanGatewaySource, humanGatewaySourceRevision } = await import('$lib/server/services/mcpGatewayService')
    const { captureSettingsLifecycle } = await import('$lib/server/services/appActions/settings/lifecycle')
    const expectedGatewaySource = humanGatewaySourceRevision('josh', stored)
    mcpGatewayService.update.mockImplementation(async (_userId, _id, change, _options, human) => {
      assertHumanGatewaySource(_userId, stored, human.expectedGatewaySource,
        captureSettingsLifecycle([`mcp_gateways:${_userId}`]))
      const fields = typeof change === 'function' ? change(structuredClone(stored)) : change
      stored = { ...stored, ...fields }
      human.onSaved({ gateway: structuredClone(stored), sourceRevision: humanGatewaySourceRevision(_userId, stored) })
      return structuredClone(stored)
    })

    const putRequest = new Request('http://localhost/api/mcp/gateways/gw_1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedGatewaySource, metadata: { dockerProfile: 'batshit' } })
    })

    const response = await itemRoute.PUT({
      request: putRequest,
      locals: { user: { id: 'josh' } },
      params: { id: 'gw_1' }
    } as any)

    expect(response.status).toBe(200)
    expect(writeDockerMcpProfileEnv).toHaveBeenCalledWith('batshit')
    expect(mcpGatewayService.update).toHaveBeenCalledTimes(1)
    expect(mcpGatewayService.update.mock.calls[0].slice(0, 2)).toEqual(['josh', 'gw_1'])
    expect(stored.discoveredTools).toEqual([])
    expect(stored.lastDiscovery).toBe(0)
    expect(stored.metadata).toEqual({ dockerProfile: 'batshit', serverNote: 'newer stored note' })
    expect((await response.json()).gateway).toMatchObject({
      discoveredTools: [],
      lastDiscovery: 0,
      metadata: { dockerProfile: 'batshit', serverNote: 'newer stored note' }
    })
    expect(syncAgentClaudeProfiles).not.toHaveBeenCalled()
  })
})
