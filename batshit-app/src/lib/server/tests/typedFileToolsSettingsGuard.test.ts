import { describe, expect, it } from 'vitest'
import { captureSettingsLifecycle, withSettingsRecordReplacement } from '../services/appActions/settings/lifecycle'
import { makeTypedToolsSnapshot, typedToolsReadPaths, typedToolsWriteGuard } from '../typedFileToolsSettingsGuard'
function source(value: boolean, kind: 'agent' | 'subagent' = 'agent') {
  const raw = typedToolsReadPaths(kind).map(path => path === '$.id' ? '["fixture"]' : path === '$.user_id' ? '["owner"]' : path === '$.created_at' ? '["birth"]' : path.endsWith('typedFileToolsEnabled') ? `[${value}]` : '[]')
  return { raw, lifecycle: captureSettingsLifecycle([`${kind}:fixture`]) }
}
describe('Typed File Tools original human choice base', () => {
  it.each(['agent', 'subagent'] as const)('binds %s exact grant, type/identity and lifecycle bytes without a new saved revision', kind => {
    const before = source(false, kind)
    const snapshot = makeTypedToolsSnapshot('fixture', kind, before.raw, before.lifecycle)
    expect(typedToolsWriteGuard(snapshot, snapshot.revision)).toEqual({ paths: typedToolsReadPaths(kind), raw: before.raw })
    const changed = [...before.raw]; changed[changed.length - 1] = '[true]'
    expect(() => typedToolsWriteGuard(makeTypedToolsSnapshot('fixture', kind, changed, before.lifecycle), snapshot.revision)).toThrow(/changed/)
    expect(() => typedToolsWriteGuard(snapshot, undefined)).toThrow(/Read the saved/)
  })
  it('does not certify missing/inherited or malformed grant state as an explicit choice', () => {
    const before = source(false)
    for (const rawValue of ['[]', '[null]', '["false"]', '[{}]']) {
      const raw = [...before.raw]; raw[raw.length - 1] = rawValue
      expect(() => makeTypedToolsSnapshot('fixture', 'agent', raw, before.lifecycle)).toThrow(/changed/)
    }
  })
  it('rejects an old same-id read after actual replacement even when stored grant bytes match', async () => {
    const before = source(false); const snapshot = makeTypedToolsSnapshot('fixture', 'agent', before.raw, before.lifecycle)
    await withSettingsRecordReplacement('agent:fixture', async () => {})
    expect(() => typedToolsWriteGuard(snapshot, snapshot.revision)).toThrow(/identity changed/)
  })
})
