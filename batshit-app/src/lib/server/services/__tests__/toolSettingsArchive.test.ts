import { describe, expect, it } from 'vitest'
import { materializeArchiveToolSettings } from '../toolSettingsArchive'
const user = 'archive_owner'
const settings = (value: unknown) => ({ key: `user:${user}:settings`, type: 'json', value: { user_id: user, global_tool_grid_settings: { typed_file_tools: value, other: true } } })
const agent = (id: string, provider?: unknown, kind = 'agent') => ({ key: `${kind}:${id}`, type: 'json', value: { id, user_id: user, provider_specific_settings: provider, unknown: 9007199254740993n } })
function convert(records: Array<{ key: string; type: string; value: any }>) {
  return materializeArchiveToolSettings([...records,
    ...(['agent', 'subagent'] as const).map(prefix => ({ key: `user:${user}:${prefix === 'agent' ? 'agents' : 'subagents'}`, type: 'set',
      value: records.filter(record => record.key === `${prefix}:${record.value?.id}`).map(record => record.value.id) }))], user)
}
describe('archive-owned tool-settings conversion before publication', () => {
  it('uses that archive global cut for both populations and leaves source/rollback copies untouched', () => {
    const source = [settings(true), agent('primary', { batshitNativeTools: { bashEnabled: false, unknown: 9007199254740995n, webSearchProvider: 'exa' } }),
      agent('child', { nativeTools: { typedFileToolsEnabled: ' FALSE ' } }, 'subagent')]
    const output = convert(source)
    expect(output[1].value).toMatchObject({ unknown: 9007199254740993n, provider_specific_settings: {
      nativeTools: { bashEnabled: false, unknown: 9007199254740995n, typedFileToolsEnabled: true } } })
    expect(output[2].value).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } })
    expect(output[0].value).toEqual({ user_id: user, global_tool_grid_settings: { other: true } })
    expect(source[0].value).toHaveProperty('global_tool_grid_settings.typed_file_tools', true)
    expect(source[1].value).toHaveProperty('provider_specific_settings.batshitNativeTools.webSearchProvider', 'exa')
  })
  it('uses factoryfalse for known missing settings and keeps empty canonical precedence', () => {
    const output = convert([agent('primary', { nativeTools: {}, batshitNativeTools: { typedFileToolsEnabled: true, bashEnabled: false } })])
    expect(output[0].value).toMatchObject({ provider_specific_settings: { nativeTools: { typedFileToolsEnabled: false } } })
  })
  it('refuses malformed globals even for zero subjects and validates every subject before publication', () => {
    expect(() => convert([settings('invalid')])).toThrow(/malformed/)
    expect(() => convert([settings(true), agent('first'), agent('bad', { nativeTools: [] })])).toThrow(/malformed/)
    expect(() => convert([{ key: `user:${user}:settings`, type: 'json', value: null }])).toThrow(/malformed/)
  })
})

  it('preserves ancillary mapping sets and refuses a missing expected subject root', () => {
    const mapping = { key: 'agent:primary:subagents', type: 'set', value: ['child'] }
    expect(convert([agent('primary'), mapping])).toContain(mapping)
    expect(() => materializeArchiveToolSettings([{ key: `user:${user}:agents`, type: 'set', value: ['missing'] }], user)).toThrow(/missing/)
  })

it('preserves archived Fabric-fallback/explicit Artifact intent without reading live or discovery state', () => {
  const result = convert([settings(true), agent('off', { nativeTools: { batshitToolsEnabled: false } }), agent('on', { nativeTools: { batshitToolsEnabled: false, artifactRuntimeEnabled: true } })])
  expect(result.find(row => row.key === 'agent:off')?.value).toMatchObject({ provider_specific_settings: { nativeTools: { artifactRuntimeEnabled: false } } })
  expect(result.find(row => row.key === 'agent:on')?.value).toMatchObject({ provider_specific_settings: { nativeTools: { artifactRuntimeEnabled: true } } })
})
