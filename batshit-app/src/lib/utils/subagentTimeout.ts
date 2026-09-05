export const MIN_SUBAGENT_TIMEOUT_SECONDS = 10
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 600

export function normalizeSubagentTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined

  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined
  if (parsed < MIN_SUBAGENT_TIMEOUT_SECONDS || parsed > MAX_SUBAGENT_TIMEOUT_SECONDS) {
    return undefined
  }

  return parsed
}

export function getSubagentTimeoutValidationError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (normalizeSubagentTimeoutSeconds(value) !== undefined) return null

  return `Call timeout must be a whole number from ${MIN_SUBAGENT_TIMEOUT_SECONDS} to ${MAX_SUBAGENT_TIMEOUT_SECONDS} seconds.`
}
