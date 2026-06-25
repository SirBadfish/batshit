import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DockerMCPClient, type DockerMCP } from '../dockerMCPClient'

// Provide global fetch mock for all tests
declare global {
  // eslint-disable-next-line no-var
  var fetch: typeof fetch
}

global.fetch = vi.fn()

describe('DockerMCPClient', () => {
  let client: DockerMCPClient

  beforeEach(() => {
    client = new DockerMCPClient()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('isDockerAvailable', () => {
    it('returns available when gateway responds to ping', async () => {
      ;(global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true })
      })

      const status = await client.isDockerAvailable()

      expect(status.available).toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:8080/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' })
        })
      )
    })

    it('returns fallback status when gateway is unreachable', async () => {
      ;(global.fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'))

      const status = await client.isDockerAvailable()

      expect(status.available).toBe(false)
      expect(status.message).toBe('Docker MCP Gateway not accessible')
      expect(status.action).toContain('docker mcp gateway run')
      expect(status.note).toBe('The gateway may still be starting up')
    })
  })

  describe('discoverMCPs', () => {
    it('returns known MCPs when gateway unavailable', async () => {
      vi.spyOn(client, 'isDockerAvailable').mockResolvedValueOnce({ available: false })

      const mcps = await client.discoverMCPs()

      expect(mcps.length).toBeGreaterThan(0)
      const names = mcps.map((mcp) => mcp.name)
      expect(names).toContain('github-official')
      expect(names).toContain('fetch')
    })

    it('uses gateway mapping when available', async () => {
      vi.spyOn(client, 'isDockerAvailable').mockResolvedValueOnce({ available: true })
      vi.spyOn(client as any, 'parseGatewayInfo').mockReturnValue(
        new Map<string, number>([
          ['filesystem', 5],
          ['custom-tools', 2]
        ])
      )

      const mcps = await client.discoverMCPs()

      expect(mcps).toHaveLength(2)
      expect(mcps[0]).toMatchObject({
        name: 'filesystem',
        description: 'filesystem MCP Server (5 tools)'
      })
    })
  })

  describe('loadMCPsAsTools', () => {
    it('converts discovered tools into ToolDefinition map', async () => {
      const mockMCPs: DockerMCP[] = [
        {
          name: 'filesystem',
          version: '1.0.0',
          description: 'Filesystem MCP',
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path']
              }
            }
          ]
        }
      ]

      vi.spyOn(client, 'discoverMCPs').mockResolvedValueOnce(mockMCPs)

      const tools = await client.loadMCPsAsTools()

      expect(tools).toBeInstanceOf(Map)
      expect(tools.size).toBe(1)
      const tool = tools.get('filesystem/read_file')
      expect(tool).toMatchObject({
        id: 'filesystem/read_file',
        type: 'docker-mcp',
        config: {
          mcpServer: 'filesystem',
          mcpTool: 'read_file'
        }
      })
    })
  })

  describe('executeTool', () => {
    it('throws descriptive error when gateway unavailable', async () => {
      vi.spyOn(client, 'isDockerAvailable').mockResolvedValueOnce({ available: false })

      await expect(client.executeTool('filesystem', 'read_file', {})).rejects.toThrow(
        'Docker MCP Gateway is required for secure tool execution'
      )
    })

    it('returns success when gateway executes tool', async () => {
      vi.spyOn(client, 'isDockerAvailable').mockResolvedValueOnce({ available: true })
      vi.spyOn(client as any, 'connectToGateway').mockResolvedValue(undefined)
      vi.spyOn(client as any, 'sendMessage').mockResolvedValue({ output: 'ok' })

      const result = await client.executeTool('filesystem', 'read_file', { path: '/tmp' })

      expect(result.success).toBe(true)
      expect(result.result).toEqual({ output: 'ok' })
      expect(result.source).toBe('docker-mcp')
    })
  })

  describe('getAvailableTools', () => {
    it('returns empty map when gateway unavailable in Mode 3', async () => {
      vi.spyOn(client, 'isDockerAvailable').mockResolvedValueOnce({
        available: false,
        action: 'Start gateway'
      })

      const tools = await client.getAvailableTools('vercel-native')

      expect(tools.dockerMCPs).toBeInstanceOf(Map)
      expect(tools.dockerMCPs.size).toBe(0)
      expect(tools.securityNote).toContain('isolated Docker containers')
    })

    it('returns docker tools when gateway available in Mode 3', async () => {
      vi.spyOn(client, 'isDockerAvailable').mockResolvedValueOnce({ available: true })
      const toolMap = new Map()
      vi.spyOn(client, 'loadMCPsAsTools').mockResolvedValueOnce(toolMap)

      const tools = await client.getAvailableTools('vercel-native')

      expect(tools.securityModel).toBe('docker-isolated')
      expect(tools.dockerMCPs).toBe(toolMap)
    })
  })
})
