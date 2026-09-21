/**
 * The saved copy of each tool server's tool list, wired through gateway discovery (2026-09-18).
 *
 * Josh's rule: keep a copy until the tool settings change. These pin that every caller shares
 * one copy per gateway, that the copy never widens what an agent may see (gateway scope before
 * it, tool filtering after it), that a new token or project folder is a fresh lookup, that a
 * failure is remembered briefly and still reported, and that Refresh asks now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listEnabled: vi.fn(),
  get: vi.fn(),
  updateDiscoveredTools: vi.fn(),
  stdioDiscover: vi.fn(),
  stdioCreateClient: vi.fn(),
  httpDiscover: vi.fn(),
  dockerDiscover: vi.fn(),
  resolveStdio: vi.fn(),
  retrieveKey: vi.fn()
}))

vi.mock('ai', () => ({
  jsonSchema: (schema: unknown) => schema,
  tool: (config: Record<string, unknown>) => config
}))

vi.mock('../mcpGatewayService', () => ({
  mcpGatewayService: {
    list: mocks.list,
    listEnabled: mocks.listEnabled,
    get: mocks.get,
    updateDiscoveredTools: mocks.updateDiscoveredTools
  }
}))

vi.mock('../stdioMCPGatewayClient', () => ({
  stdioMCPGatewayClient: {
    discoverTools: mocks.stdioDiscover,
    createClient: mocks.stdioCreateClient
  }
}))

vi.mock('../n8nMCPGatewayClient', () => ({
  n8nMCPGatewayClient: { discoverTools: mocks.httpDiscover }
}))

vi.mock('../dockerMCPGatewayClient', () => ({
  dockerMCPGatewayClient: { discoverTools: mocks.dockerDiscover }
}))

vi.mock('../dockerGatewayConfig', () => ({
  buildDockerGatewayHeaders: () => ({ Authorization: 'Bearer docker-gateway-secret' }),
  buildDockerGatewayUrl: (path: string) => `http://localhost:8811${path}`
}))

vi.mock('../mcpGatewayPolicy', () => ({
  getBlockedBatshitServerGatewayReason: () => 'blocked',
  isBlockedBatshitServerGatewayUrl: () => false
}))

vi.mock('../runtimeUrlRewrites', () => ({
  rewriteN8nGatewayUrlForRuntime: (gateway: unknown) => gateway
}))

vi.mock('../mcpGatewayStdio', () => ({
  resolveStdioGatewayProcessConfig: mocks.resolveStdio
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: { retrieve: mocks.retrieveKey }
}))

vi.mock('$lib/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { mcpGatewayDiscovery } from '../mcpGatewayDiscovery'
import { mcpToolListCache } from '../mcpToolListCache'

const CREATED = '2026-09-01T00:00:00.000Z'

const STDIO = {
  id: 'gw-stdio',
  name: 'Filesystem STDIO',
  type: 'stdio',
  enabled: true,
  stdioConfig: { command: 'npx', cwdPolicy: 'project' },
  created_at: CREATED
}
const N8N = {
  id: 'gw-n8n',
  name: 'n8n Instance MCP',
  type: 'n8n-instance-mcp',
  url: 'http://127.0.0.1:5678/mcp-server/http',
  enabled: true,
  created_at: CREATED
}
const DOCKER = {
  id: 'gw-docker',
  name: 'Docker MCP',
  type: 'docker-catalog',
  enabled: true,
  metadata: { dockerProfile: 'default' },
  created_at: CREATED
}
const ALL_IDS = [STDIO.id, N8N.id, DOCKER.id]

function tools(...names: string[]) {
  return names.map((name) => ({
    name,
    description: `${name} tool`,
    inputSchema: { jsonSchema: { type: 'object', properties: {} } }
  }))
}

let n8nToken = 'n8n-token-one'

beforeEach(() => {
  vi.clearAllMocks()
  mcpToolListCache.clearAll()
  n8nToken = 'n8n-token-one'
  mocks.list.mockResolvedValue([STDIO, N8N, DOCKER])
  mocks.listEnabled.mockResolvedValue([STDIO, N8N, DOCKER])
  mocks.get.mockImplementation(async (_userId: string, id: string) =>
    [STDIO, N8N, DOCKER].find((gateway) => gateway.id === id) ?? null
  )
  mocks.retrieveKey.mockImplementation(async (name: string) =>
    name === 'n8n_instance_mcp_token' ? n8nToken : null
  )
  mocks.resolveStdio.mockImplementation(async ({ gateway, projectPath }: any) => ({
    command: `/usr/local/bin/${gateway.stdioConfig.command}`,
    args: gateway.stdioConfig.args ?? [],
    cwd: gateway.stdioConfig.cwdPolicy === 'project' ? projectPath ?? '/Users/example/default' : undefined,
    env: {},
    startupTimeoutMs: 10_000,
    toolCallTimeoutMs: 60_000
  }))
  mocks.stdioDiscover.mockResolvedValue(tools('read_file', 'write_file'))
  mocks.httpDiscover.mockResolvedValue(tools('search_workflows', 'execute_workflow'))
  mocks.dockerDiscover.mockResolvedValue(tools('fetch', 'duckduckgo_search'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('saved tool lists in gateway discovery', () => {
  it('asks each tool server once for two sends in a row', async () => {
    const first = await mcpGatewayDiscovery.loadToolsForUser('josh', ALL_IDS, undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/hello'
    })
    const second = await mcpGatewayDiscovery.loadToolsForUser('josh', ALL_IDS, undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/hello'
    })

    expect(mocks.stdioDiscover).toHaveBeenCalledTimes(1)
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)
    expect(mocks.dockerDiscover).toHaveBeenCalledTimes(1)
    expect(Object.keys(second.tools).sort()).toEqual(Object.keys(first.tools).sort())
    expect(Object.keys(second.tools)).toHaveLength(6)
    expect(second.metadata.get('search_workflows')).toMatchObject({ gatewayId: 'gw-n8n', gatewayType: 'n8n-instance-mcp' })
  })

  it('never widens what an agent may see: gateway scope comes before the copy, tool filtering after it', async () => {
    await mcpGatewayDiscovery.loadToolsForUser('josh', ALL_IDS, undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/hello'
    })

    const n8nOnly = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, {
      skipFiltering: true
    })
    expect(Object.keys(n8nOnly.tools).sort()).toEqual(['execute_workflow', 'search_workflows'])

    const oneTool = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], ['search_workflows'])
    expect(Object.keys(oneTool.tools)).toEqual(['search_workflows'])

    const noneSelected = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'])
    expect(Object.keys(noneSelected.tools)).toEqual([])

    const noGateways = await mcpGatewayDiscovery.loadToolsForUser('josh', [], undefined, { skipFiltering: true })
    expect(Object.keys(noGateways.tools)).toEqual([])

    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)
  })

  it('asks again when the saved token changes, and hands the copy only a fingerprint of it', async () => {
    const readSpy = vi.spyOn(mcpToolListCache, 'read')

    await mcpGatewayDiscovery.loadToolsForUser('josh', ALL_IDS, undefined, { skipFiltering: true })
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)

    n8nToken = 'n8n-token-two'
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(2)
    expect(mocks.httpDiscover).toHaveBeenLastCalledWith(N8N.url, {
      headers: { Authorization: 'Bearer n8n-token-two' }
    })

    const keys = JSON.stringify(readSpy.mock.calls.map(([key]) => key))
    expect(keys).toContain('gw-docker')
    expect(keys).not.toContain('n8n-token-one')
    expect(keys).not.toContain('n8n-token-two')
    expect(keys).not.toContain('docker-gateway-secret')
    readSpy.mockRestore()
  })

  it("asks again when a STDIO server's saved key changes, and hands the copy only a fingerprint of it", async () => {
    let secret = 'fs-secret-one'
    mocks.resolveStdio.mockImplementation(async ({ gateway }: any) => ({
      command: `/usr/local/bin/${gateway.stdioConfig.command}`,
      args: [],
      cwd: undefined,
      env: { FS_TOKEN: secret },
      startupTimeoutMs: 10_000,
      toolCallTimeoutMs: 60_000
    }))
    const readSpy = vi.spyOn(mcpToolListCache, 'read')
    const load = () => mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, { skipFiltering: true })

    await load()
    await load()
    expect(mocks.stdioDiscover).toHaveBeenCalledTimes(1)
    secret = 'fs-secret-two'
    await load()
    expect(mocks.stdioDiscover).toHaveBeenCalledTimes(2)

    const keys = JSON.stringify(readSpy.mock.calls.map(([key]) => key))
    expect(keys).toContain('FS_TOKEN')
    expect(keys).not.toContain('fs-secret-one')
    expect(keys).not.toContain('fs-secret-two')
    readSpy.mockRestore()
  })

  it('asks the Docker gateway again when its profile changes, even without the gateway service clearing it', async () => {
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-docker'], undefined, { skipFiltering: true })
    mocks.list.mockResolvedValue([{ ...DOCKER, metadata: { dockerProfile: 'work' } }])
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-docker'], undefined, { skipFiltering: true })
    expect(mocks.dockerDiscover).toHaveBeenCalledTimes(2)
  })

  it('keeps one STDIO copy per project folder when the server runs in the project', async () => {
    const load = (projectPath: string) =>
      mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, { skipFiltering: true, projectPath })

    await load('/Users/example/hello')
    await load('/Users/example/hello')
    await load('/Users/example/other-project')
    expect(mocks.stdioDiscover).toHaveBeenCalledTimes(2)
    expect(mocks.stdioDiscover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectPath: '/Users/example/other-project',
        resolved: expect.objectContaining({ cwd: '/Users/example/other-project' })
      })
    )
  })

  it('shares one STDIO copy across projects when the server does not run in the project', async () => {
    const fixed = { ...STDIO, stdioConfig: { command: 'npx', cwdPolicy: 'none' } }
    mocks.list.mockResolvedValue([fixed])
    const load = (projectPath: string) =>
      mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, { skipFiltering: true, projectPath })

    await load('/Users/example/hello')
    await load('/Users/example/other-project')
    expect(mocks.stdioDiscover).toHaveBeenCalledTimes(1)
  })

  it('a tool from a saved copy still runs in the project of the send that uses it', async () => {
    const fixed = { ...STDIO, stdioConfig: { command: 'npx', cwdPolicy: 'none' } }
    mocks.list.mockResolvedValue([fixed])
    const execute = vi.fn().mockResolvedValue({ ok: true })
    mocks.stdioCreateClient.mockResolvedValue({
      client: { tools: vi.fn().mockResolvedValue({ read_file: { execute } }), close: vi.fn() },
      stderrChunks: [],
      toolCallTimeoutMs: 1000
    })

    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/hello'
    })
    const later = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/other-project'
    })
    expect(mocks.stdioDiscover).toHaveBeenCalledTimes(1)

    await (later.tools.read_file as any).execute({ path: 'README.md' })
    expect(mocks.stdioCreateClient).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'josh', projectPath: '/Users/example/other-project' })
    )
  })

  it("takes the gateway's name and groups from the record of THIS call, not from the copy", async () => {
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })

    mocks.list.mockResolvedValue([
      { ...N8N, name: 'Renamed n8n', toolGroupings: [{ mcpName: 'Workflows', toolIds: ['search_workflows'] }] }
    ])
    const later = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })

    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)
    expect(later.metadata.get('search_workflows')).toMatchObject({
      gatewayName: 'Renamed n8n',
      mcpServerName: 'Workflows'
    })
  })

  it('remembers a failed lookup for thirty seconds, and still reports it as a failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'))
    mocks.httpDiscover.mockRejectedValue(new Error('Failed to discover tools: Unauthorized'))

    const first = await mcpGatewayDiscovery.discoverFromGateway(N8N as any, 'josh')
    expect(first).toMatchObject({ success: false, error: 'Failed to discover tools: Unauthorized', tools: [] })

    vi.setSystemTime(new Date('2026-09-18T10:00:29.000Z'))
    const second = await mcpGatewayDiscovery.discoverFromGateway(N8N as any, 'josh')
    expect(second).toMatchObject({ success: false, error: 'Failed to discover tools: Unauthorized', tools: [] })
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)

    const inSend = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })
    expect(inSend.tools).toEqual({})
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-09-18T10:00:31.000Z'))
    mocks.httpDiscover.mockResolvedValue(tools('search_workflows'))
    const third = await mcpGatewayDiscovery.discoverFromGateway(N8N as any, 'josh')
    expect(third.success).toBe(true)
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(2)
  })

  it('keeps a good list for five minutes, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'))

    await mcpGatewayDiscovery.discoverFromGateway(DOCKER as any, 'josh')
    vi.setSystemTime(new Date('2026-09-18T10:04:59.000Z'))
    await mcpGatewayDiscovery.discoverFromGateway(DOCKER as any, 'josh')
    expect(mocks.dockerDiscover).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-09-18T10:05:01.000Z'))
    await mcpGatewayDiscovery.discoverFromGateway(DOCKER as any, 'josh')
    expect(mocks.dockerDiscover).toHaveBeenCalledTimes(2)
  })

  it('the Refresh button asks now, and its answer is what the next send uses', async () => {
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })

    mocks.httpDiscover.mockResolvedValue(tools('search_workflows', 'execute_workflow', 'new_workflow'))
    const refreshed = await mcpGatewayDiscovery.refreshGateway('josh', 'gw-n8n')
    expect(refreshed.success).toBe(true)
    expect(refreshed.tools.map((entry) => entry.name)).toContain('new_workflow')
    expect(mocks.updateDiscoveredTools).toHaveBeenCalledWith('josh', 'gw-n8n', [
      'search_workflows',
      'execute_workflow',
      'new_workflow'
    ])

    const next = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-n8n'], undefined, { skipFiltering: true })
    expect(Object.keys(next.tools)).toContain('new_workflow')
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(2)
  })

  it('the per-gateway tool list and the CLI gateway tool map share the copy a send made', async () => {
    await mcpGatewayDiscovery.loadToolsForUser('josh', ALL_IDS, undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/hello'
    })

    const picker = await mcpGatewayDiscovery.discoverFromGateway(N8N as any, 'josh')
    expect(picker.tools.map((entry) => entry.name)).toEqual(['search_workflows', 'execute_workflow'])

    const toolMap = await mcpGatewayDiscovery.buildGatewayToolMap({
      userId: 'josh',
      selectedGatewayIds: ['gw-n8n', 'gw-docker'],
      toolSelections: ['search_workflows', 'fetch']
    })
    expect(toolMap).toEqual({ 'gw-n8n': ['search_workflows'], 'gw-docker': ['fetch'] })

    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)
    expect(mocks.dockerDiscover).toHaveBeenCalledTimes(1)
  })

  it('two lookups of one gateway that start together make one call', async () => {
    const releases: Array<() => void> = []
    mocks.httpDiscover.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(tools('search_workflows'))))
    )

    const both = Promise.all([
      mcpGatewayDiscovery.discoverFromGateway(N8N as any, 'josh'),
      mcpGatewayDiscovery.discoverFromGateway(N8N as any, 'josh')
    ])
    await vi.waitFor(() => expect(mocks.httpDiscover).toHaveBeenCalled())
    // Let both callers reach the lookup before it answers.
    await new Promise((resolve) => setTimeout(resolve, 20))
    releases.forEach((release) => release())
    const [a, b] = await both
    expect(a.tools.map((entry) => entry.name)).toEqual(['search_workflows'])
    expect(b.tools.map((entry) => entry.name)).toEqual(['search_workflows'])
    expect(mocks.httpDiscover).toHaveBeenCalledTimes(1)
  })

  it('builds n8n MCP client placeholders from the record every time (nothing to look up, nothing saved)', async () => {
    const client = {
      id: 'gw-client',
      name: 'n8n client',
      type: 'n8n-mcp-client',
      enabled: true,
      metadata: { toolNames: ['first'] },
      created_at: CREATED
    }
    const first = await mcpGatewayDiscovery.discoverFromGateway(client as any, 'josh')
    const second = await mcpGatewayDiscovery.discoverFromGateway(
      { ...client, metadata: { toolNames: ['first', 'second'] } } as any,
      'josh'
    )
    expect(first.tools.map((entry) => entry.name)).toEqual(['first'])
    expect(second.tools.map((entry) => entry.name)).toEqual(['first', 'second'])
  })

  it('asks every time when there is no user to keep a copy for', async () => {
    await mcpGatewayDiscovery.discoverFromGateway(DOCKER as any)
    await mcpGatewayDiscovery.discoverFromGateway(DOCKER as any)
    expect(mocks.dockerDiscover).toHaveBeenCalledTimes(2)
  })
})
