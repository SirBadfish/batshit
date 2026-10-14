/**
 * MCP Gateway Refresh Tools API
 *
 * POST /api/mcp/gateways/[id]/refresh - Refresh gateway tool discovery
 *
 * Used by the UI refresh button to re-discover tools from a gateway.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import { redactGatewaySecretsForBrowser } from '$lib/server/services/mcpGatewayRuntimePresentation'

/**
 * POST /api/mcp/gateways/[id]/refresh
 * Refresh tool discovery for a gateway
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  // Session auth only
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = params

  if (!id) {
    return json({ error: 'Gateway ID is required' }, { status: 400 })
  }

  try {
    // Get the gateway
    const gateway = await mcpGatewayService.get(userId, id)

    if (!gateway) {
      return json(
        { error: `Gateway with ID ${id} not found` },
        { status: 404 }
      )
    }

    if (!gateway.enabled) {
      return json(
        { error: 'Cannot refresh tools for disabled gateway' },
        { status: 400 }
      )
    }

    // Discover tools using unified discovery service
    const result = await mcpGatewayDiscovery.refreshGateway(userId, id)

    // BL-550: discovery takes seconds, and the user can save a new launch meanwhile, so the result
    // goes into the gateway as it is now, field by field; the launch read above is never written.
    if (!result.success) {
      if (gateway.type === 'stdio') {
        await mcpGatewayService.recordStdioCheckResult(userId, id, {
          lastTestStatus: 'failed',
          lastTestAt: new Date().toISOString(),
          lastError: result.error ?? 'STDIO discovery failed'
        })
      }
      return json(
        { error: result.error || 'Discovery failed' },
        { status: 500 }
      )
    }

    if (gateway.type === 'stdio') {
      await mcpGatewayService.recordStdioCheckResult(userId, id, {
        lastTestStatus: 'passed',
        lastTestAt: new Date().toISOString(),
        lastError: null,
        toolCount: result.tools.length
      })
    }

    // Get updated gateway
    const updatedGateway = await mcpGatewayService.get(userId, id)

    return json({
      success: true,
      tools: result.tools.map(t => t.name),
      gateway: updatedGateway ? redactGatewaySecretsForBrowser(updatedGateway) : updatedGateway
    })
  } catch (error) {
    console.error('[API] Error refreshing gateway tools:', error)

    if (error instanceof Error && error.message.includes('not found')) {
      return json({ error: error.message }, { status: 404 })
    }

    return json(
      { error: 'Failed to refresh gateway tools' },
      { status: 500 }
    )
  }
}
