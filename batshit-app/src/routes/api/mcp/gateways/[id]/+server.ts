import { captureSettingsLifecycle, assertSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import { updateHumanMcpGateway } from '$lib/server/services/mcpGatewaySave'
/**
 * MCP Gateway API - Individual Gateway Operations
 *
 * GET    /api/mcp/gateways/[id] - Get gateway by ID
 * PUT    /api/mcp/gateways/[id] - Update gateway
 * DELETE /api/mcp/gateways/[id] - Delete gateway
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import {
  GatewayRegistryConflictError,
  mcpGatewayService
} from '$lib/server/services/mcpGatewayService'
import { presentMcpGatewayForBrowser } from '$lib/server/services/mcpGatewayRuntimePresentation'


/**
 * GET /api/mcp/gateways/[id]
 * Get a specific gateway by ID
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = params

  if (!id) {
    return json({ error: 'Gateway ID is required' }, { status: 400 })
  }

  try {
    const sourceLifecycle = captureSettingsLifecycle([`mcp_gateways:${locals.user.id}`])
    const gateway = await mcpGatewayService.get(locals.user.id, id)
    assertSettingsLifecycle(sourceLifecycle)

    if (!gateway) {
      return json(
        { error: `Gateway with ID ${id} not found` },
        { status: 404 }
      )
    }

    return json({ gateway: presentMcpGatewayForBrowser(gateway, locals.user.id, sourceLifecycle) })
  } catch (error) {
    console.error('[API] Error getting gateway:', error)
    return json(
      { error: 'Failed to get gateway' },
      { status: 500 }
    )
  }
}

export const PUT: RequestHandler = async ({ request, locals, params }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!params.id) return json({ error: 'Gateway ID is required' }, { status: 400 })
  try {
    const result = await updateHumanMcpGateway(locals.user.id, params.id, await request.json())
    return json(result.body, { status: result.status })
  } catch (error) {
    console.error('[API] Error updating gateway:', error)
    return json({ error: 'Failed to update gateway' }, { status: 500 })
  }
}

/**
 * DELETE /api/mcp/gateways/[id]
 * Delete a gateway
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = params

  if (!id) {
    return json({ error: 'Gateway ID is required' }, { status: 400 })
  }

  // BL-1371: as in PUT, a 409 only while the delete is not stored.
  let written = false
  try {
    const userId = locals.user.id
    await mcpGatewayService.delete(userId, id)
    written = true

    return json({ success: true })
  } catch (error) {
    console.error('[API] Error deleting gateway:', error)

    if (error instanceof GatewayRegistryConflictError && !written) {
      return json({ error: error.message }, { status: 409 })
    }
    if (error instanceof Error && error.message.includes('not found')) {
      return json({ error: error.message }, { status: 404 })
    }

    return json(
      { error: 'Failed to delete gateway' },
      { status: 500 }
    )
  }
}
