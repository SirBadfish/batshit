import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { DockerMCPClient } from '$lib/server/services/dockerMCPClient'
import { redis } from '$lib/server/redis'

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    // Check authentication
    if (!locals.user) {
      return apiFailure('Unauthorized', 401)
    }

    const { mcpId } = await request.json()

    if (!mcpId) {
      return json(
        { success: false, error: 'MCP ID required' },
        { status: 400 }
      )
    }

    const dockerMCP = new DockerMCPClient()

    // Check if Docker and gateway are available
    const status = await dockerMCP.isDockerAvailable()

    if (!status.available) {
      return json(
        {
          success: false,
          error: status.message || 'Docker MCP Gateway not available',
          action: status.action,
          note: status.note
        },
        { status: 503 }
      )
    }

    // Get the MCPs to find this one's details
    const mcps = await dockerMCP.discoverMCPs()
    const targetMCP = mcps.find(mcp =>
      mcp.name === mcpId ||
      mcp.name.includes(mcpId) ||
      mcpId.includes(mcp.name)
    )

    if (!targetMCP) {
      return json(
        {
          success: false,
          error: `MCP '${mcpId}' not found in Docker MCP Toolkit`,
          note: 'Ensure the MCP is installed via docker mcp server enable <mcp-name>'
        },
        { status: 404 }
      )
    }

    // Mark the MCP as active in Redis
    const activeMCPsKey = `active_mcps:${locals.user.id}`
    await redis.sadd(activeMCPsKey, mcpId)

    return json({
      success: true,
      message: `Connected to ${targetMCP.name}`,
      status: 'connected',
      tools: targetMCP.tools,
      mcpDetails: {
        name: targetMCP.name,
        version: targetMCP.version,
        description: targetMCP.description,
        toolCount: targetMCP.tools.length
      }
    })
  } catch (error) {
    console.error('[/api/mcp/connect] Error:', error)
    return json(
      { success: false, error: 'Failed to connect to MCP' },
      { status: 500 }
    )
  }
}