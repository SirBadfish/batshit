import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { AgentReasoningOverrides, ReasoningControlId, ReasoningControlIdentity, ReasoningControlSelection, LocalReasoningContract } from '$lib/types/reasoningControls'
import { reviewedReasoningBinding, isOllamaReasoningConnection } from '$lib/data/reasoning-controls'
import { REASONING_CONTROL_IDS, isReasoningSelection, reasoningControlKeys, resolveModelReasoningControls } from './modelReasoningControls'
import { previewRuntimeReasoningSettings } from './modelSettingsMapper'

import { isReasoningBudgetValue, reasoningBudgetLabel, reasoningBudgetHint } from './modelReasoningBudget'
import { reasoningValueLabel, reasoningValueText } from './reasoningControlLabels'

type PreviewArgs = { identity: ReasoningControlIdentity; provider?: string | null; settings?: Record<string, any> | null; overrides?: AgentReasoningOverrides; capabilities?: import('$lib/types/savedModels').ModelCapabilities | null; localReasoning?: LocalReasoningContract | null }
export { reasoningValueLabel } from './reasoningControlLabels'

function preview(args: PreviewArgs) {
  try {
    const resolved = resolveModelReasoningControls(args)
    return previewRuntimeReasoningSettings({ provider: args.provider, modelId: args.identity.effectiveModelId,
      connection: args.identity.connection, settings: resolved.settings, capabilities: args.capabilities, localReasoning: args.localReasoning, explicitReasoning: resolved.explicitReasoning })
  } catch (error) { return { values: {} as Record<string, unknown>, error: error instanceof Error ? error.message : 'This reasoning configuration cannot be sent.' } }
}

export function previewModelReasoningControls(args: PreviewArgs) {
  const binding = reviewedReasoningBinding({ modelId: args.identity.effectiveModelId, connection: args.identity.connection, localReasoning: args.localReasoning })
  const keys = reasoningControlKeys(args.identity)
  const current = preview(args)
  const inherited = preview({ ...args, overrides: undefined })
  const ids = REASONING_CONTROL_IDS.filter(id => binding?.controls.some(control => control.id === id) || id === 'thinking' && isOllamaReasoningConnection(args.identity.connection) || args.overrides?.[keys[id]] !== undefined)
  return { error: current.error, controls: ids.map(id => {
    const control = binding?.controls.find(control => control.id === id)
    const definition = binding?.descriptor.controls.find(control => control.id === id)
    const selection = args.overrides?.[keys[id]] ?? null
    const literal = isReasoningSelection(selection) ? selection.mode === 'value' ? String(selection.value) : 'Provider default' : 'unrecognized'
    const selectedValue = selection === null ? 'inherit' : !isReasoningSelection(selection) ? 'invalid'
      : selection.mode === 'provider-default' ? 'provider-default' : String(selection.value)
    const label = control?.label ?? (id === 'mode' ? 'Thinking mode' : id === 'thinking' ? 'Thinking' : 'Reasoning setting')
    const inheritedValue = inherited.values[id]
    const budget = definition?.kind === 'budget' ? definition : null
    const valueLabel = (value: unknown) => budget && typeof value === 'number' ? reasoningBudgetLabel(value, budget) : reasoningValueLabel(value)
    const inheritedHelper = binding?.adapter.package === 'ollama-ai-provider-v2' && !inherited.error && inheritedValue === undefined ? 'Preset thinking: Default (Off)' : inherited.error ? 'Preset setting unavailable. Review this model preset.' : budget ? `Preset budget: ${typeof inheritedValue === 'number' ? reasoningBudgetLabel(inheritedValue, budget) : budget.defaultValue === undefined ? 'Provider default' : `Provider default (${reasoningBudgetLabel(budget.defaultValue, budget)})`}` : inheritedValue !== undefined
      ? `Preset ${label === 'Thinking level' ? 'level' : id}: ${reasoningValueText(inheritedValue)}`
      : 'Use this model preset’s setting'
    const candidate = (next: ReasoningControlSelection | null) => {
      const overrides = { ...args.overrides }
      if (next === null) delete overrides[keys[id]]
      else overrides[keys[id]] = next
      return preview({ ...args, overrides }).error === null
    }
    const values = definition && (definition.kind === 'effort' || definition.kind === 'mode') ? definition.values : definition?.kind === 'toggle' ? [true, false] : budget ? [-1, 0, ...(selection?.mode === 'value' && typeof selection.value === 'number' && selection.value > 0 ? [selection.value] : [])].filter(value => isReasoningBudgetValue(budget, value)) : []
    const options = [
      { value: 'inherit', selectionValue: undefined, label: 'Use preset', helper: inheritedHelper, available: true },
      ...(control ? [{ value: 'provider-default', selectionValue: undefined, label: 'Provider default',
        helper: definition?.defaultValue === undefined ? 'Use the provider’s default' : `Use the provider’s default (${valueLabel(definition.defaultValue)})`,
        available: candidate({ mode: 'provider-default' }) }] : []),
      ...values.map(value => ({ value: String(value), selectionValue: value, label: valueLabel(value), helper: '', available: candidate({ mode: 'value', value }) }))
    ]
    if (budget) options.push({ value: 'custom-budget', selectionValue: undefined, label: 'Set token budget…', helper: '', available: true })
    const selected = options.find(option => option.value === selectedValue)
    return { id, key: keys[id], label, budget, effectiveValue: current.values[id], budgetHint: budget ? reasoningBudgetHint(budget) : '', selection, selectedValue, literal, inheritedHelper, options,
      unavailable: !selected || !selected.available,
      activeLabel: selected?.label ?? `Saved: ${literal} (unavailable)` }
  }) }
}

/** Preset editor choices keep Custom Parameter precedence; no alias is edited on its behalf. */
export function availableReasoningParameterValues(args: { provider?: string | null; modelId?: string | null; connection?: ModelConnectionInfo | null;
  settings: Record<string, any>; parameterName: string }): string[] | null {
  const binding = reviewedReasoningBinding(args)
  const control = binding?.controls.find(control => control.setting === args.parameterName)
  const definition = binding?.descriptor.controls.find(definition => definition.id === control?.id)
  if (!control || !definition || definition.kind !== 'effort' && definition.kind !== 'mode' && definition.kind !== 'toggle') return null
  const values = definition.kind === 'toggle' ? [true, false] : definition.values
  return [
    '', // Clearing one bad typed field must remain possible while another field is invalid.
    ...values.filter(value => previewRuntimeReasoningSettings({ ...args, settings: { ...args.settings, [control.setting]: value } }).error === null).map(String)
  ]
}
