import { describe, expect, it } from 'vitest'
import { reviewedReasoningBinding } from '$lib/data/reasoning-controls'
import { resolveRuntimeModelSelection } from './modelPresetRuntime'
import { buildRuntimeModelSettings } from './modelSettingsMapper'
import { planAgentBlockWrite, applyAgentBlockUpdate } from './agentBlockFieldSettings'
import {
  reasoningOverrideKey, parseReasoningOverrideKey, resolveModelReasoningControls,
  validateReasoningOverridesPatch
} from './modelReasoningControls'
import type { ReasoningControlIdentity } from '$lib/types/reasoningControls'

const identity: ReasoningControlIdentity = { presetId: 'shared',
  connection: { type: 'direct', id: 'direct:openai', service: 'openai' }, effectiveModelId: 'gpt-6.1-sol' }
const key = reasoningOverrideKey(identity, 'effort')
const preset = { id: 'shared', provider: 'openai', modelId: 'gpt-6.1-sol', connection: identity.connection,
  settings: { reasoningEffort: 'low', 'openai.reasoningEffort': 'high', 'openai.parallelToolCalls': false } } as any

describe('SA-132 exact reasoning ownership and request settings', () => {
  it('preserves the inherited live preset and unrelated custom parameters without an override', () => {
    const selection = resolveRuntimeModelSelection({ preset, reasoningOverrides: {} })
    expect(selection.settings).toEqual(preset.settings)
    expect(selection.explicitReasoning).toBeUndefined()
    const mimoSettings = { 'openai.reasoningEffort': 'high', temperature: 0 }
    expect(resolveModelReasoningControls({ identity: { ...identity,
      connection: { type: 'direct', id: 'direct:mimo', service: 'mimo' }, effectiveModelId: 'mimo-v2.5-pro' },
    settings: mimoSettings }).settings).toBe(mimoSettings)
  })

  it('changes only this agent and masks qualified aliases only in its effective copy', () => {
    const overridden = resolveRuntimeModelSelection({ preset,
      reasoningOverrides: { [key]: { mode: 'value', value: 'max' } } })
    expect(overridden.settings).toEqual({ reasoningEffort: 'max', 'openai.parallelToolCalls': false })
    expect(resolveRuntimeModelSelection({ preset }).settings).toEqual(preset.settings)
    expect(preset.settings).toHaveProperty('openai.reasoningEffort', 'high')
    expect(buildRuntimeModelSettings({ provider: 'openai', modelId: preset.modelId,
      connection: preset.connection, settings: overridden.settings }).providerOptions).toEqual({
      openai: { reasoningEffort: 'max', parallelToolCalls: false }
    })
  })

  it('provider default removes both proven aliases while preserving other settings', () => {
    const result = resolveRuntimeModelSelection({ preset,
      reasoningOverrides: { [key]: { mode: 'provider-default' } } })
    expect(result.settings).toEqual({ 'openai.parallelToolCalls': false })
    expect(result.explicitReasoning?.[0].selection).toEqual({ mode: 'provider-default' })
  })

  it('keys survive runtime upgrades but do not follow another preset, account or model', () => {
    expect(parseReasoningOverrideKey(key)).toEqual({ identity, control: 'effort' })
    for (const changed of [{ ...identity, presetId: 'other' }, { ...identity, effectiveModelId: 'gpt-6-sol' },
      { ...identity, connection: { ...identity.connection, id: 'another-connection' } }]) {
      expect(resolveModelReasoningControls({ identity: changed, settings: preset.settings,
        overrides: { [key]: { mode: 'value', value: 'max' } } }).settings).toBe(preset.settings)
    }
  })

  it('admits only the exact reviewed route, not conflicting/custom identities or sibling models', () => {
    for (const connection of [{ type: 'direct', id: 'direct:openai', service: 'mimo' },
      { type: 'direct', id: 'custom:fixture', service: 'openai' }, { type: 'vercel-gateway', service: 'openai' }]) {
      expect(reviewedReasoningBinding({ modelId: 'gpt-6.1-sol', connection: connection as any })).toBeNull()
    }
    expect(reviewedReasoningBinding({ modelId: 'gpt-6-unreviewed', connection: identity.connection })).toBeNull()
  })

  it('does not broaden typed GPT-6.1 parameters to an unqualified route; existing custom paths survive', () => {
    const connection = { type: 'vercel-gateway' as const, service: 'openai' }
    expect(buildRuntimeModelSettings({ provider: 'openai', modelId: 'gpt-6.1-sol', connection,
      settings: { reasoningEffort: 'max' } }).providerOptions).toEqual({})
    expect(buildRuntimeModelSettings({ provider: 'openai', modelId: 'gpt-6.1-sol', connection,
      settings: { 'openai.reasoningEffort': 'high' } }).providerOptions).toEqual({ openai: { reasoningEffort: 'high' } })
  })

  it('retains invalid saved intent and refuses it rather than clamping or dispatching it', () => {
    const overrides = { [key]: { mode: 'value' as const, value: 'none' } }
    expect(() => resolveRuntimeModelSelection({ preset, reasoningOverrides: overrides })).toThrow(/unsupported/)
    expect(overrides[key].value).toBe('none')
  })

  it('keeps explicit child presets and existing parent-model delegated defaults independent', () => {
    const child = resolveRuntimeModelSelection({ preset: { ...preset, id: 'child' },
      reasoningOverrides: { [key]: { mode: 'value', value: 'max' } } })
    expect(child.settings).toEqual(preset.settings)
    expect(resolveRuntimeModelSelection({ modelId: preset.modelId, connection: preset.connection }).settings).toBeNull()
  })
})

describe('SA-132 safe persisted leaves and retained evidence', () => {
  it('writes/removes one identity leaf without replacing another control or preset', () => {
    const otherKey = reasoningOverrideKey({ ...identity, presetId: 'other' }, 'effort')
    const stored = { [otherKey]: { mode: 'value', value: 'low' } }
    const patch = { [key]: { mode: 'value' as const, value: 'max' } }
    expect(planAgentBlockWrite('model_reasoning_overrides', patch)).toEqual({ kind: 'steps', steps: [
      { step: 'ensure', path: [] }, { step: 'set', path: [key], value: patch[key] }
    ] })
    const after = applyAgentBlockUpdate('model_reasoning_overrides', stored, patch)
    expect(after).toEqual({ ...stored, ...patch })
    expect(applyAgentBlockUpdate('model_reasoning_overrides', after, { [key]: null })).toEqual(stored)
  })

  it('refuses unsafe/bulk/malformed saves while distinguishing false and zero from absence', () => {
    for (const value of [null, [], {}, { unsafe: { mode: 'value', value: 'high' } },
      { [key]: { mode: 'provider-default', value: 'high' } }, { [key]: { mode: 'value', value: Infinity } },
      { [key]: null, [reasoningOverrideKey(identity, 'budget')]: null }]) {
      expect(validateReasoningOverridesPatch(value)).toBeTruthy()
      expect(() => planAgentBlockWrite('model_reasoning_overrides', value)).toThrow()
    }
    expect(validateReasoningOverridesPatch({ [reasoningOverrideKey(identity, 'thinking')]: { mode: 'value', value: false } })).toBeNull()
    expect(validateReasoningOverridesPatch({ [reasoningOverrideKey(identity, 'budget')]: { mode: 'value', value: 0 } })).toBeNull()
  })

})


describe('SA-132 reviewed multi-control final options', () => {
  const identity = { presetId: 'claude', connection: { type: 'direct' as const, id: 'direct:anthropic', service: 'anthropic' }, effectiveModelId: 'claude-sonnet-5-5' }
  it('masks just the selected nested mode and preserves siblings without mutating the preset', () => {
    const settings = { 'anthropic.thinking': { type: 'between_tools', display: 'summarized' }, 'anthropic.effort': 'high', custom: false }
    const resolved = resolveModelReasoningControls({ identity, settings, overrides: {
      [reasoningOverrideKey(identity, 'mode')]: { mode: 'value', value: 'adaptive' },
      [reasoningOverrideKey(identity, 'effort')]: { mode: 'value', value: 'max' }
    } })
    const runtime = buildRuntimeModelSettings({ provider: 'anthropic', modelId: identity.effectiveModelId, connection: identity.connection, settings: resolved.settings })
    expect(runtime.providerOptions.anthropic).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max', custom: false })
    expect(settings['anthropic.thinking']).toEqual({ type: 'between_tools', display: 'summarized' })
    expect(resolved.explicitReasoning.map(item => item.control)).toEqual(['effort', 'mode'])
    // A reply keeps the exact chosen pair even when the mutable saved map changes later.
    expect(runtime.providerOptions.anthropic.effort).toBe('max')
  })
  it('retains no-override custom object replacement rather than activating old typed siblings', () => {
    const connection = { type: 'direct' as const, id: 'direct:google', service: 'google' }
    const settings = { thinkingBudget: 8192, 'google.thinkingConfig': { includeThoughts: false } }
    const inherited = resolveModelReasoningControls({ identity: { presetId: 'old', connection, effectiveModelId: 'gemini-4-argon' }, settings })
    expect(inherited.settings).toBe(settings)
    expect(buildRuntimeModelSettings({ provider: 'google', modelId: 'gemini-4-argon', connection, settings: inherited.settings }).providerOptions.google.thinkingConfig)
      .toEqual({ includeThoughts: false })
    const owned = { thinkingBudget: 8192, 'google.thinkingConfig': { thinkingLevel: 'low' } }
    const modelIdentity = { presetId: 'owned', connection, effectiveModelId: 'gemini-4-argon' }
    for (const selection of [{ mode: 'value' as const, value: 'high' }, { mode: 'provider-default' as const }]) {
      const effective = resolveModelReasoningControls({ identity: modelIdentity, settings: owned,
        overrides: { [reasoningOverrideKey(modelIdentity, 'effort')]: selection } })
      expect(buildRuntimeModelSettings({ provider: 'google', modelId: modelIdentity.effectiveModelId, connection, settings: effective.settings }).providerOptions.google.thinkingConfig)
        .toEqual(selection.mode === 'value' ? { thinkingLevel: 'high' } : {})
      expect(owned['google.thinkingConfig']).toEqual({ thinkingLevel: 'low' })
    }
    const source = { 'anthropic.thinking': { display: 'summarized' }, 'anthropic.thinking.type': 'adaptive' }
    buildRuntimeModelSettings({ provider: 'anthropic', modelId: identity.effectiveModelId, connection: identity.connection, settings: source })
    expect(source['anthropic.thinking']).toEqual({ display: 'summarized' })
  })
  it('refuses an invalid custom ancestor instead of dropping an explicit selected child', () => {
    expect(() => resolveModelReasoningControls({ identity, settings: { 'anthropic.thinking': false }, overrides: {
      [reasoningOverrideKey(identity, 'mode')]: { mode: 'value', value: 'adaptive' }
    } })).toThrow(/must be an object/)
  })
  it('refuses incompatible final typed/custom pairs instead of permitting SDK lowering', () => {
    for (const effort of ['xhigh', 'max']) expect(() => buildRuntimeModelSettings({ provider: 'anthropic', modelId: identity.effectiveModelId,
      connection: identity.connection, settings: { thinkingMode: 'between_tools', 'anthropic.effort': effort } })).toThrow(/cannot use/)
    expect(buildRuntimeModelSettings({ provider: 'anthropic', modelId: identity.effectiveModelId, connection: identity.connection,
      settings: { thinkingMode: 'disabled', anthropicEffort: 'high', thinkingBudget: 2048 } }).providerOptions.anthropic.thinking).toEqual({ type: 'between_tools' })
  })
})


describe('SA-132 native toggle and friendly final-control text', () => {
  it('keeps false distinct from absence and default while preserving the old MiMo custom effort', () => {
    const identity = { presetId: 'mimo', effectiveModelId: 'mimo-v2.5', connection: { type: 'direct' as const, id: 'direct:mimo', service: 'mimo' } }
    const settings = { mimoThinking: true, 'openai.reasoningEffort': 'high', 'mimo.thinking': { type: 'enabled' } }
    const key = reasoningOverrideKey(identity, 'thinking')
    const off = resolveModelReasoningControls({ identity, settings, overrides: { [key]: { mode: 'value', value: false } } })
    expect(off.settings).toEqual({ ...settings, mimoThinking: false })
    const defaults = resolveModelReasoningControls({ identity, settings, overrides: { [key]: { mode: 'provider-default' } } })
    expect(defaults.settings).toEqual({ 'openai.reasoningEffort': 'high', 'mimo.thinking': { type: 'enabled' } })
    expect(() => resolveModelReasoningControls({ identity, settings, overrides: { [key]: { mode: 'value', value: 'false' } } })).toThrow(/unsupported/)
    expect(settings.mimoThinking).toBe(true)
  })
  it('uses friendly labels in a refused incompatible Claude pair', () => {
    expect(() => buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-sonnet-5-5',
      connection: { type: 'direct', id: 'direct:anthropic', service: 'anthropic' },
      settings: { thinkingMode: 'between_tools', anthropicEffort: 'xhigh' } })).toThrow(/Between tools \(lowest\) cannot use Extra High effort/)
  })
})
