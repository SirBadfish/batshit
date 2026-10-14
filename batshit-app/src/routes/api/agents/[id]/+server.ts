import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { syncAgentCodexProfiles, deleteAgentCodexConfig, buildAgentProfileId } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles, deleteAgentClaudeConfig, agentClaudeProfileResource } from '$lib/server/services/claudeProfileManager'
import { deleteAgentWorkerProfiles, planAgentWorkerProfileDeletion } from '$lib/server/services/cliSubagentProfileSync'
import {
  HostCommandDeleteRefusedError,
  hostOwnerResource,
  hostProfileResource,
  withHostCommandDeletion
} from '$lib/server/services/hostCommandOwnership'
import { validateDmSenderFields } from '$lib/utils/dmControl'
import { validateJevJuiceAgentFields } from '$lib/utils/jevJuiceControl'
import { getCodexConfigOverrideValidationError } from '$lib/server/services/codexSettings'
import { getClaudeConfigOverrideValidationError } from '$lib/server/services/claudeSettings'
import {
  canonicalizePrimaryAgentRecord,
  hasLegacyPrimaryAgentFields,
  isApiPrimaryAgentType,
  isCliPrimaryAgentType,
  isManagedPrimaryAgentType,
  normalizePrimaryAgentType
} from '$lib/utils/primaryAgentType'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { resolveUploadUrlsForBrowserInPayload } from '$lib/server/services/batshitServerUrls'
import { isGoonRuntimeReady } from '$lib/goons/recipe/recipeProductLifecycle'
import { deleteAgentChats, type AgentChatDeletionResult } from '$lib/server/services/agentChatDeletion'
import {
  AgentAvatarDeletionError,
  checkBatshitServerCanDeleteAvatars,
  deleteAgentAvatars
} from '$lib/server/services/agentAvatarDeletion'
import { SessionDeleteRefusedError } from '$lib/server/services/sessionDeleteTurnStop'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { buildAgentProviderSettingsPatch } from '$lib/utils/agentProviderSettings'
import { assertAgentProviderSettingsBlock, namesAgentMemorySetting } from '$lib/server/agentRecordUpdate'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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
      // BL-770: by path, never the whole record read here. An empty update (review item 1): the
      // script works the type out from the record as it is when it runs, never from this read
      // (which wrote an old type back over a change made since), and removes the legacy fields.
      await redis.updateAgent(params.id!, {})
      return json(resolveUploadUrlsForBrowserInPayload(canonicalAgent))
    }
    
    return json(resolveUploadUrlsForBrowserInPayload(agent as Record<string, any>))
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
    // SA-113 P2 (DL-113-01): refuse a bad sender policy rather than storing it. The read
    // side defaults an unrecognised value to "any agent", which is the permissive one.
    const dmSenderValidationError = validateDmSenderFields(updates)
    if (dmSenderValidationError) {
      return json({ error: dmSenderValidationError }, { status: 400 })
    }
    // SA-120 P1: the per-agent Judge Juice switch must be a boolean (absent reads as OFF).
    const jevJuiceValidationError = validateJevJuiceAgentFields(updates)
    if (jevJuiceValidationError) {
      return json({ error: jevJuiceValidationError }, { status: 400 })
    }
    // BL-1294: the agent can change its own memory settings (App Actions), so a save of them says
    // which saved values it started from, and `updateAgent` refuses it (409) when they changed.
    // `expectedMemory` is never stored. A save without it is refused visibly: a fallback that saved
    // anyway would let a stale copy take back what the agent saved.
    const namesMemory = namesAgentMemorySetting(updates)
    const expectedMemory = updates.expectedMemory
    delete updates.expectedMemory
    if (namesMemory && !isPlainRecord(expectedMemory)) {
      return json(
        {
          error:
            'This save changes memory settings but does not say which saved values it started from, so nothing was saved. Reload Batshit and try again.',
          code: 'memory_base_required'
        },
        { status: 400 }
      )
    }
    
    // Verify agent exists and belongs to user
    const agent = await redis.get(`agent:${params.id}`)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    
    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (!isManagedPrimaryAgentType(normalizePrimaryAgentType(agent))) {
      return json(
        {
          error: 'This Primary Agent uses the retired n8n type and can only be deleted.',
          code: 'primary_agent_type_retired'
        },
        { status: 409 }
      )
    }

    const namesAgentType = Object.prototype.hasOwnProperty.call(updates, 'agentType')
    const requestedAgentType =
      typeof updates.agentType === 'string' ? updates.agentType.trim().toLowerCase() : ''
    if (namesAgentType) {
      if (requestedAgentType !== 'api' && requestedAgentType !== 'cli') {
        return json(
          {
            error: 'Primary Agent type must be API or CLI.',
            code: 'primary_agent_type_invalid'
          },
          { status: 400 }
        )
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'goon_id') && updates.goon_id) {
      const goon = await redis.get(`goon:${String(updates.goon_id)}`)
      if (!goon || goon.user_id !== locals.user.id) {
        return json({ error: 'Goon not found' }, { status: 400 })
      }
      if (!isGoonRuntimeReady(goon)) {
        return json(
          { error: 'That Goon is still preparing. Finish it in Settings → 3D Goons first.' },
          { status: 409 }
        )
      }
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

    if (isApiPrimaryAgentType(resolvedAgentType) && isCliPreset) {
      return json(
        { error: 'CLI model presets are only available for CLI agents.' },
        { status: 400 }
      )
    }

    // Review item 1: `agentType` goes to updateAgent only when the body names it. The type this
    // route worked out from its own read above wrote an old type back over an API to CLI change
    // made after that read; updateAgent's script now keeps a canonical stored type and works a
    // legacy one out from the record as it is. Legacy type fields in a body are type fields for
    // that, never stored (`planAgentRecordUpdate`).
    const canonicalUpdates: Record<string, any> = {
      ...(updates as Record<string, any>),
      ...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_ref')
        ? { avatar_icon_ref: normalizeOptionalIconRefInput(updates.avatar_icon_ref, 'avatar_icon_ref') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_fit')
        ? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(updates.avatar_icon_fit, 'avatar_icon_fit') }
        : {})
    }
    if (namesAgentType) canonicalUpdates.agentType = requestedAgentType
    // Review item 6: a block that is neither an object nor null is a 400, not a 500 from the merge.
    assertAgentProviderSettingsBlock(canonicalUpdates.provider_specific_settings)
    // BL-514: updateAgent writes provider_specific_settings key by key (BL-768). The model keys a
    // body sends replace the stored model keys; the agent's own keys (the Work mode, the Bash
    // never-allow list, `codex_*`, `claude_*`, ...) change only when the body names them, so no
    // client (a chat-bar model pick, an old tab) can drop them. A block sent as null clears the
    // model keys only. BL-833: a block that names only own keys (a chat-bar mode, Work mode or
    // reasoning control) leaves the model keys alone. BL-841: `nativeTools` goes on as sent and
    // updateAgent writes it field by field, in the same script as the rest of this save.
    const providerSettingsPatch = buildAgentProviderSettingsPatch(
      (agent as Record<string, any>).provider_specific_settings,
      canonicalUpdates.provider_specific_settings
    )
    if (providerSettingsPatch === undefined) delete canonicalUpdates.provider_specific_settings
    else canonicalUpdates.provider_specific_settings = providerSettingsPatch
    if (namesMemory) {
      await redis.updateAgent(params.id!, canonicalUpdates, { expectedMemory: expectedMemory as Record<string, unknown> })
    } else {
      await redis.updateAgent(params.id!, canonicalUpdates)
    }
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
    // A save refused before anything was written (`AgentUpdateRejectedError`, review items 2 and
    // 6) carries status 400 and a message that says what to change; a type that kept changing
    // during the save (`AgentUpdateConflictError`) carries 409, and so does a memory save whose saved
    // values changed after it started (`AgentMemorySettingsConflictError`, code
    // `memory_settings_changed`, BL-1294).
    console.error('Error updating agent:', error)
    const code = typeof (error as any)?.code === 'string' ? (error as any).code : undefined
    return json(
      { error: error instanceof Error ? error.message : 'Failed to update agent', ...(code ? { code } : {}) },
      { status: (error as any)?.status ?? 500 }
    )
  }
}

// DELETE /api/agents/[id] - Delete an agent. `?chats=1` (the dialog's "Also delete its chats"
// checkbox, 2026-09-19) deletes the agent's own chats first; group chats are never included.
export const DELETE: RequestHandler = async ({ params, locals, url }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = locals.user.id
  const deleteChats = url.searchParams.get('chats') === '1'

  try {
    // Verify agent exists and belongs to user
    const agent = await redis.get(`agent:${params.id}`)
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    
    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Hold every profile this delete can physically remove before chats, pictures, or Redis
    // records change. The plan uses the same sharing test as the Worker-folder delete.
    const resources = process.platform === 'win32' ? [] : [
      hostOwnerResource({ userId, kind: 'agent', id: params.id! }),
      hostProfileResource(buildAgentProfileId(params.id)),
      agentClaudeProfileResource(params.id),
      ...(await planAgentWorkerProfileDeletion(userId, params.id!)).deletable.flatMap(({ profileId, runtimeId }) => [
        hostProfileResource(profileId), agentClaudeProfileResource(runtimeId)
      ])
    ]
    const deleteOwned = async (notices: string[]) => {
      // BL-41: batshit-server deletes the agent's avatar pictures, so make sure it can BEFORE
      // anything is deleted. "Also delete its chats" is on by default, and without this check a
      // stopped batshit-server let the chats go while the agent stayed.
      try {
        await checkBatshitServerCanDeleteAvatars()
      } catch (error) {
        if (error instanceof AgentAvatarDeletionError) {
          const retryNote = error.status === 503 ? ' Try again once batshit-server is running.' : ''
          return json(
            {
              error: `${error.message} It deletes the agent's avatar pictures, so nothing was deleted: ${deleteChats ? 'the agent and its chats are' : 'the agent is'} still there.${retryNote}`,
              code: error.code
            },
            { status: error.status }
          )
        }
        throw error
      }

      // Chats first, agent second: a chat whose reply is still stopping refuses the delete
      // (409) and the agent stays, so the user can simply try again.
      let chats: AgentChatDeletionResult | null = null
      if (deleteChats) {
        try {
          chats = await deleteAgentChats(userId, params.id!)
        } catch (error) {
          if (error instanceof SessionDeleteRefusedError) {
            return json(
              { error: `${error.message} The agent was not deleted.`, code: error.code },
              { status: 409 }
            )
          }
          throw error
        }
      }

      // BL-41: the avatar pictures are batshit-server's, so ask it BEFORE the agent record
      // goes, like the memory media inside `redis.deleteAgent`: if it cannot, the agent stays
      // (its pictures with it) and the user is told why, and a retry finishes the job. After
      // the chats, because a chat still stopping must leave the agent and its avatar untouched;
      // the check above makes a failure here rare (batshit-server stopping in between), and the
      // error then says how many chats already went.
      // Before `redis.deleteAgent` rather than inside it, on purpose: its sweeps (memory media,
      // DMs, wake-up webhooks, schedules, run credentials) delete for good, and the likely
      // failure here, batshit-server not running, must keep all of that. The price is a rare
      // one: if one of those sweeps throws after this succeeded, the agent survives without its
      // picture until the retry deletes it.
      try {
        await deleteAgentAvatars(userId, { id: params.id!, avatar: agent.avatar, avatar_url: agent.avatar_url })
      } catch (error) {
        if (error instanceof AgentAvatarDeletionError) {
          const deletedChats = chats?.deleted.length ?? 0
          const chatsNote =
            deletedChats > 0
              ? ` Its ${deletedChats} ${deletedChats === 1 ? 'chat was' : 'chats were'} already deleted.`
              : ''
          const retryNote = error.status === 503 ? ' Try again once batshit-server is running.' : ''
          return json(
            {
              error: `${error.message} The agent was not deleted.${chatsNote}${retryNote}`,
              code: error.code,
              chats: chats ? { deleted: deletedChats, keptLocked: chats.keptLocked.length } : null
            },
            { status: error.status }
          )
        }
        throw error
      }

      const { releasedHolds } = await redis.deleteAgent(params.id!)
      // BL-539: the agent's holds went with it; every open tab of those chats re-reads zip state,
      // or it keeps showing "Held by" a deleted agent until a reload. Once per chat, as the
      // reply-end step does. `publishUserEvent` logs a failed publish and never throws.
      for (const sessionId of new Set(releasedHolds.map((hold) => hold.sessionId))) {
        await publishUserEvent(userId, {
          type: 'zip_state_changed',
          sessionId,
          source: 'agent',
          opened: [],
          rezipped: []
        })
      }
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
        })(),
        // BL-393: its Workers' slot folders too (their Codex logs hold the Workers' prompts),
        // never one another record also owns.
        (async () => {
          try {
            const workers = await deleteAgentWorkerProfiles(userId, params.id!)
            if (workers.kept.length > 0) {
              console.warn('[Agents API] Kept Worker folders another record also owns:', workers.kept)
            }
          } catch (error) {
            console.warn('[Agents API] Failed to remove Worker folders:', error)
          }
        })()
      ])
      return json({
        success: true,
        chats: chats ? { deleted: chats.deleted.length, keptLocked: chats.keptLocked.length } : null,
        ...(notices[0] ? { notice: notices[0] } : {})
      })
    }
    return await (process.platform === 'win32'
      ? deleteOwned([])
      : withHostCommandDeletion(resources, deleteOwned))
  } catch (error) {
    console.error('Error deleting agent:', error)
    if (error instanceof HostCommandDeleteRefusedError) {
      return json({ error: error.message, code: error.code }, { status: error.status })
    }
    return json({ error: 'Failed to delete agent' }, { status: 500 })
  }
}
