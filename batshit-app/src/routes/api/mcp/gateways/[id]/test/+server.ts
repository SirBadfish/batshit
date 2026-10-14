/**
 * MCP Gateway Test Connection API
 *
 * POST /api/mcp/gateways/[id]/test - Test gateway connectivity
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'

/**
 * POST /api/mcp/gateways/[id]/test
 * Test connectivity to a gateway
 */
export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = locals.user.id
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

    // Test connection using unified discovery service
    const healthResult = await mcpGatewayDiscovery.healthCheck(gateway, userId)

    // BL-550: the check takes seconds, and the user can save a new launch meanwhile, so the result
    // goes into the gateway as it is now, field by field; the launch read above is never written.
    if (gateway.type === 'stdio') {
      await mcpGatewayService.recordStdioCheckResult(userId, id, {
        lastTestStatus: healthResult.available ? 'passed' : 'failed',
        lastTestAt: new Date().toISOString(),
        lastError: healthResult.available ? null : healthResult.error ?? 'STDIO health check failed',
        ...(typeof healthResult.toolCount === 'number'
          ? { toolCount: healthResult.toolCount }
          : {})
      })
    }

    return json({
      success: healthResult.available,
      error: healthResult.error,
      gateway: {
        id: gateway.id,
        name: gateway.name,
        type: gateway.type,
        url: gateway.url
      }
    })
  } catch (error) {
    console.error('[API] Error testing gateway:', error)
    return json(
      { error: 'Failed to test gateway connection' },
      { status: 500 }
    )
  }
}
