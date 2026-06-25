import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from 'ai'

import type { MCPGateway } from '$lib/types/database'
import type { ToolWithName } from './mcpGatewayTypes'
import { resolveStdioGatewayProcessConfig } from './mcpGatewayStdio'
import { logger } from '$lib/utils/logger'

export interface StdioMCPGatewayHealth {
  available: boolean
  error?: string
  toolCount?: number
}

function buildErrorMessage(base: string, stderrChunks: string[]): string {
  const stderr = stderrChunks.join('').trim()
  if (!stderr) return base
  return `${base} (${stderr})`
}

export class StdioMCPGatewayClient {
  private async createTransport(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
  }) {
    const resolved = await resolveStdioGatewayProcessConfig(params)
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      env: resolved.env,
      stderr: 'pipe'
    })

    const stderrChunks: string[] = []
    transport.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    })

    return {
      transport,
      stderrChunks,
      resolved
    }
  }

  async discoverTools(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
  }): Promise<ToolWithName[]> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const { gateway } = params
    const { transport, stderrChunks, resolved } = await this.createTransport(params)

    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`STDIO tool discovery timed out after ${resolved.startupTimeoutMs}ms`)),
          resolved.startupTimeoutMs
        )
      })

      logger.debug(`[STDIO MCP] Discovering tools from ${gateway.name}`)
      mcpClient = (await Promise.race([createMCPClient({ transport: transport as any }), timeout])) as MCPClient
      const tools = (await Promise.race([mcpClient.tools(), timeout])) as Record<string, Tool>

      return Object.entries(tools).map(([name, tool]) => ({
        ...tool,
        name
      })) as ToolWithName[]
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown STDIO discovery error'
      throw new Error(buildErrorMessage(`Failed to discover STDIO MCP tools: ${message}`, stderrChunks))
    } finally {
      if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId)
      if (mcpClient) {
        await mcpClient.close().catch(() => undefined)
      }
    }
  }

  async healthCheck(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
  }): Promise<StdioMCPGatewayHealth> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const { transport, resolved } = await this.createTransport(params)
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`STDIO health check timed out after ${resolved.startupTimeoutMs}ms`)),
          resolved.startupTimeoutMs
        )
      })

      mcpClient = (await Promise.race([createMCPClient({ transport: transport as any }), timeout])) as MCPClient
      const tools = (await Promise.race([mcpClient.tools(), timeout])) as Record<string, Tool>

      return {
        available: true,
        toolCount: Object.keys(tools).length
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'STDIO health check failed'
      }
    } finally {
      if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId)
      if (mcpClient) {
        await mcpClient.close().catch(() => undefined)
      }
    }
  }

  async createClient(params: {
    gateway: MCPGateway
    userId?: string
    projectPath?: string | null
  }): Promise<{
    client: MCPClient
    stderrChunks: string[]
    toolCallTimeoutMs: number
  }> {
    const { transport, stderrChunks, resolved } = await this.createTransport(params)
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`STDIO client startup timed out after ${resolved.startupTimeoutMs}ms`)),
          resolved.startupTimeoutMs
        )
      })

      const client = (await Promise.race([createMCPClient({ transport: transport as any }), timeout])) as MCPClient
      return {
        client,
        stderrChunks,
        toolCallTimeoutMs: resolved.toolCallTimeoutMs
      }
    } finally {
      if (typeof timeoutId !== 'undefined') clearTimeout(timeoutId)
    }
  }
}

export const stdioMCPGatewayClient = new StdioMCPGatewayClient()
