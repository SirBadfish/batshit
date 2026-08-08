import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { NailSurfaceEngineRuntime } from './nailSurface.engine'
import {
  createDefaultNailSurfaceState,
  parseNailSurfaceDefinition,
  type NailFamily,
  type NailSurfaceDefinitionV1
} from './nailSurface'

function definition() {
  return parseNailSurfaceDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/nail-surface/v1/nail-surface-v1.json'),
        'utf8'
      )
    )
  )
}

function familyMesh(contract: NailSurfaceDefinitionV1, family: NailFamily) {
  const binding = contract.runtimeBindings[family]
  const geometry = new THREE.BufferGeometry()
  const materialDefault = contract.materialDefaults[family]
  const finish = contract.finishes[materialDefault.finish]
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(
      materialDefault.color[0],
      materialDefault.color[1],
      materialDefault.color[2],
      THREE.SRGBColorSpace
    ),
    roughness: finish.roughness,
    clearcoat: finish.clearcoat,
    clearcoatRoughness: finish.clearcoatRoughness
  })
  material.name = binding.material
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.name = binding.node
  const targetNames = Object.values(binding.targets)
  mesh.morphTargetDictionary = Object.fromEntries(
    targetNames.map((name, index) => [name, index])
  )
  mesh.morphTargetInfluences = targetNames.map(() => 0)
  return mesh
}

function fixtureRoot(contract: NailSurfaceDefinitionV1) {
  const root = new THREE.Group()
  root.add(familyMesh(contract, 'fingers'))
  root.add(familyMesh(contract, 'toes'))
  return root
}

describe('NailSurfaceEngineRuntime', () => {
  it('composes signed length/width, shape presets, and transverse Arch', async () => {
    const contract = definition()
    const root = fixtureRoot(contract)
    const runtime = new NailSurfaceEngineRuntime(root, contract, null)
    const state = createDefaultNailSurfaceState(contract)
    state.geometry.fingers.length = 1
    state.geometry.fingers.width = -1
    state.geometry.fingers.shape = 'pointed'
    state.geometry.fingers.arch = 0.8
    state.geometry.toes.length = -0.5
    state.geometry.toes.shape = 'soft-square'
    state.appearance.linked = false
    state.appearance.fingers.color = [1, 0, 0]
    state.appearance.fingers.finish = 'glossy'
    state.appearance.toes.color = [0, 0, 1]
    state.appearance.toes.finish = 'matte'

    expect(await runtime.apply(state)).toBe(true)
    const fingers = root.getObjectByName(
      contract.runtimeBindings.fingers.node
    ) as THREE.SkinnedMesh
    const fingerTargets = contract.runtimeBindings.fingers.targets
    const influence = (name: string) =>
      fingers.morphTargetInfluences?.[fingers.morphTargetDictionary![name]]
    expect(influence(fingerTargets.lengthIncrease)).toBe(1)
    expect(influence(fingerTargets.lengthDecrease)).toBe(0)
    expect(influence(fingerTargets.widthNarrow)).toBe(1)
    expect(influence(fingerTargets.widthWide)).toBe(0)
    expect(influence(fingerTargets.shapePointed)).toBe(1)
    expect(influence(fingerTargets.shapeAlmond)).toBe(0)
    expect(influence(fingerTargets.arch)).toBe(0.8)
    const fingerMaterial = fingers.material as THREE.MeshPhysicalMaterial
    expect(fingerMaterial.roughness).toBe(contract.finishes.glossy.roughness)
    expect(fingerMaterial.clearcoat).toBe(contract.finishes.glossy.clearcoat)

    const toes = root.getObjectByName(
      contract.runtimeBindings.toes.node
    ) as THREE.SkinnedMesh
    const toeTargets = contract.runtimeBindings.toes.targets
    const toeInfluence = (name: string) =>
      toes.morphTargetInfluences?.[toes.morphTargetDictionary![name]]
    expect(toeInfluence(toeTargets.lengthDecrease)).toBe(0.5)
    expect(toeInfluence(toeTargets.shapeSoftSquare)).toBe(1)
    expect((toes.material as THREE.MeshPhysicalMaterial).roughness).toBe(
      contract.finishes.matte.roughness
    )

    runtime.setEnabled(false)
    expect(fingers.visible).toBe(false)
    expect(toes.visible).toBe(false)
    runtime.setEnabled(true)
    expect(fingers.visible).toBe(true)
    expect(toes.visible).toBe(true)

    expect(await runtime.apply(null)).toBe(true)
    expect(influence(fingerTargets.lengthIncrease)).toBe(0)
    expect(influence(fingerTargets.widthNarrow)).toBe(0)
    runtime.dispose()
  })

  it('fails loudly for missing surfaces, renamed materials, and missing control morphs', () => {
    const contract = definition()
    expect(() => new NailSurfaceEngineRuntime(new THREE.Group(), contract, null)).toThrow(
      /found 0/
    )
    const wrongMaterialRoot = fixtureRoot(contract)
    const finger = wrongMaterialRoot.getObjectByName(
      contract.runtimeBindings.fingers.node
    ) as THREE.SkinnedMesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
    finger.material.name = 'wrong'
    expect(() => new NailSurfaceEngineRuntime(wrongMaterialRoot, contract, null)).toThrow(
      /must use/
    )
    const missingMorphRoot = fixtureRoot(contract)
    const toe = missingMorphRoot.getObjectByName(
      contract.runtimeBindings.toes.node
    ) as THREE.SkinnedMesh
    delete toe.morphTargetDictionary?.[contract.runtimeBindings.toes.targets.arch]
    expect(() => new NailSurfaceEngineRuntime(missingMorphRoot, contract, null)).toThrow(
      /missing Nail Surface morphs/
    )
  })

  it('composites literal artwork over Nail Color without using alpha to hide geometry', async () => {
    const contract = definition()
    const root = fixtureRoot(contract)
    const calls: string[] = []
    const context = {
      fillStyle: '',
      globalCompositeOperation: '',
      fillRect: vi.fn(() => calls.push('fill')),
      drawImage: vi.fn(() => calls.push('artwork'))
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn((_kind: string, options: unknown) => {
        expect(options).toEqual({ alpha: false, colorSpace: 'srgb' })
        return context
      })
    }
    const originalCreateElement = document.createElement.bind(document)
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) =>
        tagName === 'canvas'
          ? canvas
          : originalCreateElement(tagName)) as typeof document.createElement)
    const loaded = new THREE.Texture()
    loaded.image = {}
    const loadAsync = vi.fn(async () => loaded)
    const runtime = new NailSurfaceEngineRuntime(root, contract, null, { loadAsync })
    const state = createDefaultNailSurfaceState(contract)
    state.appearance.linked = false
    state.appearance.fingers.color = [1, 0, 0]
    const template = contract.templates.fingers
    state.appearance.fingers.artwork = {
      schemaVersion: 'nail-artwork/v1',
      family: 'fingers',
      url: '/uploads/goon_nail_artwork/fingers.png',
      filename: 'fingers.png',
      size: 100,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      definitionSha256: contract.definitionSha256,
      template: {
        id: template.id,
        version: template.version,
        guideSha256: template.guide.sha256,
        slotMaskSha256: template.slotMask.sha256,
        baseArtworkSha256: template.baseArtwork.sha256
      },
      provenance: {
        sourceKind: 'user-authored',
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true
      }
    }

    try {
      expect(await runtime.apply(state)).toBe(true)
      expect(calls).toEqual(['fill', 'artwork'])
      expect(context.fillStyle).toBe('rgb(255 0 0)')
      expect(context.globalCompositeOperation).toBe('source-over')
      const fingers = root.getObjectByName(
        contract.runtimeBindings.fingers.node
      ) as THREE.SkinnedMesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
      expect(fingers.material.transparent).toBe(false)
      expect(fingers.material.opacity).toBe(1)
      expect(fingers.material.alphaMap).toBeNull()
      expect(fingers.material.map).toBeInstanceOf(THREE.CanvasTexture)
    } finally {
      runtime.dispose()
      createElement.mockRestore()
    }
  })
})
