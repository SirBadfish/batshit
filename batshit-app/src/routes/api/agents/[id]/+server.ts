import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { syncAgentCodexProfiles, deleteAgentCodexConfig } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles, deleteAgentClaudeConfig } from '$lib/server/services/claudeProfileManager'
import { getCodexConfigOverrideValidationError } from '$lib/server/services/codexSettings'
import { getClaudeConfigOverrideValidationError } from '$lib/server/services/claudeSettings'
import {
  canonicalizePrimaryAgentRecord,
  hasLegacyPrimaryAgentFields,
  isApiPrimaryAgentType,
  isCliPrimaryAgentType,
  normalizePrimaryAgentType
} from '$lib/utils/primaryAgentType'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { presentAgentForRuntime } from '$lib/server/services/agentRuntimePresentation'
import { resolveUploadUrlsForBrowserInPayload } from '$lib/server/services/batshitServerUrls'

// GET /api/agents/[id] - Get a specific agent
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const agent = await redis.get(`agent:${params.id}`)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    
    // Verify agent belongs to user
    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (hasLegacyPrimaryAgentFields(agent as Record<string, any>)) {
      const canonicalAgent = canonicalizePrimaryAgentRecord(agent as Record<string, any>)
      await redis.updateAgent(params.id!, canonicalAgent)
      return json(resolveUploadUrlsForBrowserInPayload(presentAgentForRuntime(canonicalAgent)))
    }
    
    return json(resolveUploadUrlsForBrowserInPayload(presentAgentForRuntime(agent as Record<string, any>)))
  } catch (error) {
    console.error('Error getting agent:', error)
    return json({ error: 'Failed to get agent' }, { status: 500 })
  }
}

// PUT /api/agents/[id] - Update an agent
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const updates = await request.json()
    const codexValidationError = getCodexConfigOverrideValidationError(updates.codex_settings ?? null)
    if (codexValidationError) {
      return json({ error: codexValidationError }, { status: 400 })
    }
    const claudeValidationError = getClaudeConfigOverrideValidationError(updates.claude_settings ?? null)
    if (claudeValidationError) {
      return json({ error: claudeValidationError }, { status: 400 })
    }
    
    // Verify agent exists and belongs to user
    const agent = await redis.get(`agent:${params.id}`)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    
    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    const resolvedAgentType = normalizePrimaryAgentType({
      ...(agent as Record<string, any>),
      ...(updates as Record<string, any>)
    })
    const provider = (updates.primary_model_provider ?? agent.primary_model_provider ?? '')
      .toLowerCase()
      .trim()
    const modelName = (updates.primary_model_name ?? agent.primary_model_name ?? '')
      .toLowerCase()
      .trim()
    const connection =
      updates.primary_model_connection ?? agent.primary_model_connection ?? null
    const connectionHint = (connection?.id ?? connection?.service ?? '').toLowerCase()
    const isCodexPreset =
      provider.includes('codex') ||
      modelName.includes('codex') ||
      connectionHint.includes('codex')
    const isClaudeCliPreset =
      provider.includes('claude-cli') ||
      modelName.includes('claude-cli') ||
      connectionHint.includes('claude-cli')
    const isCliPreset = isCodexPreset || isClaudeCliPreset
    const hasModelSelection = Boolean(provider || modelName || connectionHint)

    if (isCliPrimaryAgentType(resolvedAgentType) && hasModelSelection && !isCliPreset) {
      return json(
        { error: 'CLI agents only support CLI model presets.' },
        { status: 400 }
      )
    }

    if ((isApiPrimaryAgentType(resolvedAgentType) || resolvedAgentType === 'n8n') && isCliPreset) {
      return json(
        { error: 'CLI model presets are only available for CLI agents.' },
        { status: 400 }
      )
    }

    const sanitizedUpdates = {
      ...(updates as Record<string, any>),
      ...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_ref')
        ? { avatar_icon_ref: normalizeOptionalIconRefInput(updates.avatar_icon_ref, 'avatar_icon_ref') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_fit')
        ? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(updates.avatar_icon_fit, 'avatar_icon_fit') }
        : {}),
      agentType: resolvedAgentType
    }
    const canonicalUpdates = canonicalizePrimaryAgentRecord(sanitizedUpdates)
    await redis.updateAgent(params.id!, canonicalUpdates)
    try {
      await syncAgentCodexProfiles(locals.user.id)
    } catch (error) {
      console.warn('[Agents API] Failed to sync Codex profiles after update:', error)
    }
    try {
      await syncAgentClaudeProfiles(locals.user.id)
    } catch (error) {
      console.warn('[Agents API] Failed to sync Claude profiles after update:', error)
    }
    return json({ success: true })
  } catch (error) {
    console.error('Error updating agent:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to update agent' },
      { status: (error as any)?.status ?? 500 }
    )
  }
}

// DELETE /api/agents/[id] - Delete an agent
export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = locals.user.id

  try {
    // Verify agent exists and belongs to user
    const agent = await redis.get(`agent:${params.id}`)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    
    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }
    
    await redis.deleteAgent(params.id!)
    await Promise.allSettled([
      (async () => {
        try {
          await syncAgentCodexProfiles(userId)
        } catch (error) {
          console.warn('[Agents API] Failed to sync Codex profiles after delete:', error)
        }
      })(),
      (async () => {
        try {
          await syncAgentClaudeProfiles(userId)
        } catch (error) {
          console.warn('[Agents API] Failed to sync Claude profiles after delete:', error)
        }
      })(),
      (async () => {
        try {
          await deleteAgentCodexConfig(params.id)
        } catch (error) {
          console.warn('[Agents API] Failed to remove Codex config directory:', error)
        }
      })(),
      (async () => {
        try {
          await deleteAgentClaudeConfig(params.id)
        } catch (error) {
          console.warn('[Agents API] Failed to remove Claude config directory:', error)
        }
      })()
    ])
    return json({ success: true })
  } catch (error) {
    console.error('Error deleting agent:', error)
    return json({ error: 'Failed to delete agent' }, { status: 500 })
  }
}
