import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type {
  AgentReasoningOverrides, AgentReasoningOverridesPatch, ExplicitReasoningSnapshot,
  ReasoningControlId, ReasoningControlIdentity, ReasoningControlSelection, LocalReasoningContract
} from '$lib/types/reasoningControls'
import { reviewedReasoningBinding, type ReasoningSettingPath } from '$lib/data/reasoning-controls'

import { isReasoningBudgetValue, reasoningBudgetHint } from './modelReasoningBudget'
import { reasoningValueText } from './reasoningControlLabels'

export const REASONING_CONTROL_IDS = ['effort', 'thinking', 'mode', 'budget'] as const
const CONTROL_IDS = new Set<string>(REASONING_CONTROL_IDS)
const TRANSPORTS = new Set(['direct', 'openrouter', 'vercel-gateway'])
const SAFE_KEY = /^r1:(?:[0-9a-f]{2})+$/
const MAX_KEY_LENGTH = 4096

export class ModelReasoningSettingError extends Error {
  readonly status = 400
  readonly code = 'model_setting_unsupported'
  constructor(message: string) { super(message); this.name = 'ModelReasoningSettingError' }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function safeIdentityPart(value: unknown, nullable = false): boolean {
  return nullable && value === null || typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)
}

export function reasoningOverrideKey(identity: ReasoningControlIdentity, control: ReasoningControlId): string {
  const parts = [identity.presetId, identity.connection.type, identity.connection.id ?? null,
    identity.connection.service ?? null, identity.effectiveModelId, control]
  // Opaque field names also avoid the backup owner's secret-name redaction heuristics.
  return 'r1:' + Array.from(new TextEncoder().encode(JSON.stringify(parts)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function parseReasoningOverrideKey(key: string): { identity: ReasoningControlIdentity; control: ReasoningControlId } | null {
  if (key.length > MAX_KEY_LENGTH || !SAFE_KEY.test(key)) return null
  try {
    const bytes = Uint8Array.from(key.slice(3).match(/../g)!, pair => Number.parseInt(pair, 16))
    const parts = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!Array.isArray(parts) || parts.length !== 6 || !safeIdentityPart(parts[0], true) ||
      !TRANSPORTS.has(parts[1]) || !safeIdentityPart(parts[2], true) || !safeIdentityPart(parts[3], true) ||
      !safeIdentityPart(parts[4]) || !CONTROL_IDS.has(parts[5]) || (!parts[2] && !parts[3])) return null
    const identity: ReasoningControlIdentity = {
      presetId: parts[0], connection: { type: parts[1], ...(parts[2] ? { id: parts[2] } : {}),
        ...(parts[3] ? { service: parts[3] } : {}) }, effectiveModelId: parts[4]
    }
    const control = parts[5] as ReasoningControlId
    return reasoningOverrideKey(identity, control) === key ? { identity, control } : null
  } catch { return null }
}

export function isReasoningSelection(value: unknown): value is ReasoningControlSelection {
  if (!plainObject(value)) return false
  if (value.mode === 'provider-default') return Object.keys(value).length === 1
  if (value.mode !== 'value' || Object.keys(value).length !== 2 || !('value' in value)) return false
  return typeof value.value === 'boolean' || typeof value.value === 'string' && value.value.length <= 256 ||
    typeof value.value === 'number' && Number.isFinite(value.value)
}

/** A save owns exactly one safe leaf; bulk replacement is never an edit operation. */
export function validateReasoningOverridesPatch(value: unknown): string | null {
  if (!plainObject(value) || Object.keys(value).length !== 1) return 'Save one reasoning control at a time.'
  const [key, selection] = Object.entries(value)[0]
  if (!parseReasoningOverrideKey(key)) return 'The reasoning control identity is invalid. Choose the model again.'
  if (selection !== null && !isReasoningSelection(selection)) return 'The reasoning control selection is invalid.'
  return null
}

export function applyReasoningOverridesPatch(stored: AgentReasoningOverrides | null | undefined, patch: AgentReasoningOverridesPatch): AgentReasoningOverrides {
  const next = { ...stored }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

export function reasoningControlKeys(identity: ReasoningControlIdentity): Record<ReasoningControlId, string> {
  return Object.fromEntries(REASONING_CONTROL_IDS.map(id => [id, reasoningOverrideKey(identity, id)])) as Record<ReasoningControlId, string>
}

/** An explicit override follows a custom object that already wins in the mapper. */
function setExistingObjectPath(settings: Record<string, any>, path: ReasoningSettingPath, value: unknown): void {
  const [key, ...rest] = path
  if (!rest.length || !plainObject(settings[key])) return
  const copy = { ...settings[key] }
  if (rest.length === 1) copy[rest[0]] = value
  else setExistingObjectPath(copy, rest, value)
  settings[key] = copy
}

function removeSettingPath(settings: Record<string, any>, path: ReasoningSettingPath): void {
  const [key, ...rest] = path
  if (!rest.length) { delete settings[key]; return }
  const value = settings[key]
  if (!plainObject(value)) return
  const copy = { ...value }
  removeSettingPath(copy, rest)
  // Even an empty custom object remains a winning replacement in the mapper.
  settings[key] = copy
}

export function reasoningProviderValue(providerOptions: Record<string, any>, path: readonly string[]): unknown {
  let value: any = providerOptions
  for (const key of path) value = value?.[key]
  return value
}

/** The final typed/custom merged options are validated before an SDK can lower or drop them. */
export function validateReviewedReasoningSettings(args: {
  modelId?: string | null; connection?: ModelConnectionInfo | null
  settings?: Record<string, any> | null; localReasoning?: LocalReasoningContract | null; providerOptions: Record<string, Record<string, any>>
}): void {
  const binding = reviewedReasoningBinding(args)
  if (!binding) return
  for (const control of binding.controls) {
    const value = reasoningProviderValue(args.providerOptions, control.providerPath)
    if (value === undefined || value === null) continue
    const definition = binding.descriptor.controls.find(item => item.id === control.id)!
    if (definition.kind === 'budget' && !isReasoningBudgetValue(definition, value)) {
      throw new ModelReasoningSettingError(`Thinking budget is unavailable for ${args.modelId}. ${reasoningBudgetHint(definition)}`)
    }
    if (definition.kind === 'toggle' && typeof value !== 'boolean') {
      throw new ModelReasoningSettingError(`The saved ${control.label.toLowerCase()} choice is unsupported for ${args.modelId}. Choose On, Off or Provider default.`)
    }
    if ((definition.kind === 'effort' || definition.kind === 'mode') &&
      (typeof value !== 'string' || !definition.values.includes(value))) {
      throw new ModelReasoningSettingError(`The saved ${control.label.toLowerCase()} is unsupported for ${args.modelId}. Choose a supported value in Settings.`)
    }
  }
  if (binding.adapter.package === '@ai-sdk/anthropic') {
    const thinking = args.providerOptions.anthropic?.thinking
    const mode = thinking?.type ?? 'adaptive'
    const effort = args.providerOptions.anthropic?.effort ?? binding.descriptor.controls.find(item => item.id === 'effort')?.defaultValue
    if ((mode === 'between_tools' || mode === 'disabled') && (effort === 'xhigh' || effort === 'max')) {
      throw new ModelReasoningSettingError(`Thinking mode ${reasoningValueText(mode)} cannot use ${reasoningValueText(effort)} effort on ${args.modelId}. Choose adaptive thinking or an effort no higher than high.`)
    }
    if (thinking?.budgetTokens !== undefined && thinking?.budgetTokens !== null) {
      throw new ModelReasoningSettingError(`${args.modelId} does not support a thinking token budget. Clear the preset's Thinking budget or Custom Parameter; saved values are not changed automatically.`)
    }
    if (mode === 'between_tools' && (thinking?.display !== undefined || thinking?.blockBinding !== undefined)) {
      throw new ModelReasoningSettingError('Between tools thinking takes no display or block-binding fields. Choose adaptive thinking or clear those Custom Parameters.')
    }
    if (thinking?.type === undefined && thinking?.display !== undefined) {
      throw new ModelReasoningSettingError('This thinking display setting requires an explicit adaptive mode. Choose Adaptive so the SDK can preserve the display setting.')
    }
  }
  if (binding.adapter.package === '@ai-sdk/google' && binding.descriptor.controls.some(control => control.kind === 'budget') &&
    args.providerOptions.google?.thinkingConfig?.thinkingLevel !== undefined) {
    throw new ModelReasoningSettingError(`${args.modelId} uses a requested thinking budget. Clear the incompatible Thinking level; a level is not converted into a budget.`)
  }
  if (binding.adapter.package === '@ai-sdk/google' && !binding.descriptor.controls.some(control => control.kind === 'budget') &&
    args.providerOptions.google?.thinkingConfig?.thinkingBudget !== undefined) {
    throw new ModelReasoningSettingError(`${args.modelId} uses thinking levels. Clear the incompatible Thinking budget; a budget is not converted into a level.`)
  }
}

export function resolveModelReasoningControls(args: {
  identity: ReasoningControlIdentity
  settings?: Record<string, any> | null
  overrides?: AgentReasoningOverrides | null
  localReasoning?: LocalReasoningContract | null
}): { settings: Record<string, any> | null; explicitReasoning: ExplicitReasoningSnapshot[] } {
  const binding = reviewedReasoningBinding({ modelId: args.identity.effectiveModelId, connection: args.identity.connection, localReasoning: args.localReasoning })
  const keys = reasoningControlKeys(args.identity)
  const selected = REASONING_CONTROL_IDS.filter(id => args.overrides?.[keys[id]] !== undefined)
  if (!selected.length) return { settings: args.settings ?? null, explicitReasoning: [] }
  const settings = { ...args.settings }
  const explicitReasoning: ExplicitReasoningSnapshot[] = []
  for (const id of selected) {
    const selection = args.overrides![keys[id]]
    if (!isReasoningSelection(selection)) throw new ModelReasoningSettingError('The saved reasoning selection is invalid. Choose it again in Agent Settings.')
    const control = binding?.controls.find(control => control.id === id)
    const definition = binding?.descriptor.controls.find(control => control.id === id)
    if (!control || !definition) throw new ModelReasoningSettingError('Reasoning controls are not verified for this model and connection. Choose Use preset in Agent Settings.')
    if (selection.mode === 'value' && !(definition.kind === 'toggle' ? typeof selection.value === 'boolean' : definition.kind === 'budget' ? isReasoningBudgetValue(definition, selection.value)
      : (definition.kind === 'effort' || definition.kind === 'mode') && typeof selection.value === 'string' && definition.values.includes(selection.value))) {
      throw new ModelReasoningSettingError(`The saved ${control.label.toLowerCase()} is unsupported for ${args.identity.effectiveModelId}. Choose a supported value in Agent Settings.`)
    }
    for (const alias of control.aliases) {
      if (alias.length > 1 && settings[alias[0]] !== undefined && !plainObject(settings[alias[0]])) {
        throw new ModelReasoningSettingError(`Custom Parameter ${alias[0]} must be an object before this reasoning control can be changed. Its saved value was kept.`)
      }
      removeSettingPath(settings, alias)
    }
    if (selection.mode === 'value') {
      settings[control.setting] = selection.value
      for (const alias of control.aliases) setExistingObjectPath(settings, alias, selection.value)
    }
    explicitReasoning.push({ identity: args.identity, control: id, selection })
  }
  return { settings: Object.keys(settings).length ? settings : null, explicitReasoning }
}
