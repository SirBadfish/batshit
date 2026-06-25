import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateMCPClient = vi.fn()
const mockClose = vi.fn()

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    url: URL
    options: Record<string, unknown>

    constructor(url: URL, options: Record<string, unknown>) {
      this.url = url
      this.options = options
    }
  }
}))

vi.mock('../dockerGatewayConfig', () => ({
  buildDockerGatewayUrl: vi.fn(() => 'http://localhost:8080/mcp'),
  buildDockerGatewayHeaders: vi.fn(() => ({ Authorization: 'Bearer test-token' }))
}))

describe('DockerMCPGatewayClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClose.mockResolvedValue(undefined)
  })

  it('filters Docker gateway control tools from discovered profile tools', async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({
        fetch: { description: 'Fetch a URL' },
        obsidian_simple_search: { description: 'Search Obsidian' },
        'code-mode': { description: 'Docker gateway code helper' },
        'mcp-activate-profile': { description: 'Activate a Docker MCP profile' },
        'mcp-create-profile': { description: 'Create a Docker MCP profile' },
        'mcp-config-set': { description: 'Set Docker MCP config' },
        'mcp-discover': { description: 'Discover Docker MCP servers' },
        'mcp-exec': { description: 'Execute a Docker MCP tool' },
        'mcp-find': { description: 'Find Docker MCP servers' },
        'mcp-add': { description: 'Add Docker MCP server' },
        'mcp-remove': { description: 'Remove Docker MCP server' }
      }),
      close: mockClose
    })

    const { DockerMCPGatewayClient } = await import('../dockerMCPGatewayClient')
    const tools = await new DockerMCPGatewayClient().discoverTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'fetch',
      'obsidian_simple_search'
    ])
    expect(mockClose).toHaveBeenCalledTimes(1)
  })
})
