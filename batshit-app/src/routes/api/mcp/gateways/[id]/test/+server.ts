/**
 * MCP Gateway Test Connection API
 *
 * POST /api/mcp/gateways/[id]/test - Test gateway connectivity
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import { sanitizeStdioGatewayConfig } from '$lib/server/services/mcpGatewayStdio'

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

    if (gateway.type === 'stdio') {
      const stdioConfig = sanitizeStdioGatewayConfig(gateway.stdioConfig) ?? { command: '' }
      await mcpGatewayService.update(userId, id, {
        stdioConfig: {
          ...stdioConfig,
          lastTestStatus: healthResult.available ? 'passed' : 'failed',
          lastTestAt: new Date().toISOString(),
          lastError: healthResult.available ? null : healthResult.error ?? 'STDIO health check failed',
          ...(typeof healthResult.toolCount === 'number'
            ? { toolCount: healthResult.toolCount }
            : {})
        }
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
