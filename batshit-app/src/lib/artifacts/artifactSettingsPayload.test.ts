import { describe, expect, it } from 'vitest'
import { changedArtifactSettingsFields } from './artifactSettingsPayload'

// BL-546: a Settings > Artifacts save carries only the fields that differ from what the panel loaded.

const loaded = {
  name: 'Image Maker',
  content: '<div>loaded</div>',
  zone: null,
  mode: 'edit',
  icon_ref: { kind: 'lucide', id: 'image' },
  agent_allowlist: ['agent_a'],
  metadata: { source_type: 'built_in', enforce_batshit_artifact_structure: true, fabric_fields: [{ fabricId: 'prompt' }] }
}

describe('changedArtifactSettingsFields', () => {
  it('returns nothing when nothing changed, whatever the key order of an object', () => {
    expect(
      changedArtifactSettingsFields(loaded, {
        ...loaded,
        icon_ref: { id: 'image', kind: 'lucide' },
        metadata: { fabric_fields: [{ fabricId: 'prompt' }], enforce_batshit_artifact_structure: true, source_type: 'built_in' }
      })
    ).toEqual({})
  })

  it('returns only the changed fields, and only the changed metadata keys', () => {
    expect(
      changedArtifactSettingsFields(loaded, {
        ...loaded,
        zone: 'panel',
        mode: 'published',
        metadata: { ...loaded.metadata, enforce_batshit_artifact_structure: false }
      })
    ).toEqual({ zone: 'panel', mode: 'published', metadata: { enforce_batshit_artifact_structure: false } })
  })

  it('sends a list or a cleared value when it changed (an emptied allowlist, a null marker)', () => {
    expect(
      changedArtifactSettingsFields(loaded, {
        ...loaded,
        agent_allowlist: [],
        metadata: { ...loaded.metadata, runtime_manager: null }
      })
    ).toEqual({ agent_allowlist: [], metadata: { runtime_manager: null } })
  })
})
