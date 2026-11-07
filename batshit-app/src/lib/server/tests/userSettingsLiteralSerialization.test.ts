import { describe, expect, it } from 'vitest'
import { serializeUserSettingsReservedLiterals as serialize } from '../userSettingsLiteralSerialization'
describe('single Settings envelope with fixed reserved RAW literals', () => {
  it('keeps ordinary serialization byte-identical when no reserved literal is supplied', () => {
    const value = { displayName: 'Quoted "value"', admin_settings: { other: true }, goons_settings: { scene: 'keep' } }
    expect(serialize(value)).toBe(JSON.stringify(value))
  })
  it('preserves BOTH owned raw subtrees and unknown numeric precision in one valid root', () => {
    const source = { displayName: 'Keep', admin_settings: { stale: true }, goons_settings: { scene: 'keep', globalCloset: { old: 'parsed' } } }
    const admin = '{"agent_browser":{"unknown":9007199254740993,"liveViewEnabled":false}}'
    const closet = '{"items":{"unknown":9007199254740995}}'
    const raw = serialize(source, { admin, legacyCloset: closet })
    expect(raw).toContain(`"admin_settings":${admin}`); expect(raw).toContain(`"globalCloset":${closet}`)
    expect(JSON.parse(raw)).toMatchObject({ displayName: 'Keep', goons_settings: { scene: 'keep' }, admin_settings: { agent_browser: { liveViewEnabled: false } } })
    expect(source.admin_settings).toEqual({ stale: true }); expect(source.goons_settings.globalCloset).toEqual({ old: 'parsed' })
  })
  it('never replaces a nested/string lookalike and keeps escaped user text exact', () => {
    const value = { note: '"admin_settings": {"lookalike":true}', nested: { admin_settings: 'keep' } }
    const output = JSON.parse(serialize(value, { admin: '{"owned":true}' }))
    expect(output).toEqual({ ...value, admin_settings: { owned: true } })
  })
  it('refuses malformed fixed literals instead of emitting invalid persisted JSON', () => {
    expect(() => serialize({}, { admin: 'broken' })).toThrow()
    expect(() => serialize({}, { admin: '[]' })).toThrow()
    expect(() => serialize({ goons_settings: null }, { legacyCloset: '{}' })).toThrow()
  })
})
