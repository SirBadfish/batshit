export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384
export const NEAR_CONTEXT_MAX_OUTPUT_RATIO = 0.8

export type MaxOutputTokenResolutionReason = 'provided' | 'missing' | 'unsafe'

export interface MaxOutputTokenResolution {
  maxOutputTokens: number
  estimated: boolean
  reason: MaxOutputTokenResolutionReason
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  }

  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value.replace(/,/g, ''))
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  }

  return undefined
}

export function getSafeDefaultMaxOutputTokens(contextWindow?: unknown): number {
  const normalizedContextWindow = normalizePositiveInteger(contextWindow)
  if (!normalizedContextWindow) {
    return DEFAULT_MODEL_MAX_OUTPUT_TOKENS
  }

  return Math.max(1, Math.min(DEFAULT_MODEL_MAX_OUTPUT_TOKENS, Math.floor(normalizedContextWindow / 2)))
}

export function isContextSizedMaxOutputTokens(maxOutputTokens: unknown, contextWindow?: unknown): boolean {
  const normalizedMaxOutputTokens = normalizePositiveInteger(maxOutputTokens)
  const normalizedContextWindow = normalizePositiveInteger(contextWindow)
  if (!normalizedMaxOutputTokens || !normalizedContextWindow) {
    return false
  }

  return normalizedMaxOutputTokens >= normalizedContextWindow
}

export function isNearContextMaxOutputTokens(
  maxOutputTokens: unknown,
  contextWindow?: unknown,
  ratio = NEAR_CONTEXT_MAX_OUTPUT_RATIO
): boolean {
  const normalizedMaxOutputTokens = normalizePositiveInteger(maxOutputTokens)
  const normalizedContextWindow = normalizePositiveInteger(contextWindow)
  if (!normalizedMaxOutputTokens || !normalizedContextWindow) {
    return false
  }

  return normalizedMaxOutputTokens >= Math.floor(normalizedContextWindow * ratio)
}

export function sanitizeCatalogMaxOutputTokens({
  maxOutputTokens,
  contextWindow,
  rejectNearContext = true,
  unknownContextCeiling
}: {
  maxOutputTokens?: unknown
  contextWindow?: unknown
  rejectNearContext?: boolean
  unknownContextCeiling?: number | null
}): number | undefined {
  const normalizedMaxOutputTokens = normalizePositiveInteger(maxOutputTokens)
  if (!normalizedMaxOutputTokens) {
    return undefined
  }

  const normalizedContextWindow = normalizePositiveInteger(contextWindow)
  if (normalizedContextWindow) {
    if (
      isContextSizedMaxOutputTokens(normalizedMaxOutputTokens, normalizedContextWindow) ||
      (rejectNearContext && isNearContextMaxOutputTokens(normalizedMaxOutputTokens, normalizedContextWindow))
    ) {
      return undefined
    }
    return normalizedMaxOutputTokens
  }

  if (
    typeof unknownContextCeiling === 'number' &&
    Number.isFinite(unknownContextCeiling) &&
    normalizedMaxOutputTokens > unknownContextCeiling
  ) {
    return undefined
  }

  return normalizedMaxOutputTokens
}

export function resolvePresetMaxOutputTokens({
  maxOutputTokens,
  contextWindow
}: {
  maxOutputTokens?: unknown
  contextWindow?: unknown
}): number {
  return resolvePresetMaxOutputTokenResolution({ maxOutputTokens, contextWindow }).maxOutputTokens
}

export function resolvePresetMaxOutputTokenResolution({
  maxOutputTokens,
  contextWindow
}: {
  maxOutputTokens?: unknown
  contextWindow?: unknown
}): MaxOutputTokenResolution {
  const normalizedMaxOutputTokens = normalizePositiveInteger(maxOutputTokens)
  const safeMaxOutputTokens = sanitizeCatalogMaxOutputTokens({
    maxOutputTokens: normalizedMaxOutputTokens,
    contextWindow,
    rejectNearContext: true
  })

  if (safeMaxOutputTokens !== undefined) {
    return {
      maxOutputTokens: safeMaxOutputTokens,
      estimated: false,
      reason: 'provided'
    }
  }

  return {
    maxOutputTokens: getSafeDefaultMaxOutputTokens(contextWindow),
    estimated: true,
    reason: normalizedMaxOutputTokens === undefined ? 'missing' : 'unsafe'
  }
}

export function normalizeRuntimeMaxOutputTokens({
  maxOutputTokens,
  contextWindow,
  rejectNearContext = false
}: {
  maxOutputTokens?: unknown
  contextWindow?: unknown
  rejectNearContext?: boolean
}): number | undefined {
  const normalizedMaxOutputTokens = normalizePositiveInteger(maxOutputTokens)
  if (!normalizedMaxOutputTokens) {
    return undefined
  }

  if (
    isContextSizedMaxOutputTokens(normalizedMaxOutputTokens, contextWindow) ||
    (rejectNearContext && isNearContextMaxOutputTokens(normalizedMaxOutputTokens, contextWindow))
  ) {
    return getSafeDefaultMaxOutputTokens(contextWindow)
  }

  return normalizedMaxOutputTokens
}
