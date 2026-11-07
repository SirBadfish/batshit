import { resolveApiPresentationValues, resolveApiRetentionValues } from '$lib/appActions/settings/apiReasoningPreferences'
import { validWhiteboardBudget, isApiReasoningRetentionMode } from '$lib/utils/reasoningRetention'
import type { SettingsSubjectEntry } from './subjects'
import { valueState, type Group } from './scalarProjection'

function applicable(entry: SettingsSubjectEntry): boolean {
  return entry.subject.kind === 'primary' && entry.type === 'api'
}
export function projectApiPresentation(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  const id = 'agent.reasoning.presentation'
  if (!applicable(entry)) return Object.freeze({ id, status: 'unavailable', reason: 'api_primary_only' })
  const values = resolveApiPresentationValues({ ...record,
    ...(record.show_reasoning != null && typeof record.show_reasoning !== 'boolean' ? { show_reasoning: undefined } : {}),
    ...(record.show_whiteboard != null && typeof record.show_whiteboard !== 'boolean' ? { show_whiteboard: undefined } : {}) })
  return Object.freeze({ id, status: 'available', fields: Object.freeze({
    displayReasoning: valueState(record.show_reasoning, values.displayReasoning, value => typeof value === 'boolean'),
    displayWhiteboard: valueState(record.show_whiteboard, values.displayWhiteboard, value => typeof value === 'boolean')
  }) })
}
export function projectApiRetention(entry: SettingsSubjectEntry, record: Record<string, unknown>): Group {
  const id = 'agent.reasoning.retention'
  if (!applicable(entry)) return Object.freeze({ id, status: 'unavailable', reason: 'api_primary_only' })
  try {
    const values = resolveApiRetentionValues(record)
    return Object.freeze({ id, status: 'available', fields: Object.freeze({
      mode: valueState(record.api_reasoning_retention, values.mode, isApiReasoningRetentionMode),
      whiteboardBudgetTokens: valueState(record.whiteboard_budget_tokens, values.whiteboardBudgetTokens, validWhiteboardBudget)
    }) })
  } catch {
    return Object.freeze({ id, status: 'unavailable', reason: 'invalid_api_retention_preferences' })
  }
}
