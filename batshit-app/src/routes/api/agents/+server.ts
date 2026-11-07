import { SubjectPopulationError } from '$lib/server/services/subjectPopulation'
import { PresetReferenceWriteError } from '$lib/server/services/modelPresetReferenceGuard'
import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { validateDmSenderFields } from '$lib/utils/dmControl'
import { validateJevJuiceAgentFields } from '$lib/utils/jevJuiceControl'
import { CODEX_CLI_RETIRED_CODE, CODEX_CLI_RETIRED_DETAILS, CODEX_CLI_RETIRED_ERROR,
  namesRetiredCodexCliModel, namesClaudeCliModel, CLAUDE_CLI_PRESET_REFUSAL } from '$lib/utils/cliRuntimeIdentity'
import { resolveNewAgentId } from '$lib/server/services/agentIdRules' // Story 6.9c, BL-283
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { isRetiredPrimaryAgentType, retiredPrimaryAgentRefusal } from '$lib/utils/primaryAgentType'

// GET /api/agents - List all agents for the current user
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const agents = await redis.getAgents(locals.user.id)
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
    const requestedAgentType =
      typeof body.agentType === 'string' ? body.agentType.trim().toLowerCase() : ''
    // SA-139 R4 (D14): `api` is the one Primary Agent type. A retired type (the Claude Code CLI
    // lane, n8n) gets the shared refusal; anything else is not a type.
    if (Object.prototype.hasOwnProperty.call(body, 'agentType') && requestedAgentType !== 'api') {
      const retired = isRetiredPrimaryAgentType(requestedAgentType)
        ? retiredPrimaryAgentRefusal({ ...body, agentType: requestedAgentType })
        : null
      if (retired) return json(retired, { status: 409 })
      return json(
        {
          error: 'The Primary Agent type must be API.',
          code: 'primary_agent_type_invalid'
        },
        { status: 400 }
      )
    }
    // SA-139 R1: Codex CLI was removed; a new agent on it is refused.
    if (namesRetiredCodexCliModel(body)) {
      return json(
        { error: CODEX_CLI_RETIRED_ERROR, code: CODEX_CLI_RETIRED_CODE, details: CODEX_CLI_RETIRED_DETAILS },
        { status: 409 }
      )
    }
    // SA-139 R4 and R5: nothing runs a Claude Code CLI preset any more, so a Primary Agent never
    // stores one (it would only fail at its first send).
    if (namesClaudeCliModel(body)) {
      return json({ error: CLAUDE_CLI_PRESET_REFUSAL }, { status: 400 })
    }
    // The old CLI settings blocks are never stored on a new agent (R1: Codex, R4: Claude Code).
    delete body.codex_settings
    delete body.claude_settings
    // SA-113 P2 (DL-113-01): same refusal as the update route.
    const dmSenderValidationError = validateDmSenderFields(body)
    if (dmSenderValidationError) {
      return json({ error: dmSenderValidationError }, { status: 400 })
    }
    // SA-120 P1: the per-agent Judge Juice switch must be a boolean (absent reads as OFF).
    const jevJuiceValidationError = validateJevJuiceAgentFields(body)
    if (jevJuiceValidationError) {
      return json({ error: jevJuiceValidationError }, { status: 400 })
    }

    // Story 6.9c: Use provided ID or generate from displayName. BL-283/BL-285: an id the
    // delete, the avatar pictures, or a CLI Subagent's profile folder cannot live with is refused.
    const requestedId = resolveNewAgentId('agent', body.id, body.displayName)
    if (!requestedId.ok) {
      return json({ error: requestedId.error, code: requestedId.code }, { status: 400 })
    }
    const agentId = requestedId.id

    // Story 6.9c: Check for ID collision
    const exists = await redis.exists(`agent:${agentId}`)
    if (exists) {
      return json({
        error: `Agent slug '${agentId}' is already taken. Choose another slug or delete/rename the original agent.`
      }, { status: 400 })
    }
    // BL-187 (2026-09-25): a skill's or artifact's access list names ids with no kind, so an
    // agent sharing a Subagent's id would share its access. Refuse the id instead.
    if (await redis.exists(`subagent:${agentId}`)) {
      return json({
        error: `A Subagent already uses the id '${agentId}'. Give this agent another name, so their skill and artifact access stay separate.`
      }, { status: 400 })
    }

    const agent = await redis.createAgent({
      ...body,
      agentType: 'api',
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

    return json(agent)
  } catch (error) {
    console.error('Error creating agent:', error)
    if (error instanceof SubjectPopulationError || error instanceof PresetReferenceWriteError) return json({ error: error.message, code: error.code }, { status: error.status })
    return json(
      { error: error instanceof Error ? error.message : 'Failed to create agent' },
      { status: (error as any)?.status ?? 500 }
    )
  }
}
