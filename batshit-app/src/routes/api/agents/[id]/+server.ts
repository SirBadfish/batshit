import { TYPED_FILE_TOOLS_REVISION_HEADER, makeTypedToolsSnapshot, namesTypedFileToolsWrite, requireTypedToolsExpected, typedToolsReadPaths } from '$lib/server/typedFileToolsSettingsGuard'
import { MCP_SETTINGS_REVISION_HEADER, mcpSettingsLeaves } from '$lib/utils/agentSettingsSectionSaves'
import { mcpSettingsReadPaths, makeMcpSettingsSnapshot, requireMcpSettingsExpected } from '$lib/server/agentRecordUpdate'
import { AUTO_COMPACT_REVISION_HEADER } from '$lib/appActions/settings/autoCompactBaseline'
import { CONFIGURED_TTS_REVISION_HEADER } from '$lib/appActions/settings/configuredTtsBaseline'
import { CONFIGURED_TTS_READ_PATHS, configuredTtsSnapshotFromDetail, requireConfiguredTtsExpected } from '$lib/server/configuredTtsGuard'
import { AUTO_COMPACT_READ_PATHS, AUTO_COMPACT_PATHS, autoCompactSnapshotFromDetail, requireAutoCompactExpected } from '$lib/server/autoCompactGuard'
import { MODEL_SELECTION_REVISION_HEADER } from '$lib/appActions/settings/modelSelectionBaseline'
import { INSTRUCTIONS_REVISION_HEADER } from '$lib/appActions/settings/instructionsBaseline'
import { instructionsReadPaths, makeInstructionsSnapshot, requireInstructionsExpected, instructionLeaves } from '$lib/server/instructionsGuard'
import { namesModelSelection, requireModelSelectionRevision, readModelSelectionSnapshot } from '$lib/server/modelSelectionGuard'
import { captureSettingsLifecycle, assertSettingsLifecycle, SettingsLifecycleRefusal } from '$lib/server/services/appActions/settings/lifecycle'
import { AgentArtifactCleanupError } from '$lib/server/services/artifactAgentDeletionCleanup'
import { isSlashCommandMutationError } from '$lib/server/services/slashCommandRevisionProtocol'
import { SubjectPopulationError } from '$lib/server/services/subjectPopulation'
import { json, type RequestHandler } from '@sveltejs/kit'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
import { redis } from '$lib/server/redis'
import { buildAgentProfileId } from '$lib/server/services/managedProfileIdentity'
import { deleteManagedProfileFolder } from '$lib/server/services/managedProfileFolderDelete'
import { deleteAgentClaudeConfig, agentClaudeProfileResource } from '$lib/server/services/claudeProfileManager'
import { deleteAgentWorkerProfiles, planAgentWorkerProfileDeletion } from '$lib/server/services/cliSubagentProfileSync'
import {
  HostCommandDeleteRefusedError,
  hostOwnerResource,
  hostProfileResource,
  withHostCommandDeletion
} from '$lib/server/services/hostCommandOwnership'
import { validateDmSenderFields } from '$lib/utils/dmControl'
import { validateJevJuiceAgentFields } from '$lib/utils/jevJuiceControl'
import { validateLiveFileReadsAgentField } from '$lib/utils/liveFileReads'
import { CODEX_CLI_RETIRED_CODE, CODEX_CLI_RETIRED_DETAILS, CODEX_CLI_RETIRED_ERROR,
  namesRetiredCodexCliModel, namesClaudeCliModel, CLAUDE_CLI_PRESET_REFUSAL } from '$lib/utils/cliRuntimeIdentity'
import { planClaudePlanRawSamplingClears } from '$lib/server/services/claudePlanAdmission'
import {
  hasLegacyPrimaryAgentFields,
  canonicalizePrimaryAgentRecord,
  isApiPrimaryAgentType,
  normalizePrimaryAgentType,
  retiredPrimaryAgentRefusal
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
import { endClaudePlanRuns } from '$lib/server/services/claudePlanRunRegistry'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { applyAgentProviderSettingsUpdate, buildAgentProviderSettingsPatch } from '$lib/utils/agentProviderSettings'
import { AGENT_KEPT_FIELDS, assertAgentProviderSettingsBlock, namesAgentMemorySetting, type AgentUpdateOptions } from '$lib/server/agentRecordUpdate'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// GET /api/agents/[id] - Get a specific agent
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  try {
    const lifecycle = captureSettingsLifecycle([`agent:${params.id}`])
    const read = () => redis.execute(async client => {
      const instructionPaths = instructionsReadPaths('agent')
      const compactPaths = [...AUTO_COMPACT_READ_PATHS, ...AUTO_COMPACT_PATHS]
      // One atomic cut; `extraRaw` answers these lists in this order, so each reader slices its own.
      const selection = await readModelSelectionSnapshot(client, params.id!, 'agent', lifecycle, [...instructionPaths, ...compactPaths, ...CONFIGURED_TTS_READ_PATHS, ...mcpSettingsReadPaths(), ...typedToolsReadPaths('agent')])
      const compactOffset = instructionPaths.length
      const ttsOffset = compactOffset + compactPaths.length
      const mcpOffset = ttsOffset + CONFIGURED_TTS_READ_PATHS.length
      const typedOffset = mcpOffset + mcpSettingsReadPaths().length
      const instructions = makeInstructionsSnapshot(params.id!, 'agent', instructionPaths.map((path, index) => [path, selection.extraRaw[index]]), lifecycle)
      const compact = autoCompactSnapshotFromDetail(params.id!, selection.record!, selection.extraRaw.slice(compactOffset, ttsOffset), lifecycle)
      let ttsRevision: string | undefined
      try { ttsRevision = configuredTtsSnapshotFromDetail(params.id!, selection.record!, selection.extraRaw.slice(ttsOffset, mcpOffset), lifecycle).revision } catch { /* Other human settings remain readable; Voice waits for a valid fixed base. */ }
      let typedToolsRevision: string | undefined
      try { typedToolsRevision = makeTypedToolsSnapshot(params.id!, 'agent', selection.extraRaw.slice(typedOffset), lifecycle).revision } catch { /* Missing explicit source blocks this one grant, not other readable settings. */ }
      return { typedToolsRevision, mcpSettingsRevisions: makeMcpSettingsSnapshot(params.id!, mcpSettingsReadPaths(), selection.extraRaw.slice(mcpOffset, typedOffset), lifecycle).revisions, ttsRevision, autoCompactRevision: compact.revision, record: selection.record,
        modelSelectionRevision: selection.revision, instructionsRevision: JSON.stringify(instructions.revisions) }
    })
    let snapshot = await read()
    assertSettingsLifecycle(lifecycle)
    const agent = snapshot.record!
    if (agent.user_id !== locals.user.id) return json({ error: 'Unauthorized' }, { status: 403 })
    if (hasLegacyPrimaryAgentFields(agent)) {
      // The canonicalizer owns its fixed path writes. Re-read after its await;
      // an old canonicalAgent must never be paired with a fresh header.
      await redis.updateAgent(params.id!, {})
      assertSettingsLifecycle(lifecycle)
      snapshot = await read()
    }
    assertSettingsLifecycle(lifecycle)
    if (!snapshot.record || snapshot.record.user_id !== locals.user.id) return json({ error: 'Unauthorized' }, { status: 403 })
    const projected = canonicalizePrimaryAgentRecord(snapshot.record)
    // A leftover retired record (`cli`, `n8n`) stays readable so Settings can offer its delete. It
    // gets no model, instruction, Auto Compact or Voice base: every save of it is refused.
    const headers = projected.agentType === 'api'
      ? { [MODEL_SELECTION_REVISION_HEADER]: snapshot.modelSelectionRevision,
        [INSTRUCTIONS_REVISION_HEADER]: snapshot.instructionsRevision, [AUTO_COMPACT_REVISION_HEADER]: snapshot.autoCompactRevision, ...(snapshot.ttsRevision ? { [CONFIGURED_TTS_REVISION_HEADER]: snapshot.ttsRevision } : {}) } : undefined
    return json(resolveUploadUrlsForBrowserInPayload(projected), { headers: { ...headers, [MCP_SETTINGS_REVISION_HEADER]: JSON.stringify(snapshot.mcpSettingsRevisions), ...(snapshot.typedToolsRevision ? { [TYPED_FILE_TOOLS_REVISION_HEADER]: snapshot.typedToolsRevision } : {}) } })
  } catch (error) {
    console.error('Error getting agent:', error)
    const status = (error as any)?.status
    if (status === 404 || status === 409) return json({ error: error instanceof Error ? error.message : 'Agent settings changed while reading.', code: (error as any)?.code }, { status })
    return json({ error: 'Failed to get agent' }, { status: 500 })
  }
}

// PUT /api/agents/[id] - Update an agent
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  
  let typedToolsAck: { revision: string; value: boolean } | undefined
  let mcpSettingsAck: Parameters<NonNullable<AgentUpdateOptions['onMcpSettingsSaved']>>[0] | undefined
  let samplingCleared: ReturnType<typeof planClaudePlanRawSamplingClears> = null
  try {
    const updates = await request.json()
    const expectedTypedFileTools = updates.expectedTypedFileTools
    delete updates.expectedTypedFileTools
    if (expectedTypedFileTools !== undefined || namesTypedFileToolsWrite(updates)) requireTypedToolsExpected(expectedTypedFileTools)
    const expectedMcpSettings = updates.expectedMcpSettings
    delete updates.expectedMcpSettings
    if (expectedMcpSettings !== undefined || mcpSettingsLeaves(updates).length) requireMcpSettingsExpected(expectedMcpSettings, mcpSettingsLeaves(updates))
    const expectedTtsSelection = updates.expectedTtsSelection
    delete updates.expectedTtsSelection
    if (expectedTtsSelection !== undefined || updates.voice_profile !== undefined) requireConfiguredTtsExpected(expectedTtsSelection)
    const expectedAutoCompact = updates.expectedAutoCompact
    delete updates.expectedAutoCompact
    if (expectedAutoCompact !== undefined || updates.auto_compact_settings !== undefined) requireAutoCompactExpected(expectedAutoCompact)
    const expectedModelSelection = updates.expectedModelSelection
    delete updates.expectedModelSelection
    if (expectedModelSelection !== undefined) requireModelSelectionRevision(expectedModelSelection)
    const expectedInstructions = updates.expectedInstructions
    delete updates.expectedInstructions
    if (expectedInstructions !== undefined || instructionLeaves(updates).length) requireInstructionsExpected(expectedInstructions, instructionLeaves(updates))
    // SA-139 R4: the Claude Code CLI lane's request-only save checks are never stored. The record
    // check below answers a leftover CLI agent first; a live agent sent one is refused after it.
    const cliSaveChecks = ['expectedCliReasoning', 'expectedCliPromotion'].filter(field => Object.hasOwn(updates, field))
    for (const field of cliSaveChecks) delete updates[field]
    // The old CLI settings blocks are never stored (R1: Codex, R4: Claude Code). Dropping one leaves a
    // stored block untouched, so a whole-record echo that carries it still saves.
    delete updates.codex_settings
    delete updates.claude_settings
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
    // SA-137 P4: the agent's Live File Reads override is true, false or null (null removes it).
    const liveFileReadsValidationError = validateLiveFileReadsAgentField(updates)
    if (liveFileReadsValidationError) {
      return json({ error: liveFileReadsValidationError }, { status: 400 })
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
    
    // BL-1519: failed storage reads must stop admission, not impersonate absence.
    const agent = await redis.get(`agent:${params.id}`, { throwOnError: true })
    if (!agent) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }
    
    if (agent.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    // SA-139 R4 (D14): a leftover record of a retired type (the Claude Code CLI lane, n8n) refuses
    // every save; only its delete works.
    const retired = retiredPrimaryAgentRefusal(agent)
    if (retired) return json(retired, { status: 409 })
    if (cliSaveChecks.length) {
      return json(
        {
          error: `This save carries a Claude Code CLI check (${cliSaveChecks.join(', ')}), and the Claude Code CLI lane was removed from Batshit, so nothing was saved. Reload Settings and try again.`
        },
        { status: 400 }
      )
    }
    if (Object.hasOwn(updates, 'app_action_policy')) {
      // Older full-record human saves may echo the unchanged read-only field. Preserve it;
      // a differing value is an attempted authority edit and belongs to the dedicated route.
      if (!sameJsonValue(updates.app_action_policy ?? null, (agent as Record<string, unknown>).app_action_policy ?? null)) {
        return json({ error: 'App Actions policy must be changed using its dedicated Access control.', code: 'app_actions_policy_user_only' }, { status: 400 })
      }
      delete updates.app_action_policy
    }

    const namesAgentType = Object.prototype.hasOwnProperty.call(updates, 'agentType')
    const requestedAgentType =
      typeof updates.agentType === 'string' ? updates.agentType.trim().toLowerCase() : ''
    if (namesAgentType && requestedAgentType !== 'api') {
      return json(
        {
          error: 'The Primary Agent type must be API.',
          code: 'primary_agent_type_invalid'
        },
        { status: 400 }
      )
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
    if (namesModelSelection('agent', updates)) requireModelSelectionRevision(expectedModelSelection)
    const provider = (updates.primary_model_provider ?? agent.primary_model_provider ?? '')
      .toLowerCase()
      .trim()
    const modelName = (updates.primary_model_name ?? agent.primary_model_name ?? '')
      .toLowerCase()
      .trim()
    const connection =
      updates.primary_model_connection ?? agent.primary_model_connection ?? null
    // SA-139 R1: Codex CLI was removed, so an agent never names a Codex CLI model. Provider and
    // connection ids only: an OpenAI model id containing "codex" is an API model.
    if (namesRetiredCodexCliModel({ primary_model_provider: provider, primary_model_connection: connection })) {
      return json(
        { error: CODEX_CLI_RETIRED_ERROR, code: CODEX_CLI_RETIRED_CODE, details: CODEX_CLI_RETIRED_DETAILS },
        { status: 409 }
      )
    }
    // SA-139 R4 and R5: nothing runs a Claude Code CLI preset any more, so no agent stores one.
    if (namesClaudeCliModel({ primary_model_provider: provider, primary_model_name: modelName, primary_model_connection: connection })) {
      return json({ error: CLAUDE_CLI_PRESET_REFUSAL }, { status: 400 })
    }
    // A record that predates `agentType` has its type worked out from its fields (a body's legacy
    // type fields included); a save never works it out to a retired type.
    if (!isApiPrimaryAgentType(resolvedAgentType)) {
      return json(
        {
          error: 'The Primary Agent type must be API.',
          code: 'primary_agent_type_invalid'
        },
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
    // BL-1702: full-record human saves may echo read-only metadata. Keep it out of ordinary writes.
    for (const field of AGENT_KEPT_FIELDS) delete canonicalUpdates[field]
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
    // SA-139 (Faye S13): a model save that leaves the agent on the Claude plan with no preset removes what every run's
    // admission would refuse (the sampling copies, the settings block's other model keys, an effort or Thinking value
    // the model cannot take), and its answer says so. Never a silent drop at run time. The block is written key by
    // key, so a removed key is a `null` beside the save's own patch.
    samplingCleared = namesModelSelection('agent', updates)
      ? planClaudePlanRawSamplingClears(agent as Record<string, unknown>, canonicalUpdates,
        applyAgentProviderSettingsUpdate((agent as Record<string, any>).provider_specific_settings, updates.provider_specific_settings))
      : null
    if (samplingCleared) {
      Object.assign(canonicalUpdates, samplingCleared.clears)
      if (Object.keys(samplingCleared.blockClears).length) {
        canonicalUpdates.provider_specific_settings = { ...(canonicalUpdates.provider_specific_settings ?? {}), ...samplingCleared.blockClears }
      }
    }
    const options: AgentUpdateOptions = {
      onTypedFileToolsSaved(ack) { typedToolsAck = ack },
      ...(expectedTypedFileTools !== undefined ? { expectedTypedFileTools } : {}),
      onMcpSettingsSaved(ack) { mcpSettingsAck = ack },
      ...(expectedMcpSettings !== undefined ? { expectedMcpSettings } : {}),
      ...(expectedTtsSelection !== undefined ? { expectedTtsSelection } : {}),
      ...(expectedAutoCompact !== undefined ? { expectedAutoCompact } : {}),
      ...(expectedModelSelection !== undefined ? { expectedModelSelection: expectedModelSelection as string } : {}),
      ...(expectedInstructions !== undefined ? { expectedInstructions } : {}),
      ...(namesMemory ? { expectedMemory: expectedMemory as Record<string, unknown> } : {})
    }
    if (Object.keys(options).length) await redis.updateAgent(params.id!, canonicalUpdates, options)
    else await redis.updateAgent(params.id!, canonicalUpdates)
    if (canonicalUpdates.provider_specific_settings !== undefined) void publishUserEvent(locals.user.id, { type: 'agent_settings_changed', agentId: params.id!, family: 'provider-settings' })
    if (mcpSettingsLeaves(canonicalUpdates).length) void publishUserEvent(locals.user.id, { type: 'agent_settings_changed', agentId: params.id!, family: 'mcp-settings' })
    if (canonicalUpdates.voice_profile !== undefined) void publishUserEvent(locals.user.id, { type: 'agent_settings_changed', agentId: params.id!, family: 'voice-selection' })
    if (canonicalUpdates.auto_compact_settings !== undefined) void publishUserEvent(locals.user.id, { type: 'agent_settings_changed', agentId: params.id!, family: 'auto-compact' })
    if (instructionLeaves(canonicalUpdates).length) await publishUserEvent(locals.user.id, { type: 'agent_settings_changed', agentId: params.id!, family: 'instructions' })
    if (['api_reasoning_retention', 'whiteboard_budget_tokens', 'show_whiteboard', 'show_reasoning', 'preserve_reasoning'].some((field) => field in canonicalUpdates)) {
      await publishUserEvent(locals.user.id, { type: 'agent_settings_changed', agentId: params.id!, family: 'retention' })
    }
    if (canonicalUpdates.model_reasoning_overrides) {
      const key = Object.keys(canonicalUpdates.model_reasoning_overrides)[0]
      const acknowledged = await redis.json.get(`agent:${params.id}`) as Record<string, any> | null
      if (!acknowledged || acknowledged.user_id !== locals.user.id) {
        return json({ error: 'The reasoning save could not be confirmed. Reload Settings before sending.', ...(samplingCleared ? { samplingCleared: { fields: samplingCleared.fields, notice: samplingCleared.notice } } : {}) }, { status: 409 })
      }
      return json({ success: true, ...(typedToolsAck ? { typedFileTools: typedToolsAck } : {}), ...(mcpSettingsAck ? { mcpSettings: mcpSettingsAck } : {}), ...(samplingCleared ? { samplingCleared: { fields: samplingCleared.fields, notice: samplingCleared.notice } } : {}), model_reasoning_override: {
        key, selection: acknowledged.model_reasoning_overrides?.[key] ?? null
      } })
    }
    return json({ success: true, ...(typedToolsAck ? { typedFileTools: typedToolsAck } : {}), ...(mcpSettingsAck ? { mcpSettings: mcpSettingsAck } : {}), ...(samplingCleared ? { samplingCleared: { fields: samplingCleared.fields, notice: samplingCleared.notice } } : {}) })
  } catch (error) {
    // A save refused before anything was written (`AgentUpdateRejectedError`, review items 2 and
    // 6) carries status 400 and a message that says what to change; a type that kept changing
    // during the save (`AgentUpdateConflictError`) carries 409, and so does a memory save whose saved
    // values changed after it started (`AgentMemorySettingsConflictError`, code
    // `memory_settings_changed`, BL-1294).
    console.error('Error updating agent:', error)
    const code = typeof (error as any)?.code === 'string' ? (error as any).code : undefined
    return json(
      { error: error instanceof Error ? error.message : 'Failed to update agent', ...(typedToolsAck ? { typedFileToolsSaved: true, typedFileTools: typedToolsAck } : {}), ...(mcpSettingsAck ? { mcpSettingsSaved: true, mcpSettings: mcpSettingsAck } : {}), ...(code ? { code } : {}) },
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
    // Verify agent exists and belongs to user. BL-642: read with `redis.json.get`, which throws on
    // a failed read; `redis.get` answers null for one, the same as a missing agent, and the user
    // was told "Agent not found". A failed read is the catch's 500 and nothing is deleted.
    const agent = await redis.json.get(`agent:${params.id}`)
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

      // SA-139 (D10): every Claude plan run of this agent (in its own chats, a group chat, or a
      // Subagent or Worker run it started, which carry the parent's id) ends and its Claude Code exit
      // is confirmed before anything is deleted; an unconfirmed exit keeps the agent (409).
      const claudePlanRuns = await endClaudePlanRuns({ userId, agentId: params.id! }, 'This agent was deleted.')
      if (claudePlanRuns.unsettled > 0) {
        return json(
          {
            error: 'A Claude Code run of this agent is still stopping, so nothing was deleted. Try again in a moment; if this keeps happening, restart Batshit.',
            code: 'claude_plan_run_still_stopping'
          },
          { status: 409 }
        )
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
            await deleteManagedProfileFolder(params.id)
          } catch (error) {
            console.warn('[Agents API] Failed to remove the managed profile folder:', error)
          }
        })(),
        (async () => {
          try {
            await deleteAgentClaudeConfig(params.id)
          } catch (error) {
            console.warn('[Agents API] Failed to remove Claude config directory:', error)
          }
        })(),
        // BL-393: its Workers' slot folders too (their CLI logs hold the Workers' prompts),
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
    if (error instanceof AgentArtifactCleanupError) return json({ error: error.message, code: error.code, outcome: error.outcome, subjectRetained: error.subjectRetained, cleanup: error.progress }, { status: error.status })
    console.error('Error deleting agent:', error)
    if (error instanceof SettingsLifecycleRefusal) return json({ error: error.message, code: error.code }, { status: error.status })
    if (error instanceof SubjectPopulationError) return json({ error: error.message, code: error.code }, { status: error.status })
    if (isSlashCommandMutationError(error)) return json({ error: `The agent record was retained after skill reference cleanup stopped. Earlier cleanup may already have completed. ${error.message}`, code: error.code }, { status: error.status })
    if (error instanceof HostCommandDeleteRefusedError) {
      return json({ error: error.message, code: error.code }, { status: error.status })
    }
    return json({ error: 'Failed to delete agent' }, { status: 500 })
  }
}
