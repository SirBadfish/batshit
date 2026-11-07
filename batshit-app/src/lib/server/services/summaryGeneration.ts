/**
 * SA-104 P6 — shared summary-model generation ladder.
 *
 * Extracted verbatim from `/api/messages/compact` (which now imports it) so the
 * memory graduation writer and the nap can generate summaries through the exact same
 * model-resolution rules: API generation for API-compatible selections, and loud refusals
 * for a retired Primary Agent type (SA-139 R4) and for CLI or n8n-only model selections
 * (choose an API-compatible preset instead).
 */

import { captureAgentLocalReasoning } from './localModelReasoning'
import { generateText, streamText } from 'ai'
import { chatgptPlanAccountId } from '$lib/utils/chatgptPlanConnection'
import { getChatgptPlanRuntime } from './chatgptPlanHost'
import { PLAN_COMPACT, type PlanLease } from './chatgptPlanRuntime'
import { ChatgptPlanError } from './chatgptPlanVault'
import { isPlanSelection, assertPlanSettings, planProviderOptions } from './chatgptPlanInference'
import { CLAUDE_PLAN_SERVICE, isClaudePlanSelection } from '$lib/utils/claudePlanConnection'
import { admitClaudePlanSelection, ClaudePlanError } from './claudePlanAdmission'
import { estimateTokens } from '$lib/utils/tokens'
import { redis } from '$lib/server/redis'
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
import { retiredPrimaryAgentRefusal } from '$lib/utils/primaryAgentType'
import { namesRetiredCodexCliModel } from '$lib/utils/cliRuntimeIdentity'

/**
 * SA-102 P1: Batshit's own bound on a summary/compact run's output length.
 * Not a user preset default — see the comment at its use site.
 */
const BATSHIT_SUMMARY_OUTPUT_TOKEN_BOUND = 6_000

/**
 * BL-622 (rule C6): how long one summary call on the API lane may take. A Compact or a nap waits on this call; with no limit a model that never
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
  // A model id that merely contains "codex" (an OpenAI API model) is not a CLI selection, and
  // neither is a custom provider whose slug contains it: the retired Codex CLI is named by its
  // exact ids only (SA-139 R3, Faye S12).
  return (
    namesRetiredCodexCliModel({ primary_model_provider: params.provider, primary_model_connection: params.connection }) ||
    provider.includes('claude-cli') ||
    modelId.includes('claude-cli') ||
    // SA-139 (D1): only the Claude Code CLI lane; the Claude plan connection is an API connection.
    connection.includes('claude-cli')
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
  abortSignal?: AbortSignal
}) {
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

  const selectionArgs = {
    preset,
    reasoningOverrides: params.choice.modelMode === 'current' ? params.agent.model_reasoning_overrides : null,
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
  }
  const localReasoningSnapshot = params.choice.modelMode === 'current'
    ? await captureAgentLocalReasoning(params.userId, selectionArgs, params.agent.model_reasoning_overrides, params.abortSignal) : undefined
  const selection = resolveRuntimeModelSelection({ ...selectionArgs, localReasoning: localReasoningSnapshot?.contract })

  if (isCliLikeSelection({
    provider: selection.provider,
    modelId: selection.modelId,
    connection: selection.connection
  })) {
    throw new Error(
      'Compact cannot run through CLI model presets, which Batshit no longer supports. Choose an API-compatible saved model preset for compacting.'
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
    localReasoning: localReasoningSnapshot?.contract,
    localReasoningConnectionKey: localReasoningSnapshot?.connectionKey,
    explicitReasoning: selection.explicitReasoning,
    provider: resolvedIds?.developerId ?? selection.provider,
    modelId: localReasoningSnapshot ? effectiveModelId : resolvedIds?.modelId ?? selection.modelId,
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
  // SA-139 P4 (D11): a Claude plan selection runs only through its own admission and run
  // (`generateClaudePlanSummary`), never ProviderManager. Its sampling check gets the same raw
  // fallbacks the summary would otherwise send, so none is dropped silently.
  const claudePlan = isClaudePlanSelection(selection.connection)
    ? { connection: selection.connection!, modelId: selection.modelId ?? effectiveModelId, settings: (selection.settings ?? null) as Record<string, unknown> | null,
        sampling: params.choice.modelMode === 'preset' ? null : resolveAgentModelFallbacks({ preset: agentPreset, agent: params.agent }) ?? null }
    : null
  const model = plan || claudePlan ? null : (await ProviderManager.createForUser(params.userId)).getModel(effectiveModelId, {
    transport: selection.connection?.type,
    service: selection.connection?.service ?? null,
    connectionId: selection.connection?.id ?? null,
    allowAutoFallback: false
  })

  return {
    plan,
    claudePlan,
    connection: selection.connection,
    model,
    effectiveModelId,
    provider: claudePlan ? CLAUDE_PLAN_SERVICE :
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

/** The chat a Claude plan Compact belongs to: its run is that chat's, so the chat's delete or restore ends it. */
export type ClaudePlanCompactOwner = { sessionId: string }

/**
 * SA-139 P4 (D11): plain Compact on the Claude plan. Central admission (consumer `compact`) comes
 * first, so a refusal starts nothing; then one Claude Code run with no tools, in the Default Project
 * Directory (Compact reads no project), ended once the summary is read. Claude Code takes no output
 * limit or sampling, so none is sent; the summary budget is counted here, as on the ChatGPT plan.
 * Other summary callers (memory graduation, naps) pass no Compact owner and are refused readably.
 */
async function generateClaudePlanSummary(params: {
  userId: string
  agent: AgentRecord
  selection: { connection: ModelConnectionInfo; modelId: string; settings: Record<string, unknown> | null; sampling: Readonly<object> | null }
  claudePlanCompact?: ClaudePlanCompactOwner
  prompt: string
  summaryHardMaxTokens: number
  abortSignal: AbortSignal
  limit: AbortController
}): Promise<{ text: string }> {
  if (!params.claudePlanCompact) {
    throw new ClaudePlanError('consumer_unsupported', 'This summary feature cannot use the Claude plan. Choose a separate API-compatible summary preset. Nothing ran.')
  }
  const sampling = params.selection.sampling
    ? Object.fromEntries(Object.entries(params.selection.sampling).filter(([, value]) => !(Array.isArray(value) && value.length === 0)))
    : null
  const [{ readClaudePlanReadiness }, runtime] = await Promise.all([import('./claudePlanReadiness'), import('./claudePlanModel')])
  const admission = await admitClaudePlanSelection({
    connection: params.selection.connection,
    modelId: params.selection.modelId,
    settings: params.selection.settings,
    sampling,
    consumer: 'compact',
    readiness: () => readClaudePlanReadiness()
  })
  params.abortSignal.throwIfAborted()
  const model = new runtime.ClaudePlanModel({
    modelId: admission.modelId,
    cliModel: admission.cliModel,
    effort: admission.effort,
    alwaysThinking: admission.alwaysThinking,
    owner: { userId: params.userId, sessionId: params.claudePlanCompact.sessionId, agentId: typeof params.agent.id === 'string' ? params.agent.id : null, kind: 'primary' },
    workingDirectory: await runtime.resolveClaudePlanWorkingDirectory({ userId: params.userId, projectPath: null })
  })
  try {
    const streaming = streamText({ model, messages: [{ role: 'user', content: params.prompt }], abortSignal: params.abortSignal, maxRetries: 0, onError: () => {} })
    let text = ''
    for await (const part of streaming.stream) {
      if (part.type === 'error') throw part.error
      // BL-2368: Compact offers no tools, so any call (a misnamed one the run lets through) means the words
      // so far are not a summary: nothing is compacted.
      if (part.type === 'tool-input-start' || part.type === 'tool-call' || part.type === 'tool-error' || part.type === 'tool-result') {
        throw new ClaudePlanError('summary_tool_call', 'Claude asked for a tool during Compact, which offers none, so nothing was compacted. Try Compact again.')
      }
      if (part.type === 'text-delta') {
        text += part.text
        if (estimateTokens(text) > params.summaryHardMaxTokens) {
          params.limit.abort('summary_output_limit')
          throw new ClaudePlanError('summary_output_limit', 'Claude exceeded the Compact summary budget. Nothing was compacted. Choose a larger summary budget or another summary preset.')
        }
      }
    }
    return { text }
  } finally {
    model.endReply()
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
  claudePlanCompact?: ClaudePlanCompactOwner
}): Promise<SummaryGenerationResult> {
  const summaryModel = await resolveSummaryModel({
    userId: params.userId,
    agent: params.agent,
    choice: params.choice, abortSignal: params.abortSignal
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
    if (summaryModel.claudePlan) {
      result = await generateClaudePlanSummary({ ...params, selection: summaryModel.claudePlan, abortSignal, limit })
    } else if (summaryModel.plan) {
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

/**
 * Generate a summary through the explicit model choice ('current' rides the agent's own API
 * model, 'preset' a saved compact preset). SA-139 R4 (D14): a retired Primary Agent type
 * (the Claude Code CLI lane, Codex CLI, n8n) is refused loudly in BOTH modes, before any
 * model call. Never a silent fallback.
 */
export async function generateModelSummary(params: {
  userId: string
  agent: AgentRecord
  choice: SummaryModelChoice
  prompt: string
  summaryHardMaxTokens: number
  /**
   * A Compact's Stop ends its API summary. API calls also end at `SUMMARY_CALL_LIMIT_MS`.
   */
  abortSignal?: AbortSignal
  /** Internal Compact owner, absent from shared memory/nap consumers. */
  retainPlanLease?: (lease: PlanLease) => void
  /** The Claude plan's Compact owner (its chat), set only by the Compact route (SA-139 P4, D11). */
  claudePlanCompact?: ClaudePlanCompactOwner
}): Promise<SummaryGenerationResult> {
  const retired = retiredPrimaryAgentRefusal(params.agent)
  if (retired) throw new Error(`${retired.error} ${retired.details}`)

  return generateApiSummary(params)
}
