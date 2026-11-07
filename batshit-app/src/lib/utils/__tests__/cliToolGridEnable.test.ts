import { describe, expect, it } from 'vitest'
import { CLI_GROUP_KEY as key, assertCliGlobalSettingsRead, captureCliDcmWrite, cliGroupEnablePatch, effectiveCliGroupMode, readCliDcmPair, readCliNativeChoice } from '../cliToolGridEnable'

describe('one explicit CLI family enable preserves discovery ownership', () => {
  it.each([{ provider_specific_settings: [] }, { provider_specific_settings: 1 }, { provider_specific_settings: { nativeTools: 'wrong' } }, { provider_specific_settings: { nativeTools: { cliToolsEnabled: {} } } }])('refuses malformed native pair readback %j', record => {
    expect(() => readCliNativeChoice(record)).toThrow(/unavailable/)
  })
  it.each(['group-only', 'group+tools+names', 'group+tools+hints'] as const)('keeps a visible saved %s mode unchanged', mode => {
    const source = { groups: { [key]: mode }, tools: { member: 'hidden' } }
    expect(effectiveCliGroupMode(source, 'hidden')).toBe(mode)
    expect(cliGroupEnablePatch(source, 'hidden')).toBeUndefined()
  })
  it('restores a retained explicit preference before a hidden global and touches no members', () => {
    expect(cliGroupEnablePatch({ groups: { [key]: 'hidden', other: 'group-only' }, groupDisplayPreferences: { [key]: 'group+tools+names' }, tools: { member: 'hidden' } }, 'hidden'))
      .toEqual({ groups: { [key]: 'group+tools+names' }, groupDisplayPreferences: { [key]: 'group+tools+names' } })
  })
  it('restores inheritance only when its actual global group is visible', () => {
    expect(cliGroupEnablePatch({ groups: { [key]: 'hidden' } }, 'group-only')).toEqual({ groups: { [key]: null }, groupDisplayPreferences: { [key]: 'use-global' } })
    expect(cliGroupEnablePatch({}, 'hidden')).toEqual({ groups: { [key]: 'group+tools+hints' }, groupDisplayPreferences: { [key]: 'group+tools+hints' } })
  })
  it('uses the full viewed legacy block only for first canonical promotion', () => {
    const legacy = { version: 1, groups: { other: 'group-only', [key]: 'hidden' }, tools: { member: 'hidden' }, toolDisplayPreferences: { member: 'name-only' } }
    const patch = cliGroupEnablePatch(legacy, 'group-only')!
    const promoted = captureCliDcmWrite({ dcm_display_settings: legacy }, patch)
    expect(promoted).toMatchObject({ version: 1, groups: { other: 'group-only' }, tools: { member: 'hidden' }, toolDisplayPreferences: { member: 'name-only' } })
    expect(captureCliDcmWrite({ dcmDisplaySettings: legacy }, patch)).toEqual(patch)
    expect(captureCliDcmWrite({ dcm_display_settings: legacy })).toBeUndefined()
  })
  it('reads only the saved pair, normalizes its supported legacy mode, and explicitly removes absent entries', () => {
    expect(readCliDcmPair({ dcm_display_settings: { groups: { other: 'hidden', [key]: 'group+tools' } } }))
      .toEqual({ groups: { [key]: 'group+tools+hints' }, groupDisplayPreferences: { [key]: 'group+tools+hints' } })
    expect(readCliDcmPair({})).toEqual({ groups: { [key]: null }, groupDisplayPreferences: { [key]: null } })
    expect(() => readCliDcmPair({ dcmDisplaySettings: { groups: [] } })).toThrow(/unavailable/)
  })
  it.each([{}, { settings: [] }, { settings: 1 }, { settings: {}, success: false }, { settings: { global_tool_grid_settings: { cli: { dcmDisplayDefaults: { groups: { 'CLI Tools': 'future-mode' } } } } } }])('refuses unknown global evidence %j', payload => {
    expect(() => assertCliGlobalSettingsRead(payload)).toThrow()
  })
  it.each([{ settings: null }, { settings: {} }, { settings: { global_tool_grid_settings: { cli: { dcmDisplayDefaults: { groups: { 'CLI Tools': 'hidden' } } } } } }])('accepts confirmed empty or configured global evidence %j', payload => {
    expect(() => assertCliGlobalSettingsRead(payload)).not.toThrow()
  })
})
