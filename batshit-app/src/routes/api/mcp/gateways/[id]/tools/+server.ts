/**
 * MCP Gateway Tools API
 *
 * GET /api/mcp/gateways/[id]/tools - Get tools with full details for a gateway
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { mcpGatewayDiscovery } from '$lib/server/services/mcpGatewayDiscovery'
import { workflowDiscovery } from '$lib/server/services/workflowDiscovery'
import { logger } from '$lib/utils/logger'
import { shouldHideInternalMcpTool } from '$lib/server/services/nativeToolConstants'
import type { IconRef } from '$lib/icons/iconTypes'
import type { MCPGateway } from '$lib/types/database'

export interface MCPToolsResponse {
	gatewayId: string
	gatewayName: string
	stale?: boolean
	unavailable?: boolean
	error?: string
	suggestion?: string
	mcps: {
		id: string
		name: string
		icon_ref?: IconRef | null
		tools: {
			id: string
			name: string
			description?: string
			mcpName?: string
		}[]
	}[]
}

function buildToolsResponse(
	gateway: MCPGateway,
	tools: unknown[],
	includeInternalTools: boolean,
	options: { stale?: boolean; unavailable?: boolean; error?: string; suggestion?: string } = {}
): MCPToolsResponse {
	const UNGROUPED_GROUP_LABEL = 'Ungrouped Tools'
	const manualGroupings = gateway.toolGroupings || []

	const resolveGrouping = (toolId: string) => {
		if (!manualGroupings.length) return null
		return manualGroupings.find(group => group.toolIds?.includes(toolId)) ?? null
	}

	const mcpMap = new Map<
		string,
		{
			id: string
			name: string
			icon_ref?: IconRef | null
			tools: { id: string; name: string; description?: string; mcpName?: string }[]
		}
	>()

	for (const tool of tools) {
		try {
			const toolName =
				typeof tool === 'string'
					? tool
					: tool && typeof tool === 'object' && 'name' in tool
						? String((tool as { name?: unknown }).name || 'unknown')
						: 'unknown'

			if (!includeInternalTools && shouldHideInternalMcpTool(toolName)) {
				continue
			}

			const grouping = resolveGrouping(toolName)
			const mcpName: string = grouping?.mcpName || UNGROUPED_GROUP_LABEL

			if (!mcpMap.has(mcpName)) {
				mcpMap.set(mcpName, {
					id: mcpName.toLowerCase().replace(/\s+/g, '-'),
					name: mcpName,
					...(grouping?.icon_ref ? { icon_ref: grouping.icon_ref } : {}),
					tools: []
				})
			}

			const mcp = mcpMap.get(mcpName)!
			const description =
				tool && typeof tool === 'object' && 'description' in tool
					? String((tool as { description?: unknown }).description || '')
					: ''

			mcp.tools.push({
				id: toolName,
				name: toolName,
				description,
				mcpName
			})
		} catch (toolError) {
			console.error('[API] Error processing tool:', tool, toolError)
			continue
		}
	}

	return {
		gatewayId: gateway.id,
		gatewayName: gateway.name,
		...options,
		mcps: Array.from(mcpMap.values()).filter((group) => group.tools.length > 0)
	}
}

/**
 * GET /api/mcp/gateways/[id]/tools
 * Get full tool details for a gateway, grouped by MCP
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user?.id) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const userId = locals.user.id
	const { id } = params

	if (!id) {
		return json({ error: 'Gateway ID is required' }, { status: 400 })
	}

	try {
                const includeInternalTools = url.searchParams.get('includeInternal') === 'true'

		// Get the gateway
                let gateway = await mcpGatewayService.get(userId, id)
                let synthetic = false

                if (!gateway) {
                        const syntheticGateways = await workflowDiscovery.discoverDirectMCPClients(userId)
                        gateway = syntheticGateways.find((entry) => entry.id === id) || null
                        synthetic = Boolean(gateway)
                }

                if (!gateway) {
                        console.error(`[API] Gateway not found: ${id}`)
                        return json({ error: `Gateway with ID ${id} not found` }, { status: 404 })
                }

                if (!synthetic && !gateway.enabled) {
                        console.error(`[API] Gateway disabled: ${id}`)
                        return json({ error: 'Gateway is disabled' }, { status: 400 })
                }

                // Discover tools
                logger.debug(`[API] Discovering tools for gateway: ${id}`)
		const result = await mcpGatewayDiscovery.discoverFromGateway(gateway, userId)

		if (!result.success) {
			console.error(`[API] Tool discovery failed for gateway ${id}:`, result.error)

			// Return more helpful error message based on error type
			const errorMessage = result.error || 'Failed to discover tools'
			const isConnectionError = errorMessage.includes('not available') || errorMessage.includes('ECONNREFUSED')
			const cachedToolNames = Array.isArray(gateway.discoveredTools)
				? gateway.discoveredTools.filter((toolName): toolName is string => typeof toolName === 'string' && toolName.trim().length > 0)
				: []

			if (cachedToolNames.length > 0) {
				return json(
					buildToolsResponse(gateway, cachedToolNames, includeInternalTools, {
						stale: true,
						error: errorMessage,
						suggestion: 'Showing the last discovered tools. Refresh after the gateway is available again.'
					})
				)
			}

			return json(
				buildToolsResponse(gateway, [], includeInternalTools, {
					stale: true,
					unavailable: true,
					error: errorMessage,
					suggestion: isConnectionError
						? 'Start the gateway or check gateway settings.'
						: 'Check gateway configuration and refresh when the backing service is available.'
				})
			)
		}

		logger.debug(`[API] Discovered ${result.tools.length} tools for gateway ${id}`)

		return json(buildToolsResponse(gateway, result.tools, includeInternalTools))
	} catch (error) {
		console.error('[API] Error getting gateway tools:', error)
		return json({ error: 'Failed to get gateway tools' }, { status: 500 })
	}
}
