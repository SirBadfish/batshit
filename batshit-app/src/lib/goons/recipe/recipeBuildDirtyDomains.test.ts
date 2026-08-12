import { describe, expect, it } from 'vitest'
import type { RecipeSiblingStateRecord, RecipeStateSnapshot } from './recipeContracts'
import { classifyRecipeBuildDirtyDomains } from './recipeBuildDirtyDomains'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function sibling(
  id: string,
  contract: string,
  value: number,
  hash = HASH_A
): RecipeSiblingStateRecord {
  return {
    id,
    contract,
    definitionSha256: HASH_A,
    stateSha256: hash,
    state: {
      schemaVersion: contract,
      definitionSha256: HASH_A,
      value
    }
  }
}

function state(overrides: Partial<RecipeStateSnapshot> = {}): RecipeStateSnapshot {
  return {
    contract: 'goon-recipe-state/v1',
    stateSha256: HASH_A,
    appearanceDials: {
      contract: 'appearance-dial-values/v2',
      definitionSha256: HASH_A,
      neutralId: 'neutral-v1',
      neutralRecipeSha256: HASH_A,
      values: { body_width: 0 },
      unlockedDialIds: []
    },
    siblings: [],
    ...overrides
  }
}

describe('Recipe build dirty-domain classifier', () => {
  it('requires initial preparation when no saved Recipe state exists', () => {
    expect(classifyRecipeBuildDirtyDomains({ savedState: null, draftState: state() })).toEqual({
      action: 'prepare',
      requiresBuild: true,
      hasAppearanceChanges: false,
      dirtyDomains: ['initial-preparation']
    })
  })

  it('does not build for a save whose Recipe state is unchanged', () => {
    const saved = state()
    const draft = structuredClone(saved)

    // Runtime-only editor changes are intentionally absent from both inputs.
    // Camera, moods, motions, Eye Contact behavior, voice, and wardrobe cannot
    // affect this equal-state decision.
    expect(classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft })).toEqual({
      action: 'none',
      requiresBuild: false,
      hasAppearanceChanges: false,
      dirtyDomains: []
    })
  })

  it('coalesces a complete appearance batch into one update decision', () => {
    const saved = state({
      siblings: [
        sibling('facialArtwork', 'facial-artwork-state/v3', 0),
        sibling('eyeAppearance', 'eye-appearance-state/v1', 0)
      ]
    })
    const draft = state({
      stateSha256: HASH_B,
      appearanceDials: {
        ...saved.appearanceDials,
        values: { body_width: 0.45 }
      },
      siblings: [
        sibling('facialArtwork', 'facial-artwork-state/v3', 1, HASH_B),
        sibling('eyeAppearance', 'eye-appearance-state/v1', 1, HASH_B)
      ]
    })

    expect(classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft })).toEqual({
      action: 'update',
      requiresBuild: true,
      hasAppearanceChanges: true,
      dirtyDomains: ['appearance-dials', 'eye-appearance', 'facial-artwork']
    })
  })

  it('fails safe when a future Recipe-owned sibling changes', () => {
    const saved = state()
    const draft = state({
      stateSha256: HASH_B,
      siblings: [sibling('futureSurface', 'future-surface-state/v1', 1, HASH_B)]
    })
    expect(
      classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft }).dirtyDomains
    ).toEqual(['recipe-sibling:futureSurface'])
  })

  it('classifies Nail Surface changes as their own build domain', () => {
    const saved = state({
      siblings: [sibling('nailSurface', 'nail-surface-state/v1', 0)]
    })
    const draft = state({
      stateSha256: HASH_B,
      siblings: [sibling('nailSurface', 'nail-surface-state/v1', 1, HASH_B)]
    })
    expect(
      classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft }).dirtyDomains
    ).toEqual(['nail-surface'])
  })

  it('classifies Lip Artwork and Nail Surface off states with their owning domains', () => {
    const saved = state({ siblings: [] })
    const draft = state({
      stateSha256: HASH_B,
      siblings: [
        sibling('lipArtworkPresence', 'lip-artwork-presence-state/v1', 0),
        sibling('nailSurfacePresence', 'nail-surface-presence-state/v1', 0)
      ]
    })
    expect(
      classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft }).dirtyDomains
    ).toEqual(['lip-artwork', 'nail-surface'])
  })

  it('classifies Skin Appearance changes as their own build domain', () => {
    const saved = state({
      siblings: [sibling('skinAppearance', 'skin-appearance-state/v1', 0)]
    })
    const draft = state({
      stateSha256: HASH_B,
      siblings: [sibling('skinAppearance', 'skin-appearance-state/v1', 1, HASH_B)]
    })
    expect(
      classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft }).dirtyDomains
    ).toEqual(['skin-appearance'])
  })

  it('classifies Base Color Artwork as part of the Skin Appearance build domain', () => {
    const saved = state({ siblings: [] })
    const draft = state({
      stateSha256: HASH_B,
      siblings: [
        sibling('skinMaterialArtwork', 'skin-material-artwork-state/v2', 1, HASH_B)
      ]
    })
    expect(
      classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft }).dirtyDomains
    ).toEqual(['skin-appearance'])
  })

  it('classifies immutable Hair Asset selection and color changes as Hair work', () => {
    const saved = state({ siblings: [] })
    const draft = state({
      stateSha256: HASH_B,
      siblings: [sibling('hairState', 'hair-state/v2', 1, HASH_B)]
    })
    expect(
      classifyRecipeBuildDirtyDomains({ savedState: saved, draftState: draft }).dirtyDomains
    ).toEqual(['hair'])
  })
})
