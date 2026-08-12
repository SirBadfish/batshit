import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { applyEmbeddedHairMaterials } from './hairMaterial.engine'
import { EMBEDDED_HAIR_MATERIAL_CONTRACT } from './hairMaterial'

function texture(value: number) {
  return new THREE.DataTexture(Uint8Array.from([value, value, value, 255]), 1, 1)
}

describe('Hair H3 node material runtime', () => {
  it('rebuilds embedded Hair materials as one TSL PBR material with independent maps', () => {
    const neutral = texture(190)
    const mask = texture(128)
    const normal = new THREE.DataTexture(Uint8Array.from([128, 128, 255, 255]), 1, 1)
    const roughness = texture(180)
    const source = new THREE.MeshStandardMaterial({ roughness: 0.61, metalness: 0 })
    source.name = 'EmbeddedHair'
    source.map = neutral
    source.emissiveMap = mask
    source.normalMap = normal
    source.roughnessMap = roughness
    source.userData.batshitHairMaterial = {
      contract: EMBEDDED_HAIR_MATERIAL_CONTRACT,
      assetId: 'style-01',
      revisionId: 'style-01-r1',
      materialDefinitionSha256: 'a'.repeat(64),
      baseColor: '#101820',
      highlightColor: '#6f4a8e',
      metalness: 0,
      roughness: 0.61,
      normalTexture: true,
      roughnessTexture: true
    }
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), source)
    root.add(mesh)

    expect(applyEmbeddedHairMaterials(root)).toBe(1)
    expect(mesh.material).not.toBe(source)
    expect((mesh.material as any).isNodeMaterial).toBe(true)
    expect((mesh.material as THREE.MeshStandardMaterial).map).toBe(neutral)
    expect((mesh.material as THREE.MeshStandardMaterial).emissiveMap).toBe(mask)
    expect((mesh.material as THREE.MeshStandardMaterial).normalMap).toBe(normal)
    expect((mesh.material as THREE.MeshStandardMaterial).roughnessMap).toBe(roughness)
    expect(neutral.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(mask.colorSpace).toBe(THREE.NoColorSpace)
  })

  it('fails loudly when embedded metadata claims a texture the GLB did not preserve', () => {
    const source = new THREE.MeshStandardMaterial()
    source.map = texture(190)
    source.emissiveMap = texture(128)
    source.userData.batshitHairMaterial = {
      contract: EMBEDDED_HAIR_MATERIAL_CONTRACT,
      assetId: 'style-01',
      revisionId: 'style-01-r1',
      materialDefinitionSha256: 'a'.repeat(64),
      baseColor: '#101820',
      highlightColor: '#6f4a8e',
      metalness: 0,
      roughness: 0.61,
      normalTexture: true,
      roughnessTexture: false
    }
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BufferGeometry(), source))

    expect(() => applyEmbeddedHairMaterials(root)).toThrow(
      'embedded Hair Normal texture does not match its material metadata'
    )
  })
})
