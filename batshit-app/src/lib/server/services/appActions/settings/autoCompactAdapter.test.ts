import { describe, expect, it } from 'vitest'
import { validateAutoCompactChanges } from '$lib/appActions/settings/autoCompactPreferences'
import { projectAutoCompact, planAutoCompactChanges } from './autoCompactAdapter'
import type { SettingsSubjectEntry } from './subjects'

const primary: SettingsSubjectEntry = { subject: { kind: 'primary', id: 'compact_fixture' }, status: 'available', type: 'api' }
describe('common Auto Compact strict preferences and canonical effective owner', () => {
  it('admits only a strict nonempty partial with exact enum and integer/null threshold', () => {
    for (const bad of [{}, null, [], { mode: null }, { mode: 'AUTO' }, { triggerMode: null }, { remainingTokens: '2000' }, { remainingTokens: 1000.1 }, { remainingTokens: 999 }, { remainingTokens: 1000001 }, { mode: undefined }, { modelMode: 'current' }, { mode: 'auto', extra: false }]) expect(() => validateAutoCompactChanges(bad)).toThrow()
    expect(validateAutoCompactChanges({ mode: 'inherit', triggerMode: 'remaining_tokens', remainingTokens: null })).toEqual({ mode: 'inherit', triggerMode: 'remaining_tokens', remainingTokens: null })
  })
  it('reports inheritance and null fallback without guessing a Smart context window', () => {
    const projected = projectAutoCompact(primary, { auto_compact_settings: { triggerMode: 'remaining_tokens', remainingTokens: null }, __autoCompactGlobal: { mode: 'auto', triggerMode: 'remaining_tokens', remainingTokens: 5000 } })
    expect(projected).toMatchObject({ status: 'available', fields: { mode: { stored: { state: 'unset' }, effective: { value: 'auto' }, source: 'global' }, remainingTokens: { stored: { state: 'set', value: null }, effective: { state: 'unknown', reason: 'smart_threshold_uses_runtime_context_window' } } } })
  })
  it('retains raw differences and changes only requested common members', () => {
    const record = { auto_compact_settings: { modelMode: 'preset', modelPresetId: 'advanced', prompt: 'private', future: { a: 1 } }, __autoCompactGlobal: { mode: 'ask', triggerMode: 'smart' } }
    const plan = planAutoCompactChanges(primary, record, { mode: 'inherit' })
    expect(plan.changes).toEqual({ mode: 'inherit' })
    expect(plan.globalFields).toEqual(['mode', 'triggerMode'])
    expect(JSON.stringify(plan)).not.toMatch(/advanced|private|future/)
    expect(record.auto_compact_settings.prompt).toBe('private')
  })
  it('captures only before/result global dependencies and ignores unused malformed globals', () => {
    const explicit = { auto_compact_settings: { mode: 'off', triggerMode: 'smart' }, __autoCompactGlobal: 'malformed' }
    expect(planAutoCompactChanges(primary, explicit, { mode: 'ask' }).globalFields).toEqual([])
    const inherited = { auto_compact_settings: { mode: 'off', triggerMode: 'smart' }, __autoCompactGlobal: { mode: 'auto', triggerMode: 'remaining_tokens', remainingTokens: 2345 } }
    expect(planAutoCompactChanges(primary, inherited, { triggerMode: 'inherit' }).globalFields).toEqual(['triggerMode', 'remainingTokens'])
  })
  it('never repairs malformed common state or adopts delegated subjects', () => {
    for (const common of ['bad', [], { mode: null }, { triggerMode: 'future' }, { remainingTokens: '2000' }]) {
      expect(projectAutoCompact(primary, { auto_compact_settings: common })).toMatchObject({ status: 'unavailable' })
      expect(() => planAutoCompactChanges(primary, { auto_compact_settings: common }, { mode: 'off' })).toThrow()
    }
    expect(projectAutoCompact({ ...primary, subject: { kind: 'subagent', id: 'sub' } }, {})).toMatchObject({ status: 'unavailable', reason: 'auto_compact_primary_only' })
    // SA-139 R4: a Primary subject is API only; a leftover `cli` Primary entry is not adopted.
    expect(projectAutoCompact({ ...primary, type: 'cli' }, { auto_compact_settings: null })).toMatchObject({ status: 'unavailable', reason: 'auto_compact_primary_only' })
    expect(() => planAutoCompactChanges({ ...primary, type: 'cli' }, { auto_compact_settings: null }, { mode: 'off' })).toThrow('auto_compact_primary_only')
    expect(projectAutoCompact(primary, { auto_compact_settings: null })).toMatchObject({ status: 'available' })
  })
})
