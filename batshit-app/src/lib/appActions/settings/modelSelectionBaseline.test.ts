import { describe, expect, it } from 'vitest'
import { captureModelSelectionBaseline, isModelSelectionRevision, isModelSelectionWrite, withModelSelection, sameModelSelection } from './modelSelectionBaseline'

const revision = `sha256:${'a'.repeat(64)}`
describe('the shown model selection baseline', () => {
  // SA-139 R4/R5: a leftover CLI agent or CLI Subagent (a retired type) holds no model selection,
  // so no baseline is captured for it and no selection save can be built from one.
  it('captures no baseline for a retired CLI agent or CLI Subagent, only for the live API type', () => {
    const subagent = { id: 's', subagentType: 'cli', primary_model_preset_id: 'one', claude_settings: { model: 'old', permissionMode: 'plan' } }
    expect(captureModelSelectionBaseline('subagent', subagent, revision)).toBeNull()
    expect(captureModelSelectionBaseline('agent', { id: 'a', agentType: 'cli', primary_model_preset_id: 'one' }, revision)).toBeNull()
    expect(captureModelSelectionBaseline('subagent', { ...subagent, subagentType: 'api' }, revision)).toMatchObject({
      kind: 'subagent', id: 's', type: 'api', group: { primary_model_preset_id: 'one' }
    })
  })
  it('follows only the Subagent model identity while retaining its own native draft, and recognizes a local model race', () => {
    const row = { subagentType: 'api', primary_model_preset_id: 'old', primary_model_name: 'old-model',
      provider_specific_settings: { temperature: 0.2, nativeTools: { bashEnabled: false } } }
    const remote = { subagentType: 'api', primary_model_preset_id: 'new', primary_model_name: 'new-model',
      provider_specific_settings: { temperature: 0.9, nativeTools: { bashEnabled: true } } }
    const followed = withModelSelection('subagent', row, remote)
    expect(followed).toMatchObject({ primary_model_preset_id: 'new', primary_model_name: 'new-model',
      provider_specific_settings: { temperature: 0.2, nativeTools: { bashEnabled: false } } })
    expect(sameModelSelection('subagent', row, { ...row, primary_model_name: 'new-local-choice' })).toBe(false)
    expect(sameModelSelection('subagent', row, { ...row, provider_specific_settings: { temperature: 0.5 } })).toBe(true)
  })
  it('captures raw own group facts, detaches nested data and excludes runtime settings', () => {
    const row = { id: 'a', agentType: 'api', primary_model_name: 'one', primary_model_temperature: 0,
      primary_model_capabilities: { vision: false }, provider_specific_settings: { thinking: false, nativeTools: { mode: 'plan' }, codex_model: 'keep' } }
    const base = captureModelSelectionBaseline('agent', row, revision)!
    row.primary_model_capabilities.vision = true
    row.provider_specific_settings.thinking = true
    expect(base.group).toEqual({ primary_model_name: 'one', primary_model_temperature: 0,
      primary_model_capabilities: { vision: false }, provider_specific_settings: { thinking: false } })
    expect(captureModelSelectionBaseline('agent', row, null)).toBeNull()
    expect(captureModelSelectionBaseline('agent', { ...row, id: undefined }, revision)).toBeNull()
    expect(isModelSelectionRevision(`sha256:${'A'.repeat(64)}`)).toBe(false)
  })
  it('keeps Subagent scope to four identities and merges fresh model keys without taking runtime ownership', () => {
    const row = { id: 's', subagentType: 'api', primary_model_preset_id: 'one', primary_model_temperature: 0,
      provider_specific_settings: { thinking: false, codex_model: 'keep' } }
    expect(captureModelSelectionBaseline('subagent', row, revision)?.group).toEqual({ primary_model_preset_id: 'one' })
    expect(isModelSelectionWrite('agent', { provider_specific_settings: { nativeTools: { mode: 'plan' } } })).toBe(false)
    expect(isModelSelectionWrite('agent', { provider_specific_settings: { thinking: false } })).toBe(true)
    expect(isModelSelectionWrite('subagent', { provider_specific_settings: { thinking: false } })).toBe(false)
    expect(withModelSelection('agent', { provider_specific_settings: { oldModel: 1, nativeTools: { mode: 'plan' } } },
      { provider_specific_settings: { newModel: 0, nativeTools: { mode: 'dangerous' } } }).provider_specific_settings)
      .toEqual({ newModel: 0, nativeTools: { mode: 'plan' } })
  })
})
