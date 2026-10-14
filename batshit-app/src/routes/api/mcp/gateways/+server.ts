/**
 * MCP Gateways API - List and Create
 *
 * GET  /api/mcp/gateways - List all gateways for user
 * POST /api/mcp/gateways - Create new gateway
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { workflowDiscovery } from '$lib/server/services/workflowDiscovery'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import {
  assertDockerMcpProfileWritable,
  DOCKER_PROFILE_FILE_NOT_FINISHED,
  getActiveDockerMcpProfile,
  normalizeDockerMcpProfile,
  runDockerMcpProfileWrite,
  writeDockerMcpProfileEnv
} from '$lib/server/services/dockerGatewayProfileConfig'
import {
  presentMcpGatewaysForBrowser,
  redactGatewaySecretsForBrowser
} from '$lib/server/services/mcpGatewayRuntimePresentation'
import type { MCPGateway } from '$lib/types/database'
import { logger } from '$lib/utils/logger'

const normalizeWebhookPath = (url?: string): string | undefined => {
  if (!url || typeof url !== 'string') {
    return undefined
  }

  try {
    const parsed = new URL(url)
    let path = parsed.pathname.replace(/\/+$/, '')
    path = path.replace(/^\/+/, '')
    if (!path) return undefined
    if (path.startsWith('webhook/')) {
      path = path.slice('webhook/'.length)
    }
    return path.toLowerCase()
  } catch {
    let trimmed = url.trim().replace(/^https?:\/\//, '')
    trimmed = trimmed.replace(/\/+$/, '')
    trimmed = trimmed.replace(/^\/+/, '')
    if (trimmed.startsWith('webhook/')) {
      trimmed = trimmed.slice('webhook/'.length)
    }
    return trimmed ? trimmed.toLowerCase() : undefined
  }
}

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

    const allGateways = await mcpGatewayService.list(userId)

    const subagents = await redis.execute(async (client) => {
      try {
        const subagentIds = await client.sMembers(`user:${userId}:subagents`)
        if (!subagentIds || subagentIds.length === 0) {
          return []
        }

        const results: Array<Record<string, any>> = []
        for (const id of subagentIds) {
          const data = await client.json.get(`subagent:${id}`)
          if (data) {
            const value = Array.isArray(data) ? data[0] : data
            if (value && typeof value === 'object') {
              results.push(value as Record<string, any>)
            }
          }
        }
        return results
      } catch (error) {
        console.error('[API] Failed to get subagents from Redis:', error)
        return []
      }
    })

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

    const subagentWorkflowNames = (subagents || [])
      .map((subagent) => subagent?.workflowName)
      .filter((name): name is string => Boolean(name))

    const subagentWebhookUrlSet = new Set<string>()
    for (const subagent of subagents || []) {
      const rawUrl = typeof subagent?.webhookUrl === 'string' ? subagent.webhookUrl.trim() :
        typeof subagent?.webhook_url === 'string' ? subagent.webhook_url.trim() : ''
      if (!rawUrl) continue

      const addVariant = (candidate: string) => {
        if (!candidate) return
        subagentWebhookUrlSet.add(candidate)
        const trimmed = candidate.replace(/\/+$/, '')
        subagentWebhookUrlSet.add(trimmed)
        subagentWebhookUrlSet.add(`${trimmed}/`)
      }

      addVariant(rawUrl)

      try {
        const parsed = new URL(rawUrl)
        const origin = `${parsed.protocol}//${parsed.host}`
        const path = parsed.pathname.replace(/\/+$/, '')
        if (path) {
          const cleanedPath = path.replace(/^\/+/, '')
          addVariant(`${origin}/${cleanedPath}`)
          addVariant(`${origin}/webhook/${cleanedPath}`)

          if (cleanedPath.startsWith('webhook/')) {
            const stripped = cleanedPath.replace(/^webhook\//, '')
            addVariant(`${origin}/${stripped}`)
          }
        }
      } catch {
        // ignore invalid URL parsing
      }
    }
    const subagentWebhookUrls = Array.from(subagentWebhookUrlSet)

    const subagentWebhookPaths = new Set<string>()
    for (const candidate of subagentWebhookUrls) {
      const normalizedPath = normalizeWebhookPath(candidate)
      if (normalizedPath) {
        subagentWebhookPaths.add(normalizedPath)
      }
    }

    logger.debug('[API] Subagents for direct MCP detection', (subagents || []).map((subagent) => ({
      id: subagent?.id,
      name: subagent?.displayName || subagent?.name,
      workflowName: subagent?.workflowName,
      webhookUrl: subagent?.webhookUrl || subagent?.webhook_url
    })))

    const synthetic = await workflowDiscovery.discoverDirectMCPClients(
      userId,
      workflowFilters,
      {
        excludeServerUrls: [...gatewayUrls, ...subagentWebhookUrls],
        excludeServerNames: allGateways.map((gateway) => gateway.name).filter((name): name is string => Boolean(name)),
        excludeWorkflowNames: subagentWorkflowNames,
        excludeWebhookUrls: subagentWebhookUrls,
        excludeWebhookPaths: Array.from(subagentWebhookPaths)
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

    return json({ gateways: presentMcpGatewaysForBrowser(merged) })
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
const TOKEN_NOT_CONFIRMED =
  'The gateway settings were saved, but Batshit could not confirm saving the n8n Instance MCP token. Save the token again, or save it in Settings → API Keys.'
const AFTER_SAVE_NOT_FINISHED =
  'The gateway settings were saved, but Batshit could not finish updating the agent profiles.'
const AFTER_SAVE_ALSO_NOT_FINISHED = 'Batshit also could not finish updating the agent profiles.'

/**
 * BL-1410 / BL-1411: a 500 after the gateway record write was confirmed says so in fields, not
 * only in its text: `gatewaySaved: true` and the id that write confirmed (the id `create` answered, never a later read). It vouches
 * for the gateway record only; the token store, the profile file or a profile sync the error names
 * may still be unknown. Never a 200, never retried.
 */
function savedButFailed(error: string, gatewayId: string) {
  return json({ error, gatewaySaved: true, gatewayId }, { status: 500 })
}

/** A failure after the stored create: what was saved, and every step that did not finish. */
function afterSaveError(notConfirmed: string[]) {
  return notConfirmed.length === 0
    ? AFTER_SAVE_NOT_FINISHED
    : `${notConfirmed.join(' ')} ${AFTER_SAVE_ALSO_NOT_FINISHED}`
}

/**
 * POST /api/mcp/gateways
 * Create a new gateway
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  // BL-1407 / BL-1386: as in PUT, every check runs before the create, and the token store and the
  // Docker profile file follow the stored create; after it, every failure is a 500 that says the
  // settings were saved and names what could not be finished. Nothing written is undone.
  let written = false
  let createdId = ''
  const notConfirmed: string[] = []
  try {
    const userId = locals.user.id
    const body = await request.json()

    // Validate required fields
    const requiresUrl = body.type !== 'stdio'
    if (!body.name || !body.type || (requiresUrl && !body.url)) {
      return json(
        { error: requiresUrl ? 'Missing required fields: name, type, url' : 'Missing required fields: name, type' },
        { status: 400 }
      )
    }

    let metadata = body.metadata || {}
    let sentToken = ''
    let writeProfile = false
    if (body.type === 'n8n-instance-mcp') {
      sentToken = typeof metadata?.authToken === 'string' ? metadata.authToken.trim() : ''
      // BL-1407: checked now (the "Invalid …" 400), stored only after the create.
      if (sentToken) {
        apiKeyService.buildStoredDocument('n8n_instance_mcp_token', sentToken)
      }
      if (metadata && typeof metadata === 'object') {
        const { authToken: _ignored, ...rest } = metadata
        metadata = rest
      }
    } else if (body.type === 'docker-catalog') {
      const hasProfile =
        typeof metadata?.dockerProfile === 'string' || typeof metadata?.docker_profile === 'string'
      const rawProfile =
        typeof metadata?.dockerProfile === 'string'
          ? metadata.dockerProfile
          : typeof metadata?.docker_profile === 'string'
            ? metadata.docker_profile
            : getActiveDockerMcpProfile()
      const dockerProfile = normalizeDockerMcpProfile(rawProfile)
      if (hasProfile) {
        // BL-1386: the containerized refusal before the create; the file is written after it.
        assertDockerMcpProfileWritable()
        writeProfile = true
      }
      metadata = {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        dockerProfile
      }
      delete (metadata as Record<string, any>).docker_profile
    }

    // Create gateway with defaults
    const gateway: MCPGateway = {
      id: body.id || crypto.randomUUID(),
      name: body.name,
      type: body.type,
      ...(body.url ? { url: body.url } : {}),
      enabled: body.enabled !== undefined ? body.enabled : true,
      autoStart: body.autoStart,
      ...(body.authKeyName ? { authKeyName: body.authKeyName } : {}),
      ...(body.stdioConfig ? { stdioConfig: body.stdioConfig } : {}),
      discoveredTools: body.discoveredTools || [],
      lastDiscovery: body.lastDiscovery,
      dcmDisplayDefaults: body.dcmDisplayDefaults,
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    createdId = (await mcpGatewayService.create(userId, gateway)).id
    written = true

    if (sentToken) {
      // BL-1407: an explicit save, unconditional. A failure may still have written the key, so it
      // is "not confirmed": never undone, never retried here.
      try {
        await apiKeyService.store('n8n_instance_mcp_token', sentToken, userId)
      } catch (error) {
        console.error('[API] n8n Instance MCP token store not confirmed after a stored gateway create', error)
        notConfirmed.push(TOKEN_NOT_CONFIRMED)
      }
    }
    if (writeProfile) {
      // BL-1386: as in PUT, the profile as stored when this write runs, one write at a time; a
      // failure may have written part or all of the file and is never undone or retried here.
      try {
        await runDockerMcpProfileWrite(async () => {
          const stored = await mcpGatewayService.get(userId, createdId)
          const storedProfile = stored?.type === 'docker-catalog' ? stored.metadata?.dockerProfile : undefined
          if (typeof storedProfile === 'string') await writeDockerMcpProfileEnv(storedProfile)
        })
      } catch (error) {
        console.error('[API] Docker MCP profile file not finished after a stored gateway create', error)
        notConfirmed.push(DOCKER_PROFILE_FILE_NOT_FINISHED)
      }
    }

    await syncAgentCodexProfiles(userId)
    await syncAgentClaudeProfiles(userId)

    if (notConfirmed.length > 0) {
      return savedButFailed(notConfirmed.join(' '), createdId)
    }
    return json({ gateway: redactGatewaySecretsForBrowser(gateway) }, { status: 201 })
  } catch (error) {
    console.error('[API] Error creating gateway:', error)

    // The create is stored: neither "invalid" nor "already exists" is true.
    if (written) {
      return savedButFailed(afterSaveError(notConfirmed), createdId)
    }
    // Handle validation errors
    if (error instanceof Error) {
      if (error.message.includes('Invalid') || error.message.includes('already exists')) {
        return json({ error: error.message }, { status: 400 })
      }
    }

    return json(
      { error: 'Failed to create gateway' },
      { status: 500 }
    )
  }
}
