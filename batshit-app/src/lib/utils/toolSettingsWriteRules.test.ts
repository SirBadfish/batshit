import { describe, expect, it } from 'vitest'
import { explicitTypedFileToolsWriteIssue as typedIssue, newSubjectToolSettings as create, retiredOperationalToolWrite as retired } from './toolSettingsWriteRules'
describe('permanent finite tool-settings write rules', () => {
  it('gives new identities explicit factoryfalse and retains duplicate true/false and full active alias', () => {
    expect(create(undefined)).toEqual({ nativeTools: { typedFileToolsEnabled: false, artifactRuntimeEnabled: true } })
    try { create({ nativeTools: [] }); throw new Error('missing refusal') } catch (error) { expect(error).toMatchObject({ status: 400 }) }
    expect(create({ nativeTools: { typedFileToolsEnabled: true, bashEnabled: false, artifactRuntimeEnabled: true }, model: 'keep' })).toEqual({ nativeTools: { typedFileToolsEnabled: true, bashEnabled: false, artifactRuntimeEnabled: true }, model: 'keep' })
    expect(create({ batshitNativeTools: { typedFileToolsEnabled: false, bashEnabled: false, unknown: 9007199254740993n } }).nativeTools)
      .toEqual({ typedFileToolsEnabled: false, bashEnabled: false, unknown: 9007199254740993n, artifactRuntimeEnabled: true })
  })
  it('refuses only finite retired operational names at their actual old three locations', () => {
    for (const provider of [{ webSearchProvider: 'exa' }, { nativeTools: { nativeAgentBrowserProfile: 'old' } }, { batshitNativeTools: { agentBrowserTimeoutMs: 5000 } }]) {
      expect(retired(provider)).toBeTypeOf('string'); expect(() => create(provider)).toThrow(/global tool option/)
    }
    expect(retired({ nativeTools: { webSearchEnabled: false, agentBrowserEnabled: true, bashEnabled: false, executionBackend: 'local', webSearchSomethingElse: 'unknown' } })).toBeNull()
  })
  it('refuses ancestor deletion, inheritance and legacy write targets without blocking unrelated sparse saves', () => {
    for (const provider of [null, { nativeTools: null }, { nativeTools: { typedFileToolsEnabled: null } }, { nativeTools: { typedFileToolsEnabled: 'false' } }, { batshitNativeTools: { typedFileToolsEnabled: false } }]) expect(typedIssue(provider)).toBeTypeOf('string')
    for (const provider of [{ nativeTools: { typedFileToolsEnabled: false } }, { nativeTools: { bashEnabled: false } }, { modelKey: null }, { batshitNativeTools: null }]) expect(typedIssue(provider)).toBeNull()
  })
})

it('keeps stale/duplicate Fabric-off intent and explicit Artifact false rather than granting the new factory', () => {
  expect((create({ nativeTools: { batshitToolsEnabled: false } }).nativeTools as any).artifactRuntimeEnabled).toBe(false)
  expect((create({ nativeTools: { artifactRuntimeEnabled: false } }).nativeTools as any).artifactRuntimeEnabled).toBe(false)
  expect(typedIssue({ nativeTools: { artifactRuntimeEnabled: null } })).toBeTypeOf('string')
})
