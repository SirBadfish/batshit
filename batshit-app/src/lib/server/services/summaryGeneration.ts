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

import { generateText, streamText } from 'ai'
import { chatgptPlanAccountId } from '$lib/utils/chatgptPlanConnection'
import { getChatgptPlanRuntime } from './chatgptPlanHost'
import { PLAN_COMPACT, type PlanLease } from './chatgptPlanRuntime'
import { ChatgptPlanError } from './chatgptPlanVault'
import { isPlanSelection, assertPlanSettings, planProviderOptions } from './chatgptPlanInference'
import { estimateTokens } from '$lib/utils/tokens'
import { redis } from '$lib/server/redis'
import { buildCodexRuntimeSettings } from '$lib/server/services/codexSettings'
import { ProviderManager } from '$lib/server/services/providers'
import type { AgentRow } from '$lib/types/database'
import type { SavedModel, ModelConnectionInfo, ModelCapabilities } from '$lib/types/savedModels'
import type { ParameterValue } from '$lib/data/parameter-schemas'
import {
  buildRuntimeModelSettings,
  normalizeRuntimeMaxTokens,
  type RuntimeModelStandardSettings
} from '$lib/utils/modelSettingsMapper'
import { resolveModelIds } from '$lib/utils/modelIdResolver'
import { resolveAgentModelFallbacks, resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { loadRuntimeModelPreset } from '$lib/server/services/runtimeModelPreset'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { resolveCurrentModelCompactRuntime } from '$lib/utils/contextCompaction'

/**
 * SA-102 P1: Batshit's own bound on a summary/compact run's output length.
 * Not a user preset default — see the comment at its use site.
 */
const BATSHIT_SUMMARY_OUTPUT_TOKEN_BOUND = 6_000

/**
 * BL-622 (rule C6): how long one summary call on the API lane may take, the Codex lane's own limit
 * (`generateHiddenText`). A Compact or a nap waits on this call; with no limit a model that never
 * answered left the Compact's composer busy, with a Stop that stopped nothing, for as long as it
 * took.
 */
export const SUMMARY_CALL_LIMIT_MS = 180_000

export class SummaryCallLimitError extends Error {
  readonly code = 'summary_call_limit'
  constructor() {
    super(`The summary model did not answer within ${SUMMARY_CALL_LIMIT_MS / 1000} seconds.`)
    this.name = 'SummaryCallLimitError'
  }
}

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

/**
 * The values a compact-model PRESET fills in where its own settings left a gap (the choice made
 * for this Compact, not the agent's model). The agent's "current model" takes its fallbacks from
 * `resolveAgentModelFallbacks` instead.
 */
function compactPresetFallbacks(preset: SavedModel | null): RuntimeModelStandardSettings {
  const settings = preset?.settings
  return {
    temperature: settings?.temperature,
    maxTokens: settings?.maxTokens,
    topP: settings?.topP,
    topK: settings?.topK,
    presencePenalty: settings?.presencePenalty,
    frequencyPenalty: settings?.frequencyPenalty,
    seed: settings?.seed,
    stopSequences: settings?.stopSequences
  }
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

  const compactPreset =
    params.choice.modelMode === 'preset'
      ? await loadSavedModel(params.choice.modelPresetId)
      : null

  if (params.choice.modelMode === 'preset' && !compactPreset) {
    throw new Error('The selected compact model preset was not found.')
  }

  // BL-801: "current model" is the agent's own model, and an agent that names a preset runs on
  // that preset as it is now, read fresh the way the send path does since BL-515. The agent's
  // copied model, connection and settings are what the picker stored when the preset was picked;
  // a preset edited since is not what the Compact would have run on. A preset that is gone fails
  // loudly with the send path's own error, never quietly on the copies. An agent that names no
  // preset (a record from before presets) keeps its copies.
  const agentPreset =
    params.choice.modelMode === 'current'
      ? await loadRuntimeModelPreset(params.agent.primary_model_preset_id, 'primary')
      : null
  const preset = compactPreset ?? agentPreset

  const selection = resolveRuntimeModelSelection({
    preset,
    presetId: compactPreset ? params.choice.modelPresetId : params.agent.primary_model_preset_id ?? null,
    provider: params.agent.primary_model_provider,
    modelId: params.agent.primary_model_name,
    connection: compactPreset
      ? resolveSavedModelConnection(compactPreset)
      : params.agent.primary_model_connection ?? null,
    capabilities: (preset?.capabilities ?? params.agent.primary_model_capabilities ?? null) as ModelCapabilities | null,
    // The compact preset's own settings; for the agent's model, the agent's bag, of which the
    // resolver keeps only the agent's own keys when a preset is named (BL-515).
    settings: (compactPreset?.settings ?? params.agent.provider_specific_settings ?? null) as Record<string, any> | null
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
    effectiveModelId: selection.effectiveModelId,
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
    fallbacks:
      params.choice.modelMode === 'preset'
        ? compactPresetFallbacks(compactPreset)
        : resolveAgentModelFallbacks({ preset: agentPreset, agent: params.agent })
  })

  const plan = isPlanSelection(selection.connection)
  if (plan) assertPlanSettings(selection.settings)
  const model = plan ? null : (await ProviderManager.createForUser(params.userId)).getModel(effectiveModelId, {
    transport: selection.connection?.type,
    service: selection.connection?.service ?? null,
    allowAutoFallback: false
  })

  return {
    plan,
    connection: selection.connection,
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
      // SA-102 P1 (DL-102-01): this is deliberately NOT the invented default the
      // story removed from send-routed. A summary/compact run is Batshit's own
      // operation, not a user message, so it is not "a parameter left empty in a
      // Model Preset" — and it must stay bounded, because an unbounded summary
      // can be larger than the context window compaction exists to relieve.
      // Kept as an explicit, named, context-clamped operational bound.
      maxOutputTokens:
        runtimeSettings.standard.maxTokens ??
        normalizeRuntimeMaxTokens({
          maxTokens: BATSHIT_SUMMARY_OUTPUT_TOKEN_BOUND,
          provider: resolvedIds?.developerId ?? selection.provider,
          modelId: resolvedIds?.modelId ?? selection.modelId,
          connection: selection.connection,
          contextWindow: selection.contextWindow
        }) ??
        BATSHIT_SUMMARY_OUTPUT_TOKEN_BOUND,
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
  abortSignal?: AbortSignal
  retainPlanLease?: (lease: PlanLease) => void
}): Promise<SummaryGenerationResult> {
  const summaryModel = await resolveSummaryModel({
    userId: params.userId,
    agent: params.agent,
    choice: params.choice
  })

  // BL-622 (C6): the call ends at its limit, or when its caller stops it (a Compact's Stop).
  const limit = new AbortController()
  const limitTimer = setTimeout(() => limit.abort(new SummaryCallLimitError()), SUMMARY_CALL_LIMIT_MS)
  limitTimer.unref?.()
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, limit.signal])
    : limit.signal
  let result: { text: string }
  try {
    if (summaryModel.plan) {
      // Only Compact's route accepts responsibility through its actual writes.
      // Shared memory/nap callers cannot silently acquire this grant.
      if (!params.retainPlanLease) throw new ChatgptPlanError('consumer_unsupported', 'This summary feature cannot use ChatGPT plan credentials. Choose a separate API-compatible summary preset.')
      const runtime = getChatgptPlanRuntime(), accountId = chatgptPlanAccountId(summaryModel.connection?.id)
      if (!accountId) throw new ChatgptPlanError('connection_invalid', 'Choose the connected ChatGPT account again.')
      const lease = runtime.acquire(params.userId, accountId, PLAN_COMPACT, abortSignal)
      try { params.retainPlanLease(lease) } catch (error) { lease.release(); throw error }
      const streaming = streamText({ model: runtime.model(lease, summaryModel.effectiveModelId), messages: [{ role: 'user', content: params.prompt }], providerOptions: planProviderOptions(summaryModel.providerOptions), abortSignal: lease.signal, maxRetries: 0, onError: () => {} })
      let text = ''
      for await (const part of streaming.stream) {
        if (part.type === 'error') throw part.error
        if (part.type === 'text-delta') {
          text += part.text
          if (estimateTokens(text) > params.summaryHardMaxTokens) {
            limit.abort('summary_output_limit')
            throw new ChatgptPlanError('summary_output_limit', 'ChatGPT exceeded the Compact summary budget. Nothing was compacted. Choose a larger summary budget or another summary preset.')
          }
        }
      }
      runtime.assertLease(lease)
      result = { text }
    } else {
    result = await generateText({
      model: summaryModel.model!,
      messages: [{ role: 'user', content: params.prompt }],
      providerOptions: summaryModel.providerOptions,
      ...summaryModel.generationSettings,
      maxOutputTokens: Math.min(
        summaryModel.generationSettings.maxOutputTokens,
        params.summaryHardMaxTokens
      ),
      abortSignal
    })
    }
  } catch (error) {
    if (limit.signal.reason instanceof SummaryCallLimitError) throw limit.signal.reason
    throw error
  } finally {
    clearTimeout(limitTimer)
  }

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
  abortSignal?: AbortSignal
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
    codexSettings,
    abortSignal: params.abortSignal
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
  /**
   * A Compact's Stop ends its API or hidden Codex summary. API calls also end at
   * `SUMMARY_CALL_LIMIT_MS`; the Codex worker retains its own independent 180 s limit.
   */
  abortSignal?: AbortSignal
  /** Internal Compact owner, absent from shared memory/nap consumers. */
  retainPlanLease?: (lease: PlanLease) => void
}): Promise<SummaryGenerationResult> {
  if (params.choice.modelMode === 'current') {
    const runtime = resolveCurrentModelCompactRuntime(params.agent)
    if (runtime === 'codex-cli') {
      return generateCodexCliSummary({
        userId: params.userId,
        agent: params.agent,
        prompt: params.prompt,
        abortSignal: params.abortSignal
      })
    }
    if (runtime === 'claude-cli') {
      throw new Error(
        'Current-model compacting for Claude CLI is not implemented yet. Choose an API-compatible saved compact model preset.'
      )
    }
    if (runtime === 'n8n') {
      throw new Error(
        'Current-model compacting cannot run for a record that uses the retired n8n Primary Agent type. Delete that agent and create an API or CLI agent.'
      )
    }
  }

  return generateApiSummary(params)
}
