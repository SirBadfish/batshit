/**
 * n8n MCP Gateway Client
 *
 * Connects to n8n MCP Server Trigger workflows for gateway discovery.
 * Uses HTTP Streamable transport (production-ready, n8n compatible).
 *
 * ⚠️ CRITICAL MCP CLIENT LIFECYCLE PATTERN (TECH-002):
 * - ALWAYS use try/finally around createMCPClient
 * - ALWAYS await mcpClient.close() in finally block
 * - NEVER cache MCP clients (fresh per discovery)
 * - Use StreamableHTTPClientTransport for HTTP endpoints
 *
 * Risk Profile: TECH-002 (High) - Connection leaks will exhaust resources
 * Test Coverage: P0 tests verify proper cleanup on success and error
 */

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from 'ai'
import type { ToolWithName } from './mcpGatewayTypes'
import { logger } from '$lib/utils/logger'

export interface N8nMCPGatewayHealth {
  available: boolean
  error?: string
  toolCount?: number
}

export class N8nMCPGatewayClient {
  /**
   * Discover tools from n8n MCP Trigger gateway
   *
   * ✅ CORRECT MCP Client Lifecycle Pattern:
   * - Fresh client created per discovery (no caching)
   * - try/finally ensures cleanup happens
   * - await client.close() in finally block
   * - Cleanup happens even on error
   *
   * @param gatewayUrl - n8n MCP Trigger URL (e.g., http://localhost:5678/mcp/code-tools)
   * @returns Array of tool definitions
   */
  async discoverTools(
    gatewayUrl: string,
    options?: { headers?: Record<string, string>; timeoutMs?: number }
  ): Promise<ToolWithName[]> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const timeoutMs = options?.timeoutMs ?? 10_000

      logger.debug(`[MCP Gateway] Discovering tools from ${gatewayUrl}`)

      // Parse and validate URL
      const url = new URL(gatewayUrl)

      const controller = new AbortController()
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort()
          reject(new Error(`Tool discovery timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })

      const requestInit: RequestInit | undefined =
        controller.signal || options?.headers
          ? {
              signal: controller.signal,
              ...(options?.headers ? { headers: options.headers } : {})
            }
          : undefined

      // Create HTTP Streamable transport (production-ready)
      // Note: Don't specify sessionId - let the transport handle session management.
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit
      })

      // Create fresh MCP client for this discovery
      // ⚠️ CRITICAL: Create new client each time - NO caching!
      mcpClient = (await Promise.race([createMCPClient({ transport }), timeoutPromise])) as MCPClient

      // Discover tools from the n8n MCP workflow
      const tools = await Promise.race([mcpClient.tools(), timeoutPromise])

      logger.debug(`[MCP Gateway] Discovered ${Object.keys(tools).length} tools from ${gatewayUrl}`)

      // Convert tools object to array with names attached (Story 5.23)
      // Tools come as { toolName: CoreTool }, we need to preserve the names
      const entries = Object.entries(tools as Record<string, Tool>)
      return entries.map(([name, tool]) => ({
        ...tool,
        name // Attach the tool name as a property
      })) as ToolWithName[]
    } catch (error) {
      console.error(`[MCP Gateway] Failed to discover tools from ${gatewayUrl}:`, error)
      throw new Error(`Failed to discover tools: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)

      // ✅ MANDATORY: Always close the client, even on error
      // ⚠️ CRITICAL: Must await the close() call!
      if (mcpClient) {
        try {
          await Promise.race([
            mcpClient.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 250))
          ])
          logger.debug(`[MCP Gateway] Closed MCP client for ${gatewayUrl}`)
        } catch (closeError) {
          console.error(`[MCP Gateway] Error closing client for ${gatewayUrl}:`, closeError)
        }
      }
    }
  }

  /**
   * Health check for n8n MCP gateway
   *
   * ✅ CORRECT Pattern: Same try/finally pattern as discoverTools
   *
   * @param gatewayUrl - n8n MCP Trigger URL
   * @param timeoutMs - Connection timeout in milliseconds
   * @returns Health status with tool count
   */
  async healthCheck(gatewayUrl: string, timeoutMs: number = 5000, options?: { headers?: Record<string, string> }): Promise<N8nMCPGatewayHealth> {
    let mcpClient: MCPClient | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      // Parse URL
      const url = new URL(gatewayUrl)

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
          ...(options?.headers ? { headers: options.headers } : {})
        }

        // Create transport with timeout
        // Note: Don't specify sessionId - let the transport handle session management.
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit
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
        error: error instanceof Error ? error.message : 'Connection failed'
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
          console.error('[MCP Gateway] Error closing health check client:', closeError)
        }
      }
    }
  }

  /**
   * Validate gateway URL format
   */
  validateGatewayUrl(url: string): { valid: boolean; error?: string } {
    try {
      const parsedUrl = new URL(url)

      // Must be HTTP or HTTPS
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return {
          valid: false,
          error: 'Gateway URL must use http:// or https:// protocol'
        }
      }

      // Must have a path (MCP endpoint)
      if (parsedUrl.pathname === '' || parsedUrl.pathname === '/') {
        return {
          valid: false,
          error: 'Gateway URL must include MCP endpoint path (e.g., /mcp/code-tools)'
        }
      }

      return { valid: true }
    } catch {
      return {
        valid: false,
        error: 'Invalid URL format'
      }
    }
  }
}

// Export singleton instance
export const n8nMCPGatewayClient = new N8nMCPGatewayClient()
