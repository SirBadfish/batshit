import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import {
  analyzeGuidedDufClothesScene,
  buildGuidedDufOverlayPieceId,
  isSupportedGuidedDufClothesMaterialName
} from '$lib/goons/guidedDufClothes'

describe('guidedDufClothes helpers', () => {
  it('accepts real clothing slot materials and excludes body skin overlay lanes', () => {
    expect(isSupportedGuidedDufClothesMaterialName('N00_004_01_Tops_01_CLOTH')).toBe(true)
    expect(isSupportedGuidedDufClothesMaterialName('N00_000_00_Body_00_SKIN')).toBe(false)
  })

  it('builds stable piece ids from overlay id and slot name', () => {
    expect(buildGuidedDufOverlayPieceId('overlay_1', 'N00_004_01_Tops_01_CLOTH')).toBe(
      'duf_overlay_1_N00_004_01_Tops_01_CLOTH'
    )
  })

  it('groups supported DUF clothing meshes by slot and skips base-matching nodes', () => {
    const baseRoot = new THREE.Group()
    const existingTop = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ name: 'N00_004_01_Tops_01_CLOTH' })
    )
    existingTop.name = 'ExistingTop'
    baseRoot.add(existingTop)

    const overlayRoot = new THREE.Group()

    const topLeft = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ name: 'N00_004_01_Tops_01_CLOTH' })
    )
    topLeft.name = 'ImportedTop_A'
    overlayRoot.add(topLeft)

    const topRight = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ name: 'N00_004_01_Tops_01_CLOTH' })
    )
    topRight.name = 'ImportedTop_B'
    overlayRoot.add(topRight)

    const skinOverlay = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ name: 'N00_000_00_Body_00_SKIN' })
    )
    skinOverlay.name = 'ImportedSocks'
    overlayRoot.add(skinOverlay)

    const duplicateExisting = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ name: 'N00_001_01_Bottoms_01_CLOTH' })
    )
    duplicateExisting.name = 'ExistingTop'
    overlayRoot.add(duplicateExisting)

    const analysis = analyzeGuidedDufClothesScene('overlay_1', overlayRoot, baseRoot)

    expect(analysis.pieces).toEqual([
      {
        id: 'duf_overlay_1_N00_004_01_Tops_01_CLOTH',
        label: 'T-Shirt',
        runtimeNodeNames: ['ImportedTop_A', 'ImportedTop_B'],
        category: 'DUF',
        defaultOn: true,
        source: 'duf-overlay',
        overlayId: 'overlay_1',
        materialNames: ['N00_004_01_Tops_01_CLOTH']
      }
    ])
    expect(analysis.warnings).toContain(
      'Skipped skin-overlay clothing lanes: N00_000_00_Body_00_SKIN.'
    )
    expect(analysis.warnings).toContain(
      'Skipped meshes already present on the base avatar: ExistingTop.'
    )
  })
})
