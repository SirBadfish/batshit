import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateMCPClient = vi.fn()
const mockResolveStdioGatewayProcessConfig = vi.fn()
const transportInstances: Array<{
  config: Record<string, unknown>
  stderr: PassThrough
  close: ReturnType<typeof vi.fn>
}> = []

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: mockCreateMCPClient
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    stderr = new PassThrough()
    // The real transport's close ends the server process (BL-602 closes it after a failed start).
    close = vi.fn().mockResolvedValue(undefined)
    config: Record<string, unknown>

    constructor(config: Record<string, unknown>) {
      this.config = config
      transportInstances.push({ config, stderr: this.stderr, close: this.close })
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
    // A started client closes its own transport; the transport is not closed a second time.
    expect(transportInstances[0]?.close).not.toHaveBeenCalled()
    expect(transportInstances[0]?.config).toMatchObject({
      command: '/usr/bin/node',
      args: ['server.js'],
      cwd: '/tmp/project',
      env: { GITHUB_TOKEN: 'secret' },
      stderr: 'pipe'
    })
  })

  it('keeps an ordinary already-resolved launch exact and closes only its actual client', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    mockCreateMCPClient.mockResolvedValue({ close })
    const { stdioMCPGatewayClient } = await import('../stdioMCPGatewayClient')
    const resolved = { command: '/owned/node', args: ['/owned/server.cjs','literal'], cwd: '/owned', env: {}, startupTimeoutMs: 1000, toolCallTimeoutMs: 2000 }
    const opened = await stdioMCPGatewayClient.createClient({ gateway: { id: 'ordinary', name: 'Ordinary', type: 'stdio', enabled: true,
      created_at: '2026-10-21T00:00:00Z', stdioConfig: { command: 'unused' } }, resolved })
    expect(mockResolveStdioGatewayProcessConfig).not.toHaveBeenCalled()
    expect(transportInstances[0].config).toEqual({ command: resolved.command, args: resolved.args, cwd: resolved.cwd, env: {}, stderr: 'pipe' })
    expect(opened.toolCallTimeoutMs).toBe(2000)
    await opened.client.close(); expect(close).toHaveBeenCalledOnce(); expect(transportInstances[0].close).not.toHaveBeenCalled()
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
    // BL-602: no client started, so the transport itself is closed, which ends its process.
    expect(transportInstances[0]?.close).toHaveBeenCalledTimes(1)
  })
})
