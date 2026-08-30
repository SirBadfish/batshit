/**
 * SA-104 P6 — shared summary-model generation ladder.
 *
 * Extracted verbatim from `/api/messages/compact` (which now imports it) so the
 * memory graduation writer and the nap can generate summaries through the exact same
 * model-resolution rules: API generation for API-compatible selections, the Codex CLI
 * hidden-text lane for current-model Codex agents, and loud refusals for Claude-CLI
 * and n8n current-model selections (choose an API-compatible preset instead). No
 * behavior change for the Compact feature — pure move.
 */

import { generateText } from 'ai'
import { redis } from '$lib/server/redis'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import { ProviderManager } from '$lib/server/services/providers'
import type { AgentRow } from '$lib/types/database'
import type { SavedModel, ModelConnectionInfo, ModelCapabilities } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { resolveCurrentModelCompactRuntime } from '$lib/utils/contextCompaction'

type AgentRecord = AgentRow & Record<string, any>

/** The explicit model choice a summary run uses (no hidden model selection). */
export interface SummaryModelChoice {
  modelMode: 'current' | 'preset'
  modelPresetId: string | null
}

export interface SummaryGenerationResult {
  summary: string
  modelLabel: string
  provider: string | null
  modelId: string | null
}

async function loadSavedModel(presetId: string | null): Promise<SavedModel | null> {
  if (!presetId) return null
  const model = await redis.get(`model:${presetId}`).catch(() => null)
  return model && typeof model === 'object' ? (model as SavedModel) : null
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

async function resolveSummaryModel(params: {
  userId: string
  agent: AgentRecord
  choice: SummaryModelChoice
}) {
  const agentType = normalizePrimaryAgentType(params.agent)
  if (params.choice.modelMode === 'current' && agentType !== 'api') {
    throw new Error(
      'Current-model compacting for this Primary Agent is not available through the direct API compact path. Choose an API-compatible saved compact model preset.'
    )
  }

  const preset =
    params.choice.modelMode === 'preset'
      ? await loadSavedModel(params.choice.modelPresetId)
      : null

  if (params.choice.modelMode === 'preset' && !preset) {
    throw new Error('The selected compact model preset was not found.')
  }

  const selection = resolveRuntimeModelSelection({
    preset,
    presetId: params.choice.modelPresetId,
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
        params.choice.modelMode === 'preset'
          ? preset?.settings?.temperature
          : params.agent.primary_model_temperature,
      maxTokens:
        params.choice.modelMode === 'preset'
          ? preset?.settings?.maxTokens
          : params.agent.primary_model_max_tokens,
      topP:
        params.choice.modelMode === 'preset'
          ? preset?.settings?.topP
          : params.agent.primary_model_top_p,
      topK:
        params.choice.modelMode === 'preset'
          ? preset?.settings?.topK
          : params.agent.primary_model_top_k,
      presencePenalty:
        params.choice.modelMode === 'preset'
          ? preset?.settings?.presencePenalty
          : params.agent.primary_model_presence_penalty,
      frequencyPenalty:
        params.choice.modelMode === 'preset'
          ? preset?.settings?.frequencyPenalty
          : params.agent.primary_model_frequency_penalty,
      seed:
        params.choice.modelMode === 'preset'
          ? preset?.settings?.seed
          : params.agent.primary_model_seed,
      stopSequences:
        params.choice.modelMode === 'preset'
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

async function generateApiSummary(params: {
  userId: string
  agent: AgentRecord
  choice: SummaryModelChoice
  prompt: string
  summaryHardMaxTokens: number
}): Promise<SummaryGenerationResult> {
  const summaryModel = await resolveSummaryModel({
    userId: params.userId,
    agent: params.agent,
    choice: params.choice
  })

  const result = await generateText({
    model: summaryModel.model,
    messages: [{ role: 'user', content: params.prompt }],
    providerOptions: summaryModel.providerOptions,
    ...summaryModel.generationSettings,
    maxOutputTokens: Math.min(
      summaryModel.generationSettings.maxOutputTokens,
      params.summaryHardMaxTokens
    )
  })

  const summary = result.text?.trim()
  if (!summary) {
    throw new Error('Compact model returned an empty summary.')
  }

  return {
    summary,
    modelLabel: summaryModel.label,
    provider: summaryModel.provider,
    modelId: summaryModel.effectiveModelId
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

async function generateCodexCliSummary(params: {
  userId: string
  agent: AgentRecord
  prompt: string
}): Promise<SummaryGenerationResult> {
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

/**
 * Generate a summary through the explicit model choice. 'current' rides the agent's
 * own runtime where that is possible (API generation; the Codex CLI hidden-text
 * worker) and refuses loudly where it is not (Claude CLI, n8n) — the caller's UI
 * names the preset fix. Never a silent fallback.
 */
export async function generateModelSummary(params: {
  userId: string
  agent: AgentRecord
  choice: SummaryModelChoice
  prompt: string
  summaryHardMaxTokens: number
}): Promise<SummaryGenerationResult> {
  if (params.choice.modelMode === 'current') {
    const runtime = resolveCurrentModelCompactRuntime(params.agent)
    if (runtime === 'codex-cli') {
      return generateCodexCliSummary({
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

  return generateApiSummary(params)
}
