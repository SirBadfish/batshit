import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MToonMaterialLoaderPlugin, VRMLoaderPlugin } from '@pixiv/three-vrm'
import { describe, expect, it } from 'vitest'
import { GoonMToonNodeMaterial } from './goonMToonNodeMaterial'
import { writeDeterministicSemanticGlb } from './recipe/semanticGlb'

/** Small real GLB: three MToon surfaces with no tangents, so GLTFLoader clones them. */
function materialFixture() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
  const uv = new Float32Array([0, 0, 1, 0, 0, 1])
  const indices = new Uint16Array([0, 1, 2])
  const arrays = [positions, normals, uv, indices]
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = []
  let length = 0
  for (const array of arrays) {
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: array.byteLength })
    length += Math.ceil(array.byteLength / 4) * 4
  }
  const binary = new Uint8Array(length)
  arrays.forEach((array, index) => binary.set(new Uint8Array(array.buffer), bufferViews[index]!.byteOffset))
  const material = (name: string, alphaMode: string, alpha: number) => ({
    name, alphaMode, ...(alphaMode === 'MASK' ? { alphaCutoff: 0.5 } : {}), doubleSided: true,
    pbrMetallicRoughness: { baseColorFactor: [0.8, 0.7, 0.6, alpha] },
    extensions: { VRMC_materials_mtoon: { specVersion: '1.0' } }
  })
  const json = {
    asset: { version: '2.0' }, extensionsUsed: ['VRMC_materials_mtoon'],
    scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [0, 1, 2].map((mesh) => ({ name: `surface${mesh}`, mesh })),
    meshes: [0, 1, 2].map((material) => ({ primitives: [{
      attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material
    }] })),
    materials: [material('cutout', 'MASK', 1), material('solid', 'OPAQUE', 1), material('blend', 'BLEND', 0.6)],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews, buffers: [{ byteLength: length }]
  }
  return writeDeterministicSemanticGlb(json, binary).buffer as ArrayBuffer
}

describe('Goon MToon node material cutouts', () => {
  it('preserves the source cutoff and ordinary material properties through clone', () => {
    const map = new THREE.Texture()
    const original = new GoonMToonNodeMaterial({ alphaTest: 0.5, transparent: false, opacity: 0.75, side: THREE.DoubleSide, map })
    const copy = original.clone()
    expect(copy).not.toBe(original)
    expect(copy.alphaTest).toBe(0.5)
    expect(copy.opacity).toBe(0.75)
    expect(copy.transparent).toBe(false)
    expect(copy.side).toBe(THREE.DoubleSide)
    expect(copy.map).toBe(map)
  })

  it('keeps MASK cutoff on the actual GLTFLoader clone without changing OPAQUE or BLEND', async () => {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser, {
      mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: GoonMToonNodeMaterial })
    }))
    const gltf = await loader.parseAsync(materialFixture(), '')
    const [cutout, solid, blend] = gltf.scene.children as THREE.Mesh[]
    const source = await gltf.parser.getDependency('material', 0) as THREE.Material
    expect(cutout.geometry.hasAttribute('tangent')).toBe(false)
    expect(cutout.material).not.toBe(source)
    expect(source.alphaTest).toBe(0.5)
    expect((cutout.material as THREE.Material).alphaTest).toBe(0.5)
    expect((cutout.material as THREE.Material).transparent).toBe(false)
    expect((solid.material as THREE.Material).alphaTest).toBe(0)
    expect((solid.material as THREE.Material).transparent).toBe(false)
    expect((blend.material as THREE.Material).alphaTest).toBe(0)
    expect((blend.material as THREE.Material).transparent).toBe(true)
    expect((blend.material as THREE.Material).opacity).toBeCloseTo(0.6)
  })
})
