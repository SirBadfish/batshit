import type { LocalContextBudgetEvidence } from '$lib/types/localContextBudget'
import { getSmartAutoCompactTriggerTokens } from '$lib/utils/contextCompaction'
import { countTotalTokens } from '$lib/utils/tokenCounter'

export type PromptBudgetRuntime = 'vercel' | 'claude' | 'n8n'
export type PromptBudgetStatus = 'safe' | 'compact_recommended' | 'blocked' | 'unknown'
export type PromptBudgetLimitStatus = 'safe' | 'near_limit' | 'blocked' | 'unknown'

export interface PromptBudgetReport {
  runtime: PromptBudgetRuntime
  compiledPromptTokens: number
  estimatedRuntimeTokens: number
  nativeOverheadTokens: number
  contextLimit: number | null
  localContext?: LocalContextBudgetEvidence | null
  /** Optional saved CLI telemetry failed; never substitute a guessed denominator. */
  contextWindowWarning?: string | null
  /** Server lookup completion time; browser receipt time cannot order evidence. */
  contextWindowCheckedAt?: number
  /** Same privacy-safe model/settings identity used by saved CLI window reports. */
  contextWindowSettingsKey?: string | null
  contextRemainingTokens: number | null
  contextPercent: number | null
  outputReserveTokens: number
  safetyMarginTokens: number
  autoCompactTriggerTokens: number | null
  shouldAutoCompact: boolean
  tokenStatus: PromptBudgetLimitStatus
  canSend: boolean
  status: PromptBudgetStatus
  reason: string
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

function clampPercent(value: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null
  return Math.max(0, Math.min((value / limit) * 100, 100))
}

function normalizeCompiledMessages(
  messages: Array<{ role?: string; content: unknown; name?: string }>
) {
  return messages.map((message) => ({
    role: typeof message.role === 'string' && message.role ? message.role : 'user',
    content: message.content
  }))
}

export function countCompiledPromptTokens(
  messages: Array<{ role?: string; content: unknown; name?: string }>
): number {
  return countTotalTokens(normalizeCompiledMessages(messages))
}

export function resolveBudgetOutputReserve(params: {
  maxOutputTokens?: number | null
  contextLimit?: number | null
  reasoningModel?: boolean | null
}): number {
  const explicit = normalizePositiveInteger(params.maxOutputTokens)
  if (explicit !== null) return explicit

  const limit = normalizePositiveInteger(params.contextLimit)
  if (params.reasoningModel && limit) {
    return Math.min(25_000, Math.max(8_000, Math.round(limit * 0.08)))
  }

  return 0
}

export function buildPromptBudgetReport(params: {
  runtime: PromptBudgetRuntime
  messages: Array<{ role?: string; content: unknown; name?: string }>
  contextLimit?: number | null
  nativeOverheadTokens?: number
  outputReserveTokens?: number
  autoCompactTriggerTokens?: number | null
}): PromptBudgetReport {
  const runtime = params.runtime
  const contextLimit = normalizePositiveInteger(params.contextLimit)
  const compiledPromptTokens = countCompiledPromptTokens(params.messages)
  const nativeOverheadTokens = Math.max(0, Math.round(params.nativeOverheadTokens ?? 0))
  const estimatedRuntimeTokens = compiledPromptTokens + nativeOverheadTokens
  const outputReserveTokens = Math.max(0, Math.round(params.outputReserveTokens ?? 0))
  const autoCompactTriggerTokens =
    typeof params.autoCompactTriggerTokens === 'number' &&
    Number.isFinite(params.autoCompactTriggerTokens) &&
    params.autoCompactTriggerTokens > 0
      ? Math.round(params.autoCompactTriggerTokens)
      : contextLimit
        ? getSmartAutoCompactTriggerTokens(contextLimit)
        : null
  const contextRemainingTokens =
    contextLimit !== null ? contextLimit - estimatedRuntimeTokens : null
  const contextPercent = clampPercent(estimatedRuntimeTokens, contextLimit)
  const safetyMarginTokens =
    contextLimit !== null
      ? Math.max(outputReserveTokens, autoCompactTriggerTokens ?? 0)
      : outputReserveTokens

  let tokenStatus: PromptBudgetLimitStatus = 'unknown'
  if (contextLimit !== null) {
    if (estimatedRuntimeTokens + outputReserveTokens > contextLimit) {
      tokenStatus = 'blocked'
    } else if (
      autoCompactTriggerTokens !== null &&
      contextRemainingTokens !== null &&
      contextRemainingTokens <= autoCompactTriggerTokens
    ) {
      tokenStatus = 'near_limit'
    } else {
      tokenStatus = 'safe'
    }
  }

  const blocked = tokenStatus === 'blocked'
  const nearLimit = tokenStatus === 'near_limit'
  const canSend = !blocked
  const shouldAutoCompact = Boolean(
    !blocked &&
    contextLimit !== null &&
    autoCompactTriggerTokens !== null &&
    contextRemainingTokens !== null &&
    contextRemainingTokens <= autoCompactTriggerTokens
  )
  const status: PromptBudgetStatus = blocked
    ? 'blocked'
    : nearLimit || shouldAutoCompact
      ? 'compact_recommended'
      : contextLimit === null
        ? 'unknown'
        : 'safe'

  let reason = 'The compiled prompt is within the current runtime budget.'
  if (tokenStatus === 'blocked') {
    reason = 'The compiled prompt plus output headroom is larger than the selected model context window.'
  } else if (status === 'compact_recommended') {
    reason = 'The compiled prompt is near the configured Auto Compact safety margin.'
  } else if (status === 'unknown') {
    reason = 'Batshit could not resolve a model context limit for this runtime.'
  }

  return {
    runtime,
    compiledPromptTokens,
    estimatedRuntimeTokens,
    nativeOverheadTokens,
    contextLimit,
    contextRemainingTokens,
    contextPercent,
    outputReserveTokens,
    safetyMarginTokens,
    autoCompactTriggerTokens,
    shouldAutoCompact,
    tokenStatus,
    canSend,
    status,
    reason
  }
}
