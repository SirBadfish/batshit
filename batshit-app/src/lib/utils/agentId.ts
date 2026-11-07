/** Actual ordinary creation rule. Caller transport/report budgets are separate. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/
export function isCanonicalAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value)
}
