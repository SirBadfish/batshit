import { parseManagedSettingsReportInput, parseManagedSettingsChangeInput, MANAGED_SETTINGS_CHANGE_SCHEMA } from './managementInput'
import { planModelPresetCopy } from '$lib/server/services/modelManagerHelpers'
import { MODEL_PRESET_COPY_ID, validateModelPresetCopyChanges, isModelPresetCopyReview } from './modelSelectionPreferences'
import { describe, it, expect } from 'vitest'
import { validateModelSelectionChanges, isModelSelectionReviewChanges } from './modelSelectionPreferences'
describe('A3 existing preset input', () => {
  it('checks complete CLI human facts without accepting them as writable selection input', () => {
    const facts = [
      { field: 'presetId', before: null, after: 'preset' }, { field: 'program', before: 'claude', after: 'claude' },
      { field: 'nativeStorage', before: 'retained', after: 'model-patched' }, { field: 'nativeModel', before: 'old-alias', after: 'sonnet' },
      { field: 'fast', before: null, after: null }
    ].map(fact => ({ ...fact, label: fact.field }))
    expect(isModelSelectionReviewChanges(facts)).toBe(true)
    expect(isModelSelectionReviewChanges(facts.slice(0, 4))).toBe(false)
    expect(isModelSelectionReviewChanges([...facts.slice(0, 4), facts[0]])).toBe(false)
    expect(() => validateModelSelectionChanges(Object.fromEntries(facts.map(fact => [fact.field, fact.after])))).toThrow()
    expect(isModelSelectionReviewChanges(facts.map(fact => fact.field === 'program' ? { ...fact, after: 'guessed' } : fact))).toBe(false)
    expect(isModelSelectionReviewChanges(facts.map(fact => fact.field === 'program' ? { ...fact, before: null } : fact))).toBe(true)
    // SA-139 R1: the retired Codex CLI is no program a review names, before or after.
    expect(isModelSelectionReviewChanges(facts.map(fact => fact.field === 'program' ? { ...fact, before: 'codex' } : fact))).toBe(false)
    expect(isModelSelectionReviewChanges(facts.map(fact => fact.field === 'program' ? { ...fact, after: 'codex' } : fact))).toBe(false)
  })
  it('admits exactly a nonempty preset ID or explicit clear through the actual shared parser', () => {
    expect(validateModelSelectionChanges({ presetId: 'my-preset' })).toEqual({ presetId: 'my-preset' })
    expect(validateModelSelectionChanges({ clear: true })).toEqual({ clear: true })
    expect(MANAGED_SETTINGS_CHANGE_SCHEMA.properties.changes.properties.clear).toMatchObject({ type: 'boolean', const: true })
    expect(parseManagedSettingsChangeInput({ op: 'change', requestId: `${'a'.repeat(24)}:clear`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`, semanticId: 'agent.model.selection', changes: { clear: true } })).toMatchObject({ changes: { clear: true } })
  })
  it.each([{}, null, { clear: false }, { clear: null }, { clear: true, presetId: 'a' }, { clear: true, nativeModel: '' }, { presetId: null }, { presetId: '' }, { presetId: ' x ' }, { presetId: 'a', provider: 'openai' }, { presetId: 'a', settings: {} }, { presetId: 'a\n' }])('refuses implicit clear, mixed intent and raw provider/model/settings input %#', input => {
    expect(() => validateModelSelectionChanges(input)).toThrow()
  })
})


describe('A12 source-bound typed named copy', () => {
  const original = { id: 'original', modelName: 'Original', modelId: 'claude-cli', provider: 'anthropic-claude-cli', purpose: 'chat' as const,
    connection: { id: 'claude-cli', type: 'direct' as const, service: 'anthropic-claude-cli' }, settings: { claude_model: 'old-alias', privateUnknown: { zero: 0, disabled: false } }, pricing: {}, createdAt: '2026-10-18', updatedAt: '2026-10-18' }
  const input = { sourcePresetId: 'original', copyName: 'Named copy', parameters: [{ name: 'claude_model', op: 'set' as const, value: 'literal-new-alias' }] }
  // SA-139 R5: the Claude Code CLI preset's model seed (`claude_model`) fed only the removed CLI
  // Subagent, so it is no longer a copy parameter; the A12 rules are held on an API preset.
  const apiOriginal = { ...original, provider: 'openai', modelId: 'gpt-4.1', connection: { id: 'direct:openai', type: 'direct' as const, service: 'openai' },
    settings: { temperature: 1, privateUnknown: { zero: 0, disabled: false } } }
  const apiInput = { ...input, parameters: [{ name: 'temperature', op: 'set' as const, value: 0.5 }] }
  it('refuses to copy a Claude Code CLI preset\'s model seed (SA-139 R5)', () => {
    const before = structuredClone(original)
    expect(() => planModelPresetCopy(original, input, 'a'.repeat(32))).toThrow('preset_parameter_unsupported')
    expect(() => planModelPresetCopy(original, { ...input, parameters: [{ name: 'claude_model', op: 'unset' }] }, 'a'.repeat(32))).toThrow('preset_parameter_unsupported')
    expect(original).toEqual(before)
  })
  it('copies only the named parameter and leaves the original and inherited unknown fields exact', () => {
    const before = structuredClone(apiOriginal)
    const plan = planModelPresetCopy(apiOriginal, apiInput, 'a'.repeat(32))
    expect(apiOriginal).toEqual(before); expect(plan.candidate.settings).toEqual({ ...before.settings, temperature: 0.5 })
    expect(plan.candidate.id).not.toBe(apiOriginal.id); expect(plan.review).not.toHaveProperty('privateUnknown')
    expect(JSON.stringify(plan.review)).not.toContain('privateUnknown'); expect(isModelPresetCopyReview(plan.review)).toBe(true)
    expect(() => planModelPresetCopy(apiOriginal, { ...apiInput, parameters: [{ name: 'claude_model', op: 'set', value: 'alias' }] }, 'a'.repeat(32))).toThrow('unsupported')
    expect(() => planModelPresetCopy(apiOriginal, { ...apiInput, parameters: [{ name: 'permissionMode', op: 'set', value: 'goon' }] }, 'a'.repeat(32))).toThrow('unsupported')
  })
  it('keeps unset distinct from explicit null and rejects coercion or caller-supplied identity/authority', () => {
    const plan = planModelPresetCopy({ ...apiOriginal, settings: { ...apiOriginal.settings, temperature: null } }, { ...apiInput, parameters: [{ name: 'temperature', op: 'unset' }] }, 'b'.repeat(32))
    expect(plan.review.parameters[0]).toMatchObject({ before: { state: 'null' }, after: { state: 'unset' } })
    expect(plan.candidate.settings).not.toHaveProperty('temperature')
    for (const bad of [{ ...apiInput, id: 'caller-id' }, { ...apiInput, parameters: [...apiInput.parameters, ...apiInput.parameters] }, { ...apiInput, parameters: [{ name: 'temperature', op: 'set', value: {} }] }]) expect(() => validateModelPresetCopyChanges(bad)).toThrow()
  })
  it('preserves real API zero/false intent and refuses coercion/range violations before copy creation', () => {
    const api = { ...original, provider: 'openai', modelId: 'gpt-4.1', connection: { id: 'direct:openai', type: 'direct' as const, service: 'openai' }, settings: { temperature: 1, store: true, seed: 3 } }
    const parameters = [{ name: 'temperature', op: 'set' as const, value: 0 }, { name: 'store', op: 'set' as const, value: false }, { name: 'seed', op: 'unset' as const }]
    const plan = planModelPresetCopy(api, { ...input, parameters }, 'c'.repeat(32))
    expect(plan.candidate.settings).toEqual({ temperature: 0, store: false })
    expect(plan.review.parameters.map(row => row.after)).toEqual([{ state: 'set', value: 0 }, { state: 'set', value: false }, { state: 'unset' }])
    for (const value of ['0', 3, false]) expect(() => planModelPresetCopy(api, { ...input, parameters: [{ name: 'temperature', op: 'set', value }] }, 'c'.repeat(32))).toThrow('unsupported')
  })
  it('requires the explicit original choices read and the actual shared mutation parser', () => {
    expect(parseManagedSettingsReportInput({ focus: [MODEL_PRESET_COPY_ID], detail: 'choices', query: { sourcePresetId: original.id } })).toMatchObject({ query: { sourcePresetId: original.id } })
    expect(() => parseManagedSettingsReportInput({ focus: [MODEL_PRESET_COPY_ID], detail: 'choices' })).toThrow()
    const change = { op: 'change', requestId: `${'a'.repeat(24)}:copy`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`, semanticId: MODEL_PRESET_COPY_ID, changes: input }
    expect(parseManagedSettingsChangeInput(change)).toMatchObject({ changes: input })
    expect(() => parseManagedSettingsChangeInput({ ...change, changes: { ...input, provider: 'override' } })).toThrow()
  })
})
