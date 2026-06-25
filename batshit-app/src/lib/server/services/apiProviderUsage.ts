export type ApiUsageLike =
  | {
      inputTokens?: number | undefined
      outputTokens?: number | undefined
      totalTokens?: number | undefined
      reasoningTokens?: number | undefined
      cachedInputTokens?: number | undefined
      cacheCreationInputTokens?: number | undefined
      inputTokenDetails?:
        | {
            cacheReadTokens?: number | undefined
          }
        | undefined
      outputTokenDetails?:
        | {
            reasoningTokens?: number | undefined
          }
        | undefined
    }
  | null
  | undefined

export function coerceTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function buildUsageLike(values: NonNullable<ApiUsageLike>): ApiUsageLike {
  const usage: NonNullable<ApiUsageLike> = {}
  if (typeof values.inputTokens === 'number') {
    usage.inputTokens = values.inputTokens
  }
  if (typeof values.outputTokens === 'number') {
    usage.outputTokens = values.outputTokens
  }
  if (typeof values.totalTokens === 'number') {
    usage.totalTokens = values.totalTokens
  }
  if (typeof values.reasoningTokens === 'number') {
    usage.reasoningTokens = values.reasoningTokens
  }
  if (typeof values.cachedInputTokens === 'number') {
    usage.cachedInputTokens = values.cachedInputTokens
    usage.inputTokenDetails = {
      ...(usage.inputTokenDetails ?? {}),
      cacheReadTokens: values.cachedInputTokens,
    }
  }
  if (typeof values.cacheCreationInputTokens === 'number') {
    usage.cacheCreationInputTokens = values.cacheCreationInputTokens
  }

  return Object.keys(usage).length > 0 ? usage : null
}

export function mergeUsageLike(
  base: ApiUsageLike,
  incoming: NonNullable<ApiUsageLike>,
): NonNullable<ApiUsageLike> {
  const cachedInputTokens =
    incoming.cachedInputTokens ??
    incoming.inputTokenDetails?.cacheReadTokens ??
    base?.cachedInputTokens ??
    base?.inputTokenDetails?.cacheReadTokens
  const reasoningTokens =
    incoming.reasoningTokens ??
    incoming.outputTokenDetails?.reasoningTokens ??
    base?.reasoningTokens ??
    base?.outputTokenDetails?.reasoningTokens

  return {
    inputTokens: incoming.inputTokens ?? base?.inputTokens,
    outputTokens: incoming.outputTokens ?? base?.outputTokens,
    totalTokens: incoming.totalTokens ?? base?.totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationInputTokens:
      incoming.cacheCreationInputTokens ?? base?.cacheCreationInputTokens,
    ...(typeof cachedInputTokens === 'number'
      ? { inputTokenDetails: { cacheReadTokens: cachedInputTokens } }
      : {}),
    ...(typeof reasoningTokens === 'number'
      ? { outputTokenDetails: { reasoningTokens } }
      : {}),
  }
}

export function hasUsageValues(usage: ApiUsageLike): boolean {
  return (
    typeof usage?.inputTokens === 'number' ||
    typeof usage?.outputTokens === 'number' ||
    typeof usage?.totalTokens === 'number' ||
    typeof usage?.cachedInputTokens === 'number' ||
    typeof usage?.inputTokenDetails?.cacheReadTokens === 'number' ||
    typeof usage?.cacheCreationInputTokens === 'number'
  )
}

export function outputTokensForUsage(usage: ApiUsageLike): number | undefined {
  return coerceTokenCount(usage?.outputTokens)
}

function plainObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, any>
}

function firstTokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const count = coerceTokenCount(value)
    if (typeof count === 'number') return count
  }
  return undefined
}

function normalizeAiSdkV6Usage(usage: Record<string, any>): ApiUsageLike {
  const inputObject = plainObject(usage.inputTokens)
  const outputObject = plainObject(usage.outputTokens)

  if (!inputObject && !outputObject) return null

  const input = firstTokenCount(inputObject?.total, usage.inputTokenCount)
  const output = firstTokenCount(outputObject?.total, usage.outputTokenCount)
  const reasoning = firstTokenCount(
    outputObject?.reasoning,
    usage.reasoningTokens,
    usage.outputTokenDetails?.reasoningTokens,
  )
  const cachedInput = firstTokenCount(
    inputObject?.cacheRead,
    usage.cachedInputTokens,
    usage.inputTokenDetails?.cacheReadTokens,
  )
  const cacheCreationInput = firstTokenCount(
    inputObject?.cacheWrite,
    usage.cacheCreationInputTokens,
  )
  const total = firstTokenCount(
    usage.totalTokens,
    typeof input === 'number' && typeof output === 'number'
      ? input + output
      : undefined,
  )

  return buildUsageLike({
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: reasoning,
    cachedInputTokens: cachedInput,
    cacheCreationInputTokens: cacheCreationInput,
  })
}

function normalizeGeminiUsage(usage: Record<string, any>): ApiUsageLike {
  const input = firstTokenCount(
    usage.promptTokenCount,
    usage.prompt_tokens,
    usage.promptTokens,
  )
  const total = firstTokenCount(
    usage.totalTokenCount,
    usage.total_tokens,
    usage.totalTokens,
  )
  const candidates = firstTokenCount(
    usage.candidatesTokenCount,
    usage.candidates_tokens,
    usage.candidatesTokens,
  )
  const thoughts = firstTokenCount(
    usage.thoughtsTokenCount,
    usage.thoughts_tokens,
    usage.thoughtsTokens,
  )
  let output = firstTokenCount(
    usage.outputTokenCount,
    usage.output_tokens,
    usage.outputTokens,
  )
  if (output === undefined) {
    if (typeof total === 'number' && typeof input === 'number') {
      output = total - input
    } else if (
      typeof candidates === 'number' ||
      typeof thoughts === 'number'
    ) {
      output = (candidates ?? 0) + (thoughts ?? 0)
    }
  }
  const cachedInput = firstTokenCount(
    usage.cachedContentTokenCount,
    usage.cached_content_token_count,
    usage.cachedContentTokens,
    usage.cached_content_tokens,
  )

  return buildUsageLike({
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: thoughts,
    cachedInputTokens: cachedInput,
  })
}

function normalizeFlatUsage(usage: Record<string, any>): ApiUsageLike {
  const promptDetails =
    plainObject(usage.prompt_tokens_details) ??
    plainObject(usage.promptTokensDetails) ??
    plainObject(usage.input_tokens_details) ??
    plainObject(usage.inputTokensDetails)
  const completionDetails =
    plainObject(usage.completion_tokens_details) ??
    plainObject(usage.completionTokensDetails) ??
    plainObject(usage.output_tokens_details) ??
    plainObject(usage.outputTokensDetails)
  const input = firstTokenCount(
    usage.prompt_tokens,
    usage.promptTokens,
    usage.input_tokens,
    usage.inputTokens,
    usage.inputTokenCount,
  )
  const output = firstTokenCount(
    usage.completion_tokens,
    usage.completionTokens,
    usage.output_tokens,
    usage.outputTokens,
    usage.outputTokenCount,
  )
  const total = firstTokenCount(
    usage.total_tokens,
    usage.totalTokens,
    usage.totalTokenCount,
    typeof input === 'number' && typeof output === 'number'
      ? input + output
      : undefined,
  )
  const reasoning = firstTokenCount(
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.thoughts_tokens,
    usage.thoughtsTokens,
    completionDetails?.reasoning_tokens,
    completionDetails?.reasoningTokens,
  )
  const cachedInput = firstTokenCount(
    usage.cachedInputTokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cacheReadTokens,
    usage.cache_read_tokens,
    promptDetails?.cached_tokens,
    promptDetails?.cachedTokens,
  )
  const cacheCreationInput = firstTokenCount(
    usage.cacheCreationInputTokens,
    usage.cache_creation_input_tokens,
    usage.cacheCreationTokens,
    usage.cache_creation_tokens,
    promptDetails?.cache_write_tokens,
    promptDetails?.cacheWriteTokens,
  )

  return buildUsageLike({
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    reasoningTokens: reasoning,
    cachedInputTokens: cachedInput,
    cacheCreationInputTokens: cacheCreationInput,
  })
}

function normalizeProviderMetadata(metadata: Record<string, any>): ApiUsageLike {
  const candidates = [
    metadata.openrouter?.usage,
    metadata.openai?.usage,
    metadata.anthropic?.usage,
    metadata.google?.usage,
    metadata.gateway?.usage,
    metadata.usage,
  ]

  for (const candidate of candidates) {
    const usage = normalizeUsageLike(candidate)
    if (usage) return usage
  }

  return buildUsageLike({
    cachedInputTokens: firstTokenCount(
      metadata.openai?.cachedPromptTokens,
      metadata.openai?.cachedInputTokens,
      metadata.anthropic?.cacheReadInputTokens,
      metadata.google?.cachedContentTokenCount,
      metadata.openrouter?.promptTokensDetails?.cachedTokens,
    ),
    cacheCreationInputTokens: firstTokenCount(
      metadata.anthropic?.cacheCreationInputTokens,
      metadata.openrouter?.promptTokensDetails?.cacheWriteTokens,
    ),
  })
}

export function normalizeUsageLike(value: unknown): ApiUsageLike {
  const record = plainObject(value)
  if (!record) return null

  const direct = normalizeAiSdkV6Usage(record) ?? normalizeFlatUsage(record)
  if (direct) return direct

  const usageMetadata = plainObject(record.usageMetadata ?? record.usage_metadata)
  if (usageMetadata) {
    const gemini = normalizeGeminiUsage(usageMetadata)
    if (gemini) return gemini
  }

  const usage = plainObject(record.usage)
  if (usage) {
    const nestedUsage = normalizeUsageLike(usage)
    if (nestedUsage) return nestedUsage
  }

  const providerMetadata = plainObject(
    record.providerMetadata ?? record.provider_metadata,
  )
  if (providerMetadata) {
    const metadataUsage = normalizeProviderMetadata(providerMetadata)
    if (metadataUsage) return metadataUsage
  }

  return null
}

export function extractUsageFromRawPayload(rawValue: unknown): ApiUsageLike {
  const record = plainObject(rawValue)
  if (!record) return null

  const usageMetadata = plainObject(record.usageMetadata ?? record.usage_metadata)
  if (usageMetadata) {
    const gemini = normalizeGeminiUsage(usageMetadata)
    if (gemini) return gemini
  }

  return normalizeUsageLike(record)
}
