import { describe, expect, it } from 'vitest'
import { materializedToolSettingsProvider, planTypedFileToolsGrantMaterialization as plan, RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS, ToolSettingsMigrationRefusal } from './toolSettingsMigration'

const global = (value: unknown) => ({ kind: 'known' as const, value: { typed_file_tools: value } })
describe('Typed File Tools explicit-choice materialization intent', () => {
  it.each([true, false, ' TRUE ', ' false '])('retains recognized explicit choice %j over global inheritance', value => {
    expect(plan({ nativeTools: { typedFileToolsEnabled: value } }, global(true))).toMatchObject({
      value: typeof value === 'boolean' ? value : value.trim().toLowerCase() === 'true', source: 'agent',
      agentSource: 'nativeTools', promoteAlias: false, ensureNativeTools: false
    })
  })
  it.each([true, false])('freezes a known inherited global %j without changing its behavior', value => {
    expect(plan({ nativeTools: { typedFileToolsEnabled: null } }, global(value))).toMatchObject({ value, source: 'global' })
  })
  it('requires complete alias promotion, preserving opaque Bash and unknown siblings without a JSON roundtrip', () => {
    const alias = Object.freeze({ bashEnabled: false, unknown: 9007199254740993n })
    const source = Object.freeze({ batshitNativeTools: alias, modelKey: 'unchanged' })
    expect(plan(source, global(true))).toEqual({ value: true, artifactRuntimeEnabled: true, source: 'global', agentSource: 'batshitNativeTools',
      promoteAlias: true, ensureProviderBag: false, ensureNativeTools: true })
    expect(source.batshitNativeTools).toBe(alias)
    expect(alias.unknown).toBe(9007199254740993n)
  })
  it('keeps whole canonical precedence even when empty and never imports an ignored alias', () => {
    expect(plan({ nativeTools: {}, batshitNativeTools: { typedFileToolsEnabled: true, bashEnabled: false } }, global(false)))
      .toMatchObject({ value: false, source: 'global', agentSource: 'nativeTools', promoteAlias: false })
    expect(plan({ nativeTools: {}, batshitNativeTools: 'ignored historical value' }, global(true)).value).toBe(true)
  })
  it('distinguishes known absence/legacy null from an unavailable global read', () => {
    expect(plan(null, { kind: 'absent' })).toMatchObject({ value: false, source: 'factory', ensureProviderBag: true, ensureNativeTools: true })
    expect(plan({}, { kind: 'known', value: null })).toMatchObject({ value: false, source: 'factory' })
    expect(() => plan({}, undefined as any)).toThrow(ToolSettingsMigrationRefusal)
    expect(() => plan({}, { kind: 'unreadable' } as any)).toThrow(ToolSettingsMigrationRefusal)
    expect(() => plan({}, { kind: 'known' } as any)).toThrow(ToolSettingsMigrationRefusal)
  })
  it.each([[], 'bad', 1, true])('refuses malformed active native containers: %j', value => {
    expect(() => plan({ nativeTools: value }, global(true))).toThrow(ToolSettingsMigrationRefusal)
    expect(() => plan({ batshitNativeTools: value }, global(true))).toThrow(ToolSettingsMigrationRefusal)
  })
  it.each([0, 1, 'yes', [], {}])('refuses unrecognized grant values instead of turning them off: %j', value => {
    expect(() => plan({ nativeTools: { typedFileToolsEnabled: value } }, global(true))).toThrow(ToolSettingsMigrationRefusal)
    expect(() => plan({}, global(value))).toThrow(ToolSettingsMigrationRefusal)
  })
  it('retires only the finite named operational fields and keeps all execution/enable grants', () => {
    const retired = new Set<string>(RETIRED_AGENT_OPERATIONAL_TOOL_FIELDS)
    for (const key of ['webSearchEnabled', 'nativeWebSearchEnabled', 'agentBrowserEnabled', 'nativeAgentBrowserEnabled',
      'bashEnabled', 'executionBackend', 'typedFileToolsEnabled', 'someUnknownSibling']) expect(retired.has(key)).toBe(false)
    expect(retired.has('nativeWebSearchProvider')).toBe(true)
    expect(retired.has('nativeAgentBrowserProfilePath')).toBe(true)
  })
})

  it('transforms create/archive copies without changing source, unknown siblings or whole-bag precedence', () => {
    const source = { batshitNativeTools: { bashEnabled: false, unknown: 9007199254740993n, webSearchProvider: 'exa' },
      modelKey: 'kept', nativeWebSearchProvider: 'ddg' }
    const transformed = materializedToolSettingsProvider(source, global(true))
    expect(transformed).toEqual({ modelKey: 'kept', batshitNativeTools: { bashEnabled: false, unknown: 9007199254740993n },
      nativeTools: { bashEnabled: false, unknown: 9007199254740993n, typedFileToolsEnabled: true, artifactRuntimeEnabled: true } })
    expect(source.batshitNativeTools.webSearchProvider).toBe('exa')
    expect(materializedToolSettingsProvider({ nativeTools: {}, batshitNativeTools: { bashEnabled: false } }, global(false)).nativeTools)
      .toEqual({ typedFileToolsEnabled: false, artifactRuntimeEnabled: true })
  })

  it('materializes current effective Artifact capability independently of old discovery, preserving Fabric fallback', () => {
    for (const [source, expected] of [[undefined, true], [{ nativeTools: { batshitToolsEnabled: false } }, false], [{ nativeTools: { artifactRuntimeEnabled: false, batshitToolsEnabled: true } }, false], [{ nativeTools: { artifactRuntimeEnabled: true, batshitToolsEnabled: false } }, true], [{ batshitNativeTools: { nativeBatshitToolsEnabled: false } }, false]] as const) {
      expect(plan(source, { kind: 'absent' }).artifactRuntimeEnabled).toBe(expected)
      expect((materializedToolSettingsProvider(source, { kind: 'absent' }).nativeTools as any).artifactRuntimeEnabled).toBe(expected)
    }
  })
