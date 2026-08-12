import { describe, expect, it } from 'vitest'

import {
  HAIR_APPEARANCE_FOLLOWER_CONTRACT,
  HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
  HAIR_SCALP_CAGE_CONTRACT,
  type HairFollowerDefinitionV1
} from '../hairFollowers'
import { bakeHairFollowerGlb } from './hairFollowerGlbBaker'
import {
  decodeSemanticGlbAccessor,
  parseSemanticGlb,
  writeDeterministicSemanticGlb,
  type SemanticGltfRecord
} from './semanticGlb'
import { createRootWeightedFollowerHairGlbFixture } from './fixtures/hairAssetFixture'

const NEGATIVE = 'HairFollower_head_size_neg'
const POSITIVE = 'HairFollower_head_size_pos'

function definition(): HairFollowerDefinitionV1 {
  return {
    contract: HAIR_APPEARANCE_FOLLOWER_CONTRACT,
    appearanceFollowerContract: 'appearance-followers/v2',
    assetId: 'hair-test',
    revisionId: 'hair-test-r2',
    geometrySha256: 'a'.repeat(64),
    fitFamily: 'test-base',
    appearanceDefinitionSha256: 'b'.repeat(64),
    headNode: 'Head',
    sourceBodyNode: 'Body',
    scalpCage: {
      contract: HAIR_SCALP_CAGE_CONTRACT,
      space: 'avatar-root-rest',
      rootBounds: { minimum: [-1, 0, -1], maximum: [1, 2, 1] },
      transferBounds: { minimum: [-2, -1, -2], maximum: [2, 2, 2] },
      nearestNeighbors: 4,
      rootSeedFraction: 0.08,
      topology: 'triangle-geodesic/v1'
    },
    falloffProfiles: [
      { id: 'global-head', curve: 'smoothstep-root-to-tip/v1', tipWeight: 0.78 },
      { id: 'scalp-shape', curve: 'smoothstep-root-to-tip/v1', tipWeight: 0.32 },
      { id: 'local-clearance', curve: 'smoothstep-root-to-tip/v1', tipWeight: 0.08 }
    ],
    morphTargets: [
      {
        name: NEGATIVE,
        driver: { kind: 'dial-endpoint', dialId: 'head_size', endpoint: -1 },
        falloffProfile: 'global-head'
      },
      {
        name: POSITIVE,
        driver: { kind: 'dial-endpoint', dialId: 'head_size', endpoint: 1 },
        falloffProfile: 'global-head'
      }
    ],
    correctives: [],
    riskMatrix: {
      contract: HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
      scenarios: Array.from({ length: 8 }, (_, index) => ({
        id: `risk-${index + 1}`,
        values: { head_size: index % 2 === 0 ? -1 : 1 }
      })),
      thresholds: {
        maximumRootGapChange: 0.025,
        maximumClearanceLoss: 0.018,
        structuralEdgeMinimumLength: 0.005,
        minimumAbsoluteStretch: 0.005,
        maximumTipEdgeStretchRatio: 1.4,
        minimumSilhouetteDimensionRatio: 0.7,
        maximumSilhouetteDimensionRatio: 1.45
      }
    }
  }
}

function followerGlb(targetNames = [NEGATIVE, POSITIVE]) {
  const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0, 0.2, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1])
  const negative = new Float32Array([-0.1, 0, 0, -0.1, 0, 0, -0.1, 0, 0])
  const positive = new Float32Array([0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0])
  const arrays = [positions, uvs, negative, positive]
  const offsets: number[] = []
  let byteLength = 0
  for (const array of arrays) {
    offsets.push(byteLength)
    byteLength += array.byteLength
  }
  const binary = new Uint8Array(byteLength)
  arrays.forEach((array, index) => {
    binary.set(new Uint8Array(array.buffer.slice(0)), offsets[index])
  })
  const gltf: SemanticGltfRecord = {
    asset: { version: '2.0' },
    buffers: [{ byteLength }],
    bufferViews: arrays.map((array, index) => ({
      buffer: 0,
      byteOffset: offsets[index],
      byteLength: array.byteLength,
      target: 34962
    })),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.1, 0, 0],
        max: [0.1, 0.2, 0]
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: 3,
        type: 'VEC2',
        min: [0, 0],
        max: [1, 1]
      },
      {
        bufferView: 2,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-0.1, 0, 0],
        max: [-0.1, 0, 0]
      },
      {
        bufferView: 3,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0.1, 0, 0],
        max: [0.1, 0, 0]
      }
    ],
    materials: [{ name: 'HairMaterial' }],
    meshes: [
      {
        name: 'HairMesh',
        extras: { targetNames },
        primitives: [
          {
            attributes: { POSITION: 0, TEXCOORD_0: 1 },
            targets: [{ POSITION: 2 }, { POSITION: 3 }],
            material: 0,
            mode: 4
          }
        ]
      }
    ],
    nodes: [{ name: 'HairRoot', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0
  }
  return writeDeterministicSemanticGlb(gltf, binary)
}

describe('hair-follower-glb-baker/v1', () => {
  it('bakes resolved Hair positions deterministically and strips all Recipe-only targets', () => {
    const input = {
      hairGlb: followerGlb(),
      definition: definition(),
      state: { values: { head_size: 0.5 } }
    }
    const first = bakeHairFollowerGlb(input)
    expect(first).toEqual(bakeHairFollowerGlb(input))
    const parsed = parseSemanticGlb(first)
    const mesh = parsed.meshes[0]!
    expect(mesh.extras).toBeUndefined()
    expect(mesh.weights).toBeUndefined()
    const primitive = (mesh.primitives as Array<Record<string, unknown>>)[0]!
    expect(primitive.targets).toBeUndefined()
    const positionIndex = (primitive.attributes as Record<string, number>).POSITION
    const positions = Array.from(decodeSemanticGlbAccessor(parsed, positionIndex).values)
    ;[-0.05, 0, 0, 0.15, 0, 0, 0.05, 0.2, 0].forEach((expected, index) => {
      expect(positions[index]).toBeCloseTo(expected, 6)
    })
    expect((parsed.gltf.accessors as unknown[]).length).toBe(2)
    expect((parsed.gltf.bufferViews as unknown[]).length).toBe(2)
  })

  it('fails closed when geometry target names drift from the signed definition', () => {
    expect(() =>
      bakeHairFollowerGlb({
        hairGlb: followerGlb([POSITIVE, NEGATIVE]),
        definition: definition(),
        state: { values: { head_size: 1 } }
      })
    ).toThrow('target names do not match')
  })

  it('preserves and remaps strict root-weighted skin data while removing follower targets', () => {
    const baked = bakeHairFollowerGlb({
      hairGlb: createRootWeightedFollowerHairGlbFixture(),
      definition: definition(),
      state: { values: { head_size: 0.5 } }
    })
    const parsed = parseSemanticGlb(baked)
    const primitive = (parsed.meshes[0]!.primitives as Array<Record<string, unknown>>)[0]!
    const attributes = primitive.attributes as Record<string, number>
    const skin = parsed.skins[0]!
    const meshNode = parsed.nodes.find((node) => node.name === 'HairFollowerFixtureGeometry')!

    expect(primitive.targets).toBeUndefined()
    expect(attributes.JOINTS_0).toBeTypeOf('number')
    expect(attributes.WEIGHTS_0).toBeTypeOf('number')
    expect(attributes._BATSHAIR_TIP).toBeTypeOf('number')
    expect(meshNode.skin).toBe(0)
    expect(skin.joints).toEqual([0, 2])
    expect(skin.inverseBindMatrices).toBeTypeOf('number')
    expect(Array.from(decodeSemanticGlbAccessor(parsed, attributes.JOINTS_0!).values)).toEqual([
      0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0
    ])
    const weights = Array.from(
      decodeSemanticGlbAccessor(parsed, attributes.WEIGHTS_0!).values
    )
    ;[1, 0, 0, 0, 0.42, 0.58, 0, 0, 0, 1, 0, 0].forEach((expected, index) => {
      expect(weights[index]).toBeCloseTo(expected, 6)
    })
    expect(decodeSemanticGlbAccessor(parsed, skin.inverseBindMatrices!).count).toBe(2)
  })
})
