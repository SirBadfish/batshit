import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  discoverTools: vi.fn(),
  createClient: vi.fn(),
  targetExecute: vi.fn(),
  closeClient: vi.fn()
}))

vi.mock('ai', () => ({
  jsonSchema: (schema: unknown) => schema,
  tool: (config: Record<string, unknown>) => config
}))

vi.mock('../mcpGatewayService', () => ({
  mcpGatewayService: {
    // SA-096 P6: discovery reads the full registry and filters enabled itself,
    // so it can tell a disabled gateway apart from one that no longer exists.
    list: mocks.list
  }
}))

vi.mock('../stdioMCPGatewayClient', () => ({
  stdioMCPGatewayClient: {
    discoverTools: mocks.discoverTools,
    createClient: mocks.createClient
  }
}))

vi.mock('../dockerMCPGatewayClient', () => ({
  dockerMCPGatewayClient: {
    discoverTools: vi.fn()
  }
}))

vi.mock('../n8nMCPGatewayClient', () => ({
  n8nMCPGatewayClient: {
    discoverTools: vi.fn()
  }
}))

vi.mock('../dockerGatewayConfig', () => ({
  buildDockerGatewayHeaders: () => ({}),
  buildDockerGatewayUrl: (path: string) => `http://localhost:8811${path}`
}))

vi.mock('../mcpGatewayPolicy', () => ({
  getBlockedBatshitServerGatewayReason: () => 'blocked',
  isBlockedBatshitServerGatewayUrl: () => false
}))

vi.mock('../runtimeUrlRewrites', () => ({
  rewriteN8nGatewayUrlForRuntime: (url: string) => url
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn()
  }
}))

vi.mock('$lib/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

describe('MCPGatewayDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.closeClient.mockResolvedValue(undefined)
    mocks.targetExecute.mockResolvedValue({ text: 'hello' })
    mocks.discoverTools.mockResolvedValue([
      {
        name: 'read_text_file',
        description: 'Read a text file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          }
        }
      }
    ])
    mocks.createClient.mockResolvedValue({
      client: {
        tools: vi.fn().mockResolvedValue({
          read_text_file: {
            execute: mocks.targetExecute
          }
        }),
        close: mocks.closeClient
      },
      stderrChunks: [],
      toolCallTimeoutMs: 1000
    })
    mocks.list.mockResolvedValue([
      {
        id: 'gw-stdio',
        name: 'Filesystem',
        type: 'stdio',
        enabled: true,
        stdioConfig: {
          command: 'node',
          cwdPolicy: 'project'
        },
        created_at: new Date().toISOString()
      }
    ])
  })

  it('preserves user and project context when executing wrapped STDIO MCP tools', async () => {
    const { mcpGatewayDiscovery } = await import('../mcpGatewayDiscovery')

    const result = await mcpGatewayDiscovery.loadToolsForUser(
      'josh',
      ['gw-stdio'],
      undefined,
      {
        skipFiltering: true,
        projectPath: '/Users/example/batshit'
      }
    )

    expect(mocks.discoverTools).toHaveBeenCalledWith({
      gateway: expect.objectContaining({ id: 'gw-stdio' }),
      userId: 'josh',
      projectPath: '/Users/example/batshit'
    })

    await (result.tools.read_text_file as any).execute({
      path: '/Users/example/batshit/README.md'
    })

    expect(mocks.createClient).toHaveBeenCalledWith({
      gateway: expect.objectContaining({ id: 'gw-stdio' }),
      userId: 'josh',
      projectPath: '/Users/example/batshit'
    })
    expect(mocks.targetExecute).toHaveBeenCalledWith({
      path: '/Users/example/batshit/README.md'
    })
  })

  // SA-096 P6 moved the enabled filter from mcpGatewayService.listEnabled into
  // loadToolsForUser. These pin that the move changed nothing observable.
  it('still ignores a selected gateway that is registered but disabled', async () => {
    mocks.list.mockResolvedValue([
      {
        id: 'gw-stdio',
        name: 'Filesystem',
        type: 'stdio',
        enabled: false,
        stdioConfig: { command: 'node', cwdPolicy: 'project' },
        created_at: new Date().toISOString()
      }
    ])

    const { mcpGatewayDiscovery } = await import('../mcpGatewayDiscovery')
    const result = await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, {
      skipFiltering: true
    })

    expect(mocks.discoverTools).not.toHaveBeenCalled()
    expect(result.tools).toEqual({})
  })

  it('warns when a selected gateway ID is not in the registry at all', async () => {
    const { logger } = await import('$lib/utils/logger')
    const { mcpGatewayDiscovery } = await import('../mcpGatewayDiscovery')

    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio', 'gw-orphan'], undefined, {
      skipFiltering: true
    })

    const warned = (logger.warn as any).mock.calls.some((call: unknown[]) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('gw-orphan'))
    )
    expect(warned).toBe(true)
  })

  it('does not warn when every selected gateway is registered but disabled', async () => {
    const { logger } = await import('$lib/utils/logger')
    mocks.list.mockResolvedValue([
      {
        id: 'gw-stdio',
        name: 'Filesystem',
        type: 'stdio',
        enabled: false,
        stdioConfig: { command: 'node', cwdPolicy: 'project' },
        created_at: new Date().toISOString()
      }
    ])

    const { mcpGatewayDiscovery } = await import('../mcpGatewayDiscovery')
    await mcpGatewayDiscovery.loadToolsForUser('josh', ['gw-stdio'], undefined, {
      skipFiltering: true
    })

    expect(logger.warn as any).not.toHaveBeenCalled()
  })
})
