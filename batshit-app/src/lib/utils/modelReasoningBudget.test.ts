import { describe, expect, it } from 'vitest'
import { reviewedReasoningBinding } from '$lib/data/reasoning-controls'
import { isReasoningBudgetValue, parseReasoningBudget } from './modelReasoningBudget'
import { previewModelReasoningControls } from './modelReasoningPreview'
import { buildRuntimeModelSettings } from './modelSettingsMapper'
import { reasoningOverrideKey, resolveModelReasoningControls } from './modelReasoningControls'
import { filterParameters } from './parameterFilter'
import { fromInputValue } from './parameterValueAdapter'
import { formatParameterDisplayValue } from '$lib/components/settings/models/modelSettingsFormatters'

const connection = { type: 'direct' as const, id: 'direct:google', service: 'google' }
describe('SA-132 exact integer budget ranges and explicit special values', () => {
  it.each([
    ['gemini-2.5-pro', [-1, 128, 32768], [-2, 0, 1, 127, 32769]],
    ['gemini-2.5-flash', [-1, 0, 1, 24576], [-2, 24577]],
    ['gemini-2.5-flash-lite', [-1, 0, 512, 24576], [-2, 1, 511, 24577]]
  ] as const)('validates %s without rounding or inventing intermediate values', (modelId, valid, invalid) => {
    const definition = reviewedReasoningBinding({ modelId, connection })!.descriptor.controls[0]
    expect(definition.kind).toBe('budget')
    if (definition.kind !== 'budget') throw new Error('budget fixture')
    for (const value of valid) { expect(isReasoningBudgetValue(definition, value)).toBe(true); expect(parseReasoningBudget(String(value), definition)).toBe(value) }
    for (const value of [...invalid, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(isReasoningBudgetValue(definition, value)).toBe(false)
    for (const raw of ['1.5', '1e3', '1024junk', '', ' ', '1,00', '+1024']) expect(() => parseReasoningBudget(raw, definition)).toThrow(/whole requested token budget/)
    expect(parseReasoningBudget('1,024', definition)).toBe(1024)
    const parameter = filterParameters({ provider: 'google', modelId, connectionInfo: connection }).find(item => item.name === 'thinkingBudget')!
    expect(parameter).not.toHaveProperty('defaultValue')
    expect(fromInputValue(parameter, '')).toBeUndefined()
    expect(fromInputValue(parameter, '1,024')).toBe(1024)
    expect(() => fromInputValue(parameter, '1.5')).toThrow()
    expect(formatParameterDisplayValue(parameter, '1.5')).toBe('1.5')
    expect(formatParameterDisplayValue(parameter, '1e3')).toBe('1e3')
    // Unrelated legacy integer input retains its existing parser/formatter contract.
    expect(fromInputValue({ name: 'legacy', label: 'Legacy', inputType: 'integer' }, '1.5')).toBe(1)
    expect(() => buildRuntimeModelSettings({ provider: 'google', modelId, connection, settings: { thinkingBudget: 1.5 } })).toThrow(/budget/)
    expect(() => buildRuntimeModelSettings({ provider: 'google', modelId, connection, settings: { thinkingBudget: 1024, 'google.thinkingConfig.thinkingLevel': 'high' } })).toThrow(/not converted/)
  })
  it('does not describe an invalid inherited configuration as a provider default', () => {
    const settings = { thinkingBudget: 1.5 }
    const view = previewModelReasoningControls({ provider: 'google', identity: { presetId: 'bad-budget', connection, effectiveModelId: 'gemini-2.5-pro' }, settings })
    expect(view.error).toBeTruthy()
    expect(view.controls[0].inheritedHelper).toContain('unavailable')
    expect(view.controls[0].inheritedHelper).not.toContain('Provider default')
    expect(settings.thinkingBudget).toBe(1.5)
  })
  it('keeps inheritance, provider default, Dynamic, Off and positive choices separate without touching custom siblings', () => {
    const identity = { presetId: 'budget', connection, effectiveModelId: 'gemini-2.5-flash-lite' }
    const settings = { thinkingBudget: 2048, 'google.thinkingConfig': { thinkingBudget: 1024, includeThoughts: false } }
    const key = reasoningOverrideKey(identity, 'budget')
    expect(resolveModelReasoningControls({ identity, settings }).settings).toBe(settings)
    for (const value of [-1, 0, 512]) {
      const resolved = resolveModelReasoningControls({ identity, settings, overrides: { [key]: { mode: 'value', value } } })
      expect(buildRuntimeModelSettings({ provider: 'google', modelId: identity.effectiveModelId, connection, settings: resolved.settings }).providerOptions.google.thinkingConfig)
        .toEqual({ thinkingBudget: value, includeThoughts: false })
    }
    const defaults = resolveModelReasoningControls({ identity, settings, overrides: { [key]: { mode: 'provider-default' } } })
    expect(buildRuntimeModelSettings({ provider: 'google', modelId: identity.effectiveModelId, connection, settings: defaults.settings }).providerOptions.google.thinkingConfig).toEqual({ includeThoughts: false })
    expect(settings).toEqual({ thinkingBudget: 2048, 'google.thinkingConfig': { thinkingBudget: 1024, includeThoughts: false } })
  })
})
