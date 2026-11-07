import type { ReasoningControlDefinition } from '$lib/types/reasoningControls'

export type ReasoningBudget = Extract<ReasoningControlDefinition, { kind: 'budget' }>
export function isReasoningBudgetValue(budget: ReasoningBudget, value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    (budget.specialValues?.includes(value) === true || value >= budget.min && (budget.max === undefined || value <= budget.max))
}
export function reasoningBudgetLabel(value: number, budget: ReasoningBudget): string {
  if (!isReasoningBudgetValue(budget, value)) return `${value} (unavailable)`
  return value === -1 ? 'Dynamic' : value === 0 ? 'Off' : `${value.toLocaleString('en-US')} tokens`
}
export function reasoningBudgetHint(budget: ReasoningBudget): string {
  const range = budget.max === undefined ? `${budget.min.toLocaleString('en-US')} or more` : `${budget.min.toLocaleString('en-US')}–${budget.max.toLocaleString('en-US')}`
  return `Enter a whole requested token budget (${range})${isReasoningBudgetValue(budget, -1) ? ', -1 for Dynamic' : ''}${isReasoningBudgetValue(budget, 0) ? ', or 0 for Off' : ''}.`
}
/** Explicit decimal integer entry only; do not silently round decimal/scientific text. */
export function parseReasoningBudget(raw: string, budget: ReasoningBudget): number {
  const text = raw.trim()
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error(reasoningBudgetHint(budget))
  const value = Number(text.replaceAll(',', ''))
  if (!isReasoningBudgetValue(budget, value)) throw new Error(reasoningBudgetHint(budget))
  return value
}
