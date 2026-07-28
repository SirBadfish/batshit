import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { LipArtworkEngineRuntime } from './lipArtwork.engine'
import { parseLipArtworkDefinition, parseLipArtworkState } from './lipArtwork'

function definition() {
  return parseLipArtworkDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/lip-artwork/v2/lip-artwork-v2.json'),
        'utf8'
      )
    )
  )
}

function fixtureState() {
  const contract = definition()
  return parseLipArtworkState(contract, {
    schemaVersion: 'lip-artwork-state/v2',
    definitionSha256: contract.definitionSha256,
    artwork: {
      url: '/uploads/goon_facial_artwork/lips.png',
      filename: 'lips.png',
      size: 123,
      mimeType: 'image/png',
      sha256: '1'.repeat(64),
      definitionSha256: contract.definitionSha256,
      template: {
        id: contract.template.id,
        version: contract.template.version,
        guideSha256: contract.template.guide.sha256,
        maskSha256: contract.template.safePaintMask.sha256,
        baseLipReferenceMaskSha256: contract.template.baseLipReferenceMask.sha256
      },
      provenance: {
        sourceKind: 'user-authored',
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true
      }
    },
    tint: [1, 0.5, 0.5],
    opacity: 0.8
  })
}

describe('LipArtworkEngineRuntime', () => {
  it('keeps package-authored PBR lighting while replacing only artwork RGB and alpha', async () => {
    const contract = definition()
    const originalMap = new THREE.Texture()
    const originalAlphaMap = new THREE.Texture()
    const original = new THREE.MeshStandardMaterial({
      map: originalMap,
      alphaMap: originalAlphaMap,
      color: 0xffffff,
      metalness: 0,
      roughness: 120 / 255,
      transparent: true
    })
    original.name = contract.runtimeBinding.material
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), original)
    mesh.name = contract.runtimeBinding.node
    const root = new THREE.Group()
    root.add(mesh)
    const texture = new THREE.Texture()
    const runtime = new LipArtworkEngineRuntime(root, contract, {
      loadAsync: async () => texture
    })

    expect(await runtime.apply(fixtureState())).toBe(true)
    expect(mesh.material).not.toBe(original)
    expect(mesh.material.name).toContain('lip_artwork_runtime_v2')
    const applied = mesh.material as THREE.MeshStandardMaterial
    expect(applied.isMeshStandardMaterial).toBe(true)
    expect(applied.map).toBe(texture)
    expect(applied.alphaMap).toBeNull()
    expect(applied.metalness).toBe(0)
    expect(applied.roughness).toBeCloseTo(120 / 255)
    expect(applied.opacity).toBe(0.8)
    expect(applied.transparent).toBe(true)
    expect(applied.depthWrite).toBe(false)
    expect(texture.flipY).toBe(false)

    expect(await runtime.apply(null)).toBe(true)
    expect(mesh.material).toBe(original)
    runtime.dispose()
    expect(mesh.material).toBe(original)
  })

  it('fails loudly when the package binding is missing, renamed, or unlit', () => {
    const contract = definition()
    const root = new THREE.Group()
    expect(() => new LipArtworkEngineRuntime(root, contract)).toThrow(/found 0/)
    const material = new THREE.MeshStandardMaterial()
    material.name = 'wrong'
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
    mesh.name = contract.runtimeBinding.node
    root.add(mesh)
    expect(() => new LipArtworkEngineRuntime(root, contract)).toThrow(/must use/)

    const unlitRoot = new THREE.Group()
    const unlit = new THREE.MeshBasicMaterial()
    unlit.name = contract.runtimeBinding.material
    const unlitMesh = new THREE.Mesh(new THREE.BufferGeometry(), unlit)
    unlitMesh.name = contract.runtimeBinding.node
    unlitRoot.add(unlitMesh)
    expect(() => new LipArtworkEngineRuntime(unlitRoot, contract)).toThrow(
      /light-reactive PBR material/
    )
  })
})
