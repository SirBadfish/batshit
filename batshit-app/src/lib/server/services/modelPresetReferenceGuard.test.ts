import { withSettingsRecordReplacement } from './appActions/settings/lifecycle'
import { describe, expect, it, vi } from 'vitest'
import { assertPresetCopyDestinationUnreferenced, presetReferenceIds } from './modelPresetReferenceGuard'

describe('effective stored preset references', () => {
  it('counts only active modes, including the existing null-to-legacy memory fallback', () => {
    expect(presetReferenceIds('primary', { primary_model_preset_id: ' chat ',
      auto_compact_settings: { modelMode: 'current', modelPresetId: 'inactive' },
      memory_window: null, memoryWindow: { summary_model_mode: 'preset', summary_model_preset_id: ' summary ' } })).toEqual(['chat', 'summary'])
    expect(presetReferenceIds('settings', { global_auto_compact_settings: { modelMode: 'current', modelPresetId: 'inactive' } })).toEqual([])
    expect(presetReferenceIds('memory', { embedding: { lane: 'builtin', preset: { presetId: 'inactive' } } })).toEqual([])
  })
  it('uses normalized Artifact roles and preserves the distinction between clearing and activation', () => {
    expect(presetReferenceIds('artifact', { model_config: { mode: 'basic', primary: { source: 'preset', presetId: 'chosen' },
      visual: { source: 'preset', presetId: 'inactive' } } })).toEqual(['chosen'])
    expect(presetReferenceIds('artifact', { model_config: { mode: 'advanced', primary: { source: 'preset', presetId: 'chosen' },
      visual: { source: 'preset', presetId: 'visual' }, audio: { source: 'none' }, utility: { source: 'primary' } } })).toEqual(['chosen', 'visual'])
    expect(presetReferenceIds('artifact', { model_config: null, model: null })).toEqual([])
  })
})


describe('A12 strict fixed copy reference population', () => {
  it.each(['INVALID_INDEX', 'TOO_LARGE'])('refuses %s instead of an empty successful population', async answer => {
    const client = { eval: vi.fn(async () => [answer]) }
    await expect(withSettingsRecordReplacement('model:guard-copy', () => assertPresetCopyDestinationUnreferenced(client, 'owner', 'guard-copy', () => {}))).rejects.toMatchObject({ code: 'MODEL_PRESET_REFERENCE_UNAVAILABLE' })
    expect(client.eval).toHaveBeenCalledOnce()
  })
  it('refuses a missing indexed row and never calls a migrating/filtering human list reader', async () => {
    const client = { eval: vi.fn().mockResolvedValueOnce([['indexed-primary'], [], []]).mockResolvedValueOnce(['MISSING']) }
    await expect(withSettingsRecordReplacement('model:guard-copy-missing', () => assertPresetCopyDestinationUnreferenced(client, 'owner', 'guard-copy-missing', () => {}))).rejects.toMatchObject({ code: 'MODEL_PRESET_REFERENCE_UNAVAILABLE' })
    expect(client.eval).toHaveBeenCalledTimes(2)
  })
})
