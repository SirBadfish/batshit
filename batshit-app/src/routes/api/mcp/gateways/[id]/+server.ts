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
  mcpGatewayService,
  type GatewayUpdate
} from '$lib/server/services/mcpGatewayService'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  assertDockerMcpProfileWritable,
  DOCKER_PROFILE_FILE_NOT_FINISHED,
  normalizeDockerMcpProfile,
  runDockerMcpProfileWrite,
  writeDockerMcpProfileEnv
} from '$lib/server/services/dockerGatewayProfileConfig'
import { presentMcpGatewayForBrowser } from '$lib/server/services/mcpGatewayRuntimePresentation'
import {
  moveLegacyN8nInstanceToken,
  N8N_INSTANCE_TOKEN_SERVICE
} from '$lib/server/services/n8nInstanceCredential'

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

    return json({ gateway: presentMcpGatewayForBrowser(gateway) })
  } catch (error) {
    console.error('[API] Error getting gateway:', error)
    return json(
      { error: 'Failed to get gateway' },
      { status: 500 }
    )
  }
}

/**
 * BL-1407: the answer when the token store after a stored gateway write did not confirm. It may
 * have written the key (a lost answer), so it never says the token was not saved. Same text in
 * POST /api/mcp/gateways.
 */
const TOKEN_NOT_CONFIRMED =
  'The gateway settings were saved, but Batshit could not confirm saving the n8n Instance MCP token. Save the token again, or save it in Settings → API Keys.'
const AFTER_SAVE_NOT_FINISHED =
  'The gateway settings were saved, but Batshit could not finish updating the agent profiles or reading the gateway back.'
const AFTER_SAVE_ALSO_NOT_FINISHED =
  'Batshit also could not finish updating the agent profiles or reading the gateway back.'

/**
 * BL-1410 / BL-1411: a 500 after the gateway record write was confirmed says so in fields, not
 * only in its text: `gatewaySaved: true` and the id that write confirmed (the id this route updated). It vouches
 * for the gateway record only; the token store, the profile file or a profile sync the error names
 * may still be unknown. Never a 200, never retried.
 */
function savedButFailed(error: string, gatewayId: string) {
  return json({ error, gatewaySaved: true, gatewayId }, { status: 500 })
}

/** A failure after the stored gateway write: what was saved, and every step that did not finish. */
function afterSaveError(notConfirmed: string[]) {
  return notConfirmed.length === 0
    ? AFTER_SAVE_NOT_FINISHED
    : `${notConfirmed.join(' ')} ${AFTER_SAVE_ALSO_NOT_FINISHED}`
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

  // BL-1371: a conflict is a 409 "nothing was saved" only before the write is stored. BL-1407 /
  // BL-1386: no part of this save and no side effect is stored before it either: every check runs
  // first, and the token store and the Docker profile file follow the stored write. So a 409, 404
  // or 400 means none of this save was stored (the earlier read may still store a normalizing
  // write of the registry, BL-1371). After the write, every failure is a 500 that says the
  // settings were saved and names what could not be finished; nothing written is undone.
  let written = false
  const notConfirmed: string[] = []
  try {
    const updates = await request.json()
    const userId = locals.user.id
    // BL-1371: this earlier read gives only the type and the STDIO clearing below. Nothing written
    // is built from it: the n8n and Docker metadata are merged inside `update`, onto the gateway as
    // stored at its compare-and-set.
    const existing = await mcpGatewayService.get(userId, id)

    // Don't allow changing ID or created_at
    delete updates.id
    delete updates.created_at

    const gatewayType = updates.type ?? existing?.type

    if (gatewayType === 'stdio') {
      updates.url = undefined
      updates.authKeyName = undefined
    }

    // Update timestamp
    updates.updated_at = new Date().toISOString()

    let change: GatewayUpdate = updates
    let sentToken = ''
    let dockerProfile: string | null = null

    if (gatewayType === 'n8n-instance-mcp') {
      const updateMeta = (updates.metadata && typeof updates.metadata === 'object')
        ? updates.metadata
        : {}

      // BL-1397: only a token sent in this body is an explicit save of the canonical key. BL-1407:
      // it is checked now (format and injection: the "Invalid …" 400) and stored only after the
      // gateway write. With no token (or a blank one) the route stores none; the guarded move after
      // the write handles an old copy and never validates it synchronously.
      sentToken = typeof updateMeta.authToken === 'string' ? updateMeta.authToken.trim() : ''
      if (sentToken) apiKeyService.buildStoredDocument(N8N_INSTANCE_TOKEN_SERVICE, sentToken)

      // BL-1407: the gateway write keeps a stored copy. It leaves only through the guarded move,
      // which runs after this save's token store, so a store that fails after the write never
      // costs it. A blank or non-string stored value is no usable token and goes with this write.
      const { authToken: _sentToken, ...sentMeta } = updateMeta as Record<string, any>
      change = (stored) => {
        const storedMeta = (stored.metadata && typeof stored.metadata === 'object') ? stored.metadata : {}
        const metadata: Record<string, any> = { ...storedMeta, ...sentMeta }
        const storedToken = typeof storedMeta.authToken === 'string' ? storedMeta.authToken.trim() : ''
        if (!storedToken) {
          delete metadata.authToken
        }
        return { ...updates, metadata }
      }
    } else if (gatewayType === 'docker-catalog') {
      const updateMeta = (updates.metadata && typeof updates.metadata === 'object')
        ? updates.metadata
        : {}

      const hasProfileUpdate =
        Object.prototype.hasOwnProperty.call(updateMeta, 'dockerProfile') ||
        Object.prototype.hasOwnProperty.call(updateMeta, 'docker_profile')

      if (hasProfileUpdate) {
        dockerProfile = normalizeDockerMcpProfile(
          Object.prototype.hasOwnProperty.call(updateMeta, 'dockerProfile')
            ? updateMeta.dockerProfile
            : updateMeta.docker_profile
        )
        // BL-1386: the containerized refusal now, before the gateway write; the file is written
        // only after the write is stored.
        assertDockerMcpProfileWritable()
      }

      change = (stored) => {
        const storedMeta = (stored.metadata && typeof stored.metadata === 'object') ? stored.metadata : {}
        const metadata: Record<string, any> = { ...storedMeta, ...updateMeta }
        const next: Record<string, any> = { ...updates }
        if (dockerProfile !== null) {
          // A new profile serves other tools: the stored list goes, so the next lookup asks again.
          if (storedMeta.dockerProfile !== dockerProfile) {
            next.discoveredTools = []
            next.lastDiscovery = 0
          }
          metadata.dockerProfile = dockerProfile
        }
        if ('docker_profile' in metadata) {
          delete metadata.docker_profile
        }
        next.metadata = metadata
        return next
      }
    }

    await mcpGatewayService.update(userId, id, change)
    written = true

    if (gatewayType === 'n8n-instance-mcp') {
      if (sentToken) {
        // BL-1407: an explicit save, unconditional (the last explicit save wins). A failure may
        // still have written the key (a lost answer), so it is "not confirmed": never undone and
        // never retried here. The user's next save stores it again.
        try {
          await apiKeyService.store(N8N_INSTANCE_TOKEN_SERVICE, sentToken, userId)
        } catch (error) {
          console.error('[API] n8n Instance MCP token store not confirmed after a stored gateway save', error)
          notConfirmed.push(TOKEN_NOT_CONFIRMED)
        }
      }
      // BL-1397: the guarded move runs after every stored n8n Instance save, whether or not a CLI
      // provider's profile sync runs. It decides from the saved key as it reads it: a readable key
      // (the one just stored, or one saved before) retires the copy; an absent key takes it. A
      // step that keeps the copy or fails is a warning (no value), never this save's error.
      try {
        const { outcome } = await moveLegacyN8nInstanceToken(userId, id)
        if (!['moved', 'retired', 'superseded', 'no_copy'].includes(outcome)) {
          console.warn(`[API] n8n Instance MCP token of gateway ${id} not moved (${outcome})`)
        }
      } catch (error) {
        console.warn('[API] n8n Instance MCP token move failed after a stored gateway save', error)
      }
    }

    if (dockerProfile !== null) {
      // BL-1386: the profile file follows the stored gateway. It is written after the stored write,
      // from the profile as stored when this write runs, one write at a time. Every save that
      // carried a profile writes, the same profile included, so the next such save repairs a
      // failed write. A failure may have written part or all of the file: never undone, never
      // retried here.
      try {
        await runDockerMcpProfileWrite(async () => {
          const stored = await mcpGatewayService.get(userId, id)
          const storedProfile = stored?.type === 'docker-catalog' ? stored.metadata?.dockerProfile : undefined
          if (typeof storedProfile === 'string') await writeDockerMcpProfileEnv(storedProfile)
        })
      } catch (error) {
        console.error('[API] Docker MCP profile file not finished after a stored gateway save', error)
        notConfirmed.push(DOCKER_PROFILE_FILE_NOT_FINISHED)
      }
    }

    await syncAgentCodexProfiles(userId)
    await syncAgentClaudeProfiles(userId)

    // Return updated gateway
    const gateway = await mcpGatewayService.get(userId, id)

    if (notConfirmed.length > 0) {
      return savedButFailed(notConfirmed.join(' '), id)
    }
    return json({ gateway: gateway ? presentMcpGatewayForBrowser(gateway) : gateway })
  } catch (error) {
    console.error('[API] Error updating gateway:', error)

    // The gateway write is stored: none of "nothing was saved", "not found" or "invalid" is true.
    if (written) {
      return savedButFailed(afterSaveError(notConfirmed), id)
    }
    if (error instanceof GatewayRegistryConflictError) {
      return json({ error: error.message }, { status: 409 })
    }
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

  // BL-1371: as in PUT, a 409 only while the delete is not stored.
  let written = false
  try {
    const userId = locals.user.id
    await mcpGatewayService.delete(userId, id)
    written = true
    await syncAgentCodexProfiles(userId)
    await syncAgentClaudeProfiles(userId)

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
