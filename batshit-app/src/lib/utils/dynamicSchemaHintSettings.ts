/** Shared factory values; saved Admin leaves remain authoritative. */
export const DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT = 10
export const DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT = 10
export const DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS = 400
export const DEFAULT_DCM_TOOL_NAME_THRESHOLD = 30
export const DEFAULT_DCM_TOTAL_HINT_TOKENS = 3000
export const MIN_DCM_TOTAL_HINT_TOKENS = 500
export const MAX_DCM_TOTAL_HINT_TOKENS = 20000

export function normalizeTotalHintTokens(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed)
    ? Math.min(MAX_DCM_TOTAL_HINT_TOKENS, Math.max(MIN_DCM_TOTAL_HINT_TOKENS, Math.round(parsed)))
    : DEFAULT_DCM_TOTAL_HINT_TOKENS
}
