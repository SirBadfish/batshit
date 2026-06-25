import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateMCPClient = vi.fn()
const mockResolveStdioGatewayProcessConfig = vi.fn()
const transportInstances: Array<{ config: Record<string, unknown>; stderr: PassThrough }> = []

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    stderr = new PassThrough()
    config: Record<string, unknown>

    constructor(config: Record<string, unknown>) {
      this.config = config
      transportInstances.push({ config, stderr: this.stderr })
    }
  }
}))

vi.mock('../mcpGatewayStdio', () => ({
  resolveStdioGatewayProcessConfig: mockResolveStdioGatewayProcessConfig
}))

describe('stdioMCPGatewayClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transportInstances.length = 0
    mockResolveStdioGatewayProcessConfig.mockResolvedValue({
      command: '/usr/bin/node',
      args: ['server.js'],
      cwd: '/tmp/project',
      env: { GITHUB_TOKEN: 'secret' },
      startupTimeoutMs: 5000,
      toolCallTimeoutMs: 60000
    })
  })

  it('discovers tools through the stdio transport', async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({
        alpha: { description: 'Alpha tool' },
        beta: { description: 'Beta tool' }
      }),
      close: vi.fn().mockResolvedValue(undefined)
    })

    const { stdioMCPGatewayClient } = await import('../stdioMCPGatewayClient')
    const tools = await stdioMCPGatewayClient.discoverTools({
      gateway: {
        id: 'gw-stdio',
        name: 'Local STDIO',
        type: 'stdio',
        enabled: true,
        stdioConfig: {
          command: 'node'
        },
        created_at: new Date().toISOString()
      }
    })

    expect(tools.map((tool) => tool.name)).toEqual(['alpha', 'beta'])
    expect(transportInstances[0]?.config).toMatchObject({
      command: '/usr/bin/node',
      args: ['server.js'],
      cwd: '/tmp/project',
      env: { GITHUB_TOKEN: 'secret' },
      stderr: 'pipe'
    })
  })

  it('returns a failed health check when the client startup throws', async () => {
    mockCreateMCPClient.mockRejectedValue(new Error('spawn ENOENT'))

    const { stdioMCPGatewayClient } = await import('../stdioMCPGatewayClient')
    const result = await stdioMCPGatewayClient.healthCheck({
      gateway: {
        id: 'gw-stdio',
        name: 'Local STDIO',
        type: 'stdio',
        enabled: true,
        stdioConfig: {
          command: 'node'
        },
        created_at: new Date().toISOString()
      }
    })

    expect(result.available).toBe(false)
    expect(result.error).toContain('spawn ENOENT')
  })
})
