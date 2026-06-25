/**
 * Docker MCP Gateway Client
 *
 * Connects to Docker MCP Gateway for tool discovery.
 * Uses HTTP Streamable transport (production-ready).
 *
 * ⚠️ CRITICAL MCP CLIENT LIFECYCLE PATTERN (TECH-002):
 * - ALWAYS use try/finally around createMCPClient
 * - ALWAYS await mcpClient.close() in finally block
 * - NEVER cache MCP clients (fresh per discovery)
 * - Use StreamableHTTPClientTransport for HTTP endpoints
 *
 * Risk Profile: TECH-002 (High) - Connection leaks will exhaust resources
 * Test Coverage: P0 tests verify proper cleanup on success and error
 *
 * Story 5.22: Refactored from dockerMCPIntegration.ts to use correct lifecycle
 */

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from 'ai'
import type { ToolWithName } from './mcpGatewayTypes'
import {
  buildDockerGatewayHeaders,
  buildDockerGatewayUrl
} from './dockerGatewayConfig'
import { logger } from '$lib/utils/logger'

const extractStreamableEndpointError = (message: string): string => {
  const marker = 'endpoint:'
  const markerIndex = message.indexOf(marker)
  if (markerIndex === -1) return message

  const rawPayload = message.slice(markerIndex + marker.length).trim()
  if (!rawPayload.startsWith('{')) return message

  try {
    const parsed = JSON.parse(rawPayload)
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message
  } catch {
    return message
  }

  return message
}

export interface DockerMCPGatewayHealth {
  available: boolean
  error?: string
  toolCount?: number
}

export class DockerMCPGatewayClient {
  /**
   * Discover tools from Docker MCP Gateway
   *
   * ✅ CORRECT MCP Client Lifecycle Pattern:
   * - Fresh client created per discovery (no caching)
   * - try/finally ensures cleanup happens
   * - await client.close() in finally block
   * - Cleanup happens even on error
   *
   * @returns Array of tool definitions from all Docker MCPs
   */
  async discoverTools(): Promise<ToolWithName[]> {
    let mcpClient: MCPClient | undefined
    const gatewayUrl = buildDockerGatewayUrl('/mcp')

    try {
      logger.debug(`[Docker MCP] Discovering tools from ${gatewayUrl}`)

      // Create HTTP Streamable transport
      // Note: Don't specify sessionId - let the transport handle session management
      const url = new URL(gatewayUrl)
      const baseHeaders = buildDockerGatewayHeaders()
      const authHeader = baseHeaders.Authorization || baseHeaders.authorization
      logger.debug('[DockerMCPGatewayClient] tools() auth header', authHeader ? `${authHeader.slice(0,24)}…` : 'missing')

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: baseHeaders
        }
      })

      // Create fresh MCP client for this discovery
      // ⚠️ CRITICAL: Create new client each time - NO caching!
      mcpClient = await createMCPClient({ transport })

      // Discover tools from the Docker Gateway
      // Gateway aggregates tools from all running Docker MCPs
      const tools = await mcpClient.tools()

      logger.debug(`[Docker MCP] Discovered ${Object.keys(tools).length} tools from Docker Gateway`)

      // Convert tools object to array with names attached (Story 5.23)
      // Tools come as { toolName: CoreTool }, we need to preserve the names
      const entries = Object.entries(tools as Record<string, Tool>)

      // Filter out ALL Docker Dynamic MCP tools.
      // Batshit implements its own Dynamic MCP feature via batshit_server_mcp_find/use tools.
      // Docker's tools are blocked entirely to avoid conflicts and because:
      // - code-mode: Returns JS code instead of data - incompatible with batshit
      // - mcp-activate-profile/create-profile: Mutates the Docker MCP gateway profile outside Batshit's settings model
      // - mcp-config-set: Invalid JSON schema (array without items)
      // - mcp-exec: Invalid JSON schema (array without items)
      // - mcp-find/add/remove: Replaced by batshit's own implementation
      const dynamicMCPTools = new Set([
        'code-mode',      // Docker gateway code helper; conflicts with Batshit-owned execution lanes
        'mcp-activate-profile',
        'mcp-create-profile',
        'mcp-config-set', // Invalid schema
        'mcp-exec',       // Invalid schema
        'mcp-discover',   // Currently exposed as a prompt by Docker; filter defensively if it becomes a tool
        'mcp-find',       // Replaced by batshit_server_mcp_find
        'mcp-add',        // Not needed - users add MCPs in Docker Desktop
        'mcp-remove',     // Not needed - session-scoped anyway
      ])

      const filteredEntries = entries.filter(([name]) => {
        if (dynamicMCPTools.has(name)) {
          logger.debug(`[Docker MCP] Filtering out Dynamic MCP tool: ${name}`)
          return false
        }
        return true
      })

      if (filteredEntries.length < entries.length) {
        logger.debug(`[Docker MCP] Filtered ${entries.length - filteredEntries.length} incompatible tool(s), returning ${filteredEntries.length} tools`)
      }

      return filteredEntries.map(([name, tool]) => ({
        ...tool,
        name // Attach the tool name as a property
      })) as ToolWithName[]
    } catch (error) {
      console.error(`[Docker MCP] Failed to discover tools:`, error)

      // Provide user-friendly error messages
      if (error instanceof Error) {
        const normalizedMessage = extractStreamableEndpointError(error.message)
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Docker Gateway is not available at ${gatewayUrl}. Please start Docker Desktop and ensure the MCP Gateway is running on the configured port.`)
        }
        throw new Error(`Failed to discover Docker MCP tools: ${normalizedMessage}`)
      }
      throw new Error('Failed to discover Docker MCP tools: Unknown error')
    } finally {
      // ✅ MANDATORY: Always close the client, even on error
      // ⚠️ CRITICAL: Must await the close() call!
      if (mcpClient) {
        try {
          await mcpClient.close()
          logger.debug(`[Docker MCP] Closed MCP client`)
        } catch (closeError) {
          console.error(`[Docker MCP] Error closing client:`, closeError)
        }
      }
    }
  }

  /**
   * Health check for Docker MCP Gateway
   *
   * ✅ CORRECT Pattern: Same try/finally pattern as discoverTools
   *
   * @param timeoutMs - Connection timeout in milliseconds
   * @returns Health status with tool count
   */
  async healthCheck(timeoutMs: number = 5000): Promise<DockerMCPGatewayHealth> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const gatewayUrl = buildDockerGatewayUrl('/mcp')

    try {
      // Create AbortController for timeout
      const controller = new AbortController()
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort()
          reject(new Error(`Health check timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      try {
        const requestInit: RequestInit = {
          signal: controller.signal,
          headers: buildDockerGatewayHeaders()
        }

        // Create transport with timeout
        // Note: Don't specify sessionId - let the transport handle session management
        const url = new URL(gatewayUrl)
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: {
            ...requestInit
          }
        })

        // Fresh client for health check
        mcpClient = (await Promise.race([
          createMCPClient({ transport }),
          timeoutPromise
        ])) as MCPClient

        // Try to get tools (proves gateway is responding)
        const tools = await Promise.race([mcpClient.tools(), timeoutPromise])
        const toolCount = Object.keys(tools).length

        return {
          available: true,
          toolCount
        }
      } catch (err) {
        throw err
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Docker Gateway not responding'
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)

      // ✅ MANDATORY: Always close, even on health check
      if (mcpClient) {
        try {
          await Promise.race([
            mcpClient.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 250))
          ])
        } catch (closeError) {
          console.error('[Docker MCP] Error closing health check client:', closeError)
        }
      }
    }
  }

  /**
   * Check if Docker Gateway is running (quick check without MCP client)
   */
  async isGatewayRunning(): Promise<boolean> {
    const gatewayUrl = buildDockerGatewayUrl('/mcp')

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 1000)

      const response = await fetch(gatewayUrl, {
        signal: controller.signal,
        method: 'POST',
        headers: buildDockerGatewayHeaders({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'health-check',
          method: 'ping'
        })
      })

      clearTimeout(timeoutId)
      return response.ok
    } catch {
      return false
    }
  }
}

// Export singleton instance
export const dockerMCPGatewayClient = new DockerMCPGatewayClient()
