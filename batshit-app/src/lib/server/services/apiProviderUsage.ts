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
    plainObject(usage.inputTokensDetails) ??
    // AI SDK 7 core usage: flat numeric tokens + inputTokenDetails/outputTokenDetails
    // (the legacy flat cachedInputTokens/reasoningTokens duplicates were removed).
    plainObject(usage.inputTokenDetails)
  const completionDetails =
    plainObject(usage.completion_tokens_details) ??
    plainObject(usage.completionTokensDetails) ??
    plainObject(usage.output_tokens_details) ??
    plainObject(usage.outputTokensDetails) ??
    plainObject(usage.outputTokenDetails)
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
    promptDetails?.cacheReadTokens,
    // SA-107 (DL-107-05), fallback-last: flat `usage.cached_tokens` — the
    // Together non-reasoning and Cohere native v2 wire shapes. The nested
    // prompt-details shapes above stay authoritative when both appear.
    usage.cached_tokens,
    usage.cachedTokens,
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

  // SA-107: Cohere native v2 reports final usage inside a `delta` wrapper
  // (`message-end` event: { delta: { usage: { ..., cached_tokens } } }).
  const delta = plainObject(record.delta)
  if (delta) {
    const deltaUsage = normalizeUsageLike(delta)
    if (deltaUsage) return deltaUsage
  }

  return normalizeUsageLike(record)
}

/**
 * SA-107 (DL-107-07): true only for the raw Anthropic accounting shape, where
 * flat `input_tokens` EXCLUDES cache reads/writes reported beside it. Detection
 * is deliberately strict (snake_case wire shape only) so already-normalized
 * v7 usage objects — whose flat cache fields ride an INCLUSIVE input — are
 * never summed twice.
 */
function isAnthropicExclusiveUsageShape(usageRecord: Record<string, any>): boolean {
  if (usageRecord.input_tokens === undefined) return false
  return (
    usageRecord.cache_read_input_tokens !== undefined ||
    usageRecord.cache_creation_input_tokens !== undefined
  )
}

/**
 * SA-107 (DL-107-07): normalize a step's `providerMetadata` usage entry into
 * v7-inclusive semantics. Returns a usage object ONLY when it carries cache
 * evidence (cache read or creation counts); anything else returns null so the
 * caller never replaces trustworthy SDK usage with weaker data.
 */
export function normalizeProviderMetadataUsageInclusive(
  providerMetadata: unknown,
): ApiUsageLike {
  const metadata = plainObject(providerMetadata)
  if (!metadata) return null

  for (const entryValue of Object.values(metadata)) {
    const entry = plainObject(entryValue)
    if (!entry) continue
    const usageRecord = plainObject(entry.usage)
    if (!usageRecord) continue
    const normalized = normalizeUsageLike(usageRecord)
    if (!normalized) continue
    const hasCacheEvidence =
      typeof normalized.cachedInputTokens === 'number' ||
      typeof normalized.cacheCreationInputTokens === 'number'
    if (!hasCacheEvidence) continue

    if (isAnthropicExclusiveUsageShape(usageRecord)) {
      const rawInput = coerceTokenCount(usageRecord.input_tokens) ?? 0
      const cacheRead = normalized.cachedInputTokens ?? 0
      const cacheWrite = normalized.cacheCreationInputTokens ?? 0
      const inclusiveInput = rawInput + cacheRead + cacheWrite
      const output = normalized.outputTokens
      return buildUsageLike({
        inputTokens: inclusiveInput,
        outputTokens: output,
        totalTokens:
          typeof output === 'number' ? inclusiveInput + output : undefined,
        reasoningTokens: normalized.reasoningTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        cacheCreationInputTokens: normalized.cacheCreationInputTokens,
      })
    }

    return normalized
  }

  return null
}

/**
 * SA-107 (DL-107-07): aggregate cache-bearing providerMetadata usage across
 * AI SDK steps. Steps without cache-bearing metadata usage contribute nothing,
 * keeping numerator and denominator consistent. Returns null when no step
 * carried cache evidence.
 */
export function deriveUsageFromStepsProviderMetadata(steps: unknown): ApiUsageLike {
  if (!Array.isArray(steps) || steps.length === 0) return null

  const addTo = (base: number | undefined, value: number | undefined) =>
    value === undefined ? base : (base ?? 0) + value

  let sawCache = false
  let inputTotal: number | undefined
  let outputTotal: number | undefined
  let cachedTotal: number | undefined
  let cacheCreationTotal: number | undefined
  let reasoningTotal: number | undefined

  for (const step of steps) {
    const usage = normalizeProviderMetadataUsageInclusive(
      (step as any)?.providerMetadata,
    )
    if (!usage) continue
    sawCache = true
    inputTotal = addTo(inputTotal, usage.inputTokens)
    outputTotal = addTo(outputTotal, usage.outputTokens)
    cachedTotal = addTo(cachedTotal, usage.cachedInputTokens)
    cacheCreationTotal = addTo(cacheCreationTotal, usage.cacheCreationInputTokens)
    reasoningTotal = addTo(reasoningTotal, usage.reasoningTokens)
  }

  if (!sawCache) return null

  return buildUsageLike({
    inputTokens: inputTotal,
    outputTokens: outputTotal,
    totalTokens:
      inputTotal !== undefined && outputTotal !== undefined
        ? inputTotal + outputTotal
        : undefined,
    reasoningTokens: reasoningTotal,
    cachedInputTokens: cachedTotal,
    cacheCreationInputTokens: cacheCreationTotal,
  })
}

/**
 * SA-107 (DL-107-07 amended): gateway-lane guard against RAW Anthropic
 * exclusive accounting reaching the strip. Under true v7-inclusive semantics
 * `cachedInputTokens + cacheCreationInputTokens` can never exceed
 * `inputTokens`, so when it does the numbers are provably exclusive and the
 * inclusive input/total are rebuilt. Live 2026-08-31 evidence: the gateway
 * SDK now delivers cache fields on usage itself but keeps `inputTokens: 3`
 * exclusive — without this guard the strip would compute >100% and clamp.
 */
function correctExclusiveGatewayUsage(
  usage: NonNullable<ApiUsageLike>,
): NonNullable<ApiUsageLike> {
  const input = usage.inputTokens
  if (typeof input !== 'number') return usage
  const cacheRead = usage.cachedInputTokens ?? 0
  const cacheWrite = usage.cacheCreationInputTokens ?? 0
  if (cacheRead + cacheWrite <= input) return usage

  const inclusiveInput = input + cacheRead + cacheWrite
  return {
    ...usage,
    inputTokens: inclusiveInput,
    totalTokens:
      typeof usage.outputTokens === 'number'
        ? inclusiveInput + usage.outputTokens
        : usage.totalTokens,
    ...(typeof usage.cachedInputTokens === 'number'
      ? { inputTokenDetails: { cacheReadTokens: usage.cachedInputTokens } }
      : {}),
  }
}

/**
 * SA-107 (DL-107-06/07): resolve the usage object persisted on the assistant
 * message (`metadata.usage`, the chat-strip source).
 *
 * Precedence:
 * 1. Gateway lane: step providerMetadata derivation is preferred whenever it
 *    exists (raw shapes are the authority on exclusive vs inclusive input);
 *    whatever usage results is then passed through the arithmetic
 *    exclusive-accounting guard above.
 * 2. SDK finish usage that already carries cache fields → returned AS-IS on
 *    non-gateway lanes, so every healthy lane stays byte-identical.
 * 3. SDK usage without cache fields + raw-stream usage with them → SDK numbers
 *    stay authoritative, raw-chunk cache fields fill the gaps (Together
 *    non-reasoning, Cohere native v2).
 * 4. Otherwise the base usage is returned unchanged.
 */
export function resolveMessageUsage(args: {
  sdkUsage?: unknown
  rawStreamUsage?: ApiUsageLike
  steps?: unknown
  isGatewayLane?: boolean
}): ApiUsageLike {
  const base = args.sdkUsage ?? args.rawStreamUsage ?? undefined
  const normalizedBase = normalizeUsageLike(base)
  const baseHasCache =
    typeof normalizedBase?.cachedInputTokens === 'number' ||
    typeof normalizedBase?.cacheCreationInputTokens === 'number'

  if (args.isGatewayLane) {
    const derived = deriveUsageFromStepsProviderMetadata(args.steps)
    if (derived) {
      const merged = normalizedBase
        ? mergeUsageLike(normalizedBase, derived)
        : { ...derived }
      if (
        typeof merged.inputTokens === 'number' &&
        typeof merged.outputTokens === 'number'
      ) {
        merged.totalTokens = merged.inputTokens + merged.outputTokens
      }
      return correctExclusiveGatewayUsage(merged)
    }

    const raw = args.rawStreamUsage
    const rawHasCache =
      typeof raw?.cachedInputTokens === 'number' ||
      typeof raw?.cacheCreationInputTokens === 'number'
    const merged = baseHasCache
      ? normalizedBase
      : raw && rawHasCache
        ? normalizedBase
          ? mergeUsageLike(raw, normalizedBase)
          : raw
        : normalizedBase
    if (merged) {
      return correctExclusiveGatewayUsage(merged)
    }
    return base as ApiUsageLike
  }

  if (baseHasCache) return base as ApiUsageLike

  const raw = args.rawStreamUsage
  const rawHasCache =
    typeof raw?.cachedInputTokens === 'number' ||
    typeof raw?.cacheCreationInputTokens === 'number'
  if (raw && rawHasCache) {
    return normalizedBase ? mergeUsageLike(raw, normalizedBase) : raw
  }

  return base as ApiUsageLike
}

/**
 * SA-102 (DL-102-13): local cache counts come from each response, not a runtime
 * capability or the SDK's normalized zero. Reporting can depend on startup
 * flags and versions. The SDK preserves provider usage on each step.usage.raw,
 * but drops raw when aggregating steps, so aggregate callers must supply every
 * model call's raw usage. A partially reported sum is not a run-wide count.
 * Cloud usage is returned by identity. For a single call the default reads
 * usage.raw before normalization discards that provenance.
 */
export function withHonestLocalCacheUsage(
  usage: ApiUsageLike,
  reporting: 'reports' | 'never-reports' | null | undefined,
  rawUsages: readonly unknown[] = [plainObject(usage)?.raw],
): ApiUsageLike {
  if (!usage || reporting == null) return usage
  // Normalize FIRST. The AI SDK can hand back either a flat
  // `cachedInputTokens` or a nested `inputTokens.cacheRead`, and a flat delete
  // on the un-normalized object leaves the nested one to be re-extracted
  // downstream by `buildTokenUsage`.
  const normalized = normalizeUsageLike(usage) ?? usage
  const next: NonNullable<ApiUsageLike> = { ...normalized }
  delete next.cachedInputTokens
  delete next.cacheCreationInputTokens
  if (next.inputTokenDetails) {
    const details = { ...next.inputTokenDetails }
    delete (details as Record<string, unknown>).cacheReadTokens
    next.inputTokenDetails = Object.keys(details).length ? details : undefined
  }

  const rawCounts = rawUsages.map((raw) => normalizeUsageLike(raw))
  const sumReported = (field: 'cachedInputTokens' | 'cacheCreationInputTokens') => {
    if (rawCounts.length === 0) return undefined
    let total = 0
    for (const raw of rawCounts) {
      const count = raw?.[field]
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
        return undefined
      }
      total += count
    }
    return Number.isFinite(total) ? total : undefined
  }
  const cached = sumReported('cachedInputTokens')
  const created = sumReported('cacheCreationInputTokens')
  if (cached !== undefined) {
    next.cachedInputTokens = cached
    next.inputTokenDetails = { ...next.inputTokenDetails, cacheReadTokens: cached }
  }
  if (created !== undefined) next.cacheCreationInputTokens = created
  return next
}
