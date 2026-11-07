import { captureSettingsLifecycle, assertSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import { createHumanMcpGateway } from '$lib/server/services/mcpGatewaySave'
/**
 * MCP Gateways API - List and Create
 *
 * GET  /api/mcp/gateways - List all gateways for user
 * POST /api/mcp/gateways - Create new gateway
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { workflowDiscovery } from '$lib/server/services/workflowDiscovery'
import { presentMcpGatewaysForBrowser } from '$lib/server/services/mcpGatewayRuntimePresentation'
import type { MCPGateway } from '$lib/types/database'

/**
 * GET /api/mcp/gateways
 * List all gateways for the current user
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const userId = locals.user.id

    // Check for optional filters
    const type = url.searchParams.get('type')
    const enabledOnly = url.searchParams.get('enabled') === 'true'
    const workflowFilters = url.searchParams.getAll('workflowId')

    const sourceLifecycle = captureSettingsLifecycle([`mcp_gateways:${userId}`])
    const allGateways = await mcpGatewayService.list(userId)
    assertSettingsLifecycle(sourceLifecycle)

    const gatewayUrlSet = new Set<string>()
    for (const gateway of allGateways) {
      const url = typeof gateway.url === 'string' ? gateway.url.trim() : ''
      if (!url) continue
      const base = url.replace(/\/+$/, '')
      gatewayUrlSet.add(url)
      gatewayUrlSet.add(base)
      gatewayUrlSet.add(`${base}/`)
    }
    const gatewayUrls = Array.from(gatewayUrlSet)

    const synthetic = await workflowDiscovery.discoverDirectMCPClients(
      userId,
      workflowFilters,
      {
        excludeServerUrls: gatewayUrls,
        excludeServerNames: allGateways.map((gateway) => gateway.name).filter((name): name is string => Boolean(name))
      }
    )

    let gateways: MCPGateway[] = allGateways

    if (type) {
      if (type === 'n8n-mcp-client') {
        const filteredSynthetic = enabledOnly ? synthetic.filter((gateway) => gateway.enabled) : synthetic
        return json({ gateways: filteredSynthetic })
      }

      gateways = gateways.filter((gateway) => gateway.type === type)
    }

    if (enabledOnly) {
      gateways = gateways.filter((gateway) => gateway.enabled)
    }

    const syntheticFiltered = enabledOnly ? synthetic.filter((gateway) => gateway.enabled) : synthetic

    const merged =
      type && type !== 'n8n-mcp-client'
        ? gateways
        : [...gateways, ...syntheticFiltered]

    return json({ gateways: presentMcpGatewaysForBrowser(merged, userId, sourceLifecycle) })
  } catch (error) {
    console.error('[API] Error listing gateways:', error)
    return json(
      { error: 'Failed to list gateways' },
      { status: 500 }
    )
  }
}

/**
 * BL-1407: the answer when the token store after a stored create did not confirm (it may have
 * written the key). Same text in PUT /api/mcp/gateways/[id].
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await createHumanMcpGateway(locals.user.id, await request.json())
    return json(result.body, { status: result.status })
  } catch (error) {
    console.error('[API] Error creating gateway:', error)
    return json({ error: 'Failed to create gateway' }, { status: 500 })
  }
}
