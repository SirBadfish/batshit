import { describe, expect, it } from 'vitest'
import { adoptTypedFileToolsAck, captureTypedFileToolsBaseline, typedFileToolsBodyValue, withExpectedTypedFileTools, withoutExpectedTypedFileTools, withTypedFileToolsChoice, withoutTypedFileToolsChoice } from './typedFileToolsSave'
const token = `sha256:${'a'.repeat(64)}`
const next = `sha256:${'b'.repeat(64)}`
const row = { id: 'subject', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false, bashEnabled: false }, modelKey: 'keep' } }
describe('mounted Typed File Tools original choice base', () => {
  it('requires same-detail explicit boolean+token and keeps false distinct from absent/inherited', () => {
    expect(captureTypedFileToolsBaseline('agent', 'subject', row, token)).toMatchObject({ value: false, token })
    expect(captureTypedFileToolsBaseline('agent', 'other', row, token)).toBeNull()
    expect(captureTypedFileToolsBaseline('agent', 'subject', row, null)).toBeNull()
    expect(captureTypedFileToolsBaseline('agent', 'subject', { ...row, provider_specific_settings: null }, token)).toBeNull()
  })
  it('carries only the original token for a named typed write and strips request metadata from record copies', () => {
    const base = captureTypedFileToolsBaseline('agent', 'subject', row, token)
    const body = { provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } } }
    expect(withExpectedTypedFileTools(body, base)).toEqual({ ...body, expectedTypedFileTools: token })
    expect(() => withExpectedTypedFileTools(body, null)).toThrow(/nothing was sent/)
    expect(withExpectedTypedFileTools({ displayName: 'Other' }, null)).toEqual({ displayName: 'Other' })
    expect(withoutExpectedTypedFileTools(withExpectedTypedFileTools(body, base))).toEqual(body)
  })
  it('does not adopt another flight/target/value or a malformed/unknown receipt', () => {
    const base = captureTypedFileToolsBaseline('subagent', 'subject', row, token)
    expect(adoptTypedFileToolsAck(base, token, true, { revision: next, value: true })).toMatchObject({ kind: 'subagent', id: 'subject', token: next, value: true })
    for (const [expected, wanted, ack] of [[next, true, { revision: next, value: true }], [token, false, { revision: next, value: true }], [token, true, {}]]) expect(adoptTypedFileToolsAck(base, expected, wanted, ack)).toBeNull()
  })
  it('replaces only the grant for explicit recovery and never mutates the old form or another sibling', () => {
    const changed = withTypedFileToolsChoice(row, true)
    expect(changed).toEqual({ ...row, provider_specific_settings: { ...row.provider_specific_settings, nativeTools: { typedFileToolsEnabled: true, bashEnabled: false } } })
    expect(typedFileToolsBodyValue(row)).toBe(false)
  })
})

  it('holds only the unadmitted grant while preserving unrelated sparse work and the original draft', () => {
    const body = { displayName: 'Current', provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true, bashEnabled: false }, providerKey: 5 } }
    expect(withoutTypedFileToolsChoice(body)).toEqual({ displayName: 'Current', provider_specific_settings: { nativeTools: { bashEnabled: false }, providerKey: 5 } })
    expect(typedFileToolsBodyValue(body)).toBe(true)
    expect(withoutTypedFileToolsChoice({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: true } } })).toEqual({})
  })
