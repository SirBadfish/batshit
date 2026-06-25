import { json, type RequestHandler } from '@sveltejs/kit'
import { generateText } from 'ai'
import { redis } from '$lib/server/redis'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import { ProviderManager } from '$lib/server/services/providers'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import type { AgentRow } from '$lib/types/database'
import type { SavedModel, ModelConnectionInfo, ModelCapabilities } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import {
  buildCompactionTranscript,
  buildLiveProtectedItemsNote,
  getContextCompactionState,
  normalizeGlobalAutoCompactSettings,
  resolveCompactSummaryBudget,
  resolveEffectiveAutoCompactSettings,
  resolveCurrentModelCompactRuntime,
  selectMessagesForCompaction,
  type AutoCompactEventMode,
  type ContextCompactionEvent,
  type EffectiveAutoCompactSettings
} from '$lib/utils/contextCompaction'
import { countTotalTokens } from '$lib/utils/tokenCounter'
import {
  estimateCurrentContextTokens,
  loadContextProtections,
  normalizeMessages,
  normalizeStringArray
} from '$lib/server/services/contextTokenPreview'

type AgentRecord = AgentRow & Record<string, any>

async function loadSavedModel(presetId: string | null): Promise<SavedModel | null> {
  if (!presetId) return null
  const model = await redis.get(`model:${presetId}`).catch(() => null)
  return model && typeof model === 'object' ? model as SavedModel : null
}

function isCliLikeSelection(params: {
  provider?: string | null
  modelId?: string | null
  connection?: ModelConnectionInfo | null
}) {
  const provider = (params.provider ?? '').toLowerCase()
  const modelId = (params.modelId ?? '').toLowerCase()
  const connection = (
    params.connection?.id ??
    params.connection?.service ??
    params.connection?.type ??
    ''
  ).toLowerCase()
  return (
    provider.includes('codex') ||
    provider.includes('claude-cli') ||
    modelId.includes('codex') ||
    modelId.includes('claude-cli') ||
    connection.includes('codex') ||
    connection.includes('claude')
  )
}

function isN8nOnlySelection(params: {
  provider?: string | null
  connection?: ModelConnectionInfo | null
}) {
  const provider = (params.provider ?? '').toLowerCase()
  const connection = (
    params.connection?.id ??
    params.connection?.service ??
    ''
  ).toLowerCase()
  return (
    provider.includes('n8n') ||
    connection.includes('n8n') ||
    connection === 'aws-bedrock' ||
    connection === 'azure-openai' ||
    connection === 'google-vertex'
  )
}

type CompactGenerationResult = {
  summary: string
  modelLabel: string
  provider: string | null
  modelId: string | null
}

async function resolveCompactModel(params: {
  userId: string
  agent: AgentRecord
  settings: EffectiveAutoCompactSettings
}) {
  const agentType = normalizePrimaryAgentType(params.agent)
  if (params.settings.modelMode === 'current' && agentType !== 'api') {
    throw new Error(
      'Current-model compacting for this Primary Agent is not available through the direct API compact path. Choose an API-compatible saved compact model preset.'
    )
  }

  const preset =
    params.settings.modelMode === 'preset'
      ? await loadSavedModel(params.settings.modelPresetId)
      : null

  if (params.settings.modelMode === 'preset' && !preset) {
    throw new Error('The selected compact model preset was not found.')
  }

  const selection = resolveRuntimeModelSelection({
    preset,
    presetId: params.settings.modelPresetId,
    provider: params.agent.primary_model_provider,
    modelId: params.agent.primary_model_name,
    connection: preset ? resolveSavedModelConnection(preset) : params.agent.primary_model_connection ?? null,
    capabilities: (preset?.capabilities ?? params.agent.primary_model_capabilities ?? null) as ModelCapabilities | null,
    settings: (preset?.settings ?? params.agent.provider_specific_settings ?? null) as Record<string, any> | null
  })

  if (isCliLikeSelection({
    provider: selection.provider,
    modelId: selection.modelId,
    connection: selection.connection
  })) {
    throw new Error(
      'Compact cannot run through CLI model presets yet. Choose an API-compatible saved model preset for compacting.'
    )
  }

  if (isN8nOnlySelection({ provider: selection.provider, connection: selection.connection })) {
    throw new Error(
      'Compact cannot run through n8n-only model connections. Choose an API-compatible saved model preset for compacting.'
    )
  }

  const resolvedIds = resolveModelIds({
    developerId: selection.provider,
    modelId: selection.modelId,
    connection: selection.connection
  })

  const effectiveModelId = resolvedIds?.effectiveModelId ?? selection.modelId
  if (!effectiveModelId) {
    throw new Error('Compact model is missing a model ID.')
  }

  const runtimeSettings = buildRuntimeModelSettings({
    provider: resolvedIds?.developerId ?? selection.provider,
    modelId: resolvedIds?.modelId ?? selection.modelId,
    connection: selection.connection,
    contextWindow: selection.contextWindow,
    capabilities: selection.capabilities,
    settings: selection.settings as Record<string, ParameterValue> | null,
    fallbacks: {
      temperature:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.temperature
          : params.agent.primary_model_temperature,
      maxTokens:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.maxTokens
          : params.agent.primary_model_max_tokens,
      topP:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.topP
          : params.agent.primary_model_top_p,
      topK:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.topK
          : params.agent.primary_model_top_k,
      presencePenalty:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.presencePenalty
          : params.agent.primary_model_presence_penalty,
      frequencyPenalty:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.frequencyPenalty
          : params.agent.primary_model_frequency_penalty,
      seed:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.seed
          : params.agent.primary_model_seed,
      stopSequences:
        params.settings.modelMode === 'preset'
          ? preset?.settings?.stopSequences
          : params.agent.primary_model_stop_sequences
    }
  })

  const manager = await ProviderManager.createForUser(params.userId)
  const model = manager.getModel(effectiveModelId, {
    transport: selection.connection?.type,
    service: selection.connection?.service ?? null,
    allowAutoFallback: false
  })

  return {
    model,
    effectiveModelId,
    provider:
      resolvedIds?.developerId ??
      selection.provider ??
      selection.connection?.service ??
      null,
    providerOptions:
      Object.keys(runtimeSettings.providerOptions).length > 0
        ? runtimeSettings.providerOptions
        : undefined,
    generationSettings: {
      maxOutputTokens: runtimeSettings.standard.maxTokens ?? 6_000,
      ...(runtimeSettings.standard.temperature !== undefined
        ? { temperature: runtimeSettings.standard.temperature }
        : {}),
      ...(runtimeSettings.standard.topP !== undefined ? { topP: runtimeSettings.standard.topP } : {}),
      ...(runtimeSettings.standard.topK !== undefined ? { topK: runtimeSettings.standard.topK } : {}),
      ...(runtimeSettings.standard.presencePenalty !== undefined
        ? { presencePenalty: runtimeSettings.standard.presencePenalty }
        : {}),
      ...(runtimeSettings.standard.frequencyPenalty !== undefined
        ? { frequencyPenalty: runtimeSettings.standard.frequencyPenalty }
        : {}),
      ...(runtimeSettings.standard.seed !== undefined ? { seed: runtimeSettings.standard.seed } : {}),
      ...(runtimeSettings.standard.stopSequences !== undefined
        ? { stopSequences: runtimeSettings.standard.stopSequences }
        : {})
    },
    label:
      preset?.modelName ||
      preset?.modelId ||
      effectiveModelId
  }
}

async function generateApiCompactSummary(params: {
  userId: string
  agent: AgentRecord
  settings: EffectiveAutoCompactSettings
  prompt: string
  summaryHardMaxTokens: number
}): Promise<CompactGenerationResult> {
  const compactModel = await resolveCompactModel({
    userId: params.userId,
    agent: params.agent,
    settings: params.settings
  })

  const result = await generateText({
    model: compactModel.model,
    messages: [{ role: 'user', content: params.prompt }],
    providerOptions: compactModel.providerOptions,
    ...compactModel.generationSettings,
    maxOutputTokens: Math.min(
      compactModel.generationSettings.maxOutputTokens,
      params.summaryHardMaxTokens
    )
  })

  const summary = result.text?.trim()
  if (!summary) {
    throw new Error('Compact model returned an empty summary.')
  }

  return {
    summary,
    modelLabel: compactModel.label,
    provider: compactModel.provider,
    modelId: compactModel.effectiveModelId
  }
}

function buildCliCompactWorkerPrompt(prompt: string) {
  return [
    'You are running as Batshit\'s hidden CLI compact worker. This is maintenance work for context continuity, not a normal visible assistant reply.',
    'Return only the compact summary. Do not call tools, run shell commands, inspect files, use web search, ask follow-up questions, or mention these worker instructions.',
    'Remember: manually unzipped zip items and active clips remain live in the next Primary Agent context, so mention them only when their existence or purpose matters.',
    '',
    prompt
  ].join('\n')
}

async function generateCodexCliCompactSummary(params: {
  userId: string
  agent: AgentRecord
  prompt: string
}): Promise<CompactGenerationResult> {
  const { CodexBridge } = await import('$lib/server/services/codexBridge')
  const bridge = new CodexBridge()
  const codexSettings = buildCodexRuntimeSettings(
    params.agent.codex_settings ?? params.agent.provider_specific_settings ?? null
  )
  const result = await bridge.generateHiddenText({
    prompt: buildCliCompactWorkerPrompt(params.prompt),
    userId: params.userId,
    agentId: params.agent.id,
    model: params.agent.primary_model_name,
    providerSettings: params.agent.provider_specific_settings ?? null,
    codexSettings
  })

  return {
    summary: result.text,
    modelLabel: result.modelLabel,
    provider: 'openai-codex',
    modelId: result.modelId
  }
}

async function generateCompactSummary(params: {
  userId: string
  agent: AgentRecord
  settings: EffectiveAutoCompactSettings
  prompt: string
  summaryHardMaxTokens: number
}): Promise<CompactGenerationResult> {
  if (params.settings.modelMode === 'current') {
    const runtime = resolveCurrentModelCompactRuntime(params.agent)
    if (runtime === 'codex-cli') {
      return generateCodexCliCompactSummary({
        userId: params.userId,
        agent: params.agent,
        prompt: params.prompt
      })
    }
    if (runtime === 'claude-cli') {
      throw new Error(
        'Current-model compacting for Claude CLI is not implemented yet. Choose an API-compatible saved compact model preset.'
      )
    }
    if (runtime === 'n8n') {
      throw new Error(
        'Current-model compacting is not available for n8n Primary Agents. Choose an API-compatible saved compact model preset.'
      )
    }
  }

  return generateApiCompactSummary(params)
}

function buildCompactPrompt(params: {
  settings: EffectiveAutoCompactSettings
  transcript: string
  liveProtectedNote: string
  summarySoftTargetTokens: number
  summaryHardMaxTokens: number
}) {
  const protectedBlock = params.liveProtectedNote
    ? `\n\nLIVE ITEMS THAT STAY OUTSIDE THE SUMMARY:\n${params.liveProtectedNote}`
    : ''

  return [
    params.settings.prompt,
    protectedBlock,
    '',
    'SUMMARY BUDGET:',
    `Aim for roughly ${params.summarySoftTargetTokens.toLocaleString()} tokens when that is enough to preserve continuity. Do not exceed about ${params.summaryHardMaxTokens.toLocaleString()} tokens unless the alternative would lose important live task state. The exact number is not the goal; useful continuity is the goal.`,
    '',
    'OLD CONVERSATION SEGMENT TO COMPACT:',
    params.transcript
  ].join('\n')
}

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const body = await request.json()
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    const mode: AutoCompactEventMode = body?.mode === 'auto' ? 'auto' : 'manual'
    const previewOnly = body?.previewOnly === true

    if (!sessionId || !agentId) {
      return json({ error: 'Session ID and agent ID are required' }, { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const [session, agent, userSettings, protections] = await Promise.all([
      redis.getSession(sessionId),
      redis.get(`agent:${agentId}`) as Promise<AgentRecord | null>,
      redis.getUserSettings(user.value.id),
      loadContextProtections(sessionId)
    ])

    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    if (!agent || agent.user_id !== user.value.id) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    const globalSettings = normalizeGlobalAutoCompactSettings(
      userSettings?.global_auto_compact_settings
    )
    const effectiveSettings = resolveEffectiveAutoCompactSettings({
      global: globalSettings,
      agent: agent.auto_compact_settings
    })

    if (mode === 'auto' && effectiveSettings.mode === 'off') {
      return json({ error: 'Auto Compact is disabled for this agent.' }, { status: 400 })
    }

    const messagesFromBody = normalizeMessages(body?.messages)
    const messages = messagesFromBody.length > 0
      ? messagesFromBody
      : await redis.getSessionMessages(sessionId)

    const compactionState = getContextCompactionState(session.metadata ?? null)
    const selection = selectMessagesForCompaction(messages, compactionState.events, {
      protections
    })

    if (selection.compactedMessageCount <= 0) {
      return json({
        error: 'No older unprotected messages are available to compact.',
        code: 'no_compaction_candidates',
        protectedMessageCount: selection.protectedMessageCount
      }, { status: 400 })
    }

    const beforeEstimate = await estimateCurrentContextTokens({
      sessionId,
      messages,
      agent,
      userId: user.value.id,
      agentTypeHint: typeof body?.agentType === 'string' ? body.agentType : undefined,
      trimmedMessageIds: Array.isArray(body?.trimmedMessageIds) ? body.trimmedMessageIds : [],
      eventFetch
    })
    const summaryBudget = resolveCompactSummaryBudget({
      contextLimit: beforeEstimate.budget.contextLimit,
      sourceTokenEstimate: selection.sourceTokenEstimate
    })

    if (previewOnly) {
      return json({
        success: true,
        previewOnly: true,
        selection,
        compactedMessageIds: selection.sourceMessageIds,
        protectedMessageCount: selection.protectedMessageCount,
        sourceTokenEstimate: selection.sourceTokenEstimate,
        summaryBudget,
        beforeBudget: beforeEstimate.budget,
        beforeTokens: beforeEstimate.tokens
      })
    }

    const transcript = buildCompactionTranscript(selection.sourceMessages)
    const liveProtectedNote = buildLiveProtectedItemsNote({
      protectedMessageIds: selection.protectedMessageIds,
      protectedUnzippedZipIds: protections.protectedUnzippedZipIds,
      activeClipIds: protections.activeClipIds
    })
    const prompt = buildCompactPrompt({
      settings: effectiveSettings,
      transcript,
      liveProtectedNote,
      summarySoftTargetTokens: summaryBudget.softTargetTokens,
      summaryHardMaxTokens: summaryBudget.hardMaxTokens
    })

    const compactResult = await generateCompactSummary({
      userId: user.value.id,
      agent,
      settings: effectiveSettings,
      prompt,
      summaryHardMaxTokens: summaryBudget.hardMaxTokens
    })

    const now = new Date().toISOString()
    const event: ContextCompactionEvent = {
      id: crypto.randomUUID(),
      createdAt: now,
      mode,
      agentId,
      compactedThroughMessageId: selection.compactedThroughMessageId,
      sourceMessageIds: selection.sourceMessageIds,
      protectedMessageIds: selection.protectedMessageIds,
      compactedMessageCount: selection.compactedMessageCount,
      protectedMessageCount: selection.protectedMessageCount,
      sourceTokenEstimate: selection.sourceTokenEstimate,
      summaryTokenEstimate: countTotalTokens([{ role: 'system', content: compactResult.summary }]),
      summarySoftTargetTokens: summaryBudget.softTargetTokens,
      summaryHardMaxTokens: summaryBudget.hardMaxTokens,
      modelMode: effectiveSettings.modelMode,
      modelPresetId: effectiveSettings.modelPresetId,
      modelLabel: compactResult.modelLabel,
      provider: compactResult.provider,
      modelId: compactResult.modelId,
      promptVersion: 1,
      summary: compactResult.summary
    }

    const nextMetadata = {
      ...(session.metadata ?? {}),
      contextCompaction: {
        version: 1,
        events: [...compactionState.events, event]
      }
    }
    await redis.updateSession(sessionId, { metadata: nextMetadata })

    const afterEstimate = await estimateCurrentContextTokens({
      sessionId,
      messages,
      agent,
      userId: user.value.id,
      agentTypeHint: typeof body?.agentType === 'string' ? body.agentType : undefined,
      trimmedMessageIds: Array.isArray(body?.trimmedMessageIds) ? body.trimmedMessageIds : [],
      eventFetch
    })

    const compactedTrimmedMessageIds = normalizeStringArray(body?.trimmedMessageIds)
      .filter((id) => selection.sourceMessageIds.includes(id))

    return json({
      success: true,
      event,
      contextCompaction: nextMetadata.contextCompaction,
      compactedMessageIds: selection.sourceMessageIds,
      compactedTrimmedMessageIds,
      protectedMessageCount: selection.protectedMessageCount,
      sourceTokenEstimate: selection.sourceTokenEstimate,
      summaryTokenEstimate: event.summaryTokenEstimate,
      summaryBudget,
      beforeBudget: beforeEstimate.budget,
      beforeTokens: beforeEstimate.tokens,
      afterBudget: afterEstimate.budget,
      afterTokens: afterEstimate.tokens,
      modelLabel: compactResult.modelLabel
    })
  } catch (error) {
    console.error('[context-compact] Failed to compact context:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to compact context' },
      { status: 500 }
    )
  }
}
