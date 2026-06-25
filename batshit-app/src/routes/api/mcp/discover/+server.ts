import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { logger } from '$lib/utils/logger'
import { DockerMCPClient, type DockerMCP } from '$lib/server/services/dockerMCPClient'
import { gatewayManager } from '$lib/server/services/dockerGatewayManager'
import { requireUser } from '$lib/server/services/routeSecurity'

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const user = requireUser(locals)
    if (!user.ok) return user.response
    const userId = user.value.id

    // Initialize Docker MCP client
    const dockerMCP = new DockerMCPClient()

    // Get list of available MCPs from Docker MCP Toolkit
    let availableMCPs: DockerMCP[] = []
    try {
      // Try to discover real MCPs if gateway is running
      const status = await gatewayManager.getStatus()
      if (status === 'running') {
        availableMCPs = await dockerMCP.discoverMCPs()
      }
    } catch (err) {
      logger.debug('[/api/mcp/discover] Using default MCP list, gateway not running')
    }

    // If no MCPs discovered or gateway not running, use default list
    if (availableMCPs.length === 0) {
      availableMCPs = await getDefaultMCPs()
    }

    // Get user's active MCPs from Redis
    const activeMCPsKey = `active_mcps:${userId}`
    const activeMCPsList = await redis.smembers(activeMCPsKey) || []

    // Mark which MCPs are currently active
    // Need to ensure each MCP has an id field for the UI
    // Also convert tools to string array for the UI
    const mcps = availableMCPs.map(mcp => ({
      ...mcp,
      id: mcp.name, // Use name as id (DockerMCP doesn't have id field)
      active: activeMCPsList.includes(mcp.name),
      available: true, // Mark as available since it's from the gateway
      // Convert tool objects to string array for UI display
      tools: Array.isArray(mcp.tools)
        ? mcp.tools.map(tool =>
            typeof tool === 'string' ? tool : tool.name || 'unknown'
          )
        : []
    }))

    return json({
      mcps,
      activeMCPs: activeMCPsList,
      totalCount: mcps.length,
      gatewayStatus: await gatewayManager.getStatus()
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    })
  } catch (error) {
    console.error('[/api/mcp/discover] Error:', error)
    return json(
      { error: 'Failed to discover MCPs' },
      { status: 500 }
    )
  }
}

// Default MCP list - fallback when discovery fails
// Returns all 6 known servers (same as gateway provides)
async function getDefaultMCPs() {
  // Known servers from Docker MCP Gateway
  const knownServers = [
    { id: 'github-official', name: 'GitHub Official', toolCount: 96 },
    { id: 'memory', name: 'Memory', toolCount: 9 },
    { id: 'tavily', name: 'Tavily', toolCount: 4 },
    { id: 'duckduckgo', name: 'DuckDuckGo', toolCount: 2 },
    { id: 'youtube_transcript', name: 'YouTube Transcript', toolCount: 2 },
    { id: 'fetch', name: 'Fetch', toolCount: 1 }
  ]

  return knownServers.map(server => ({
    id: server.id,
    name: server.name,
    description: `${server.name} MCP Server (${server.toolCount} tools)`,
    version: '1.0.0',
    available: true,
    tools: [] // Empty until gateway running
  }))
}
