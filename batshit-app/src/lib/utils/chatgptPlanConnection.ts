export const CHATGPT_PLAN_USAGE_URL = 'https://chatgpt.com/settings/usage'
export const CHATGPT_PLAN_PARAMETERS = new Set(['reasoningEffort', 'reasoningSummary', 'textVerbosity', 'parallelToolCalls'])
const PREFIX = 'chatgpt-plan:'
export function chatgptPlanConnectionId(accountId: string): string { return PREFIX + accountId }
export function chatgptPlanAccountId(connectionId?: string | null): string | null {
  if (!connectionId?.startsWith(PREFIX)) return null
  const accountId = connectionId.slice(PREFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId) ? accountId : null
}
export function isChatgptPlanConnection(connectionId?: string | null): boolean { return Boolean(connectionId?.startsWith(PREFIX)) }
export type ChatgptPlanAccountSummary = { id: string; email: string; state: 'ready' | 'identity-only' | 'reconnect' | 'disconnected'; revocationStatus?: 'pending' | 'confirmed' | 'unconfirmed' }
