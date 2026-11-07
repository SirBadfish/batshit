import {
  API_REASONING_RETENTION_MODES, resolveApiReasoningRetention, validateReasoningRetentionSave,
  type ApiReasoningRetentionMode
} from '$lib/utils/reasoningRetention'
import { shouldShowReasoningByDefaultForPrimaryAgent } from '$lib/utils/primaryAgentType'

export type ApiPresentationValues = { displayReasoning: boolean; displayWhiteboard: boolean }
export type ApiPresentationChanges = Partial<{ [K in keyof ApiPresentationValues]: ApiPresentationValues[K] | null }>
export type ApiRetentionValues = { mode: ApiReasoningRetentionMode; whiteboardBudgetTokens: number }
export type ApiRetentionChanges = Partial<{ [K in keyof ApiRetentionValues]: ApiRetentionValues[K] | null }>

function changeObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length ||
    Object.keys(value).some(key => !keys.includes(key))) throw new Error('Choose only the adopted API preference fields.')
  return value as Record<string, unknown>
}

export function validateApiPresentationChanges(value: unknown): ApiPresentationChanges {
  const change = changeObject(value, ['displayReasoning', 'displayWhiteboard'])
  if (Object.values(change).some(item => item !== null && typeof item !== 'boolean')) {
    throw new Error('Display preferences must be true, false or null to use the factory default.')
  }
  return { ...change } as ApiPresentationChanges
}

export function validateApiRetentionChanges(value: unknown): ApiRetentionChanges {
  const change = changeObject(value, ['mode', 'whiteboardBudgetTokens'])
  const saved: Record<string, unknown> = {}
  if (Object.hasOwn(change, 'mode')) saved.api_reasoning_retention = change.mode
  if (Object.hasOwn(change, 'whiteboardBudgetTokens')) saved.whiteboard_budget_tokens = change.whiteboardBudgetTokens
  const error = validateReasoningRetentionSave(saved)
  if (error || Object.values(change).some(item => item === undefined)) throw new Error(error ?? 'A preference must have an explicit value or null.')
  return { ...change } as ApiRetentionChanges
}

/** Existing per-agent resolvers own defaults; malformed saved values stay failures. */
export function resolveApiPresentationValues(record: Record<string, unknown>): ApiPresentationValues {
  if (record.show_reasoning != null && typeof record.show_reasoning !== 'boolean') throw new Error('Invalid saved Display Reasoning preference.')
  if (record.show_whiteboard != null && typeof record.show_whiteboard !== 'boolean') throw new Error('Invalid saved Display Whiteboard preference.')
  return {
    displayReasoning: record.show_reasoning as boolean | null | undefined ?? shouldShowReasoningByDefaultForPrimaryAgent(record.agentType),
    displayWhiteboard: record.show_whiteboard as boolean | null | undefined ?? true
  }
}

export function resolveApiRetentionValues(record: Record<string, unknown>): ApiRetentionValues {
  const resolved = resolveApiReasoningRetention(record)
  return { mode: resolved.mode, whiteboardBudgetTokens: resolved.whiteboardBudgetTokens }
}

export { API_REASONING_RETENTION_MODES }
