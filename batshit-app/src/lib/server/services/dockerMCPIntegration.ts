/**
 * Docker MCP Integration for Mode 3
 * Uses Vercel AI SDK's native MCP support with StreamableHTTPClientTransport
 * Story 5.15: Docker MCP Toolkit Integration
 * Updated: HTTP Streamable transport (recommended by Vercel, n8n compatible)
 */

import { createMCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DockerMCPClient } from './dockerMCPClient'
import { redis } from '$lib/server/redis'
import {
  buildDockerGatewayHeaders,
  buildDockerGatewayUrl
} from './dockerGatewayConfig'
import { logger } from '$lib/utils/logger'

// Track active MCP clients for cleanup
const activeMCPClients: Map<string, any> = new Map()

/**
 * Load Docker MCP tools for Mode 3 using Vercel's native MCP support
 * @param selectedMCPs - Optional list of selected MCP IDs to filter (from chat bar)
 */
export async function loadDockerMCPsForMode3(
  userId?: string,
  sessionId?: string,
  selectedMCPs?: string[]
): Promise<Record<string, any>> {
  const dockerMCP = new DockerMCPClient()
  const allTools: Record<string, any> = {}

  try {
    // Check if Docker Gateway is available
    const status = await dockerMCP.isDockerAvailable()
    if (!status.available) {
      logger.debug('[Docker MCP] Gateway not available, skipping Docker MCPs')
      return {}
    }

    // Determine which MCPs to load
    // If selectedMCPs is provided (from chat bar), use that as the filter
    // Otherwise, get all active MCPs for the user
    let mcpsToLoad: string[] = []

    if (selectedMCPs && selectedMCPs.length > 0) {
      // User has explicitly selected MCPs in the chat bar
      mcpsToLoad = selectedMCPs
      logger.debug(`[Docker MCP] Using ${mcpsToLoad.length} selected MCPs from chat bar`)
    } else if (userId) {
      // No explicit selection, load all active MCPs for the user
      const activeMCPsKey = `active_mcps:${userId}`
      mcpsToLoad = await redis.smembers(activeMCPsKey)
      logger.debug(`[Docker MCP] Loading ${mcpsToLoad.length} active MCPs for user`)
    }

    if (mcpsToLoad.length === 0) {
      logger.debug('[Docker MCP] No MCPs to load')
      return {}
    }

    // For Docker MCP Gateway, we use HTTP Streamable transport (recommended)
    // The gateway runs on localhost:8080 with /mcp endpoint
    // This transport is:
    // - Recommended by Vercel for production
    // - Compatible with n8n MCP Client nodes
    // - More stable than SSE for our use case
    const gatewayUrl = new URL(buildDockerGatewayUrl('/mcp'))

    // Create MCP client for the Docker Gateway
    // The gateway aggregates all Docker MCPs
    try {
      logger.debug('[Docker MCP] Creating MCP client with StreamableHTTPClientTransport')

      const transport = new StreamableHTTPClientTransport(gatewayUrl, {
        sessionId: sessionId || 'default',
        requestInit: {
          headers: buildDockerGatewayHeaders()
        }
      })

      const mcpClient = await createMCPClient({
        transport
      })

      // Store client for cleanup later
      const clientKey = `${userId}-${sessionId}`
      activeMCPClients.set(clientKey, mcpClient)

      // Get tools from the MCP server
      const tools = await mcpClient.tools()

      if (tools) {
        // The tools() method returns an object with tool definitions
        // that are already compatible with Vercel AI SDK
        Object.assign(allTools, tools)
        logger.debug(`[Docker MCP] Loaded ${Object.keys(tools).length} tools from Docker Gateway`)
      }
    } catch (error) {
      console.error('[Docker MCP] Failed to create MCP client with HTTP Streamable:', error)
      // No fallback - if HTTP Streamable fails, we have a configuration issue
    }

    return allTools
  } catch (error) {
    console.error('[Docker MCP] Error loading Docker MCPs for Mode 3:', error)
    return {}
  }
}

/**
 * Clean up MCP clients when done
 * CRITICAL: Must be called in onFinish callback
 */
export async function cleanupMCPClients(userId?: string, sessionId?: string): Promise<void> {
  const clientKey = `${userId}-${sessionId}`
  const client = activeMCPClients.get(clientKey)

  if (client) {
    try {
      await client.close()
      activeMCPClients.delete(clientKey)
      logger.debug(`[Docker MCP] Cleaned up MCP client for ${clientKey}`)
    } catch (error) {
      console.error('[Docker MCP] Error cleaning up MCP client:', error)
    }
  }
}

/**
 * Clean up all MCP clients (for shutdown)
 */
export async function cleanupAllMCPClients(): Promise<void> {
  for (const [key, client] of activeMCPClients) {
    try {
      await client.close()
      logger.debug(`[Docker MCP] Cleaned up MCP client for ${key}`)
    } catch (error) {
      console.error(`[Docker MCP] Error cleaning up client ${key}:`, error)
    }
  }
  activeMCPClients.clear()
}
