import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager'
import { getCodexConfigOverrideValidationError } from '$lib/server/services/codexSettings'
import { getClaudeConfigOverrideValidationError } from '$lib/server/services/claudeSettings'
import { sanitizeId } from '$lib/utils/idSanitizer' // Story 6.9c
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { presentAgentForRuntime } from '$lib/server/services/agentRuntimePresentation'

// GET /api/agents - List all agents for the current user
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const agents = (await redis.getAgents(locals.user.id)).map((agent) =>
      presentAgentForRuntime(agent as Record<string, any>)
    )
    return json({ agents })
  } catch (error) {
    console.error('Error getting agents:', error)
    return json({ error: 'Failed to get agents' }, { status: 500 })
  }
}

// POST /api/agents - Create a new agent
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const body = await request.json()
    const codexValidationError = getCodexConfigOverrideValidationError(body.codex_settings ?? null)
    if (codexValidationError) {
      return json({ error: codexValidationError }, { status: 400 })
    }
    const claudeValidationError = getClaudeConfigOverrideValidationError(body.claude_settings ?? null)
    if (claudeValidationError) {
      return json({ error: claudeValidationError }, { status: 400 })
    }

    // Story 6.9c: Use provided ID or generate from displayName
    const agentId = body.id?.trim() || sanitizeId(body.displayName)

    // Story 6.9c: Check for ID collision
    const exists = await redis.exists(`agent:${agentId}`)
    if (exists) {
      return json({
        error: `Agent slug '${agentId}' is already taken. Choose another slug or delete/rename the original agent.`
      }, { status: 400 })
    }

    const agent = await redis.createAgent({
      ...body,
      ...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_ref')
        ? { avatar_icon_ref: normalizeOptionalIconRefInput(body.avatar_icon_ref, 'avatar_icon_ref') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_fit')
        ? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(body.avatar_icon_fit, 'avatar_icon_fit') }
        : {}),
      id: agentId,
      user_id: locals.user.id,
      // Set default settings if not provided
      ai_permissions: body.ai_permissions || {
        can_pin: false,
        max_pins: 5,
        default_pin_duration: 10
      }
    })

    try {
      await syncAgentCodexProfiles(locals.user.id)
    } catch (error) {
      console.warn('[Agents API] Failed to sync Codex profiles after create:', error)
    }
    try {
      await syncAgentClaudeProfiles(locals.user.id)
    } catch (error) {
      console.warn('[Agents API] Failed to sync Claude profiles after create:', error)
    }

    return json(agent)
  } catch (error) {
    console.error('Error creating agent:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to create agent' },
      { status: (error as any)?.status ?? 500 }
    )
  }
}
