import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { estimateTokens } from '$lib/utils/tokens'

export const API_REASONING_RETENTION_MODES = ['whiteboard', 'preserve', 'both', 'neither'] as const
export type ApiReasoningRetentionMode = (typeof API_REASONING_RETENTION_MODES)[number]
export interface AgentReasoningRetention {
  api_reasoning_retention?: ApiReasoningRetentionMode | null
  whiteboard_budget_tokens?: number | null
  show_whiteboard?: boolean | null
}
export interface ResolvedReasoningRetention {
  mode: ApiReasoningRetentionMode
  whiteboardEnabled: boolean
  preserveReasoning: boolean
  whiteboardBudgetTokens: number
  showWhiteboard: boolean
}
/** SA-126 WB-3 (Josh, 2026-10-19): measured on the final grid; Preserve stays off. */
export const API_REASONING_RETENTION_DEFAULT_MODE: ApiReasoningRetentionMode = 'whiteboard'
export const WHITEBOARD_DEFAULT_BUDGET = 1500
export const WHITEBOARD_MIN_BUDGET = 250
export const WHITEBOARD_MAX_BUDGET = 16000
export const WHITEBOARD_CONTROL_ID = 'sys.whiteboard.update'

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}

export function isApiReasoningRetentionMode(value: unknown): value is ApiReasoningRetentionMode {
  return API_REASONING_RETENTION_MODES.includes(value as ApiReasoningRetentionMode)
}

export function validWhiteboardBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= WHITEBOARD_MIN_BUDGET && value <= WHITEBOARD_MAX_BUDGET
}

/** API-only. Deliberately does not map the old API preserve_reasoning flag. */
export function resolveApiReasoningRetention(agent: unknown): ResolvedReasoningRetention {
  const own = record(agent)
  const mode = own.api_reasoning_retention ?? API_REASONING_RETENTION_DEFAULT_MODE
  const budget = own.whiteboard_budget_tokens ?? WHITEBOARD_DEFAULT_BUDGET
  const display = own.show_whiteboard ?? true
  if (!isApiReasoningRetentionMode(mode) || !validWhiteboardBudget(budget) || typeof display !== 'boolean') {
    throw new Error('Invalid saved API reasoning retention settings. Review this agent’s settings.')
  }
  return {
    mode,
    whiteboardEnabled: mode === 'whiteboard' || mode === 'both',
    preserveReasoning: mode === 'preserve' || mode === 'both',
    whiteboardBudgetTokens: budget,
    showWhiteboard: display
  }
}

export function resolvePreserveReasoning(agent: unknown): boolean {
  return normalizePrimaryAgentType(record(agent)) === 'api'
    ? resolveApiReasoningRetention(agent).preserveReasoning
    : record(agent).preserve_reasoning === true
}

/** Sparse saves may clear a field to restore its factory default. */
export function validateReasoningRetentionSave(value: unknown): string | null {
  const fields = record(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Reasoning retention settings must be an object.'
  const modeKey = 'api_reasoning_retention'
  if (fields[modeKey] != null && !isApiReasoningRetentionMode(fields[modeKey])) return 'Invalid reasoning retention mode.'
  if (fields.whiteboard_budget_tokens != null && !validWhiteboardBudget(fields.whiteboard_budget_tokens)) {
    return `Whiteboard Budget must be a whole number from ${WHITEBOARD_MIN_BUDGET} to ${WHITEBOARD_MAX_BUDGET} estimated tokens.`
  }
  if (fields.show_whiteboard != null && typeof fields.show_whiteboard !== 'boolean') return 'Display Whiteboard must be a boolean.'
  return null
}

export const estimateWhiteboardTokens = estimateTokens
