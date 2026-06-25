/**
 * MCP Gateway API - Individual Gateway Operations
 *
 * GET    /api/mcp/gateways/[id] - Get gateway by ID
 * PUT    /api/mcp/gateways/[id] - Update gateway
 * DELETE /api/mcp/gateways/[id] - Delete gateway
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  normalizeDockerMcpProfile,
  writeDockerMcpProfileEnv
} from '$lib/server/services/dockerGatewayProfileConfig'
import { decorateMcpGatewayForRuntime } from '$lib/server/services/mcpGatewayRuntimePresentation'

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
    const gateway = await mcpGatewayService.get(locals.user.id, id)

    if (!gateway) {
      return json(
        { error: `Gateway with ID ${id} not found` },
        { status: 404 }
      )
    }

    return json({ gateway: decorateMcpGatewayForRuntime(gateway) })
  } catch (error) {
    console.error('[API] Error getting gateway:', error)
    return json(
      { error: 'Failed to get gateway' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/mcp/gateways/[id]
 * Update an existing gateway
 */
export const PUT: RequestHandler = async ({ request, locals, params }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = params

  if (!id) {
    return json({ error: 'Gateway ID is required' }, { status: 400 })
  }

  try {
    const updates = await request.json()
    const userId = locals.user.id
    const existing = await mcpGatewayService.get(userId, id)

    // Don't allow changing ID or created_at
    delete updates.id
    delete updates.created_at

    const gatewayType = updates.type ?? existing?.type

    if (gatewayType === 'stdio') {
      updates.url = undefined
      updates.authKeyName = undefined
    }

    if (gatewayType === 'n8n-instance-mcp') {
      const existingMeta = (existing?.metadata && typeof existing.metadata === 'object')
        ? existing.metadata
        : {}
      const updateMeta = (updates.metadata && typeof updates.metadata === 'object')
        ? updates.metadata
        : {}

      const authToken = typeof updateMeta.authToken === 'string'
        ? updateMeta.authToken.trim()
        : (typeof existingMeta.authToken === 'string' ? existingMeta.authToken.trim() : '')

      if (authToken) {
        await apiKeyService.store('n8n_instance_mcp_token', authToken, userId)
      }

      const mergedMeta = { ...existingMeta, ...updateMeta }
      if ('authToken' in mergedMeta) {
        delete (mergedMeta as Record<string, any>).authToken
      }
      updates.metadata = mergedMeta
    } else if (gatewayType === 'docker-catalog') {
      const existingMeta = (existing?.metadata && typeof existing.metadata === 'object')
        ? existing.metadata
        : {}
      const updateMeta = (updates.metadata && typeof updates.metadata === 'object')
        ? updates.metadata
        : {}

      const hasProfileUpdate =
        Object.prototype.hasOwnProperty.call(updateMeta, 'dockerProfile') ||
        Object.prototype.hasOwnProperty.call(updateMeta, 'docker_profile')

      const mergedMeta = { ...existingMeta, ...updateMeta }
      if (hasProfileUpdate) {
        const dockerProfile = normalizeDockerMcpProfile(
          Object.prototype.hasOwnProperty.call(updateMeta, 'dockerProfile')
            ? updateMeta.dockerProfile
            : updateMeta.docker_profile
        )
        await writeDockerMcpProfileEnv(dockerProfile)
        if (existingMeta.dockerProfile !== dockerProfile) {
          updates.discoveredTools = []
          updates.lastDiscovery = 0
        }
        mergedMeta.dockerProfile = dockerProfile
      }

      if ('docker_profile' in mergedMeta) {
        delete (mergedMeta as Record<string, any>).docker_profile
      }
      updates.metadata = mergedMeta
    }

    // Update timestamp
    updates.updated_at = new Date().toISOString()

    await mcpGatewayService.update(userId, id, updates)
    await syncAgentCodexProfiles(userId)
    await syncAgentClaudeProfiles(userId)

    // Return updated gateway
    const gateway = await mcpGatewayService.get(userId, id)

    return json({ gateway: gateway ? decorateMcpGatewayForRuntime(gateway) : gateway })
  } catch (error) {
    console.error('[API] Error updating gateway:', error)

    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return json({ error: error.message }, { status: 404 })
      }
      if (error.message.includes('Invalid')) {
        return json({ error: error.message }, { status: 400 })
      }
    }

    return json(
      { error: 'Failed to update gateway' },
      { status: 500 }
    )
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

  try {
    const userId = locals.user.id
    await mcpGatewayService.delete(userId, id)
    await syncAgentCodexProfiles(userId)
    await syncAgentClaudeProfiles(userId)

    return json({ success: true })
  } catch (error) {
    console.error('[API] Error deleting gateway:', error)

    if (error instanceof Error && error.message.includes('not found')) {
      return json({ error: error.message }, { status: 404 })
    }

    return json(
      { error: 'Failed to delete gateway' },
      { status: 500 }
    )
  }
}
