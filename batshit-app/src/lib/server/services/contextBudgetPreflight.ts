import { buildCodexPromptPackageFromMessages } from '$lib/server/services/codexBridge'
import { getSmartAutoCompactTriggerTokens } from '$lib/utils/contextCompaction'
import { countTotalTokens } from '$lib/utils/tokenCounter'

export type PromptBudgetRuntime = 'vercel' | 'codex' | 'claude' | 'n8n'
export type PromptBudgetStatus = 'safe' | 'compact_recommended' | 'blocked' | 'unknown'
export type PromptBudgetLimitStatus = 'safe' | 'near_limit' | 'blocked' | 'unknown'

export const CODEX_CLI_INPUT_CHAR_LIMIT = 1_048_576
export const CODEX_CLI_INPUT_CHAR_SAFETY_MARGIN = 32_768

export interface PromptBudgetReport {
  runtime: PromptBudgetRuntime
  compiledPromptTokens: number
  estimatedRuntimeTokens: number
  nativeOverheadTokens: number
  contextLimit: number | null
  contextRemainingTokens: number | null
  contextPercent: number | null
  outputReserveTokens: number
  safetyMarginTokens: number
  autoCompactTriggerTokens: number | null
  shouldAutoCompact: boolean
  tokenStatus: PromptBudgetLimitStatus
  runtimeHardLimitStatus: PromptBudgetLimitStatus
  runtimeHardLimitName: string | null
  packagedInputChars: number | null
  packagedInputCharLimit: number | null
  packagedInputSafeCharLimit: number | null
  packagedInputRemainingChars: number | null
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

export function countCodexPackagedInputChars(params: {
  messages: Array<{ role?: string; content: unknown; name?: string }>
  images?: Array<{ url: string; alt?: string }>
  extraRuntimeInputChars?: number
}): number {
  const promptPackage = buildCodexPromptPackageFromMessages({
    messages: params.messages,
    images: params.images
  })
  return (
    promptPackage.prompt.length +
    (promptPackage.developerInstructions?.length ?? 0) +
    Math.max(0, Math.round(params.extraRuntimeInputChars ?? 0))
  )
}

export function buildPromptBudgetReport(params: {
  runtime: PromptBudgetRuntime
  messages: Array<{ role?: string; content: unknown; name?: string }>
  images?: Array<{ url: string; alt?: string }>
  contextLimit?: number | null
  nativeOverheadTokens?: number
  outputReserveTokens?: number
  autoCompactTriggerTokens?: number | null
  extraRuntimeInputChars?: number
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

  let packagedInputChars: number | null = null
  let packagedInputCharLimit: number | null = null
  let packagedInputSafeCharLimit: number | null = null
  let packagedInputRemainingChars: number | null = null
  let runtimeHardLimitStatus: PromptBudgetLimitStatus = 'unknown'
  let runtimeHardLimitName: string | null = null

  if (runtime === 'codex') {
    packagedInputChars = countCodexPackagedInputChars({
      messages: params.messages,
      images: params.images,
      extraRuntimeInputChars: params.extraRuntimeInputChars
    })
    packagedInputCharLimit = CODEX_CLI_INPUT_CHAR_LIMIT
    packagedInputSafeCharLimit = CODEX_CLI_INPUT_CHAR_LIMIT - CODEX_CLI_INPUT_CHAR_SAFETY_MARGIN
    packagedInputRemainingChars = packagedInputSafeCharLimit - packagedInputChars
    runtimeHardLimitName = 'Codex CLI input character limit'
    runtimeHardLimitStatus =
      packagedInputChars > packagedInputSafeCharLimit
        ? 'blocked'
        : packagedInputChars > packagedInputSafeCharLimit - CODEX_CLI_INPUT_CHAR_SAFETY_MARGIN
          ? 'near_limit'
          : 'safe'
  } else {
    runtimeHardLimitStatus = 'safe'
  }

  const blocked = tokenStatus === 'blocked' || runtimeHardLimitStatus === 'blocked'
  const nearLimit = tokenStatus === 'near_limit' || runtimeHardLimitStatus === 'near_limit'
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
      : contextLimit === null && runtime !== 'codex'
        ? 'unknown'
        : 'safe'

  let reason = 'The compiled prompt is within the current runtime budget.'
  if (runtimeHardLimitStatus === 'blocked') {
    reason = `The packaged Codex CLI input is too large to launch safely. Compact context or return protected unzipped items to automatic before sending.`
  } else if (tokenStatus === 'blocked') {
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
    runtimeHardLimitStatus,
    runtimeHardLimitName,
    packagedInputChars,
    packagedInputCharLimit,
    packagedInputSafeCharLimit,
    packagedInputRemainingChars,
    canSend,
    status,
    reason
  }
}
