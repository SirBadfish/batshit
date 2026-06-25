import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
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
    listEnabled: mocks.listEnabled
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
    mocks.listEnabled.mockResolvedValue([
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
})
