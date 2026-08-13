import { describe, expect, it } from 'vitest'

import {
  ARTIFACT_TOOL_GRID_GROUP_NAME,
  createDefaultArtifactToolGridSettings,
  createDefaultFabricToolGridSettings,
  FABRIC_TOOL_GRID_GROUP_NAME,
  normalizeArtifactToolGridSettings,
  normalizeFabricToolGridSettings
} from '../toolGridBrokerFamilies'

/**
 * SA-096 P3 / DL-6: the untouched state must be the right state. These pin the two
 * defaults and, more importantly, that they survive a partial settings object — the
 * failure mode a resolver-side fallback would have had.
 */
describe('broker family Tool Grid settings', () => {
  it('defaults Fabric to group-only and Artifact to hints', () => {
    expect(createDefaultFabricToolGridSettings().dcmDisplayDefaults.groups).toEqual({
      [FABRIC_TOOL_GRID_GROUP_NAME]: 'group-only'
    })
    expect(createDefaultArtifactToolGridSettings().dcmDisplayDefaults.groups).toEqual({
      [ARTIFACT_TOOL_GRID_GROUP_NAME]: 'group+tools+hints'
    })
  })

  it('seeds the default when nothing is stored', () => {
    expect(normalizeFabricToolGridSettings(null).dcmDisplayDefaults.groups).toEqual({
      [FABRIC_TOOL_GRID_GROUP_NAME]: 'group-only'
    })
    expect(normalizeArtifactToolGridSettings(undefined).dcmDisplayDefaults.groups).toEqual({
      [ARTIFACT_TOOL_GRID_GROUP_NAME]: 'group+tools+hints'
    })
  })

  it('seeds the default when a partial settings object omits this family group', () => {
    const stored = { dcmDisplayDefaults: { version: 1, groups: {}, tools: { 'sys.zip.fetch': 'name-only' } } }
    const normalized = normalizeFabricToolGridSettings(stored)

    expect(normalized.dcmDisplayDefaults.groups[FABRIC_TOOL_GRID_GROUP_NAME]).toBe('group-only')
    expect(normalized.dcmDisplayDefaults.tools['sys.zip.fetch']).toBe('name-only')
  })

  it('keeps an explicit user choice, including hidden', () => {
    const shown = normalizeFabricToolGridSettings({
      dcmDisplayDefaults: { version: 1, groups: { [FABRIC_TOOL_GRID_GROUP_NAME]: 'group+tools+names' }, tools: {} }
    })
    expect(shown.dcmDisplayDefaults.groups[FABRIC_TOOL_GRID_GROUP_NAME]).toBe('group+tools+names')

    const hidden = normalizeArtifactToolGridSettings({
      dcmDisplayDefaults: { version: 1, groups: { [ARTIFACT_TOOL_GRID_GROUP_NAME]: 'hidden' }, tools: {} }
    })
    expect(hidden.dcmDisplayDefaults.groups[ARTIFACT_TOOL_GRID_GROUP_NAME]).toBe('hidden')
  })

  it('normalizes the legacy group+tools mode into hints', () => {
    const normalized = normalizeArtifactToolGridSettings({
      dcmDisplayDefaults: { version: 1, groups: { [ARTIFACT_TOOL_GRID_GROUP_NAME]: 'group+tools' }, tools: {} }
    })
    expect(normalized.dcmDisplayDefaults.groups[ARTIFACT_TOOL_GRID_GROUP_NAME]).toBe(
      'group+tools+hints'
    )
  })
})
