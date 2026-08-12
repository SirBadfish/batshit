import { describe, expect, it } from 'vitest'

import {
  HAIR_COLOR_PRESETS,
  createEmbeddedHairMaterialMetadata,
  evaluateHairValueMasterLinear,
  inspectHairMaterialPng,
  parseEmbeddedHairMaterial
} from './hairMaterial'
import { createHairState } from './hairAssets'
import {
  createHairAssetFixture,
  createRigidHairGlbFixture,
  HAIR_HIGHLIGHT_MASK_PNG_FIXTURE,
  HAIR_NEUTRAL_VALUE_PNG_FIXTURE
} from './recipe/fixtures/hairAssetFixture'
import type { RecipeSource } from './recipe/recipeContracts'

const HASH = 'a'.repeat(64)

async function fixture() {
  return createHairAssetFixture({
    recipeSource: {
      identities: {
        baseId: 'batshit-base-female',
        fitFamily: 'batshit-base-female-v1',
        definitionSha256: HASH,
        physicalBasisSha256: HASH,
        topologySha256: HASH,
        skeletonHierarchySha256: HASH
      }
    } as RecipeSource,
    mainBytes: createRigidHairGlbFixture(),
    headNode: 'head'
  })
}

describe('Hair H3 neutral material contract', () => {
  it('binds exact PNG dimensions and embedded palette metadata', async () => {
    const asset = await fixture()
    const state = createHairState(asset, {
      baseColor: '#101820',
      highlightColor: '#6f4a8e'
    })

    expect(
      inspectHairMaterialPng(HAIR_NEUTRAL_VALUE_PNG_FIXTURE, asset.material, 'neutral-value')
    ).toMatchObject({ width: 1, height: 1 })
    expect(
      inspectHairMaterialPng(HAIR_HIGHLIGHT_MASK_PNG_FIXTURE, asset.material, 'highlight-mask')
    ).toMatchObject({ width: 1, height: 1 })
    const metadata = createEmbeddedHairMaterialMetadata(asset, state)
    expect(parseEmbeddedHairMaterial(metadata)).toEqual(metadata)
    expect(metadata).toMatchObject({
      baseColor: '#101820',
      highlightColor: '#6f4a8e',
      normalTexture: false,
      roughnessTexture: false
    })
  })

  it('retains authored value detail for light, dark, natural, and fantasy palettes', () => {
    const palettes = [
      { base: [1, 0.82, 0.55], highlight: [1, 0.95, 0.8] },
      { base: [0, 0, 0], highlight: [0.06, 0.01, 0.12] },
      { base: [0.28, 0.08, 0.025], highlight: [0.7, 0.22, 0.06] },
      { base: [0.02, 0.16, 0.4], highlight: [0.55, 0.05, 0.85] }
    ] as const

    for (const palette of palettes) {
      const shadow = evaluateHairValueMasterLinear({ ...palette, mask: 0.35, value: 0.3 })
      const authoredMid = evaluateHairValueMasterLinear({ ...palette, mask: 0.35, value: 0.5 })
      const sheen = evaluateHairValueMasterLinear({ ...palette, mask: 0.35, value: 0.82 })
      expect(shadow.every((value, index) => value <= authoredMid[index]!)).toBe(true)
      expect(sheen.every((value, index) => value >= authoredMid[index]!)).toBe(true)
      expect(sheen.every((value) => value >= 0 && value <= 1)).toBe(true)
    }

    const literalBlackSheen = evaluateHairValueMasterLinear({
      base: [0, 0, 0],
      highlight: [0, 0, 0],
      mask: 0,
      value: 0.82
    })
    expect(literalBlackSheen.every((value) => value > 0)).toBe(true)
    expect(HAIR_COLOR_PRESETS.map((preset) => preset.id)).toEqual([
      'dark-purple',
      'black-violet',
      'chestnut',
      'platinum',
      'ocean-blue'
    ])
  })

  it('rejects structurally truncated PNG material inputs', async () => {
    const asset = await fixture()
    expect(() =>
      inspectHairMaterialPng(
        HAIR_NEUTRAL_VALUE_PNG_FIXTURE.subarray(0, 33),
        asset.material,
        'neutral-value'
      )
    ).toThrow('PNG ending')
  })

  it('uses the painted mask only to choose Base versus Highlight territory', () => {
    const base = [0.1, 0.2, 0.3] as const
    const highlight = [0.7, 0.4, 0.2] as const
    expect(evaluateHairValueMasterLinear({ base, highlight, mask: 0, value: 0.5 })).toEqual(base)
    expect(evaluateHairValueMasterLinear({ base, highlight, mask: 1, value: 0.5 })).toEqual(
      highlight
    )
  })
})
